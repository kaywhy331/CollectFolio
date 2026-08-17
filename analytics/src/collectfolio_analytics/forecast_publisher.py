"""T5: publish eligible per-variant trajectory-v1 packets as per-group,
size-bounded, gzip-compressed JSON objects for the worker to serve.

Reads analytics/data/trajectory/packets/category-<id>/packets.jsonl.gz
(T2/T3/T4 output) and docs/receipts/trajectory-v1/evaluation-summary.json
(T4 output), applies the T4 fail-closed serving-eligibility gate, and slices
the surviving packets into <=128KiB gzip objects keyed
forecasts/<categoryId>/<groupId>.json.gz (or deterministic
``.partN.json.gz`` siblings when a group's eligible packets don't fit in
one object -- never silently truncated), plus a forecasts/manifest.json
summarizing every category+group (published or excluded, and why) so the
serving app can distinguish "excluded cohort" from "unknown product".

Community-free-access derived-forecast publication requires an explicit,
separately-reviewed SourceTerms record -- see
``assert_tcgcsv_community_free_access_terms`` in ``tcgcsv.py`` and
``analytics/manifests/tcgcsv-community-free-access-derived-forecasts.json``
for the record and its rationale (tracked deviation from T1).
"""

from __future__ import annotations

import gzip
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Mapping, Sequence
from uuid import UUID

from .market_pipeline import SourceTerms
from .tcgcsv import assert_tcgcsv_community_free_access_terms
from .trajectory import MODEL_VERSION, content_sha256

DEFAULT_MAX_OBJECT_BYTES = 128 * 1024

# Cold-start is unevaluable by construction (no walk-forward truth exists
# for variants with zero observed prices anywhere in the panel) -- per PRD
# Sec4 hard criterion 3b it serves everywhere, with this explicit label,
# independent of any category/cohort gate outcome.
COLD_START_CONFIDENCE = "cold-start"

# T5 90d-only serving mode. Kevin's 2026-08-17 "forecasts should be for all
# products" directive activates a near-miss the T4 gate itself had already
# flagged as informational-only (see trajectory_cli._near_miss_notes /
# evaluation-summary.md "Near-miss notes"): category 1 (Magic) and category 2
# (Yu-Gi-Oh) standard-cohort packets pass the holdout gate at 90 days but not
# at 30. This is a narrowly scoped, explicitly reviewed allowlist -- never an
# automatic "any near miss ships" policy -- and every (category, cohort) pair
# on it still has its 90-day pass independently re-checked against the
# evaluation data at publish time (see eligible_horizons); it is never
# trusted blindly. 30d for these two stays "not enough evidence" in the app,
# never a fabricated value.
NINETY_DAY_ONLY_OVERRIDE: frozenset[tuple[int, str]] = frozenset({
    (1, "standard"),
    (2, "standard"),
})


# ---------------------------------------------------------------------------
# SourceTerms manifest loading (mirrors cardbase_history_cli.py's pattern).
# ---------------------------------------------------------------------------


def _mapping(value: object, name: str) -> Mapping[str, object]:
    if not isinstance(value, Mapping):
        raise ValueError(f"{name} must be an object")
    return value


def _text(value: object, name: str, *, optional: bool = False) -> str:
    if optional and value in (None, ""):
        return ""
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{name} must be non-empty")
    return value.strip()


def _bool(value: object, name: str) -> bool:
    if not isinstance(value, bool):
        raise ValueError(f"{name} must be boolean")
    return value


def _uuid(value: object, name: str) -> str:
    try:
        return str(UUID(_text(value, name)))
    except ValueError as exc:
        raise ValueError(f"{name} must be a UUID") from exc


def _datetime(value: object, name: str) -> datetime:
    raw = _text(value, name)
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(f"{name} must be an ISO timestamp") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError(f"{name} must include a timezone")
    return parsed.astimezone(timezone.utc)


def _optional_datetime(value: object, name: str) -> datetime | None:
    return None if value in (None, "") else _datetime(value, name)


def load_source_terms(path: Path) -> SourceTerms:
    """Load a community-free-access SourceTerms manifest (JSON), the same
    shape as the existing research-only manifests under analytics/manifests/
    (see cardbase_history_cli.py's ``_source_terms`` for the sibling
    loader). Underscore-prefixed top-level keys (``_rationale`` etc.) are
    documentation only and ignored here."""

    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    source = _mapping(payload.get("source"), "source")
    return SourceTerms(
        source_id=_uuid(source.get("id"), "source.id"),
        terms_review_id=_uuid(source.get("termsReviewId"), "source.termsReviewId"),
        current_terms_review_id=_uuid(source.get("currentTermsReviewId"), "source.currentTermsReviewId"),
        source_code=_text(source.get("code"), "source.code"),
        source_name=_text(source.get("name"), "source.name"),
        decision=_text(source.get("decision"), "source.decision"),
        active=_bool(source.get("active"), "source.active"),
        commercial_use_allowed=_bool(source.get("commercialUseAllowed"), "source.commercialUseAllowed"),
        catalog_metadata_allowed=_bool(source.get("catalogMetadataAllowed"), "source.catalogMetadataAllowed"),
        public_raw_display_allowed=_bool(source.get("publicRawDisplayAllowed"), "source.publicRawDisplayAllowed"),
        public_derived_display_allowed=_bool(
            source.get("publicDerivedDisplayAllowed"), "source.publicDerivedDisplayAllowed"
        ),
        attribution_required=_bool(source.get("attributionRequired"), "source.attributionRequired"),
        attribution_text=_text(source.get("attributionText"), "source.attributionText", optional=True),
        document_hash=_text(source.get("documentHash"), "source.documentHash"),
        reviewed_at=_datetime(source.get("reviewedAt"), "source.reviewedAt"),
        expires_at=_optional_datetime(source.get("expiresAt"), "source.expiresAt"),
    )


# ---------------------------------------------------------------------------
# Serving eligibility (T4 fail-closed gate, from evaluation-summary.json).
# ---------------------------------------------------------------------------


def load_serving_eligibility(evaluation_summary_path: Path) -> dict[int, dict[str, bool]]:
    """{categoryId: {cohort: servingEligible}} straight from T4's merged
    evaluation-summary.json (``categories[].gate.servingEligibleByCohort``).
    Fail-closed: any (category, cohort) not present here is NOT eligible."""

    payload = json.loads(Path(evaluation_summary_path).read_text(encoding="utf-8"))
    by_category: dict[int, dict[str, bool]] = {}
    for row in payload.get("categories", []):
        category_id = int(row["categoryId"])
        by_category[category_id] = {
            str(cohort): bool(eligible)
            for cohort, eligible in row.get("gate", {}).get("servingEligibleByCohort", {}).items()
        }
    return by_category


def is_packet_eligible(
    category_id: int, confidence: str, serving_eligibility: Mapping[int, Mapping[str, bool]]
) -> bool:
    """Fail-closed eligibility: cold-start serves everywhere (PRD Sec4 hard
    criterion 3b, unevaluable by construction); every other cohort must be
    explicitly True in the T4 holdout gate's servingEligibleByCohort for
    its category. Anything not explicitly True -- including an unknown
    category or an unrecognized cohort string -- is excluded."""

    if confidence == COLD_START_CONFIDENCE:
        return True
    return bool(serving_eligibility.get(category_id, {}).get(confidence, False))


def load_serving_eligibility_by_horizon(evaluation_summary_path: Path) -> dict[int, dict[str, dict[int, bool]]]:
    """{categoryId: {cohort: {horizonDays: servingEligible}}} from T4's
    merged evaluation-summary.json (``categories[].gate.results``), the
    same per-(cohort, horizon) pass/fail data the near-miss notes are built
    from. Fail-closed: any (category, cohort, horizon) not present is NOT
    eligible."""

    payload = json.loads(Path(evaluation_summary_path).read_text(encoding="utf-8"))
    by_category: dict[int, dict[str, dict[int, bool]]] = {}
    for row in payload.get("categories", []):
        category_id = int(row["categoryId"])
        by_cohort: dict[str, dict[int, bool]] = {}
        for result in row.get("gate", {}).get("results", []):
            by_cohort.setdefault(str(result["cohort"]), {})[int(result["horizonDays"])] = bool(
                result.get("servingEligible", False)
            )
        by_category[category_id] = by_cohort
    return by_category


def eligible_horizons(
    category_id: int,
    confidence: str,
    serving_eligibility: Mapping[int, Mapping[str, bool]],
    serving_eligibility_by_horizon: Mapping[int, Mapping[str, Mapping[int, bool]]],
) -> tuple[int, ...]:
    """Which of trajectory-v1's {30, 90} horizons this (category, cohort)
    may serve. Cold-start serves both, always (PRD Sec4 hard criterion 3b).
    A cohort that clears the gate at both horizons serves both. Otherwise,
    only a curated (category, cohort) on NINETY_DAY_ONLY_OVERRIDE -- and
    only once its 90-day pass is independently re-confirmed here -- serves
    90d alone. Everything else serves nothing: the app must render "not
    enough evidence" for that packet rather than a fabricated value."""

    if confidence == COLD_START_CONFIDENCE:
        return (30, 90)
    if is_packet_eligible(category_id, confidence, serving_eligibility):
        return (30, 90)
    if (category_id, confidence) in NINETY_DAY_ONLY_OVERRIDE:
        by_horizon = serving_eligibility_by_horizon.get(category_id, {}).get(confidence, {})
        if by_horizon.get(90, False):
            return (90,)
    return ()


# ---------------------------------------------------------------------------
# Deterministic size-bounded slicing.
# ---------------------------------------------------------------------------


def _canonical_json_bytes(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def gzip_bytes(data: bytes) -> bytes:
    # mtime=0 keeps the gzip header (and therefore the object bytes and
    # their contentHash) deterministic across runs/machines.
    return gzip.compress(data, compresslevel=9, mtime=0)


def _variant_sort_key(variant: Mapping[str, object]) -> tuple[int, str]:
    return (int(variant["productId"]), str(variant["subTypeName"]))


def _group_object_payload(
    category_id: int, group_id: int, variants: Sequence[Mapping[str, object]], *, part: int, parts_total: int
) -> dict[str, object]:
    as_of_values = sorted({str(v["asOf"]) for v in variants}) if variants else []
    return {
        "modelVersion": MODEL_VERSION,
        "categoryId": category_id,
        "groupId": group_id,
        "asOf": as_of_values[-1] if as_of_values else None,
        "part": part,
        "partsTotal": parts_total,
        "variants": [
            {
                "productId": v["productId"],
                "subTypeName": v["subTypeName"],
                "confidence": v["confidence"],
                "sampleSize": v["sampleSize"],
                "volatilityBucket": v["volatilityBucket"],
                "lastKnownDate": v["lastKnownDate"],
                "lastKnownPrice": v["lastKnownPrice"],
                "horizons": v["horizons"],
                "medianPath": v["medianPath"],
            }
            for v in variants
        ],
    }


def _fits(
    category_id: int, group_id: int, variants: Sequence[Mapping[str, object]], max_object_bytes: int
) -> bool:
    payload = _group_object_payload(category_id, group_id, variants, part=1, parts_total=1)
    return len(gzip_bytes(_canonical_json_bytes(payload))) <= max_object_bytes


def _max_fitting_prefix(
    category_id: int, group_id: int, remaining: Sequence[Mapping[str, object]], max_object_bytes: int
) -> int:
    """Largest k such that remaining[:k] gzips to <= max_object_bytes,
    found by exponential-then-binary search (O(log n) compressions). If
    even a single variant doesn't fit, returns 1 anyway -- callers must
    NOT silently drop it; it becomes its own oversized part instead."""

    n = len(remaining)
    if n == 0:
        return 0
    if not _fits(category_id, group_id, remaining[:1], max_object_bytes):
        return 1
    if _fits(category_id, group_id, remaining[:n], max_object_bytes):
        return n
    lo, hi = 1, n  # invariant: remaining[:lo] fits, remaining[:hi] does not
    while lo + 1 < hi:
        mid = (lo + hi) // 2
        if _fits(category_id, group_id, remaining[:mid], max_object_bytes):
            lo = mid
        else:
            hi = mid
    return lo


@dataclass(frozen=True, slots=True)
class GroupPart:
    part: int
    parts_total: int
    variants: tuple[Mapping[str, object], ...]
    object_bytes: bytes
    gzip_bytes: bytes
    oversized: bool


def split_group_variants_deterministic(
    category_id: int,
    group_id: int,
    variants: Sequence[Mapping[str, object]],
    *,
    max_object_bytes: int = DEFAULT_MAX_OBJECT_BYTES,
) -> list[GroupPart]:
    """Deterministically order and pack ``variants`` (already
    eligibility-filtered) into the fewest gzip objects that each stay
    <= max_object_bytes, splitting into part files when one object isn't
    enough. Ordering is by (productId, subTypeName) so re-running on the
    same input always produces byte-identical parts (same variants, same
    order, same split boundaries) -- reproducible, not order-of-collection
    dependent. Never drops a variant: a single variant that alone exceeds
    max_object_bytes still becomes its own ``oversized=True`` part rather
    than being silently truncated."""

    ordered = sorted(variants, key=_variant_sort_key)
    if not ordered:
        return []

    chunks: list[list[Mapping[str, object]]] = []
    remaining = ordered
    while remaining:
        k = _max_fitting_prefix(category_id, group_id, remaining, max_object_bytes)
        k = max(k, 1)
        chunks.append(list(remaining[:k]))
        remaining = remaining[k:]

    # Fixed-point pass: re-check every chunk against its REAL final
    # part/partsTotal numbering (not the part=1/partsTotal=1 numbering
    # `_max_fitting_prefix` probed with). Growing the chunk count, or even
    # just widening a partsTotal digit, perturbs the gzip byte stream --
    # compressed size is not simply additive with content length, so a
    # chunk that fit the probe can still land a byte or two over budget
    # once correctly numbered. Peel the last variant off any
    # multi-variant chunk that's still over budget and retry until no
    # chunk changes; peeling strictly shrinks the offending chunk each
    # round, so this always terminates (single-variant chunks are never
    # peeled further -- they surface as oversized=True instead, never
    # silently truncated).
    for _ in range(len(ordered) + 4):
        parts_total = len(chunks)
        rebuilt: list[list[Mapping[str, object]]] = []
        changed = False
        for index, chunk in enumerate(chunks, start=1):
            payload = _group_object_payload(category_id, group_id, chunk, part=index, parts_total=parts_total)
            compressed = gzip_bytes(_canonical_json_bytes(payload))
            if len(compressed) > max_object_bytes and len(chunk) > 1:
                rebuilt.append(chunk[:-1])
                rebuilt.append([chunk[-1]])
                changed = True
            else:
                rebuilt.append(chunk)
        chunks = rebuilt
        if not changed:
            break

    parts_total = len(chunks)
    parts: list[GroupPart] = []
    for index, chunk in enumerate(chunks, start=1):
        payload = _group_object_payload(category_id, group_id, chunk, part=index, parts_total=parts_total)
        raw = _canonical_json_bytes(payload)
        compressed = gzip_bytes(raw)
        parts.append(
            GroupPart(
                part=index,
                parts_total=parts_total,
                variants=tuple(chunk),
                object_bytes=raw,
                gzip_bytes=compressed,
                oversized=len(compressed) > max_object_bytes,
            )
        )
    return parts


def object_key(category_id: int, group_id: int, part: int, parts_total: int) -> str:
    if parts_total <= 1:
        return f"forecasts/{category_id}/{group_id}.json.gz"
    return f"forecasts/{category_id}/{group_id}.part{part}.json.gz"


# ---------------------------------------------------------------------------
# Category / full-run orchestration.
# ---------------------------------------------------------------------------


def _sha256_hex(data: bytes) -> str:
    from hashlib import sha256

    return sha256(data).hexdigest()


def _iter_category_packets(packets_path: Path):
    with gzip.open(packets_path, "rt", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line:
                yield json.loads(line)


def publish_category(
    category_id: int,
    packets_path: Path,
    serving_eligibility: Mapping[int, Mapping[str, bool]],
    staging_root: Path,
    *,
    max_object_bytes: int = DEFAULT_MAX_OBJECT_BYTES,
    serving_eligibility_by_horizon: Mapping[int, Mapping[str, Mapping[int, bool]]] | None = None,
) -> dict:
    """Stream one category's packets.jsonl.gz, apply the fail-closed
    eligibility filter, group survivors by groupId, slice each group into
    <=max_object_bytes gzip objects under staging_root, and return this
    category's manifest contribution (every group present -- published or
    excluded -- so the app can tell "excluded cohort" from "unknown
    product": a groupId simply absent from the manifest never existed in
    this category's panel at all).

    A packet whose cohort clears the gate at only one horizon (currently
    only category 1/2 "standard" via NINETY_DAY_ONLY_OVERRIDE) is still
    included, but with the failing horizon's key stripped from its
    ``horizons`` object -- never a fabricated value for that horizon, and
    the app's existing "missing horizon -> not enough evidence" rendering
    already covers the gap with no display-side change required."""

    serving_eligibility_by_horizon = serving_eligibility_by_horizon or {}
    by_group: dict[int, list[Mapping[str, object]]] = {}
    all_group_ids: set[int] = set()
    total_variants = 0
    excluded_by_cohort: dict[str, int] = {}
    last_known_dates: list[str] = []
    served_horizons_by_cohort: dict[str, set[int]] = {}

    for packet in _iter_category_packets(packets_path):
        total_variants += 1
        group_id = int(packet["groupId"])
        all_group_ids.add(group_id)
        confidence = str(packet["confidence"])
        horizons = eligible_horizons(category_id, confidence, serving_eligibility, serving_eligibility_by_horizon)
        if horizons:
            served_horizons_by_cohort.setdefault(confidence, set()).update(horizons)
            served_packet = packet
            packet_horizon_keys = set(packet.get("horizons") or {})
            if packet_horizon_keys - {str(h) for h in horizons}:
                served_packet = {
                    **packet,
                    "horizons": {
                        key: band for key, band in packet["horizons"].items() if int(key) in horizons
                    },
                }
            by_group.setdefault(group_id, []).append(served_packet)
            last_known_date = packet["lastKnownDate"]
            if last_known_date is not None:
                # cold-start packets carry no observed price history, so
                # lastKnownDate is legitimately null -- exclude, don't
                # coerce to the string "None" (which would sort ahead of
                # real ISO dates and corrupt the staleness-rule range).
                last_known_dates.append(str(last_known_date))
        else:
            excluded_by_cohort[confidence] = excluded_by_cohort.get(confidence, 0) + 1

    groups_manifest: dict[str, object] = {}
    objects_written = 0
    for group_id in sorted(all_group_ids):
        variants = by_group.get(group_id)
        if not variants:
            groups_manifest[str(group_id)] = {
                "status": "excluded",
                "reason": "no eligible cohort for this category/group's variants",
                "eligibleVariantCount": 0,
            }
            continue

        parts = split_group_variants_deterministic(
            category_id, group_id, variants, max_object_bytes=max_object_bytes
        )
        part_entries = []
        for part in parts:
            key = object_key(category_id, group_id, part.part, part.parts_total)
            dest = staging_root / key
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(part.gzip_bytes)
            objects_written += 1
            part_entries.append({
                "objectKey": key,
                "part": part.part,
                "partsTotal": part.parts_total,
                "variantCount": len(part.variants),
                "bytes": len(part.gzip_bytes),
                "contentHash": _sha256_hex(part.gzip_bytes),
                "oversized": part.oversized,
            })
        groups_manifest[str(group_id)] = {
            "status": "published",
            "eligibleVariantCount": len(variants),
            "parts": part_entries,
        }

    return {
        "categoryId": category_id,
        "totalVariants": total_variants,
        "eligibleVariants": sum(len(v) for v in by_group.values()),
        "totalGroups": len(all_group_ids),
        "publishedGroups": sum(1 for g in groups_manifest.values() if g["status"] == "published"),
        "excludedGroups": sum(1 for g in groups_manifest.values() if g["status"] == "excluded"),
        "excludedByCohort": excluded_by_cohort,
        "objectsWritten": objects_written,
        "lastKnownDateRange": {
            "earliest": min(last_known_dates) if last_known_dates else None,
            "latest": max(last_known_dates) if last_known_dates else None,
        },
        "servedHorizonsByCohort": {
            cohort: sorted(horizons) for cohort, horizons in sorted(served_horizons_by_cohort.items())
        },
        "groups": groups_manifest,
    }


def publish_forecasts(
    packets_dir: Path,
    evaluation_summary_path: Path,
    source_terms_path: Path,
    staging_root: Path,
    *,
    category_ids: Sequence[int] | None = None,
    max_object_bytes: int = DEFAULT_MAX_OBJECT_BYTES,
    at: datetime | None = None,
) -> dict:
    """Full T5 publish run: assert community-free-access publication
    rights, load the T4 fail-closed serving-eligibility gate, then slice
    every requested category's eligible packets into staging_root. Returns
    (and writes to staging_root/forecasts/manifest.json) the combined
    manifest: per-category+group counts, the eligibility policy that drove
    inclusion, asOf/modelVersion, per-object contentHash, and this
    generation's receipt."""

    instant = at or datetime.now(timezone.utc)
    terms = load_source_terms(Path(source_terms_path))
    assert_tcgcsv_community_free_access_terms(terms, instant)

    serving_eligibility = load_serving_eligibility(Path(evaluation_summary_path))
    serving_eligibility_by_horizon = load_serving_eligibility_by_horizon(Path(evaluation_summary_path))

    packets_dir = Path(packets_dir)
    if category_ids is None:
        discovered = []
        for child in sorted(packets_dir.glob("category-*")):
            packets_path = child / "packets.jsonl.gz"
            if packets_path.is_file():
                discovered.append(int(child.name.removeprefix("category-")))
        category_ids = sorted(discovered)

    staging_root = Path(staging_root)
    category_rows = []
    for category_id in category_ids:
        packets_path = packets_dir / f"category-{category_id}" / "packets.jsonl.gz"
        if not packets_path.is_file():
            raise FileNotFoundError(f"no packets.jsonl.gz for category {category_id} under {packets_dir}")
        category_rows.append(
            publish_category(
                category_id, packets_path, serving_eligibility, staging_root,
                max_object_bytes=max_object_bytes,
                serving_eligibility_by_horizon=serving_eligibility_by_horizon,
            )
        )

    all_dates = [
        row["lastKnownDateRange"][edge]
        for row in category_rows
        for edge in ("earliest", "latest")
        if row["lastKnownDateRange"][edge] is not None
    ]

    manifest = {
        "modelVersion": MODEL_VERSION,
        "generatedAt": instant.isoformat(),
        "asOf": instant.date().isoformat(),
        "maxObjectBytes": max_object_bytes,
        "sourceTerms": {
            "sourceCode": terms.source_code,
            "decision": terms.decision,
            "documentHash": terms.document_hash,
            "attributionRequired": terms.attribution_required,
            "attributionText": terms.attribution_text,
        },
        "eligibilityPolicy": {
            str(category_id): {
                **cohorts,
                COLD_START_CONFIDENCE: True,
            }
            for category_id, cohorts in serving_eligibility.items()
        },
        # Per-(category, cohort) list of horizon days actually served,
        # straight from what publish_category served (not merely gate
        # eligibility) -- covers both full-eligibility {30, 90} cohorts and
        # the curated 90d-only NINETY_DAY_ONLY_OVERRIDE cohorts (cat 1/2
        # "standard", enabled by Kevin's 2026-08-17 "all products"
        # directive). A cohort/category pair with no eligible horizon at
        # all is simply absent.
        "servedHorizonsByCategory": {
            str(row["categoryId"]): row["servedHorizonsByCohort"] for row in category_rows
        },
        "ninetyDayOnlyCohorts": [
            f"{category_id}:{cohort}" for category_id, cohort in sorted(NINETY_DAY_ONLY_OVERRIDE)
        ],
        "lastKnownDateRange": {
            "earliest": min(all_dates) if all_dates else None,
            "latest": max(all_dates) if all_dates else None,
        },
        "categories": {str(row["categoryId"]): row for row in category_rows},
    }
    manifest["manifestContentHash"] = content_sha256(manifest)

    manifest_path = staging_root / "forecasts" / "manifest.json"
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    return manifest
