"""Dependency-free first-party demand-velocity features (PRD Sec 23.7).

Inputs are shaped like rows already privacy-gated by the database: each
``DemandPeriod`` corresponds to one ``aggregate_demand_snapshots`` row, which
``rebuild_aggregate_demand_snapshots`` only marks ``privacy_threshold_met``
once a period/variant clears the minimum distinct-user count (PRD Sec 29.2).
This module never re-derives that threshold from raw counts; it only trusts
the flag it is given and refuses to blend a below-threshold period into a
windowed rate, so a small, potentially identifying cohort can never leak
into a feature through averaging.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from typing import Callable, Sequence


@dataclass(frozen=True, slots=True)
class DemandPeriod:
    """One privacy-gated ``aggregate_demand_snapshots`` row."""

    period_start: date
    period_end: date
    watch_adds: int
    watch_removes: int
    searches: int
    portfolio_adds: int
    views: int
    unique_users: int
    privacy_threshold_met: bool

    def __post_init__(self) -> None:
        if not isinstance(self.period_start, date) or not isinstance(self.period_end, date):
            raise ValueError("period bounds must be dates")
        if self.period_end < self.period_start:
            raise ValueError("period_end cannot precede period_start")
        counts = (
            self.watch_adds, self.watch_removes, self.searches,
            self.portfolio_adds, self.views, self.unique_users,
        )
        if any(isinstance(value, bool) or not isinstance(value, int) or value < 0 for value in counts):
            raise ValueError("demand counts must be non-negative integers")
        if not isinstance(self.privacy_threshold_met, bool):
            raise ValueError("privacy_threshold_met must be a boolean")

    @property
    def days(self) -> int:
        return (self.period_end - self.period_start).days + 1

    @property
    def total_engagement(self) -> int:
        return self.watch_adds + self.watch_removes + self.searches + self.portfolio_adds + self.views


@dataclass(frozen=True, slots=True)
class DemandVelocity:
    feature_cutoff: date
    watchlist_velocity_7d: float | None
    watchlist_velocity_30d: float | None
    search_velocity_7d: float | None
    portfolio_add_velocity_30d: float | None
    view_velocity_7d: float | None
    demand_acceleration: float | None
    evidence_periods: int
    privacy_supported: bool


def _ordered(periods: Sequence[DemandPeriod]) -> tuple[DemandPeriod, ...]:
    values = tuple(periods)
    if any(not isinstance(item, DemandPeriod) for item in values):
        raise ValueError("periods must contain DemandPeriod values")
    ordered = tuple(sorted(values, key=lambda item: item.period_start))
    for left, right in zip(ordered, ordered[1:]):
        if right.period_start <= left.period_end:
            raise ValueError("demand periods must be non-overlapping and chronologically ordered")
    return ordered


def _trailing(periods: Sequence[DemandPeriod], window_end: date, days: int) -> tuple[DemandPeriod, ...]:
    window_start = window_end - timedelta(days=days)
    return tuple(
        period for period in periods
        if period.period_start >= window_start and period.period_end <= window_end
    )


def _rate_per_day(periods: Sequence[DemandPeriod], selector: Callable[[DemandPeriod], int]) -> float | None:
    """Total selected count over total days, or None without full evidence.

    Every contributing period must be privacy-threshold-met; a single
    unsupported period makes the whole window unsupported rather than
    silently dropping it (dropping would understate the denominator and
    bias the rate).
    """

    if not periods:
        return None
    if not all(period.privacy_threshold_met for period in periods):
        return None
    total_days = sum(period.days for period in periods)
    if total_days <= 0:
        return None
    return float(sum(selector(period) for period in periods)) / total_days


def demand_velocity(periods: Sequence[DemandPeriod], feature_cutoff: date) -> DemandVelocity:
    """Point-in-time demand-velocity and acceleration features.

    Only periods ending at or before ``feature_cutoff`` are used (PRD Sec
    25.1/25.4: no future feature timestamps). ``demand_acceleration`` is the
    change in total daily engagement between the trailing 7 days and the 7
    days before that, matching ``demand_acceleration`` in Sec 23.7.
    """

    if not isinstance(feature_cutoff, date):
        raise ValueError("feature_cutoff must be a date")
    eligible = tuple(period for period in _ordered(periods) if period.period_end <= feature_cutoff)

    window_7d = _trailing(eligible, feature_cutoff, 7)
    window_30d = _trailing(eligible, feature_cutoff, 30)
    prior_window_7d = _trailing(eligible, feature_cutoff - timedelta(days=7), 7)

    current_engagement_rate = _rate_per_day(window_7d, lambda period: period.total_engagement)
    prior_engagement_rate = _rate_per_day(prior_window_7d, lambda period: period.total_engagement)
    demand_acceleration = (
        current_engagement_rate - prior_engagement_rate
        if current_engagement_rate is not None and prior_engagement_rate is not None
        else None
    )

    return DemandVelocity(
        feature_cutoff=feature_cutoff,
        watchlist_velocity_7d=_rate_per_day(window_7d, lambda period: period.watch_adds + period.watch_removes),
        watchlist_velocity_30d=_rate_per_day(window_30d, lambda period: period.watch_adds + period.watch_removes),
        search_velocity_7d=_rate_per_day(window_7d, lambda period: period.searches),
        portfolio_add_velocity_30d=_rate_per_day(window_30d, lambda period: period.portfolio_adds),
        view_velocity_7d=_rate_per_day(window_7d, lambda period: period.views),
        demand_acceleration=demand_acceleration,
        evidence_periods=len(eligible),
        privacy_supported=any(period.privacy_threshold_met for period in eligible),
    )
