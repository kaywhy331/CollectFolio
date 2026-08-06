"""Honest, private-only retrospective walk-forward forecast evidence."""

from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from hashlib import sha256
import json
from math import erf, exp, isfinite, log, sqrt
from typing import Iterable, Mapping
from uuid import UUID, uuid5

from .baselines import damped_momentum, no_change
from .evaluation import (
    ForecastCase,
    ResearchLineage,
    WalkForwardAudit,
    evaluate_cases,
    realized_price_at_maturity,
)
from .forecasting import (
    NORMAL_QUANTILES,
    PromotionPolicy,
    ResearchForecastPrediction,
    ResearchModelCard,
    assess_research_scorecard,
)
from .market_pipeline import SourceTerms
from .observations import PriceObservation, PriceSeriesKey, point_in_time_series
from .trends import TrendSnapshot, build_trend_snapshot


LEDGER_STATUSES = {"accepted", "missing", "outlier", "quarantined"}
SIMULATION_MODE = "retrospective_walk_forward"


def _canonical_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _hash(value: object) -> str:
    return sha256(_canonical_json(value).encode("utf-8")).hexdigest()


def _utc(value: datetime, name: str) -> datetime:
    if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() is None:
        raise ValueError(f"{name} must be timezone-aware")
    return value.astimezone(timezone.utc)


def _parse_datetime(value: object, name: str) -> datetime:
    if isinstance(value, datetime):
        return _utc(value, name)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{name} must be an ISO-8601 datetime")
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(f"{name} must be an ISO-8601 datetime") from exc
    return _utc(parsed, name)


def _uuid(value: object, name: str) -> str:
    try:
        return str(UUID(str(value)))
    except (TypeError, ValueError, AttributeError) as exc:
        raise ValueError(f"{name} must be a UUID") from exc


def _positive(value: object, name: str) -> float:
    if isinstance(value, bool):
        raise ValueError(f"{name} must be finite and positive")
    try:
        numeric = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} must be finite and positive") from exc
    if not isfinite(numeric) or numeric <= 0:
        raise ValueError(f"{name} must be finite and positive")
    return numeric


def _probability(value: object, name: str) -> float:
    if isinstance(value, bool):
        raise ValueError(f"{name} must be between zero and one")
    try:
        numeric = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} must be between zero and one") from exc
    if not isfinite(numeric) or not 0 <= numeric <= 1:
        raise ValueError(f"{name} must be between zero and one")
    return numeric


def _required_text(value: object, name: str) -> str:
    text = str(value or "").strip()
    if not text:
        raise ValueError(f"{name} must be non-empty")
    return text


def _deterministic_id(key: PriceSeriesKey, label: str) -> str:
    namespace = UUID(key.canonical_variant_id)
    return str(uuid5(namespace, f"collectfolio:{key.source_id}:{label}"))


@dataclass(frozen=True, slots=True)
class HostedObservation:
    """One immutable hosted ledger row, including rows excluded from features."""

    id: str
    key: PriceSeriesKey
    observation_status: str
    observed_at: datetime
    available_at: datetime
    market_price: float | None
    quality_score: float
    external_record_id: str
    reason_codes: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        object.__setattr__(self, "id", _uuid(self.id, "observation id"))
        if not isinstance(self.key, PriceSeriesKey):
            raise ValueError("key must be a PriceSeriesKey")
        if self.observation_status not in LEDGER_STATUSES:
            raise ValueError(f"observation_status must be one of {sorted(LEDGER_STATUSES)}")
        observed_at = _utc(self.observed_at, "observed_at")
        available_at = _utc(self.available_at, "available_at")
        if available_at < observed_at:
            raise ValueError("available_at cannot precede observed_at")
        object.__setattr__(self, "observed_at", observed_at)
        object.__setattr__(self, "available_at", available_at)
        if self.market_price is not None:
            object.__setattr__(self, "market_price", _positive(self.market_price, "market_price"))
        if self.observation_status == "accepted" and self.market_price is None:
            raise ValueError("accepted observations require market_price")
        object.__setattr__(self, "quality_score", _probability(self.quality_score, "quality_score"))
        object.__setattr__(self, "external_record_id", _required_text(
            self.external_record_id, "external_record_id"
        ))
        reasons = tuple(_required_text(value, "reason_code") for value in self.reason_codes)
        object.__setattr__(self, "reason_codes", reasons)

    def accepted_price_observation(self) -> PriceObservation | None:
        if self.observation_status != "accepted":
            return None
        return PriceObservation(
            key=self.key,
            observed_at=self.observed_at,
            available_at=self.available_at,
            price=self.market_price,
            quality=self.quality_score,
            source_observation_id=self.id,
        )

    def hash_value(self) -> Mapping[str, object]:
        return {
            "id": self.id,
            "status": self.observation_status,
            "observedAt": self.observed_at.isoformat(),
            "availableAt": self.available_at.isoformat(),
            "marketPrice": self.market_price,
            "qualityScore": self.quality_score,
            "externalRecordId": self.external_record_id,
            "reasonCodes": list(self.reason_codes),
        }


def parse_hosted_observation_rows(
    rows: Iterable[Mapping[str, object]],
    key: PriceSeriesKey,
) -> tuple[HostedObservation, ...]:
    """Parse a bounded database export while enforcing one exact price series."""

    if not isinstance(key, PriceSeriesKey):
        raise ValueError("key must be a PriceSeriesKey")
    values: list[HostedObservation] = []
    for index, row in enumerate(rows):
        if not isinstance(row, Mapping):
            raise ValueError(f"observation row {index} must be an object")
        if str(row.get("currency", "")).upper() != key.currency:
            raise ValueError(f"observation row {index} currency does not match the series")
        if str(row.get("price_semantics", "")).lower() != key.price_semantics:
            raise ValueError(f"observation row {index} price semantics do not match the series")
        reasons = row.get("reason_codes", ())
        if not isinstance(reasons, (list, tuple)):
            raise ValueError(f"observation row {index} reason_codes must be an array")
        values.append(HostedObservation(
            id=row.get("id"),
            key=key,
            observation_status=str(row.get("observation_status", "")),
            observed_at=_parse_datetime(row.get("observed_at"), f"row {index} observed_at"),
            available_at=_parse_datetime(row.get("available_at"), f"row {index} available_at"),
            market_price=row.get("market_price"),
            quality_score=row.get("quality_score"),
            external_record_id=str(row.get("external_record_id", "")),
            reason_codes=tuple(str(value) for value in reasons),
        ))
    ordered = tuple(sorted(values, key=lambda item: (item.observed_at, item.available_at, item.id)))
    if not ordered:
        raise ValueError("at least one hosted observation is required")
    if len({item.id for item in ordered}) != len(ordered):
        raise ValueError("hosted observation IDs must be unique")
    return ordered


@dataclass(frozen=True, slots=True)
class RetrospectiveWalkForwardConfig:
    model_key: str
    model_version: str
    model_family: str
    allowed_horizons: tuple[int, ...]
    mapping_version: str
    feature_version: str
    code_version: str
    generated_at: datetime
    model_config: Mapping[str, object]
    cohort_key: str = "tcgcsv_30d_origins_accepted_research_only_v2"
    expected_interval_days: int = 7
    max_reference_lag_days: float = 7.0
    origin_spacing_days: int = 30
    promotion_policy: PromotionPolicy = PromotionPolicy()
    code_artifact_hash: str | None = None

    def __post_init__(self) -> None:
        for name in (
            "model_key", "model_version", "model_family", "mapping_version",
            "feature_version", "code_version", "cohort_key",
        ):
            object.__setattr__(self, name, _required_text(getattr(self, name), name))
        if len(self.cohort_key) > 200:
            raise ValueError("cohort_key cannot exceed 200 characters")
        object.__setattr__(self, "generated_at", _utc(self.generated_at, "generated_at"))
        if not isinstance(self.model_config, Mapping):
            raise ValueError("model_config must be an object")
        object.__setattr__(self, "model_config", dict(self.model_config))
        if (
            isinstance(self.expected_interval_days, bool)
            or not isinstance(self.expected_interval_days, int)
            or self.expected_interval_days <= 0
        ):
            raise ValueError("expected_interval_days must be a positive integer")
        if (
            isinstance(self.max_reference_lag_days, bool)
            or not isfinite(self.max_reference_lag_days)
            or self.max_reference_lag_days < 0
        ):
            raise ValueError("max_reference_lag_days must be finite and non-negative")
        if (
            isinstance(self.origin_spacing_days, bool)
            or not isinstance(self.origin_spacing_days, int)
            or self.origin_spacing_days <= 0
        ):
            raise ValueError("origin_spacing_days must be a positive integer")
        if not isinstance(self.promotion_policy, PromotionPolicy):
            raise ValueError("promotion_policy must be a PromotionPolicy")
        code_hash = self.code_artifact_hash or _hash({"codeVersion": self.code_version})
        if len(code_hash) != 64 or any(value not in "0123456789abcdef" for value in code_hash):
            raise ValueError("code_artifact_hash must be a SHA-256 digest")
        object.__setattr__(self, "code_artifact_hash", code_hash)


@dataclass(frozen=True, slots=True)
class RetrospectiveWalkForwardEvidence:
    generated_at: datetime
    ledger_hash: str
    ledger_status_counts: Mapping[str, int]
    model_row: Mapping[str, object]
    analytics_run_rows: tuple[Mapping[str, object], ...]
    analytics_run_source_rows: tuple[Mapping[str, object], ...]
    trend_snapshot_rows: tuple[Mapping[str, object], ...]
    prediction_rows: tuple[Mapping[str, object], ...]
    evaluation_rows: tuple[Mapping[str, object], ...]
    scorecard_rows: tuple[Mapping[str, object], ...]
    scorecard_evaluation_rows: tuple[Mapping[str, object], ...]
    unscorable_matured_targets: int
    packet_hash: str

    @property
    def skipped_matured_targets(self) -> int:
        """Compatibility alias for schema-v1 packet consumers."""

        return self.unscorable_matured_targets

    @property
    def gate_status(self) -> Mapping[str, str]:
        return {
            "sourceRights": "research_only",
            "simulationMode": SIMULATION_MODE,
            "predictions": "research_only",
            "evaluations": "private_only",
            "scorecards": "operator_evidence_only",
            "modelReview": "required",
            "publicPublication": "blocked",
        }

    def as_dict(self) -> Mapping[str, object]:
        return {
            "schemaVersion": 2,
            "mode": "research_only",
            "simulationMode": SIMULATION_MODE,
            "generatedAt": self.generated_at.isoformat(),
            "sourcePermissionCheckedAt": self.generated_at.isoformat(),
            "inputLedger": {
                "ledgerHash": self.ledger_hash,
                "statusCounts": dict(self.ledger_status_counts),
                "outliersPreservedAndExcludedFromFeatures": True,
            },
            "modelRow": dict(self.model_row),
            "analyticsRunRows": list(self.analytics_run_rows),
            "analyticsRunSourceRows": list(self.analytics_run_source_rows),
            "trendSnapshotRows": list(self.trend_snapshot_rows),
            "predictionRows": list(self.prediction_rows),
            "evaluationRows": list(self.evaluation_rows),
            "scorecardRows": list(self.scorecard_rows),
            "scorecardEvaluationRows": list(self.scorecard_evaluation_rows),
            "promotionReviewRows": [],
            "publicCandidateRows": [],
            "unscorableMaturedTargets": self.unscorable_matured_targets,
            "skippedMaturedTargets": self.unscorable_matured_targets,
            "gateStatus": dict(self.gate_status),
            "packetHash": self.packet_hash,
        }


def _assert_generation_rights(terms: SourceTerms, generated_at: datetime) -> None:
    if not terms.permits_research_ingestion(generated_at) or terms.reviewed_at > generated_at:
        raise PermissionError("source terms do not permit research at generation time")
    if (
        terms.decision != "research_only"
        or terms.commercial_use_allowed
        or terms.catalog_metadata_allowed
        or terms.public_raw_display_allowed
        or terms.public_derived_display_allowed
    ):
        raise PermissionError("retrospective evidence requires closed research-only source rights")


def _normal_probability_up(mean_log_return: float, sigma: float) -> float:
    if sigma <= 0:
        return 0.5 if mean_log_return == 0 else float(mean_log_return > 0)
    return 0.5 * (1 + erf(mean_log_return / (sigma * sqrt(2))))


def _trend_row(
    snapshot: TrendSnapshot,
    *,
    snapshot_id: str,
    analytics_run_id: str,
    terms: SourceTerms,
) -> Mapping[str, object]:
    trend_state = "insufficient" if snapshot.trend_state == "insufficient_data" else snapshot.trend_state
    reasons = [
        SIMULATION_MODE,
        "not_prospectively_generated",
        "point_in_time_features",
        "research_only_source",
    ]
    if trend_state == "insufficient":
        reasons.append("insufficient_trend_evidence")
    hash_values = {
        "analytics_run_id": analytics_run_id,
        "variant_id": snapshot.key.canonical_variant_id,
        "source_id": terms.source_id,
        "terms_review_id": terms.terms_review_id,
        "feature_cutoff": snapshot.feature_cutoff.isoformat(),
        "latest_observed_at": snapshot.latest_observed_at.isoformat(),
        "price_current": snapshot.current_price,
        "return_7d": snapshot.return_7d,
        "return_30d": snapshot.return_30d,
        "return_90d": snapshot.return_90d,
        "return_180d": snapshot.return_180d,
        "return_365d": snapshot.return_365d,
        "robust_slope_30d": snapshot.robust_slope_30d,
        "robust_slope_90d": snapshot.robust_slope_90d,
        "momentum_acceleration": snapshot.momentum_acceleration,
        "volatility_30d": snapshot.volatility_30d,
        "volatility_90d": snapshot.volatility_90d,
        "max_drawdown_180d": snapshot.max_drawdown_180d,
        "history_density_90d": snapshot.history_density_90d,
        "staleness_hours": snapshot.staleness_hours,
        "source_quality_90d": snapshot.source_quality_90d,
        "evidence_quality": snapshot.evidence_quality,
        "slope_z_90d": snapshot.slope_z_90d,
        "trend_state": trend_state,
        "observation_count_90d": snapshot.observation_count_90d,
        "reason_codes": reasons,
    }
    row = dict(hash_values)
    row.pop("latest_observed_at")
    return {"id": snapshot_id, **row, "snapshot_hash": _hash(hash_values)}


def _run_row(
    *,
    run_id: str,
    run_kind: str,
    feature_cutoff: datetime,
    generated_at: datetime,
    dataset_hash: str,
    terms: SourceTerms,
    config: RetrospectiveWalkForwardConfig,
    run_config: Mapping[str, object],
    records_read: int,
    records_written: int,
    records_quarantined: int,
) -> Mapping[str, object]:
    return {
        "id": run_id,
        "run_kind": run_kind,
        "status": "succeeded" if records_quarantined == 0 else "partial",
        "feature_cutoff": feature_cutoff.isoformat(),
        "started_at": generated_at.isoformat(),
        "completed_at": generated_at.isoformat(),
        "dataset_hash": dataset_hash,
        "source_policy_hash": terms.policy_hash,
        "mapping_version": config.mapping_version,
        "feature_version": config.feature_version,
        "code_version": config.code_version,
        "config_hash": _hash(run_config),
        "config": dict(run_config),
        "records_read": records_read,
        "records_written": records_written,
        "records_quarantined": records_quarantined,
        "error_summary": None,
    }


def _forecast_prediction(
    *,
    model: ResearchModelCard,
    snapshot: TrendSnapshot,
    terms: SourceTerms,
    analytics_run_id: str,
    trend_snapshot_id: str,
    origin: datetime,
    horizon_days: int,
    feature_dataset_hash: str,
) -> ResearchForecastPrediction:
    damping = float(model.config.get("damping", 0.25))
    max_return = float(model.config.get("maxAbsLogReturn", 0.70))
    max_interval = float(model.config.get("maxIntervalLogWidth", 1.50))
    if not 0 <= damping <= 1 or max_return <= 0 or max_interval <= 0:
        raise ValueError("model config contains invalid forecast bounds")
    reasons = [
        "baseline_only",
        "static_baseline_no_training",
        "uncalibrated_interval",
        SIMULATION_MODE,
        "not_prospectively_generated",
        "source_rights_checked_at_generation",
        "operator_model_review_required",
    ]
    status = "research_only"
    if model.model_family == "no_change_baseline":
        forecast = no_change(snapshot.current_price, horizon_days)
    elif snapshot.robust_slope_90d is None:
        forecast = no_change(snapshot.current_price, horizon_days)
        status = "quarantined"
        reasons.append("missing_robust_slope")
    else:
        forecast = damped_momentum(
            snapshot.current_price,
            horizon_days,
            snapshot.robust_slope_90d,
            damping=damping,
            max_abs_log_return=max_return,
        )
    if snapshot.volatility_90d is None or snapshot.volatility_90d <= 0:
        sigma = 0.0
        status = "quarantined"
        reasons.append("missing_positive_volatility")
    else:
        sigma = min(max_interval, snapshot.volatility_90d * sqrt(horizon_days))
    quantiles = {
        probability: forecast.median_price * exp(z_score * sigma)
        for probability, z_score in NORMAL_QUANTILES.items()
    }
    return ResearchForecastPrediction(
        analytics_run_id=analytics_run_id,
        model=model,
        trend_snapshot_id=trend_snapshot_id,
        snapshot=snapshot,
        terms=terms,
        origin=origin,
        horizon_days=horizon_days,
        quantiles=quantiles,
        probability_up=_normal_probability_up(forecast.predicted_log_return, sigma),
        confidence=(
            min(49.0, max(0.0, snapshot.evidence_quality * 100))
            if status == "research_only" else 0.0
        ),
        prediction_status=status,
        reason_codes=tuple(reasons),
        feature_dataset_hash=feature_dataset_hash,
    )


def _spaced_origins(values: Iterable[datetime], spacing_days: int) -> tuple[datetime, ...]:
    selected: list[datetime] = []
    minimum_gap = timedelta(days=spacing_days)
    for value in sorted(set(values)):
        if not selected or value - selected[-1] >= minimum_gap:
            selected.append(value)
    return tuple(selected)


def _direction(value: float, tolerance: float = 1e-12) -> int:
    return 1 if value > tolerance else -1 if value < -tolerance else 0


def _pinball(actual: float, predicted: float, probability: float) -> float:
    residual = actual - predicted
    return probability * residual if residual >= 0 else (probability - 1) * residual


def _summary_metrics(summary: object) -> Mapping[str, object]:
    return {
        "count": summary.count,
        "maeLogReturn": summary.mae_log_return,
        "medianAbsolutePercentageError": summary.median_absolute_percentage_error,
        "symmetricMape": summary.symmetric_mape,
        "medianAbsoluteDollarError": summary.median_absolute_dollar_error,
        "directionAccuracy": summary.direction_accuracy,
        "directionAccuracy10Percent": summary.direction_accuracy_10_percent,
        "directionAccuracy25Percent": summary.direction_accuracy_25_percent,
        "baselineRelativeLift": summary.baseline_relative_lift,
        "brierScore": summary.brier_score,
        "probabilityCalibrationError": summary.probability_calibration_error,
        "pinballLoss": (
            {f"{key:.2f}": value for key, value in summary.pinball_loss.items()}
            if summary.pinball_loss is not None else None
        ),
        "interval50Coverage": summary.interval_50_coverage,
        "interval80Coverage": summary.interval_80_coverage,
        "meanInterval50Width": summary.mean_interval_50_width,
        "meanInterval80Width": summary.mean_interval_80_width,
    }


def _empty_summary_metrics() -> Mapping[str, object]:
    return {
        "count": 0,
        "maeLogReturn": None,
        "medianAbsolutePercentageError": None,
        "symmetricMape": None,
        "medianAbsoluteDollarError": None,
        "directionAccuracy": None,
        "directionAccuracy10Percent": None,
        "directionAccuracy25Percent": None,
        "baselineRelativeLift": None,
        "brierScore": None,
        "probabilityCalibrationError": None,
        "pinballLoss": None,
        "interval50Coverage": None,
        "interval80Coverage": None,
        "meanInterval50Width": None,
        "meanInterval80Width": None,
    }


def build_retrospective_walk_forward(
    ledger: Iterable[HostedObservation],
    terms: SourceTerms,
    config: RetrospectiveWalkForwardConfig,
) -> RetrospectiveWalkForwardEvidence:
    """Build simulated historical predictions without claiming prospective origin."""

    if not isinstance(terms, SourceTerms):
        raise ValueError("terms must be SourceTerms")
    if not isinstance(config, RetrospectiveWalkForwardConfig):
        raise ValueError("config must be RetrospectiveWalkForwardConfig")
    _assert_generation_rights(terms, config.generated_at)
    values = tuple(sorted(ledger, key=lambda item: (item.observed_at, item.available_at, item.id)))
    if not values or any(not isinstance(item, HostedObservation) for item in values):
        raise ValueError("at least one HostedObservation is required")
    keys = {item.key for item in values}
    if len(keys) != 1:
        raise ValueError("walk-forward evidence cannot mix exact price-series identities")
    key = values[0].key
    if key.source_id != terms.source_id:
        raise ValueError("observation source does not match source terms")
    if any(item.available_at > config.generated_at for item in values):
        raise ValueError("hosted ledger contains observations unavailable at generation time")

    accepted = tuple(
        observation
        for item in values
        if (observation := item.accepted_price_observation()) is not None
    )
    if not accepted:
        raise ValueError("walk-forward evidence requires accepted observations")
    ledger_hash = _hash([item.hash_value() for item in values])
    status_counts = {name: count for name, count in sorted(Counter(
        item.observation_status for item in values
    ).items())}
    model_definition = {
        "simulationMode": SIMULATION_MODE,
        "trainingMode": "none_static_baseline",
        "modelKey": config.model_key,
        "modelVersion": config.model_version,
        "modelFamily": config.model_family,
        "allowedHorizons": sorted(set(config.allowed_horizons)),
        "config": dict(config.model_config),
        "codeArtifactHash": config.code_artifact_hash,
    }
    model_definition_hash = _hash(model_definition)
    lineage = ResearchLineage(
        dataset_sha256=model_definition_hash,
        code_version=config.code_version,
        feature_version=config.feature_version,
        mapping_version=config.mapping_version,
        model_version=config.model_version,
    )
    model = ResearchModelCard(
        id=_deterministic_id(key, f"retrospective-model:{config.model_key}:{config.model_version}"),
        model_key=config.model_key,
        version=config.model_version,
        model_family=config.model_family,
        lineage=lineage,
        allowed_horizons=config.allowed_horizons,
        created_at=config.generated_at,
        config={
            **dict(config.model_config),
            "simulationMode": SIMULATION_MODE,
            "trainingMode": "none_static_baseline",
            "researchOnly": True,
            "expectedIntervalDays": config.expected_interval_days,
            "maxReferenceLagDays": config.max_reference_lag_days,
            "originSpacingDays": config.origin_spacing_days,
            "codeArtifactHash": config.code_artifact_hash,
            "modelDefinition": model_definition,
        },
        training_mode="none_static_baseline",
        model_definition_hash=model_definition_hash,
        training_dataset_hash=None,
        model_artifact_hash=config.code_artifact_hash,
    )

    run_rows: list[Mapping[str, object]] = []
    source_rows: list[Mapping[str, object]] = []
    trend_rows: list[Mapping[str, object]] = []
    prediction_rows: list[Mapping[str, object]] = []
    evaluation_rows: list[Mapping[str, object]] = []
    cases_by_horizon: dict[int, list[ForecastCase]] = defaultdict(list)
    matured_by_horizon: dict[int, list[Mapping[str, object]]] = defaultdict(list)
    unscorable_targets = 0
    origins = _spaced_origins(
        (item.available_at for item in values if item.observation_status == "accepted"),
        config.origin_spacing_days,
    )

    for origin in origins:
        known = point_in_time_series(accepted, origin, key=key)
        snapshot = build_trend_snapshot(
            accepted,
            origin,
            key=key,
            expected_interval_days=config.expected_interval_days,
            max_reference_lag_days=config.max_reference_lag_days,
        )
        origin_hash = _hash([
            {
                "sourceObservationId": item.source_observation_id,
                "observedAt": item.observed_at.isoformat(),
                "availableAt": item.available_at.isoformat(),
                "price": item.price,
                "quality": item.quality,
            }
            for item in known
        ])
        run_id = _deterministic_id(
            key, f"walk-forward-run:{model.id}:{origin.isoformat()}"
        )
        snapshot_id = _deterministic_id(
            key, f"walk-forward-snapshot:{model.id}:{origin.isoformat()}"
        )
        trend_rows.append(_trend_row(
            snapshot,
            snapshot_id=snapshot_id,
            analytics_run_id=run_id,
            terms=terms,
        ))
        origin_predictions: list[ResearchForecastPrediction] = []
        for horizon in model.allowed_horizons:
            prediction = _forecast_prediction(
                model=model,
                snapshot=snapshot,
                terms=terms,
                analytics_run_id=run_id,
                trend_snapshot_id=snapshot_id,
                origin=origin,
                horizon_days=horizon,
                feature_dataset_hash=origin_hash,
            )
            prediction_id = _deterministic_id(
                key, f"walk-forward-prediction:{model.id}:{origin.isoformat()}:{horizon}"
            )
            row = {"id": prediction_id, **prediction.database_row()}
            prediction_rows.append(row)
            origin_predictions.append(prediction)
            if prediction.matures_at > config.generated_at:
                continue
            evaluation_id = _deterministic_id(
                key, f"walk-forward-evaluation:{prediction_id}:{ledger_hash}"
            )
            target_window_start = prediction.matures_at - timedelta(days=6)
            try:
                realized = realized_price_at_maturity(
                    accepted,
                    prediction.matures_at,
                    config.generated_at,
                    key=key,
                )
            except ValueError as exc:
                if "no realized-price observations" not in str(exc):
                    raise
                unscorable_targets += 1
                evaluation_rows.append({
                    "id": evaluation_id,
                    "analytics_run_id": None,
                    "prediction_id": prediction_id,
                    "maturity": prediction.matures_at.isoformat(),
                    "evaluated_at": config.generated_at.isoformat(),
                    "evaluation_status": "unscorable",
                    "unscorable_reason": "no_observations_in_trailing_seven_day_window",
                    "target_window_start": target_window_start.isoformat(),
                    "target_window_end": prediction.matures_at.isoformat(),
                    "realized_price": None,
                    "exact_date_price": None,
                    "observation_count": 0,
                    "absolute_log_error": None,
                    "absolute_percentage_error": None,
                    "direction_correct": None,
                    "brier_component": None,
                    "pinball_losses": {},
                    "evaluation_hash": "0" * 64,
                })
                matured_by_horizon[horizon].append({
                    "evaluation_id": evaluation_id,
                    "origin": origin,
                    "prediction_status": prediction.prediction_status,
                    "evaluation_status": "unscorable",
                })
                continue
            audit = WalkForwardAudit(
                origin=origin,
                horizon_days=horizon,
                feature_cutoff=snapshot.feature_cutoff,
                training_cutoff=origin,
                latest_training_label_maturity=None,
                evaluated_at=config.generated_at,
            )
            case = ForecastCase(
                audit=audit,
                key=key,
                lineage=lineage,
                current_price=snapshot.current_price,
                predicted_price=prediction.quantiles[0.50],
                realized_price=realized.trailing_seven_day_median,
                baseline_price=snapshot.current_price,
                probability_up=prediction.probability_up,
                quantiles=prediction.quantiles,
            )
            pinball = {
                f"{probability:.2f}": _pinball(
                    case.realized_price, case.quantiles[probability], probability
                )
                for probability in NORMAL_QUANTILES
            }
            evaluation_values = {
                "analytics_run_id": None,
                "prediction_id": prediction_id,
                "maturity": prediction.matures_at.isoformat(),
                "evaluated_at": config.generated_at.isoformat(),
                "evaluation_status": "scored",
                "unscorable_reason": None,
                "target_window_start": target_window_start.isoformat(),
                "target_window_end": prediction.matures_at.isoformat(),
                "realized_price": realized.trailing_seven_day_median,
                "exact_date_price": realized.exact_date_price,
                "observation_count": realized.observation_count,
                "absolute_log_error": abs(log(case.predicted_price / case.realized_price)),
                "absolute_percentage_error": abs(case.predicted_price - case.realized_price) / case.realized_price,
                "direction_correct": (
                    _direction(case.predicted_price / case.current_price - 1)
                    == _direction(case.realized_price / case.current_price - 1)
                ),
                "brier_component": (
                    case.probability_up - float(case.realized_price > case.current_price)
                ) ** 2,
                "pinball_losses": pinball,
            }
            evaluation_rows.append({
                "id": evaluation_id,
                **evaluation_values,
                "evaluation_hash": "0" * 64,
            })
            matured_by_horizon[horizon].append({
                "evaluation_id": evaluation_id,
                "origin": origin,
                "prediction_status": prediction.prediction_status,
                "evaluation_status": "scored",
            })
            if prediction.prediction_status == "research_only":
                cases_by_horizon[horizon].append(case)

        quarantined = sum(
            prediction.prediction_status == "quarantined"
            for prediction in origin_predictions
        )
        run_config = {
            "operation": SIMULATION_MODE,
            "simulationMode": SIMULATION_MODE,
            "notProspectivelyGenerated": True,
            "sourcePermissionCheckedAt": config.generated_at.isoformat(),
            "origin": origin.isoformat(),
            "modelVersionId": model.id,
            "pointInTimeObservationCount": len(known),
            "outliersExcludedFromFeatures": True,
            "publicPublicationAllowed": False,
        }
        run_rows.append(_run_row(
            run_id=run_id,
            run_kind="walk_forward",
            feature_cutoff=origin,
            generated_at=config.generated_at,
            dataset_hash=origin_hash,
            terms=terms,
            config=config,
            run_config=run_config,
            records_read=len(known),
            records_written=1 + len(origin_predictions),
            records_quarantined=quarantined,
        ))
        source_rows.append({
            "analytics_run_id": run_id,
            "source_id": terms.source_id,
            "terms_review_id": terms.terms_review_id,
            "usage_kind": "derived_feature",
        })

    evaluation_run_id = _deterministic_id(
        key, f"forecast-evaluation-run:{model.id}:{ledger_hash}:{config.generated_at.isoformat()}"
    )
    for row in evaluation_rows:
        row["analytics_run_id"] = evaluation_run_id
        hash_values = dict(row)
        hash_values.pop("id")
        hash_values.pop("evaluation_hash")
        row["evaluation_hash"] = _hash({
            **hash_values,
            "simulationMode": SIMULATION_MODE,
            "modelVersionId": model.id,
        })

    scorecard_rows: list[Mapping[str, object]] = []
    scorecard_evaluation_rows: list[Mapping[str, object]] = []
    promotion_policy = config.promotion_policy.as_dict()
    promotion_policy_hash = config.promotion_policy.policy_hash
    for horizon in sorted(matured_by_horizon):
        members = tuple(matured_by_horizon[horizon])
        cases = tuple(cases_by_horizon[horizon])
        if cases:
            summary = evaluate_cases(cases)
            assessment = assess_research_scorecard(
                summary,
                policy=config.promotion_policy,
                baseline_results={"no_change": summary.baseline_relative_lift},
            )
            summary_metrics = {**_summary_metrics(summary), **assessment.metrics}
            recommendation = assessment.recommendation
            assessment_reasons = assessment.reason_codes
            operator_review_required = assessment.operator_review_required
        else:
            summary_metrics = _empty_summary_metrics()
            summary_metrics = {
                **summary_metrics,
                "baselineResults": {},
                "missingRequiredBaselines": list(
                    config.promotion_policy.required_baselines
                ),
                "belowThresholdRequiredBaselines": [],
                "strongestSimpleChallenger": None,
            }
            recommendation = "insufficient"
            assessment_reasons = (
                "missing_required_baselines",
                "insufficient_evaluation_cases",
                "missing_baseline_comparison",
                "missing_interval_coverage",
                "missing_probability_score",
            )
            operator_review_required = True
        origin_start = min(member["origin"] for member in members)
        origin_end = max(member["origin"] for member in members)
        included_count = sum(
            member["prediction_status"] == "research_only"
            and member["evaluation_status"] == "scored"
            for member in members
        )
        unscorable_count = sum(
            member["prediction_status"] == "research_only"
            and member["evaluation_status"] == "unscorable"
            for member in members
        )
        excluded_count = sum(
            member["prediction_status"] == "quarantined" for member in members
        )
        membership = [
            {
                "evaluationId": member["evaluation_id"],
                "evaluationStatus": member["evaluation_status"],
                "includedInMetrics": (
                    member["prediction_status"] == "research_only"
                    and member["evaluation_status"] == "scored"
                ),
                "reasonCodes": (
                    ["quarantined_prediction_excluded"]
                    if member["prediction_status"] == "quarantined"
                    else ["unscorable_target_excluded"]
                    if member["evaluation_status"] == "unscorable"
                    else []
                ),
            }
            for member in sorted(members, key=lambda value: str(value["evaluation_id"]))
        ]
        evaluation_membership_hash = _hash(membership)
        metrics = {
            **summary_metrics,
            "maturedCount": len(members),
            "unscorableCount": unscorable_count,
            "excludedCount": excluded_count,
            "evaluationMembershipHash": evaluation_membership_hash,
            "promotionPolicy": promotion_policy,
            "promotionPolicyHash": promotion_policy_hash,
            "originSpacingDays": config.origin_spacing_days,
            "simulationMode": SIMULATION_MODE,
            "notProspectivelyGenerated": True,
            "operatorReviewRequired": operator_review_required,
            "quarantinedPredictionsExcluded": True,
        }
        reasons = tuple(dict.fromkeys((
            SIMULATION_MODE,
            "not_prospectively_generated",
            "operator_model_review_required",
            *assessment_reasons,
        )))
        scorecard_id = _deterministic_id(
            key,
            f"model-scorecard:{model.id}:{horizon}:{config.cohort_key}:"
            f"{origin_start.isoformat()}:{origin_end.isoformat()}",
        )
        scorecard_values = {
            "analytics_run_id": evaluation_run_id,
            "model_version_id": model.id,
            "horizon_days": horizon,
            "cohort_key": config.cohort_key,
            "origin_start": origin_start.isoformat(),
            "origin_end": origin_end.isoformat(),
            "evaluation_count": included_count,
            "matured_count": len(members),
            "unscorable_count": unscorable_count,
            "excluded_count": excluded_count,
            "metrics": metrics,
            "promotion_policy": promotion_policy,
            "promotion_policy_hash": promotion_policy_hash,
            "evaluation_membership_hash": evaluation_membership_hash,
            "promotion_recommendation": recommendation,
            "reason_codes": list(reasons),
        }
        scorecard_rows.append({
            "id": scorecard_id,
            **scorecard_values,
            "scorecard_hash": _hash(scorecard_values),
        })
        scorecard_evaluation_rows.extend({
            "scorecard_id": scorecard_id,
            "evaluation_id": member["evaluationId"],
            "evaluation_status": member["evaluationStatus"],
            "included_in_metrics": member["includedInMetrics"],
            "reason_codes": member["reasonCodes"],
        } for member in membership)

    excluded_matured_targets = sum(
        member["prediction_status"] == "quarantined"
        for members in matured_by_horizon.values()
        for member in members
    )
    evaluation_run_config = {
        "operation": "retrospective_forecast_evaluation",
        "simulationMode": SIMULATION_MODE,
        "notProspectivelyGenerated": True,
        "sourcePermissionCheckedAt": config.generated_at.isoformat(),
        "modelVersionId": model.id,
        "ledgerHash": ledger_hash,
        "scorecardCount": len(scorecard_rows),
        "unscorableMaturedTargets": unscorable_targets,
        "excludedMaturedTargets": excluded_matured_targets,
        "publicPublicationAllowed": False,
    }
    run_rows.append(_run_row(
        run_id=evaluation_run_id,
        run_kind="forecast_evaluation",
        feature_cutoff=config.generated_at,
        generated_at=config.generated_at,
        dataset_hash=ledger_hash,
        terms=terms,
        config=config,
        run_config=evaluation_run_config,
        records_read=len(evaluation_rows),
        records_written=(
            len(evaluation_rows) + len(scorecard_rows) + len(scorecard_evaluation_rows)
        ),
        records_quarantined=excluded_matured_targets,
    ))
    source_rows.append({
        "analytics_run_id": evaluation_run_id,
        "source_id": terms.source_id,
        "terms_review_id": terms.terms_review_id,
        "usage_kind": "derived_feature",
    })

    packet_values = {
        "simulationMode": SIMULATION_MODE,
        "generatedAt": config.generated_at.isoformat(),
        "ledgerHash": ledger_hash,
        "ledgerStatusCounts": status_counts,
        "modelRow": model.database_row(),
        "analyticsRunRows": run_rows,
        "analyticsRunSourceRows": source_rows,
        "trendSnapshotRows": trend_rows,
        "predictionRows": prediction_rows,
        "evaluationRows": evaluation_rows,
        "scorecardRows": scorecard_rows,
        "scorecardEvaluationRows": scorecard_evaluation_rows,
        "unscorableMaturedTargets": unscorable_targets,
        "promotionReviewRows": [],
        "publicCandidateRows": [],
    }
    return RetrospectiveWalkForwardEvidence(
        generated_at=config.generated_at,
        ledger_hash=ledger_hash,
        ledger_status_counts=status_counts,
        model_row=model.database_row(),
        analytics_run_rows=tuple(run_rows),
        analytics_run_source_rows=tuple(source_rows),
        trend_snapshot_rows=tuple(trend_rows),
        prediction_rows=tuple(prediction_rows),
        evaluation_rows=tuple(evaluation_rows),
        scorecard_rows=tuple(scorecard_rows),
        scorecard_evaluation_rows=tuple(scorecard_evaluation_rows),
        unscorable_matured_targets=unscorable_targets,
        packet_hash=_hash(packet_values),
    )
