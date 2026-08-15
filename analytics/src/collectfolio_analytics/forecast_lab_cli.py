"""Bounded CLI for CollectFolio's private Forecast Lab.

The input is a point-in-time feature export, not raw provider data.  Every
historical row includes the instant at which its future label became known;
every current target omits a label.  Output is mode-0600, immutable by path,
and explicitly incapable of creating a public publication candidate.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
from hashlib import sha256
import json
from math import isfinite
import os
from pathlib import Path
import sys
from typing import Mapping, Sequence
from uuid import UUID

from .evaluation import ResearchLineage
from .forecast_dataset import (
    CANDIDATE_UNIVERSE_VERIFICATION,
    COMPILED_CELL_STATES,
    COMPILED_PROMOTION_BLOCKERS,
    FORECAST_FEATURE_VERSION as COMPILED_FEATURE_VERSION,
    FORECAST_OBSERVATION_COMPILER_VERSION,
    TARGET_WINDOW_DAYS,
    canonical_forecast_cohort_key,
)
from .forecast_engine import (
    AcquisitionQuoteKey,
    AcquisitionCosts,
    DeclaredPanelCoverage,
    ForecastEnginePolicy,
    ForecastFeatures,
    MaturedTrainingExample,
    ShadowEvaluationPolicy,
    MAX_BOOTSTRAP_SAMPLES,
    run_shadow_walk_forward,
    build_watch_candidate,
    train_shadow_forecast,
)
from .evaluation import realized_price_at_maturity
from .observations import PriceObservation, normalize_market_identity
from .forecasting import PromotionPolicy, REQUIRED_PROMOTION_BASELINES
from .observations import PriceSeriesKey


MAX_EXAMPLES = 5_000
MAX_TARGETS = 1_000
MAX_COMPILED_MEMBERS = 500
MAX_COMPILED_ORIGINS = 64
MAX_COMPILED_CELLS = 5_000
MAX_REQUIRED_BASELINES = 16


def _mapping(value: object, name: str) -> Mapping[str, object]:
    if not isinstance(value, Mapping):
        raise ValueError(f"{name} must be an object")
    return value


def _array(value: object, name: str, *, maximum: int, allow_empty: bool = False) -> list[Mapping[str, object]]:
    if not isinstance(value, list) or any(not isinstance(item, Mapping) for item in value):
        raise ValueError(f"{name} must be an array of objects")
    if (not allow_empty and not value) or len(value) > maximum:
        minimum = 0 if allow_empty else 1
        raise ValueError(f"{name} must contain between {minimum} and {maximum} rows")
    return value


def _text(value: object, name: str) -> str:
    result = str(value or "").strip()
    if not result:
        raise ValueError(f"{name} must be non-empty")
    return result


def _uuid(value: object, name: str) -> str:
    try:
        return str(UUID(str(value)))
    except (TypeError, ValueError, AttributeError) as exc:
        raise ValueError(f"{name} must be a UUID") from exc


def _digest(value: object, name: str) -> str:
    result = _text(value, name).lower()
    if len(result) != 64 or any(character not in "0123456789abcdef" for character in result):
        raise ValueError(f"{name} must be a SHA-256 digest")
    return result


def _datetime(value: object, name: str) -> datetime:
    if not isinstance(value, str):
        raise ValueError(f"{name} must be an ISO-8601 datetime")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(f"{name} must be an ISO-8601 datetime") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError(f"{name} must include a timezone")
    return parsed.astimezone(timezone.utc)


def _number(value: object, name: str) -> float:
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not isfinite(value)
    ):
        raise ValueError(f"{name} must be a finite JSON number")
    return float(value)


def _integer(value: object, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{name} must be an integer")
    return value


def _optional_number(value: object, name: str) -> float | None:
    return None if value is None else _number(value, name)


def _exact_policy_keys(
    source: Mapping[str, object], allowed: set[str], name: str,
) -> None:
    if not set(source).issubset(allowed):
        raise ValueError(f"{name} has an invalid field contract")


def _canonical_hash(value: object) -> str:
    body = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return sha256(body.encode("utf-8")).hexdigest()


def _code_artifact_hash() -> str:
    digest = sha256()
    source_root = Path(__file__).resolve().parent
    for path in sorted(source_root.glob("*.py"), key=lambda item: item.name):
        digest.update(path.name.encode("utf-8"))
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def _engine_policy(value: object) -> ForecastEnginePolicy:
    source = _mapping(value or {}, "enginePolicy")
    _exact_policy_keys(source, {
        "horizons", "minimumTrainingExamples", "minimumCalibrationExamples",
        "minimumHistoryDays", "minimumEvidenceQuality", "validationFraction",
        "momentumDamping", "marketDamping", "structuralConvergenceFraction",
        "demandReturnCap", "reprintReturnPenalty", "maximumAbsLogReturn",
        "minimumSigma", "maximumSigma", "minimumModelWeight",
        "maximumEvidenceIntervalMultiplier", "useDemandAcceleration",
        "splitEmbargoDays",
    }, "enginePolicy")
    raw_horizons = source.get("horizons", [30, 90])
    if (
        not isinstance(raw_horizons, (list, tuple))
        or not raw_horizons
        or len(raw_horizons) > 2
    ):
        raise ValueError("enginePolicy.horizons must contain one or two values")
    use_demand = source.get("useDemandAcceleration", False)
    if not isinstance(use_demand, bool):
        raise ValueError("enginePolicy.useDemandAcceleration must be a boolean")
    split_embargo = source.get("splitEmbargoDays")
    return ForecastEnginePolicy(
        horizons=tuple(
            _integer(item, f"enginePolicy.horizons[{index}]")
            for index, item in enumerate(raw_horizons)
        ),
        minimum_training_examples=_integer(
            source.get("minimumTrainingExamples", 30),
            "enginePolicy.minimumTrainingExamples",
        ),
        minimum_calibration_examples=_integer(
            source.get("minimumCalibrationExamples", 10),
            "enginePolicy.minimumCalibrationExamples",
        ),
        minimum_history_days=_integer(
            source.get("minimumHistoryDays", 90), "enginePolicy.minimumHistoryDays",
        ),
        minimum_evidence_quality=_number(
            source.get("minimumEvidenceQuality", 0.55),
            "enginePolicy.minimumEvidenceQuality",
        ),
        validation_fraction=_number(
            source.get("validationFraction", 0.25), "enginePolicy.validationFraction",
        ),
        momentum_damping=_number(
            source.get("momentumDamping", 0.25), "enginePolicy.momentumDamping",
        ),
        market_damping=_number(
            source.get("marketDamping", 0.25), "enginePolicy.marketDamping",
        ),
        structural_convergence_fraction=_number(
            source.get("structuralConvergenceFraction", 0.25),
            "enginePolicy.structuralConvergenceFraction",
        ),
        demand_return_cap=_number(
            source.get("demandReturnCap", 0.12), "enginePolicy.demandReturnCap",
        ),
        reprint_return_penalty=_number(
            source.get("reprintReturnPenalty", 0.10),
            "enginePolicy.reprintReturnPenalty",
        ),
        maximum_abs_log_return=_number(
            source.get("maximumAbsLogReturn", 0.70),
            "enginePolicy.maximumAbsLogReturn",
        ),
        minimum_sigma=_number(
            source.get("minimumSigma", 0.03), "enginePolicy.minimumSigma",
        ),
        maximum_sigma=_number(
            source.get("maximumSigma", 0.80), "enginePolicy.maximumSigma",
        ),
        minimum_model_weight=_number(
            source.get("minimumModelWeight", 0.05),
            "enginePolicy.minimumModelWeight",
        ),
        maximum_evidence_interval_multiplier=_number(
            source.get("maximumEvidenceIntervalMultiplier", 2.0),
            "enginePolicy.maximumEvidenceIntervalMultiplier",
        ),
        use_demand_acceleration=use_demand,
        split_embargo_days=(
            None
            if split_embargo is None
            else _integer(split_embargo, "enginePolicy.splitEmbargoDays")
        ),
    )


def _evaluation_policy(value: object) -> ShadowEvaluationPolicy:
    source = _mapping(value or {}, "evaluationPolicy")
    _exact_policy_keys(source, {
        "minimumCases", "minimumVariants", "minimumSets", "minimumSpacedOrigins",
        "minimumOriginSpacingDays", "bootstrapSamples", "confidenceLevel",
        "minimumLiftLowerBound", "minimumProbabilityCalibrationCases",
        "minimumAfterCostCalibrationCases", "maximumAfterCostBrierScore",
        "maximumAfterCostCalibrationError", "minimumSelectedPocketCases",
        "minimumSelectedPositiveRate", "minimumSelectedMedianNetRoi",
        "maximumSelectedFalseDiscoveryRate", "promotionPolicy",
    }, "evaluationPolicy")
    promotion = _mapping(source.get("promotionPolicy", {}), "evaluationPolicy.promotionPolicy")
    _exact_policy_keys(promotion, {
        "version", "minimumCases", "minimumBaselineLift",
        "interval80CoverageMin", "interval80CoverageMax", "maximumBrierScore",
        "requiredBaselines",
    }, "evaluationPolicy.promotionPolicy")
    version = promotion.get("version", "forecast-ensemble-promotion-v1")
    if not isinstance(version, str) or not version.strip():
        raise ValueError("evaluationPolicy.promotionPolicy.version must be non-empty text")
    raw_baselines = promotion.get("requiredBaselines", REQUIRED_PROMOTION_BASELINES)
    if (
        not isinstance(raw_baselines, (list, tuple))
        or not raw_baselines
        or len(raw_baselines) > MAX_REQUIRED_BASELINES
        or any(not isinstance(item, str) or not item.strip() for item in raw_baselines)
    ):
        raise ValueError(
            "evaluationPolicy.promotionPolicy.requiredBaselines is invalid"
        )
    baselines = tuple(item.strip() for item in raw_baselines)
    if len(set(baselines)) != len(baselines):
        raise ValueError(
            "evaluationPolicy.promotionPolicy.requiredBaselines contains duplicates"
        )
    minimum_cases = _integer(
        source.get("minimumCases", 200), "evaluationPolicy.minimumCases",
    )
    bootstrap_samples = _integer(
        source.get("bootstrapSamples", 600), "evaluationPolicy.bootstrapSamples",
    )
    if bootstrap_samples > MAX_BOOTSTRAP_SAMPLES:
        raise ValueError(
            "evaluationPolicy.bootstrapSamples cannot exceed "
            f"{MAX_BOOTSTRAP_SAMPLES}"
        )
    return ShadowEvaluationPolicy(
        minimum_cases=minimum_cases,
        minimum_variants=_integer(
            source.get("minimumVariants", 50), "evaluationPolicy.minimumVariants",
        ),
        minimum_sets=_integer(
            source.get("minimumSets", 5), "evaluationPolicy.minimumSets",
        ),
        minimum_spaced_origins=_integer(
            source.get("minimumSpacedOrigins", 6),
            "evaluationPolicy.minimumSpacedOrigins",
        ),
        minimum_origin_spacing_days=_integer(
            source.get("minimumOriginSpacingDays", 21),
            "evaluationPolicy.minimumOriginSpacingDays",
        ),
        bootstrap_samples=bootstrap_samples,
        confidence_level=_number(
            source.get("confidenceLevel", 0.95), "evaluationPolicy.confidenceLevel",
        ),
        minimum_lift_lower_bound=_number(
            source.get("minimumLiftLowerBound", 0.0),
            "evaluationPolicy.minimumLiftLowerBound",
        ),
        minimum_probability_calibration_cases=_integer(
            source.get("minimumProbabilityCalibrationCases", 50),
            "evaluationPolicy.minimumProbabilityCalibrationCases",
        ),
        minimum_after_cost_calibration_cases=_integer(
            source.get("minimumAfterCostCalibrationCases", 50),
            "evaluationPolicy.minimumAfterCostCalibrationCases",
        ),
        maximum_after_cost_brier_score=_number(
            source.get("maximumAfterCostBrierScore", 0.25),
            "evaluationPolicy.maximumAfterCostBrierScore",
        ),
        maximum_after_cost_calibration_error=_number(
            source.get("maximumAfterCostCalibrationError", 0.10),
            "evaluationPolicy.maximumAfterCostCalibrationError",
        ),
        minimum_selected_pocket_cases=_integer(
            source.get("minimumSelectedPocketCases", 30),
            "evaluationPolicy.minimumSelectedPocketCases",
        ),
        minimum_selected_positive_rate=_number(
            source.get("minimumSelectedPositiveRate", 0.60),
            "evaluationPolicy.minimumSelectedPositiveRate",
        ),
        minimum_selected_median_net_roi=_number(
            source.get("minimumSelectedMedianNetRoi", 0.0),
            "evaluationPolicy.minimumSelectedMedianNetRoi",
        ),
        maximum_selected_false_discovery_rate=_number(
            source.get("maximumSelectedFalseDiscoveryRate", 0.40),
            "evaluationPolicy.maximumSelectedFalseDiscoveryRate",
        ),
        promotion_policy=PromotionPolicy(
            version=version.strip(),
            minimum_cases=_integer(
                promotion.get("minimumCases", minimum_cases),
                "evaluationPolicy.promotionPolicy.minimumCases",
            ),
            minimum_baseline_lift=_number(
                promotion.get("minimumBaselineLift", 0.02),
                "evaluationPolicy.promotionPolicy.minimumBaselineLift",
            ),
            interval_80_coverage_min=_number(
                promotion.get("interval80CoverageMin", 0.72),
                "evaluationPolicy.promotionPolicy.interval80CoverageMin",
            ),
            interval_80_coverage_max=_number(
                promotion.get("interval80CoverageMax", 0.88),
                "evaluationPolicy.promotionPolicy.interval80CoverageMax",
            ),
            maximum_brier_score=_number(
                promotion.get("maximumBrierScore", 0.25),
                "evaluationPolicy.promotionPolicy.maximumBrierScore",
            ),
            required_baselines=baselines,
        ),
    )


def _features(row: Mapping[str, object], name: str) -> ForecastFeatures:
    feature = _mapping(row.get("features"), f"{name}.features")
    timestamps = feature.get("featureTimestamps", ())
    if not isinstance(timestamps, (list, tuple)):
        raise ValueError(f"{name}.features.featureTimestamps must be an array")
    return ForecastFeatures(
        variant_id=_text(row.get("variantId"), f"{name}.variantId"),
        cohort_key=_text(row.get("cohortKey"), f"{name}.cohortKey"),
        origin=_datetime(row.get("origin"), f"{name}.origin"),
        current_price=_number(row.get("currentPrice"), f"{name}.currentPrice"),
        robust_daily_log_slope=_number(
            feature.get("robustDailyLogSlope"),
            f"{name}.features.robustDailyLogSlope",
        ),
        volatility_daily=_number(
            feature.get("volatilityDaily"), f"{name}.features.volatilityDaily",
        ),
        evidence_quality=_number(
            feature.get("evidenceQuality"), f"{name}.features.evidenceQuality",
        ),
        history_days=_integer(
            feature.get("historyDays"), f"{name}.features.historyDays",
        ),
        set_id=str(row.get("setId") or "").strip(),
        market_daily_log_slope=_optional_number(
            feature.get("marketDailyLogSlope"),
            f"{name}.features.marketDailyLogSlope",
        ),
        lifecycle_log_return_30d=_optional_number(
            feature.get("lifecycleLogReturn30d"),
            f"{name}.features.lifecycleLogReturn30d",
        ),
        lifecycle_log_return_90d=_optional_number(
            feature.get("lifecycleLogReturn90d"),
            f"{name}.features.lifecycleLogReturn90d",
        ),
        structural_median_price=_optional_number(
            feature.get("structuralMedianPrice"),
            f"{name}.features.structuralMedianPrice",
        ),
        structural_lower_price=_optional_number(
            feature.get("structuralLowerPrice"),
            f"{name}.features.structuralLowerPrice",
        ),
        demand_acceleration=_optional_number(
            feature.get("demandAcceleration"),
            f"{name}.features.demandAcceleration",
        ),
        demand_normalization_version=(
            None
            if feature.get("demandNormalizationVersion") is None
            else _text(
                feature.get("demandNormalizationVersion"),
                f"{name}.features.demandNormalizationVersion",
            )
        ),
        reprint_risk=_optional_number(
            feature.get("reprintRisk"), f"{name}.features.reprintRisk",
        ),
        feature_timestamps=tuple(
            _datetime(item, f"{name}.features.featureTimestamps") for item in timestamps
        ),
    )


def _series(row: Mapping[str, object], name: str) -> PriceSeriesKey:
    series = _mapping(row.get("series"), f"{name}.series")
    return PriceSeriesKey(
        canonical_variant_id=_text(row.get("variantId"), f"{name}.variantId"),
        source_id=_text(series.get("sourceId"), f"{name}.series.sourceId"),
        currency=_text(series.get("currency", "USD"), f"{name}.series.currency"),
        finish=_text(series.get("finish"), f"{name}.series.finish"),
        condition_class=_text(series.get("conditionClass"), f"{name}.series.conditionClass"),
        price_semantics=_text(series.get("priceSemantics"), f"{name}.series.priceSemantics"),
        language=_text(series.get("language", "en"), f"{name}.series.language"),
        market_condition=_text(
            series.get("marketCondition"), f"{name}.series.marketCondition"
        ),
    )


def _series_value(key: PriceSeriesKey) -> dict[str, object]:
    return {
        "sourceId": key.source_id,
        "currency": key.currency,
        "language": key.language,
        "finish": key.finish,
        "conditionClass": key.condition_class,
        "marketCondition": key.market_condition,
        "priceSemantics": key.price_semantics,
    }


def _compiled_coverage_contract(
    audit: Mapping[str, object],
    raw_examples: list[Mapping[str, object]],
    raw_targets: list[Mapping[str, object]],
    generated_at: datetime,
    lineage: ResearchLineage,
    raw_engine_policy: Mapping[str, object],
    raw_evaluation_policy: Mapping[str, object],
) -> tuple[
    dict[tuple[str, int], DeclaredPanelCoverage],
    dict[str, PriceSeriesKey],
    dict[str, str],
]:
    """Validate the exact caller-declared grid and bind report coverage to it."""

    expected_audit_keys = {
        "compilerVersion", "inputDatasetSha256", "featureDatasetSha256",
        "compilerCodeArtifactSha256", "sourcePolicySha256", "sourceId",
        "termsReviewId", "compiledAt", "inputCutoffAt", "declaredSeriesCount",
        "compilerConfig", "compilerConfigSha256", "declaredMembers",
        "declaredPanelSha256", "declaredGridSha256", "declaredOrigins",
        "declaredHorizons", "declaredOriginCount", "expectedCellCount",
        "cellStateCounts", "cells", "cellLedgerSha256", "canonicalCohortKey",
        "cohortDefinition", "universeCompleteness", "evidenceTiming",
        "prospectiveEvidenceEligible", "catalogMetadataAuthority",
        "promotionBlockReasonCodes", "candidateUniverseVerification",
        "candidateUniverseIdsIssued", "targetWindowPolicy",
        "observationStatusCounts", "abstentions", "publicPublicationAllowed",
        "auditSha256",
    }
    if set(audit) != expected_audit_keys:
        raise ValueError("compilerAudit has an invalid top-level field contract")
    if audit.get("compilerVersion") != FORECAST_OBSERVATION_COMPILER_VERSION:
        raise ValueError("compilerAudit compiler version is unsupported")
    for field in (
        "inputDatasetSha256", "featureDatasetSha256", "compilerCodeArtifactSha256",
        "sourcePolicySha256", "compilerConfigSha256", "auditSha256",
    ):
        _digest(audit.get(field), f"compilerAudit.{field}")
    source_id = _uuid(audit.get("sourceId"), "compilerAudit.sourceId")
    _uuid(audit.get("termsReviewId"), "compilerAudit.termsReviewId")
    compiled_at = _datetime(audit.get("compiledAt"), "compilerAudit.compiledAt")
    input_cutoff = _datetime(audit.get("inputCutoffAt"), "compilerAudit.inputCutoffAt")
    if (
        audit.get("compiledAt") != compiled_at.isoformat()
        or audit.get("inputCutoffAt") != input_cutoff.isoformat()
        or input_cutoff != compiled_at
        or generated_at != compiled_at
    ):
        raise ValueError(
            "compiled Forecast Lab input requires the exact honest compiler generation time"
        )

    compiler_config = _mapping(
        audit.get("compilerConfig"), "compilerAudit.compilerConfig",
    )
    expected_config_keys = {
        "generatedAt", "origins", "horizons", "mappingVersion", "codeVersion",
        "codeArtifactSha256", "expectedIntervalDays", "maxReferenceLagDays",
        "enginePolicy", "evaluationPolicy",
    }
    if set(compiler_config) != expected_config_keys:
        raise ValueError("compilerAudit.compilerConfig has an invalid field contract")
    if _canonical_hash(compiler_config) != audit.get("compilerConfigSha256"):
        raise ValueError("compilerAudit.compilerConfig hash is inconsistent")
    if (
        compiler_config.get("generatedAt") != audit.get("compiledAt")
        or compiler_config.get("generatedAt") != audit.get("inputCutoffAt")
    ):
        raise ValueError("compilerAudit.compilerConfig generation time is inconsistent")
    if compiler_config.get("origins") != audit.get("declaredOrigins"):
        raise ValueError("compilerAudit.compilerConfig origins are inconsistent")
    if compiler_config.get("horizons") != audit.get("declaredHorizons"):
        raise ValueError("compilerAudit.compilerConfig horizons are inconsistent")
    if compiler_config.get("mappingVersion") != lineage.mapping_version:
        raise ValueError("compilerAudit.compilerConfig mapping version differs from lineage")
    if compiler_config.get("codeVersion") != lineage.code_version:
        raise ValueError("compilerAudit.compilerConfig code version differs from lineage")
    if _digest(
        compiler_config.get("codeArtifactSha256"),
        "compilerAudit.compilerConfig.codeArtifactSha256",
    ) != audit.get("compilerCodeArtifactSha256"):
        raise ValueError("compilerAudit.compilerConfig code artifact is inconsistent")
    config_engine_policy = _mapping(
        compiler_config.get("enginePolicy"),
        "compilerAudit.compilerConfig.enginePolicy",
    )
    config_evaluation_policy = _mapping(
        compiler_config.get("evaluationPolicy"),
        "compilerAudit.compilerConfig.evaluationPolicy",
    )
    if _canonical_hash(config_engine_policy) != _canonical_hash(raw_engine_policy):
        raise ValueError("manifest enginePolicy differs from compilerAudit.compilerConfig")
    if _canonical_hash(config_evaluation_policy) != _canonical_hash(raw_evaluation_policy):
        raise ValueError("manifest evaluationPolicy differs from compilerAudit.compilerConfig")
    max_reference_lag = compiler_config.get("maxReferenceLagDays")
    if (
        isinstance(max_reference_lag, bool)
        or not isinstance(max_reference_lag, (int, float))
        or not isfinite(max_reference_lag)
        or max_reference_lag < 0
    ):
        raise ValueError(
            "compilerAudit.compilerConfig.maxReferenceLagDays is invalid"
        )
    status_counts = audit.get("observationStatusCounts")
    if (
        not isinstance(status_counts, Mapping)
        or not status_counts
        or any(key not in {"accepted", "missing", "outlier", "quarantined"} for key in status_counts)
        or any(
            isinstance(value, bool) or not isinstance(value, int) or value < 0
            for value in status_counts.values()
        )
        or sum(status_counts.values()) < 1
    ):
        raise ValueError("compilerAudit.observationStatusCounts is invalid")

    marker_values = {
        "universeCompleteness": "declared_only",
        "evidenceTiming": "retrospective",
        "catalogMetadataAuthority": "caller_declared_export",
    }
    if any(audit.get(name) != value for name, value in marker_values.items()):
        raise ValueError("compiled declared-panel evidence markers are invalid")
    if audit.get("prospectiveEvidenceEligible") is not False:
        raise ValueError("compiled retrospective evidence cannot be prospectively eligible")
    blockers = audit.get("promotionBlockReasonCodes")
    if blockers != list(COMPILED_PROMOTION_BLOCKERS):
        raise ValueError("compiled promotion blockers are invalid")

    raw_members = audit.get("declaredMembers")
    raw_origins = audit.get("declaredOrigins")
    raw_horizons = audit.get("declaredHorizons")
    raw_cells = audit.get("cells")
    if (
        not isinstance(raw_members, list)
        or not raw_members
        or len(raw_members) > MAX_COMPILED_MEMBERS
        or any(not isinstance(item, Mapping) for item in raw_members)
    ):
        raise ValueError("compilerAudit.declaredMembers is invalid")
    if (
        not isinstance(raw_origins, list)
        or not raw_origins
        or len(raw_origins) > MAX_COMPILED_ORIGINS
    ):
        raise ValueError("compilerAudit.declaredOrigins is invalid")
    if not isinstance(raw_horizons, list) or not raw_horizons or len(raw_horizons) > 2:
        raise ValueError("compilerAudit.declaredHorizons is invalid")
    if not isinstance(raw_cells, list) or len(raw_cells) > MAX_COMPILED_CELLS or any(
        not isinstance(item, Mapping) for item in raw_cells
    ):
        raise ValueError("compilerAudit.cells is invalid")

    target_policy = _mapping(
        audit.get("targetWindowPolicy"), "compilerAudit.targetWindowPolicy",
    )
    expected_interval = target_policy.get("expectedIntervalDays")
    minimum_coverage = target_policy.get("minimumCoverage")
    maximum_gap_policy = target_policy.get("maximumGapDays")
    if (
        set(target_policy) != {
            "windowDays", "expectedIntervalDays", "minimumCoverage", "maximumGapDays",
        }
        or isinstance(target_policy.get("windowDays"), bool)
        or not isinstance(target_policy.get("windowDays"), int)
        or target_policy.get("windowDays") != TARGET_WINDOW_DAYS
        or isinstance(expected_interval, bool)
        or not isinstance(expected_interval, int)
        or expected_interval < 1
        or not isinstance(minimum_coverage, float)
        or not isfinite(minimum_coverage)
        or minimum_coverage != 1.0
        or isinstance(maximum_gap_policy, bool)
        or not isinstance(maximum_gap_policy, int)
        or maximum_gap_policy != expected_interval
    ):
        raise ValueError("compilerAudit target-window policy is invalid")
    config_expected_interval = compiler_config.get("expectedIntervalDays")
    if (
        isinstance(config_expected_interval, bool)
        or not isinstance(config_expected_interval, int)
        or config_expected_interval < 1
        or config_expected_interval != expected_interval
    ):
        raise ValueError("compilerAudit.compilerConfig target cadence is inconsistent")

    declared_members: list[dict[str, object]] = []
    series_by_market_id: dict[str, PriceSeriesKey] = {}
    market_id_by_variant: dict[str, str] = {}
    member_by_identity: dict[tuple[str, str], dict[str, object]] = {}
    for index, raw in enumerate(raw_members):
        name = f"compilerAudit.declaredMembers[{index}]"
        expected_keys = {
            "variantId", "marketSeriesId", "marketSeriesIdentityHash", "setId",
            "game", "cohortKey", "series",
        }
        if set(raw) != expected_keys:
            raise ValueError(f"{name} has an invalid field contract")
        variant_id = _uuid(raw.get("variantId"), f"{name}.variantId")
        market_series_id = _uuid(raw.get("marketSeriesId"), f"{name}.marketSeriesId")
        if (
            raw.get("variantId") != variant_id
            or raw.get("marketSeriesId") != market_series_id
        ):
            raise ValueError(f"{name} identifiers are not canonically encoded")
        series = _series(raw, name)
        if series.source_id != source_id:
            raise ValueError(f"{name}.series.sourceId differs from compiler source")
        cohort = _text(raw.get("cohortKey"), f"{name}.cohortKey")
        game = normalize_market_identity(_text(raw.get("game"), f"{name}.game"))
        if cohort != canonical_forecast_cohort_key(game, series):
            raise ValueError(f"{name}.cohortKey is not canonical")
        member = {
            "variantId": variant_id,
            "marketSeriesId": market_series_id,
            "marketSeriesIdentityHash": _digest(
                raw.get("marketSeriesIdentityHash"),
                f"{name}.marketSeriesIdentityHash",
            ),
            "setId": _uuid(raw.get("setId"), f"{name}.setId"),
            "game": game,
            "cohortKey": cohort,
            "series": _series_value(series),
        }
        if dict(raw) != member:
            raise ValueError(f"{name} is not canonically encoded")
        identity = (variant_id, market_series_id)
        if identity in member_by_identity:
            raise ValueError("compilerAudit.declaredMembers contains duplicates")
        if market_series_id in series_by_market_id:
            raise ValueError("compiled declared members reuse a marketSeriesId")
        if variant_id in market_id_by_variant:
            raise ValueError("compiled declared members reuse a variantId")
        member_by_identity[identity] = member
        series_by_market_id[market_series_id] = series
        market_id_by_variant[variant_id] = market_series_id
        declared_members.append(member)

    if [value["marketSeriesId"] for value in declared_members] != sorted(
        value["marketSeriesId"] for value in declared_members
    ):
        raise ValueError("compilerAudit.declaredMembers are not canonically ordered")

    cohorts = {str(value["cohortKey"]) for value in declared_members}
    if len(cohorts) != 1 or audit.get("canonicalCohortKey") != next(iter(cohorts)):
        raise ValueError("compilerAudit canonical cohort is inconsistent")
    first_member = declared_members[0]
    if audit.get("cohortDefinition") != {
        "version": "forecast-cohort-v1",
        "game": first_member["game"],
        **dict(first_member["series"]),
    }:
        raise ValueError("compilerAudit cohort definition is inconsistent")
    declared_series_count = audit.get("declaredSeriesCount")
    if (
        isinstance(declared_series_count, bool)
        or not isinstance(declared_series_count, int)
        or declared_series_count != len(declared_members)
    ):
        raise ValueError("compilerAudit declared series count is inconsistent")

    if _digest(audit.get("declaredPanelSha256"), "compilerAudit.declaredPanelSha256") != _canonical_hash(declared_members):
        raise ValueError("compilerAudit declared panel hash is inconsistent")
    origins = tuple(
        _datetime(value, f"compilerAudit.declaredOrigins[{index}]")
        for index, value in enumerate(raw_origins)
    )
    if len(set(origins)) != len(origins) or tuple(sorted(origins)) != origins:
        raise ValueError("compilerAudit.declaredOrigins must be unique and sorted")
    canonical_origins = [value.isoformat() for value in origins]
    if raw_origins != canonical_origins:
        raise ValueError("compilerAudit.declaredOrigins are not canonical")
    declared_origin_count = audit.get("declaredOriginCount")
    if (
        isinstance(declared_origin_count, bool)
        or not isinstance(declared_origin_count, int)
        or declared_origin_count != len(origins)
    ):
        raise ValueError("compilerAudit declared origin count is inconsistent")
    horizons = tuple(raw_horizons)
    if (
        any(
            isinstance(value, bool) or not isinstance(value, int) or value not in (30, 90)
            for value in horizons
        )
        or len(set(horizons)) != len(horizons)
        or tuple(sorted(horizons)) != horizons
    ):
        raise ValueError("compilerAudit.declaredHorizons are invalid")
    expected_grid_hash = _canonical_hash({
        "declaredMembers": declared_members,
        "declaredOrigins": canonical_origins,
        "declaredHorizons": list(horizons),
    })
    if _digest(audit.get("declaredGridSha256"), "compilerAudit.declaredGridSha256") != expected_grid_hash:
        raise ValueError("compilerAudit declared grid hash is inconsistent")

    expected_cell_count = len(declared_members) * len(origins) * len(horizons)
    if (
        isinstance(audit.get("expectedCellCount"), bool)
        or not isinstance(audit.get("expectedCellCount"), int)
        or audit.get("expectedCellCount") != expected_cell_count
        or len(raw_cells) != expected_cell_count
    ):
        raise ValueError("compilerAudit expected cell count is inconsistent")
    if _digest(audit.get("cellLedgerSha256"), "compilerAudit.cellLedgerSha256") != _canonical_hash(raw_cells):
        raise ValueError("compilerAudit cell ledger hash is inconsistent")

    expected_grid = {
        (member["variantId"], member["marketSeriesId"], origin, horizon)
        for member in declared_members
        for origin in origins
        for horizon in horizons
    }
    cells_by_identity: dict[tuple[str, str, datetime, int], Mapping[str, object]] = {}
    cell_order: list[tuple[str, str, datetime, int]] = []
    state_counts = {state: 0 for state in COMPILED_CELL_STATES}
    slices: dict[tuple[str, int], list[Mapping[str, object]]] = {}
    output_hashes: dict[str, dict[tuple[str, str, datetime, int], str]] = {
        "scored": {}, "open": {},
    }
    for index, raw in enumerate(raw_cells):
        name = f"compilerAudit.cells[{index}]"
        variant_id = _uuid(raw.get("variantId"), f"{name}.variantId")
        market_series_id = _uuid(raw.get("marketSeriesId"), f"{name}.marketSeriesId")
        if (
            raw.get("variantId") != variant_id
            or raw.get("marketSeriesId") != market_series_id
        ):
            raise ValueError(f"{name} identifiers are not canonically encoded")
        member = member_by_identity.get((variant_id, market_series_id))
        if member is None:
            raise ValueError(f"{name} is not in the declared panel")
        for field in (
            "marketSeriesIdentityHash", "setId", "game", "cohortKey", "series",
        ):
            if raw.get(field) != member[field]:
                raise ValueError(f"{name}.{field} differs from its declared member")
        origin = _datetime(raw.get("origin"), f"{name}.origin")
        horizon = raw.get("horizonDays")
        if isinstance(horizon, bool) or not isinstance(horizon, int) or horizon not in horizons:
            raise ValueError(f"{name}.horizonDays is invalid")
        maturity = _datetime(raw.get("maturityAt"), f"{name}.maturityAt")
        if maturity != origin + timedelta(days=horizon):
            raise ValueError(f"{name}.maturityAt is inconsistent")
        state = raw.get("state")
        if state not in COMPILED_CELL_STATES:
            raise ValueError(f"{name}.state is invalid")
        if state == "open" and maturity <= generated_at:
            raise ValueError(f"{name} open state has already matured")
        if state in ("scored", "unscorable") and maturity > generated_at:
            raise ValueError(f"{name} outcome state has not matured")
        reasons = raw.get("reasonCodes")
        if (
            not isinstance(reasons, list)
            or any(not isinstance(value, str) or not value for value in reasons)
            or len(set(reasons)) != len(reasons)
            or (state in ("open", "scored") and reasons)
            or (state in ("feature_abstained", "unscorable") and not reasons)
        ):
            raise ValueError(f"{name}.reasonCodes is invalid")
        expected_keys = {
            "variantId", "marketSeriesId", "marketSeriesIdentityHash", "setId",
            "game", "cohortKey", "series", "origin", "horizonDays", "maturityAt",
            "state", "reasonCodes",
        }
        if state in ("open", "scored"):
            expected_keys.add("compiledRowSha256")
        if state in ("scored", "unscorable"):
            expected_keys.add("targetWindow")
        if set(raw) != expected_keys:
            raise ValueError(f"{name} has an invalid field contract")
        if raw.get("origin") != origin.isoformat() or raw.get("maturityAt") != maturity.isoformat():
            raise ValueError(f"{name} timestamps are not canonical")
        identity = (variant_id, market_series_id, origin, horizon)
        if identity in cells_by_identity:
            raise ValueError("compilerAudit.cells contains duplicate grid cells")
        cells_by_identity[identity] = raw
        cell_order.append(identity)
        state_counts[state] += 1
        slices.setdefault((str(member["cohortKey"]), horizon), []).append(raw)
        has_row_hash = raw.get("compiledRowSha256") is not None
        if state in ("open", "scored"):
            if not has_row_hash:
                raise ValueError(f"{name} requires compiledRowSha256")
            output_hashes[state][identity] = _digest(
                raw.get("compiledRowSha256"), f"{name}.compiledRowSha256",
            )
        elif has_row_hash:
            raise ValueError(f"{name} cannot contain compiledRowSha256")
        if state in ("scored", "unscorable"):
            window = raw.get("targetWindow")
            if not isinstance(window, Mapping) or set(window) != {
                "windowDays", "expectedIntervalDays", "expectedDateCount",
                "observedDateCount", "coverage", "maximumGapDays",
            }:
                raise ValueError(f"{name}.targetWindow is invalid")
            expected_dates = (TARGET_WINDOW_DAYS - 1) // expected_interval + 1
            window_days = window.get("windowDays")
            window_interval = window.get("expectedIntervalDays")
            expected_date_count = window.get("expectedDateCount")
            observed_dates = window.get("observedDateCount")
            coverage = window.get("coverage")
            maximum_gap = window.get("maximumGapDays")
            if (
                isinstance(window_days, bool)
                or not isinstance(window_days, int)
                or window_days != TARGET_WINDOW_DAYS
                or isinstance(window_interval, bool)
                or not isinstance(window_interval, int)
                or window_interval != expected_interval
                or isinstance(expected_date_count, bool)
                or not isinstance(expected_date_count, int)
                or expected_date_count != expected_dates
                or isinstance(observed_dates, bool)
                or not isinstance(observed_dates, int)
                or observed_dates < 0
                or not isinstance(coverage, float)
                or not isfinite(coverage)
                or coverage != min(1.0, observed_dates / expected_dates)
                or (
                    maximum_gap is not None
                    and (
                        isinstance(maximum_gap, bool)
                        or not isinstance(maximum_gap, int)
                        or maximum_gap < 0
                    )
                )
            ):
                raise ValueError(f"{name}.targetWindow is inconsistent")
            expected_reasons: list[str] = []
            if observed_dates == 0:
                expected_reasons.append("missing_maturity_window_label")
                if maximum_gap is not None:
                    raise ValueError(f"{name}.targetWindow maximum gap is inconsistent")
            else:
                if maximum_gap is None:
                    raise ValueError(f"{name}.targetWindow requires maximumGapDays")
                if observed_dates < expected_dates:
                    expected_reasons.append("incomplete_maturity_window_coverage")
                if maximum_gap > expected_interval:
                    expected_reasons.append("maturity_window_gap_exceeds_policy")
            if reasons != expected_reasons:
                raise ValueError(f"{name} target-window reasons are inconsistent")
            if state == "scored" and expected_reasons:
                raise ValueError(f"{name} scored state has incomplete target coverage")
            if state == "unscorable" and not expected_reasons:
                raise ValueError(f"{name} unscorable state has complete target coverage")
        elif raw.get("targetWindow") is not None:
            raise ValueError(f"{name} cannot contain targetWindow")
    if set(cells_by_identity) != expected_grid:
        raise ValueError("compilerAudit.cells do not reconcile to the declared Cartesian grid")
    if cell_order != sorted(
        cell_order, key=lambda value: (value[2], value[3], value[1]),
    ):
        raise ValueError("compilerAudit.cells are not canonically ordered")
    raw_state_counts = audit.get("cellStateCounts")
    if (
        not isinstance(raw_state_counts, Mapping)
        or set(raw_state_counts) != set(COMPILED_CELL_STATES)
        or any(
            isinstance(value, bool) or not isinstance(value, int) or value < 0
            for value in raw_state_counts.values()
        )
        or dict(raw_state_counts) != state_counts
    ):
        raise ValueError("compilerAudit.cellStateCounts is inconsistent")

    def row_hashes(
        rows: list[Mapping[str, object]], name: str,
    ) -> dict[tuple[str, str, datetime, int], str]:
        result: dict[tuple[str, str, datetime, int], str] = {}
        order: list[tuple[str, str, datetime, int]] = []
        for index, row in enumerate(rows):
            row_name = f"{name}[{index}]"
            expected_row_keys = {
                "variantId", "setId", "cohortKey", "origin", "horizonDays",
                "currentPrice", "marketSeriesId", "series", "features",
            }
            if name == "examples":
                expected_row_keys.add("targetObservations")
            if set(row) != expected_row_keys:
                raise ValueError(f"{row_name} has an invalid compiled-row field contract")
            features = _mapping(row.get("features"), f"{row_name}.features")
            expected_feature_keys = {
                "robustDailyLogSlope", "volatilityDaily", "evidenceQuality",
                "historyDays", "marketDailyLogSlope", "lifecycleLogReturn30d",
                "lifecycleLogReturn90d", "structuralMedianPrice",
                "structuralLowerPrice", "demandAcceleration",
                "demandNormalizationVersion", "reprintRisk", "featureTimestamps",
            }
            if set(features) != expected_feature_keys:
                raise ValueError(f"{row_name}.features has an invalid field contract")
            if any(
                features[field] is not None
                for field in (
                    "marketDailyLogSlope", "lifecycleLogReturn30d",
                    "lifecycleLogReturn90d", "structuralMedianPrice",
                    "structuralLowerPrice", "demandAcceleration",
                    "demandNormalizationVersion", "reprintRisk",
                )
            ):
                raise ValueError(f"{row_name} contains caller-authored unavailable features")
            timestamps = features.get("featureTimestamps")
            if not isinstance(timestamps, list) or len(timestamps) != 1:
                raise ValueError(f"{row_name}.features.featureTimestamps is invalid")
            _number(row.get("currentPrice"), f"{row_name}.currentPrice")
            for feature_name in (
                "robustDailyLogSlope", "volatilityDaily", "evidenceQuality",
            ):
                _number(
                    features.get(feature_name),
                    f"{row_name}.features.{feature_name}",
                )
            _integer(
                features.get("historyDays"), f"{row_name}.features.historyDays",
            )
            variant_id = _uuid(row.get("variantId"), f"{row_name}.variantId")
            market_series_id = _uuid(
                row.get("marketSeriesId"), f"{row_name}.marketSeriesId",
            )
            origin = _datetime(row.get("origin"), f"{row_name}.origin")
            horizon = _integer(row.get("horizonDays"), f"{row_name}.horizonDays")
            feature_timestamp = _datetime(
                timestamps[0], f"{row_name}.features.featureTimestamps[0]",
            )
            if (
                row.get("variantId") != variant_id
                or row.get("marketSeriesId") != market_series_id
                or row.get("origin") != origin.isoformat()
                or timestamps[0] != feature_timestamp.isoformat()
                or horizon not in horizons
            ):
                raise ValueError(f"{row_name} is not canonically encoded")
            identity = (
                variant_id,
                market_series_id,
                origin,
                horizon,
            )
            if identity in result:
                raise ValueError(f"{name} contains duplicate declared-grid rows")
            order.append(identity)
            member = member_by_identity.get((identity[0], identity[1]))
            if member is None:
                raise ValueError(f"{row_name} is not in the declared panel")
            if (
                row.get("setId") != member["setId"]
                or row.get("cohortKey") != member["cohortKey"]
                or row.get("series") != member["series"]
            ):
                raise ValueError(f"{row_name} differs from declared catalog/series metadata")
            if name == "examples":
                cell = cells_by_identity.get(identity)
                if cell is None or cell.get("state") != "scored":
                    raise ValueError(f"{row_name} does not map to a scored audit cell")
                target_rows = row.get("targetObservations")
                if not isinstance(target_rows, list) or not target_rows:
                    raise ValueError(f"{row_name}.targetObservations is invalid")
                maturity = identity[2] + timedelta(days=identity[3])
                window_start = maturity - timedelta(days=TARGET_WINDOW_DAYS - 1)
                observed_dates = set()
                target_order: list[tuple[datetime, datetime, str]] = []
                for target_index, target in enumerate(target_rows):
                    target_name = f"{row_name}.targetObservations[{target_index}]"
                    if not isinstance(target, Mapping):
                        raise ValueError(f"{target_name} must be an object")
                    if set(target) != {"id", "observedAt", "availableAt", "price", "quality"}:
                        raise ValueError(f"{target_name} has an invalid field contract")
                    observed_at = _datetime(target.get("observedAt"), f"{target_name}.observedAt")
                    available_at = _datetime(target.get("availableAt"), f"{target_name}.availableAt")
                    observation_id = _uuid(target.get("id"), f"{target_name}.id")
                    _number(target.get("price"), f"{target_name}.price")
                    _number(target.get("quality"), f"{target_name}.quality")
                    if (
                        target.get("id") != observation_id
                        or target.get("observedAt") != observed_at.isoformat()
                        or target.get("availableAt") != available_at.isoformat()
                    ):
                        raise ValueError(f"{target_name} is not canonically encoded")
                    if not window_start <= observed_at <= maturity or available_at > maturity:
                        raise ValueError(f"{target_name} is outside the maturity window")
                    observed_dates.add(observed_at.date())
                    target_order.append((observed_at, available_at, observation_id))
                if target_order != sorted(target_order):
                    raise ValueError(f"{row_name}.targetObservations are not canonically ordered")
                ordered_dates = sorted(observed_dates)
                boundaries = [window_start.date(), *ordered_dates, maturity.date()]
                maximum_gap = max(
                    (right - left).days
                    for left, right in zip(boundaries, boundaries[1:])
                )
                target_window = cell["targetWindow"]
                if (
                    target_window["observedDateCount"] != len(ordered_dates)
                    or target_window["coverage"]
                    != min(1.0, len(ordered_dates) / target_window["expectedDateCount"])
                    or target_window["maximumGapDays"] != maximum_gap
                    or len(ordered_dates) < target_window["expectedDateCount"]
                    or maximum_gap > expected_interval
                ):
                    raise ValueError(f"{row_name} target observations differ from cadence audit")
            result[identity] = _canonical_hash(row)
        if order != sorted(order, key=lambda value: (value[2], value[3], value[1])):
            raise ValueError(f"{name} rows are not canonically ordered")
        return result

    if row_hashes(raw_examples, "examples") != output_hashes["scored"]:
        raise ValueError("compiled examples do not exactly match scored audit cells")
    if row_hashes(raw_targets, "targets") != output_hashes["open"]:
        raise ValueError("compiled targets do not exactly match open audit cells")

    abstentions = audit.get("abstentions")
    expected_abstentions = {
        (identity[0], identity[1], identity[2], identity[3]): tuple(cell["reasonCodes"])
        for identity, cell in cells_by_identity.items()
        if cell["state"] in ("feature_abstained", "unscorable")
    }
    actual_abstentions: dict[tuple[str, str, datetime, int], tuple[str, ...]] = {}
    abstention_order: list[tuple[str, str, datetime, int]] = []
    for index, raw in enumerate(abstentions):
        name = f"compilerAudit.abstentions[{index}]"
        if set(raw) != {
            "variantId", "marketSeriesId", "origin", "horizonDays", "reasonCodes",
        }:
            raise ValueError(f"{name} has an invalid field contract")
        variant_id = _uuid(raw.get("variantId"), f"{name}.variantId")
        market_series_id = _uuid(raw.get("marketSeriesId"), f"{name}.marketSeriesId")
        origin = _datetime(raw.get("origin"), f"{name}.origin")
        horizon = _integer(raw.get("horizonDays"), f"{name}.horizonDays")
        if (
            raw.get("variantId") != variant_id
            or raw.get("marketSeriesId") != market_series_id
            or raw.get("origin") != origin.isoformat()
            or horizon not in horizons
        ):
            raise ValueError(f"{name} is not canonically encoded")
        identity = (variant_id, market_series_id, origin, horizon)
        reasons = raw.get("reasonCodes")
        if identity in actual_abstentions or not isinstance(reasons, list):
            raise ValueError("compilerAudit.abstentions is inconsistent")
        abstention_order.append(identity)
        actual_abstentions[identity] = tuple(reasons)
    if abstention_order != sorted(
        abstention_order, key=lambda value: (value[2], value[3], value[1]),
    ):
        raise ValueError("compilerAudit.abstentions are not canonically ordered")
    if actual_abstentions != expected_abstentions:
        raise ValueError("compilerAudit abstentions do not reconcile to cell states")

    coverage_by_slice: dict[tuple[str, int], DeclaredPanelCoverage] = {}
    ledger_hash = _digest(audit.get("cellLedgerSha256"), "compilerAudit.cellLedgerSha256")
    for identity, cells in slices.items():
        counts = {state: 0 for state in COMPILED_CELL_STATES}
        for cell in cells:
            counts[str(cell["state"])] += 1
        coverage_by_slice[identity] = DeclaredPanelCoverage(
            planned_count=len(cells),
            feature_abstained_count=counts["feature_abstained"],
            open_count=counts["open"],
            scored_count=counts["scored"],
            unscorable_count=counts["unscorable"],
            cell_ledger_sha256=ledger_hash,
            promotion_block_reason_codes=tuple(COMPILED_PROMOTION_BLOCKERS),
            universe_completeness=str(audit.get("universeCompleteness")),
            evidence_timing=str(audit.get("evidenceTiming")),
            prospective_evidence_eligible=False,
            catalog_metadata_authority=str(audit.get("catalogMetadataAuthority")),
        )
    return coverage_by_slice, series_by_market_id, market_id_by_variant


def _cost_quote(
    value: object,
    name: str,
    *,
    market_series_id: str,
    origin: datetime,
    horizon_days: int,
    series: PriceSeriesKey,
) -> tuple[AcquisitionQuoteKey, AcquisitionCosts] | None:
    if value is None:
        return None
    source = _mapping(value, name)
    currency = _text(source.get("currency"), f"{name}.currency").upper()
    if currency != series.currency:
        raise ValueError(f"{name}.currency differs from the market series")
    quote = AcquisitionQuoteKey(
        market_series_id=market_series_id,
        forecast_origin=origin,
        horizon_days=horizon_days,
        currency=currency,
        quoted_at=_datetime(source.get("quotedAt"), f"{name}.quotedAt"),
    )
    costs = AcquisitionCosts(
        offer_price=_number(source.get("offerPrice"), f"{name}.offerPrice"),
        tax_rate=_number(source.get("taxRate", 0), f"{name}.taxRate"),
        buy_shipping=_number(source.get("buyShipping", 0), f"{name}.buyShipping"),
        sell_fee_rate=_number(
            source.get("sellFeeRate", 0.13), f"{name}.sellFeeRate",
        ),
        sell_fee_fixed=_number(
            source.get("sellFeeFixed", 0), f"{name}.sellFeeFixed",
        ),
        sell_shipping=_number(
            source.get("sellShipping", 0), f"{name}.sellShipping",
        ),
        liquidity_haircut_rate=_optional_number(
            source.get("liquidityHaircutRate"), f"{name}.liquidityHaircutRate",
        ),
    )
    return quote, costs


def _label_observations(
    row: Mapping[str, object],
    name: str,
    series: PriceSeriesKey,
) -> tuple[PriceObservation, ...]:
    raw_values = _array(
        row.get("targetObservations"),
        f"{name}.targetObservations",
        maximum=31,
    )
    values: list[PriceObservation] = []
    for index, raw in enumerate(raw_values):
        item_name = f"{name}.targetObservations[{index}]"
        values.append(PriceObservation(
            key=series,
            observed_at=_datetime(raw.get("observedAt"), f"{item_name}.observedAt"),
            available_at=_datetime(raw.get("availableAt"), f"{item_name}.availableAt"),
            price=_number(raw.get("price"), f"{item_name}.price"),
            quality=_number(raw.get("quality", 1), f"{item_name}.quality"),
            source_observation_id=_uuid(raw.get("id"), f"{item_name}.id"),
        ))
    return tuple(values)


def _after_cost_view(
    forecast: object,
    quote: AcquisitionQuoteKey,
    costs: AcquisitionCosts,
    features: ForecastFeatures,
    candidate_universe_id: str | None,
) -> Mapping[str, object]:
    candidate = build_watch_candidate(
        forecast,
        costs,
        evidence_quality=features.evidence_quality,
        structural_lower_price=features.structural_lower_price,
    )
    net_roi = {
        str(probability): costs.net_exit(price) / costs.all_in_cost - 1
        for probability, price in forecast.quantiles.items()
    }
    reasons = list(candidate.reason_codes)
    if candidate_universe_id is None:
        reasons.append("candidate_universe_lineage_missing")
    return {
        "marketSeriesId": quote.market_series_id,
        "currency": quote.currency,
        "quotedAt": quote.quoted_at.isoformat(),
        "forecastOrigin": quote.forecast_origin.isoformat(),
        "horizonDays": quote.horizon_days,
        "candidateUniverseId": candidate_universe_id,
        "offerPrice": costs.offer_price,
        "allInAcquisitionCost": costs.all_in_cost,
        "breakEvenResalePrice": costs.break_even_resale_price,
        "liquidityAdjustedBreakEvenReference": (
            costs.liquidity_adjusted_break_even_reference
        ),
        "netRoiByQuantile": net_roi,
        "probabilityNetProceedsExceedCost": candidate.probability_net_positive,
        "selectionStatus": (
            candidate.status if candidate_universe_id is not None else "not_selected"
        ),
        "reasonCodes": reasons,
    }


def build_forecast_lab_packet(
    manifest: Mapping[str, object],
    *,
    generated_at: datetime,
) -> Mapping[str, object]:
    """Validate one feature manifest and produce private shadow evidence."""

    if manifest.get("mode") != "research_only":
        raise PermissionError("Forecast Lab manifest must remain research_only")
    if (
        not isinstance(generated_at, datetime)
        or generated_at.tzinfo is None
        or generated_at.utcoffset() is None
    ):
        raise ValueError("generated_at must be a timezone-aware datetime")
    generated = generated_at.astimezone(timezone.utc)
    lineage_source = _mapping(manifest.get("lineage"), "lineage")
    lineage = ResearchLineage(
        dataset_sha256=_text(lineage_source.get("datasetSha256"), "lineage.datasetSha256"),
        code_version=_text(lineage_source.get("codeVersion"), "lineage.codeVersion"),
        feature_version=_text(lineage_source.get("featureVersion"), "lineage.featureVersion"),
        mapping_version=_text(lineage_source.get("mappingVersion"), "lineage.mappingVersion"),
        model_version=_text(lineage_source.get("modelVersion"), "lineage.modelVersion"),
    )
    compiler_audit = None
    if (
        lineage.feature_version == COMPILED_FEATURE_VERSION
        and manifest.get("compilerAudit") is None
    ):
        raise ValueError("compiled feature lineage requires compilerAudit")
    if manifest.get("compilerAudit") is not None:
        if lineage.feature_version != COMPILED_FEATURE_VERSION:
            raise ValueError("compilerAudit requires compiled feature lineage")
        compiler_audit = dict(_mapping(manifest.get("compilerAudit"), "compilerAudit"))
        declared_audit_hash = _text(
            compiler_audit.pop("auditSha256", None), "compilerAudit.auditSha256",
        ).lower()
        if _canonical_hash(compiler_audit) != declared_audit_hash:
            raise ValueError("compilerAudit hash is inconsistent")
        if compiler_audit.get("inputDatasetSha256") != lineage.dataset_sha256:
            raise ValueError("compilerAudit input hash differs from lineage")
        if compiler_audit.get("publicPublicationAllowed") is not False:
            raise PermissionError("compilerAudit must remain private")
        abstentions = compiler_audit.get("abstentions")
        if (
            not isinstance(abstentions, list)
            or len(abstentions) > MAX_EXAMPLES + MAX_TARGETS
            or any(not isinstance(item, Mapping) for item in abstentions)
        ):
            raise ValueError("compilerAudit.abstentions is invalid")
        compiler_audit["auditSha256"] = declared_audit_hash
        if (
            manifest.get("publicCandidateRows") != []
            or manifest.get("publicPublicationAllowed") is not False
        ):
            raise PermissionError("compiled Forecast Lab manifests must remain private")
    raw_examples = _array(
        manifest.get("examples"),
        "examples",
        maximum=MAX_EXAMPLES,
        allow_empty=compiler_audit is not None,
    )
    raw_targets = _array(
        manifest.get("targets", []), "targets", maximum=MAX_TARGETS, allow_empty=True,
    )
    feature_dataset_hash = _canonical_hash({"examples": raw_examples, "targets": raw_targets})
    declared_feature_hash = manifest.get("featureDatasetSha256")
    if declared_feature_hash is not None and str(declared_feature_hash).lower() != feature_dataset_hash:
        raise ValueError("featureDatasetSha256 differs from the canonical feature rows")
    if (
        compiler_audit is not None
        and compiler_audit.get("featureDatasetSha256") != feature_dataset_hash
    ):
        raise ValueError("compilerAudit feature hash differs from the canonical feature rows")
    coverage_by_slice: dict[tuple[str, int], DeclaredPanelCoverage] = {}
    compiled_series_by_market_id: dict[str, PriceSeriesKey] = {}
    compiled_market_id_by_variant: dict[str, str] = {}
    raw_engine_policy = _mapping(manifest.get("enginePolicy", {}), "enginePolicy")
    raw_evaluation_policy = _mapping(
        manifest.get("evaluationPolicy", {}), "evaluationPolicy",
    )
    if compiler_audit is not None:
        if (
            compiler_audit.get("candidateUniverseVerification")
            != CANDIDATE_UNIVERSE_VERIFICATION
            or compiler_audit.get("candidateUniverseIdsIssued") is not False
        ):
            raise ValueError("compiled candidate-universe verification contract is invalid")
        if any(
            row.get("candidateUniverseId") is not None
            for row in (*raw_examples, *raw_targets)
        ):
            raise ValueError(
                "unverified compiled input cannot issue candidateUniverseId values"
            )
        (
            coverage_by_slice,
            compiled_series_by_market_id,
            compiled_market_id_by_variant,
        ) = _compiled_coverage_contract(
            compiler_audit,
            raw_examples,
            raw_targets,
            generated,
            lineage,
            raw_engine_policy,
            raw_evaluation_policy,
        )
    engine_policy = _engine_policy(raw_engine_policy)
    evaluation_policy = _evaluation_policy(raw_evaluation_policy)

    examples: list[MaturedTrainingExample] = []
    costs_by_identity: dict[AcquisitionQuoteKey, AcquisitionCosts] = {}
    series_by_market_id: dict[str, PriceSeriesKey] = dict(compiled_series_by_market_id)
    market_id_by_variant: dict[str, str] = dict(compiled_market_id_by_variant)
    series_by_variant: dict[str, PriceSeriesKey] = {
        variant_id: series_by_market_id[market_series_id]
        for variant_id, market_series_id in market_id_by_variant.items()
    }
    identities: set[tuple[str, datetime, int]] = set()
    for index, raw in enumerate(raw_examples):
        name = f"examples[{index}]"
        feature = _features(raw, name)
        horizon = _integer(raw.get("horizonDays"), f"{name}.horizonDays")
        identity = (feature.variant_id, feature.origin, horizon)
        if identity in identities:
            raise ValueError("examples contain duplicate variant/origin/horizon rows")
        identities.add(identity)
        series = _series(raw, name)
        market_series_id = _uuid(raw.get("marketSeriesId"), f"{name}.marketSeriesId")
        candidate_universe_id = (
            None if raw.get("candidateUniverseId") is None
            else _uuid(raw.get("candidateUniverseId"), f"{name}.candidateUniverseId")
        )
        declared_series = series_by_market_id.setdefault(market_series_id, series)
        if declared_series != series:
            raise ValueError("one marketSeriesId cannot describe multiple exact series")
        declared_market_id = market_id_by_variant.setdefault(feature.variant_id, market_series_id)
        if declared_market_id != market_series_id:
            raise ValueError("one variant cannot mix marketSeriesId lineage")
        maturity = feature.origin + timedelta(days=horizon)
        if any(field in raw for field in ("realizedPrice", "labelAvailableAt", "targetObservationIds")):
            raise ValueError("outcome values and availability must be derived from immutable targetObservations")
        observations = _label_observations(raw, name, series)
        label_available = max(
            maturity,
            *(value.available_at for value in observations),
        )
        if label_available > generated:
            raise ValueError("Forecast Lab cannot evaluate a label unavailable at generation time")
        label = realized_price_at_maturity(
            observations,
            maturity,
            label_available,
            key=series,
        )
        examples.append(MaturedTrainingExample(
            feature,
            horizon,
            label.trailing_seven_day_median,
            label_available,
            series,
            label.observation_ids,
            market_series_id,
            candidate_universe_id,
        ))
        key = examples[-1].series_key
        current_key = series_by_variant.get(feature.variant_id)
        if current_key is not None and current_key != key:
            raise ValueError("one variant cannot mix exact price-series identities")
        series_by_variant[feature.variant_id] = key
        cost_quote = _cost_quote(
            raw.get("costs"), f"{name}.costs",
            market_series_id=market_series_id,
            origin=feature.origin,
            horizon_days=horizon,
            series=series,
        )
        if cost_quote is not None:
            quote, acquisition = cost_quote
            if quote in costs_by_identity:
                raise ValueError("examples contain duplicate cost quote identities")
            costs_by_identity[quote] = acquisition

    reports = []
    report_slices = set(coverage_by_slice) or {
        (value.features.cohort_key, value.horizon_days) for value in examples
    }
    for cohort, horizon in sorted(report_slices):
        report = run_shadow_walk_forward(
            examples,
            horizon,
            cohort,
            series_by_variant,
            lineage,
            engine_policy=engine_policy,
            evaluation_policy=evaluation_policy,
            costs=costs_by_identity or None,
            declared_panel_coverage=coverage_by_slice.get((cohort, horizon)),
        )
        reports.append(report.as_dict())

    target_forecasts = []
    for index, raw in enumerate(raw_targets):
        name = f"targets[{index}]"
        feature = _features(raw, name)
        if feature.origin > generated:
            raise ValueError("target forecast origin cannot exceed generation time")
        horizon = _integer(raw.get("horizonDays"), f"{name}.horizonDays")
        if feature.origin + timedelta(days=horizon) <= generated:
            raise ValueError("target forecast maturity must exceed generation time")
        if any(field in raw for field in (
            "realizedPrice", "labelAvailableAt", "targetObservationIds", "targetObservations",
        )):
            raise ValueError("current targets cannot contain realized outcomes")
        series = _series(raw, name)
        market_series_id = _uuid(raw.get("marketSeriesId"), f"{name}.marketSeriesId")
        candidate_universe_id = (
            None if raw.get("candidateUniverseId") is None
            else _uuid(raw.get("candidateUniverseId"), f"{name}.candidateUniverseId")
        )
        if series_by_market_id.get(market_series_id) != series:
            raise ValueError("target marketSeriesId differs from the training series")
        if market_id_by_variant.get(feature.variant_id) != market_series_id:
            raise ValueError("target variant differs from its marketSeriesId lineage")
        forecast = train_shadow_forecast(
            feature,
            examples,
            horizon,
            feature.origin,
            policy=engine_policy,
            model_version=lineage.model_version,
            series_key=series,
            market_series_id=market_series_id,
        )
        forecast_row = forecast.as_dict()
        cost_quote = _cost_quote(
            raw.get("costs"), f"{name}.costs",
            market_series_id=market_series_id,
            origin=feature.origin,
            horizon_days=horizon,
            series=series,
        )
        forecast_row["afterCost"] = (
            None if cost_quote is None
            else _after_cost_view(
                forecast,
                cost_quote[0],
                cost_quote[1],
                feature,
                candidate_universe_id,
            )
        )
        target_forecasts.append(forecast_row)

    packet: dict[str, object] = {
        "mode": "research_only",
        "simulationMode": "rolling_origin_shadow",
        "generatedAt": generated.isoformat(),
        "lineage": {
            "datasetSha256": lineage.dataset_sha256,
            "featureDatasetSha256": feature_dataset_hash,
            "codeVersion": lineage.code_version,
            "codeArtifactSha256": _code_artifact_hash(),
            "featureVersion": lineage.feature_version,
            "mappingVersion": lineage.mapping_version,
            "modelVersion": lineage.model_version,
        },
        "enginePolicy": engine_policy.as_dict(),
        "evaluationPolicy": {
            "minimumCases": evaluation_policy.minimum_cases,
            "minimumVariants": evaluation_policy.minimum_variants,
            "minimumSets": evaluation_policy.minimum_sets,
            "minimumSpacedOrigins": evaluation_policy.minimum_spaced_origins,
            "minimumOriginSpacingDays": evaluation_policy.minimum_origin_spacing_days,
            "bootstrapSamples": evaluation_policy.bootstrap_samples,
            "confidenceLevel": evaluation_policy.confidence_level,
            "minimumLiftLowerBound": evaluation_policy.minimum_lift_lower_bound,
            "minimumProbabilityCalibrationCases": evaluation_policy.minimum_probability_calibration_cases,
            "minimumAfterCostCalibrationCases": evaluation_policy.minimum_after_cost_calibration_cases,
            "maximumAfterCostBrierScore": evaluation_policy.maximum_after_cost_brier_score,
            "maximumAfterCostCalibrationError": evaluation_policy.maximum_after_cost_calibration_error,
            "minimumSelectedPocketCases": evaluation_policy.minimum_selected_pocket_cases,
            "minimumSelectedPositiveRate": evaluation_policy.minimum_selected_positive_rate,
            "minimumSelectedMedianNetRoi": evaluation_policy.minimum_selected_median_net_roi,
            "maximumSelectedFalseDiscoveryRate": evaluation_policy.maximum_selected_false_discovery_rate,
            "promotionPolicy": evaluation_policy.promotion_policy.as_dict(),
        },
        "reports": reports,
        "shadowForecasts": target_forecasts,
        "marketSeriesIds": sorted(series_by_market_id),
        "publicCandidateRows": [],
        "publicPublicationAllowed": False,
        "operatorReviewRequired": True,
    }
    if compiler_audit is not None:
        packet["compilerAudit"] = compiler_audit
    packet["packetHash"] = _canonical_hash(packet)
    return packet


def _read_json(path: str) -> Mapping[str, object]:
    try:
        text = sys.stdin.read() if path == "-" else Path(path).read_text(encoding="utf-8")
        return _mapping(json.loads(text), "manifest")
    except json.JSONDecodeError as exc:
        raise ValueError("manifest must contain valid JSON") from exc


def _write_private_json(path: str, value: Mapping[str, object], *, pretty: bool) -> None:
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as output:
        json.dump(value, output, indent=2 if pretty else None, sort_keys=True)
        output.write("\n")


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Run private, point-in-time CollectFolio Forecast Lab evidence.",
    )
    parser.add_argument("manifest", help="bounded feature manifest JSON path, or - for stdin")
    parser.add_argument("output", help="new mode-0600 packet path; existing files are refused")
    parser.add_argument(
        "--generated-at",
        help="honest ISO-8601 generation time; defaults to current UTC",
    )
    parser.add_argument("--pretty", action="store_true", help="indent packet JSON")
    args = parser.parse_args(argv)
    generated = (
        datetime.now(timezone.utc)
        if args.generated_at is None
        else _datetime(args.generated_at, "--generated-at")
    )
    packet = build_forecast_lab_packet(_read_json(args.manifest), generated_at=generated)
    _write_private_json(args.output, packet, pretty=args.pretty)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
