"""Operator CLI for the trajectory-v1 index + per-card forecast engine (T2/T3).

Subcommands:
  build-indices   build (and cache) the shared market/game/set indices, the
                  groups-metadata cache (publishedOn, fetched once from the
                  live TCGCSV groups endpoint and cached thereafter), and
                  the pooled release-age lifecycle curve -- all shared
                  inputs every `run-category` invocation needs, built once
                  so a multi-category run does not redo this work per
                  category.
  fetch-products  (T3) resumably fetch per-product card_number/rarity from
                  the community-free-access `tcgplayer/<cat>/<group>/products`
                  endpoint for every group already in the cached
                  groups-metadata file, so `fit-hedonic` can use rarity as a
                  hedonic feature when available. Safe to re-invoke: already
                  -fetched groups are skipped, and a partial pass (request
                  budget exhausted) is resumed by the next call.
  fit-hedonic     (T3) fit one category's per-card hedonic log-price
                  regression (+ the video_model_v0 two-feature ablation, +
                  cold-start candidate discovery) and cache the resulting
                  predictions for `run-category` to blend in; writes an
                  RMSE/R^2 receipt.
  run-category    process exactly one category's variants end to end
                  (damped-trend + Theta + shrinkage + split-conformal),
                  optionally blending in a cached hedonic prediction (T3),
                  emit its packet file, and write a per-category receipt
                  with row counts, wall-clock seconds, peak RSS, packet
                  bytes, and the packet content hash.
  report          aggregate every per-category receipt already on disk
                  into one run summary; touches no network and reruns no
                  models.

`build-indices` must be run before `run-category`; `run-category` is safe
to invoke once per category as a separate, harness-tracked process (each
call fits comfortably inside the host's RAM ceiling by construction --
see trajectory.py's module docstring). `fetch-products` and `fit-hedonic`
are both optional (T3 graceful degradation): `run-category` behaves exactly
as it did pre-T3 whenever no cached hedonic-predictions file exists for a
category.
"""

from __future__ import annotations

import argparse
import json
import math
import resource
import sys
import time
from dataclasses import asdict
from array import array
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Mapping, Sequence

from .hedonic import fit_hedonic_category, fit_video_model_v0_ablation
from .hedonic_features import (
    MAIN_MODEL_CONTINUOUS_FIELDS,
    PRODUCTS_CACHE_FILENAME,
    build_category_feature_rows,
    cold_start_candidates,
    load_or_fetch_products_metadata,
)
from .forecast_publisher import DEFAULT_MAX_OBJECT_BYTES, publish_forecasts
from .history_publisher import DEFAULT_MAX_OBJECT_BYTES as HISTORY_DEFAULT_MAX_OBJECT_BYTES, publish_history
from .indices import IndexSet, build_indices
from .lifecycle import (
    GROUPS_CACHE_FILENAME,
    LifecycleCurve,
    LifecycleError,
    build_lifecycle_curve,
    load_or_fetch_groups_metadata,
)
from .tcgcsv_panel import DEFAULT_CATEGORY_IDS
from .trajectory import HORIZONS_DAYS, MODEL_VERSION, content_sha256, horizon_steps_for, process_category
from .trajectory_eval import DEFAULT_MAX_VARIANTS_PER_CATEGORY, run_component_weight_remediation

INDICES_CACHE_FILENAME = "indices.json.gz"
LIFECYCLE_CACHE_FILENAME = "lifecycle_curve.json.gz"
HEDONIC_PREDICTIONS_DIRNAME = "hedonic"


def _category_ids(args: argparse.Namespace) -> tuple[int, ...]:
    return tuple(args.category_id) if args.category_id else DEFAULT_CATEGORY_IDS


def _peak_rss_bytes() -> int:
    """Peak resident set size of this process so far, in bytes.

    ``ru_maxrss`` is kibibytes on Linux (unlike macOS, where it is bytes) --
    this host is Linux, so the x1024 conversion is correct here.
    """

    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024


def _serialize_index_set(index_set: IndexSet) -> dict[str, object]:
    return {
        "dates": [d.isoformat() for d in index_set.dates],
        "categoryIds": list(index_set.category_ids),
        "market": list(index_set.market),
        "category": {str(c): list(arr) for c, arr in index_set.category.items()},
        "group": {f"{c}:{g}": list(arr) for (c, g), arr in index_set.group.items()},
        "groupFirstIndex": {f"{c}:{g}": idx for (c, g), idx in index_set.group_first_index.items()},
        "rowCounts": {str(c): n for c, n in index_set.row_counts.items()},
        "variantCounts": {str(c): n for c, n in index_set.variant_counts.items()},
    }


def _deserialize_index_set(payload: Mapping[str, object]) -> IndexSet:
    dates = tuple(date.fromisoformat(str(d)) for d in payload["dates"])
    category = {int(c): array("d", arr) for c, arr in payload["category"].items()}
    group: dict[tuple[int, int], array] = {}
    for key, arr in payload["group"].items():
        c_str, g_str = key.split(":")
        group[(int(c_str), int(g_str))] = array("d", arr)
    group_first_index: dict[tuple[int, int], int] = {}
    for key, idx in payload["groupFirstIndex"].items():
        c_str, g_str = key.split(":")
        group_first_index[(int(c_str), int(g_str))] = int(idx)
    return IndexSet(
        dates=dates,
        category_ids=tuple(int(c) for c in payload["categoryIds"]),
        market=array("d", payload["market"]),
        category=category,
        group=group,
        group_first_index=group_first_index,
        row_counts={int(c): int(n) for c, n in payload["rowCounts"].items()},
        variant_counts={int(c): int(n) for c, n in payload["variantCounts"].items()},
    )


def _serialize_lifecycle_curve(curve: LifecycleCurve) -> dict[str, object]:
    return {
        "curve": {str(k): v for k, v in curve.curve.items()},
        "sampleCounts": {str(k): v for k, v in curve.sample_counts.items()},
    }


def _deserialize_lifecycle_curve(payload: Mapping[str, object]) -> LifecycleCurve:
    return LifecycleCurve(
        curve={int(k): float(v) for k, v in payload["curve"].items()},
        sample_counts={int(k): int(v) for k, v in payload["sampleCounts"].items()},
    )


def _write_json_gz(path: Path, payload: object) -> None:
    import gzip

    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".part")
    with gzip.open(tmp, "wt", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    tmp.replace(path)


def _read_json_gz(path: Path) -> object:
    import gzip

    with gzip.open(path, "rt", encoding="utf-8") as handle:
        return json.load(handle)


def _build_indices_command(args: argparse.Namespace) -> int:
    category_ids = _category_ids(args)
    panel_dir = Path(args.panel_dir)
    state_dir = Path(args.state_dir)

    started = time.monotonic()
    index_set = build_indices(panel_dir, category_ids, trim_fraction=args.trim_fraction)
    indices_path = state_dir / INDICES_CACHE_FILENAME
    _write_json_gz(indices_path, _serialize_index_set(index_set))

    groups_cache_path = state_dir / GROUPS_CACHE_FILENAME
    try:
        groups_metadata, groups_hash = load_or_fetch_groups_metadata(
            groups_cache_path, category_ids, force_refresh=args.refresh_groups,
            base_url=args.base_url, user_agent=args.user_agent, timeout_seconds=args.timeout_seconds,
        )
    except LifecycleError as exc:
        print(f"trajectory-cli: groups metadata fetch failed: {exc}", file=sys.stderr)
        return 2

    curve = build_lifecycle_curve(index_set, groups_metadata, trim_fraction=args.trim_fraction)
    curve_path = state_dir / LIFECYCLE_CACHE_FILENAME
    _write_json_gz(curve_path, _serialize_lifecycle_curve(curve))
    elapsed = time.monotonic() - started

    receipt = {
        "modelVersion": MODEL_VERSION,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "categoryIds": list(category_ids),
        "wallClockSeconds": round(elapsed, 3),
        "peakRssBytes": _peak_rss_bytes(),
        "indexSet": index_set.as_receipt_dict(),
        "groupsMetadataCount": len(groups_metadata),
        "groupsMetadataContentHash": groups_hash,
        "lifecycleCurvePoints": len(curve.curve),
        "cachePaths": {
            "indices": str(indices_path),
            "groupsMetadata": str(groups_cache_path),
            "lifecycleCurve": str(curve_path),
        },
    }
    receipts_dir = Path(args.receipts_dir)
    receipts_dir.mkdir(parents=True, exist_ok=True)
    (receipts_dir / "trajectory-build-indices.json").write_text(
        json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8",
    )
    print(json.dumps(receipt, indent=2, sort_keys=True))
    return 0


def _load_shared_inputs(state_dir: Path) -> tuple[IndexSet, LifecycleCurve, dict[tuple[int, int], dict]]:
    indices_path = state_dir / INDICES_CACHE_FILENAME
    curve_path = state_dir / LIFECYCLE_CACHE_FILENAME
    groups_path = state_dir / GROUPS_CACHE_FILENAME
    if not indices_path.is_file() or not curve_path.is_file() or not groups_path.is_file():
        raise RuntimeError(
            f"missing shared trajectory state under {state_dir}; run `build-indices` first"
        )
    index_set = _deserialize_index_set(_read_json_gz(indices_path))
    curve = _deserialize_lifecycle_curve(_read_json_gz(curve_path))
    raw_groups = _read_json_gz(groups_path)
    groups_metadata = {
        (int(row["category_id"]), int(row["group_id"])): row
        for row in raw_groups.get("groups", [])
    }
    return index_set, curve, groups_metadata


def _default_as_of_date(index_set: IndexSet) -> date:
    """The calendar date `process_category`'s own `as_of` default falls on.

    `process_category(as_of=None)` defaults to `dates[-1] + 1 day` at UTC
    midnight (see trajectory.py); T3's feature assembly needs the plain
    `date` half of that same instant so release-age-at-asOf features
    computed at fit time (`fit-hedonic`) line up with what `run-category`
    computes at emission time.
    """

    return index_set.dates[-1] + timedelta(days=1)


def _fetch_products_command(args: argparse.Namespace) -> int:
    category_ids = _category_ids(args)
    state_dir = Path(args.state_dir)
    groups_path = state_dir / GROUPS_CACHE_FILENAME
    if not groups_path.is_file():
        print(
            f"trajectory-cli: missing {groups_path}; run `build-indices` first "
            "(fetch-products needs the group id list)",
            file=sys.stderr,
        )
        return 2
    raw_groups = _read_json_gz(groups_path)
    group_keys = [
        (int(row["category_id"]), int(row["group_id"]))
        for row in raw_groups.get("groups", [])
        if int(row["category_id"]) in category_ids
    ]

    products_cache_path = Path(args.products_cache) if args.products_cache else (
        state_dir / HEDONIC_PREDICTIONS_DIRNAME / PRODUCTS_CACHE_FILENAME
    )
    started = time.monotonic()
    _products, result = load_or_fetch_products_metadata(
        products_cache_path, group_keys,
        max_requests=args.max_requests,
        base_url=args.base_url, user_agent=args.user_agent, timeout_seconds=args.timeout_seconds,
    )
    elapsed = time.monotonic() - started

    receipt = {
        "modelVersion": MODEL_VERSION,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "categoryIds": list(category_ids),
        "wallClockSeconds": round(elapsed, 3),
        "peakRssBytes": _peak_rss_bytes(),
        "cachePath": str(products_cache_path),
        "groupsRequested": result.groups_requested,
        "groupsAlreadyCached": result.groups_already_cached,
        "groupsFetchedThisCall": result.groups_fetched_this_call,
        "groupsFailedThisCall": result.groups_failed_this_call,
        "requestsMadeThisCall": result.requests_made_this_call,
        "elapsedSecondsInner": result.elapsed_seconds,
        "truncated": result.truncated,
        "cacheContentHash": result.cache_content_hash,
        "productCount": result.product_count,
    }
    receipts_dir = Path(args.receipts_dir)
    receipts_dir.mkdir(parents=True, exist_ok=True)
    (receipts_dir / "trajectory-fetch-products.json").write_text(
        json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8",
    )
    print(json.dumps(receipt, indent=2, sort_keys=True))
    if result.truncated:
        print(
            "trajectory-cli: products fetch truncated at the request budget; "
            "re-invoke fetch-products to resume",
            file=sys.stderr,
        )
    return 0


def _load_products_metadata_readonly(cache_path: Path) -> dict[tuple[int, int], dict] | None:
    """Read an already-fetched products-metadata cache without fetching.

    Returns ``None`` (not an error) when the cache does not exist yet --
    T3's graceful-degradation clause: fit-hedonic proceeds on the features
    that do not need this cache (finish, release age, set family, kind,
    group-level price statistics).
    """

    if not cache_path.is_file():
        return None
    products, _result = load_or_fetch_products_metadata(cache_path, [])
    return products


def _hedonic_predictions_path(state_dir: Path, category_id: int) -> Path:
    return state_dir / HEDONIC_PREDICTIONS_DIRNAME / f"hedonic_predictions_category_{category_id}.json.gz"


def _fit_hedonic_command(args: argparse.Namespace) -> int:
    category_id = args.category_id
    panel_dir = Path(args.panel_dir)
    state_dir = Path(args.state_dir)

    try:
        index_set, _curve, groups_metadata = _load_shared_inputs(state_dir)
    except RuntimeError as exc:
        print(f"trajectory-cli: {exc}", file=sys.stderr)
        return 2
    if category_id not in index_set.category_ids:
        print(
            f"trajectory-cli: category {category_id} was not in the cached index set "
            f"{list(index_set.category_ids)}; rerun build-indices with --category-id {category_id}",
            file=sys.stderr,
        )
        return 2

    products_cache_path = Path(args.products_cache) if args.products_cache else (
        state_dir / HEDONIC_PREDICTIONS_DIRNAME / PRODUCTS_CACHE_FILENAME
    )
    products_metadata = _load_products_metadata_readonly(products_cache_path)
    as_of_date = _default_as_of_date(index_set)

    started = time.monotonic()
    feature_set = build_category_feature_rows(
        panel_dir, category_id, index_set.dates, groups_metadata, products_metadata, as_of_date,
    )
    if not feature_set.rows:
        print(f"trajectory-cli: category {category_id} has zero priced variants; nothing to fit", file=sys.stderr)
        return 2

    model = fit_hedonic_category(
        category_id, list(feature_set.rows), list(feature_set.log_price),
        continuous_fields=MAIN_MODEL_CONTINUOUS_FIELDS,
    )
    ablation = fit_video_model_v0_ablation(category_id, list(feature_set.rows), list(feature_set.log_price))
    cold_start = cold_start_candidates(
        panel_dir, category_id, index_set.dates, groups_metadata, products_metadata, as_of_date,
    )
    elapsed = time.monotonic() - started

    predictions = [
        {"productId": pid, "subTypeName": sub, "logPrice": round(model.predict_log_price(row), 6)}
        for (pid, sub), row in zip(feature_set.keys, feature_set.rows)
    ]
    cold_start_predictions = [
        {
            "productId": pid, "subTypeName": sub,
            "groupId": cold_start.group_by_key[(pid, sub)],
            "logPrice": round(model.predict_log_price(row), 6),
        }
        for (pid, sub), row in zip(cold_start.keys, cold_start.rows)
    ]
    predictions_payload = {
        "modelVersion": MODEL_VERSION,
        "categoryId": category_id,
        "asOfDate": as_of_date.isoformat(),
        "predictions": predictions,
        "coldStart": cold_start_predictions,
    }
    predictions_path = _hedonic_predictions_path(state_dir, category_id)
    _write_json_gz(predictions_path, predictions_payload)
    predictions_hash = content_sha256(predictions_payload)

    receipt = {
        "modelVersion": MODEL_VERSION,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "categoryId": category_id,
        "wallClockSeconds": round(elapsed, 3),
        "peakRssBytes": _peak_rss_bytes(),
        "nRows": len(feature_set.rows),
        "rarityCoverage": round(feature_set.rarity_coverage, 6),
        "productsMetadataAvailable": products_metadata is not None,
        "productsCachePath": str(products_cache_path) if products_metadata is not None else None,
        "mainModel": {
            "usedInterceptOnlyFallback": model.used_intercept_only_fallback,
            "featureCount": len(model.spec.column_names),
            "metrics": model.metrics.as_receipt_dict(),
        },
        "ablation": ablation,
        "coldStart": {
            "candidateCount": len(cold_start.keys),
        },
        "predictionsCachePath": str(predictions_path),
        "predictionsCacheContentHash": predictions_hash,
    }
    receipts_dir = Path(args.receipts_dir)
    receipts_dir.mkdir(parents=True, exist_ok=True)
    (receipts_dir / f"trajectory-hedonic-category-{category_id}.json").write_text(
        json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8",
    )
    print(json.dumps(receipt, indent=2, sort_keys=True))
    return 0


def _hedonic_payload_to_maps(
    payload: Mapping[str, object],
) -> tuple[dict[tuple[int, str], float], dict[tuple[int, str], int]]:
    hedonic_log_price: dict[tuple[int, str], float] = {
        (int(row["productId"]), str(row["subTypeName"])): float(row["logPrice"])
        for row in payload.get("predictions", [])
    }
    cold_start_variants: dict[tuple[int, str], int] = {}
    for row in payload.get("coldStart", []):
        key = (int(row["productId"]), str(row["subTypeName"]))
        cold_start_variants[key] = int(row["groupId"])
        hedonic_log_price[key] = float(row["logPrice"])
    return hedonic_log_price, cold_start_variants


def _load_hedonic_predictions(
    state_dir: Path, category_id: int
) -> tuple[dict[tuple[int, str], float] | None, dict[tuple[int, str], int] | None]:
    """Load a `fit-hedonic`-written predictions cache, if any.

    Returns ``(None, None)`` when no cache exists for this category (T3
    graceful degradation: `run-category` then behaves exactly as it did
    pre-T3).
    """

    path = _hedonic_predictions_path(state_dir, category_id)
    if not path.is_file():
        return None, None
    payload = _read_json_gz(path)
    return _hedonic_payload_to_maps(payload)


def _load_component_weights(
    path: Path, category_id: int
) -> dict[int, tuple[float, float, float]] | None:
    """Load a trajectory-v1.1 ``component-weights.json`` receipt and
    return this category's selected weights keyed by ``horizon_steps`` (the
    key ``process_category``'s ``component_weights`` parameter expects).

    Expected schema (written by the remediation's weight-selection step,
    see ``trajectory_eval.select_component_weights``):
    ``{"<categoryId>": {"<horizonDays>": {"weightA": a, "weightC": c,
    "weightB": b, ...}, ...}, ...}``. Legacy entries without ``weightC``
    imply zero mean reversion. Returns ``None`` (implicit ``(1.0, 0.0, 1.0)`` everywhere
    behavior) when the file is absent or has no entry for this category.
    """

    if not path.is_file():
        return None
    payload = json.loads(path.read_text(encoding="utf-8"))
    category_payload = payload.get(str(category_id))
    if not category_payload:
        return None
    weights: dict[int, tuple[float, float, float]] = {}
    for horizon_days_str, entry in category_payload.items():
        h_steps = horizon_steps_for(int(horizon_days_str))
        weights[h_steps] = (
            float(entry["weightA"]),
            float(entry.get("weightC", 0.0)),
            float(entry["weightB"]),
        )
    return weights or None


def _run_category_command(args: argparse.Namespace) -> int:
    category_id = args.category_id
    panel_dir = Path(args.panel_dir)
    state_dir = Path(args.state_dir)

    try:
        index_set, curve, groups_metadata = _load_shared_inputs(state_dir)
    except RuntimeError as exc:
        print(f"trajectory-cli: {exc}", file=sys.stderr)
        return 2
    if category_id not in index_set.category_ids:
        print(
            f"trajectory-cli: category {category_id} was not in the cached index set "
            f"{list(index_set.category_ids)}; rerun build-indices with --category-id {category_id}",
            file=sys.stderr,
        )
        return 2

    hedonic_log_price: dict[tuple[int, str], float] | None = None
    cold_start_variants: dict[tuple[int, str], int] | None = None
    hedonic_applied = False
    if not args.no_hedonic:
        if args.hedonic_predictions_path:
            predictions_path = Path(args.hedonic_predictions_path)
            if predictions_path.is_file():
                payload = _read_json_gz(predictions_path)
                hedonic_log_price, cold_start_variants = _hedonic_payload_to_maps(payload)
        else:
            hedonic_log_price, cold_start_variants = _load_hedonic_predictions(state_dir, category_id)
        hedonic_applied = hedonic_log_price is not None

    weights_path = (
        Path(args.component_weights_path)
        if args.component_weights_path
        else Path(args.receipts_dir) / "component-weights.json"
    )
    component_weights = _load_component_weights(weights_path, category_id)

    started = time.monotonic()
    result = process_category(
        panel_dir, category_id, index_set, curve, groups_metadata,
        Path(args.packets_dir), horizons_days=HORIZONS_DAYS,
        hedonic_log_price=hedonic_log_price, cold_start_variants=cold_start_variants,
        component_weights=component_weights,
    )
    elapsed = time.monotonic() - started
    packet_bytes = Path(result.output_path).stat().st_size

    receipt = {
        "modelVersion": MODEL_VERSION,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "categoryId": category_id,
        "variantCount": result.variant_count,
        "packetRowCount": result.packet_row_count,
        "datesCovered": result.dates_covered,
        "wallClockSeconds": round(elapsed, 3),
        "peakRssBytes": _peak_rss_bytes(),
        "packetBytes": packet_bytes,
        "outputPath": result.output_path,
        "contentHash": result.content_hash,
        "poolSizes": result.pool_sizes,
        "rejects": result.rejects,
        "hedonicBlendApplied": hedonic_applied,
        "coldStartPacketCount": len(cold_start_variants) if cold_start_variants else 0,
        "componentWeightsApplied": component_weights is not None,
        "componentWeights": (
            {str(h_steps): list(ab) for h_steps, ab in component_weights.items()}
            if component_weights else None
        ),
    }
    receipts_dir = Path(args.receipts_dir)
    receipts_dir.mkdir(parents=True, exist_ok=True)
    (receipts_dir / f"trajectory-category-{category_id}.json").write_text(
        json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8",
    )
    print(json.dumps(receipt, indent=2, sort_keys=True))
    return 0


def _render_markdown(summary: Mapping[str, object]) -> str:
    lines = [
        "# trajectory-v1.1 -- per-card forecast run summary",
        "",
        f"- Generated at: {summary['generatedAt']}",
        f"- Categories: {summary['categoryIds']}",
        f"- Total packet rows: {summary['totalPacketRows']}",
        f"- Total packet bytes: {summary['totalPacketBytes']}",
        f"- Total wall-clock seconds (sum of per-category runs): {summary['totalWallClockSeconds']}",
        f"- Peak RSS across categories (bytes): {summary['peakRssBytesAcrossCategories']}",
        "",
        "| Category | Variants | Packet rows | Bytes | Wall (s) | Peak RSS (MB) | Content hash |",
        "|---|---|---|---|---|---|---|",
    ]
    for row in summary["categories"]:
        lines.append(
            f"| {row['categoryId']} | {row['variantCount']} | {row['packetRowCount']} | "
            f"{row['packetBytes']} | {row['wallClockSeconds']} | "
            f"{row['peakRssBytes'] / (1024 * 1024):.1f} | `{row['contentHash'][:12]}` |"
        )
    lines.append("")
    return "\n".join(lines)


def _report_command(args: argparse.Namespace) -> int:
    receipts_dir = Path(args.receipts_dir)
    category_receipts = []
    for path in sorted(receipts_dir.glob("trajectory-category-*.json")):
        category_receipts.append(json.loads(path.read_text(encoding="utf-8")))

    summary = {
        "modelVersion": MODEL_VERSION,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "categoryIds": [row["categoryId"] for row in category_receipts],
        "totalPacketRows": sum(row["packetRowCount"] for row in category_receipts),
        "totalPacketBytes": sum(row["packetBytes"] for row in category_receipts),
        "totalWallClockSeconds": round(sum(row["wallClockSeconds"] for row in category_receipts), 3),
        "peakRssBytesAcrossCategories": max((row["peakRssBytes"] for row in category_receipts), default=0),
        "categories": category_receipts,
    }
    receipts_dir.mkdir(parents=True, exist_ok=True)
    (receipts_dir / "trajectory-run-summary.json").write_text(
        json.dumps(summary, indent=2, sort_keys=True) + "\n", encoding="utf-8",
    )
    (receipts_dir / "trajectory-run-summary.md").write_text(_render_markdown(summary), encoding="utf-8")
    print(json.dumps({k: v for k, v in summary.items() if k != "categories"}, indent=2, sort_keys=True))
    return 0


def _render_component_weights_summary_markdown(category_rows: list[dict]) -> str:
    lines = [
        "# trajectory-v1.1 -- causal rolling held-out-set validation",
        "",
        "Per (category x horizon): deployment coefficients `(a, c, b)` are selected from",
        "matured non-overlapping blocks. Validation is independently rolling and leaves",
        "each scored set out of coefficient selection and conformal calibration.",
        "",
        "## Selected weights",
        "",
        "| Category | Horizon (d) | a common | c reversion | b drift | Fit lift | Fit n | Fit blocks |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for row in category_rows:
        for h_days, sel in sorted(row["selection"].items()):
            lines.append(
                f"| {row['categoryId']} | {h_days} | {sel['weightA']} | {sel.get('weightC', 0.0)} | {sel['weightB']} | "
                f"{sel['trainMaeLiftOverNoChange']} | {sel['trainNCases']} | "
                f"{len(sel['trainOrigins'])} |"
            )
    lines += [
        "",
        "## Holdout gate: pass/fail per (category x cohort x horizon)",
        "",
        "| Category | Cohort | Horizon (d) | n | Blocks | Sets | MAE lift | Macro set lift | "
        "Bootstrap lower90 | No-harm sets | Coverage80 | Evidence tier | Pass |",
        "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ]
    for row in category_rows:
        for result in row["gate"]["results"]:
            lift = f"{result['maeLiftOverNoChange']:.6f}" if result["nCases"] else "n/a"
            cov = f"{result['coverage80']:.4f}" if result["nCases"] else "n/a"
            macro = result.get("macroSetLift")
            lower = result.get("bootstrapLiftLower90")
            no_harm = result.get("setsNoHarmFraction")
            lines.append(
                f"| {row['categoryId']} | {result['cohort']} | {result['horizonDays']} | "
                f"{result['nCases']} | {result.get('nScoreBlocks', 0)} | {result.get('eligibleSetCount', 0)} | "
                f"{lift} | {macro if macro is not None else 'n/a'} | {lower if lower is not None else 'n/a'} | "
                f"{no_harm if no_harm is not None else 'n/a'} | {cov} | {result.get('evidenceTier', 'range-only')} | "
                f"{result['passes']} |"
            )
    lines += [
        "",
        "## Serving-eligibility conclusions",
        "",
        "| Category | Cohort | Serving eligible |",
        "|---|---|---|",
    ]
    for row in category_rows:
        for cohort, eligible in sorted(row["gate"]["servingEligibleByCohort"].items()):
            lines.append(f"| {row['categoryId']} | {cohort} | {eligible} |")
    lines += [
        "",
        "## Variant sampling (no silent caps)",
        "",
        "| Category | Total variants | Sampled variants | Sampling applied |",
        "|---|---|---|---|",
    ]
    for row in category_rows:
        lines.append(
            f"| {row['categoryId']} | {row['totalVariants']} | {row['sampledVariants']} | "
            f"{row['samplingApplied']} |"
        )
    for row in category_rows:
        if row["samplingApplied"]:
            lines.append(
                f"- Category {row['categoryId']}: metrics are computed on a deterministic "
                f"{row['sampledVariants']}-of-{row['totalVariants']} variant sample "
                f"({row['samplingRule']})."
            )
        else:
            lines.append(
                f"- Category {row['categoryId']}: no sampling applied -- metrics are computed "
                f"on the full {row['totalVariants']}-variant universe."
            )

    near_miss_lines = _near_miss_notes(category_rows)
    lines += [
        "",
        "## Near-miss notes (informational; failed horizons remain range-only)",
        "",
    ]
    if near_miss_lines:
        lines += near_miss_lines
    else:
        lines.append("- none")

    lines += [
        "",
        "cold-start: no observed current-price anchor exists. Hedonic output is published",
        "only as an attribute-based reference range, never as a directional forecast.",
        "",
    ]
    return "\n".join(lines)


def _near_miss_notes(category_rows: list[dict]) -> list[str]:
    """Flag (category, cohort) pairs where a later horizon passes the
    holdout gate but an earlier one does not. This is informational only:
    each horizon keeps its own evidence tier and no override upgrades a
    failed horizon."""

    notes = []
    for row in category_rows:
        by_cohort: dict[str, dict[int, dict]] = {}
        for result in row["gate"]["results"]:
            by_cohort.setdefault(result["cohort"], {})[result["horizonDays"]] = result
        for cohort, by_horizon in sorted(by_cohort.items()):
            horizons = sorted(by_horizon)
            if len(horizons) < 2:
                continue
            earliest = horizons[0]
            passing_later = [h for h in horizons[1:] if by_horizon[h]["passes"]]
            if passing_later and not by_horizon[earliest]["passes"]:
                later_label = "/".join(f"{h}d" for h in passing_later)
                notes.append(
                    f"- Category {row['categoryId']}, {cohort} cohort: passes {later_label} only "
                    f"({earliest}d fails). Failed horizons remain range-only; no override upgrades them."
                )
    return notes


def _category_row_from_receipt(receipt: dict) -> dict:
    """Reconstruct the summary-renderer's category_rows shape from a
    persisted evaluation-category-<id>.json receipt (selection + gridScores
    are stored split across two receipt keys; this re-merges them keyed by
    horizonDays, matching what _eval_component_weights_command builds
    in-memory for the invocation it just ran)."""

    selection = {}
    for h_steps_str, sel in receipt["selection"].items():
        merged = dict(sel)
        merged["gridScores"] = receipt["gridScores"][h_steps_str]
        selection[sel["horizonDays"]] = merged
    return {
        "categoryId": receipt["categoryId"],
        "selection": selection,
        "gate": receipt["gate"],
        "totalVariants": receipt.get("totalVariants"),
        "sampledVariants": receipt.get("sampledVariants"),
        "samplingApplied": receipt.get("samplingApplied"),
        "samplingRule": receipt.get("samplingRule"),
    }


def _merged_category_rows(receipts_dir: Path) -> list[dict]:
    """Every evaluation-category-*.json currently present in receipts_dir,
    parsed back into category_rows shape and sorted by categoryId -- the
    summary is a MERGE over all per-category receipts on disk, not just
    whatever categories the current invocation happened to (re-)evaluate,
    so per-category invocations (e.g. one category per process/receipt)
    don't clobber each other's contribution to evaluation-summary.md/json."""

    rows = []
    for path in sorted(receipts_dir.glob("evaluation-category-*.json")):
        receipt = json.loads(path.read_text(encoding="utf-8"))
        rows.append(_category_row_from_receipt(receipt))
    rows.sort(key=lambda row: row["categoryId"])
    return rows


def _eval_component_weights_command(args: argparse.Namespace) -> int:
    panel_dir = Path(args.panel_dir)
    state_dir = Path(args.state_dir)
    receipts_dir = Path(args.receipts_dir)
    receipts_dir.mkdir(parents=True, exist_ok=True)
    category_ids = [int(c) for c in args.category_ids.split(",") if c.strip()]

    try:
        index_set, curve, groups_metadata = _load_shared_inputs(state_dir)
    except RuntimeError as exc:
        print(f"trajectory-cli: {exc}", file=sys.stderr)
        return 2

    weights_path = receipts_dir / "component-weights.json"
    combined_weights: dict = json.loads(weights_path.read_text(encoding="utf-8")) if weights_path.is_file() else {}

    category_rows = []
    for category_id in category_ids:
        if category_id not in index_set.category_ids:
            print(
                f"trajectory-cli: category {category_id} was not in the cached index set "
                f"{list(index_set.category_ids)}; rerun build-indices with --category-id {category_id}",
                file=sys.stderr,
            )
            return 2

        started = time.monotonic()
        out = run_component_weight_remediation(
            panel_dir, category_id, index_set, curve, groups_metadata,
            max_variants_per_category=args.max_variants_per_category,
        )
        elapsed = time.monotonic() - started

        selection_json = {
            h_steps: {k: v for k, v in sel.items()}
            for h_steps, sel in out["selection"].items()
        }
        gate = out["gate"]
        gate_json = {
            "categoryId": gate["categoryId"],
            "componentWeights": {str(h): list(ab) for h, ab in gate["componentWeights"].items()},
            "results": [
                {
                    "categoryId": r.category_id,
                    "cohort": r.cohort,
                    "horizonDays": r.horizon_days,
                    "nCases": r.n_cases,
                    "maeEngine": r.mae_engine,
                    "maeNoChange": r.mae_no_change,
                    "maeLiftOverNoChange": r.mae_lift_over_no_change,
                    "nMovers": r.n_movers,
                    "directionAccuracyMovers": r.direction_accuracy_movers,
                    "coverage80": r.coverage_80,
                    "pinballQ50Engine": r.pinball_q50_engine,
                    "pinballQ50NoChange": r.pinball_q50_no_change,
                    "pinballBeatsNoChange": r.pinball_beats_no_change,
                    "baselineMae": r.baseline_mae,
                    "passes": r.passes,
                    "failReasons": r.fail_reasons,
                    "servingEligible": r.serving_eligible,
                    "nScoreBlocks": r.n_score_blocks,
                    "eligibleSetCount": r.eligible_set_count,
                    "macroSetLift": r.macro_set_lift if math.isfinite(r.macro_set_lift) else None,
                    "bootstrapLiftLower90": r.bootstrap_lift_lower_90 if math.isfinite(r.bootstrap_lift_lower_90) else None,
                    "setsNoHarmFraction": r.sets_no_harm_fraction if math.isfinite(r.sets_no_harm_fraction) else None,
                    "coverageCells": [
                        {"cell": cell, "nCases": n_cases, "coverage80": coverage}
                        for cell, n_cases, coverage in r.coverage_cells
                    ],
                    "validationScope": r.validation_scope,
                    "evidenceTier": r.evidence_tier,
                }
                for r in gate["results"]
            ],
            "servingEligibleByCohort": gate["servingEligibleByCohort"],
            "coldStart": gate["coldStart"],
            "anyCohortServingEligible": gate["anyCohortServingEligible"],
            "validationProtocol": gate.get("validationProtocol", {}),
        }

        receipt = {
            "modelVersion": MODEL_VERSION,
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "categoryId": category_id,
            "wallClockSeconds": round(elapsed, 3),
            "peakRssBytes": _peak_rss_bytes(),
            "selection": {
                str(h_steps): {k: v for k, v in sel.items() if k != "gridScores"}
                for h_steps, sel in selection_json.items()
            },
            "gridScores": {str(h_steps): sel["gridScores"] for h_steps, sel in selection_json.items()},
            "gate": gate_json,
            "totalVariants": out["totalVariants"],
            "sampledVariants": out["sampledVariants"],
            "samplingApplied": out["samplingApplied"],
            "samplingRule": out["samplingRule"],
        }
        (receipts_dir / f"evaluation-category-{category_id}.json").write_text(
            json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8",
        )

        combined_weights[str(category_id)] = {
            str(sel["horizonDays"]): {
                "weightA": sel["weightA"],
                "weightC": sel.get("weightC", 0.0),
                "weightB": sel["weightB"],
            }
            for sel in selection_json.values()
        }

        category_rows.append({
            "categoryId": category_id,
            "selection": {sel["horizonDays"]: sel for sel in selection_json.values()},
            "gate": gate_json,
            "totalVariants": out["totalVariants"],
            "sampledVariants": out["sampledVariants"],
            "samplingApplied": out["samplingApplied"],
            "samplingRule": out["samplingRule"],
        })
        print(
            f"category {category_id}: done in {elapsed:.1f}s, "
            f"anyCohortServingEligible={gate['anyCohortServingEligible']}",
            flush=True,
        )

    weights_path.write_text(json.dumps(combined_weights, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    # Merge from every evaluation-category-*.json present in receipts_dir
    # (not just the categories this invocation just (re-)evaluated) --
    # per-category invocations must not clobber each other's contribution
    # to evaluation-summary.md/json.
    merged_category_rows = _merged_category_rows(receipts_dir)
    summary_md = _render_component_weights_summary_markdown(merged_category_rows)
    (receipts_dir / "evaluation-summary.md").write_text(summary_md, encoding="utf-8")
    (receipts_dir / "evaluation-summary.json").write_text(
        json.dumps({"categories": merged_category_rows}, indent=2, sort_keys=True) + "\n", encoding="utf-8",
    )
    print(f"wrote {weights_path}")
    print(f"wrote {receipts_dir / 'evaluation-summary.md'} ({len(merged_category_rows)} categor{'y' if len(merged_category_rows) == 1 else 'ies'})")
    return 0


def _render_eval_summary_command(args: argparse.Namespace) -> int:
    """Regenerate evaluation-summary.md/json by merging every
    evaluation-category-*.json currently in --receipts-dir. Cheap: no eval
    re-run, just reads existing receipts and re-renders the summary."""

    receipts_dir = Path(args.receipts_dir)
    if not receipts_dir.is_dir():
        print(f"trajectory-cli: receipts dir not found: {receipts_dir}", file=sys.stderr)
        return 2
    category_rows = _merged_category_rows(receipts_dir)
    if not category_rows:
        print(f"trajectory-cli: no evaluation-category-*.json receipts found in {receipts_dir}", file=sys.stderr)
        return 2
    summary_md = _render_component_weights_summary_markdown(category_rows)
    (receipts_dir / "evaluation-summary.md").write_text(summary_md, encoding="utf-8")
    (receipts_dir / "evaluation-summary.json").write_text(
        json.dumps({"categories": category_rows}, indent=2, sort_keys=True) + "\n", encoding="utf-8",
    )
    print(f"wrote {receipts_dir / 'evaluation-summary.md'} ({len(category_rows)} categories)")
    print(f"wrote {receipts_dir / 'evaluation-summary.json'}")
    return 0


def _publish_forecasts_command(args: argparse.Namespace) -> int:
    """Slice recognized packets, labeled by their validated evidence tier,
    into <=--max-object-bytes gzip objects
    under --out-dir, plus forecasts/manifest.json. Gated on an explicit,
    separately-reviewed community-free-access SourceTerms record (tracked
    deviation from T1's research-only assert_tcgcsv_research_terms -- see
    forecast_publisher.py's module docstring); refuses to write anything if
    that gate fails."""

    packets_dir = Path(args.packets_dir)
    if not packets_dir.is_dir():
        print(f"trajectory-cli: packets dir not found: {packets_dir}", file=sys.stderr)
        return 2
    evaluation_summary_path = Path(args.evaluation_summary_path)
    if not evaluation_summary_path.is_file():
        print(f"trajectory-cli: evaluation summary not found: {evaluation_summary_path}", file=sys.stderr)
        return 2
    source_terms_path = Path(args.source_terms_path)
    if not source_terms_path.is_file():
        print(f"trajectory-cli: source terms manifest not found: {source_terms_path}", file=sys.stderr)
        return 2

    category_ids = None
    if args.category_ids:
        category_ids = sorted({int(part) for part in args.category_ids.split(",") if part.strip()})

    # FA-03: reuse the same read-only products-metadata cache loader
    # fit-hedonic already uses (see _load_products_metadata_readonly above)
    # rather than duplicating its cache-reading logic here. Omitted flag =>
    # None => every packet classifies productKind "unknown" (safe default).
    products_metadata = (
        _load_products_metadata_readonly(Path(args.products_cache)) if args.products_cache else None
    )
    # FA-05: optional, additive; forecast_publisher treats a missing path
    # as an exact no-op, so no existence check is needed here.
    msrp_path = Path(args.msrp_path) if args.msrp_path else None

    started = time.monotonic()
    manifest = publish_forecasts(
        packets_dir,
        evaluation_summary_path,
        source_terms_path,
        Path(args.out_dir),
        category_ids=category_ids,
        max_object_bytes=args.max_object_bytes,
        products_metadata=products_metadata,
        msrp_path=msrp_path,
    )
    elapsed_seconds = time.monotonic() - started

    receipts_dir = Path(args.receipts_dir)
    receipts_dir.mkdir(parents=True, exist_ok=True)
    receipt = {
        "task": "T5-publish-forecasts",
        "modelVersion": MODEL_VERSION,
        "generatedAt": manifest["generatedAt"],
        "elapsedSeconds": round(elapsed_seconds, 3),
        "maxObjectBytes": manifest["maxObjectBytes"],
        "manifestContentHash": manifest["manifestContentHash"],
        "sourceTerms": manifest["sourceTerms"],
        "publishAllEvidenceTiers": manifest["publishAllEvidenceTiers"],
        "evidenceTierPolicy": manifest["evidenceTierPolicy"],
        "servedHorizonsByCategory": manifest["servedHorizonsByCategory"],
        "productsCache": str(Path(args.products_cache)) if args.products_cache else None,
        "msrpPath": str(msrp_path) if msrp_path else None,
        "categories": {
            category_id: {
                "totalVariants": row["totalVariants"],
                "eligibleVariants": row["eligibleVariants"],
                "totalGroups": row["totalGroups"],
                "publishedGroups": row["publishedGroups"],
                "excludedGroups": row["excludedGroups"],
                "excludedByCohort": row["excludedByCohort"],
                # FA-02 (anchor_clamp_saturated) / FA-05 (below_msrp_floor)
                "excludedByReason": row["excludedByReason"],
                # FA-03: directional-tier downgrades forced by productKind.
                "directionalDowngradesByKind": row["directionalDowngradesByKind"],
                "objectsWritten": row["objectsWritten"],
                "lastKnownDateRange": row["lastKnownDateRange"],
                "servedHorizonsByCohort": row["servedHorizonsByCohort"],
            }
            for category_id, row in manifest["categories"].items()
        },
    }
    receipt_path = receipts_dir / "publish-forecasts-receipt.json"
    receipt_path.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    total_objects = sum(row["objectsWritten"] for row in manifest["categories"].values())
    total_eligible = sum(row["eligibleVariants"] for row in manifest["categories"].values())
    print(
        f"published {total_objects} object(s) covering {total_eligible} eligible variant(s) "
        f"across {len(manifest['categories'])} categor(y/ies) in {elapsed_seconds:.1f}s"
    )
    print(f"wrote {Path(args.out_dir) / 'forecasts' / 'manifest.json'}")
    print(f"wrote {receipt_path}")
    return 0


def _publish_history_command(args: argparse.Namespace) -> int:
    """0.8.17: slice every category's observed weekly panel prices (ALL
    variants -- history is observed data, no eligibility gate) into
    <=--max-object-bytes gzip objects under --out-dir, plus
    history/manifest.json. Gated on an explicit, separately-reviewed
    community-free-access SourceTerms record authorizing RAW price display
    -- narrower than and separate from T5's derived-forecast record (see
    history_publisher.py's module docstring); refuses to write anything if
    that gate fails."""

    panel_dir = Path(args.panel_dir)
    if not panel_dir.is_dir():
        print(f"trajectory-cli: panel dir not found: {panel_dir}", file=sys.stderr)
        return 2
    source_terms_path = Path(args.source_terms_path)
    if not source_terms_path.is_file():
        print(f"trajectory-cli: source terms manifest not found: {source_terms_path}", file=sys.stderr)
        return 2

    category_ids = None
    if args.category_ids:
        category_ids = sorted({int(part) for part in args.category_ids.split(",") if part.strip()})

    started = time.monotonic()
    manifest = publish_history(
        panel_dir,
        source_terms_path,
        Path(args.out_dir),
        category_ids=category_ids,
        max_object_bytes=args.max_object_bytes,
    )
    elapsed_seconds = time.monotonic() - started

    receipts_dir = Path(args.receipts_dir)
    receipts_dir.mkdir(parents=True, exist_ok=True)
    receipt = {
        "task": "0.8.17-publish-history",
        "modelVersion": manifest["modelVersion"],
        "generatedAt": manifest["generatedAt"],
        "elapsedSeconds": round(elapsed_seconds, 3),
        "maxObjectBytes": manifest["maxObjectBytes"],
        "manifestContentHash": manifest["manifestContentHash"],
        "sourceTerms": manifest["sourceTerms"],
        "categories": {
            category_id: {
                "totalGroups": row["totalGroups"],
                "publishedGroups": row["publishedGroups"],
                "excludedGroups": row["excludedGroups"],
                "totalVariants": row["totalVariants"],
                "objectsWritten": row["objectsWritten"],
            }
            for category_id, row in manifest["categories"].items()
        },
    }
    receipt_path = receipts_dir / "publish-history-receipt.json"
    receipt_path.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    total_objects = sum(row["objectsWritten"] for row in manifest["categories"].values())
    total_variants = sum(row["totalVariants"] for row in manifest["categories"].values())
    print(
        f"published {total_objects} object(s) covering {total_variants} variant(s) "
        f"across {len(manifest['categories'])} categor(y/ies) in {elapsed_seconds:.1f}s"
    )
    print(f"wrote {Path(args.out_dir) / 'history' / 'manifest.json'}")
    print(f"wrote {receipt_path}")
    return 0


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "trajectory-v1 index + per-card forecast engine CLI (PRD task T2). "
            "`build-indices` builds the shared market/game/set indices and release-age "
            "lifecycle curve once; `run-category` processes one category's variants at a "
            "time (damped-trend + Theta + shrinkage + split-conformal) and emits its packet "
            "file; `report` aggregates already-written per-category receipts."
        ),
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    build = subparsers.add_parser(
        "build-indices",
        help="build and cache the shared market/game/set indices + release-age lifecycle curve",
    )
    build.add_argument(
        "--category-id", action="append", type=int,
        help=f"repeatable; defaults to {list(DEFAULT_CATEGORY_IDS)}",
    )
    build.add_argument("--panel-dir", default="analytics/data/panel")
    build.add_argument("--state-dir", default="analytics/data/trajectory")
    build.add_argument("--receipts-dir", default="docs/receipts/trajectory-v1")
    build.add_argument("--trim-fraction", type=float, default=0.1)
    build.add_argument("--refresh-groups", action="store_true", help="refetch groups metadata even if cached")
    build.add_argument("--base-url", default="https://tcgcsv.com/")
    build.add_argument(
        "--user-agent",
        default="CollectFolio/0.1 trajectory-v1 lifecycle library (community-free-access)",
    )
    build.add_argument("--timeout-seconds", type=float, default=30.0)
    build.set_defaults(handler=_build_indices_command)

    run = subparsers.add_parser(
        "run-category",
        help="process exactly one category's variants and emit its packet file + receipt",
    )
    run.add_argument("--category-id", type=int, required=True)
    run.add_argument("--panel-dir", default="analytics/data/panel")
    run.add_argument("--state-dir", default="analytics/data/trajectory")
    run.add_argument("--packets-dir", default="analytics/data/trajectory/packets")
    run.add_argument("--receipts-dir", default="docs/receipts/trajectory-v1")
    run.add_argument(
        "--hedonic-predictions-path", default=None,
        help="override path to a fit-hedonic predictions cache; defaults to the state-dir convention",
    )
    run.add_argument(
        "--no-hedonic", action="store_true",
        help="skip loading any cached hedonic predictions even if present (pre-T3 behavior)",
    )
    run.add_argument(
        "--component-weights-path", default=None,
        help=(
            "path to a trajectory-v1.1 component-weights.json receipt with this "
            "category's selected per-horizon (a, c, b); defaults to "
            "<receipts-dir>/component-weights.json. When absent or missing this "
            "category, every horizon implicitly uses the legacy-compatible "
            "(1.0, 0.0, 1.0)."
        ),
    )
    run.set_defaults(handler=_run_category_command)

    eval_weights = subparsers.add_parser(
        "eval-component-weights",
        help=(
            "trajectory-v1.1 per-(category, horizon) coefficient selection plus causal "
            "rolling held-out-set qualification, writing "
            "component-weights.json + evaluation-category-<id>.json + evaluation-summary.md/json"
        ),
    )
    eval_weights.add_argument(
        "--category-ids", required=True,
        help="comma-separated category ids to evaluate, e.g. 1,2,3,85",
    )
    eval_weights.add_argument("--panel-dir", default="analytics/data/panel")
    eval_weights.add_argument("--state-dir", default="analytics/data/trajectory")
    eval_weights.add_argument("--receipts-dir", default="docs/receipts/trajectory-v1")
    eval_weights.add_argument(
        "--max-variants-per-category", type=int, default=DEFAULT_MAX_VARIANTS_PER_CATEGORY,
        help=(
            "deterministic cap on variants considered per category (sha256-ranked N-of-M "
            "sample, no-op when the category has fewer variants); bounds raw-case-collection "
            "RSS on categories with very large variant counts"
        ),
    )
    eval_weights.set_defaults(handler=_eval_component_weights_command)

    render_eval_summary = subparsers.add_parser(
        "render-eval-summary",
        help=(
            "Regenerate evaluation-summary.md/json by merging every "
            "evaluation-category-*.json present in --receipts-dir. Cheap: reads "
            "existing receipts only, no eval re-run."
        ),
    )
    render_eval_summary.add_argument("--receipts-dir", default="docs/receipts/trajectory-v1")
    render_eval_summary.set_defaults(handler=_render_eval_summary_command)

    fetch_products = subparsers.add_parser(
        "fetch-products",
        help=(
            "bounded, resumable fetch of products metadata (card number/rarity) for the cached "
            "group id list; polite one-request-per-group with a delay, safe to re-invoke to resume"
        ),
    )
    fetch_products.add_argument(
        "--category-id", action="append", type=int,
        help=f"repeatable; defaults to {list(DEFAULT_CATEGORY_IDS)}",
    )
    fetch_products.add_argument("--state-dir", default="analytics/data/trajectory")
    fetch_products.add_argument("--receipts-dir", default="docs/receipts/trajectory-v1")
    fetch_products.add_argument(
        "--products-cache", default=None,
        help="override cache path; defaults to <state-dir>/hedonic/products_metadata.json.gz",
    )
    fetch_products.add_argument("--max-requests", type=int, default=2_000)
    fetch_products.add_argument("--base-url", default="https://tcgcsv.com/")
    fetch_products.add_argument(
        "--user-agent",
        default="CollectFolio/0.1 trajectory-v1 lifecycle library (community-free-access)",
    )
    fetch_products.add_argument("--timeout-seconds", type=float, default=30.0)
    fetch_products.set_defaults(handler=_fetch_products_command)

    fit_hedonic = subparsers.add_parser(
        "fit-hedonic",
        help=(
            "fit the per-category hedonic log-price regression + video_model_v0 ablation, "
            "compute cold-start candidate predictions, and cache predictions for run-category"
        ),
    )
    fit_hedonic.add_argument("--category-id", type=int, required=True)
    fit_hedonic.add_argument("--panel-dir", default="analytics/data/panel")
    fit_hedonic.add_argument("--state-dir", default="analytics/data/trajectory")
    fit_hedonic.add_argument("--receipts-dir", default="docs/receipts/trajectory-v1")
    fit_hedonic.add_argument(
        "--products-cache", default=None,
        help=(
            "path to an already-fetched products metadata cache (see fetch-products); read-only, "
            "never fetched here. Omit to fit on finish/release-age/set-family/kind/group-price "
            "features alone (graceful degradation per PRD)."
        ),
    )
    fit_hedonic.set_defaults(handler=_fit_hedonic_command)

    report = subparsers.add_parser(
        "report",
        help="aggregate already-written per-category receipts into one run summary; no network",
    )
    report.add_argument("--receipts-dir", default="docs/receipts/trajectory-v1")
    report.set_defaults(handler=_report_command)

    publish = subparsers.add_parser(
        "publish-forecasts",
        help=(
            "slice recognized packets with per-horizon evidence tiers into <=128KiB "
            "gzip objects + forecasts/manifest.json "
            "under --out-dir, gated on an explicit community-free-access SourceTerms record"
        ),
    )
    publish.add_argument("--packets-dir", default="analytics/data/trajectory/packets")
    publish.add_argument("--evaluation-summary-path", default="docs/receipts/trajectory-v1/evaluation-summary.json")
    publish.add_argument(
        "--source-terms-path",
        default="analytics/manifests/tcgcsv-community-free-access-derived-forecasts.json",
    )
    publish.add_argument("--out-dir", default="analytics/data/publish")
    publish.add_argument("--receipts-dir", default="docs/receipts/trajectory-v1")
    publish.add_argument(
        "--category-ids", default=None,
        help="comma-separated category ids to publish; defaults to every category-<id> dir found",
    )
    publish.add_argument("--max-object-bytes", type=int, default=DEFAULT_MAX_OBJECT_BYTES)
    publish.add_argument(
        "--products-cache", default=None,
        help=(
            "FA-03 serving contract: path to an already-fetched products-metadata "
            "cache (the same file `fetch-products` writes and `fit-hedonic` reads, "
            "state-dir/hedonic/products_metadata.json.gz by default) used to "
            "classify every packet's productKind (single/sealed) via "
            "hedonic_features.product_kind. NOT REQUIRED, but the default when "
            "omitted is deliberately conservative: every variant classifies as "
            "'unknown', and the serving gate treats 'unknown' exactly like "
            "'sealed' -- it may only ever serve a non-directional (range-only / "
            "attribute-reference) tier, never category-validated or "
            "relative-validated, no matter what the evidence-tier map says. Pass "
            "this flag so validated single-card cohorts can serve their real "
            "directional tier; sealed products are never affected either way."
        ),
    )
    publish.add_argument(
        "--msrp-path", default="analytics/manifests/sealed-msrp.json",
        help=(
            "FA-05: JSON file mapping productId -> {msrp, inPrint} (see that "
            "file for the schema) used to withhold (never clamp upward) a "
            "sealed, in-print band whose q50 falls below 80%% of MSRP at some "
            "horizon. Defaults to the checked-in curated seed, which starts "
            "empty and is therefore an exact no-op until hand-curated. A path "
            "that does not exist on disk is also an exact no-op (the gate is "
            "purely additive, never required)."
        ),
    )
    publish.set_defaults(handler=_publish_forecasts_command)

    publish_history = subparsers.add_parser(
        "publish-history",
        help=(
            "0.8.17: slice every category's observed weekly panel prices (ALL variants, no "
            "eligibility gate -- history is observed data) into <=128KiB gzip objects + "
            "history/manifest.json under --out-dir, gated on an explicit community-free-access "
            "SourceTerms record authorizing RAW price display (separate from publish-forecasts' "
            "derived-forecast record)"
        ),
    )
    publish_history.add_argument("--panel-dir", default="analytics/data/panel")
    publish_history.add_argument(
        "--source-terms-path",
        default="analytics/manifests/tcgcsv-community-free-access-history.json",
    )
    publish_history.add_argument("--out-dir", default="analytics/data/publish")
    publish_history.add_argument("--receipts-dir", default="docs/receipts/trajectory-v1")
    publish_history.add_argument(
        "--category-ids", default=None,
        help="comma-separated category ids to publish; defaults to every category-<id> dir found",
    )
    publish_history.add_argument("--max-object-bytes", type=int, default=HISTORY_DEFAULT_MAX_OBJECT_BYTES)
    publish_history.set_defaults(handler=_publish_history_command)

    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        return int(args.handler(args))
    except (OSError, ValueError, RuntimeError, LifecycleError) as exc:
        print(f"trajectory-cli: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
