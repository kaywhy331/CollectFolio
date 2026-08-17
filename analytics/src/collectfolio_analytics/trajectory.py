"""Damped-trend + Theta + EB-shrinkage + split-conformal trajectory engine (T2).

Per PRD §4/T2 and roadmap §4: for card *i* on week *t*,
``y_i,t = m_t + g_t + s_t + r_i,t``. This module forecasts each component
for a single category at a time (the expensive part -- per-card modeling
across up to ~160K variants), using the shared market/category/group
indices already built by ``indices.py`` and the release-age lifecycle
curve built by ``lifecycle.py``:

1. ``m``/``g`` -- damped-trend (Holt, phi grid-searched, capped <= 0.95)
   exponential smoothing directly on the cumulative log-index series.
2. ``s`` -- the group's own damped trend blended with the lifecycle cohort
   curve, empirical-Bayes weighted by how many weeks of its own history
   the group has (``lifecycle.py``).
3. ``r_i`` -- a simplified single-line Theta forecast: SES-smoothed level
   of the card's *residual return* series (return net of the expected
   market+game+set return each week) is its drift estimate, empirical-Bayes
   shrunk toward zero by ``n/(n+n0)``. This is a deliberate simplification
   of classical two-line Theta (documented in the T2 report): the roadmap's
   own emphasis is on the shrinkage behavior, which this form makes exactly
   testable at its n=0 and n->infinity limits.
4. Point/band -- split-conformal: walk-forward residuals (real, point-in-
   time-safe: forecasts built from data at-or-before an origin, compared to
   the real price ``horizon_steps`` weeks later) are pooled by
   (volatility bucket x horizon) *within this category*, standardized by
   each contributing card's own MAD volatility, and their empirical
   quantiles become the per-card band offset -- scaled back up by *this*
   card's own MAD -- emitted as noncrossing q10..q90 via ``quantiles.py``.

Memory shape: the only per-variant state kept live across passes is a
handful of preallocated ``array('d'/'i')`` columns indexed by a
``(productId, subTypeName) -> int`` map -- never a dict of Python-float
lists for the whole category.
"""

from __future__ import annotations

from array import array
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from hashlib import sha256
from math import exp, isfinite, isnan, log
from pathlib import Path
from statistics import median
from typing import Mapping, Sequence

import gzip
import io
import json

from .indices import IndexSet, _iter_category_date_rows, trimmed_mean
from .lifecycle import (
    LifecycleCurve,
    blend_group_forecast_delta,
    cohort_return_over_horizon,
    release_age_weeks,
)
from .quantiles import QuantileOrderError, REQUIRED_QUANTILES, rearrange_quantiles, validate_quantiles

MODEL_VERSION = "trajectory-v1"
HORIZONS_DAYS: tuple[int, ...] = (30, 90)
WEEK_DAYS = 7

SES_ALPHA_GRID: tuple[float, ...] = (0.1, 0.2, 0.3, 0.4, 0.5)
DAMPED_ALPHA = 0.3
DAMPED_BETA = 0.1
DAMPED_PHI_GRID: tuple[float, ...] = (0.70, 0.75, 0.80, 0.85, 0.90, 0.95)
N0_DRIFT = 8.0
MIN_HISTORY_FOR_STANDARD = 8
MAX_PATH_POINTS = 32
VOLATILITY_FLOOR = 1e-4
MAX_ORIGINS_PER_HORIZON = 5
MIN_ORIGIN_INDEX = 15


def _canonical_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def content_sha256(value: object) -> str:
    return sha256(_canonical_json(value).encode("utf-8")).hexdigest()


def horizon_steps_for(days: int) -> int:
    if isinstance(days, bool) or not isinstance(days, int) or days <= 0:
        raise ValueError("horizon days must be a positive integer")
    return max(1, round(days / WEEK_DAYS))


# ---------------------------------------------------------------------------
# Damped-trend exponential smoothing (index level series: market/game/set)
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class DampedTrendFit:
    phi: float
    level: array
    trend: array


def fit_damped_trend(
    levels: Sequence[float],
    *,
    alpha: float = DAMPED_ALPHA,
    beta: float = DAMPED_BETA,
    phi_grid: Sequence[float] = DAMPED_PHI_GRID,
) -> DampedTrendFit:
    """Holt's damped-trend recursion, phi chosen by in-sample SSE grid search.

    ``l_t = alpha*y_t + (1-alpha)*(l_{t-1} + phi*b_{t-1})``
    ``b_t = beta*(l_t - l_{t-1}) + (1-beta)*phi*b_{t-1}``

    Run once over the whole series: because the recursion is causal,
    ``(level[o], trend[o])`` at any index ``o`` uses only ``levels[:o+1]``
    and is safe to reuse as the walk-forward state at that origin.
    """

    n = len(levels)
    if n < 2:
        raise ValueError("fit_damped_trend requires at least two points")
    if any(isinstance(v, bool) or not isfinite(v) for v in levels):
        raise ValueError("levels must be finite")
    if not phi_grid:
        raise ValueError("phi_grid must not be empty")
    if any(isinstance(p, bool) or not isfinite(p) or not 0 < p <= 0.95 for p in phi_grid):
        raise ValueError("phi_grid values must lie in (0, 0.95]")

    best: tuple[float, float, array, array] | None = None
    for phi in phi_grid:
        level = array("d", [0.0]) * n
        trend = array("d", [0.0]) * n
        level[0] = levels[0]
        trend[0] = levels[1] - levels[0]
        sse = 0.0
        for t in range(1, n):
            pred = level[t - 1] + phi * trend[t - 1]
            err = levels[t] - pred
            sse += err * err
            level[t] = alpha * levels[t] + (1 - alpha) * (level[t - 1] + phi * trend[t - 1])
            trend[t] = beta * (level[t] - level[t - 1]) + (1 - beta) * phi * trend[t - 1]
        if best is None or sse < best[0]:
            best = (sse, phi, level, trend)
    assert best is not None
    _, phi, level, trend = best
    return DampedTrendFit(phi=phi, level=level, trend=trend)


def damped_forecast_delta(fit: DampedTrendFit, origin_index: int, horizon_steps: int) -> float:
    """Expected change in level from ``origin_index`` to ``origin_index+horizon_steps``."""

    if isinstance(horizon_steps, bool) or not isinstance(horizon_steps, int) or horizon_steps <= 0:
        raise ValueError("horizon_steps must be a positive integer")
    if not 0 <= origin_index < len(fit.trend):
        raise ValueError("origin_index out of range")
    phi = fit.phi
    b = fit.trend[origin_index]
    if abs(phi - 1.0) < 1e-12:
        return b * horizon_steps
    return b * phi * (1 - phi ** horizon_steps) / (1 - phi)


# ---------------------------------------------------------------------------
# Theta method with empirical-Bayes drift shrinkage (card residual)
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class ThetaDriftFit:
    alpha: float
    level: array
    count: array
    n0: float


def fit_theta_drift(
    residual_returns: Sequence[float],
    *,
    alpha_grid: Sequence[float] = SES_ALPHA_GRID,
    n0: float = N0_DRIFT,
) -> ThetaDriftFit:
    """SES level of a card's residual-return series, nan-skipping.

    ``residual_returns[t]`` is ``nan`` wherever no return is observable at
    step ``t`` (no consecutive known prices). The SES level is treated as
    the card's raw (unshrunk) drift estimate at every step; ``level``/
    ``count`` are recorded at every index so any origin's walk-forward
    state is available without refitting (the recursion is causal).
    """

    n = len(residual_returns)
    if n < 1:
        raise ValueError("fit_theta_drift requires at least one step")
    if not alpha_grid:
        raise ValueError("alpha_grid must not be empty")

    best: tuple[float, float, array, array] | None = None
    for alpha in alpha_grid:
        if isinstance(alpha, bool) or not isfinite(alpha) or not 0 < alpha < 1:
            raise ValueError("alpha_grid values must lie in (0, 1)")
        level = array("d", [0.0]) * n
        count = array("i", [0]) * n
        l = 0.0
        c = 0
        have_level = False
        sse = 0.0
        nvalid = 0
        for t in range(n):
            r = residual_returns[t]
            valid = not isnan(r)
            if valid:
                if have_level:
                    err = r - l
                    sse += err * err
                    nvalid += 1
                    l = alpha * r + (1 - alpha) * l
                else:
                    l = r
                    have_level = True
                c += 1
            level[t] = l
            count[t] = c
        score = sse / nvalid if nvalid else float("inf")
        if best is None or score < best[0]:
            best = (score, alpha, level, count)
    assert best is not None
    _, alpha, level, count = best
    return ThetaDriftFit(alpha=alpha, level=level, count=count, n0=n0)


def shrunk_drift_at(fit: ThetaDriftFit, origin_index: int) -> tuple[float, float, int]:
    """``(shrunk_drift, weight, n)`` at ``origin_index``.

    ``weight = n/(n+n0)``: n=0 -> weight 0 (pure prior, no idiosyncratic
    drift -- the card is forecast to move exactly with its market/game/set
    index); n -> infinity -> weight -> 1 (the card keeps its own drift).
    """

    if not 0 <= origin_index < len(fit.level):
        raise ValueError("origin_index out of range")
    n = fit.count[origin_index]
    raw = fit.level[origin_index]
    denom = n + fit.n0
    weight = (n / denom) if denom > 0 else 0.0
    return raw * weight, weight, n


# ---------------------------------------------------------------------------
# Residual construction and volatility
# ---------------------------------------------------------------------------


def variant_residual_returns(
    prices: array,
    index_set: IndexSet,
    category_id: int,
    group_id: int,
) -> array:
    """Per-step residual log-return, gap-normalized, aligned to ``index_set.dates``."""

    n = len(prices)
    nan = float("nan")
    adjusted = array("d", [nan]) * n
    for t in range(n):
        p = prices[t]
        if not isnan(p) and p > 0:
            adjusted[t] = log(p) - index_set.combined_level(category_id, group_id, t)
    residual = array("d", [nan]) * n
    prev_t: int | None = None
    for t in range(n):
        if isnan(adjusted[t]):
            continue
        if prev_t is not None:
            gap = t - prev_t
            residual[t] = (adjusted[t] - adjusted[prev_t]) / gap
        prev_t = t
    return residual


def mad_volatility(values: array) -> float:
    cleaned = [v for v in values if not isnan(v)]
    if len(cleaned) < 2:
        return float("nan")
    center = median(cleaned)
    return 1.4826 * median(abs(v - center) for v in cleaned)


def last_known(prices: array) -> tuple[int, float] | None:
    for t in range(len(prices) - 1, -1, -1):
        if not isnan(prices[t]):
            return t, prices[t]
    return None


# ---------------------------------------------------------------------------
# Group-level (set) forecast: own damped trend blended with lifecycle cohort
# ---------------------------------------------------------------------------


def group_component_delta(
    *,
    group_fit: DampedTrendFit | None,
    group_first_index: int,
    origin_index: int,
    horizon_steps: int,
    horizon_days: int,
    lifecycle_curve: LifecycleCurve,
    published_on: str | None,
    origin_date: date,
) -> float:
    slice_origin = origin_index - group_first_index
    if group_fit is not None and 0 <= slice_origin < len(group_fit.trend):
        own_delta = damped_forecast_delta(group_fit, slice_origin, horizon_steps)
        n_group = max(0, slice_origin)
    else:
        own_delta = 0.0
        n_group = 0

    cohort_return = 0.0
    if published_on:
        age_week = release_age_weeks(published_on, origin_date)
        if age_week is not None:
            cohort_return = cohort_return_over_horizon(lifecycle_curve, age_week, horizon_steps)

    blended, _weight = blend_group_forecast_delta(
        own_delta, cohort_return, n_group=n_group, horizon_days=horizon_days,
    )
    return blended


# ---------------------------------------------------------------------------
# Walk-forward origin selection and empirical quantiles (split-conformal)
# ---------------------------------------------------------------------------


def select_walk_forward_origins(
    n_dates: int,
    horizon_steps: int,
    *,
    max_origins: int = MAX_ORIGINS_PER_HORIZON,
    min_origin_index: int = MIN_ORIGIN_INDEX,
) -> tuple[int, ...]:
    last_valid = n_dates - 1 - horizon_steps
    if last_valid < min_origin_index:
        return ()
    span = last_valid - min_origin_index
    if span <= 0:
        return (min_origin_index,)
    count = min(max_origins, span + 1)
    if count <= 1:
        return (last_valid,)
    step = span / (count - 1)
    origins = sorted({min_origin_index + round(i * step) for i in range(count)})
    return tuple(origins)


def empirical_quantile(sorted_values: Sequence[float], probability: float) -> float:
    n = len(sorted_values)
    if n == 0:
        raise ValueError("empirical_quantile requires at least one value")
    if n == 1:
        return float(sorted_values[0])
    pos = probability * (n - 1)
    lo = int(pos)
    hi = min(lo + 1, n - 1)
    frac = pos - lo
    return float(sorted_values[lo] + (sorted_values[hi] - sorted_values[lo]) * frac)


def volatility_bucket(mad: float, low_cut: float, high_cut: float) -> str:
    if isnan(mad):
        return "unknown"
    if mad <= low_cut:
        return "low"
    if mad <= high_cut:
        return "mid"
    return "high"


def tercile_cutoffs(values: Sequence[float]) -> tuple[float, float]:
    cleaned = sorted(v for v in values if not isnan(v))
    if not cleaned:
        return (0.0, 0.0)
    low = empirical_quantile(cleaned, 1 / 3)
    high = empirical_quantile(cleaned, 2 / 3)
    return (low, high)


# ---------------------------------------------------------------------------
# Per-category orchestration
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class CategoryRunResult:
    category_id: int
    variant_count: int
    packet_row_count: int
    dates_covered: int
    pool_sizes: dict[str, int]
    conformal_offsets: dict[str, dict[str, float]]
    output_path: str
    content_hash: str
    rejects: dict[str, int]


def _load_category_prices(
    panel_dir: Path,
    category_id: int,
    dates: Sequence[date],
) -> tuple[dict[tuple[int, str], int], list[int], list[array]]:
    """Single streaming pass: compact per-variant price columns for one category."""

    n = len(dates)
    nan = float("nan")
    variant_index: dict[tuple[int, str], int] = {}
    variant_group: list[int] = []
    prices: list[array] = []

    for t, day in enumerate(dates):
        path = panel_dir / f"category-{category_id}" / f"{day.isoformat()}.jsonl.gz"
        if not path.is_file():
            continue
        for group_id, product_id, subtype, price in _iter_category_date_rows(path):
            key = (product_id, subtype)
            idx = variant_index.get(key)
            if idx is None:
                idx = len(variant_index)
                variant_index[key] = idx
                variant_group.append(group_id)
                prices.append(array("d", [nan]) * n)
            prices[idx][t] = price
    return variant_index, variant_group, prices


def _fit_group_trends(
    index_set: IndexSet, category_id: int
) -> dict[int, tuple[int, DampedTrendFit | None]]:
    fits: dict[int, tuple[int, DampedTrendFit | None]] = {}
    for (cat, group_id), arr in index_set.group.items():
        if cat != category_id:
            continue
        first = index_set.group_first_index.get((cat, group_id), 0)
        tail = arr[first:]
        fit = fit_damped_trend(list(tail)) if len(tail) >= 2 else None
        fits[group_id] = (first, fit)
    return fits


def process_category(
    panel_dir: Path,
    category_id: int,
    index_set: IndexSet,
    lifecycle_curve: LifecycleCurve,
    groups_metadata: Mapping[tuple[int, int], Mapping[str, object]],
    output_dir: Path,
    *,
    horizons_days: Sequence[int] = HORIZONS_DAYS,
    as_of: datetime | None = None,
) -> CategoryRunResult:
    dates = index_set.dates
    n = len(dates)
    horizon_steps_list = tuple(sorted({horizon_steps_for(h) for h in horizons_days}))
    steps_by_days = {h: horizon_steps_for(h) for h in horizons_days}

    market_fit = fit_damped_trend(list(index_set.market))
    category_fit = fit_damped_trend(list(index_set.category[category_id]))
    group_fits = _fit_group_trends(index_set, category_id)

    variant_index, variant_group, prices = _load_category_prices(panel_dir, category_id, dates)
    num_variants = len(variant_index)

    nan = float("nan")
    own_mad = array("d", [nan]) * num_variants
    final_drift = array("d", [0.0]) * num_variants
    final_n = array("i", [0]) * num_variants
    last_price_arr = array("d", [nan]) * num_variants
    last_index_arr = array("i", [-1]) * num_variants

    # standardized walk-forward residuals per horizon, bucket assigned after
    # own-MAD terciles are known category-wide.
    raw_pool: list[tuple[int, int, float]] = []  # (variant_idx, horizon_steps, standardized_residual)

    for i in range(num_variants):
        gk_group_id = variant_group[i]
        residual = variant_residual_returns(prices[i], index_set, category_id, gk_group_id)
        own_mad[i] = mad_volatility(residual)
        found = last_known(prices[i])
        if found is None:
            continue
        li, lp = found
        last_index_arr[i] = li
        last_price_arr[i] = lp

        theta_fit = fit_theta_drift(list(residual))
        drift_t, _weight_t, n_t = shrunk_drift_at(theta_fit, li)
        final_drift[i] = drift_t
        final_n[i] = n_t

        mad_i = own_mad[i]
        if isnan(mad_i):
            continue
        # Floor (not skip) near-/exactly-zero-MAD variants: many real card
        # variants have literally-constant week-over-week prices (stale
        # bulk-product listings), so own_mad == 0.0 for a large, genuine
        # subset -- often enough to pull the *entire* low-volatility tercile
        # cutoff down to 0.0. Skipping those variants here (rather than
        # flooring the standardization denominator) would leave the "low"
        # bucket's calibration pool permanently empty for every horizon,
        # silently defeating the (category x volatility-bucket x horizon)
        # split-conformal requirement for that whole segment. Flooring
        # mirrors the same VOLATILITY_FLOOR substitution already used for
        # mad_for_band at packet-emission time below.
        denom = mad_i if mad_i >= VOLATILITY_FLOOR else VOLATILITY_FLOOR
        first, gfit = group_fits.get(gk_group_id, (0, None))
        published_on = groups_metadata.get((category_id, gk_group_id), {}).get("published_on")

        for h_steps in horizon_steps_list:
            h_days = h_steps * WEEK_DAYS
            for origin in select_walk_forward_origins(n, h_steps):
                if origin >= li:
                    continue
                target = origin + h_steps
                if target >= n or isnan(prices[i][origin]) or isnan(prices[i][target]):
                    continue
                index_delta = (
                    damped_forecast_delta(market_fit, origin, h_steps)
                    + damped_forecast_delta(category_fit, origin, h_steps)
                    + group_component_delta(
                        group_fit=gfit,
                        group_first_index=first,
                        origin_index=origin,
                        horizon_steps=h_steps,
                        horizon_days=h_days,
                        lifecycle_curve=lifecycle_curve,
                        published_on=str(published_on) if published_on else None,
                        origin_date=dates[origin],
                    )
                )
                drift_o, _weight_o, _n_o = shrunk_drift_at(theta_fit, origin)
                forecast_log = log(prices[i][origin]) + index_delta + drift_o * h_steps
                actual_log = log(prices[i][target])
                standardized = (actual_log - forecast_log) / denom
                raw_pool.append((i, h_steps, standardized))

    low_cut, high_cut = tercile_cutoffs(own_mad)
    fallback_mad = trimmed_mean([v for v in own_mad if not isnan(v)]) if any(not isnan(v) for v in own_mad) else VOLATILITY_FLOOR
    fallback_mad = max(fallback_mad, VOLATILITY_FLOOR)

    pools: dict[tuple[str, int], list[float]] = {}
    for variant_idx, h_steps, standardized in raw_pool:
        bucket = volatility_bucket(own_mad[variant_idx], low_cut, high_cut)
        pools.setdefault((bucket, h_steps), []).append(standardized)

    conformal_offsets: dict[tuple[str, int], dict[float, float]] = {}
    pool_sizes: dict[str, int] = {}
    for key, values in pools.items():
        values.sort()
        conformal_offsets[key] = {q: empirical_quantile(values, q) for q in REQUIRED_QUANTILES}
        pool_sizes[f"{key[0]}:{key[1]}"] = len(values)

    default_offsets = {q: (q - 0.5) * 2.0 for q in REQUIRED_QUANTILES}  # wide symmetric fallback in MAD units

    if as_of is None:
        as_of = datetime.combine(dates[-1], datetime.min.time(), tzinfo=timezone.utc) + timedelta(days=1)

    output_dir = Path(output_dir)
    category_dir = output_dir / f"category-{category_id}"
    category_dir.mkdir(parents=True, exist_ok=True)
    output_path = category_dir / "packets.jsonl.gz"
    tmp_path = output_path.with_suffix(output_path.suffix + ".part")

    rejects = {"crossed_quantiles_rearranged": 0, "no_history": 0}
    row_count = 0
    content_digest = sha256()

    raw_handle = open(tmp_path, "wb")
    gzip_handle = gzip.GzipFile(filename="", mode="wb", fileobj=raw_handle, mtime=0)
    with raw_handle, gzip_handle, io.TextIOWrapper(gzip_handle, encoding="utf-8", newline="\n") as handle:
        for (product_id, subtype), i in sorted(variant_index.items()):
            li = last_index_arr[i]
            if li < 0:
                rejects["no_history"] += 1
                continue
            lp = last_price_arr[i]
            mad_i = own_mad[i]
            mad_for_band = mad_i if (not isnan(mad_i) and mad_i >= VOLATILITY_FLOOR) else fallback_mad
            bucket = volatility_bucket(mad_i, low_cut, high_cut)
            group_id = variant_group[i]
            first, gfit = group_fits.get(group_id, (0, None))
            published_on = groups_metadata.get((category_id, group_id), {}).get("published_on")
            n_i = final_n[i]
            drift_i = final_drift[i]

            horizons_out: dict[str, dict[str, float]] = {}
            for h_days, h_steps in steps_by_days.items():
                index_delta = (
                    damped_forecast_delta(market_fit, li, h_steps)
                    + damped_forecast_delta(category_fit, li, h_steps)
                    + group_component_delta(
                        group_fit=gfit,
                        group_first_index=first,
                        origin_index=li,
                        horizon_steps=h_steps,
                        horizon_days=h_days,
                        lifecycle_curve=lifecycle_curve,
                        published_on=str(published_on) if published_on else None,
                        origin_date=dates[li],
                    )
                )
                predicted_log = log(lp) + index_delta + drift_i * h_steps
                offsets = conformal_offsets.get((bucket, h_steps)) or default_offsets
                quantile_values = {
                    q: exp(predicted_log + offsets.get(q, 0.0) * mad_for_band)
                    for q in REQUIRED_QUANTILES
                }
                try:
                    ordered = validate_quantiles(quantile_values)
                except QuantileOrderError:
                    quantile_values = rearrange_quantiles(quantile_values)
                    ordered = validate_quantiles(quantile_values)
                    rejects["crossed_quantiles_rearranged"] += 1
                horizons_out[str(h_days)] = {f"q{int(round(p * 100)):02d}": v for p, v in ordered}

            path_points = []
            max_steps = max(steps_by_days.values())
            path_len = min(MAX_PATH_POINTS, max_steps + 1)
            for k in range(path_len):
                delta = (
                    damped_forecast_delta(market_fit, li, k)
                    + damped_forecast_delta(category_fit, li, k)
                    + group_component_delta(
                        group_fit=gfit,
                        group_first_index=first,
                        origin_index=li,
                        horizon_steps=k,
                        horizon_days=k * WEEK_DAYS,
                        lifecycle_curve=lifecycle_curve,
                        published_on=str(published_on) if published_on else None,
                        origin_date=dates[li],
                    )
                    + drift_i * k
                    if k > 0
                    else 0.0
                )
                point_date = dates[li] + timedelta(days=WEEK_DAYS * k)
                path_points.append({
                    "date": point_date.isoformat(),
                    "price": round(exp(log(lp) + delta), 6),
                })

            confidence = "standard"
            if isnan(mad_i):
                confidence = "insufficient-history"
            elif n_i < MIN_HISTORY_FOR_STANDARD:
                confidence = "low-history"

            row = {
                "modelVersion": MODEL_VERSION,
                "categoryId": category_id,
                "groupId": group_id,
                "productId": product_id,
                "subTypeName": subtype,
                "asOf": as_of.isoformat(),
                "lastKnownDate": dates[li].isoformat(),
                "lastKnownPrice": round(lp, 6),
                "confidence": confidence,
                "volatilityBucket": bucket,
                "sampleSize": n_i,
                "horizons": horizons_out,
                "medianPath": path_points,
            }
            line = _canonical_json(row) + "\n"
            handle.write(line)
            content_digest.update(line.encode("utf-8"))
            row_count += 1
    tmp_path.replace(output_path)

    return CategoryRunResult(
        category_id=category_id,
        variant_count=num_variants,
        packet_row_count=row_count,
        dates_covered=n,
        pool_sizes=pool_sizes,
        conformal_offsets={
            f"{bucket}:{h}": {f"q{int(round(p * 100)):02d}": v for p, v in offs.items()}
            for (bucket, h), offs in conformal_offsets.items()
        },
        output_path=str(output_path),
        content_hash=content_digest.hexdigest(),
        rejects=rejects,
    )
