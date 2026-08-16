"""Walk-forward audit contracts and forecast evaluation metrics."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from math import isfinite, log
import re
from statistics import mean, median
from typing import Iterable, Mapping

from .observations import PriceObservation, PriceSeriesKey, point_in_time_series
from .quantiles import REQUIRED_QUANTILES, validate_quantiles

SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")


def _utc(value: datetime, name: str) -> datetime:
    if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() is None:
        raise ValueError(f"{name} must be a timezone-aware datetime")
    return value.astimezone(timezone.utc)


def _positive(value: float, name: str) -> float:
    if isinstance(value, bool):
        raise ValueError(f"{name} must be finite and positive")
    try:
        numeric = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} must be finite and positive") from exc
    if not isfinite(numeric) or numeric <= 0:
        raise ValueError(f"{name} must be finite and positive")
    return numeric


def training_label_is_mature(
    feature_date: datetime,
    horizon_days: int,
    training_cutoff: datetime,
) -> bool:
    """Return whether ``feature_date + horizon`` matured by the cutoff."""

    feature = _utc(feature_date, "feature_date")
    cutoff = _utc(training_cutoff, "training_cutoff")
    if isinstance(horizon_days, bool) or not isinstance(horizon_days, int) or horizon_days <= 0:
        raise ValueError("horizon_days must be a positive integer")
    return feature + timedelta(days=horizon_days) <= cutoff


def assert_features_known(
    feature_timestamps: Iterable[datetime],
    feature_cutoff: datetime,
) -> None:
    """Fail a run when any feature became knowable after its cutoff."""

    cutoff = _utc(feature_cutoff, "feature_cutoff")
    timestamps = tuple(_utc(value, "feature_timestamp") for value in feature_timestamps)
    if any(value > cutoff for value in timestamps):
        raise ValueError("feature timestamp exceeds feature cutoff")


@dataclass(frozen=True, slots=True)
class WalkForwardAudit:
    origin: datetime
    horizon_days: int
    feature_cutoff: datetime
    training_cutoff: datetime
    latest_training_label_maturity: datetime | None
    evaluated_at: datetime

    def __post_init__(self) -> None:
        if isinstance(self.horizon_days, bool) or not isinstance(self.horizon_days, int) or self.horizon_days <= 0:
            raise ValueError("horizon_days must be a positive integer")
        origin = _utc(self.origin, "origin")
        feature_cutoff = _utc(self.feature_cutoff, "feature_cutoff")
        training_cutoff = _utc(self.training_cutoff, "training_cutoff")
        label_maturity = (
            _utc(self.latest_training_label_maturity, "latest_training_label_maturity")
            if self.latest_training_label_maturity is not None
            else None
        )
        evaluated_at = _utc(self.evaluated_at, "evaluated_at")
        if feature_cutoff > origin:
            raise ValueError("feature cutoff exceeds forecast origin")
        if training_cutoff > origin:
            raise ValueError("training cutoff exceeds forecast origin")
        if label_maturity is not None and label_maturity > training_cutoff:
            raise ValueError("training label had not matured by the training cutoff")
        if evaluated_at < origin + timedelta(days=self.horizon_days):
            raise ValueError("forecast was evaluated before its horizon matured")
        object.__setattr__(self, "origin", origin)
        object.__setattr__(self, "feature_cutoff", feature_cutoff)
        object.__setattr__(self, "training_cutoff", training_cutoff)
        object.__setattr__(self, "latest_training_label_maturity", label_maturity)
        object.__setattr__(self, "evaluated_at", evaluated_at)


@dataclass(frozen=True, slots=True)
class ResearchLineage:
    dataset_sha256: str
    code_version: str
    feature_version: str
    mapping_version: str
    model_version: str

    def __post_init__(self) -> None:
        dataset_hash = str(self.dataset_sha256).strip().lower()
        if not SHA256_PATTERN.fullmatch(dataset_hash):
            raise ValueError("dataset_sha256 must be a 64-character hexadecimal digest")
        object.__setattr__(self, "dataset_sha256", dataset_hash)
        for field_name in ("code_version", "feature_version", "mapping_version", "model_version"):
            value = getattr(self, field_name)
            if not isinstance(value, str) or not value.strip():
                raise ValueError(f"{field_name} must be non-empty")
            object.__setattr__(self, field_name, value.strip())


@dataclass(frozen=True, slots=True)
class RealizedPrice:
    maturity: datetime
    trailing_seven_day_median: float
    exact_date_price: float | None
    observation_count: int
    observation_ids: tuple[str, ...]


def realized_price_at_maturity(
    observations: Iterable[PriceObservation],
    maturity: datetime,
    evaluated_at: datetime,
    *,
    key: PriceSeriesKey | None = None,
) -> RealizedPrice:
    """Calculate the PRD's trailing seven-day median target after maturity."""

    maturity_utc = _utc(maturity, "maturity")
    evaluated_utc = _utc(evaluated_at, "evaluated_at")
    if evaluated_utc < maturity_utc:
        raise ValueError("realized price cannot be evaluated before maturity")
    known = point_in_time_series(observations, evaluated_utc, key=key)
    window_start = maturity_utc - timedelta(days=6)
    window = [
        item for item in known
        if window_start <= item.observed_at <= maturity_utc
        and item.available_at <= maturity_utc
    ]
    if not window:
        raise ValueError("no realized-price observations exist in the maturity window")
    observation_ids = tuple(str(item.source_observation_id or "").strip() for item in window)
    if any(not value for value in observation_ids) or len(set(observation_ids)) != len(observation_ids):
        raise ValueError("realized-price observations require unique immutable IDs")
    exact = [item for item in window if item.observed_at.date() == maturity_utc.date()]
    return RealizedPrice(
        maturity=maturity_utc,
        trailing_seven_day_median=float(median(item.price for item in window)),
        exact_date_price=exact[-1].price if exact else None,
        observation_count=len(window),
        observation_ids=observation_ids,
    )


@dataclass(frozen=True, slots=True)
class ForecastCase:
    audit: WalkForwardAudit
    key: PriceSeriesKey
    lineage: ResearchLineage
    current_price: float
    predicted_price: float
    realized_price: float
    baseline_price: float | None = None
    probability_up: float | None = None
    quantiles: Mapping[float, float] | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.audit, WalkForwardAudit):
            raise ValueError("audit must be a WalkForwardAudit")
        if not isinstance(self.key, PriceSeriesKey):
            raise ValueError("key must be a PriceSeriesKey")
        if not isinstance(self.lineage, ResearchLineage):
            raise ValueError("lineage must be ResearchLineage")
        object.__setattr__(self, "current_price", _positive(self.current_price, "current_price"))
        object.__setattr__(self, "predicted_price", _positive(self.predicted_price, "predicted_price"))
        object.__setattr__(self, "realized_price", _positive(self.realized_price, "realized_price"))
        if self.baseline_price is not None:
            object.__setattr__(self, "baseline_price", _positive(self.baseline_price, "baseline_price"))
        if self.probability_up is not None:
            if isinstance(self.probability_up, bool) or not isfinite(self.probability_up) or not 0 <= self.probability_up <= 1:
                raise ValueError("probability_up must be between zero and one")
            object.__setattr__(self, "probability_up", float(self.probability_up))
        if self.quantiles is not None:
            validated = validate_quantiles(self.quantiles, required=REQUIRED_QUANTILES)
            if any(value <= 0 for _, value in validated):
                raise ValueError("forecast price quantiles must be positive")
            object.__setattr__(self, "quantiles", dict(validated))


@dataclass(frozen=True, slots=True)
class EvaluationSummary:
    count: int
    mae_log_return: float
    median_absolute_percentage_error: float
    symmetric_mape: float
    median_absolute_dollar_error: float
    direction_accuracy: float
    direction_accuracy_10_percent: float | None
    direction_accuracy_25_percent: float | None
    baseline_relative_lift: float | None
    brier_score: float | None
    probability_calibration_error: float | None
    pinball_loss: Mapping[float, float] | None
    interval_50_coverage: float | None
    interval_80_coverage: float | None
    mean_interval_50_width: float | None
    mean_interval_80_width: float | None


def _direction(value: float, *, tolerance: float = 1e-12) -> int:
    if value > tolerance:
        return 1
    if value < -tolerance:
        return -1
    return 0


def _direction_accuracy(cases: tuple[ForecastCase, ...], threshold: float = 0) -> float | None:
    eligible = [
        case for case in cases
        if abs(case.realized_price / case.current_price - 1) >= threshold
    ]
    if not eligible:
        return None
    matches = sum(
        _direction(case.predicted_price / case.current_price - 1)
        == _direction(case.realized_price / case.current_price - 1)
        for case in eligible
    )
    return matches / len(eligible)


def _calibration_error(cases: tuple[ForecastCase, ...], bins: int = 10) -> float:
    total = len(cases)
    error = 0.0
    for index in range(bins):
        lower = index / bins
        upper = (index + 1) / bins
        bucket = [
            case for case in cases
            if lower <= case.probability_up < upper
            or (index == bins - 1 and case.probability_up == 1)
        ]
        if not bucket:
            continue
        predicted = mean(case.probability_up for case in bucket)
        observed = mean(case.realized_price > case.current_price for case in bucket)
        error += len(bucket) / total * abs(predicted - observed)
    return error


def _pinball(actual: float, predicted: float, probability: float) -> float:
    residual = actual - predicted
    return probability * residual if residual >= 0 else (probability - 1) * residual


def evaluate_cases(cases: Iterable[ForecastCase]) -> EvaluationSummary:
    """Evaluate one comparable walk-forward slice without automatic promotion."""

    values = tuple(cases)
    if not values or any(not isinstance(case, ForecastCase) for case in values):
        raise ValueError("at least one ForecastCase is required")
    horizons = {case.audit.horizon_days for case in values}
    if len(horizons) != 1:
        raise ValueError("evaluation slices cannot mix forecast horizons")

    log_errors = [abs(log(case.predicted_price / case.realized_price)) for case in values]
    percentage_errors = [abs(case.predicted_price - case.realized_price) / case.realized_price for case in values]
    symmetric_errors = [
        2 * abs(case.predicted_price - case.realized_price) / (case.predicted_price + case.realized_price)
        for case in values
    ]
    dollar_errors = [abs(case.predicted_price - case.realized_price) for case in values]

    baseline_lift = None
    if all(case.baseline_price is not None for case in values):
        baseline_error = mean(abs(log(case.baseline_price / case.realized_price)) for case in values)
        baseline_lift = 1 - mean(log_errors) / baseline_error if baseline_error > 0 else None

    brier = None
    calibration = None
    if all(case.probability_up is not None for case in values):
        brier = mean(
            (case.probability_up - float(case.realized_price > case.current_price)) ** 2
            for case in values
        )
        calibration = _calibration_error(values)

    pinball = None
    coverage_50 = None
    coverage_80 = None
    width_50 = None
    width_80 = None
    if all(case.quantiles is not None for case in values):
        pinball = {
            probability: mean(_pinball(case.realized_price, case.quantiles[probability], probability) for case in values)
            for probability in REQUIRED_QUANTILES
        }
        coverage_50 = mean(case.quantiles[0.25] <= case.realized_price <= case.quantiles[0.75] for case in values)
        coverage_80 = mean(case.quantiles[0.10] <= case.realized_price <= case.quantiles[0.90] for case in values)
        width_50 = mean(case.quantiles[0.75] - case.quantiles[0.25] for case in values)
        width_80 = mean(case.quantiles[0.90] - case.quantiles[0.10] for case in values)

    return EvaluationSummary(
        count=len(values),
        mae_log_return=mean(log_errors),
        median_absolute_percentage_error=median(percentage_errors),
        symmetric_mape=mean(symmetric_errors),
        median_absolute_dollar_error=median(dollar_errors),
        direction_accuracy=_direction_accuracy(values) or 0.0,
        direction_accuracy_10_percent=_direction_accuracy(values, 0.10),
        direction_accuracy_25_percent=_direction_accuracy(values, 0.25),
        baseline_relative_lift=baseline_lift,
        brier_score=brier,
        probability_calibration_error=calibration,
        pinball_loss=pinball,
        interval_50_coverage=coverage_50,
        interval_80_coverage=coverage_80,
        mean_interval_50_width=width_50,
        mean_interval_80_width=width_80,
    )
