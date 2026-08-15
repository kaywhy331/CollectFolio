"""Point-in-time 30/90-day forecast ensemble for private shadow research.

The engine deliberately trains several transparent challengers instead of
assuming one formula is universally best.  All labels must have matured by
the training cutoff, quantiles are calibrated from held-out residuals, and
the returned artifact remains research-only until the existing governance
and source-rights gates approve a scorecard.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from hashlib import sha256
import json
from math import erf, exp, isfinite, log, sqrt
from statistics import median
from random import Random
from typing import Iterable, Mapping, Sequence
from uuid import UUID

from .baselines import (
    BaselineForecast,
    damped_momentum,
    lifecycle_cohort,
    market_index,
    no_change,
    structural_convergence,
)
from .forecasting import (
    PromotionPolicy,
    ResearchForecastPacket,
    ResearchForecastPrediction,
    ResearchModelCard,
    ResearchScorecard,
    assess_research_scorecard,
)
from .evaluation import ForecastCase, ResearchLineage, WalkForwardAudit, evaluate_cases
from .market_pipeline import SourceTerms
from .observations import PriceSeriesKey
from .quantiles import REQUIRED_QUANTILES, validate_quantiles
from .trends import TrendSnapshot


SHADOW_HORIZONS = (30, 90)
DEFAULT_FORECAST_MODEL_VERSION = "forecast-ensemble-v2"
MAX_BOOTSTRAP_SAMPLES = 2_000
MAX_POLICY_SPACING_DAYS = 3_650
Z_SCORES = {
    0.10: -1.2815515655446004,
    0.25: -0.6744897501960817,
    0.50: 0.0,
    0.75: 0.6744897501960817,
    0.90: 1.2815515655446004,
}


def _utc(value: datetime, name: str) -> datetime:
    if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() is None:
        raise ValueError(f"{name} must be a timezone-aware datetime")
    return value.astimezone(timezone.utc)


def _finite(value: float, name: str) -> float:
    if isinstance(value, bool):
        raise ValueError(f"{name} must be finite")
    try:
        numeric = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} must be finite") from exc
    if not isfinite(numeric):
        raise ValueError(f"{name} must be finite")
    return numeric


def _positive(value: float, name: str) -> float:
    numeric = _finite(value, name)
    if numeric <= 0:
        raise ValueError(f"{name} must be positive")
    return numeric


def _bounded(value: float, minimum: float, maximum: float, name: str) -> float:
    numeric = _finite(value, name)
    if not minimum <= numeric <= maximum:
        raise ValueError(f"{name} must be between {minimum} and {maximum}")
    return numeric


def _horizon(value: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value not in SHADOW_HORIZONS:
        raise ValueError(f"horizon_days must be one of {SHADOW_HORIZONS}")
    return value


def _model_version(value: object) -> str:
    normalized = value.strip() if isinstance(value, str) else ""
    if normalized != DEFAULT_FORECAST_MODEL_VERSION:
        raise ValueError(
            "model_version must equal "
            f"{DEFAULT_FORECAST_MODEL_VERSION}; legacy or caller-defined versions "
            "cannot label the implemented forecast math"
        )
    return normalized


def _canonical_hash(value: object) -> str:
    body = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return sha256(body.encode("utf-8")).hexdigest()


def _uuid(value: object, name: str) -> str:
    try:
        return str(UUID(str(value)))
    except (TypeError, ValueError, AttributeError) as exc:
        raise ValueError(f"{name} must be a UUID") from exc


@dataclass(frozen=True, slots=True)
class ForecastFeatures:
    """Features known for one exact variant at a single forecast origin."""

    variant_id: str
    cohort_key: str
    origin: datetime
    current_price: float
    robust_daily_log_slope: float
    volatility_daily: float
    evidence_quality: float
    history_days: int
    set_id: str = ""
    market_daily_log_slope: float | None = None
    lifecycle_log_return_30d: float | None = None
    lifecycle_log_return_90d: float | None = None
    structural_median_price: float | None = None
    structural_lower_price: float | None = None
    demand_acceleration: float | None = None
    demand_normalization_version: str | None = None
    reprint_risk: float | None = None
    feature_timestamps: tuple[datetime, ...] = ()

    def __post_init__(self) -> None:
        for name in ("variant_id", "cohort_key"):
            value = str(getattr(self, name) or "").strip()
            if not value:
                raise ValueError(f"{name} must be non-empty")
            object.__setattr__(self, name, value)
        origin = _utc(self.origin, "origin")
        object.__setattr__(self, "origin", origin)
        object.__setattr__(self, "current_price", _positive(self.current_price, "current_price"))
        object.__setattr__(self, "robust_daily_log_slope", _finite(
            self.robust_daily_log_slope, "robust_daily_log_slope",
        ))
        object.__setattr__(self, "volatility_daily", _bounded(
            self.volatility_daily, 0, 10, "volatility_daily",
        ))
        object.__setattr__(self, "evidence_quality", _bounded(
            self.evidence_quality, 0, 1, "evidence_quality",
        ))
        if isinstance(self.history_days, bool) or not isinstance(self.history_days, int) or self.history_days < 0:
            raise ValueError("history_days must be a non-negative integer")
        object.__setattr__(self, "set_id", str(self.set_id or "").strip())
        for name in ("market_daily_log_slope", "lifecycle_log_return_30d", "lifecycle_log_return_90d", "demand_acceleration"):
            value = getattr(self, name)
            if value is not None:
                object.__setattr__(self, name, _finite(value, name))
        if self.demand_normalization_version is not None:
            demand_version = str(self.demand_normalization_version).strip()
            if not demand_version:
                raise ValueError("demand_normalization_version must be non-empty or None")
            object.__setattr__(self, "demand_normalization_version", demand_version)
        for name in ("structural_median_price", "structural_lower_price"):
            value = getattr(self, name)
            if value is not None:
                object.__setattr__(self, name, _positive(value, name))
        if self.reprint_risk is not None:
            object.__setattr__(self, "reprint_risk", _bounded(
                self.reprint_risk, 0, 1, "reprint_risk",
            ))
        timestamps = tuple(_utc(value, "feature_timestamp") for value in self.feature_timestamps)
        if any(value > origin for value in timestamps):
            raise ValueError("feature timestamp exceeds forecast origin")
        object.__setattr__(self, "feature_timestamps", timestamps)

    def lifecycle_return(self, horizon_days: int) -> float | None:
        horizon = _horizon(horizon_days)
        return self.lifecycle_log_return_30d if horizon == 30 else self.lifecycle_log_return_90d


@dataclass(frozen=True, slots=True)
class MaturedTrainingExample:
    """One point-in-time feature row with a matured future-return label."""

    features: ForecastFeatures
    horizon_days: int
    realized_price: float
    label_available_at: datetime
    series_key: PriceSeriesKey | None = None
    target_observation_ids: tuple[str, ...] = ()
    market_series_id: str | None = None
    candidate_universe_id: str | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.features, ForecastFeatures):
            raise ValueError("features must be ForecastFeatures")
        horizon = _horizon(self.horizon_days)
        object.__setattr__(self, "horizon_days", horizon)
        object.__setattr__(self, "realized_price", _positive(self.realized_price, "realized_price"))
        available = _utc(self.label_available_at, "label_available_at")
        if available < self.features.origin + timedelta(days=horizon):
            raise ValueError("label_available_at precedes forecast maturity")
        object.__setattr__(self, "label_available_at", available)
        if self.series_key is not None and not isinstance(self.series_key, PriceSeriesKey):
            raise ValueError("series_key must be a PriceSeriesKey or None")
        observation_ids = tuple(str(value or "").strip() for value in self.target_observation_ids)
        if any(not value for value in observation_ids) or len(set(observation_ids)) != len(observation_ids):
            raise ValueError("target_observation_ids must contain unique non-empty values")
        if self.market_series_id is not None:
            object.__setattr__(
                self, "market_series_id", _uuid(self.market_series_id, "market_series_id")
            )
            if self.series_key is None:
                raise ValueError("market-series lineage requires an exact series_key")
            if not observation_ids:
                raise ValueError("market-series lineage requires target observation IDs")
            if any(_uuid(value, "target observation ID") != value for value in observation_ids):
                raise ValueError("target observation IDs must be canonical UUIDs")
        if self.candidate_universe_id is not None:
            object.__setattr__(
                self,
                "candidate_universe_id",
                _uuid(self.candidate_universe_id, "candidate_universe_id"),
            )
        object.__setattr__(self, "target_observation_ids", observation_ids)

    @property
    def realized_log_return(self) -> float:
        return log(self.realized_price / self.features.current_price)


@dataclass(frozen=True, slots=True)
class ForecastEnginePolicy:
    horizons: tuple[int, ...] = SHADOW_HORIZONS
    minimum_training_examples: int = 30
    minimum_calibration_examples: int = 10
    minimum_history_days: int = 90
    minimum_evidence_quality: float = 0.55
    validation_fraction: float = 0.25
    momentum_damping: float = 0.25
    market_damping: float = 0.25
    structural_convergence_fraction: float = 0.25
    demand_return_cap: float = 0.12
    reprint_return_penalty: float = 0.10
    maximum_abs_log_return: float = 0.70
    minimum_sigma: float = 0.03
    maximum_sigma: float = 0.80
    minimum_model_weight: float = 0.05
    maximum_evidence_interval_multiplier: float = 2.0
    use_demand_acceleration: bool = False
    split_embargo_days: int | None = None

    def __post_init__(self) -> None:
        horizons = tuple(sorted({_horizon(value) for value in self.horizons}))
        if not horizons:
            raise ValueError("at least one horizon is required")
        object.__setattr__(self, "horizons", horizons)
        for name in ("minimum_training_examples", "minimum_calibration_examples", "minimum_history_days"):
            value = getattr(self, name)
            if isinstance(value, bool) or not isinstance(value, int) or value < 1:
                raise ValueError(f"{name} must be a positive integer")
        for name in (
            "minimum_evidence_quality", "validation_fraction", "momentum_damping",
            "market_damping", "structural_convergence_fraction", "minimum_model_weight",
        ):
            object.__setattr__(self, name, _bounded(getattr(self, name), 0, 1, name))
        if not 0 < self.validation_fraction < 0.5:
            raise ValueError("validation_fraction must be between zero and 0.5")
        for name in (
            "demand_return_cap", "reprint_return_penalty", "maximum_abs_log_return",
            "minimum_sigma", "maximum_sigma", "maximum_evidence_interval_multiplier",
        ):
            value = _positive(getattr(self, name), name)
            object.__setattr__(self, name, value)
        if self.minimum_sigma >= self.maximum_sigma:
            raise ValueError("minimum_sigma must be below maximum_sigma")
        if not 1 <= self.maximum_evidence_interval_multiplier <= 2:
            raise ValueError(
                "maximum_evidence_interval_multiplier must be between one and two"
            )
        if not isinstance(self.use_demand_acceleration, bool):
            raise ValueError("use_demand_acceleration must be a boolean")
        if self.use_demand_acceleration:
            raise ValueError(
                "demand acceleration is unavailable in forecast-ensemble-v2 until "
                "immutable population and recommendation-exposure provenance exists"
            )
        embargo = self.split_embargo_days
        if embargo is not None and (
            isinstance(embargo, bool) or not isinstance(embargo, int) or embargo < 1
        ):
            raise ValueError("split_embargo_days must be a positive integer or None")
        if embargo is not None and embargo > MAX_POLICY_SPACING_DAYS:
            raise ValueError(
                f"split_embargo_days cannot exceed {MAX_POLICY_SPACING_DAYS}"
            )

    def as_dict(self) -> dict[str, object]:
        return {
            "horizons": list(self.horizons),
            "minimumTrainingExamples": self.minimum_training_examples,
            "minimumCalibrationExamples": self.minimum_calibration_examples,
            "minimumHistoryDays": self.minimum_history_days,
            "minimumEvidenceQuality": self.minimum_evidence_quality,
            "validationFraction": self.validation_fraction,
            "momentumDamping": self.momentum_damping,
            "marketDamping": self.market_damping,
            "structuralConvergenceFraction": self.structural_convergence_fraction,
            "demandReturnCap": self.demand_return_cap,
            "reprintReturnPenalty": self.reprint_return_penalty,
            "maximumAbsLogReturn": self.maximum_abs_log_return,
            "minimumSigma": self.minimum_sigma,
            "maximumSigma": self.maximum_sigma,
            "minimumModelWeight": self.minimum_model_weight,
            "maximumEvidenceIntervalMultiplier": self.maximum_evidence_interval_multiplier,
            "useDemandAcceleration": self.use_demand_acceleration,
            "splitEmbargoDays": self.split_embargo_days,
        }


def _candidate_returns(features: ForecastFeatures, horizon_days: int, policy: ForecastEnginePolicy) -> dict[str, float]:
    horizon = _horizon(horizon_days)
    candidates: list[BaselineForecast] = [
        no_change(features.current_price, horizon),
        damped_momentum(
            features.current_price,
            horizon,
            features.robust_daily_log_slope,
            damping=policy.momentum_damping,
            max_abs_log_return=policy.maximum_abs_log_return,
        ),
    ]
    if features.market_daily_log_slope is not None:
        candidates.append(market_index(
            features.current_price,
            horizon,
            features.market_daily_log_slope,
            damping=policy.market_damping,
            max_abs_log_return=policy.maximum_abs_log_return,
        ))
    lifecycle_return = features.lifecycle_return(horizon)
    if lifecycle_return is not None:
        candidates.append(lifecycle_cohort(
            features.current_price,
            horizon,
            lifecycle_return,
            max_abs_log_return=policy.maximum_abs_log_return,
        ))
    if features.structural_median_price is not None:
        candidates.append(structural_convergence(
            features.current_price,
            horizon,
            features.structural_median_price,
            convergence_fraction=policy.structural_convergence_fraction,
            max_abs_log_return=policy.maximum_abs_log_return,
        ))
    result = {value.model_key: value.predicted_log_return for value in candidates}
    if features.reprint_risk is not None:
        result["event_risk"] = -features.reprint_risk * policy.reprint_return_penalty
    return result


def _chronological_split(
    examples: Sequence[MaturedTrainingExample],
    validation_fraction: float,
) -> tuple[tuple[MaturedTrainingExample, ...], tuple[MaturedTrainingExample, ...]]:
    training, validation = _split_by_origin_blocks(examples, validation_fraction, blocks=2)
    return training, validation


def _split_by_origin_blocks(
    examples: Sequence[MaturedTrainingExample],
    holdout_fraction: float,
    *,
    blocks: int,
    embargo_days: int = 0,
) -> tuple[tuple[MaturedTrainingExample, ...], ...]:
    """Split on whole origins so one market day cannot leak across partitions."""

    ordered = tuple(sorted(examples, key=lambda value: (value.features.origin, value.features.variant_id)))
    origins = tuple(sorted({value.features.origin for value in ordered}))
    if len(origins) < blocks:
        empty = tuple(() for _ in range(blocks - 1))
        return (ordered, *empty)
    holdout_origins = max(1, int(len(origins) * holdout_fraction))
    holdout_origins = min(holdout_origins, max(1, (len(origins) - 1) // (blocks - 1)))
    training_origin_count = len(origins) - holdout_origins * (blocks - 1)
    boundaries = [training_origin_count + index * holdout_origins for index in range(blocks)]
    boundaries[-1] = len(origins)
    origin_groups = [
        set(origins[0:training_origin_count]),
        *(set(origins[boundaries[index - 1]:boundaries[index]]) for index in range(1, blocks)),
    ]
    partitions = tuple(
        tuple(value for value in ordered if value.features.origin in group)
        for group in origin_groups
    )
    if embargo_days <= 0:
        return partitions
    result: list[tuple[MaturedTrainingExample, ...]] = []
    for index, partition in enumerate(partitions):
        if not partition or index == len(partitions) - 1 or not partitions[index + 1]:
            result.append(partition)
            continue
        next_origin = min(value.features.origin for value in partitions[index + 1])
        cutoff = next_origin - timedelta(days=embargo_days)
        result.append(tuple(value for value in partition if value.features.origin < cutoff))
    return tuple(result)


def _chronological_three_way_split(
    examples: Sequence[MaturedTrainingExample],
    validation_fraction: float,
    embargo_days: int = 0,
) -> tuple[
    tuple[MaturedTrainingExample, ...],
    tuple[MaturedTrainingExample, ...],
    tuple[MaturedTrainingExample, ...],
]:
    """Keep model selection and interval calibration on disjoint later blocks."""

    return _split_by_origin_blocks(
        examples, validation_fraction, blocks=3, embargo_days=embargo_days,
    )


def _losses(
    validation: Sequence[MaturedTrainingExample],
    horizon_days: int,
    policy: ForecastEnginePolicy,
) -> dict[str, float]:
    candidates = [
        _candidate_returns(example.features, horizon_days, policy)
        for example in validation
    ]
    common = set(candidates[0]) if candidates else set()
    for values in candidates[1:]:
        common.intersection_update(values)
    errors: dict[str, list[float]] = {name: [] for name in sorted(common)}
    for example, predictions in zip(validation, candidates):
        for name in errors:
            errors[name].append(abs(predictions[name] - example.realized_log_return))
    return {name: sum(values) / len(values) for name, values in errors.items() if values}


def _weights(losses: Mapping[str, float], minimum_weight: float) -> dict[str, float]:
    if not losses:
        return {"no_change": 1.0}
    scale = max(float(median(losses.values())), 1e-6)
    raw = {
        name: max(minimum_weight, exp(-max(0.0, loss) / scale))
        for name, loss in losses.items()
    }
    total = sum(raw.values())
    return {name: value / total for name, value in raw.items()}


def _weighted_prediction(candidates: Mapping[str, float], weights: Mapping[str, float]) -> float:
    common = tuple(name for name in candidates if name in weights)
    if not common:
        return candidates.get("no_change", 0.0)
    total = sum(weights[name] for name in common)
    return sum(candidates[name] * weights[name] for name in common) / total


def _empirical_quantile(values: Sequence[float], probability: float) -> float:
    if not values:
        raise ValueError("empirical quantile requires evidence")
    ordered = sorted(float(value) for value in values)
    position = (len(ordered) - 1) * probability
    left = int(position)
    right = min(left + 1, len(ordered) - 1)
    fraction = position - left
    return ordered[left] * (1 - fraction) + ordered[right] * fraction


def _normal_probability_up(center: float, sigma: float) -> float:
    if sigma <= 0:
        return 0.5 if center == 0 else float(center > 0)
    return 0.5 * (1 + erf(center / (sigma * sqrt(2))))


@dataclass(frozen=True, slots=True)
class ShadowForecast:
    variant_id: str
    cohort_key: str
    origin: datetime
    horizon_days: int
    current_price: float
    quantiles: Mapping[float, float]
    probability_up: float
    confidence: float
    model_weights: Mapping[str, float]
    validation_losses: Mapping[str, float]
    calibration_count: int
    training_count: int
    status: str
    reason_codes: tuple[str, ...]
    model_version: str
    model_definition_hash: str
    artifact_hash: str
    calibration_distribution: tuple[float, ...] = ()
    market_series_id: str | None = None
    public_publication_allowed: bool = False

    def __post_init__(self) -> None:
        object.__setattr__(self, "model_version", _model_version(self.model_version))
        if self.status not in {"research_only", "quarantined"}:
            raise ValueError("shadow forecast status is invalid")
        quantiles = dict(validate_quantiles(self.quantiles, required=REQUIRED_QUANTILES))
        if any(value <= 0 for value in quantiles.values()):
            raise ValueError("forecast prices must be positive")
        object.__setattr__(self, "quantiles", quantiles)
        if self.market_series_id is not None:
            object.__setattr__(
                self, "market_series_id", _uuid(self.market_series_id, "market_series_id")
            )

    def as_dict(self) -> dict[str, object]:
        return {
            "variantId": self.variant_id,
            "cohortKey": self.cohort_key,
            "origin": self.origin.isoformat(),
            "horizonDays": self.horizon_days,
            "maturesAt": (self.origin + timedelta(days=self.horizon_days)).isoformat(),
            "currentPrice": self.current_price,
            "quantiles": {str(value): price for value, price in self.quantiles.items()},
            "probabilityUp": self.probability_up,
            "confidence": self.confidence,
            "modelWeights": dict(self.model_weights),
            "validationLosses": dict(self.validation_losses),
            "calibrationCount": self.calibration_count,
            "trainingCount": self.training_count,
            "status": self.status,
            "reasonCodes": list(self.reason_codes),
            "modelVersion": self.model_version,
            "modelDefinitionHash": self.model_definition_hash,
            "artifactHash": self.artifact_hash,
            "calibrationDistribution": list(self.calibration_distribution),
            "marketSeriesId": self.market_series_id,
            "publicPublicationAllowed": False,
        }


def train_shadow_forecast(
    features: ForecastFeatures,
    examples: Iterable[MaturedTrainingExample],
    horizon_days: int,
    training_cutoff: datetime,
    *,
    policy: ForecastEnginePolicy = ForecastEnginePolicy(),
    model_version: str = DEFAULT_FORECAST_MODEL_VERSION,
    series_key: PriceSeriesKey | None = None,
    market_series_id: str | None = None,
) -> ShadowForecast:
    """Train/calibrate an ensemble and predict one exact variant."""

    model_version = _model_version(model_version)
    if not isinstance(features, ForecastFeatures):
        raise ValueError("features must be ForecastFeatures")
    horizon = _horizon(horizon_days)
    if horizon not in policy.horizons:
        raise ValueError("horizon is disabled by policy")
    cutoff = _utc(training_cutoff, "training_cutoff")
    if cutoff > features.origin:
        raise ValueError("training_cutoff exceeds forecast origin")
    if series_key is not None and not isinstance(series_key, PriceSeriesKey):
        raise ValueError("series_key must be a PriceSeriesKey or None")
    if series_key is not None and series_key.canonical_variant_id != features.variant_id:
        raise ValueError("target market series does not match forecast variant")
    target_market_series_id = (
        _uuid(market_series_id, "market_series_id")
        if market_series_id is not None else None
    )
    if target_market_series_id is not None and series_key is None:
        raise ValueError("market_series_id requires an exact target series_key")
    raw_examples = tuple(examples)
    identities_by_variant: dict[str, tuple[str, ...]] = {}
    market_series_by_variant: dict[str, str] = {}
    for example in raw_examples:
        if not isinstance(example, MaturedTrainingExample) or example.series_key is None:
            continue
        if example.series_key.canonical_variant_id != example.features.variant_id:
            raise ValueError("training market series does not match its forecast variant")
        identity = example.series_key.exact_identity
        previous = identities_by_variant.setdefault(example.features.variant_id, identity)
        if previous != identity:
            raise ValueError("one training variant cannot mix exact market-series identities")
        if example.market_series_id is not None:
            previous_market_series = market_series_by_variant.setdefault(
                example.features.variant_id, example.market_series_id,
            )
            if previous_market_series != example.market_series_id:
                raise ValueError("one training variant cannot mix market-series IDs")
    trained_target_market_series = market_series_by_variant.get(features.variant_id)
    if (
        target_market_series_id is not None
        and trained_target_market_series is not None
        and trained_target_market_series != target_market_series_id
    ):
        raise ValueError("target market-series ID differs from its training lineage")
    eligible = tuple(
        example for example in raw_examples
        if isinstance(example, MaturedTrainingExample)
        and example.horizon_days == horizon
        and example.features.cohort_key == features.cohort_key
        and example.features.origin < features.origin
        and example.label_available_at <= cutoff
    )
    reasons = ["shadow_model", "operator_model_review_required"]
    if features.demand_acceleration is not None and not policy.use_demand_acceleration:
        reasons.append("demand_signal_withheld")
    if len(eligible) < policy.minimum_training_examples:
        reasons.append("insufficient_training_examples")
    if features.history_days < policy.minimum_history_days:
        reasons.append("insufficient_history")
    if features.evidence_quality < policy.minimum_evidence_quality:
        reasons.append("low_evidence_quality")

    validation: tuple[MaturedTrainingExample, ...] = ()
    calibration: tuple[MaturedTrainingExample, ...] = ()
    losses: dict[str, float] = {"no_change": 0.0}
    weights: dict[str, float] = {"no_change": 1.0}
    residuals: list[float] = []
    if len(eligible) >= 3:
        _, validation, calibration = _chronological_three_way_split(
            eligible,
            policy.validation_fraction,
            embargo_days=policy.split_embargo_days or horizon,
        )
        losses = _losses(validation, horizon, policy)
        weights = _weights(losses, policy.minimum_model_weight)
        for example in calibration:
            candidates = _candidate_returns(example.features, horizon, policy)
            residuals.append(example.realized_log_return - _weighted_prediction(candidates, weights))
    if len(residuals) < policy.minimum_calibration_examples:
        reasons.append("insufficient_calibration_examples")

    candidates = _candidate_returns(features, horizon, policy)
    raw_center = _weighted_prediction(candidates, weights)
    market_sigma = max(policy.minimum_sigma, features.volatility_daily * sqrt(horizon))
    residual_center = 0.0
    use_empirical_calibration = False
    if residuals:
        residual_center = _empirical_quantile(residuals, 0.50)
        raw_center += residual_center
        return_quantiles = {
            probability: raw_center + _empirical_quantile(residuals, probability) - residual_center
            for probability in REQUIRED_QUANTILES
        }
        empirical_spread = (
            _empirical_quantile(residuals, 0.90)
            - _empirical_quantile(residuals, 0.10)
        )
        empirical_sigma = max(
            policy.minimum_sigma,
            empirical_spread / 2.563103131,
        )
        sigma = min(policy.maximum_sigma, max(market_sigma, empirical_sigma))
        use_empirical_calibration = (
            len(residuals) >= policy.minimum_calibration_examples
            and empirical_spread > 1e-12
        )
        if not use_empirical_calibration:
            return_quantiles = {
                probability: raw_center + Z_SCORES[probability] * sigma
                for probability in REQUIRED_QUANTILES
            }
            if (
                len(residuals) >= policy.minimum_calibration_examples
                and empirical_spread <= 1e-12
            ):
                reasons.append("degenerate_calibration_distribution")
    else:
        sigma = min(policy.maximum_sigma, market_sigma)
        return_quantiles = {
            probability: raw_center + Z_SCORES[probability] * sigma
            for probability in REQUIRED_QUANTILES
        }

    # Evidence quality is part of the forecast itself, not only its display
    # confidence. The policy's admissibility floor is the no-change anchor;
    # support grows linearly from that floor to full strength at quality one.
    # ``maximum_sigma`` caps pre-adjustment uncertainty. The separately bounded
    # evidence multiplier must still widen a saturated base distribution.
    minimum_quality = policy.minimum_evidence_quality
    evidence_weight = (
        1.0
        if minimum_quality == 1 and features.evidence_quality == 1
        else 0.0
        if minimum_quality == 1
        else max(0.0, min(
            1.0,
            (features.evidence_quality - minimum_quality) / (1 - minimum_quality),
        ))
    )
    spread_multiplier = 1 + (1 - evidence_weight) * (
        policy.maximum_evidence_interval_multiplier - 1
    )
    evidence_sigma = sigma * spread_multiplier
    center = raw_center * evidence_weight
    return_quantiles = {
        probability: center + (value - raw_center) * spread_multiplier
        for probability, value in return_quantiles.items()
    }
    adjusted_calibration_distribution = (
        tuple(sorted(
            center + (residual - residual_center) * spread_multiplier
            for residual in residuals
        ))
        if use_empirical_calibration else ()
    )
    if any(not isfinite(value) for value in adjusted_calibration_distribution):
        raise ValueError("adjusted calibration distribution must be finite")
    if evidence_weight < 1:
        reasons.append("evidence_quality_adjusted")

    # A positive affine transform preserves quantile order. Validate rather
    # than silently sorting, which would hide a crossed/non-finite model output.
    return_quantiles = dict(validate_quantiles(return_quantiles))
    try:
        quantiles = {
            probability: features.current_price * exp(value)
            for probability, value in return_quantiles.items()
        }
    except OverflowError as exc:
        raise ValueError("forecast quantiles overflowed") from exc
    if any(not isfinite(value) or value <= 0 for value in quantiles.values()):
        raise ValueError("forecast quantiles must be finite and positive")
    probability_up = (
        sum(value > 0 for value in adjusted_calibration_distribution)
        / len(adjusted_calibration_distribution)
        if adjusted_calibration_distribution
        else _normal_probability_up(center, evidence_sigma)
    )
    fatal_reasons = {
        "insufficient_training_examples", "insufficient_history", "low_evidence_quality",
        "insufficient_calibration_examples", "degenerate_calibration_distribution",
    }
    status = "quarantined" if fatal_reasons.intersection(reasons) else "research_only"
    support = min(
        1.0,
        len(eligible) / max(policy.minimum_training_examples * 2, 1),
        len(residuals) / max(policy.minimum_calibration_examples * 2, 1),
    )
    confidence = 0.0 if status == "quarantined" else min(79.0, 100 * features.evidence_quality * support)
    model_definition = {
        "modelVersion": model_version,
        "horizon": horizon,
        "policy": policy.as_dict(),
        "candidateModels": tuple(sorted(candidates)),
        "selectionMethod": "inverse-validation-mae-softmax",
        "calibrationMethod": "origin-blocked-residual-quantiles-with-horizon-embargo",
        "evidenceAdjustmentMethod": "floor-anchored-shrink-and-widen-log-interval-v2",
    }
    fitted_artifact = {
        "modelDefinitionHash": _canonical_hash(model_definition),
        "trainingCutoff": cutoff.isoformat(),
        "weights": weights,
        "losses": losses,
        "seriesIdentity": None if series_key is None else series_key.exact_identity,
        "eligibleExamplesHash": _canonical_hash([
            {
                "variantId": value.features.variant_id,
                "origin": value.features.origin.isoformat(),
                "horizon": value.horizon_days,
                "realizedPrice": value.realized_price,
                "labelAvailableAt": value.label_available_at.isoformat(),
                "targetObservationIds": value.target_observation_ids,
                "marketSeriesId": value.market_series_id,
                "candidateUniverseId": value.candidate_universe_id,
            }
            for value in eligible
        ]),
        "selectionOrigins": sorted({value.features.origin.isoformat() for value in validation}),
        "calibrationOrigins": sorted({value.features.origin.isoformat() for value in calibration}),
        "trainingOrigins": sorted({value.features.origin.isoformat() for value in eligible}),
        "targetMarketSeriesId": target_market_series_id,
    }
    return ShadowForecast(
        features.variant_id,
        features.cohort_key,
        features.origin,
        horizon,
        features.current_price,
        quantiles,
        max(0.0, min(1.0, probability_up)),
        confidence,
        weights,
        losses,
        len(residuals),
        len(eligible),
        status,
        tuple(reasons),
        model_version,
        _canonical_hash(model_definition),
        _canonical_hash(fitted_artifact),
        adjusted_calibration_distribution,
        target_market_series_id,
    )


@dataclass(frozen=True, slots=True)
class ShadowForecastLedgerItem:
    """Bind one shadow estimate to its immutable trend-snapshot identity."""

    forecast: ShadowForecast
    snapshot: TrendSnapshot
    trend_snapshot_id: str
    market_series_id: str | None = None
    evidence_mode: str = "retrospective"

    def __post_init__(self) -> None:
        if not isinstance(self.forecast, ShadowForecast) or not isinstance(self.snapshot, TrendSnapshot):
            raise ValueError("ledger items require a ShadowForecast and TrendSnapshot")
        if self.forecast.variant_id != self.snapshot.key.canonical_variant_id:
            raise ValueError("shadow forecast and trend snapshot variants differ")
        if self.forecast.origin < self.snapshot.feature_cutoff:
            raise ValueError("trend snapshot feature cutoff exceeds shadow forecast origin")
        if abs(self.forecast.current_price - self.snapshot.current_price) > 1e-9:
            raise ValueError("shadow forecast and trend snapshot current prices differ")
        if self.market_series_id is not None:
            try:
                normalized = str(UUID(str(self.market_series_id)))
            except (TypeError, ValueError, AttributeError) as exc:
                raise ValueError("market_series_id must be a UUID") from exc
            object.__setattr__(self, "market_series_id", normalized)
        if self.evidence_mode not in {"retrospective", "prospective"}:
            raise ValueError("evidence_mode must be retrospective or prospective")
        if self.evidence_mode == "prospective" and self.market_series_id is None:
            raise ValueError("prospective ledger items require a market series")
        if (
            self.forecast.market_series_id is not None
            and self.market_series_id != self.forecast.market_series_id
        ):
            raise ValueError("ledger market series differs from forecast lineage")


def build_shadow_forecast_packet(
    model: ResearchModelCard,
    items: Iterable[ShadowForecastLedgerItem],
    terms: SourceTerms,
    *,
    analytics_run_id: str,
) -> ResearchForecastPacket:
    """Convert calibrated shadow estimates to the existing private ledger rows."""

    if not isinstance(model, ResearchModelCard) or model.model_family != "quantile_return_forecast":
        raise ValueError("shadow packets require a quantile_return_forecast model card")
    implemented_model_version = _model_version(model.version)
    _model_version(model.lineage.model_version)
    if not isinstance(terms, SourceTerms):
        raise ValueError("terms must be SourceTerms")
    values = tuple(items)
    if not values or any(not isinstance(item, ShadowForecastLedgerItem) for item in values):
        raise ValueError("at least one ShadowForecastLedgerItem is required")
    predictions: list[ResearchForecastPrediction] = []
    identities: set[tuple[str, datetime, int]] = set()
    for item in values:
        forecast = item.forecast
        forecast_model_version = _model_version(forecast.model_version)
        identity = (forecast.variant_id, forecast.origin, forecast.horizon_days)
        if identity in identities:
            raise ValueError("shadow packet contains a duplicate variant/origin/horizon")
        identities.add(identity)
        if forecast.horizon_days not in model.allowed_horizons:
            raise ValueError("shadow horizon is not allowed by the model card")
        if forecast_model_version != implemented_model_version:
            raise ValueError("shadow forecast version differs from the model card")
        if model.model_definition_hash != forecast.model_definition_hash:
            raise ValueError("shadow model definition differs from the model card")
        if model.model_artifact_hash not in {None, forecast.artifact_hash}:
            raise ValueError("shadow artifact hash differs from the origin-specific model card")
        if item.snapshot.key.source_id != terms.source_id:
            raise ValueError("shadow trend snapshot source differs from source terms")
        if not terms.permits_research_ingestion(forecast.origin):
            raise PermissionError("current source terms do not permit shadow forecasting")
        predictions.append(ResearchForecastPrediction(
            analytics_run_id=analytics_run_id,
            model=model,
            trend_snapshot_id=item.trend_snapshot_id,
            snapshot=item.snapshot,
            terms=terms,
            origin=forecast.origin,
            horizon_days=forecast.horizon_days,
            quantiles=forecast.quantiles,
            probability_up=forecast.probability_up,
            confidence=forecast.confidence,
            prediction_status=forecast.status,
            reason_codes=forecast.reason_codes,
            market_series_id=item.market_series_id,
            evidence_mode=item.evidence_mode,
        ))
    rows = tuple(prediction.database_row() for prediction in predictions)
    model_row = model.database_row()
    return ResearchForecastPacket(
        model_row=model_row,
        prediction_rows=rows,
        packet_hash=_canonical_hash({"model": model_row, "predictions": rows}),
        public_publication_allowed=False,
    )


@dataclass(frozen=True, slots=True)
class AcquisitionCosts:
    offer_price: float
    tax_rate: float = 0.0
    buy_shipping: float = 0.0
    sell_fee_rate: float = 0.13
    sell_fee_fixed: float = 0.0
    sell_shipping: float = 0.0
    liquidity_haircut_rate: float | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "offer_price", _positive(self.offer_price, "offer_price"))
        object.__setattr__(self, "tax_rate", _bounded(
            self.tax_rate, 0, 1, "tax_rate",
        ))
        sell_fee_rate = _finite(self.sell_fee_rate, "sell_fee_rate")
        if sell_fee_rate < 0 or sell_fee_rate >= 1:
            raise ValueError("sell_fee_rate must be at least 0 and less than 1")
        object.__setattr__(self, "sell_fee_rate", sell_fee_rate)
        for name in ("buy_shipping", "sell_fee_fixed", "sell_shipping"):
            value = _finite(getattr(self, name), name)
            if value < 0:
                raise ValueError(f"{name} cannot be negative")
            object.__setattr__(self, name, value)
        if self.liquidity_haircut_rate is not None:
            haircut = _finite(self.liquidity_haircut_rate, "liquidity_haircut_rate")
            if haircut < 0 or haircut >= 1:
                raise ValueError(
                    "liquidity_haircut_rate must be at least 0 and less than 1"
                )
            object.__setattr__(self, "liquidity_haircut_rate", haircut)

    @property
    def all_in_cost(self) -> float:
        return self.offer_price * (1 + self.tax_rate) + self.buy_shipping

    @property
    def break_even_resale_price(self) -> float:
        """Fee-only gross sale price needed to recover the all-in acquisition cost."""

        return (
            self.all_in_cost + self.sell_fee_fixed + self.sell_shipping
        ) / (1 - self.sell_fee_rate)

    @property
    def liquidity_adjusted_break_even_reference(self) -> float | None:
        """Reference price needed after applying a source-backed liquidity haircut."""

        if self.liquidity_haircut_rate is None:
            return None
        return self.break_even_resale_price / (1 - self.liquidity_haircut_rate)

    def net_exit(self, gross_price: float) -> float:
        haircut = self.liquidity_haircut_rate or 0.0
        return (
            gross_price * (1 - self.sell_fee_rate) * (1 - haircut)
            - self.sell_fee_fixed
            - self.sell_shipping
        )


@dataclass(frozen=True, slots=True)
class AcquisitionQuoteKey:
    """Point-in-time identity for one after-cost forecast evaluation."""

    market_series_id: str
    forecast_origin: datetime
    horizon_days: int
    currency: str
    quoted_at: datetime

    def __post_init__(self) -> None:
        object.__setattr__(
            self, "market_series_id", _uuid(self.market_series_id, "market_series_id")
        )
        origin = _utc(self.forecast_origin, "forecast_origin")
        quoted = _utc(self.quoted_at, "quoted_at")
        if quoted > origin:
            raise ValueError("cost quote cannot become known after the forecast origin")
        object.__setattr__(self, "forecast_origin", origin)
        object.__setattr__(self, "quoted_at", quoted)
        object.__setattr__(self, "horizon_days", _horizon(self.horizon_days))
        currency = str(self.currency or "").strip().upper()
        if len(currency) != 3 or not currency.isalpha():
            raise ValueError("currency must be a three-letter code")
        object.__setattr__(self, "currency", currency)


@dataclass(frozen=True, slots=True)
class WatchCandidate:
    variant_id: str
    horizon_days: int
    all_in_cost: float
    conservative_net_roi: float
    median_net_roi: float
    probability_net_positive: float
    evidence_quality: float
    interval_log_width: float
    status: str
    reason_codes: tuple[str, ...]


def build_watch_candidate(
    forecast: ShadowForecast,
    costs: AcquisitionCosts,
    *,
    evidence_quality: float,
    structural_lower_price: float | None = None,
    minimum_probability_net_positive: float = 0.70,
) -> WatchCandidate:
    """Apply transparent after-cost gates to one shadow forecast."""

    if not isinstance(forecast, ShadowForecast) or not isinstance(costs, AcquisitionCosts):
        raise ValueError("forecast and costs must use forecast-engine contracts")
    quality = _bounded(evidence_quality, 0, 1, "evidence_quality")
    threshold = _bounded(
        minimum_probability_net_positive, 0, 1, "minimum_probability_net_positive",
    )
    all_in = costs.all_in_cost
    net_returns = {
        probability: costs.net_exit(price) / all_in - 1
        for probability, price in forecast.quantiles.items()
    }
    q25_roi = net_returns[0.25]
    median_roi = net_returns[0.50]
    break_even_gross = (
        costs.liquidity_adjusted_break_even_reference
        or costs.break_even_resale_price
    )
    break_even_log_return = log(break_even_gross / forecast.current_price)
    calibrated = tuple(forecast.calibration_distribution)
    probability_positive = (
        sum(value > break_even_log_return for value in calibrated) / len(calibrated)
        if calibrated else 0.0
    )
    reasons: list[str] = []
    if forecast.status != "research_only":
        reasons.append("forecast_not_research_eligible")
    if q25_roi <= 0:
        reasons.append("conservative_net_return_not_positive")
    if probability_positive < threshold:
        reasons.append("net_probability_below_threshold")
    if not calibrated:
        reasons.append("after_cost_probability_uncalibrated")
    if structural_lower_price is None:
        reasons.append("structural_lower_bound_missing")
    elif _positive(structural_lower_price, "structural_lower_price") <= all_in:
        reasons.append("structural_lower_bound_not_above_cost")
    if costs.liquidity_haircut_rate is None:
        reasons.append("liquidity_unknown")
    status = "watch_candidate" if not reasons else "not_selected"
    return WatchCandidate(
        forecast.variant_id,
        forecast.horizon_days,
        all_in,
        q25_roi,
        median_roi,
        probability_positive,
        quality,
        log(forecast.quantiles[0.90] / forecast.quantiles[0.10]),
        status,
        tuple(reasons),
    )


@dataclass(frozen=True, slots=True)
class SelectedPocketEvaluation:
    candidate_count: int
    reference_positive_rate: float | None
    median_reference_implied_net_roi: float | None
    reference_false_discovery_rate: float | None
    mean_conservative_reference_error: float | None
    outcome_semantics: str = "provider_reference_implied_net_roi"

    # Compatibility aliases for private callers created before the outcome was
    # labeled precisely. Serialized reports use the truthful reference names.
    @property
    def realized_positive_rate(self) -> float | None:
        return self.reference_positive_rate

    @property
    def median_realized_net_roi(self) -> float | None:
        return self.median_reference_implied_net_roi

    @property
    def false_discovery_rate(self) -> float | None:
        return self.reference_false_discovery_rate

    @property
    def mean_conservative_forecast_error(self) -> float | None:
        return self.mean_conservative_reference_error


def evaluate_selected_pockets(
    outcomes: Iterable[tuple[WatchCandidate, float]],
) -> SelectedPocketEvaluation:
    """Evaluate selected cards against matured provider-reference prices.

    This is not executed-sale ROI. The outcome applies the origin-time cost
    assumptions to the later exact-series provider reference.
    """

    selected: list[tuple[WatchCandidate, float]] = []
    for candidate, reference_implied_net_roi in outcomes:
        if not isinstance(candidate, WatchCandidate):
            raise ValueError("outcomes must contain WatchCandidate values")
        reference_roi = _finite(
            reference_implied_net_roi, "reference_implied_net_roi",
        )
        if candidate.status == "watch_candidate":
            selected.append((candidate, reference_roi))
    if not selected:
        return SelectedPocketEvaluation(0, None, None, None, None)
    realized_values = [value for _, value in selected]
    false_discoveries = sum(value <= 0 for value in realized_values)
    return SelectedPocketEvaluation(
        len(selected),
        sum(value > 0 for value in realized_values) / len(selected),
        float(median(realized_values)),
        false_discoveries / len(selected),
        sum(abs(candidate.conservative_net_roi - realized) for candidate, realized in selected) / len(selected),
    )


@dataclass(frozen=True, slots=True)
class AfterCostProbabilityEvaluation:
    case_count: int
    brier_score: float | None
    calibration_error: float | None
    outcome_semantics: str = "provider_reference_net_proceeds_exceed_cost"


def _evaluate_after_cost_probability(
    cases: Iterable[tuple[float, bool]],
    bins: int = 10,
) -> AfterCostProbabilityEvaluation:
    values = tuple(cases)
    if not values:
        return AfterCostProbabilityEvaluation(0, None, None)
    validated = tuple(
        (_bounded(probability, 0, 1, "after_cost_probability"), bool(outcome))
        for probability, outcome in values
    )
    brier = sum(
        (probability - float(outcome)) ** 2
        for probability, outcome in validated
    ) / len(validated)
    calibration = 0.0
    for index in range(bins):
        lower = index / bins
        upper = (index + 1) / bins
        bucket = [
            value for value in validated
            if lower <= value[0] < upper
            or (index == bins - 1 and value[0] == 1)
        ]
        if not bucket:
            continue
        predicted = sum(value[0] for value in bucket) / len(bucket)
        observed = sum(value[1] for value in bucket) / len(bucket)
        calibration += len(bucket) / len(validated) * abs(predicted - observed)
    return AfterCostProbabilityEvaluation(len(validated), brier, calibration)


@dataclass(frozen=True, slots=True)
class ShadowEvaluationPolicy:
    """Breadth and uncertainty gates beyond the per-model scorecard."""

    minimum_cases: int = 200
    minimum_variants: int = 50
    minimum_sets: int = 5
    minimum_spaced_origins: int = 6
    minimum_origin_spacing_days: int = 21
    bootstrap_samples: int = 600
    confidence_level: float = 0.95
    minimum_lift_lower_bound: float = 0.0
    minimum_probability_calibration_cases: int = 50
    minimum_after_cost_calibration_cases: int = 50
    maximum_after_cost_brier_score: float = 0.25
    maximum_after_cost_calibration_error: float = 0.10
    minimum_selected_pocket_cases: int = 30
    minimum_selected_positive_rate: float = 0.60
    minimum_selected_median_net_roi: float = 0.0
    maximum_selected_false_discovery_rate: float = 0.40
    promotion_policy: PromotionPolicy = PromotionPolicy(
        version="forecast-ensemble-promotion-v1",
        minimum_cases=200,
        minimum_baseline_lift=0.02,
        interval_80_coverage_min=0.72,
        interval_80_coverage_max=0.88,
        maximum_brier_score=0.25,
    )

    def __post_init__(self) -> None:
        for name in (
            "minimum_cases", "minimum_variants", "minimum_sets", "minimum_spaced_origins",
            "minimum_origin_spacing_days", "bootstrap_samples",
            "minimum_probability_calibration_cases",
            "minimum_after_cost_calibration_cases",
            "minimum_selected_pocket_cases",
        ):
            value = getattr(self, name)
            if isinstance(value, bool) or not isinstance(value, int) or value < 1:
                raise ValueError(f"{name} must be a positive integer")
        if self.bootstrap_samples > MAX_BOOTSTRAP_SAMPLES:
            raise ValueError(
                f"bootstrap_samples cannot exceed {MAX_BOOTSTRAP_SAMPLES}"
            )
        if self.minimum_origin_spacing_days > MAX_POLICY_SPACING_DAYS:
            raise ValueError(
                "minimum_origin_spacing_days cannot exceed "
                f"{MAX_POLICY_SPACING_DAYS}"
            )
        level = _bounded(self.confidence_level, 0, 1, "confidence_level")
        if not 0.5 < level < 1:
            raise ValueError("confidence_level must be between 0.5 and 1")
        _finite(self.minimum_lift_lower_bound, "minimum_lift_lower_bound")
        object.__setattr__(self, "maximum_after_cost_brier_score", _bounded(
            self.maximum_after_cost_brier_score, 0, 1,
            "maximum_after_cost_brier_score",
        ))
        object.__setattr__(self, "maximum_after_cost_calibration_error", _bounded(
            self.maximum_after_cost_calibration_error, 0, 1,
            "maximum_after_cost_calibration_error",
        ))
        object.__setattr__(self, "minimum_selected_positive_rate", _bounded(
            self.minimum_selected_positive_rate, 0, 1, "minimum_selected_positive_rate",
        ))
        object.__setattr__(self, "minimum_selected_median_net_roi", _finite(
            self.minimum_selected_median_net_roi, "minimum_selected_median_net_roi",
        ))
        object.__setattr__(self, "maximum_selected_false_discovery_rate", _bounded(
            self.maximum_selected_false_discovery_rate,
            0,
            1,
            "maximum_selected_false_discovery_rate",
        ))
        if not isinstance(self.promotion_policy, PromotionPolicy):
            raise ValueError("promotion_policy must be PromotionPolicy")


def _spaced_origins(origins: Iterable[datetime], spacing_days: int) -> tuple[datetime, ...]:
    selected: list[datetime] = []
    for origin in sorted(set(origins)):
        if not selected or origin - selected[-1] >= timedelta(days=spacing_days):
            selected.append(origin)
    return tuple(selected)


def _clustered_lift_interval(
    errors: Sequence[tuple[datetime, float, float]],
    *,
    samples: int,
    confidence_level: float,
    seed_key: str,
) -> tuple[float, float] | None:
    """Origin-cluster bootstrap for model lift over one baseline."""

    clusters: dict[datetime, list[tuple[float, float]]] = {}
    for origin, model_error, baseline_error in errors:
        clusters.setdefault(origin, []).append((model_error, baseline_error))
    origins = tuple(sorted(clusters))
    if len(origins) < 2:
        return None
    seed = int(sha256(seed_key.encode("utf-8")).hexdigest()[:16], 16)
    random = Random(seed)
    estimates: list[float] = []
    for _ in range(samples):
        sampled = [origins[random.randrange(len(origins))] for _ in origins]
        pairs = [pair for origin in sampled for pair in clusters[origin]]
        model_mean = sum(value[0] for value in pairs) / len(pairs)
        baseline_mean = sum(value[1] for value in pairs) / len(pairs)
        if baseline_mean > 0:
            estimates.append(1 - model_mean / baseline_mean)
    if not estimates:
        return None
    tail = (1 - confidence_level) / 2
    return _empirical_quantile(estimates, tail), _empirical_quantile(estimates, 1 - tail)


@dataclass(frozen=True, slots=True)
class DeclaredPanelCoverage:
    """Fail-closed coverage for a caller-declared retrospective panel slice."""

    planned_count: int
    feature_abstained_count: int
    open_count: int
    scored_count: int
    unscorable_count: int
    cell_ledger_sha256: str
    promotion_block_reason_codes: tuple[str, ...]
    universe_completeness: str = "declared_only"
    evidence_timing: str = "retrospective"
    prospective_evidence_eligible: bool = False
    catalog_metadata_authority: str = "caller_declared_export"

    def __post_init__(self) -> None:
        counts = (
            self.planned_count,
            self.feature_abstained_count,
            self.open_count,
            self.scored_count,
            self.unscorable_count,
        )
        if any(
            isinstance(value, bool) or not isinstance(value, int) or value < 0
            for value in counts
        ):
            raise ValueError("declared panel coverage counts must be non-negative integers")
        if sum(counts[1:]) != self.planned_count:
            raise ValueError("declared panel coverage states must reconcile to planned_count")
        digest = str(self.cell_ledger_sha256 or "").strip().lower()
        if len(digest) != 64 or any(value not in "0123456789abcdef" for value in digest):
            raise ValueError("cell_ledger_sha256 must be a SHA-256 digest")
        object.__setattr__(self, "cell_ledger_sha256", digest)
        blockers = tuple(
            str(value or "").strip() for value in self.promotion_block_reason_codes
        )
        if not blockers or any(not value for value in blockers) or len(set(blockers)) != len(blockers):
            raise ValueError("promotion block reason codes must be unique and non-empty")
        object.__setattr__(self, "promotion_block_reason_codes", blockers)
        if self.universe_completeness != "declared_only":
            raise ValueError("declared panel universe completeness must be declared_only")
        if self.evidence_timing != "retrospective":
            raise ValueError("declared panel evidence timing must be retrospective")
        if self.prospective_evidence_eligible is not False:
            raise ValueError("declared panel evidence cannot be prospectively eligible")
        if self.catalog_metadata_authority != "caller_declared_export":
            raise ValueError(
                "declared panel catalog metadata authority must be caller_declared_export"
            )

    def as_dict(self) -> dict[str, object]:
        return {
            "plannedCount": self.planned_count,
            "featureAbstainedCount": self.feature_abstained_count,
            "openCount": self.open_count,
            "scoredCount": self.scored_count,
            "unscorableCount": self.unscorable_count,
            "cellLedgerSha256": self.cell_ledger_sha256,
            "universeCompleteness": self.universe_completeness,
            "evidenceTiming": self.evidence_timing,
            "prospectiveEvidenceEligible": self.prospective_evidence_eligible,
            "catalogMetadataAuthority": self.catalog_metadata_authority,
            "promotionBlockReasonCodes": list(self.promotion_block_reason_codes),
        }


@dataclass(frozen=True, slots=True)
class ShadowWalkForwardReport:
    horizon_days: int
    cohort_key: str
    forecasts: tuple[ShadowForecast, ...]
    scored_cases: int
    quarantined_cases: int
    variant_count: int
    set_count: int
    spaced_origin_count: int
    baseline_lifts: Mapping[str, float | None]
    baseline_lift_intervals: Mapping[str, tuple[float, float] | None]
    scorecard: ResearchScorecard | None
    after_cost_probability: AfterCostProbabilityEvaluation
    candidate_universe_member_count: int
    cost_evidence_case_count: int
    selected_pockets: SelectedPocketEvaluation
    recommendation: str
    reason_codes: tuple[str, ...]
    lineage: ResearchLineage
    report_hash: str
    declared_panel_coverage: DeclaredPanelCoverage | None = None
    public_publication_allowed: bool = False

    def as_dict(self) -> dict[str, object]:
        return {
            "horizonDays": self.horizon_days,
            "cohortKey": self.cohort_key,
            "forecastCount": len(self.forecasts),
            "scoredCases": self.scored_cases,
            "quarantinedCases": self.quarantined_cases,
            "variantCount": self.variant_count,
            "setCount": self.set_count,
            "spacedOriginCount": self.spaced_origin_count,
            "baselineLifts": dict(self.baseline_lifts),
            "baselineLiftIntervals": {
                name: list(value) if value is not None else None
                for name, value in self.baseline_lift_intervals.items()
            },
            "scorecard": None if self.scorecard is None else {
                "recommendation": self.scorecard.recommendation,
                "reasonCodes": list(self.scorecard.reason_codes),
                "operatorReviewRequired": self.scorecard.operator_review_required,
                "metrics": dict(self.scorecard.metrics),
            },
            "afterCostProbability": {
                "caseCount": self.after_cost_probability.case_count,
                "brierScore": self.after_cost_probability.brier_score,
                "calibrationError": self.after_cost_probability.calibration_error,
                "outcomeSemantics": self.after_cost_probability.outcome_semantics,
            },
            "candidateUniverseMemberCount": self.candidate_universe_member_count,
            "costEvidenceCaseCount": self.cost_evidence_case_count,
            "selectedPockets": {
                "candidateCount": self.selected_pockets.candidate_count,
                "referencePositiveRate": self.selected_pockets.reference_positive_rate,
                "medianReferenceImpliedNetRoi": self.selected_pockets.median_reference_implied_net_roi,
                "referenceFalseDiscoveryRate": self.selected_pockets.reference_false_discovery_rate,
                "meanConservativeReferenceError": self.selected_pockets.mean_conservative_reference_error,
                "outcomeSemantics": self.selected_pockets.outcome_semantics,
            },
            "recommendation": self.recommendation,
            "reasonCodes": list(self.reason_codes),
            "lineage": {
                "datasetSha256": self.lineage.dataset_sha256,
                "codeVersion": self.lineage.code_version,
                "featureVersion": self.lineage.feature_version,
                "mappingVersion": self.lineage.mapping_version,
                "modelVersion": self.lineage.model_version,
            },
            "reportHash": self.report_hash,
            "declaredPanelCoverage": (
                None
                if self.declared_panel_coverage is None
                else self.declared_panel_coverage.as_dict()
            ),
            "publicPublicationAllowed": False,
        }


def run_shadow_walk_forward(
    examples: Iterable[MaturedTrainingExample],
    horizon_days: int,
    cohort_key: str,
    series_keys: Mapping[str, PriceSeriesKey],
    lineage: ResearchLineage,
    *,
    engine_policy: ForecastEnginePolicy = ForecastEnginePolicy(),
    evaluation_policy: ShadowEvaluationPolicy = ShadowEvaluationPolicy(),
    costs: Mapping[AcquisitionQuoteKey, AcquisitionCosts] | None = None,
    declared_panel_coverage: DeclaredPanelCoverage | None = None,
) -> ShadowWalkForwardReport:
    """Run honest rolling-origin evaluation and breadth/pocket promotion gates."""

    horizon = _horizon(horizon_days)
    cohort = str(cohort_key or "").strip()
    if not cohort:
        raise ValueError("cohort_key must be non-empty")
    if not isinstance(lineage, ResearchLineage):
        raise ValueError("lineage must be ResearchLineage")
    if lineage.model_version != DEFAULT_FORECAST_MODEL_VERSION:
        raise ValueError(
            f"model_version must equal {DEFAULT_FORECAST_MODEL_VERSION} for implemented v2 math"
        )
    values = tuple(sorted(
        (
            value for value in examples
            if isinstance(value, MaturedTrainingExample)
            and value.horizon_days == horizon
            and value.features.cohort_key == cohort
        ),
        key=lambda value: (value.features.origin, value.features.variant_id),
    ))
    if declared_panel_coverage is not None:
        if not isinstance(declared_panel_coverage, DeclaredPanelCoverage):
            raise ValueError("declared_panel_coverage must be DeclaredPanelCoverage or None")
        if declared_panel_coverage.scored_count != len(values):
            raise ValueError("declared panel scored coverage differs from evaluation examples")
    if not values and declared_panel_coverage is None:
        raise ValueError("walk-forward evaluation has no matching examples")
    universe_by_origin: dict[tuple[datetime, int], str] = {}
    for example in values:
        if example.candidate_universe_id is None:
            continue
        origin_key = (example.features.origin, example.horizon_days)
        current_universe = universe_by_origin.setdefault(
            origin_key, example.candidate_universe_id,
        )
        if current_universe != example.candidate_universe_id:
            raise ValueError("one forecast origin cannot mix candidate-universe snapshots")
    cost_index: dict[tuple[str, datetime, int, str], AcquisitionCosts] = {}
    if costs is not None:
        for quote, acquisition in costs.items():
            if not isinstance(quote, AcquisitionQuoteKey) or not isinstance(acquisition, AcquisitionCosts):
                raise ValueError("costs must map AcquisitionQuoteKey to AcquisitionCosts")
            identity = (
                quote.market_series_id,
                quote.forecast_origin,
                quote.horizon_days,
                quote.currency,
            )
            if identity in cost_index:
                raise ValueError("cost evidence contains ambiguous quote timestamps")
            cost_index[identity] = acquisition
    forecasts: list[ShadowForecast] = []
    cases: list[ForecastCase] = []
    scored_examples: list[MaturedTrainingExample] = []
    baseline_errors: dict[str, list[tuple[datetime, float, float]]] = {
        name: [] for name in ("no_change", "damped_momentum", "market_index", "lifecycle_cohort", "structural_convergence")
    }
    pocket_outcomes: list[tuple[WatchCandidate, float]] = []
    after_cost_probability_cases: list[tuple[float, bool]] = []
    cost_evidence_case_count = 0
    quarantined = 0
    for example in values:
        forecast = train_shadow_forecast(
            example.features,
            values,
            horizon,
            example.features.origin,
            policy=engine_policy,
            model_version=lineage.model_version,
            series_key=series_keys.get(example.features.variant_id),
            market_series_id=example.market_series_id,
        )
        forecasts.append(forecast)
        if forecast.status != "research_only":
            quarantined += 1
            continue
        key = series_keys.get(example.features.variant_id)
        if not isinstance(key, PriceSeriesKey):
            raise ValueError("every scored variant requires an exact PriceSeriesKey")
        eligible_training = [
            value for value in values
            if value.features.origin < example.features.origin
            and value.label_available_at <= example.features.origin
            and (value.series_key is None or value.series_key == key)
        ]
        latest_maturity = max((value.label_available_at for value in eligible_training), default=None)
        audit = WalkForwardAudit(
            example.features.origin,
            horizon,
            example.features.origin,
            example.features.origin,
            latest_maturity,
            example.label_available_at,
        )
        case = ForecastCase(
            audit,
            key,
            lineage,
            example.features.current_price,
            forecast.quantiles[0.50],
            example.realized_price,
            example.features.current_price,
            forecast.probability_up,
            forecast.quantiles,
        )
        cases.append(case)
        scored_examples.append(example)
        model_error = abs(log(forecast.quantiles[0.50] / example.realized_price))
        candidate_returns = _candidate_returns(example.features, horizon, engine_policy)
        for name in baseline_errors:
            if name in candidate_returns:
                baseline_price = example.features.current_price * exp(candidate_returns[name])
                baseline_errors[name].append((
                    example.features.origin,
                    model_error,
                    abs(log(baseline_price / example.realized_price)),
                ))
        if costs is not None:
            if example.market_series_id is None:
                raise ValueError("after-cost evaluation requires market-series lineage")
            acquisition = cost_index.get((
                example.market_series_id,
                example.features.origin,
                horizon,
                key.currency,
            ))
            if acquisition is not None:
                cost_evidence_case_count += 1
                candidate = build_watch_candidate(
                    forecast,
                    acquisition,
                    evidence_quality=example.features.evidence_quality,
                    structural_lower_price=example.features.structural_lower_price,
                )
                reference_implied_roi = (
                    acquisition.net_exit(example.realized_price)
                    / acquisition.all_in_cost - 1
                )
                pocket_outcomes.append((candidate, reference_implied_roi))
                after_cost_probability_cases.append((
                    candidate.probability_net_positive,
                    reference_implied_roi > 0,
                ))

    required_names = tuple(baseline_errors)
    baseline_lifts: dict[str, float | None] = {}
    lift_intervals: dict[str, tuple[float, float] | None] = {}
    for name in required_names:
        errors = baseline_errors[name]
        if len(errors) != len(cases) or not errors:
            baseline_lifts[name] = None
            lift_intervals[name] = None
            continue
        model_mean = sum(value[1] for value in errors) / len(errors)
        baseline_mean = sum(value[2] for value in errors) / len(errors)
        baseline_lifts[name] = 1 - model_mean / baseline_mean if baseline_mean > 0 else None
        lift_intervals[name] = _clustered_lift_interval(
            errors,
            samples=evaluation_policy.bootstrap_samples,
            confidence_level=evaluation_policy.confidence_level,
            seed_key=f"{lineage.dataset_sha256}:{cohort}:{horizon}:{name}",
        )
    scorecard = None
    if cases:
        summary = evaluate_cases(cases)
        scorecard = assess_research_scorecard(
            summary,
            policy=evaluation_policy.promotion_policy,
            baseline_results=baseline_lifts,
        )
    variants = {value.features.variant_id for value in scored_examples}
    sets = {value.features.set_id for value in scored_examples if value.features.set_id}
    candidate_universe_member_count = sum(
        value.candidate_universe_id is not None for value in scored_examples
    )
    spaced = _spaced_origins(
        (value.features.origin for value in scored_examples),
        evaluation_policy.minimum_origin_spacing_days,
    )
    reasons: list[str] = []
    if len(cases) < evaluation_policy.minimum_cases:
        reasons.append("insufficient_scored_cases")
    if len(cases) < evaluation_policy.minimum_probability_calibration_cases:
        reasons.append("insufficient_probability_calibration_cases")
    if len(variants) < evaluation_policy.minimum_variants:
        reasons.append("insufficient_variant_breadth")
    if len(sets) < evaluation_policy.minimum_sets:
        reasons.append("insufficient_set_breadth")
    if len(spaced) < evaluation_policy.minimum_spaced_origins:
        reasons.append("insufficient_origin_breadth")
    missing_intervals = [name for name in required_names if lift_intervals[name] is None]
    if missing_intervals:
        reasons.append("missing_clustered_lift_intervals")
    elif any(
        lift_intervals[name][0] <= evaluation_policy.minimum_lift_lower_bound
        for name in required_names
    ):
        reasons.append("lift_lower_bound_not_positive")
    if scorecard is None:
        reasons.append("missing_scorecard")
    elif scorecard.recommendation != "eligible_for_operator_review":
        reasons.extend(
            value for value in scorecard.reason_codes
            if value not in reasons
        )
    after_cost_probability = _evaluate_after_cost_probability(
        after_cost_probability_cases,
    )
    selected = evaluate_selected_pockets(pocket_outcomes)
    if costs is None:
        reasons.append("missing_after_cost_evidence")
    else:
        if cost_evidence_case_count < len(cases):
            reasons.append("incomplete_after_cost_candidate_universe")
        if candidate_universe_member_count < len(cases):
            reasons.append("missing_candidate_universe_lineage")
    if (
        after_cost_probability.case_count
        < evaluation_policy.minimum_after_cost_calibration_cases
    ):
        reasons.append("insufficient_after_cost_probability_calibration_cases")
    else:
        if (
            after_cost_probability.brier_score is None
            or after_cost_probability.brier_score
            > evaluation_policy.maximum_after_cost_brier_score
        ):
            reasons.append("after_cost_brier_above_threshold")
        if (
            after_cost_probability.calibration_error is None
            or after_cost_probability.calibration_error
            > evaluation_policy.maximum_after_cost_calibration_error
        ):
            reasons.append("after_cost_calibration_error_above_threshold")
    if selected.candidate_count < evaluation_policy.minimum_selected_pocket_cases:
        reasons.append("insufficient_selected_pocket_cases")
    if (
        selected.reference_positive_rate is not None
        and selected.reference_positive_rate < evaluation_policy.minimum_selected_positive_rate
    ):
        reasons.append("selected_reference_positive_rate_below_threshold")
    if (
        selected.median_reference_implied_net_roi is not None
        and selected.median_reference_implied_net_roi
        <= evaluation_policy.minimum_selected_median_net_roi
    ):
        reasons.append("selected_median_reference_implied_net_roi_below_threshold")
    if (
        selected.reference_false_discovery_rate is not None
        and selected.reference_false_discovery_rate
        > evaluation_policy.maximum_selected_false_discovery_rate
    ):
        reasons.append("selected_reference_false_discovery_rate_above_threshold")
    if declared_panel_coverage is not None:
        reasons.extend(
            reason
            for reason in declared_panel_coverage.promotion_block_reason_codes
            if reason not in reasons
        )
    if not reasons:
        recommendation = "eligible_for_operator_review"
    elif declared_panel_coverage is not None or any(
        value.startswith(("insufficient_", "missing_", "incomplete_"))
        for value in reasons
    ):
        recommendation = "insufficient"
    else:
        recommendation = "reject"
    report_body = {
        "horizon": horizon,
        "cohort": cohort,
        "lineage": {
            "datasetSha256": lineage.dataset_sha256,
            "codeVersion": lineage.code_version,
            "featureVersion": lineage.feature_version,
            "mappingVersion": lineage.mapping_version,
            "modelVersion": lineage.model_version,
        },
        "forecastHashes": [value.artifact_hash for value in forecasts],
        "scoredCases": len(cases),
        "quarantinedCases": quarantined,
        "variants": sorted(variants),
        "sets": sorted(sets),
        "spacedOrigins": [value.isoformat() for value in spaced],
        "baselineLifts": baseline_lifts,
        "liftIntervals": lift_intervals,
        "scorecard": None if scorecard is None else dict(scorecard.metrics),
        "afterCostProbability": {
            "caseCount": after_cost_probability.case_count,
            "brierScore": after_cost_probability.brier_score,
            "calibrationError": after_cost_probability.calibration_error,
            "outcomeSemantics": after_cost_probability.outcome_semantics,
        },
        "candidateUniverseMemberCount": candidate_universe_member_count,
        "costEvidenceCaseCount": cost_evidence_case_count,
        "selectedPockets": {
            "candidateCount": selected.candidate_count,
            "referencePositiveRate": selected.reference_positive_rate,
            "medianReferenceImpliedNetRoi": selected.median_reference_implied_net_roi,
            "referenceFalseDiscoveryRate": selected.reference_false_discovery_rate,
            "conservativeReferenceError": selected.mean_conservative_reference_error,
            "outcomeSemantics": selected.outcome_semantics,
        },
        "selectedPocketPolicy": {
            "minimumCases": evaluation_policy.minimum_selected_pocket_cases,
            "minimumPositiveRate": evaluation_policy.minimum_selected_positive_rate,
            "minimumMedianNetRoi": evaluation_policy.minimum_selected_median_net_roi,
            "maximumFalseDiscoveryRate": evaluation_policy.maximum_selected_false_discovery_rate,
            "minimumAfterCostCalibrationCases": evaluation_policy.minimum_after_cost_calibration_cases,
            "maximumAfterCostBrierScore": evaluation_policy.maximum_after_cost_brier_score,
            "maximumAfterCostCalibrationError": evaluation_policy.maximum_after_cost_calibration_error,
        },
        "recommendation": recommendation,
        "reasons": reasons,
        "declaredPanelCoverage": (
            None
            if declared_panel_coverage is None
            else declared_panel_coverage.as_dict()
        ),
    }
    return ShadowWalkForwardReport(
        horizon,
        cohort,
        tuple(forecasts),
        len(cases),
        quarantined,
        len(variants),
        len(sets),
        len(spaced),
        baseline_lifts,
        lift_intervals,
        scorecard,
        after_cost_probability,
        candidate_universe_member_count,
        cost_evidence_case_count,
        selected,
        recommendation,
        tuple(reasons),
        lineage,
        _canonical_hash(report_body),
        declared_panel_coverage,
    )
