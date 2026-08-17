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
import resource
import sys
import time
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
from .indices import IndexSet, build_indices
from .lifecycle import (
    GROUPS_CACHE_FILENAME,
    LifecycleCurve,
    LifecycleError,
    build_lifecycle_curve,
    load_or_fetch_groups_metadata,
)
from .tcgcsv_panel import DEFAULT_CATEGORY_IDS
from .trajectory import HORIZONS_DAYS, MODEL_VERSION, content_sha256, process_category

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

    started = time.monotonic()
    result = process_category(
        panel_dir, category_id, index_set, curve, groups_metadata,
        Path(args.packets_dir), horizons_days=HORIZONS_DAYS,
        hedonic_log_price=hedonic_log_price, cold_start_variants=cold_start_variants,
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
        "# trajectory-v1 -- per-card forecast run summary",
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
    run.set_defaults(handler=_run_category_command)

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
