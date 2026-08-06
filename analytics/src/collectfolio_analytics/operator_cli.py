"""Operator CLI for deterministic, non-publishing research qualification."""

from __future__ import annotations

import argparse
from datetime import date, datetime, timezone
import json
import os
from pathlib import Path
import sys
from typing import Mapping, Sequence

from .catalog_mapping import ApprovedMapping, CanonicalCard, CanonicalSet, CanonicalVariant
from .market_pipeline import ObservationBatch, ObservationMapping, SourceTerms
from .monitoring import assess_operator_packet
from .qualification import (
    PrivateQualificationConfig,
    build_private_research_evidence,
    prepare_archive_observations,
)
from .tcgcsv import (
    ARCHIVE_AVAILABILITY_LAG_DAYS,
    ARCHIVE_INTERVAL_DAYS,
    TCGCSVArchiveHistory,
    TCGCSVResearchClient,
    assert_tcgcsv_research_terms,
    build_tcgcsv_research_packet,
)


def _mapping(value: object, name: str) -> Mapping[str, object]:
    if not isinstance(value, Mapping):
        raise ValueError(f"{name} must be an object")
    return value


def _sequence(value: object, name: str) -> Sequence[object]:
    if not isinstance(value, list):
        raise ValueError(f"{name} must be an array")
    return value


def _text(value: object, name: str, *, optional: bool = False) -> str:
    text = str(value or "").strip()
    if not text and not optional:
        raise ValueError(f"{name} must be non-empty")
    return text


def _datetime(value: object, name: str) -> datetime:
    text = _text(value, name)
    normalized = text[:-1] + "+00:00" if text.endswith("Z") else text
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError as exc:
        raise ValueError(f"{name} must be an ISO timestamp") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError(f"{name} must include a timezone")
    return parsed


def _optional_datetime(value: object, name: str) -> datetime | None:
    return None if value in (None, "") else _datetime(value, name)


def _optional_date(value: object, name: str) -> date | None:
    if value in (None, ""):
        return None
    try:
        return date.fromisoformat(_text(value, name))
    except ValueError as exc:
        raise ValueError(f"{name} must be an ISO date") from exc


def _date(value: object, name: str) -> date:
    parsed = _optional_date(value, name)
    if parsed is None:
        raise ValueError(f"{name} must be an ISO date")
    return parsed


def _bool(value: object, name: str) -> bool:
    if not isinstance(value, bool):
        raise ValueError(f"{name} must be boolean")
    return value


def _source_terms(value: object) -> SourceTerms:
    source = _mapping(value, "source")
    return SourceTerms(
        source_id=_text(source.get("id"), "source.id"),
        terms_review_id=_text(source.get("termsReviewId"), "source.termsReviewId"),
        current_terms_review_id=_text(
            source.get("currentTermsReviewId"), "source.currentTermsReviewId"
        ),
        source_code=_text(source.get("code"), "source.code"),
        source_name=_text(source.get("name"), "source.name"),
        decision=_text(source.get("decision"), "source.decision"),
        active=_bool(source.get("active"), "source.active"),
        commercial_use_allowed=_bool(
            source.get("commercialUseAllowed"), "source.commercialUseAllowed"
        ),
        catalog_metadata_allowed=_bool(
            source.get("catalogMetadataAllowed"), "source.catalogMetadataAllowed"
        ),
        public_raw_display_allowed=_bool(
            source.get("publicRawDisplayAllowed"), "source.publicRawDisplayAllowed"
        ),
        public_derived_display_allowed=_bool(
            source.get("publicDerivedDisplayAllowed"), "source.publicDerivedDisplayAllowed"
        ),
        attribution_required=_bool(
            source.get("attributionRequired"), "source.attributionRequired"
        ),
        attribution_text=_text(
            source.get("attributionText"), "source.attributionText", optional=True
        ),
        document_hash=_text(source.get("documentHash"), "source.documentHash"),
        reviewed_at=_datetime(source.get("reviewedAt"), "source.reviewedAt"),
        expires_at=_optional_datetime(source.get("expiresAt"), "source.expiresAt"),
    )


def _canonical_variants(value: object) -> tuple[CanonicalVariant, ...]:
    rows = _sequence(value, "canonicalVariants")
    variants: list[CanonicalVariant] = []
    for index, raw in enumerate(rows):
        item = _mapping(raw, f"canonicalVariants[{index}]")
        canonical_set = CanonicalSet.build(
            game=_text(item.get("game"), f"canonicalVariants[{index}].game"),
            language=_text(item.get("language"), f"canonicalVariants[{index}].language"),
            set_code=_text(item.get("setCode"), f"canonicalVariants[{index}].setCode"),
            name=_text(item.get("setName"), f"canonicalVariants[{index}].setName"),
            series=_text(item.get("series"), f"canonicalVariants[{index}].series", optional=True),
            release_date=_optional_date(
                item.get("releaseDate"), f"canonicalVariants[{index}].releaseDate"
            ),
        )
        card = CanonicalCard.build(
            canonical_set,
            name=_text(item.get("name"), f"canonicalVariants[{index}].name"),
            number=_text(item.get("number"), f"canonicalVariants[{index}].number"),
            rarity=_text(item.get("rarity"), f"canonicalVariants[{index}].rarity", optional=True),
            artist=_text(item.get("artist"), f"canonicalVariants[{index}].artist", optional=True),
        )
        variants.append(CanonicalVariant.build(
            card,
            language=_text(item.get("language"), f"canonicalVariants[{index}].language"),
            edition=_text(item.get("edition", "standard"), f"canonicalVariants[{index}].edition"),
            finish=_text(item.get("finish"), f"canonicalVariants[{index}].finish"),
            variant_name=_text(
                item.get("variantName"), f"canonicalVariants[{index}].variantName", optional=True
            ),
            condition_class=_text(
                item.get("conditionClass", "raw"),
                f"canonicalVariants[{index}].conditionClass",
            ),
        ))
    if not variants:
        raise ValueError("canonicalVariants must not be empty")
    return tuple(variants)


def _approved_mappings(
    value: object,
    *,
    source_id: str,
    mapping_version: str,
) -> tuple[tuple[ApprovedMapping, ...], tuple[ObservationMapping, ...]]:
    if value is None:
        return (), ()
    rows = _sequence(value, "approvedMappings")
    approved: list[ApprovedMapping] = []
    observations: list[ObservationMapping] = []
    for index, raw in enumerate(rows):
        item = _mapping(raw, f"approvedMappings[{index}]")
        product_id = _text(item.get("externalProductId"), f"approvedMappings[{index}].externalProductId")
        variant_key = _text(
            item.get("externalVariantKey"),
            f"approvedMappings[{index}].externalVariantKey",
        )
        variant_id = _text(item.get("variantId"), f"approvedMappings[{index}].variantId")
        approved.append(ApprovedMapping(
            source_id=source_id,
            external_product_id=product_id,
            external_variant_key=variant_key,
            variant_id=variant_id,
            mapping_version=mapping_version,
        ))
        observations.append(ObservationMapping(
            mapping_id=_text(item.get("mappingId"), f"approvedMappings[{index}].mappingId"),
            source_id=source_id,
            variant_id=variant_id,
            external_product_id=product_id,
            external_variant_key=variant_key,
            mapping_confidence=float(item.get("mappingConfidence", 1)),
            review_status="approved",
            mapping_version=mapping_version,
            finish=_text(item.get("finish"), f"approvedMappings[{index}].finish"),
            condition_class=_text(
                item.get("conditionClass", "raw"),
                f"approvedMappings[{index}].conditionClass",
            ),
        ))
    return tuple(approved), tuple(observations)


def _mapping_review(value: object, *, required: bool) -> Mapping[str, object] | None:
    if value is None and not required:
        return None
    review = _mapping(value, "mappingReview")
    if review.get("decision") != "approved" or review.get("scope") != "research_only":
        raise PermissionError("approved mappings require a research-only mapping review")
    document_hash = _text(review.get("documentHash"), "mappingReview.documentHash").lower()
    if len(document_hash) != 64 or any(character not in "0123456789abcdef" for character in document_hash):
        raise ValueError("mappingReview.documentHash must be a SHA-256 digest")
    return {
        "decision": "approved",
        "scope": "research_only",
        "reviewerLabel": _text(review.get("reviewerLabel"), "mappingReview.reviewerLabel"),
        "reviewedAt": _datetime(review.get("reviewedAt"), "mappingReview.reviewedAt").isoformat(),
        "document": _text(review.get("document"), "mappingReview.document"),
        "documentHash": document_hash,
    }


def _private_qualification_config(
    value: object,
    *,
    ingested_at: datetime,
    mapping_version: str,
) -> tuple[Mapping[str, object], PrivateQualificationConfig]:
    research = _mapping(value, "historicalResearch")
    expected_interval = int(research.get("expectedIntervalDays", ARCHIVE_INTERVAL_DAYS))
    availability_lag = int(
        research.get("availabilityLagDays", ARCHIVE_AVAILABILITY_LAG_DAYS)
    )
    max_reference_lag = int(
        research.get("maxReferenceLagDays", ARCHIVE_INTERVAL_DAYS)
    )
    if expected_interval != ARCHIVE_INTERVAL_DAYS:
        raise ValueError(
            f"historicalResearch.expectedIntervalDays must be {ARCHIVE_INTERVAL_DAYS}"
        )
    if availability_lag != ARCHIVE_AVAILABILITY_LAG_DAYS:
        raise ValueError(
            "historicalResearch.availabilityLagDays must match the conservative archive contract"
        )
    if max_reference_lag != expected_interval:
        raise ValueError(
            "historicalResearch.maxReferenceLagDays must match expectedIntervalDays"
        )
    model = _mapping(research.get("model"), "historicalResearch.model")
    feature_cutoff = _optional_datetime(
        research.get("featureCutoff"), "historicalResearch.featureCutoff"
    ) or ingested_at
    forecast_origin = _optional_datetime(
        research.get("forecastOrigin"), "historicalResearch.forecastOrigin"
    ) or feature_cutoff
    config = PrivateQualificationConfig(
        history_ingestion_run_id=_text(
            research.get("ingestionRunId"), "historicalResearch.ingestionRunId"
        ),
        trend_analytics_run_id=_text(
            research.get("trendAnalyticsRunId"),
            "historicalResearch.trendAnalyticsRunId",
        ),
        forecast_analytics_run_id=_text(
            research.get("forecastAnalyticsRunId"),
            "historicalResearch.forecastAnalyticsRunId",
        ),
        trend_snapshot_id=_text(
            research.get("trendSnapshotId"), "historicalResearch.trendSnapshotId"
        ),
        model_version_id=_text(
            model.get("id"), "historicalResearch.model.id"
        ),
        model_key=_text(model.get("key"), "historicalResearch.model.key"),
        model_version=_text(
            model.get("version"), "historicalResearch.model.version"
        ),
        model_family=_text(
            model.get("family"), "historicalResearch.model.family"
        ),
        allowed_horizons=tuple(
            int(item)
            for item in _sequence(
                model.get("allowedHorizons"),
                "historicalResearch.model.allowedHorizons",
            )
        ),
        mapping_version=mapping_version,
        feature_version=_text(
            research.get("featureVersion"), "historicalResearch.featureVersion"
        ),
        code_version=_text(
            research.get("codeVersion"), "historicalResearch.codeVersion"
        ),
        ingested_at=ingested_at,
        feature_cutoff=feature_cutoff,
        forecast_origin=forecast_origin,
        model_config=_mapping(
            model.get("config", {}), "historicalResearch.model.config"
        ),
    )
    return research, config


def _prepare_historical_research(
    value: object,
    *,
    client: TCGCSVResearchClient,
    category_id: int,
    group_id: int,
    product_ids: Sequence[int],
    observation_mappings: Sequence[ObservationMapping],
    terms: SourceTerms,
    ingested_at: datetime,
    mapping_version: str,
    actor_label: str,
) -> tuple[TCGCSVArchiveHistory, ObservationBatch, PrivateQualificationConfig]:
    research, config = _private_qualification_config(
        value,
        ingested_at=ingested_at,
        mapping_version=mapping_version,
    )
    if not observation_mappings:
        raise PermissionError(
            "historical research requires an explicitly approved exact mapping"
        )
    history = client.weekly_price_history(
        start_date=_date(
            research.get("startDate"), "historicalResearch.startDate"
        ),
        end_date=_date(research.get("endDate"), "historicalResearch.endDate"),
        category_id=category_id,
        group_id=group_id,
    )
    observations = prepare_archive_observations(
        history,
        observation_mappings,
        terms,
        product_ids=product_ids,
        ingestion_run_id=config.history_ingestion_run_id,
        ingested_at=ingested_at,
        actor_label=actor_label,
    )
    return history, observations, config


def build_operator_packet(
    manifest: Mapping[str, object],
    *,
    client: TCGCSVResearchClient | None = None,
    include_history: bool = True,
    execution_at: datetime | None = None,
) -> Mapping[str, object]:
    if manifest.get("mode") != "research_only":
        raise PermissionError("operator manifest mode must be research_only")
    terms = _source_terms(manifest.get("source"))
    source = _mapping(manifest.get("source"), "source")
    tcgcsv = _mapping(manifest.get("tcgcsv"), "tcgcsv")
    variants = _canonical_variants(manifest.get("canonicalVariants"))
    set_keys = {variant.card.set.canonical_key for variant in variants}
    if len(set_keys) != 1:
        raise ValueError("one operator packet cannot mix canonical sets")
    mapping_version = _text(manifest.get("mappingVersion"), "mappingVersion")
    approved, observation_mappings = _approved_mappings(
        manifest.get("approvedMappings"),
        source_id=terms.source_id,
        mapping_version=mapping_version,
    )
    mapping_review = _mapping_review(manifest.get("mappingReview"), required=bool(approved))
    product_ids = [int(value) for value in _sequence(tcgcsv.get("productIds"), "tcgcsv.productIds")]
    category_id = int(tcgcsv.get("categoryId"))
    group_id = int(tcgcsv.get("groupId"))
    actor_label = _text(
        manifest.get("actorLabel", "tcgcsv-research-adapter-v1"), "actorLabel"
    )
    manifest_ingested_at = _optional_datetime(
        manifest.get("ingestedAt"), "ingestedAt"
    )
    if execution_at is not None:
        if execution_at.tzinfo is None or execution_at.utcoffset() is None:
            raise ValueError("execution_at must include a timezone")
        permission_checked_at = execution_at.astimezone(timezone.utc)
    else:
        permission_checked_at = datetime.now(timezone.utc).replace(microsecond=0)
    # A historical manifest timestamp is evidence metadata, never the clock used
    # to authorize a live network request. Current-only monitoring records the
    # actual execution time so freshness and expiry checks cannot be replayed.
    ingested_at = (
        manifest_ingested_at
        if include_history and manifest_ingested_at is not None
        else permission_checked_at
    )
    assert_tcgcsv_research_terms(terms, permission_checked_at)
    research_client = client or TCGCSVResearchClient(
        base_url=_text(tcgcsv.get("baseUrl", "https://tcgcsv.com/"), "tcgcsv.baseUrl"),
        user_agent=_text(tcgcsv.get("userAgent"), "tcgcsv.userAgent"),
    )
    if mapping_review and _datetime(mapping_review["reviewedAt"], "mappingReview.reviewedAt") > ingested_at:
        raise ValueError("mapping review cannot occur after ingestion")

    history: TCGCSVArchiveHistory | None = None
    historical_observations: ObservationBatch | None = None
    qualification_config: PrivateQualificationConfig | None = None
    historical_value = manifest.get("historicalResearch") if include_history else None
    if historical_value is not None:
        history, historical_observations, qualification_config = _prepare_historical_research(
            historical_value,
            client=research_client,
            category_id=category_id,
            group_id=group_id,
            product_ids=product_ids,
            observation_mappings=observation_mappings,
            terms=terms,
            ingested_at=ingested_at,
            mapping_version=mapping_version,
            actor_label=actor_label,
        )
    history_by_variant: dict[str, list[object]] = {}
    if historical_observations is not None:
        for observation in historical_observations.trend_observations:
            history_by_variant.setdefault(
                observation.key.canonical_variant_id, []
            ).append(observation)

    snapshot = research_client.snapshot(category_id, group_id)
    packet = build_tcgcsv_research_packet(
        snapshot,
        variants,
        terms,
        canonical_set_key=next(iter(set_keys)),
        ingestion_run_id=_text(manifest.get("ingestionRunId"), "ingestionRunId"),
        ingested_at=ingested_at,
        permission_checked_at=permission_checked_at,
        mapping_version=mapping_version,
        product_ids=product_ids,
        approved_mappings=approved,
        observation_mappings=observation_mappings,
        history_by_variant=history_by_variant,
        actor_label=actor_label,
    )
    candidate_rows = list(packet.catalog.mapping_candidates)
    result = {
        "schemaVersion": 1,
        "mode": "research_only",
        "source": {
            "id": terms.source_id,
            "code": terms.source_code,
            "termsReviewId": terms.terms_review_id,
            "policyHash": terms.policy_hash,
            "termsUrl": source.get("termsUrl"),
            "reviewedAt": terms.reviewed_at.isoformat(),
            "expiresAt": terms.expires_at.isoformat() if terms.expires_at else None,
        },
        "sourcePermissionCheckedAt": permission_checked_at.isoformat(),
        "ingestion": {
            "runId": _text(manifest.get("ingestionRunId"), "ingestionRunId"),
            "ingestedAt": ingested_at.isoformat(),
            "snapshotHash": packet.snapshot_hash,
            "sourceUpdatedAt": packet.source_updated_at.isoformat(),
            "rawRecordCount": packet.raw_record_count,
            "datasetHash": packet.observations.dataset_hash,
        },
        "catalog": {
            "datasetHash": packet.catalog.dataset_hash,
            "sets": list(packet.catalog.catalog_sets),
            "cards": list(packet.catalog.catalog_cards),
            "variants": list(packet.catalog.catalog_variants),
            "mappingCandidates": candidate_rows,
            "recordsQuarantined": packet.catalog.records_quarantined,
        },
        "observations": {
            "statusCounts": packet.observations.status_counts,
            "databaseRows": list(packet.observations.database_rows),
            "qualityEvents": list(packet.observations.quality_events),
        },
        "gateStatus": dict(packet.gate_status),
        "mappingReview": mapping_review,
        "operatorReviewRequired": any(
            "initial_mapping_review_required" in row.get("reason_codes", [])
            or row.get("disposition") in {"review", "quarantined", "unmapped"}
            for row in candidate_rows
        ),
    }
    if (
        history is not None
        and historical_observations is not None
        and qualification_config is not None
    ):
        evidence = build_private_research_evidence(
            history,
            historical_observations,
            packet.observations,
            terms,
            qualification_config,
        )
        result["historicalResearch"] = evidence.as_dict()
        result["operatorReviewRequired"] = True
    result["health"] = assess_operator_packet(result, permission_checked_at).as_dict()
    return result


def _read_manifest(path: str) -> Mapping[str, object]:
    text = sys.stdin.read() if path == "-" else Path(path).read_text(encoding="utf-8")
    value = json.loads(text)
    return _mapping(value, "manifest")


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Build a deterministic TCGCSV research packet; never publish it.",
    )
    parser.add_argument("manifest", help="JSON manifest path, or - for stdin")
    parser.add_argument("--pretty", action="store_true", help="indent JSON output")
    parser.add_argument(
        "--output",
        help="write to a new mode-0600 file instead of stdout; existing files are refused",
    )
    parser.add_argument(
        "--skip-history",
        action="store_true",
        help="qualify only the current snapshot (for low-bandwidth scheduled monitoring)",
    )
    args = parser.parse_args(argv)
    packet = build_operator_packet(
        _read_manifest(args.manifest),
        include_history=not args.skip_history,
    )
    if args.output:
        descriptor = os.open(  # noqa: PTH123 - exclusive permissions are intentional
            args.output,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL,
            0o600,
        )
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            json.dump(packet, output, indent=2 if args.pretty else None, sort_keys=True)
            output.write("\n")
    else:
        json.dump(packet, sys.stdout, indent=2 if args.pretty else None, sort_keys=True)
        sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
