"""Deterministic curation packets for the migration-0009 pull-rate registry.

The checked-in manifest contains manual transcriptions of published rarity
tables, not copied article bodies. This module resolves human-reviewable set
codes to the same canonical UUIDs as the catalog seed, validates published
percentages and intervals, preserves immutable article-body hashes as
evidence, and produces a private research packet. It performs no network or
database access.
"""

from __future__ import annotations

from datetime import date, datetime, timezone
from hashlib import sha256
import json
import re
from typing import Mapping, Sequence
from uuid import UUID, uuid5

from .catalog_mapping import CATALOG_NAMESPACE, CanonicalSet
from .pull_rates import PullRateSource, SetPullRateEntry, build_pull_rate_packet

CURATION_MODE = "research_only_pull_rate_curation"
PACKET_MODE = "research_only_pull_rate_registry"
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
SAMPLE_SIZE_KINDS = ("exact", "reported_lower_bound")
MAX_SOURCES = 50
MAX_ENTRIES = 500


def pull_rate_packet_hash(
    rows: Mapping[str, object],
    evidence: Mapping[str, object],
    coverage: Mapping[str, object],
) -> str:
    """Hash every durable row plus the evidence and missing-data ledger."""

    integrity = {"rows": rows, "evidence": evidence, "coverage": coverage}
    return sha256(
        json.dumps(integrity, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        .encode("utf-8")
    ).hexdigest()


def _mapping(value: object, name: str) -> Mapping[str, object]:
    if not isinstance(value, Mapping):
        raise ValueError(f"{name} must be an object")
    return value


def _sequence(value: object, name: str) -> Sequence[object]:
    if not isinstance(value, list):
        raise ValueError(f"{name} must be an array")
    return value


def _text(payload: Mapping[str, object], key: str) -> str:
    value = payload.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{key} is required")
    return value.strip()


def _date(value: object, name: str) -> date:
    try:
        return date.fromisoformat(str(value))
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} must be an ISO date") from exc


def _datetime(value: object, name: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} must be an ISO timestamp") from exc
    if parsed.tzinfo is None:
        raise ValueError(f"{name} must include a timezone")
    return parsed


def _number(value: object, name: str) -> float:
    if isinstance(value, bool):
        raise ValueError(f"{name} must be numeric")
    try:
        return float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} must be numeric") from exc


def _sha256(value: object, name: str) -> str:
    digest = str(value or "").strip()
    if not SHA256_PATTERN.fullmatch(digest):
        raise ValueError(f"{name} must be a lowercase SHA-256 digest")
    return digest


def _canonical_set(payload: Mapping[str, object]) -> CanonicalSet:
    return CanonicalSet.build(
        game="pokemon",
        language="en",
        set_code=_text(payload, "set_code"),
        name=_text(payload, "name"),
        series=_text(payload, "series"),
        release_date=_date(payload.get("release_date"), "release_date"),
    )


def _source(
    payload: Mapping[str, object],
) -> tuple[PullRateSource, dict[str, object]]:
    article_id = _text(payload, "article_id")
    try:
        UUID(article_id)
    except ValueError as exc:
        raise ValueError("article_id must be a UUID") from exc
    url = _text(payload, "url")
    if article_id not in url:
        raise ValueError("source URL must contain its article_id")
    body_hash = _sha256(payload.get("article_body_sha256"), "article_body_sha256")
    updated_at = _datetime(payload.get("article_updated_at"), "article_updated_at")
    sample_size_kind = _text(payload, "sample_size_kind")
    if sample_size_kind not in SAMPLE_SIZE_KINDS:
        raise ValueError(f"sample_size_kind must be one of {SAMPLE_SIZE_KINDS}")
    sample_size = payload.get("sample_size")
    if isinstance(sample_size, bool) or not isinstance(sample_size, int) or sample_size <= 0:
        raise ValueError("sample_size must be a positive integer")
    qualifier = "reported strict lower bound" if sample_size_kind == "reported_lower_bound" else "exact"
    methodology = (
        f"{_text(payload, 'methodology')} Registry sample_size is the {qualifier} "
        f"published by the article. Article body SHA-256: {body_hash}; "
        f"source API updated_at: {updated_at.astimezone(timezone.utc).isoformat()}."
    )
    source = PullRateSource(
        publisher=_text(payload, "publisher"),
        title=_text(payload, "title"),
        url=url,
        published_at=_date(payload.get("published_at"), "published_at"),
        retrieved_at=_datetime(payload.get("retrieved_at"), "retrieved_at"),
        sample_size=sample_size,
        confidence_grade=_text(payload, "confidence_grade"),
        methodology=methodology,
        region=str(payload.get("region") or "us"),
        language=str(payload.get("language") or "en"),
    )
    evidence = {
        "source_id": source.id,
        "article_id": article_id,
        "article_body_sha256": body_hash,
        "article_updated_at": updated_at.astimezone(timezone.utc).isoformat(),
        "sample_size_kind": sample_size_kind,
    }
    return source, evidence


def _entry(
    payload: Mapping[str, object],
    *,
    canonical_set: CanonicalSet,
    source: PullRateSource,
    inherited_notes: str = "",
) -> tuple[SetPullRateEntry, dict[str, object]]:
    probability_percent = _number(
        payload.get("published_probability_percent"), "published_probability_percent"
    )
    if not 0 < probability_percent <= 100:
        raise ValueError("published_probability_percent must be inside (0, 100]")
    margin = _number(
        payload.get("published_ci_margin_percentage_points"),
        "published_ci_margin_percentage_points",
    )
    if margin < 0:
        raise ValueError("published_ci_margin_percentage_points cannot be negative")
    probability = round(probability_percent / 100, 10)
    ci_lower_raw = probability_percent - margin
    ci_upper_raw = probability_percent + margin
    omission_reason = str(payload.get("ci_omission_reason") or "").strip()
    if ci_lower_raw <= 0:
        if not omission_reason:
            raise ValueError("a nonpositive published CI lower bound requires ci_omission_reason")
        ci_lower = None
        ci_upper = None
    else:
        if omission_reason:
            raise ValueError("ci_omission_reason is only valid for a nonpositive lower bound")
        ci_lower = round(ci_lower_raw / 100, 10)
        ci_upper = round(min(ci_upper_raw, 100) / 100, 10)
    eligible_count = payload.get("eligible_count")
    equal_distribution_assumed = payload.get("equal_distribution_assumed", False)
    if not isinstance(equal_distribution_assumed, bool):
        raise ValueError("equal_distribution_assumed must be a boolean")
    entry_notes = str(payload.get("collation_notes") or "").strip()
    notes = " ".join(value for value in (inherited_notes, entry_notes) if value)
    if not notes:
        raise ValueError("collation_notes are required at manifest, study, or entry level")
    if omission_reason:
        notes = f"{notes} CI columns omitted: {omission_reason}"
    entry = SetPullRateEntry(
        set_id=canonical_set.id,
        rarity_slot=_text(payload, "rarity_slot"),
        probability=probability,
        ci_lower=ci_lower,
        ci_upper=ci_upper,
        one_in_packs=_number(payload.get("one_in_packs"), "one_in_packs"),
        eligible_count=eligible_count,
        equal_distribution_assumed=equal_distribution_assumed,
        collation_notes=notes,
        effective_from=canonical_set.release_date,
        version=payload.get("version", 1),
    )
    evidence = {
        "entry_id": entry.database_row(source)["id"],
        "set_code": canonical_set.set_code,
        "published_probability_percent": probability_percent,
        "published_ci_margin_percentage_points": margin,
        "published_one_in_packs": entry.one_in_packs,
        "ci_omission_reason": omission_reason or None,
    }
    return entry, evidence


def _unavailable(
    values: Sequence[object],
    target_sets: Mapping[str, CanonicalSet],
    article_source_ids: Mapping[str, str],
) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    seen: set[tuple[str, str, str]] = set()
    for raw in values:
        payload = _mapping(raw, "unavailable entry")
        set_code = _text(payload, "set_code")
        if set_code not in target_sets:
            raise ValueError(f"unavailable entry names unknown target set {set_code!r}")
        scope = _text(payload, "scope")
        if scope not in ("set", "rarity_slot"):
            raise ValueError("unavailable scope must be set or rarity_slot")
        rarity_slot = str(payload.get("rarity_slot") or "").strip()
        if scope == "rarity_slot" and not rarity_slot:
            raise ValueError("rarity_slot scope requires rarity_slot")
        if scope == "set" and rarity_slot:
            raise ValueError("set scope cannot name a rarity_slot")
        article_id = str(payload.get("article_id") or "").strip()
        if article_id and article_id not in article_source_ids:
            raise ValueError("unavailable article_id must name a packet source")
        source_id = article_source_ids.get(article_id) if article_id else None
        key = (set_code, scope, rarity_slot)
        if key in seen:
            raise ValueError(f"duplicate unavailable identity {key}")
        seen.add(key)
        checked_at = _datetime(payload.get("checked_at"), "checked_at").astimezone(timezone.utc)
        identity = (
            f"pull-rate-unavailable|{target_sets[set_code].id}|{scope}|"
            f"{rarity_slot}|{checked_at.isoformat()}"
        )
        rows.append({
            "id": str(uuid5(CATALOG_NAMESPACE, identity)),
            "set_code": set_code,
            "set_id": target_sets[set_code].id,
            "source_id": source_id,
            "scope": scope,
            "rarity_slot": rarity_slot or None,
            "reason": _text(payload, "reason"),
            "checked_at": checked_at.isoformat(),
        })
    return rows


def build_curated_pull_rate_packet(manifest: Mapping[str, object]) -> dict[str, object]:
    """Validate one checked-in curation manifest and emit database-ready rows."""

    if not isinstance(manifest, Mapping) or manifest.get("mode") != CURATION_MODE:
        raise ValueError(f"manifest mode must be {CURATION_MODE}")
    generated_at = _datetime(manifest.get("generated_at"), "generated_at")
    source_review_raw = _mapping(manifest.get("source_review"), "source_review")
    if source_review_raw.get("decision") != "research_only":
        raise ValueError("source_review decision must remain research_only")
    source_review = {
        "decision": "research_only",
        "document_path": _text(source_review_raw, "document_path"),
        "document_sha256": _sha256(
            source_review_raw.get("document_sha256"), "source_review.document_sha256"
        ),
    }
    source_defaults_raw = manifest.get("source_defaults") or {}
    source_defaults = dict(_mapping(source_defaults_raw, "source_defaults"))
    default_notes = str(manifest.get("default_collation_notes") or "").strip()
    target_values = _sequence(manifest.get("target_sets"), "target_sets")
    target_sets: dict[str, CanonicalSet] = {}
    for raw in target_values:
        canonical_set = _canonical_set(_mapping(raw, "target set"))
        if canonical_set.set_code in target_sets:
            raise ValueError(f"duplicate target set {canonical_set.set_code!r}")
        target_sets[canonical_set.set_code] = canonical_set
    if not target_sets:
        raise ValueError("at least one target set is required")

    study_values = _sequence(manifest.get("studies"), "studies")
    if not study_values or len(study_values) > MAX_SOURCES:
        raise ValueError(f"studies must contain between 1 and {MAX_SOURCES} sources")
    source_rows: list[dict[str, object]] = []
    rate_rows: list[dict[str, object]] = []
    source_evidence: list[dict[str, object]] = []
    entry_evidence: list[dict[str, object]] = []
    covered_sets: set[str] = set()
    source_ids: set[str] = set()
    article_source_ids: dict[str, str] = {}
    rate_ids: set[str] = set()
    for raw_study in study_values:
        study = _mapping(raw_study, "study")
        source_payload = dict(source_defaults)
        source_payload.update(_mapping(study.get("source"), "source"))
        source, evidence = _source(source_payload)
        if source.id in source_ids:
            raise ValueError(f"duplicate source identity {source.id}")
        source_ids.add(source.id)
        article_source_ids[str(evidence["article_id"])] = source.id
        entries: list[SetPullRateEntry] = []
        inherited_notes = " ".join(
            value
            for value in (default_notes, str(study.get("collation_notes") or "").strip())
            if value
        )
        for raw_entry in _sequence(study.get("entries"), "entries"):
            payload = _mapping(raw_entry, "entry")
            set_code = _text(payload, "set_code")
            if set_code not in target_sets:
                raise ValueError(f"entry names unknown target set {set_code!r}")
            entry, published = _entry(
                payload,
                canonical_set=target_sets[set_code],
                source=source,
                inherited_notes=inherited_notes,
            )
            row = entry.database_row(source)
            if row["id"] in rate_ids:
                raise ValueError(f"duplicate pull-rate row identity {row['id']}")
            rate_ids.add(str(row["id"]))
            entries.append(entry)
            entry_evidence.append(published)
            covered_sets.add(set_code)
        packet = build_pull_rate_packet(source, entries, generated_at=generated_at)
        source_rows.extend(packet["rows"]["pull_rate_sources"])
        rate_rows.extend(packet["rows"]["set_pull_rates"])
        source_evidence.append(evidence)
    if len(rate_rows) > MAX_ENTRIES:
        raise ValueError(f"a curation manifest may contain at most {MAX_ENTRIES} entries")

    unavailable = _unavailable(
        _sequence(manifest.get("unavailable"), "unavailable"),
        target_sets,
        article_source_ids,
    )
    unavailable_sets = {row["set_code"] for row in unavailable if row["scope"] == "set"}
    overlap = covered_sets & unavailable_sets
    if overlap:
        raise ValueError(f"sets cannot be both covered and unavailable: {sorted(overlap)}")
    unaccounted = set(target_sets) - covered_sets - unavailable_sets
    if unaccounted:
        raise ValueError(f"target sets lack rates or an unavailable record: {sorted(unaccounted)}")

    catalog_sets = [
        {
            "set_code": entry.set_code,
            "set_id": entry.id,
            "canonical_key": entry.canonical_key,
            "name": entry.name,
            "release_date": entry.release_date.isoformat(),
        }
        for entry in target_sets.values()
    ]
    unavailable_rows = [
        {key: value for key, value in row.items() if key != "set_code"}
        for row in unavailable
    ]
    rows = {
        "pull_rate_sources": source_rows,
        "set_pull_rates": rate_rows,
        "pull_rate_unavailability": unavailable_rows,
    }
    evidence = {
        "source_review": source_review,
        "sources": source_evidence,
        "entries": entry_evidence,
        "catalog_sets": catalog_sets,
    }
    coverage = {
        "target_set_codes": list(target_sets),
        "covered_set_codes": sorted(covered_sets),
        "unavailable": unavailable,
    }
    return {
        "mode": PACKET_MODE,
        "generated_at": generated_at.astimezone(timezone.utc).isoformat(),
        "counts": {
            "sources": len(source_rows),
            "entries": len(rate_rows),
            "target_sets": len(target_sets),
            "covered_sets": len(covered_sets),
            "unavailable_sets": len(unavailable_sets),
            "unavailable_records": len(unavailable),
        },
        "rows": rows,
        "evidence": evidence,
        "coverage": coverage,
        "review_required": True,
        "public_display_candidates": [],
        "packet_hash": pull_rate_packet_hash(rows, evidence, coverage),
    }
