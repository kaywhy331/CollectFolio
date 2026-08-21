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

from .hedonic import COLD_START_BAND_WIDEN_FACTOR, N0_HEDONIC, hedonic_level_weight
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

# T4 (PRD Sec4 walk-forward evaluation gate) hard criteria, from packet
# sampling documented in docs/receipts/trajectory-v1/trajectory-hedonic-summary.md
# "Tracked concerns":
STALE_WEEKS_THRESHOLD = 8
# ln(3): the T3 hedonic level-blend anchor shift is capped so the blended
# anchor can move at most 3x above/below the card's own last-known price,
# regardless of how small n (and therefore the empirical-Bayes weight) is.
MAX_HEDONIC_BLEND_LOG_SHIFT = 1.0986122886681098


def _canonical_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def content_sha256(value: object) -> str:
    return sha256(_canonical_json(value).encode("utf-8")).hexdigest()


def horizon_steps_for(days: int) -> int:
    if isinstance(days, bool) or not isinstance(days, int) or days <= 0:
        raise ValueError("horizon days must be a positive integer")
    return max(1, round(days / WEEK_DAYS))


def interpolated_component_weights(
    weights_by_h_steps: Mapping[int, tuple[float, float]],
    step: int,
) -> tuple[float, float]:
    """Blend calibrated horizon weights into one continuous path.

    Component weights are evaluated only at served horizons (currently 30
    and 90 days, or 4 and 13 weekly steps).  A nearest-horizon lookup makes
    the median path jump from one parameter set to the other around day 60.
    Hold the nearest endpoint outside the calibrated interval and linearly
    blend between adjacent calibrated horizons inside it, preserving the
    exact evaluated weights at every served checkpoint.
    """
    horizon_steps = sorted(weights_by_h_steps)
    if not horizon_steps:
        return (1.0, 1.0)
    if step <= horizon_steps[0]:
        return weights_by_h_steps[horizon_steps[0]]
    if step >= horizon_steps[-1]:
        return weights_by_h_steps[horizon_steps[-1]]

    for lower, upper in zip(horizon_steps, horizon_steps[1:]):
        if lower <= step <= upper:
            fraction = (step - lower) / (upper - lower)
            lower_a, lower_b = weights_by_h_steps[lower]
            upper_a, upper_b = weights_by_h_steps[upper]
            return (
                lower_a + ((upper_a - lower_a) * fraction),
                lower_b + ((upper_b - lower_b) * fraction),
            )
    return weights_by_h_steps[horizon_steps[-1]]


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


def _widest_offsets(
    conformal_offsets: Mapping[tuple[str, int], Mapping[float, float]],
    h_steps: int,
    default_offsets: Mapping[float, float],
    bucket_mad: Mapping[str, float],
    fallback_mad: float,
) -> tuple[Mapping[float, float], float]:
    """The single (bucket, h_steps) calibrated pool with the largest
    EFFECTIVE (i.e. absolute log-price-space) quantile spread, for the
    given horizon -- "the widest calibrated pool for the category" a T3
    cold-start packet's bands are built from (then scaled further by
    ``COLD_START_BAND_WIDEN_FACTOR``). Returns ``(offsets, mad_scale)``:
    ``mad_scale`` MUST be used as that packet's ``mad_for_band`` multiplier
    (not an unrelated constant like ``fallback_mad``).

    Correctness note: each (bucket, h_steps) pool's *raw* offsets are
    standardized residuals -- ``(actual - forecast) / own_mad`` -- so a
    "low"-volatility bucket's raw offsets are calibrated against own_mad
    values near ``VOLATILITY_FLOOR`` and are consequently enormous in raw
    units (e.g. a q90 offset of several thousand), while a "high"-bucket
    pool's raw offsets are calibrated against a much larger own_mad and so
    look far smaller in raw units despite representing a wider *actual*
    band. Comparing raw offset spreads directly (an earlier version of this
    function did exactly that) therefore almost always "wins" on the low
    bucket for the wrong reason, and multiplying that pool's raw offsets by
    an unrelated MAD (``fallback_mad``, a category-wide average) produces
    nonsensical, unbounded-looking prices. This version compares each
    pool's *effective* width (``raw_spread * that_bucket's_own_representative
    MAD``) and returns the winning pool's own representative MAD alongside
    it, so the caller multiplies like-for-like.
    """

    candidates = [
        (bucket, offs) for (bucket, h), offs in conformal_offsets.items() if h == h_steps
    ]
    if not candidates:
        return default_offsets, fallback_mad

    def _effective_width(item: tuple[str, Mapping[float, float]]) -> float:
        bucket, offs = item
        values = list(offs.values())
        raw_spread = (max(values) - min(values)) if values else 0.0
        return raw_spread * bucket_mad.get(bucket, fallback_mad)

    winning_bucket, winning_offsets = max(candidates, key=_effective_width)
    return winning_offsets, bucket_mad.get(winning_bucket, fallback_mad)


def tercile_cutoffs(values: Sequence[float]) -> tuple[float, float]:
    cleaned = sorted(v for v in values if not isnan(v))
    if not cleaned:
        return (0.0, 0.0)
    low = empirical_quantile(cleaned, 1 / 3)
    high = empirical_quantile(cleaned, 2 / 3)
    return (low, high)


def _calibrate_conformal(
    own_mad: Sequence[float],
    raw_pool: Sequence[tuple[int, int, float]],
) -> tuple[
    float,
    float,
    float,
    dict[str, float],
    dict[tuple[str, int], dict[float, float]],
    dict[float, float],
    dict[str, int],
]:
    """Split-conformal (bucket x horizon) calibration from standardized
    walk-forward residuals. Factored out of ``process_category`` so
    ``trajectory_eval.py``'s walk-forward evaluator can build the exact
    same conformal pools the production packet-emission path builds --
    a single source of truth for both, rather than two copies that could
    silently drift apart.

    Returns ``(low_cut, high_cut, fallback_mad, bucket_mad,
    conformal_offsets, default_offsets, pool_sizes)``.
    """

    low_cut, high_cut = tercile_cutoffs(own_mad)
    fallback_mad = trimmed_mean([v for v in own_mad if not isnan(v)]) if any(not isnan(v) for v in own_mad) else VOLATILITY_FLOOR
    fallback_mad = max(fallback_mad, VOLATILITY_FLOOR)

    # Each volatility bucket's own representative own_mad -- needed so a T3
    # cold-start packet that borrows a bucket's raw conformal offsets (see
    # _widest_offsets) multiplies them by a like-for-like MAD scale instead
    # of the unrelated category-wide fallback_mad.
    bucket_mad_samples: dict[str, list[float]] = {}
    for v in own_mad:
        if isnan(v):
            continue
        bucket_mad_samples.setdefault(volatility_bucket(v, low_cut, high_cut), []).append(v)
    bucket_mad = {
        bucket: max(median(values), VOLATILITY_FLOOR)
        for bucket, values in bucket_mad_samples.items()
    }

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

    return low_cut, high_cut, fallback_mad, bucket_mad, conformal_offsets, default_offsets, pool_sizes


# ---------------------------------------------------------------------------
# T4: confidence-tier classification (with staleness degradation) and the
# capped hedonic level-blend anchor. Factored out of process_category's
# emission loop so trajectory_eval.py's walk-forward evaluator can reuse the
# exact same rule the production packet-emission path applies -- a single
# source of truth for both.
# ---------------------------------------------------------------------------


def confidence_tier(*, n_i: int, mad_i: float, weeks_stale: float | None) -> str:
    """Confidence tier for an observed (non-cold-start) variant.

    Base tier from own-history sample size / volatility (T2/T3 behavior,
    unchanged): ``"insufficient-history"`` when ``mad_i`` is nan (the
    variant never had two consecutive known prices to form even one
    residual return), else ``"low-history"`` when ``n_i <
    MIN_HISTORY_FOR_STANDARD`` drift-fit observations, else ``"standard"``.

    T4 staleness rule (PRD Sec4 hard criterion 3a, from packet sampling):
    a variant whose last-known price is more than ``STALE_WEEKS_THRESHOLD``
    weeks old must not carry ``"standard"`` confidence even if it otherwise
    qualifies on sample size/volatility alone -- an old last-known price is
    not a reliable forecast anchor no matter how much history led up to
    it. Staleness only ever *degrades* a tier (standard -> low-history);
    it never upgrades a tier that was already worse than standard.
    """

    if isnan(mad_i):
        return "insufficient-history"
    if n_i < MIN_HISTORY_FOR_STANDARD:
        return "low-history"
    if weeks_stale is not None and weeks_stale > STALE_WEEKS_THRESHOLD:
        return "low-history"
    return "standard"


def hedonic_blend_anchor_log(
    own_log: float,
    hedonic_pred: float,
    n_i: int,
    *,
    max_abs_shift: float = MAX_HEDONIC_BLEND_LOG_SHIFT,
) -> float:
    """T3 empirical-Bayes anchor blend, T4-capped (PRD Sec4 hard criterion 3c).

    The original T3 form is ``anchor = weight*own_log + (1-weight)*hedonic``
    with ``weight = n/(n+N0_HEDONIC)`` -- algebraically a shift away from
    the card's own log price: ``anchor = own_log + (1-weight)*(hedonic -
    own_log)``. Walk-forward evaluation of the sampled low-n case (own
    last-known price $81,421, raw blended anchor ~= $111 at n close to 0 --
    a several-hundred-x level swing driven almost entirely by a single
    hedonic point estimate) showed this unclamped shift is not a safe
    MAE-improving anchor at low n. The shift is therefore clamped in log
    space to ``max_abs_shift`` (default ``ln(3)``: the blended anchor can
    move at most 3x above/below the card's own last-known price) -- the
    empirical-Bayes weight still governs the *direction and unclamped
    magnitude* the shift would have taken; this only bounds how far it is
    allowed to move the anchor. At high n the unclamped shift is already
    near zero, so the clamp is a no-op there (HighNInvarianceTests).

    T4 incident fix (2026-08): this blend is a cold-start/low-n device --
    it exists to lean on the hedonic model when a variant's own history is
    too thin to trust alone. At standard confidence (``n_i >=
    MIN_HISTORY_FOR_STANDARD``) it can only ever *add* hedonic bias on top
    of an already-sufficient own-history anchor, and the empirical-Bayes
    weight does not go to zero fast enough to make that bias negligible:
    a real card with n_i=10 (own last-known price $1,196.63, hedonic
    prediction around $30, weight = 10/18 -> 44% hedonic contribution)
    saturated the ln(3) clamp and served a 90d q50 that was a 3x
    instant-drop from the card's actual last price under "standard"
    confidence -- indefensible to a user even though it passed the
    aggregate T4 gate (young-but-standard cards are rare enough that the
    aggregate MAE gate does not catch this shape). So above the standard
    threshold the anchor is exactly the card's own last-known log price;
    the weight/clamp machinery below only ever runs for n_i below
    threshold, where packets are cold-start-only and never served at
    "standard" confidence, but must still carry an honest, back-testable
    number.
    """

    if n_i >= MIN_HISTORY_FOR_STANDARD:
        return own_log

    weight = hedonic_level_weight(n_i)
    raw_shift = (1.0 - weight) * (hedonic_pred - own_log)
    clamped_shift = max(-max_abs_shift, min(max_abs_shift, raw_shift))
    return own_log + clamped_shift


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
    hedonic_log_price: Mapping[tuple[int, str], float] | None = None,
    cold_start_variants: Mapping[tuple[int, str], int] | None = None,
    component_weights: Mapping[int, tuple[float, float]] | None = None,
) -> CategoryRunResult:
    """... (see module docstring for the model). ``hedonic_log_price`` is an
    optional, purely-additive T3 input: ``{(product_id, subTypeName): predicted
    log price}`` from a per-category hedonic fit (hedonic.py +
    hedonic_features.py). When ``None`` (the default), behavior is byte-for-byte
    identical to the pre-T3 engine. When provided:

    - Variants with ``li >= 0`` (an observed last price) blend their own
      last-known-price ANCHOR with the hedonic prediction via
      ``weight = hedonic_level_weight(final_n[i])`` -- ``n/(n+N0_HEDONIC)``,
      the same empirical-Bayes shrinkage form already used for card drift.
      At high ``n`` this weight -> 1, so the blended anchor -> the
      variant's own price and packet output is unchanged within floating
      point noise (see ZeroVolatilityLowBucketCalibrationTests-style
      regression tests / HighNInvarianceTests in test_trajectory.py).
    - Variants with ``li < 0`` (zero price observations ever --
      ``rejects["no_history"]``) previously received no packet row at
      all. If a hedonic prediction is available for such a variant, it
      now gets a pure-prior packet: confidence ``"cold-start"``, anchor =
      the hedonic log price, conformal bands = the category's single
      widest calibrated (bucket, horizon) pool, widened further by
      ``COLD_START_BAND_WIDEN_FACTOR``. Variants with no hedonic
      prediction available keep the original reject-and-skip behavior.

    ``cold_start_variants`` is a second, separate optional T3 input:
    ``{(product_id, subTypeName): groupId}`` for products that have NEVER
    appeared in ``panel_dir`` with a valid price at all (so they are not,
    and structurally cannot be, present in ``variant_index`` -- see
    ``_load_category_prices``, which only ever creates an entry from an
    already-observed valid price). Without this parameter, ``li < 0`` is
    unreachable on real data today (confirmed empirically: every current
    category's ``rejects["no_history"]`` is 0), so the cold-start branch
    above would otherwise be exercised only by synthetic unit tests. Each
    key present here but absent from the panel is folded into the same
    emission loop with a synthetic ``li = -1``, so it becomes a real
    cold-start candidate: it still only emits a packet if
    ``hedonic_log_price`` also has a prediction for that key (see
    ``hedonic_features.cold_start_candidates``, which is the intended
    source of both maps together).

    ``component_weights`` (T4 remediation): optional ``{horizon_steps: (a,
    b)}`` overriding the implicit ``(1.0, 1.0)`` in ``forecast_log =
    anchor_log + a*index_delta + b*drift*horizon_steps``, applied
    identically at both walk-forward calibration time (the ``raw_pool``
    loop) and live packet-emission time -- selected per (category,
    horizon) by ``trajectory_eval.select_component_weights`` on
    training-only origins and persisted to
    ``docs/receipts/trajectory-v1/component-weights.json``. When ``None``
    (the default), every horizon implicitly uses ``(1.0, 1.0)`` and
    packet output is byte-for-byte identical to the pre-remediation (T2/T3)
    engine -- this parameter is purely additive.
    """
    dates = index_set.dates
    n = len(dates)
    horizon_steps_list = tuple(sorted({horizon_steps_for(h) for h in horizons_days}))
    steps_by_days = {h: horizon_steps_for(h) for h in horizons_days}
    weights_by_h_steps = {
        h_steps: (component_weights.get(h_steps, (1.0, 1.0)) if component_weights else (1.0, 1.0))
        for h_steps in horizon_steps_list
    }

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
                weight_a, weight_b = weights_by_h_steps[h_steps]
                forecast_log = log(prices[i][origin]) + weight_a * index_delta + weight_b * drift_o * h_steps
                actual_log = log(prices[i][target])
                standardized = (actual_log - forecast_log) / denom
                raw_pool.append((i, h_steps, standardized))

    low_cut, high_cut, fallback_mad, bucket_mad, conformal_offsets, default_offsets, pool_sizes = (
        _calibrate_conformal(own_mad, raw_pool)
    )

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

    # Extra candidates supplied only via `cold_start_variants` (never in the
    # panel at all -- see the docstring above); folded into the same sorted
    # key space as `variant_index` so both are emitted by one loop.
    extra_cold_start = {
        key: group_id
        for key, group_id in (cold_start_variants or {}).items()
        if key not in variant_index
    }
    all_keys = sorted(set(variant_index) | set(extra_cold_start))

    raw_handle = open(tmp_path, "wb")
    gzip_handle = gzip.GzipFile(filename="", mode="wb", fileobj=raw_handle, mtime=0)
    with raw_handle, gzip_handle, io.TextIOWrapper(gzip_handle, encoding="utf-8", newline="\n") as handle:
        for product_id, subtype in all_keys:
            i = variant_index.get((product_id, subtype))
            hedonic_pred = hedonic_log_price.get((product_id, subtype)) if hedonic_log_price else None

            if i is not None:
                li = last_index_arr[i]
                mad_i = own_mad[i]
                group_id = variant_group[i]
            else:
                li = -1
                mad_i = nan
                group_id = extra_cold_start[(product_id, subtype)]

            is_cold_start = li < 0
            if is_cold_start and hedonic_pred is None:
                # Unchanged pre-T3 behavior: no observed price ever, and no
                # hedonic prior available either -- nothing to anchor a
                # forecast on.
                rejects["no_history"] += 1
                continue

            first, gfit = group_fits.get(group_id, (0, None))
            published_on = groups_metadata.get((category_id, group_id), {}).get("published_on")

            if is_cold_start:
                # T3: zero price observations ever, but a hedonic prior is
                # available -- emit a pure-prior packet instead of
                # rejecting. Forecast forward from "now" (the most recent
                # indexed date), anchored entirely on the hedonic
                # prediction, with the category's single widest calibrated
                # (bucket, horizon) conformal pool widened further by
                # COLD_START_BAND_WIDEN_FACTOR (this variant has no own
                # residual history to calibrate bands from at all).
                origin_index = n - 1
                origin_date = dates[origin_index]
                anchor_log = hedonic_pred
                n_i = 0
                drift_i = 0.0
                bucket = "unknown"
                band_widen = COLD_START_BAND_WIDEN_FACTOR
                confidence = "cold-start"
                last_known_date_out: str | None = None
                last_known_price_out: float | None = None
            else:
                origin_index = li
                origin_date = dates[li]
                lp = last_price_arr[i]
                own_log = log(lp)
                n_i = final_n[i]
                drift_i = final_drift[i]
                if hedonic_pred is not None:
                    # T3 blend (T4-capped): shrink the forecast ANCHOR (not
                    # the drift, which already has its own n/(n+N0_DRIFT)
                    # shrinkage) toward the hedonic prior by the same
                    # empirical-Bayes form, weighted by the card's own
                    # drift-fit sample size, then clamp the resulting shift
                    # -- see hedonic_blend_anchor_log's docstring. At and
                    # above MIN_HISTORY_FOR_STANDARD (the "standard"
                    # confidence threshold) this is now an exact no-op --
                    # the blend only ever runs below that threshold, where
                    # packets are cold-start/low-history only.
                    anchor_log = hedonic_blend_anchor_log(own_log, hedonic_pred, n_i)
                else:
                    anchor_log = own_log
                mad_for_band = mad_i if (not isnan(mad_i) and mad_i >= VOLATILITY_FLOOR) else fallback_mad
                bucket = volatility_bucket(mad_i, low_cut, high_cut)
                band_widen = 1.0
                weeks_stale = (as_of.date() - dates[li]).days / WEEK_DAYS
                confidence = confidence_tier(n_i=n_i, mad_i=mad_i, weeks_stale=weeks_stale)
                last_known_date_out = dates[li].isoformat()
                last_known_price_out = round(lp, 6)

            horizons_out: dict[str, dict[str, float]] = {}
            for h_days, h_steps in steps_by_days.items():
                index_delta = (
                    damped_forecast_delta(market_fit, origin_index, h_steps)
                    + damped_forecast_delta(category_fit, origin_index, h_steps)
                    + group_component_delta(
                        group_fit=gfit,
                        group_first_index=first,
                        origin_index=origin_index,
                        horizon_steps=h_steps,
                        horizon_days=h_days,
                        lifecycle_curve=lifecycle_curve,
                        published_on=str(published_on) if published_on else None,
                        origin_date=origin_date,
                    )
                )
                weight_a, weight_b = weights_by_h_steps[h_steps]
                predicted_log = anchor_log + weight_a * index_delta + weight_b * drift_i * h_steps
                if is_cold_start:
                    # The widest EFFECTIVE (bucket, h_steps) pool can differ
                    # per horizon, so both the offsets and their paired MAD
                    # scale are resolved fresh for each h_steps here (see
                    # _widest_offsets's docstring for why mad_for_band must
                    # come from the SAME pool as offsets, not fallback_mad).
                    offsets, mad_for_band = _widest_offsets(
                        conformal_offsets, h_steps, default_offsets, bucket_mad, fallback_mad,
                    )
                else:
                    offsets = conformal_offsets.get((bucket, h_steps)) or default_offsets
                quantile_values = {
                    q: exp(predicted_log + offsets.get(q, 0.0) * mad_for_band * band_widen)
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
            # The path uses the same calibrated endpoint weights as the
            # horizon quantiles. Intermediate weeks smoothly blend adjacent
            # endpoints so the visualization cannot switch regimes halfway
            # between 30d and 90d.
            for k in range(path_len):
                if k == 0:
                    delta = 0.0
                else:
                    path_weight_a, path_weight_b = interpolated_component_weights(weights_by_h_steps, k)
                    delta = (
                        path_weight_a * (
                            damped_forecast_delta(market_fit, origin_index, k)
                            + damped_forecast_delta(category_fit, origin_index, k)
                            + group_component_delta(
                                group_fit=gfit,
                                group_first_index=first,
                                origin_index=origin_index,
                                horizon_steps=k,
                                horizon_days=k * WEEK_DAYS,
                                lifecycle_curve=lifecycle_curve,
                                published_on=str(published_on) if published_on else None,
                                origin_date=origin_date,
                            )
                        )
                        + path_weight_b * drift_i * k
                    )
                point_date = origin_date + timedelta(days=WEEK_DAYS * k)
                path_points.append({
                    "date": point_date.isoformat(),
                    "price": round(exp(anchor_log + delta), 6),
                })

            row = {
                "modelVersion": MODEL_VERSION,
                "categoryId": category_id,
                "groupId": group_id,
                "productId": product_id,
                "subTypeName": subtype,
                "asOf": as_of.isoformat(),
                "lastKnownDate": last_known_date_out,
                "lastKnownPrice": last_known_price_out,
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
        variant_count=num_variants + len(extra_cold_start),
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
