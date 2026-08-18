"""0.8.17: publish per-group TCGCSV weekly price-HISTORY objects from the
weekly panel (``analytics/data/panel``, ``tcgcsv_panel.py``'s output) as
size-bounded, gzip-compressed JSON objects for the worker to serve.

Reads every requested category's ``analytics/data/panel/category-<id>/
<date>.jsonl.gz`` weekly panel files and slices, per group, the observed
per-variant price series into <=128KiB gzip objects keyed
``history/<categoryId>/<groupId>.json.gz`` (or deterministic
``.partN.json.gz`` siblings when a group's variants don't fit in one
object -- never silently truncated), plus a ``history/manifest.json``
summarizing every category+group.

Unlike ``forecast_publisher.py``'s T5 derived-forecast publication, history
objects republish TCGCSV's own raw historical prices -- observed data, not
a model prediction -- so ALL variants publish (no T4 holdout-gate
eligibility filter: there is nothing to hold out, the numbers are simply
what TCGCSV reported that week). Publication instead requires its own
explicit, separately-reviewed SourceTerms record -- see
``assert_tcgcsv_community_free_access_history_terms`` in ``tcgcsv.py`` and
``analytics/manifests/tcgcsv-community-free-access-history.json`` for the
record and its rationale (tracked deviation, narrower than and separate
from T5's derived-forecast record, which explicitly does not cover raw
TCGCSV price data).
"""

from __future__ import annotations

import gzip
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path
from typing import Mapping, Sequence

from .indices import discover_panel_dates
from .tcgcsv import assert_tcgcsv_community_free_access_history_terms
from .tcgcsv_panel import PRICE_FIELDS
from .trajectory import content_sha256

DEFAULT_MAX_OBJECT_BYTES = 128 * 1024

#: Weekly panel is already sampled at ARCHIVE_INTERVAL_DAYS=7; this simply
#: bounds how many trailing weekly points a single variant ever republishes
#: (PRD-aligned with the panel's own 80-Saturday backfill horizon).
MAX_POINTS_PER_VARIANT = 80

HISTORY_MODEL_VERSION = "tcgcsv-history-v1"


# ---------------------------------------------------------------------------
# Panel reading: per-category weekly rows -> per-group, per-variant series.
# ---------------------------------------------------------------------------


def _iter_category_date_group_rows(path: Path):
    """Yield ``(groupId, productId, subTypeName, price)`` for one panel
    date file, unfiltered by group -- mirrors indices._iter_category_date_rows
    but is kept local so this module has no private cross-module coupling."""

    with gzip.open(path, "rt", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            price = row.get("price")
            if not isinstance(price, (int, float)) or isinstance(price, bool):
                continue
            if price != price or price <= 0:  # NaN-safe, skip nulls/non-positive
                continue
            yield (
                int(row["groupId"]),
                int(row["productId"]),
                str(row["subTypeName"]),
                float(price),
            )


def load_category_history(
    panel_dir: Path, category_id: int
) -> dict[int, dict[tuple[int, str], list[tuple[str, float]]]]:
    """{groupId: {(productId, subTypeName): [(dateIso, price), ...]}} for
    every weekly panel date on disk for ``category_id``, in date order,
    capped to the trailing ``MAX_POINTS_PER_VARIANT`` points per variant.
    A date with no valid price for a variant simply contributes no point
    for that variant that week (skip nulls, never a fabricated point)."""

    dates = discover_panel_dates(panel_dir, category_id)
    dates = dates[-MAX_POINTS_PER_VARIANT:] if len(dates) > MAX_POINTS_PER_VARIANT else dates
    by_group: dict[int, dict[tuple[int, str], list[tuple[str, float]]]] = {}
    for archive_date in dates:
        date_path = Path(panel_dir) / f"category-{int(category_id)}" / f"{archive_date.isoformat()}.jsonl.gz"
        if not date_path.is_file():
            continue
        date_str = archive_date.isoformat()
        for group_id, product_id, subtype, price in _iter_category_date_group_rows(date_path):
            variant_key = (product_id, subtype)
            series = by_group.setdefault(group_id, {}).setdefault(variant_key, [])
            series.append((date_str, price))
    return by_group


# ---------------------------------------------------------------------------
# Deterministic size-bounded slicing (mirrors forecast_publisher.py).
# ---------------------------------------------------------------------------


def _canonical_json_bytes(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def gzip_bytes(data: bytes) -> bytes:
    return gzip.compress(data, compresslevel=9, mtime=0)


def _variant_sort_key(variant: Mapping[str, object]) -> tuple[int, str]:
    return (int(variant["productId"]), str(variant["subTypeName"]))


def _group_object_payload(
    category_id: int, group_id: int, variants: Sequence[Mapping[str, object]], *, part: int, parts_total: int
) -> dict[str, object]:
    return {
        "modelVersion": HISTORY_MODEL_VERSION,
        "categoryId": category_id,
        "groupId": group_id,
        "part": part,
        "partsTotal": parts_total,
        "variants": [
            {
                "productId": v["productId"],
                "subTypeName": v["subTypeName"],
                "points": v["points"],
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
    n = len(remaining)
    if n == 0:
        return 0
    if not _fits(category_id, group_id, remaining[:1], max_object_bytes):
        return 1
    if _fits(category_id, group_id, remaining[:n], max_object_bytes):
        return n
    lo, hi = 1, n
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
    """Deterministically pack ``variants`` into the fewest <=max_object_bytes
    gzip objects, splitting into part files when needed. Same
    exponential/binary-search-then-fixed-point-peel algorithm as
    forecast_publisher.split_group_variants_deterministic -- see that
    function's docstring for the full rationale. Never drops a variant."""

    ordered = sorted(variants, key=_variant_sort_key)
    if not ordered:
        return []

    chunks: list[list[Mapping[str, object]]] = []
    remaining = ordered
    while remaining:
        k = max(_max_fitting_prefix(category_id, group_id, remaining, max_object_bytes), 1)
        chunks.append(list(remaining[:k]))
        remaining = remaining[k:]

    for _ in range(len(ordered) + 4):
        parts_total = len(chunks)
        rebuilt: list[list[Mapping[str, object]]] = []
        changed = False
        for chunk in chunks:
            payload = _group_object_payload(category_id, group_id, chunk, part=1, parts_total=parts_total)
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
        return f"history/{category_id}/{group_id}.json.gz"
    return f"history/{category_id}/{group_id}.part{part}.json.gz"


def _sha256_hex(data: bytes) -> str:
    return sha256(data).hexdigest()


# ---------------------------------------------------------------------------
# Category / full-run orchestration.
# ---------------------------------------------------------------------------


def publish_category_history(
    category_id: int,
    panel_dir: Path,
    staging_root: Path,
    *,
    max_object_bytes: int = DEFAULT_MAX_OBJECT_BYTES,
) -> dict:
    """Read one category's weekly panel, group observed price series by
    group+variant, and slice every group (ALL variants -- history is
    observed data, no eligibility gate) into <=max_object_bytes gzip
    objects under staging_root. Returns this category's manifest
    contribution."""

    by_group = load_category_history(panel_dir, category_id)
    groups_manifest: dict[str, object] = {}
    objects_written = 0
    total_variants = 0

    for group_id in sorted(by_group):
        series_by_variant = by_group[group_id]
        variants = [
            {"productId": product_id, "subTypeName": subtype, "points": points}
            for (product_id, subtype), points in series_by_variant.items()
            if points
        ]
        total_variants += len(variants)
        if not variants:
            groups_manifest[str(group_id)] = {
                "status": "excluded",
                "reason": "no observed price points for this category/group's variants",
                "variantCount": 0,
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
            "variantCount": len(variants),
            "parts": part_entries,
        }

    return {
        "categoryId": category_id,
        "totalGroups": len(by_group),
        "publishedGroups": sum(1 for g in groups_manifest.values() if g["status"] == "published"),
        "excludedGroups": sum(1 for g in groups_manifest.values() if g["status"] == "excluded"),
        "totalVariants": total_variants,
        "objectsWritten": objects_written,
        "groups": groups_manifest,
    }


def publish_history(
    panel_dir: Path,
    source_terms_path: Path,
    staging_root: Path,
    *,
    category_ids: Sequence[int] | None = None,
    max_object_bytes: int = DEFAULT_MAX_OBJECT_BYTES,
    at: datetime | None = None,
) -> dict:
    """Full history publish run: assert community-free-access RAW-display
    publication rights (a separate, narrower gate than the derived-forecast
    one), then slice every requested category's weekly panel into
    staging_root. Returns (and writes to staging_root/history/manifest.json)
    the combined manifest."""

    # Deferred import to avoid a hard module-load dependency for callers
    # that only need the panel-reading/slicing pieces (e.g. unit tests).
    from .forecast_publisher import load_source_terms

    instant = at or datetime.now(timezone.utc)
    terms = load_source_terms(Path(source_terms_path))
    assert_tcgcsv_community_free_access_history_terms(terms, instant)

    panel_dir = Path(panel_dir)
    if category_ids is None:
        discovered = []
        for child in sorted(panel_dir.glob("category-*")):
            if child.is_dir():
                discovered.append(int(child.name.removeprefix("category-")))
        category_ids = sorted(discovered)

    staging_root = Path(staging_root)
    category_rows = [
        publish_category_history(category_id, panel_dir, staging_root, max_object_bytes=max_object_bytes)
        for category_id in category_ids
    ]

    manifest = {
        "modelVersion": HISTORY_MODEL_VERSION,
        "generatedAt": instant.isoformat(),
        "asOf": instant.date().isoformat(),
        "maxObjectBytes": max_object_bytes,
        "maxPointsPerVariant": MAX_POINTS_PER_VARIANT,
        "sourceTerms": {
            "sourceCode": terms.source_code,
            "decision": terms.decision,
            "documentHash": terms.document_hash,
            "attributionRequired": terms.attribution_required,
            "attributionText": terms.attribution_text,
        },
        "categories": {str(row["categoryId"]): row for row in category_rows},
    }
    manifest["manifestContentHash"] = content_sha256(manifest)

    manifest_path = staging_root / "history" / "manifest.json"
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    return manifest
