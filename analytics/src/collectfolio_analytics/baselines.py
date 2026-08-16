"""Transparent forecast baselines required by the PRD."""

from __future__ import annotations

from dataclasses import dataclass
from math import exp, isfinite, log


@dataclass(frozen=True, slots=True)
class BaselineForecast:
    model_key: str
    current_price: float
    horizon_days: int
    predicted_log_return: float
    median_price: float


def _inputs(current_price: float, horizon_days: int) -> tuple[float, int]:
    if isinstance(current_price, bool) or not isfinite(current_price) or current_price <= 0:
        raise ValueError("current_price must be finite and positive")
    if isinstance(horizon_days, bool) or not isinstance(horizon_days, int) or horizon_days <= 0:
        raise ValueError("horizon_days must be a positive integer")
    return float(current_price), horizon_days


def no_change(current_price: float, horizon_days: int) -> BaselineForecast:
    """Forecast that the future price equals the current price."""

    price, horizon = _inputs(current_price, horizon_days)
    return BaselineForecast("no_change", price, horizon, 0.0, price)


def damped_momentum(
    current_price: float,
    horizon_days: int,
    daily_log_slope: float,
    *,
    damping: float = 0.25,
    max_abs_log_return: float | None = 0.70,
) -> BaselineForecast:
    """Continue an explicit fraction of recent log-price slope.

    The optional return cap is symmetric in log space and is recorded through
    the resulting predicted return. This is a challenger baseline, not a
    production price forecast.
    """

    price, horizon = _inputs(current_price, horizon_days)
    if isinstance(daily_log_slope, bool) or not isfinite(daily_log_slope):
        raise ValueError("daily_log_slope must be finite")
    if isinstance(damping, bool) or not isfinite(damping) or not 0 <= damping <= 1:
        raise ValueError("damping must be between zero and one")
    if max_abs_log_return is not None and (
        isinstance(max_abs_log_return, bool)
        or not isfinite(max_abs_log_return)
        or max_abs_log_return <= 0
    ):
        raise ValueError("max_abs_log_return must be positive or None")

    predicted_return = float(daily_log_slope) * horizon * float(damping)
    if max_abs_log_return is not None:
        predicted_return = max(-max_abs_log_return, min(max_abs_log_return, predicted_return))
    return BaselineForecast(
        "damped_momentum",
        price,
        horizon,
        predicted_return,
        price * exp(predicted_return),
    )


def market_index(
    current_price: float,
    horizon_days: int,
    market_daily_log_slope: float,
    *,
    damping: float = 0.25,
    max_abs_log_return: float | None = 0.70,
) -> BaselineForecast:
    """Move the card with a damped point-in-time cohort market trend."""

    forecast = damped_momentum(
        current_price,
        horizon_days,
        market_daily_log_slope,
        damping=damping,
        max_abs_log_return=max_abs_log_return,
    )
    return BaselineForecast(
        "market_index",
        forecast.current_price,
        forecast.horizon_days,
        forecast.predicted_log_return,
        forecast.median_price,
    )


def lifecycle_cohort(
    current_price: float,
    horizon_days: int,
    cohort_log_return: float,
    *,
    max_abs_log_return: float | None = 0.70,
) -> BaselineForecast:
    """Apply the historical return of a matching release-age cohort."""

    price, horizon = _inputs(current_price, horizon_days)
    if isinstance(cohort_log_return, bool) or not isfinite(cohort_log_return):
        raise ValueError("cohort_log_return must be finite")
    if max_abs_log_return is not None and (
        isinstance(max_abs_log_return, bool)
        or not isfinite(max_abs_log_return)
        or max_abs_log_return <= 0
    ):
        raise ValueError("max_abs_log_return must be positive or None")
    predicted_return = float(cohort_log_return)
    if max_abs_log_return is not None:
        predicted_return = max(-max_abs_log_return, min(max_abs_log_return, predicted_return))
    return BaselineForecast(
        "lifecycle_cohort",
        price,
        horizon,
        predicted_return,
        price * exp(predicted_return),
    )


def structural_convergence(
    current_price: float,
    horizon_days: int,
    structural_median_price: float,
    *,
    convergence_fraction: float = 0.25,
    max_abs_log_return: float | None = 0.70,
) -> BaselineForecast:
    """Close an explicit fraction of the gap to a structural price level."""

    price, horizon = _inputs(current_price, horizon_days)
    if (
        isinstance(structural_median_price, bool)
        or not isfinite(structural_median_price)
        or structural_median_price <= 0
    ):
        raise ValueError("structural_median_price must be finite and positive")
    if (
        isinstance(convergence_fraction, bool)
        or not isfinite(convergence_fraction)
        or not 0 <= convergence_fraction <= 1
    ):
        raise ValueError("convergence_fraction must be between zero and one")
    if max_abs_log_return is not None and (
        isinstance(max_abs_log_return, bool)
        or not isfinite(max_abs_log_return)
        or max_abs_log_return <= 0
    ):
        raise ValueError("max_abs_log_return must be positive or None")
    predicted_return = log(float(structural_median_price) / price) * float(convergence_fraction)
    if max_abs_log_return is not None:
        predicted_return = max(-max_abs_log_return, min(max_abs_log_return, predicted_return))
    return BaselineForecast(
        "structural_convergence",
        price,
        horizon,
        predicted_return,
        price * exp(predicted_return),
    )
