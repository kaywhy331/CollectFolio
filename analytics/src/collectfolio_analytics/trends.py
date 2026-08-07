"""Dependency-free descriptive market trend features."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from math import isfinite, log
from statistics import median
from typing import Iterable, Sequence

from .observations import PriceObservation, PriceSeriesKey, point_in_time_series


@dataclass(frozen=True, slots=True)
class TrendThresholds:
    """Calibratable trend and freshness thresholds.

    Defaults reproduce the PRD's example z-score bands. A production model card
    must replace them with values calibrated on point-in-time history.
    """

    rise_z: float = 0.5
    strong_z: float = 1.5
    minimum_data_quality: float = 0.5
    minimum_observations: int = 7
    volatility_floor: float = 1e-6
    full_freshness_hours: float = 24.0
    stale_after_hours: float = 168.0

    def __post_init__(self) -> None:
        numeric = (
            self.rise_z,
            self.strong_z,
            self.minimum_data_quality,
            self.volatility_floor,
            self.full_freshness_hours,
            self.stale_after_hours,
        )
        if any(isinstance(value, bool) or not isfinite(value) for value in numeric):
            raise ValueError("trend thresholds must be finite")
        if not 0 < self.rise_z < self.strong_z:
            raise ValueError("z-score thresholds must satisfy 0 < rise_z < strong_z")
        if not 0 <= self.minimum_data_quality <= 1:
            raise ValueError("minimum_data_quality must be between zero and one")
        if (
            isinstance(self.minimum_observations, bool)
            or not isinstance(self.minimum_observations, int)
            or self.minimum_observations < 2
        ):
            raise ValueError("minimum_observations must be at least two")
        if self.volatility_floor <= 0:
            raise ValueError("volatility_floor must be positive")
        if self.full_freshness_hours < 0 or self.stale_after_hours <= self.full_freshness_hours:
            raise ValueError("stale_after_hours must exceed full_freshness_hours")


@dataclass(frozen=True, slots=True)
class TrendSnapshot:
    key: PriceSeriesKey
    feature_cutoff: datetime
    latest_observed_at: datetime
    current_price: float
    return_7d: float | None
    return_30d: float | None
    return_90d: float | None
    return_180d: float | None
    return_365d: float | None
    robust_slope_30d: float | None
    robust_slope_90d: float | None
    momentum_acceleration: float | None
    volatility_30d: float | None
    volatility_90d: float | None
    max_drawdown_180d: float | None
    history_density_90d: float
    staleness_hours: float
    source_quality_90d: float
    evidence_quality: float
    slope_z_90d: float | None
    trend_state: str
    observation_count_90d: int


def _ordered(observations: Iterable[PriceObservation]) -> tuple[PriceObservation, ...]:
    values = tuple(observations)
    if any(not isinstance(item, PriceObservation) for item in values):
        raise ValueError("observations must contain PriceObservation values")
    if values and any(item.key != values[0].key for item in values):
        raise ValueError("trend calculations cannot mix exact price-series identities")
    ordered = tuple(sorted(values, key=lambda item: item.observed_at))
    if len({item.observed_at for item in ordered}) != len(ordered):
        raise ValueError("trend calculations require a deduplicated point-in-time series")
    return ordered


def _trailing(
    observations: Sequence[PriceObservation],
    end: datetime,
    days: int,
) -> tuple[PriceObservation, ...]:
    start = end - timedelta(days=days)
    return tuple(item for item in observations if start <= item.observed_at <= end)


def theil_sen_log_slope(observations: Iterable[PriceObservation]) -> float:
    """Median pairwise log-price slope in calendar days."""

    values = _ordered(observations)
    slopes: list[float] = []
    for left_index, left in enumerate(values):
        for right in values[left_index + 1:]:
            elapsed_days = (right.observed_at - left.observed_at).total_seconds() / 86_400
            if elapsed_days > 0:
                slopes.append(log(right.price / left.price) / elapsed_days)
    if not slopes:
        raise ValueError("Theil-Sen slope requires two distinct observation times")
    return float(median(slopes))


def mad_log_return_volatility(observations: Iterable[PriceObservation]) -> float:
    """Scaled MAD of daily-normalized adjacent log returns."""

    values = _ordered(observations)
    returns: list[float] = []
    for left, right in zip(values, values[1:]):
        elapsed_days = (right.observed_at - left.observed_at).total_seconds() / 86_400
        if elapsed_days > 0:
            returns.append(log(right.price / left.price) / elapsed_days ** 0.5)
    if not returns:
        raise ValueError("volatility requires two distinct observation times")
    center = median(returns)
    return float(1.4826 * median(abs(value - center) for value in returns))


def max_drawdown(observations: Iterable[PriceObservation]) -> float:
    """Largest peak-to-trough loss magnitude, expressed from zero to one."""

    values = _ordered(observations)
    if not values:
        raise ValueError("drawdown requires at least one observation")
    peak = values[0].price
    drawdown = 0.0
    for item in values:
        peak = max(peak, item.price)
        drawdown = max(drawdown, (peak - item.price) / peak)
    return float(drawdown)


def endpoint_log_return(
    observations: Iterable[PriceObservation],
    horizon_days: int,
    *,
    max_reference_lag_days: float = 3.0,
) -> float | None:
    """Log return using only a reference at or before the horizon endpoint."""

    if isinstance(horizon_days, bool) or not isinstance(horizon_days, int) or horizon_days <= 0:
        raise ValueError("horizon_days must be a positive integer")
    if isinstance(max_reference_lag_days, bool) or not isfinite(max_reference_lag_days) or max_reference_lag_days < 0:
        raise ValueError("max_reference_lag_days must be finite and non-negative")
    values = _ordered(observations)
    if not values:
        return None
    latest = values[-1]
    target = latest.observed_at - timedelta(days=horizon_days)
    candidates = [item for item in values if item.observed_at <= target]
    if not candidates:
        return None
    reference = candidates[-1]
    lag = (target - reference.observed_at).total_seconds() / 86_400
    if lag > max_reference_lag_days:
        return None
    return float(log(latest.price / reference.price))


def history_density(
    observations: Iterable[PriceObservation],
    start: datetime,
    end: datetime,
    *,
    expected_interval_days: int = 1,
) -> float:
    """Observed unique UTC dates divided by expected sampling dates."""

    if (
        not isinstance(start, datetime)
        or start.tzinfo is None
        or start.utcoffset() is None
        or not isinstance(end, datetime)
        or end.tzinfo is None
        or end.utcoffset() is None
    ):
        raise ValueError("history-density bounds must be timezone-aware")
    start = start.astimezone(timezone.utc)
    end = end.astimezone(timezone.utc)
    if end < start:
        raise ValueError("history-density end cannot precede start")
    if (
        isinstance(expected_interval_days, bool)
        or not isinstance(expected_interval_days, int)
        or expected_interval_days <= 0
    ):
        raise ValueError("expected_interval_days must be positive")
    values = _ordered(observations)
    observed_dates = {
        item.observed_at.date()
        for item in values
        if start <= item.observed_at <= end
    }
    span_days = int((end.date() - start.date()).days)
    expected = span_days // expected_interval_days + 1
    return min(1.0, len(observed_dates) / expected) if expected else 0.0


def classify_trend(
    slope: float,
    volatility: float,
    *,
    data_quality: float,
    observation_count: int,
    thresholds: TrendThresholds = TrendThresholds(),
) -> tuple[str, float]:
    """Return provisional trend state and volatility-adjusted slope."""

    for value, name in ((slope, "slope"), (volatility, "volatility"), (data_quality, "data_quality")):
        if isinstance(value, bool) or not isfinite(value):
            raise ValueError(f"{name} must be finite")
    if volatility < 0:
        raise ValueError("volatility cannot be negative")
    if not 0 <= data_quality <= 1:
        raise ValueError("data_quality must be between zero and one")
    if isinstance(observation_count, bool) or observation_count < 0:
        raise ValueError("observation_count cannot be negative")

    slope_z = slope / max(volatility, thresholds.volatility_floor)
    if data_quality < thresholds.minimum_data_quality or observation_count < thresholds.minimum_observations:
        return "insufficient_data", float(slope_z)
    if slope_z >= thresholds.strong_z:
        return "strong_rise", float(slope_z)
    if slope_z >= thresholds.rise_z:
        return "rise", float(slope_z)
    if slope_z <= -thresholds.strong_z:
        return "strong_fall", float(slope_z)
    if slope_z <= -thresholds.rise_z:
        return "fall", float(slope_z)
    return "stable", float(slope_z)


def _freshness_score(staleness_hours: float, thresholds: TrendThresholds) -> float:
    if staleness_hours <= thresholds.full_freshness_hours:
        return 1.0
    if staleness_hours >= thresholds.stale_after_hours:
        return 0.0
    usable_span = thresholds.stale_after_hours - thresholds.full_freshness_hours
    return 1 - (staleness_hours - thresholds.full_freshness_hours) / usable_span


def build_trend_snapshot(
    observations: Iterable[PriceObservation],
    feature_cutoff: datetime,
    *,
    key: PriceSeriesKey | None = None,
    expected_interval_days: int = 1,
    max_reference_lag_days: float = 3.0,
    thresholds: TrendThresholds = TrendThresholds(),
) -> TrendSnapshot:
    """Build descriptive features from only information known at the cutoff."""

    series = point_in_time_series(observations, feature_cutoff, key=key)
    if not series:
        raise ValueError("no observations were known at the feature cutoff")
    latest = series[-1]
    cutoff = feature_cutoff.astimezone(latest.observed_at.tzinfo)
    trailing_30 = _trailing(series, latest.observed_at, 30)
    trailing_90 = _trailing(series, latest.observed_at, 90)
    trailing_180 = _trailing(series, latest.observed_at, 180)

    slope_30 = theil_sen_log_slope(trailing_30) if len(trailing_30) >= 2 else None
    slope_90 = theil_sen_log_slope(trailing_90) if len(trailing_90) >= 2 else None
    volatility_30 = mad_log_return_volatility(trailing_30) if len(trailing_30) >= 2 else None
    volatility_90 = mad_log_return_volatility(trailing_90) if len(trailing_90) >= 2 else None
    drawdown_180 = max_drawdown(trailing_180) if trailing_180 else None
    density_90 = history_density(
        trailing_90,
        latest.observed_at - timedelta(days=90),
        latest.observed_at,
        expected_interval_days=expected_interval_days,
    )
    staleness = max(0.0, (cutoff - latest.observed_at).total_seconds() / 3_600)
    source_quality = float(median(item.quality for item in trailing_90))
    evidence_quality = min(density_90, source_quality, _freshness_score(staleness, thresholds))

    trend_state = "insufficient_data"
    slope_z = None
    if slope_90 is not None and volatility_90 is not None:
        trend_state, slope_z = classify_trend(
            slope_90,
            volatility_90,
            data_quality=evidence_quality,
            observation_count=len(trailing_90),
            thresholds=thresholds,
        )

    returns = {
        horizon: endpoint_log_return(
            series,
            horizon,
            max_reference_lag_days=max_reference_lag_days,
        )
        for horizon in (7, 30, 90, 180, 365)
    }
    return TrendSnapshot(
        key=latest.key,
        feature_cutoff=cutoff,
        latest_observed_at=latest.observed_at,
        current_price=latest.price,
        return_7d=returns[7],
        return_30d=returns[30],
        return_90d=returns[90],
        return_180d=returns[180],
        return_365d=returns[365],
        robust_slope_30d=slope_30,
        robust_slope_90d=slope_90,
        momentum_acceleration=(slope_30 - slope_90) if slope_30 is not None and slope_90 is not None else None,
        volatility_30d=volatility_30,
        volatility_90d=volatility_90,
        max_drawdown_180d=drawdown_180,
        history_density_90d=density_90,
        staleness_hours=staleness,
        source_quality_90d=source_quality,
        evidence_quality=evidence_quality,
        slope_z_90d=slope_z,
        trend_state=trend_state,
        observation_count_90d=len(trailing_90),
    )
