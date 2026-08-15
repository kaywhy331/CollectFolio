"""Immutable research forecast packets and explicit promotion evidence."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from hashlib import sha256
import json
from math import erf, exp, isfinite, sqrt
from typing import Mapping
from uuid import UUID

from .baselines import damped_momentum, no_change
from .evaluation import EvaluationSummary, ResearchLineage, assert_features_known
from .market_pipeline import SourceTerms
from .quantiles import validate_quantiles
from .trends import TrendSnapshot


SUPPORTED_HORIZONS = (7, 30, 90, 180, 365)
MODEL_FAMILIES = {
    "no_change_baseline",
    "damped_momentum_baseline",
    "structural_fair_value",
    "quantile_return_forecast",
}
REQUIRED_PROMOTION_BASELINES = (
    "no_change",
    "damped_momentum",
    "market_index",
    "lifecycle_cohort",
    "structural_convergence",
)
NORMAL_QUANTILES = {
    0.10: -1.2815515655446004,
    0.25: -0.6744897501960817,
    0.50: 0.0,
    0.75: 0.6744897501960817,
    0.90: 1.2815515655446004,
}


def _uuid(value: str, name: str) -> str:
    try:
        return str(UUID(str(value)))
    except (TypeError, ValueError, AttributeError) as exc:
        raise ValueError(f"{name} must be a UUID") from exc


def _utc(value: datetime, name: str) -> datetime:
    if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() is None:
        raise ValueError(f"{name} must be timezone-aware")
    return value.astimezone(timezone.utc)


def _canonical_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _hash(value: object) -> str:
    return sha256(_canonical_json(value).encode("utf-8")).hexdigest()


def _bounded(value: float, minimum: float, maximum: float, name: str) -> float:
    if isinstance(value, bool) or not isfinite(value) or not minimum <= value <= maximum:
        raise ValueError(f"{name} must be between {minimum} and {maximum}")
    return float(value)


@dataclass(frozen=True, slots=True)
class ResearchModelCard:
    id: str
    model_key: str
    version: str
    model_family: str
    lineage: ResearchLineage
    allowed_horizons: tuple[int, ...]
    created_at: datetime
    config: Mapping[str, object]
    training_mode: str = "trained"
    model_definition_hash: str | None = None
    training_dataset_hash: str | None = None
    model_artifact_hash: str | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "id", _uuid(self.id, "model id"))
        for name in ("model_key", "version"):
            value = str(getattr(self, name) or "").strip()
            if not value:
                raise ValueError(f"{name} must be non-empty")
            object.__setattr__(self, name, value)
        if self.model_family not in MODEL_FAMILIES:
            raise ValueError(f"model_family must be one of {sorted(MODEL_FAMILIES)}")
        if not isinstance(self.lineage, ResearchLineage):
            raise ValueError("lineage must be ResearchLineage")
        horizons = tuple(sorted(set(self.allowed_horizons)))
        if not horizons or any(value not in SUPPORTED_HORIZONS for value in horizons):
            raise ValueError(f"allowed_horizons must come from {SUPPORTED_HORIZONS}")
        object.__setattr__(self, "allowed_horizons", horizons)
        object.__setattr__(self, "created_at", _utc(self.created_at, "created_at"))
        if not isinstance(self.config, Mapping):
            raise ValueError("config must be an object")
        object.__setattr__(self, "config", dict(self.config))
        training_mode = str(self.training_mode or "").strip()
        if training_mode not in {"trained", "none_static_baseline"}:
            raise ValueError("training_mode must be trained or none_static_baseline")
        object.__setattr__(self, "training_mode", training_mode)
        definition_hash = self.model_definition_hash or self.lineage.dataset_sha256
        if len(definition_hash) != 64 or any(value not in "0123456789abcdef" for value in definition_hash):
            raise ValueError("model_definition_hash must be a SHA-256 digest")
        object.__setattr__(self, "model_definition_hash", definition_hash)
        training_hash = self.training_dataset_hash
        if training_mode == "trained" and training_hash is None:
            training_hash = self.lineage.dataset_sha256
        if training_mode == "none_static_baseline" and training_hash is not None:
            raise ValueError("a static baseline cannot claim a training dataset")
        if training_hash is not None and (
            len(training_hash) != 64
            or any(value not in "0123456789abcdef" for value in training_hash)
        ):
            raise ValueError("training_dataset_hash must be a SHA-256 digest")
        object.__setattr__(self, "training_dataset_hash", training_hash)
        artifact_hash = self.model_artifact_hash
        if artifact_hash is not None and (
            len(artifact_hash) != 64
            or any(value not in "0123456789abcdef" for value in artifact_hash)
        ):
            raise ValueError("model_artifact_hash must be a SHA-256 digest")
        object.__setattr__(self, "model_artifact_hash", artifact_hash)

    @property
    def config_hash(self) -> str:
        return _hash(self.config)

    def database_row(self) -> dict[str, object]:
        return {
            "id": self.id,
            "model_key": self.model_key,
            "version": self.version,
            "model_family": self.model_family,
            "research_only": True,
            "allowed_horizons": list(self.allowed_horizons),
            "training_mode": self.training_mode,
            "model_definition_hash": self.model_definition_hash,
            "training_dataset_hash": self.training_dataset_hash,
            "feature_version": self.lineage.feature_version,
            "mapping_version": self.lineage.mapping_version,
            "code_version": self.lineage.code_version,
            "model_artifact_hash": self.model_artifact_hash,
            "trained_through": None,
            "config": dict(self.config),
            "config_hash": self.config_hash,
            "created_at": self.created_at.isoformat(),
        }


@dataclass(frozen=True, slots=True)
class ResearchForecastPrediction:
    analytics_run_id: str
    model: ResearchModelCard
    trend_snapshot_id: str
    snapshot: TrendSnapshot
    terms: SourceTerms
    origin: datetime
    horizon_days: int
    quantiles: Mapping[float, float]
    probability_up: float
    confidence: float
    prediction_status: str
    reason_codes: tuple[str, ...]
    feature_dataset_hash: str | None = None
    market_series_id: str | None = None
    evidence_mode: str = "retrospective"

    def __post_init__(self) -> None:
        object.__setattr__(self, "analytics_run_id", _uuid(self.analytics_run_id, "analytics_run_id"))
        object.__setattr__(self, "trend_snapshot_id", _uuid(self.trend_snapshot_id, "trend_snapshot_id"))
        if not isinstance(self.model, ResearchModelCard):
            raise ValueError("model must be ResearchModelCard")
        if not isinstance(self.snapshot, TrendSnapshot):
            raise ValueError("snapshot must be TrendSnapshot")
        if not isinstance(self.terms, SourceTerms):
            raise ValueError("terms must be SourceTerms")
        origin = _utc(self.origin, "origin")
        object.__setattr__(self, "origin", origin)
        if self.horizon_days not in self.model.allowed_horizons:
            raise ValueError("horizon is not allowed by this model card")
        quantiles = dict(validate_quantiles(self.quantiles))
        if any(value <= 0 for value in quantiles.values()):
            raise ValueError("forecast price quantiles must be positive")
        object.__setattr__(self, "quantiles", quantiles)
        object.__setattr__(self, "probability_up", _bounded(
            self.probability_up, 0, 1, "probability_up"
        ))
        object.__setattr__(self, "confidence", _bounded(self.confidence, 0, 100, "confidence"))
        if self.prediction_status not in {"research_only", "quarantined"}:
            raise ValueError("research predictions cannot be publication-eligible")
        reasons = tuple(str(value).strip() for value in self.reason_codes if str(value).strip())
        if "operator_model_review_required" not in reasons:
            raise ValueError("research prediction must require operator model review")
        object.__setattr__(self, "reason_codes", reasons)
        dataset_hash = self.feature_dataset_hash or self.model.lineage.dataset_sha256
        if len(dataset_hash) != 64 or any(value not in "0123456789abcdef" for value in dataset_hash):
            raise ValueError("feature_dataset_hash must be a SHA-256 digest")
        object.__setattr__(self, "feature_dataset_hash", dataset_hash)
        if self.market_series_id is not None:
            object.__setattr__(
                self, "market_series_id", _uuid(self.market_series_id, "market_series_id")
            )
        if self.evidence_mode not in {"retrospective", "prospective"}:
            raise ValueError("evidence_mode must be retrospective or prospective")
        if self.evidence_mode == "prospective" and self.market_series_id is None:
            raise ValueError("prospective predictions require immutable market-series lineage")

    @property
    def matures_at(self) -> datetime:
        return self.origin + timedelta(days=self.horizon_days)

    @property
    def prediction_hash(self) -> str:
        return _hash({
            "analyticsRunId": self.analytics_run_id,
            "modelVersionId": self.model.id,
            "trendSnapshotId": self.trend_snapshot_id,
            "variantId": self.snapshot.key.canonical_variant_id,
            "sourceId": self.terms.source_id,
            "termsReviewId": self.terms.terms_review_id,
            "origin": self.origin.isoformat(),
            "horizonDays": self.horizon_days,
            "currentPrice": self.snapshot.current_price,
            "quantiles": self.quantiles,
            "probabilityUp": self.probability_up,
            "status": self.prediction_status,
            "reasons": self.reason_codes,
            "featureDatasetHash": self.feature_dataset_hash,
            "marketSeriesId": self.market_series_id,
            "evidenceMode": self.evidence_mode,
            "seriesIdentity": {
                "sourceId": self.snapshot.key.source_id,
                "currency": self.snapshot.key.currency,
                "language": self.snapshot.key.language,
                "finish": self.snapshot.key.finish,
                "conditionClass": self.snapshot.key.condition_class,
                "marketCondition": self.snapshot.key.market_condition,
                "priceSemantics": self.snapshot.key.price_semantics,
            },
            "lineage": self.model.lineage.__dict__ if hasattr(self.model.lineage, "__dict__") else {
                "dataset": self.model.lineage.dataset_sha256,
                "code": self.model.lineage.code_version,
                "features": self.model.lineage.feature_version,
                "mapping": self.model.lineage.mapping_version,
                "model": self.model.lineage.model_version,
            },
        })

    def database_row(self) -> dict[str, object]:
        return {
            "analytics_run_id": self.analytics_run_id,
            "model_version_id": self.model.id,
            "trend_snapshot_id": self.trend_snapshot_id,
            "variant_id": self.snapshot.key.canonical_variant_id,
            "source_id": self.terms.source_id,
            "terms_review_id": self.terms.terms_review_id,
            "market_series_id": self.market_series_id,
            "evidence_mode": self.evidence_mode,
            "origin": self.origin.isoformat(),
            "feature_cutoff": self.snapshot.feature_cutoff.isoformat(),
            "horizon_days": self.horizon_days,
            "matures_at": self.matures_at.isoformat(),
            "currency": self.snapshot.key.currency,
            "current_price": self.snapshot.current_price,
            "q10": self.quantiles[0.10],
            "q25": self.quantiles[0.25],
            "q50": self.quantiles[0.50],
            "q75": self.quantiles[0.75],
            "q90": self.quantiles[0.90],
            "probability_up": self.probability_up,
            "confidence": self.confidence,
            "prediction_status": self.prediction_status,
            "reason_codes": list(self.reason_codes),
            "dataset_hash": self.feature_dataset_hash,
            "feature_version": self.model.lineage.feature_version,
            "mapping_version": self.model.lineage.mapping_version,
            "code_version": self.model.lineage.code_version,
            "prediction_hash": self.prediction_hash,
        }


@dataclass(frozen=True, slots=True)
class ResearchForecastPacket:
    model_row: Mapping[str, object]
    prediction_rows: tuple[Mapping[str, object], ...]
    packet_hash: str
    public_publication_allowed: bool = False


def _normal_probability_up(mean_log_return: float, sigma: float) -> float:
    if sigma <= 0:
        return 0.5 if mean_log_return == 0 else float(mean_log_return > 0)
    return 0.5 * (1 + erf(mean_log_return / (sigma * sqrt(2))))


def build_research_baseline_packet(
    model: ResearchModelCard,
    snapshot: TrendSnapshot,
    terms: SourceTerms,
    *,
    analytics_run_id: str,
    trend_snapshot_id: str,
    origin: datetime,
    market_series_id: str | None = None,
    evidence_mode: str = "retrospective",
) -> ResearchForecastPacket:
    """Build baseline predictions that are permanently marked research-only."""

    if not terms.permits_research_ingestion(origin):
        raise PermissionError("current source terms do not permit research forecasts")
    origin_utc = _utc(origin, "origin")
    assert_features_known(
        (snapshot.feature_cutoff, snapshot.latest_observed_at),
        origin_utc,
    )
    if snapshot.key.source_id != terms.source_id:
        raise ValueError("trend snapshot source does not match source terms")

    config = model.config
    damping = float(config.get("damping", 0.25))
    max_return = float(config.get("maxAbsLogReturn", 0.70))
    max_interval = float(config.get("maxIntervalLogWidth", 1.50))
    if not 0 <= damping <= 1 or max_return <= 0 or max_interval <= 0:
        raise ValueError("model config contains invalid forecast bounds")

    predictions: list[ResearchForecastPrediction] = []
    for horizon in model.allowed_horizons:
        reasons = ["baseline_only", "uncalibrated_interval", "operator_model_review_required"]
        status = "research_only"
        if model.model_family == "no_change_baseline":
            median_forecast = no_change(snapshot.current_price, horizon)
        else:
            if snapshot.robust_slope_90d is None:
                median_forecast = no_change(snapshot.current_price, horizon)
                status = "quarantined"
                reasons.append("missing_robust_slope")
            else:
                median_forecast = damped_momentum(
                    snapshot.current_price,
                    horizon,
                    snapshot.robust_slope_90d,
                    damping=damping,
                    max_abs_log_return=max_return,
                )

        volatility = snapshot.volatility_90d
        if volatility is None or volatility <= 0:
            sigma = 0.0
            status = "quarantined"
            reasons.append("missing_positive_volatility")
        else:
            sigma = min(max_interval, volatility * sqrt(horizon))
        quantiles = {
            probability: median_forecast.median_price * exp(z_score * sigma)
            for probability, z_score in NORMAL_QUANTILES.items()
        }
        probability_up = _normal_probability_up(median_forecast.predicted_log_return, sigma)
        confidence = min(49.0, max(0.0, snapshot.evidence_quality * 100)) if status == "research_only" else 0.0
        predictions.append(ResearchForecastPrediction(
            analytics_run_id=analytics_run_id,
            model=model,
            trend_snapshot_id=trend_snapshot_id,
            snapshot=snapshot,
            terms=terms,
            origin=origin_utc,
            horizon_days=horizon,
            quantiles=quantiles,
            probability_up=probability_up,
            confidence=confidence,
            prediction_status=status,
            reason_codes=tuple(reasons),
            market_series_id=market_series_id,
            evidence_mode=evidence_mode,
        ))
    rows = tuple(prediction.database_row() for prediction in predictions)
    model_row = model.database_row()
    return ResearchForecastPacket(
        model_row=model_row,
        prediction_rows=rows,
        packet_hash=_hash({"model": model_row, "predictions": rows}),
        public_publication_allowed=False,
    )


@dataclass(frozen=True, slots=True)
class PromotionPolicy:
    version: str = "research-promotion-v1"
    minimum_cases: int = 30
    minimum_baseline_lift: float = 0.02
    interval_80_coverage_min: float = 0.72
    interval_80_coverage_max: float = 0.88
    maximum_brier_score: float = 0.25
    required_baselines: tuple[str, ...] = REQUIRED_PROMOTION_BASELINES

    def __post_init__(self) -> None:
        version = str(self.version or "").strip()
        if not version or len(version) > 120:
            raise ValueError("promotion policy version must contain 1-120 characters")
        object.__setattr__(self, "version", version)
        if (
            isinstance(self.minimum_cases, bool)
            or not isinstance(self.minimum_cases, int)
            or self.minimum_cases < 1
        ):
            raise ValueError("minimum_cases must be positive")
        _bounded(self.minimum_baseline_lift, -1, 1, "minimum_baseline_lift")
        lower = _bounded(self.interval_80_coverage_min, 0, 1, "interval_80_coverage_min")
        upper = _bounded(self.interval_80_coverage_max, 0, 1, "interval_80_coverage_max")
        if lower >= upper:
            raise ValueError("80% coverage bounds must be increasing")
        _bounded(self.maximum_brier_score, 0, 1, "maximum_brier_score")
        baselines = tuple(dict.fromkeys(
            str(value or "").strip() for value in self.required_baselines
            if str(value or "").strip()
        ))
        if not baselines or len(baselines) > 16:
            raise ValueError("required_baselines must contain between 1 and 16 values")
        object.__setattr__(self, "required_baselines", baselines)

    def as_dict(self) -> dict[str, object]:
        return {
            "version": self.version,
            "minimumCases": self.minimum_cases,
            "minimumBaselineLift": self.minimum_baseline_lift,
            "interval80CoverageMin": self.interval_80_coverage_min,
            "interval80CoverageMax": self.interval_80_coverage_max,
            "maximumBrierScore": self.maximum_brier_score,
            "requiredBaselines": list(self.required_baselines),
        }

    @property
    def policy_hash(self) -> str:
        return _hash(self.as_dict())


@dataclass(frozen=True, slots=True)
class ResearchScorecard:
    recommendation: str
    reason_codes: tuple[str, ...]
    operator_review_required: bool
    metrics: Mapping[str, object]


def assess_research_scorecard(
    summary: EvaluationSummary,
    *,
    policy: PromotionPolicy = PromotionPolicy(),
    baseline_results: Mapping[str, float | None] | None = None,
) -> ResearchScorecard:
    """Assess statistical gates while always retaining a human promotion gate."""

    if not isinstance(summary, EvaluationSummary):
        raise ValueError("summary must be EvaluationSummary")
    reasons: list[str] = []
    comparisons: dict[str, float | None] = {}
    supplied_results = (
        {"no_change": summary.baseline_relative_lift}
        if baseline_results is None else baseline_results
    )
    for name, value in dict(supplied_results).items():
        normalized_name = str(name or "").strip()
        if not normalized_name:
            raise ValueError("baseline result names must be non-empty")
        if value is None:
            comparisons[normalized_name] = None
            continue
        if isinstance(value, bool):
            raise ValueError("baseline results must be finite numbers or null")
        try:
            numeric_value = float(value)
        except (TypeError, ValueError) as exc:
            raise ValueError("baseline results must be finite numbers or null") from exc
        if not isfinite(numeric_value):
            raise ValueError("baseline results must be finite numbers or null")
        comparisons[normalized_name] = numeric_value
    if (
        comparisons.get("no_change") is not None
        and summary.baseline_relative_lift is not None
        and abs(comparisons["no_change"] - summary.baseline_relative_lift) > 1e-12
    ):
        raise ValueError("no-change baseline result differs from the evaluation summary")
    missing_baselines = [
        name for name in policy.required_baselines
        if name not in comparisons or comparisons[name] is None
    ]
    if missing_baselines:
        reasons.append("missing_required_baselines")
    if summary.count < policy.minimum_cases:
        reasons.append("insufficient_evaluation_cases")
    if summary.baseline_relative_lift is None:
        reasons.append("missing_baseline_comparison")
    elif summary.baseline_relative_lift < policy.minimum_baseline_lift:
        reasons.append("baseline_lift_below_threshold")
    below_threshold_baselines = [
        name for name in policy.required_baselines
        if name != "no_change"
        and comparisons.get(name) is not None
        and comparisons[name] < policy.minimum_baseline_lift
    ]
    if below_threshold_baselines:
        reasons.append("challenger_baseline_lift_below_threshold")
    if summary.interval_80_coverage is None:
        reasons.append("missing_interval_coverage")
    elif not policy.interval_80_coverage_min <= summary.interval_80_coverage <= policy.interval_80_coverage_max:
        reasons.append("interval_coverage_outside_band")
    if summary.brier_score is None:
        reasons.append("missing_probability_score")
    elif summary.brier_score > policy.maximum_brier_score:
        reasons.append("brier_score_above_threshold")
    recommendation = "eligible_for_operator_review" if not reasons else (
        "insufficient" if any(reason.startswith("missing_") or reason.startswith("insufficient_") for reason in reasons)
        else "reject"
    )
    strongest_challenger = min(
        (
            (name, comparisons[name])
            for name in policy.required_baselines
            if name != "no_change" and comparisons.get(name) is not None
        ),
        key=lambda item: item[1],
        default=None,
    )
    metrics = {
        "count": summary.count,
        "maeLogReturn": summary.mae_log_return,
        "medianAbsolutePercentageError": summary.median_absolute_percentage_error,
        "symmetricMape": summary.symmetric_mape,
        "directionAccuracy": summary.direction_accuracy,
        "baselineRelativeLift": summary.baseline_relative_lift,
        "brierScore": summary.brier_score,
        "interval80Coverage": summary.interval_80_coverage,
        "interval80Width": summary.mean_interval_80_width,
        "baselineResults": comparisons,
        "missingRequiredBaselines": missing_baselines,
        "belowThresholdRequiredBaselines": below_threshold_baselines,
        "strongestSimpleChallenger": (
            {
                "name": strongest_challenger[0],
                "relativeLift": strongest_challenger[1],
            }
            if strongest_challenger is not None else None
        ),
    }
    return ResearchScorecard(
        recommendation=recommendation,
        reason_codes=tuple(reasons),
        operator_review_required=True,
        metrics=metrics,
    )
