"""Compile immutable observation panels into Forecast Ensemble v2 manifests.

This bridge is deliberately research-only.  It derives a narrow, auditable
feature set from exact point-in-time price observations and records gaps as
abstentions instead of interpolating or accepting caller-authored features.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from hashlib import sha256
import json
from math import isfinite
from typing import Iterable, Mapping
from uuid import UUID

from .forecast_engine import DEFAULT_FORECAST_MODEL_VERSION, SHADOW_HORIZONS
from .market_pipeline import SourceTerms
from .observations import (
    PriceObservation,
    PriceSeriesKey,
    normalize_market_identity,
    point_in_time_series,
)
from .trends import build_trend_snapshot
from .walk_forward import HostedObservation


FORECAST_FEATURE_VERSION = "forecast-features-v2-observation-compiled-v1"
FORECAST_OBSERVATION_COMPILER_VERSION = "forecast-observation-compiler-v1"
TARGET_WINDOW_DAYS = 7
CANDIDATE_UNIVERSE_VERIFICATION = "unverified_expected_input_manifest_missing"
COMPILED_CELL_STATES = ("feature_abstained", "open", "scored", "unscorable")
COMPILED_PROMOTION_BLOCKERS = (
    "missing_independently_sealed_input_universe",
    "retrospective_compilation_not_prospective_evidence",
)


def _utc(value: datetime, name: str) -> datetime:
    if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() is None:
        raise ValueError(f"{name} must be a timezone-aware datetime")
    return value.astimezone(timezone.utc)


def _text(value: object, name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{name} must be non-empty")
    return value.strip()


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


def _canonical_hash(value: object) -> str:
    body = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return sha256(body.encode("utf-8")).hexdigest()


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


def _cohort_definition(game: str, key: PriceSeriesKey) -> dict[str, object]:
    return {
        "version": "forecast-cohort-v1",
        "game": normalize_market_identity(game),
        **_series_value(key),
    }


def canonical_forecast_cohort_key(game: str, key: PriceSeriesKey) -> str:
    """Derive the research cohort from canonical catalog and exact-series fields."""

    if not isinstance(key, PriceSeriesKey):
        raise ValueError("key must be a PriceSeriesKey")
    normalized_game = normalize_market_identity(_text(game, "game"))
    return f"forecast-cohort-v1:{_canonical_hash(_cohort_definition(normalized_game, key))}"


@dataclass(frozen=True, slots=True)
class ForecastPanelSeries:
    """One exact market series and its immutable hosted observation ledger."""

    key: PriceSeriesKey
    market_series_id: str
    market_series_identity_hash: str
    set_id: str
    game: str
    observations: tuple[HostedObservation, ...]

    def __post_init__(self) -> None:
        if not isinstance(self.key, PriceSeriesKey):
            raise ValueError("key must be a PriceSeriesKey")
        object.__setattr__(
            self, "market_series_id", _uuid(self.market_series_id, "market_series_id")
        )
        object.__setattr__(self, "market_series_identity_hash", _digest(
            self.market_series_identity_hash, "market_series_identity_hash",
        ))
        object.__setattr__(self, "set_id", _uuid(self.set_id, "set_id"))
        object.__setattr__(
            self, "game", normalize_market_identity(_text(self.game, "game")),
        )
        values = tuple(sorted(
            self.observations,
            key=lambda item: (item.observed_at, item.available_at, item.id),
        ))
        if not values or any(not isinstance(item, HostedObservation) for item in values):
            raise ValueError("observations must contain HostedObservation values")
        if len({item.id for item in values}) != len(values):
            raise ValueError("hosted observation IDs must be unique within a series")
        if any(item.key != self.key for item in values):
            raise ValueError("forecast panel observations cannot mix exact series identities")
        if any(item.market_series_id != self.market_series_id for item in values):
            raise ValueError("forecast panel observations cannot mix market-series IDs")
        accepted_at_instant: dict[tuple[datetime, datetime], tuple[float | None, float]] = {}
        for item in values:
            if item.observation_status != "accepted":
                continue
            instant = (item.observed_at, item.available_at)
            model_value = (item.market_price, item.quality_score)
            previous = accepted_at_instant.setdefault(instant, model_value)
            if previous != model_value:
                raise ValueError(
                    "forecast panel contains conflicting accepted observations at one "
                    "observed/available instant"
                )
        object.__setattr__(self, "observations", values)

    @property
    def variant_id(self) -> str:
        return self.key.canonical_variant_id

    @property
    def cohort_key(self) -> str:
        return canonical_forecast_cohort_key(self.game, self.key)

    @property
    def accepted_observations(self) -> tuple[PriceObservation, ...]:
        return tuple(
            converted
            for item in self.observations
            if (converted := item.accepted_price_observation()) is not None
        )

    def hash_value(self) -> dict[str, object]:
        return {
            "variantId": self.variant_id,
            "marketSeriesId": self.market_series_id,
            "marketSeriesIdentityHash": self.market_series_identity_hash,
            "setId": self.set_id,
            "game": self.game,
            "cohortKey": self.cohort_key,
            "cohortDefinition": _cohort_definition(self.game, self.key),
            "series": _series_value(self.key),
            "observations": [item.hash_value() for item in self.observations],
        }


@dataclass(frozen=True, slots=True)
class ForecastDatasetConfig:
    """Preregistered origins and policies for one research compiler run."""

    generated_at: datetime
    origins: tuple[datetime, ...]
    mapping_version: str
    code_version: str
    horizons: tuple[int, ...] = SHADOW_HORIZONS
    expected_interval_days: int = 1
    max_reference_lag_days: float = 3.0
    engine_policy: Mapping[str, object] = field(default_factory=dict)
    evaluation_policy: Mapping[str, object] = field(default_factory=dict)
    code_artifact_hash: str | None = None

    def __post_init__(self) -> None:
        generated = _utc(self.generated_at, "generated_at")
        object.__setattr__(self, "generated_at", generated)
        raw_origins = tuple(_utc(value, "origin") for value in self.origins)
        if not raw_origins:
            raise ValueError("origins must contain at least one timestamp")
        if len(set(raw_origins)) != len(raw_origins):
            raise ValueError("origins cannot contain duplicates")
        origins = tuple(sorted(raw_origins))
        if any(value > generated for value in origins):
            raise ValueError("forecast dataset origins cannot exceed generation time")
        object.__setattr__(self, "origins", origins)
        object.__setattr__(self, "mapping_version", _text(
            self.mapping_version, "mapping_version",
        ))
        object.__setattr__(self, "code_version", _text(self.code_version, "code_version"))
        raw_horizons = tuple(self.horizons)
        if len(set(raw_horizons)) != len(raw_horizons):
            raise ValueError("horizons cannot contain duplicates")
        horizons = tuple(sorted(raw_horizons))
        if not horizons or any(
            isinstance(value, bool) or not isinstance(value, int) or value not in SHADOW_HORIZONS
            for value in horizons
        ):
            raise ValueError(f"horizons must come from {SHADOW_HORIZONS}")
        object.__setattr__(self, "horizons", horizons)
        if (
            isinstance(self.expected_interval_days, bool)
            or not isinstance(self.expected_interval_days, int)
            or self.expected_interval_days < 1
        ):
            raise ValueError("expected_interval_days must be a positive integer")
        if (
            isinstance(self.max_reference_lag_days, bool)
            or not isfinite(self.max_reference_lag_days)
            or self.max_reference_lag_days < 0
        ):
            raise ValueError("max_reference_lag_days must be finite and non-negative")
        if not isinstance(self.engine_policy, Mapping) or not isinstance(
            self.evaluation_policy, Mapping
        ):
            raise ValueError("forecast dataset policies must be objects")
        object.__setattr__(self, "engine_policy", dict(self.engine_policy))
        object.__setattr__(self, "evaluation_policy", dict(self.evaluation_policy))
        code_hash = self.code_artifact_hash or _canonical_hash({
            "codeVersion": self.code_version,
        })
        if len(code_hash) != 64 or any(value not in "0123456789abcdef" for value in code_hash):
            raise ValueError("code_artifact_hash must be a SHA-256 digest")
        object.__setattr__(self, "code_artifact_hash", code_hash)

    def hash_value(self) -> dict[str, object]:
        return {
            "generatedAt": self.generated_at.isoformat(),
            "origins": [value.isoformat() for value in self.origins],
            "horizons": list(self.horizons),
            "mappingVersion": self.mapping_version,
            "codeVersion": self.code_version,
            "codeArtifactSha256": self.code_artifact_hash,
            "expectedIntervalDays": self.expected_interval_days,
            "maxReferenceLagDays": self.max_reference_lag_days,
            "enginePolicy": dict(self.engine_policy),
            "evaluationPolicy": dict(self.evaluation_policy),
        }


def _assert_research_rights(terms: SourceTerms, generated_at: datetime) -> None:
    if not isinstance(terms, SourceTerms):
        raise ValueError("terms must be SourceTerms")
    if not terms.permits_research_ingestion(generated_at):
        raise PermissionError("source terms do not permit research at generation time")


def _abstention(
    panel: ForecastPanelSeries,
    origin: datetime,
    horizon: int,
    reasons: str | Iterable[str],
) -> dict[str, object]:
    values = (reasons,) if isinstance(reasons, str) else tuple(reasons)
    reason_codes = tuple(dict.fromkeys(_text(value, "reason") for value in values))
    if not reason_codes:
        raise ValueError("abstention requires at least one reason")
    return {
        "variantId": panel.variant_id,
        "marketSeriesId": panel.market_series_id,
        "origin": origin.isoformat(),
        "horizonDays": horizon,
        "reasonCodes": list(reason_codes),
    }


def _feature_row(
    panel: ForecastPanelSeries,
    origin: datetime,
    horizon: int,
    config: ForecastDatasetConfig,
) -> tuple[dict[str, object] | None, tuple[str, ...]]:
    accepted = panel.accepted_observations
    known = point_in_time_series(accepted, origin, key=panel.key)
    if not known:
        return None, ("no_point_in_time_feature_observation",)
    snapshot = build_trend_snapshot(
        accepted,
        origin,
        key=panel.key,
        expected_interval_days=config.expected_interval_days,
        max_reference_lag_days=config.max_reference_lag_days,
    )
    history_seconds = (known[-1].observed_at - known[0].observed_at).total_seconds()
    history_days = max(0, int(history_seconds // 86_400))
    latest_availability = max(item.available_at for item in known)
    missing: list[str] = []
    if snapshot.robust_slope_90d is None:
        missing.append("missing_required_robust_slope_90d")
    if snapshot.volatility_90d is None:
        missing.append("missing_required_volatility_90d")
    if missing:
        return None, tuple(missing)
    return {
        "variantId": panel.variant_id,
        "setId": panel.set_id,
        "cohortKey": panel.cohort_key,
        "origin": origin.isoformat(),
        "horizonDays": horizon,
        "currentPrice": snapshot.current_price,
        "marketSeriesId": panel.market_series_id,
        "series": _series_value(panel.key),
        "features": {
            "robustDailyLogSlope": snapshot.robust_slope_90d,
            "volatilityDaily": snapshot.volatility_90d,
            "evidenceQuality": snapshot.evidence_quality,
            "historyDays": history_days,
            "marketDailyLogSlope": None,
            "lifecycleLogReturn30d": None,
            "lifecycleLogReturn90d": None,
            "structuralMedianPrice": None,
            "structuralLowerPrice": None,
            "demandAcceleration": None,
            "demandNormalizationVersion": None,
            "reprintRisk": None,
            "featureTimestamps": [latest_availability.isoformat()],
        },
    }, ()


def _target_observations(
    panel: ForecastPanelSeries,
    maturity: datetime,
    *,
    expected_interval_days: int,
) -> tuple[list[dict[str, object]], tuple[str, ...], dict[str, object]]:
    known = point_in_time_series(
        panel.accepted_observations, maturity, key=panel.key,
    )
    window_start = maturity - timedelta(days=TARGET_WINDOW_DAYS - 1)
    values = [
        item for item in known
        if window_start <= item.observed_at <= maturity
        and item.available_at <= maturity
    ]
    expected_date_count = (
        (maturity.date() - window_start.date()).days // expected_interval_days + 1
    )
    observed_dates = sorted({item.observed_at.date() for item in values})
    coverage = min(1.0, len(observed_dates) / expected_date_count)
    maximum_gap_days = None
    reasons: list[str] = []
    if not values:
        reasons.append("missing_maturity_window_label")
    else:
        boundaries = [window_start.date(), *observed_dates, maturity.date()]
        maximum_gap_days = max(
            (right - left).days for left, right in zip(boundaries, boundaries[1:])
        )
        if len(observed_dates) < expected_date_count:
            reasons.append("incomplete_maturity_window_coverage")
        if maximum_gap_days > expected_interval_days:
            reasons.append("maturity_window_gap_exceeds_policy")
    audit = {
        "windowDays": TARGET_WINDOW_DAYS,
        "expectedIntervalDays": expected_interval_days,
        "expectedDateCount": expected_date_count,
        "observedDateCount": len(observed_dates),
        "coverage": coverage,
        "maximumGapDays": maximum_gap_days,
    }
    observations = [
        {
            "id": _uuid(item.source_observation_id, "target observation ID"),
            "observedAt": item.observed_at.isoformat(),
            "availableAt": item.available_at.isoformat(),
            "price": item.price,
            "quality": item.quality,
        }
        for item in values
    ]
    return observations, tuple(reasons), audit


def compile_forecast_dataset(
    panels: Iterable[ForecastPanelSeries],
    terms: SourceTerms,
    config: ForecastDatasetConfig,
) -> Mapping[str, object]:
    """Return a deterministic, Forecast-Lab-compatible private manifest."""

    if not isinstance(config, ForecastDatasetConfig):
        raise ValueError("config must be ForecastDatasetConfig")
    _assert_research_rights(terms, config.generated_at)
    raw_values = tuple(panels)
    if not raw_values or any(not isinstance(item, ForecastPanelSeries) for item in raw_values):
        raise ValueError("panels must contain ForecastPanelSeries values")
    values = tuple(sorted(raw_values, key=lambda item: item.market_series_id))
    if len({item.market_series_id for item in values}) != len(values):
        raise ValueError("forecast panels require unique market-series IDs")
    if len({item.variant_id for item in values}) != len(values):
        raise ValueError("forecast panels require one exact market series per variant")
    observation_ids = [item.id for panel in values for item in panel.observations]
    if len(set(observation_ids)) != len(observation_ids):
        raise ValueError("forecast panels cannot reuse observation IDs across series")
    if any(item.key.source_id != terms.source_id for item in values):
        raise ValueError("forecast panel source differs from the reviewed source terms")
    if any(
        observation.available_at > config.generated_at
        for panel in values
        for observation in panel.observations
    ):
        raise ValueError("forecast panel contains an observation unavailable at generation time")
    cohort_identities = {
        (
            item.cohort_key,
            item.game,
            item.key.source_id,
            item.key.currency,
            item.key.language,
            item.key.finish,
            item.key.condition_class,
            item.key.market_condition,
            item.key.price_semantics,
        )
        for item in values
    }
    if len(cohort_identities) != 1:
        raise ValueError("forecast panels cannot mix incompatible cohort identities")

    status_counts = Counter(
        item.observation_status for panel in values for item in panel.observations
    )
    compiler_config = config.hash_value()
    input_value = {
        "compilerVersion": FORECAST_OBSERVATION_COMPILER_VERSION,
        "sourcePolicyHash": terms.policy_hash,
        "sourceId": terms.source_id,
        "termsReviewId": terms.terms_review_id,
        "compilerCodeArtifactSha256": config.code_artifact_hash,
        "config": compiler_config,
        "series": [item.hash_value() for item in values],
    }
    input_hash = _canonical_hash(input_value)
    declared_members = [
        {
            "variantId": item.variant_id,
            "marketSeriesId": item.market_series_id,
            "marketSeriesIdentityHash": item.market_series_identity_hash,
            "setId": item.set_id,
            "game": item.game,
            "cohortKey": item.cohort_key,
            "series": _series_value(item.key),
        }
        for item in values
    ]
    declared_panel_hash = _canonical_hash(declared_members)
    declared_origins = [value.isoformat() for value in config.origins]
    declared_horizons = list(config.horizons)
    declared_grid_hash = _canonical_hash({
        "declaredMembers": declared_members,
        "declaredOrigins": declared_origins,
        "declaredHorizons": declared_horizons,
    })

    examples: list[dict[str, object]] = []
    targets: list[dict[str, object]] = []
    abstentions: list[dict[str, object]] = []
    cell_ledger: list[dict[str, object]] = []
    state_counts: Counter[str] = Counter()
    for origin in config.origins:
        for horizon in config.horizons:
            maturity = origin + timedelta(days=horizon)
            for panel in values:
                row, feature_reasons = _feature_row(panel, origin, horizon, config)
                cell: dict[str, object] = {
                    "variantId": panel.variant_id,
                    "marketSeriesId": panel.market_series_id,
                    "marketSeriesIdentityHash": panel.market_series_identity_hash,
                    "setId": panel.set_id,
                    "game": panel.game,
                    "cohortKey": panel.cohort_key,
                    "series": _series_value(panel.key),
                    "origin": origin.isoformat(),
                    "horizonDays": horizon,
                    "maturityAt": maturity.isoformat(),
                }
                if row is None:
                    abstentions.append(_abstention(panel, origin, horizon, feature_reasons))
                    state = "feature_abstained"
                    cell["reasonCodes"] = list(feature_reasons)
                elif maturity > config.generated_at:
                    state = "open"
                    cell["reasonCodes"] = []
                    targets.append(row)
                    cell["compiledRowSha256"] = _canonical_hash(row)
                else:
                    labels, label_reasons, coverage = _target_observations(
                        panel,
                        maturity,
                        expected_interval_days=config.expected_interval_days,
                    )
                    cell["targetWindow"] = coverage
                    if label_reasons:
                        abstentions.append(_abstention(
                            panel, origin, horizon, label_reasons,
                        ))
                        state = "unscorable"
                        cell["reasonCodes"] = list(label_reasons)
                    else:
                        state = "scored"
                        cell["reasonCodes"] = []
                        row["targetObservations"] = labels
                        examples.append(row)
                        cell["compiledRowSha256"] = _canonical_hash(row)
                cell["state"] = state
                state_counts[state] += 1
                cell_ledger.append(cell)

    examples.sort(key=lambda row: (
        row["origin"], row["horizonDays"], row["marketSeriesId"],
    ))
    targets.sort(key=lambda row: (
        row["origin"], row["horizonDays"], row["marketSeriesId"],
    ))
    abstentions.sort(key=lambda row: (
        row["origin"], row["horizonDays"], row["marketSeriesId"],
    ))
    feature_hash = _canonical_hash({"examples": examples, "targets": targets})
    audit: dict[str, object] = {
        "compilerVersion": FORECAST_OBSERVATION_COMPILER_VERSION,
        "inputDatasetSha256": input_hash,
        "featureDatasetSha256": feature_hash,
        "compilerCodeArtifactSha256": config.code_artifact_hash,
        "sourcePolicySha256": terms.policy_hash,
        "sourceId": terms.source_id,
        "termsReviewId": terms.terms_review_id,
        "compiledAt": config.generated_at.isoformat(),
        "inputCutoffAt": config.generated_at.isoformat(),
        "compilerConfig": compiler_config,
        "compilerConfigSha256": _canonical_hash(compiler_config),
        "declaredSeriesCount": len(values),
        "declaredMembers": declared_members,
        "declaredPanelSha256": declared_panel_hash,
        "declaredGridSha256": declared_grid_hash,
        "declaredOrigins": declared_origins,
        "declaredHorizons": declared_horizons,
        "declaredOriginCount": len(config.origins),
        "expectedCellCount": len(values) * len(config.origins) * len(config.horizons),
        "cellStateCounts": {
            state: state_counts[state] for state in COMPILED_CELL_STATES
        },
        "cells": cell_ledger,
        "cellLedgerSha256": _canonical_hash(cell_ledger),
        "canonicalCohortKey": values[0].cohort_key,
        "cohortDefinition": _cohort_definition(values[0].game, values[0].key),
        "universeCompleteness": "declared_only",
        "evidenceTiming": "retrospective",
        "prospectiveEvidenceEligible": False,
        "catalogMetadataAuthority": "caller_declared_export",
        "promotionBlockReasonCodes": list(COMPILED_PROMOTION_BLOCKERS),
        "candidateUniverseVerification": CANDIDATE_UNIVERSE_VERIFICATION,
        "candidateUniverseIdsIssued": False,
        "targetWindowPolicy": {
            "windowDays": TARGET_WINDOW_DAYS,
            "expectedIntervalDays": config.expected_interval_days,
            "minimumCoverage": 1.0,
            "maximumGapDays": config.expected_interval_days,
        },
        "observationStatusCounts": dict(sorted(status_counts.items())),
        "abstentions": abstentions,
        "publicPublicationAllowed": False,
    }
    audit["auditSha256"] = _canonical_hash(audit)
    return {
        "mode": "research_only",
        "lineage": {
            "datasetSha256": input_hash,
            "codeVersion": config.code_version,
            "featureVersion": FORECAST_FEATURE_VERSION,
            "mappingVersion": config.mapping_version,
            "modelVersion": DEFAULT_FORECAST_MODEL_VERSION,
        },
        "featureDatasetSha256": feature_hash,
        "enginePolicy": dict(config.engine_policy),
        "evaluationPolicy": dict(config.evaluation_policy),
        "examples": examples,
        "targets": targets,
        "compilerAudit": audit,
        "publicCandidateRows": [],
        "publicPublicationAllowed": False,
    }
