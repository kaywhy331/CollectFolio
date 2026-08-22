"""Causal, held-out-set validation for the trajectory-v1.1 engine.

**Documented deviation from the PRD's literal "using the existing
evaluation.py machinery" wording.** ``evaluation.py``'s dataclasses
(``PriceSeriesKey``, ``WalkForwardAudit``, ``ResearchLineage``,
``ForecastCase``) are built for the *other*, Supabase-backed live-serving
subsystem: ``PriceSeriesKey.canonical_variant_id`` is validated as a UUID in
``__post_init__``, and ``ResearchLineage``/``PriceObservation`` require
provenance fields (``source_observation_id``, ``available_at``,
``dataset_sha256`` as 64-hex) that do not exist in trajectory-v1's simpler
panel-native identity space (``category_id, product_id, subTypeName`` plus a
weekly array index). Synthesizing UUIDs and fabricated lineage records to
force trajectory-v1 packets through those exact dataclasses would add a
translation layer with no evaluation benefit -- what the PRD's gate actually
needs is the walk-forward *methodology and metric semantics* (point-in-time-
safe origins, MAE log-return lift over no-change, direction accuracy on
>=5% movers, pinball(q50), 80% band coverage), not those specific classes.

This module is therefore a lightweight, trajectory-v1-native walk-forward
evaluator: it reuses every one of trajectory.py's real fitted-model
primitives (damped trend, Theta drift, lifecycle blend, and the same
split-conformal quantile rules that ``process_category`` uses to build the
packets actually served) and ``baselines.py``'s five baseline functions completely
unmodified, computing the identical metric semantics ``evaluation.py``
implements -- just keyed by trajectory-v1's own identity instead of
evaluation.py's UUID/Supabase-lineage dataclasses. See
``docs/receipts/trajectory-v1/evaluation-summary.md`` for the pass/fail
table and serving-eligibility conclusions this module's output feeds.

The validator uses non-overlapping horizon blocks and recomputes every
origin-sensitive feature (lifecycle curve, MAD/volatility bucket, history
tier, set age, mean-reversion signal) from information available at that
origin.  Smoothing parameters are fixed in ``trajectory.py``.  Coefficients
are selected on past blocks only and each scored set is excluded from the
coefficient-selection target rows used for its score.
"""

from __future__ import annotations

from bisect import bisect_right
from dataclasses import dataclass, replace
from hashlib import sha256
from math import exp, isfinite, isnan, log
from pathlib import Path
from random import Random
from statistics import median
from typing import Mapping, Sequence

from .baselines import (
    damped_momentum,
    lifecycle_cohort,
    market_index,
    no_change,
    structural_convergence,
)
from .indices import IndexSet
from .lifecycle import LifecycleCurve, build_lifecycle_curve, release_age_weeks
from .trajectory import (
    HORIZONS_DAYS,
    REQUIRED_QUANTILES,
    VOLATILITY_FLOOR,
    WEEK_DAYS,
    _fit_group_trends,
    _load_category_prices,
    component_coefficients,
    confidence_tier,
    damped_forecast_delta,
    empirical_quantile,
    fit_damped_trend,
    fit_theta_drift,
    group_component_delta,
    horizon_steps_for,
    last_known,
    mad_volatility,
    own_level_reversion_at,
    shrunk_drift_at,
    variant_residual_returns,
    volatility_bucket,
)

# Trajectory-v1.1 diagnostic and qualification thresholds.
MOVER_LOG_RETURN_THRESHOLD = log(1.05)  # ">=5% movers"
COVERAGE_PASS_RANGE = (0.75, 0.88)

# A 131-week backfilled panel produces 28+12+9 block origins across the
# three horizons, so this remains a safety ceiling rather than a sampling
# rule.  Exceeding it is recorded as an error instead of silently dropping
# validation blocks.
EVAL_MAX_ORIGINS_PER_HORIZON = 64

# Preregistered trajectory-v1.1 coefficient grid:
# point = anchor + a*common + c*own-level-reversion + b*Theta-drift*h.
COMMON_WEIGHT_GRID: tuple[float, ...] = (0.0, 0.25, 0.5, 1.0)
REVERSION_WEIGHT_GRID: tuple[float, ...] = (0.0, 0.1, 0.25, 0.5)
DRIFT_WEIGHT_GRID: tuple[float, ...] = (-0.25, 0.0, 0.25)
# Compatibility name retained for operator/tests that referred to the old
# common/drift grid.  New selection uses the three grids above.
COMPONENT_WEIGHT_GRID = COMMON_WEIGHT_GRID
DEFAULT_TRAIN_FRACTION = 0.6
MIN_HOLDOUT_ORIGINS = 6
MIN_INITIAL_FIT_BLOCKS = 2
MIN_SCORED_BLOCKS = 3
MIN_SET_VARIANTS = 20
SET_NO_HARM_TOLERANCE = -0.005
SET_NO_HARM_FRACTION = 0.80
BOOTSTRAP_CONFIDENCE = 0.90
BOOTSTRAP_REPLICATES = 400

# Deterministic variant-count cap for _collect_raw_cases (remediation
# follow-up: real category-1's variant count made even the (already
# origin-capped) raw-case collection RSS-infeasible on this box's actual
# ~0.8-1.2GB steady headroom -- cat85 needed 1.17GB at 32,365 variants, so
# an uncapped 5x-larger category is infeasible as-is). Sizing target: peak
# RSS <=900MB/category; cat85's ~36KB/variant implies N=20000 -> ~730MB.
DEFAULT_MAX_VARIANTS_PER_CATEGORY = 20_000

SAMPLING_RULE_DESCRIPTION = (
    "deterministic N-of-M variant sample: every (productId, subTypeName) key "
    "is ranked by sha256(f'{productId}|{subTypeName}')'s hex digest "
    "(ties broken by the key itself), and the first N in that ranking are "
    "kept -- order-independent (depends only on the key set, not on load "
    "order) and exactly reproducible."
)


def _sample_variant_keys(
    keys: Sequence[tuple[int, str]], max_variants: int | None
) -> set[tuple[int, str]]:
    """Deterministic, order-independent N-of-M sample of variant keys.

    No-op (returns every key) when ``max_variants`` is ``None`` or the
    category already has ``<= max_variants`` variants -- "no silent caps"
    for categories under the threshold. Otherwise ranks every key by the
    hex digest of ``sha256(f"{productId}|{subTypeName}")`` and keeps the
    first ``max_variants`` in that ranking, tie-broken by the key itself
    (astronomically unlikely to matter, but keeps the ranking a strict
    total order). Depends only on the input key set, not iteration/load
    order, so re-running on the same panel always keeps the same variants.
    """

    keys = list(keys)
    if max_variants is None or len(keys) <= max_variants:
        return set(keys)
    ranked = sorted(
        keys,
        key=lambda k: (sha256(f"{k[0]}|{k[1]}".encode("utf-8")).hexdigest(), k[0], k[1]),
    )
    return set(ranked[:max_variants])


@dataclass(frozen=True, slots=True)
class EvalCase:
    """One point-in-time-safe walk-forward (variant, horizon, origin) case."""

    product_id: int
    sub_type_name: str
    group_id: int
    cohort: str
    horizon_days: int
    origin_date: str
    target_date: str
    current_price: float
    realized_price: float
    engine_median_price: float
    engine_q10_price: float
    engine_q90_price: float
    baseline_median_prices: dict[str, float]
    volatility_bucket: str = "unknown"
    set_age_bucket: str = "unknown-age"


def _median_of(sorted_pool: Sequence[float]) -> float:
    mid = len(sorted_pool) // 2
    if len(sorted_pool) % 2:
        return max(sorted_pool[mid], 1e-6)
    return max((sorted_pool[mid - 1] + sorted_pool[mid]) / 2.0, 1e-6)


class _StructuralPriceIndex:
    """A self-contained "structural fair value" index: the median price, at
    a given origin, among other variants in the same product group (e.g.
    the same set/expansion) -- the peer price level
    ``structural_convergence`` closes part of the gap toward. Falls back to
    the category-wide median at that origin when the group has no other
    priced peers at that date (e.g. a singleton group).

    Built once per category, over only the handful of distinct origins
    ``select_walk_forward_origins`` actually produces (origins depend only
    on ``(n_dates, horizon_steps)``, not on the variant, so every variant at
    a given horizon shares the same small origin set) -- O(num_variants x
    num_distinct_origins), not O(num_cases x num_variants), which is what a
    naive per-case linear scan over every other variant would cost (this
    module originally did exactly that and was orders of magnitude too
    slow on a real ~34K-variant category; see T4 receipts).
    """

    def __init__(self, prices: Sequence[Sequence[float]], variant_group: Sequence[int], origins: Sequence[int]):
        self._by_group: dict[int, dict[int, list[float]]] = {}
        self._by_category: dict[int, list[float]] = {}
        for origin in origins:
            group_pool: dict[int, list[float]] = {}
            category_pool: list[float] = []
            for j, group_id in enumerate(variant_group):
                p = prices[j][origin]
                if isnan(p):
                    continue
                group_pool.setdefault(group_id, []).append(p)
                category_pool.append(p)
            self._by_group[origin] = {g: sorted(v) for g, v in group_pool.items()}
            self._by_category[origin] = sorted(category_pool)

    def median_price(self, group_id: int, origin: int) -> float:
        pool = self._by_group.get(origin, {}).get(group_id, [])
        if len(pool) < 2:
            pool = self._by_category.get(origin, [])
        if not pool:
            return 1.0
        return _median_of(pool)


def select_non_overlapping_origins(
    n_dates: int,
    horizon_steps: int,
    *,
    min_origin_index: int = 15,
    max_origins: int | None = EVAL_MAX_ORIGINS_PER_HORIZON,
) -> tuple[int, ...]:
    """Return preregistered, non-overlapping validation block origins.

    Origins are exactly ``min_origin_index + k*horizon_steps`` and are kept
    only when their target matures inside the panel.  Unlike the old evenly
    spaced sampler, adjacent targets cannot share most of their return
    window and masquerade as independent evidence.
    """

    if any(isinstance(value, bool) or not isinstance(value, int) for value in (n_dates, horizon_steps, min_origin_index)):
        raise ValueError("origin parameters must be integers")
    if n_dates <= 0 or horizon_steps <= 0 or min_origin_index < 0:
        raise ValueError("invalid origin parameters")
    last_valid = n_dates - 1 - horizon_steps
    if last_valid < min_origin_index:
        return ()
    origins = tuple(range(min_origin_index, last_valid + 1, horizon_steps))
    if max_origins is not None and len(origins) > max_origins:
        raise ValueError(
            f"{len(origins)} validation blocks exceed the explicit max_origins={max_origins}; "
            "raise the ceiling instead of silently sampling blocks"
        )
    return origins


def split_origins_chronologically(
    origins: Sequence[int],
    *,
    train_fraction: float = DEFAULT_TRAIN_FRACTION,
    min_holdout: int = MIN_HOLDOUT_ORIGINS,
) -> tuple[tuple[int, ...], tuple[int, ...]]:
    """Chronological (not random) train/holdout split of a horizon's
    distinct walk-forward origins, so weight selection is honestly
    out-of-sample: training only ever sees the earlier ~``train_fraction``
    of origins, holdout only the later ones. Guarantees at least
    ``min_holdout`` holdout origins whenever there are enough origins to
    give any at all (shrinking the training side, never the reverse --
    the holdout side is what gates serving, so it is never sacrificed to
    give training more data).
    """

    ordered = sorted(set(origins))
    total = len(ordered)
    if total == 0:
        return (), ()
    k = round(total * train_fraction)
    k = max(0, min(total, k))
    if total - k < min(min_holdout, total):
        k = max(0, total - min(min_holdout, total))
    return tuple(ordered[:k]), tuple(ordered[k:])


@dataclass(frozen=True, slots=True)
class _RawCase:
    """Every (variant, horizon, origin) ingredient that does NOT depend on
    the component weights ``(a, c, b)`` -- the expensive part (per-variant
    damped-trend/Theta fits, the common-index delta, causal lifecycle and
    own-level signals, the five baseline predictions, and cohort/tier
    classification) is computed exactly once here. Hedonic price levels are
    deliberately excluded from the directional model.
    ``_finalize_eval_cases`` combines these into ``forecast_log = anchor_log
    + a*index_delta + c*reversion_o + b*drift_o*h_steps`` and calibrates conformal bands
    around it -- both cheap enough to redo for every grid point in
    ``select_component_weights`` without repeating any of this stage's
    O(num_variants) work.
    """

    variant_idx: int
    product_id: int
    sub_type_name: str
    group_id: int
    cohort: str
    volatility_bucket: str
    set_age_bucket: str
    h_steps: int
    horizon_days: int
    origin: int
    origin_date: str
    target_date: str
    current_price: float
    anchor_log: float
    index_delta: float
    reversion_o: float
    drift_o: float
    actual_log: float
    mad_i: float
    baseline_median_prices: dict[str, float]


@dataclass(frozen=True, slots=True)
class _RawCollection:
    category_id: int
    dates: Sequence
    horizon_steps_list: tuple[int, ...]
    steps_by_days: dict[int, int]
    origins_by_h: dict[int, tuple[int, ...]]
    cases: list[_RawCase]
    total_variants: int
    sampled_variants: int
    sampling_applied: bool
    sampling_rule: str | None


def _collect_raw_cases(
    panel_dir: Path,
    category_id: int,
    index_set: IndexSet,
    lifecycle_curve: LifecycleCurve,
    groups_metadata: Mapping[tuple[int, int], Mapping[str, object]],
    *,
    horizons_days: Sequence[int],
    hedonic_log_price: Mapping[tuple[int, str], float] | None,
    max_origins_per_horizon: int,
    max_variants_per_category: int | None = DEFAULT_MAX_VARIANTS_PER_CATEGORY,
) -> _RawCollection:
    dates = index_set.dates
    n = len(dates)
    horizon_steps_list = tuple(sorted({horizon_steps_for(h) for h in horizons_days}))
    steps_by_days = {horizon_steps_for(h): h for h in horizons_days}
    origins_by_h = {
        h_steps: select_non_overlapping_origins(
            n, h_steps, max_origins=max_origins_per_horizon
        )
        for h_steps in horizon_steps_list
    }

    market_fit = fit_damped_trend(list(index_set.market))
    category_fit = fit_damped_trend(list(index_set.category[category_id]))
    group_fits = _fit_group_trends(index_set, category_id)

    variant_index, variant_group, prices = _load_category_prices(panel_dir, category_id, dates)
    total_variants = len(variant_index)

    # Deterministic variant sampling: applied BEFORE any per-variant fitting
    # so it actually bounds the raw-case-collection RSS/CPU (sampling after
    # the fact would still have paid the full O(total_variants) cost).
    # Reindexes variant_index/variant_group/prices down to just the sampled
    # keys (0..sampled_variants-1, ordered by the sampled key set's own
    # sort order) so every downstream loop below -- which only ever
    # iterates `range(num_variants)` -- transparently sees the smaller
    # universe without any other code needing to know sampling happened.
    sampled_keys = _sample_variant_keys(list(variant_index.keys()), max_variants_per_category)
    sampling_applied = len(sampled_keys) < total_variants
    if sampling_applied:
        kept_keys = sorted(sampled_keys)
        new_variant_index: dict[tuple[int, str], int] = {}
        new_variant_group: list[int] = []
        new_prices: list = []
        for new_i, key in enumerate(kept_keys):
            old_i = variant_index[key]
            new_variant_index[key] = new_i
            new_variant_group.append(variant_group[old_i])
            new_prices.append(prices[old_i])
        variant_index = new_variant_index
        variant_group = new_variant_group
        prices = new_prices

    num_variants = len(variant_index)
    key_by_index = {i: key for key, i in variant_index.items()}
    sampled_variants = num_variants

    all_origins = sorted({origin for origins in origins_by_h.values() for origin in origins})
    structural_index = _StructuralPriceIndex(prices, variant_group, all_origins)

    # Historical evaluation must not reuse the full-panel curve or hedonic
    # predictions.  Curves are rebuilt at block boundaries; low/cold-start
    # hedonic anchors remain descriptive reference ranges outside the
    # predictive gate.
    _ = lifecycle_curve, hedonic_log_price
    lifecycle_by_origin = {
        origin: build_lifecycle_curve(index_set, groups_metadata, up_to_index=origin)
        for origin in all_origins
    }

    nan = float("nan")
    theta_fits: list = [None] * num_variants
    last_indices = [-1] * num_variants
    mad_by_origin = {origin: [nan] * num_variants for origin in all_origins}

    for i in range(num_variants):
        group_id = variant_group[i]
        residual = variant_residual_returns(prices[i], index_set, category_id, group_id)
        found = last_known(prices[i])
        if found is None:
            continue
        last_indices[i] = found[0]
        theta_fits[i] = fit_theta_drift(list(residual))
        for origin in all_origins:
            mad_by_origin[origin][i] = mad_volatility(residual[: origin + 1])

    cutoffs_by_origin: dict[int, tuple[float, float]] = {}
    for origin, values in mad_by_origin.items():
        cleaned = sorted(value for value in values if not isnan(value))
        if not cleaned:
            cutoffs_by_origin[origin] = (0.0, 0.0)
            continue

        def _quantile(position: float) -> float:
            lo = int(position)
            hi = min(lo + 1, len(cleaned) - 1)
            fraction = position - lo
            return cleaned[lo] + (cleaned[hi] - cleaned[lo]) * fraction

        cutoffs_by_origin[origin] = (
            _quantile((len(cleaned) - 1) / 3),
            _quantile(2 * (len(cleaned) - 1) / 3),
        )

    raw_cases: list[_RawCase] = []
    for i in range(num_variants):
        theta_fit = theta_fits[i]
        if theta_fit is None:
            continue
        group_id = variant_group[i]
        first, group_fit = group_fits.get(group_id, (0, None))
        published_on = groups_metadata.get((category_id, group_id), {}).get("published_on")
        product_id, subtype = key_by_index[i]

        for h_steps in horizon_steps_list:
            nominal_days = steps_by_days[h_steps]
            actual_days = h_steps * WEEK_DAYS
            for origin in origins_by_h[h_steps]:
                target = origin + h_steps
                if (
                    origin >= last_indices[i]
                    or target >= n
                    or isnan(prices[i][origin])
                    or isnan(prices[i][target])
                ):
                    continue
                mad_i = mad_by_origin[origin][i]
                if isnan(mad_i):
                    continue
                low_cut, high_cut = cutoffs_by_origin[origin]
                bucket = volatility_bucket(mad_i, low_cut, high_cut)
                drift_o, _weight_o, n_o = shrunk_drift_at(theta_fit, origin)
                cohort = confidence_tier(n_i=n_o, mad_i=mad_i, weeks_stale=0.0)
                age_weeks = release_age_weeks(
                    str(published_on) if published_on else None, dates[origin]
                )
                age_bucket = (
                    "unknown-age" if age_weeks is None
                    else "young" if age_weeks < 26
                    else "established"
                )
                group_delta = group_component_delta(
                    group_fit=group_fit,
                    group_first_index=first,
                    origin_index=origin,
                    horizon_steps=h_steps,
                    horizon_days=actual_days,
                    lifecycle_curve=lifecycle_by_origin[origin],
                    published_on=str(published_on) if published_on else None,
                    origin_date=dates[origin],
                )
                index_delta = (
                    damped_forecast_delta(market_fit, origin, h_steps)
                    + damped_forecast_delta(category_fit, origin, h_steps)
                    + group_delta
                )
                current_price = prices[i][origin]
                anchor_log = log(current_price)
                actual_log = log(prices[i][target])
                reversion_o = own_level_reversion_at(
                    prices[i], index_set, category_id, group_id, origin
                )
                daily_log_slope = drift_o / WEEK_DAYS
                market_daily_log_slope = damped_forecast_delta(market_fit, origin, 1) / WEEK_DAYS
                structural_price = structural_index.median_price(group_id, origin)
                nc = no_change(current_price, actual_days)
                dm = damped_momentum(current_price, actual_days, daily_log_slope)
                mi = market_index(current_price, actual_days, market_daily_log_slope)
                lc = lifecycle_cohort(current_price, actual_days, group_delta)
                sc = structural_convergence(current_price, actual_days, structural_price)

                raw_cases.append(_RawCase(
                    variant_idx=i,
                    product_id=product_id,
                    sub_type_name=subtype,
                    group_id=group_id,
                    cohort=cohort,
                    volatility_bucket=bucket,
                    set_age_bucket=age_bucket,
                    h_steps=h_steps,
                    horizon_days=nominal_days,
                    origin=origin,
                    origin_date=dates[origin].isoformat(),
                    target_date=dates[target].isoformat(),
                    current_price=current_price,
                    anchor_log=anchor_log,
                    index_delta=index_delta,
                    reversion_o=reversion_o,
                    drift_o=drift_o,
                    actual_log=actual_log,
                    mad_i=mad_i,
                    baseline_median_prices={
                        nc.model_key: nc.median_price,
                        dm.model_key: dm.median_price,
                        mi.model_key: mi.median_price,
                        lc.model_key: lc.median_price,
                        sc.model_key: sc.median_price,
                    },
                ))

    return _RawCollection(
        category_id=category_id,
        dates=dates,
        horizon_steps_list=horizon_steps_list,
        steps_by_days=steps_by_days,
        origins_by_h=origins_by_h,
        cases=raw_cases,
        total_variants=total_variants,
        sampled_variants=sampled_variants,
        sampling_applied=sampling_applied,
        sampling_rule=SAMPLING_RULE_DESCRIPTION if sampling_applied else None,
    )


def _finalize_eval_cases(
    raw: _RawCollection,
    *,
    component_weights: Mapping[int, Sequence[float]] | None = None,
    calibration_origins: Mapping[int, Sequence[int]] | None = None,
    case_origins: Mapping[int, Sequence[int]] | None = None,
) -> list[EvalCase]:
    """Cheap stage: combine ``_RawCase`` ingredients into forecasts under a
    given ``(a, c, b)`` per horizon, calibrate conformal bands from whichever
    origins are allowed to calibrate, and emit ``EvalCase`` records for
    whichever origins are allowed to be scored. See ``build_eval_cases``
    for the parameter contract (identical semantics, just split into a
    weight-independent collection stage and this weight-dependent one).
    """

    weights_by_h = {
        h_steps: component_coefficients(component_weights.get(h_steps) if component_weights else None)
        for h_steps in raw.horizon_steps_list
    }
    # `.get(h_steps, ...)` (not `[h_steps]`) deliberately: select_component_weights
    # passes a restriction map for only the ONE horizon it is currently
    # tuning (e.g. `{h_steps: train_origins}`); every other horizon must
    # fall back to its full unrestricted origin set rather than KeyError.
    calib_allowed = {
        h_steps: set(calibration_origins.get(h_steps, raw.origins_by_h[h_steps])) if calibration_origins is not None else set(raw.origins_by_h[h_steps])
        for h_steps in raw.horizon_steps_list
    }
    case_allowed = {
        h_steps: set(case_origins.get(h_steps, raw.origins_by_h[h_steps])) if case_origins is not None else set(raw.origins_by_h[h_steps])
        for h_steps in raw.horizon_steps_list
    }

    forecast_log_by_case: list[float] = [0.0] * len(raw.cases)
    calibration_pools: dict[tuple[str, int], list[float]] = {}

    for idx, rc in enumerate(raw.cases):
        weight_a, weight_c, weight_b = weights_by_h[rc.h_steps]
        forecast_log = (
            rc.anchor_log
            + weight_a * rc.index_delta
            + weight_c * rc.reversion_o
            + weight_b * rc.drift_o * rc.h_steps
        )
        forecast_log_by_case[idx] = forecast_log
        if rc.origin in calib_allowed[rc.h_steps]:
            denom = rc.mad_i if rc.mad_i >= VOLATILITY_FLOOR else VOLATILITY_FLOOR
            standardized = (rc.actual_log - forecast_log) / denom
            calibration_pools.setdefault((rc.volatility_bucket, rc.h_steps), []).append(standardized)

    conformal_offsets: dict[tuple[str, int], dict[float, float]] = {}
    for key, values in calibration_pools.items():
        values.sort()
        empirical = {q: empirical_quantile(values, q) for q in REQUIRED_QUANTILES}
        conformal_offsets[key] = {
            q: 0.0 if q == 0.5 else min(empirical[q], 0.0) if q < 0.5 else max(empirical[q], 0.0)
            for q in REQUIRED_QUANTILES
        }
    default_offsets = {q: (q - 0.5) * 2.0 for q in REQUIRED_QUANTILES}

    cases: list[EvalCase] = []
    for idx, rc in enumerate(raw.cases):
        if rc.origin not in case_allowed[rc.h_steps]:
            continue
        forecast_log = forecast_log_by_case[idx]
        mad_for_band = max(rc.mad_i, VOLATILITY_FLOOR)
        offsets = conformal_offsets.get((rc.volatility_bucket, rc.h_steps)) or default_offsets
        quantile_prices = {q: exp(forecast_log + offsets.get(q, 0.0) * mad_for_band) for q in REQUIRED_QUANTILES}
        quantile_prices[0.5] = exp(forecast_log)

        cases.append(
            EvalCase(
                product_id=rc.product_id,
                sub_type_name=rc.sub_type_name,
                group_id=rc.group_id,
                cohort=rc.cohort,
                volatility_bucket=rc.volatility_bucket,
                set_age_bucket=rc.set_age_bucket,
                horizon_days=rc.horizon_days,
                origin_date=rc.origin_date,
                target_date=rc.target_date,
                current_price=rc.current_price,
                realized_price=exp(rc.actual_log),
                engine_median_price=quantile_prices[0.5],
                engine_q10_price=quantile_prices[0.10],
                engine_q90_price=quantile_prices[0.90],
                baseline_median_prices=rc.baseline_median_prices,
            )
        )

    return cases


def build_eval_cases(
    panel_dir: Path,
    category_id: int,
    index_set: IndexSet,
    lifecycle_curve: LifecycleCurve,
    groups_metadata: Mapping[tuple[int, int], Mapping[str, object]],
    *,
    horizons_days: Sequence[int] = HORIZONS_DAYS,
    hedonic_log_price: Mapping[tuple[int, str], float] | None = None,
    max_origins_per_horizon: int = EVAL_MAX_ORIGINS_PER_HORIZON,
    component_weights: Mapping[int, Sequence[float]] | None = None,
    calibration_origins: Mapping[int, Sequence[int]] | None = None,
    case_origins: Mapping[int, Sequence[int]] | None = None,
    max_variants_per_category: int | None = DEFAULT_MAX_VARIANTS_PER_CATEGORY,
) -> list[EvalCase]:
    """Point-in-time-safe walk-forward cases, mirroring exactly what
    ``process_category`` would have served at each historical origin: fixed
    damped-trend/Theta parameters, an origin-censored lifecycle curve,
    origin-time volatility and confidence labels, no hedonic level anchor,
    and split-conformal (bucket x horizon) calibration.

    ``component_weights``: ``{horizon_steps: (a, c, b)}`` overriding the
    default ``(1.0, 0.0, 1.0)`` in ``forecast_log = anchor_log +
    a*index_delta + c*reversion_o + b*drift_o*h_steps``.

    ``calibration_origins``/``case_origins``: optional
    ``{horizon_steps: [allowed origins]}`` restricting which walk-forward
    origins contribute to (respectively) the split-conformal pool and the
    emitted ``EvalCase`` records. Both default to "every origin the (n,
    h_steps, max_origins_per_horizon) grid produces" (current, unrestricted
    compatibility behavior) when ``None``. Passing disjoint sets (training
    origins for calibration, holdout origins for cases) is exactly the
    honest out-of-sample gate the remediation requires: bands and the
    median point forecast for a holdout case are calibrated purely from
    training-origin residuals, never from the holdout data being scored.

    This is a thin convenience wrapper around ``_collect_raw_cases`` (the
    expensive, weight-independent per-variant fitting pass) followed by
    ``_finalize_eval_cases`` (the cheap, weight-dependent forecast +
    calibration pass). ``select_component_weights`` calls the two stages
    directly so it only pays the expensive pass once per category, not once
    per grid point.
    """

    raw = _collect_raw_cases(
        panel_dir, category_id, index_set, lifecycle_curve, groups_metadata,
        horizons_days=horizons_days, hedonic_log_price=hedonic_log_price,
        max_origins_per_horizon=max_origins_per_horizon,
        max_variants_per_category=max_variants_per_category,
    )
    return _finalize_eval_cases(
        raw, component_weights=component_weights,
        calibration_origins=calibration_origins, case_origins=case_origins,
    )


@dataclass(frozen=True, slots=True)
class CohortHorizonResult:
    category_id: int
    cohort: str
    horizon_days: int
    n_cases: int
    mae_engine: float
    mae_no_change: float
    mae_lift_over_no_change: float
    n_movers: int
    direction_accuracy_movers: float | None
    coverage_80: float
    pinball_q50_engine: float
    pinball_q50_no_change: float
    pinball_beats_no_change: bool
    baseline_mae: dict[str, float]
    passes: bool
    fail_reasons: list[str]
    serving_eligible: bool
    n_score_blocks: int = 0
    eligible_set_count: int = 0
    macro_set_lift: float = float("nan")
    bootstrap_lift_lower_90: float = float("nan")
    sets_no_harm_fraction: float = float("nan")
    coverage_cells: tuple[tuple[str, int, float], ...] = ()
    validation_scope: str = "out-of-time"
    evidence_tier: str = "range-only"


def _pinball_q50(realized_price: float, median_price: float) -> float:
    diff = log(realized_price) - log(median_price)
    return 0.5 * abs(diff)


def evaluate_cohort_horizon(
    category_id: int,
    cohort: str,
    horizon_days: int,
    cases: Sequence[EvalCase],
) -> CohortHorizonResult:
    n_cases = len(cases)
    fail_reasons: list[str] = []

    if n_cases == 0:
        return CohortHorizonResult(
            category_id=category_id,
            cohort=cohort,
            horizon_days=horizon_days,
            n_cases=0,
            mae_engine=float("nan"),
            mae_no_change=float("nan"),
            mae_lift_over_no_change=float("nan"),
            n_movers=0,
            direction_accuracy_movers=None,
            coverage_80=float("nan"),
            pinball_q50_engine=float("nan"),
            pinball_q50_no_change=float("nan"),
            pinball_beats_no_change=False,
            baseline_mae={},
            passes=False,
            fail_reasons=["no walk-forward cases available"],
            serving_eligible=False,
        )

    engine_abs_errs = []
    no_change_abs_errs = []
    covered = 0
    mover_correct = 0
    n_movers = 0
    pinball_engine = []
    pinball_no_change = []
    baseline_abs_errs: dict[str, list[float]] = {}

    for case in cases:
        actual_log = log(case.realized_price)
        current_log = log(case.current_price)
        engine_log = log(case.engine_median_price)

        engine_abs_errs.append(abs(actual_log - engine_log))
        no_change_abs_errs.append(abs(actual_log - current_log))
        pinball_engine.append(_pinball_q50(case.realized_price, case.engine_median_price))
        pinball_no_change.append(_pinball_q50(case.realized_price, case.current_price))

        if case.engine_q10_price <= case.realized_price <= case.engine_q90_price:
            covered += 1

        actual_return = actual_log - current_log
        if abs(actual_return) >= MOVER_LOG_RETURN_THRESHOLD:
            n_movers += 1
            engine_return = engine_log - current_log
            if (engine_return >= 0) == (actual_return >= 0):
                mover_correct += 1

        for model_key, predicted_price in case.baseline_median_prices.items():
            if model_key == "no_change":
                continue
            baseline_abs_errs.setdefault(model_key, []).append(abs(actual_log - log(predicted_price)))

    mae_engine = sum(engine_abs_errs) / n_cases
    mae_no_change = sum(no_change_abs_errs) / n_cases
    lift = mae_no_change - mae_engine
    coverage = covered / n_cases
    pinball_e = sum(pinball_engine) / n_cases
    pinball_nc = sum(pinball_no_change) / n_cases
    direction_accuracy = (mover_correct / n_movers) if n_movers > 0 else None
    baseline_mae = {k: sum(v) / len(v) for k, v in baseline_abs_errs.items()}

    if not (lift > 0):
        fail_reasons.append(f"MAE lift over no-change not positive ({lift:.6f})")
    # Direction accuracy remains diagnostic.  It is not an independent
    # promotion gate because sparse mover labels are unstable and MAE lift
    # already scores both sign and magnitude.
    if not (COVERAGE_PASS_RANGE[0] <= coverage <= COVERAGE_PASS_RANGE[1]):
        fail_reasons.append(f"80% band coverage {coverage:.4f} outside {COVERAGE_PASS_RANGE}")
    pinball_beats = pinball_e < pinball_nc
    # q50 pinball is exactly half absolute log error and is reported for
    # comparability, not counted as a duplicate gate.

    passes = not fail_reasons
    return CohortHorizonResult(
        category_id=category_id,
        cohort=cohort,
        horizon_days=horizon_days,
        n_cases=n_cases,
        mae_engine=mae_engine,
        mae_no_change=mae_no_change,
        mae_lift_over_no_change=lift,
        n_movers=n_movers,
        direction_accuracy_movers=direction_accuracy,
        coverage_80=coverage,
        pinball_q50_engine=pinball_e,
        pinball_q50_no_change=pinball_nc,
        pinball_beats_no_change=pinball_beats,
        baseline_mae=baseline_mae,
        passes=passes,
        fail_reasons=fail_reasons,
        serving_eligible=passes,
    )


def _lower_percentile(values: Sequence[float], probability: float) -> float:
    ordered = sorted(value for value in values if isfinite(value))
    if not ordered:
        return float("nan")
    return ordered[max(0, min(len(ordered) - 1, int(probability * (len(ordered) - 1))))]


def _apply_held_out_set_gate(
    result: CohortHorizonResult,
    cases: Sequence[EvalCase],
) -> CohortHorizonResult:
    """Apply the preregistered held-out-set generalization requirements."""

    reasons = list(result.fail_reasons)
    # Count blocks that actually contributed cases for this cohort.  A
    # nominal score origin with no eligible cases is not validation evidence.
    n_score_blocks = len({case.origin_date for case in cases})
    if n_score_blocks < MIN_SCORED_BLOCKS:
        reasons.append(
            f"only {n_score_blocks} non-overlapping scored blocks; at least {MIN_SCORED_BLOCKS} required"
        )

    # Category-demeaned return errors make the set-level test about relative
    # card/set effects instead of awarding every set the same market move.
    by_origin: dict[str, list[EvalCase]] = {}
    for case in cases:
        by_origin.setdefault(case.origin_date, []).append(case)
    relative_lift_by_case: dict[int, float] = {}
    for origin_cases in by_origin.values():
        actual_returns = [log(case.realized_price / case.current_price) for case in origin_cases]
        predicted_returns = [log(case.engine_median_price / case.current_price) for case in origin_cases]
        actual_center = median(actual_returns)
        predicted_center = median(predicted_returns)
        for case, actual_return, predicted_return in zip(origin_cases, actual_returns, predicted_returns):
            actual_relative = actual_return - actual_center
            predicted_relative = predicted_return - predicted_center
            relative_lift_by_case[id(case)] = abs(actual_relative) - abs(actual_relative - predicted_relative)

    by_group: dict[int, list[EvalCase]] = {}
    for case in cases:
        by_group.setdefault(case.group_id, []).append(case)
    eligible_groups = {
        group_id
        for group_id, group_cases in by_group.items()
        if len({(case.product_id, case.sub_type_name) for case in group_cases}) >= MIN_SET_VARIANTS
    }
    group_lifts = {
        group_id: sum(relative_lift_by_case[id(case)] for case in by_group[group_id]) / len(by_group[group_id])
        for group_id in eligible_groups
    }
    macro_lift = (
        sum(group_lifts.values()) / len(group_lifts)
        if group_lifts else float("nan")
    )
    no_harm_fraction = (
        sum(lift >= SET_NO_HARM_TOLERANCE for lift in group_lifts.values()) / len(group_lifts)
        if group_lifts else float("nan")
    )
    if len(eligible_groups) < 3:
        reasons.append(
            f"only {len(eligible_groups)} eligible held-out sets; at least 3 with {MIN_SET_VARIANTS}+ variants required"
        )
    if not (isfinite(macro_lift) and macro_lift > 0):
        reasons.append("macro-average held-out-set relative MAE lift is not positive")
    if not (isfinite(no_harm_fraction) and no_harm_fraction >= SET_NO_HARM_FRACTION):
        reasons.append(
            f"fewer than {SET_NO_HARM_FRACTION:.0%} of eligible sets meet the {SET_NO_HARM_TOLERANCE:.3f} no-harm floor"
        )

    # Cluster bootstrap across both independent score blocks and sets.
    cell_values: dict[tuple[str, int], list[float]] = {}
    for case in cases:
        if case.group_id in eligible_groups:
            cell_values.setdefault((case.origin_date, case.group_id), []).append(relative_lift_by_case[id(case)])
    # Collapse each block x set cell first so large sets cannot dominate the
    # held-out-set interval merely by contributing more variants.
    cell_means = {
        key: sum(values) / len(values)
        for key, values in cell_values.items()
        if values
    }
    origin_labels = sorted({origin for origin, _group in cell_means})
    group_labels = sorted(eligible_groups)
    bootstrap: list[float] = []
    if origin_labels and group_labels:
        rng = Random(0xC011EC7F0110)
        for _iteration in range(BOOTSTRAP_REPLICATES):
            sampled_origins = [origin_labels[rng.randrange(len(origin_labels))] for _ in origin_labels]
            sampled_groups = [group_labels[rng.randrange(len(group_labels))] for _ in group_labels]
            values: list[float] = []
            for origin in sampled_origins:
                for group_id in sampled_groups:
                    cell = cell_means.get((origin, group_id))
                    if cell is not None:
                        values.append(cell)
            if values:
                bootstrap.append(sum(values) / len(values))
    bootstrap_lower = _lower_percentile(bootstrap, (1.0 - BOOTSTRAP_CONFIDENCE) / 2.0)
    if not (isfinite(bootstrap_lower) and bootstrap_lower > 0):
        reasons.append("cluster-bootstrap 90% lower bound for held-out-set lift is not positive")

    coverage_cells: list[tuple[str, int, float]] = []
    grouped_coverage: dict[str, list[bool]] = {}
    for case in cases:
        label = f"{case.volatility_bucket}:{case.set_age_bucket}"
        grouped_coverage.setdefault(label, []).append(
            case.engine_q10_price <= case.realized_price <= case.engine_q90_price
        )
    for label, covered in sorted(grouped_coverage.items()):
        if len(covered) < 500:
            continue
        coverage = sum(covered) / len(covered)
        coverage_cells.append((label, len(covered), coverage))
        if not (COVERAGE_PASS_RANGE[0] <= coverage <= COVERAGE_PASS_RANGE[1]):
            reasons.append(
                f"80% coverage for {label} ({coverage:.4f}, n={len(covered)}) outside {COVERAGE_PASS_RANGE}"
            )

    if result.cohort != "standard":
        reasons.append("directional validation is restricted to the standard-history cohort")

    passes = not reasons
    return replace(
        result,
        passes=passes,
        serving_eligible=passes,
        fail_reasons=reasons,
        n_score_blocks=n_score_blocks,
        eligible_set_count=len(eligible_groups),
        macro_set_lift=macro_lift,
        bootstrap_lift_lower_90=bootstrap_lower,
        sets_no_harm_fraction=no_harm_fraction,
        coverage_cells=tuple(coverage_cells),
        validation_scope="held-out-set-and-time",
        evidence_tier="category-validated" if passes else "range-only",
    )


def evaluate_category(
    panel_dir: Path,
    category_id: int,
    index_set: IndexSet,
    lifecycle_curve: LifecycleCurve,
    groups_metadata: Mapping[tuple[int, int], Mapping[str, object]],
    *,
    horizons_days: Sequence[int] = HORIZONS_DAYS,
    hedonic_log_price: Mapping[tuple[int, str], float] | None = None,
) -> dict[str, object]:
    """Build all walk-forward cases for a category and evaluate every
    (cohort x horizon) present. This legacy convenience entry point reports
    aggregate eligibility across every requested horizon; production v1.1
    qualification uses ``gate_rolling_evaluation`` and publishes evidence
    tiers per horizon. ``cold-start`` is not
    produced by ``build_eval_cases`` at all -- by construction, every
    ``cold_start_variants`` key never has an observed price anywhere in the
    panel (see ``process_category``'s docstring), so no later-truth
    walk-forward case can ever exist for it from this dataset alone; it is
    reported separately as ``unevaluable`` (PRD Sec4 hard criterion 3b).
    """

    cases = build_eval_cases(
        panel_dir, category_id, index_set, lifecycle_curve, groups_metadata,
        horizons_days=horizons_days, hedonic_log_price=hedonic_log_price,
    )

    by_cohort_horizon: dict[tuple[str, int], list[EvalCase]] = {}
    for case in cases:
        by_cohort_horizon.setdefault((case.cohort, case.horizon_days), []).append(case)

    cohorts = sorted({c for c, _h in by_cohort_horizon} | {"standard", "low-history", "insufficient-history"})
    results: list[CohortHorizonResult] = []
    for cohort in cohorts:
        for h_days in sorted(horizons_days):
            group_cases = by_cohort_horizon.get((cohort, h_days), [])
            results.append(evaluate_cohort_horizon(category_id, cohort, h_days, group_cases))

    eligible_by_cohort = {}
    for cohort in cohorts:
        cohort_results = [r for r in results if r.cohort == cohort]
        eligible_by_cohort[cohort] = bool(cohort_results) and all(r.serving_eligible for r in cohort_results)

    return {
        "categoryId": category_id,
        "results": results,
        "servingEligibleByCohort": eligible_by_cohort,
        "coldStart": {
            "status": "unevaluable",
            "reason": (
                "cold-start variants (cold_start_variants keys with no observed "
                "price anywhere in the panel) structurally cannot produce a "
                "later-truth walk-forward case from this dataset; serve only "
                "with explicit cold-start labeling per PRD Sec4 hard criterion 3b."
            ),
        },
        "anyCohortServingEligible": any(eligible_by_cohort.values()),
    }


def select_component_weights(
    raw: _RawCollection,
    *,
    grid: Sequence[float] | None = None,
    common_grid: Sequence[float] = COMMON_WEIGHT_GRID,
    reversion_grid: Sequence[float] = REVERSION_WEIGHT_GRID,
    drift_grid: Sequence[float] = DRIFT_WEIGHT_GRID,
    train_fraction: float = DEFAULT_TRAIN_FRACTION,
    min_holdout: int = MIN_HOLDOUT_ORIGINS,
) -> dict[int, dict[str, object]]:
    """Deployment fit: per-(category, horizon) grid search of
    ``a, c, b`` for ``forecast_log = anchor_log + a*index_delta +
    c*reversion_o + b*drift_o*h_steps``, selected only from chronologically
    earlier fit origins and scored only on ``cohort == "standard"`` cases.
    Returns ``{horizon_steps: {...}}`` with the selected ``(a, c, b)``, the
    chronological fit/diagnostic split, and the full grid of scores for
    provenance. Independent qualification is performed by
    ``gate_rolling_evaluation`` with rolling time blocks and held-out sets.

    Deliberately takes an already-collected ``_RawCollection`` (see
    ``_collect_raw_cases``) rather than re-loading panel data. Coefficient
    selection scores the point formula directly: conformal offsets do not
    affect q50 and therefore need not be materialized for every grid point.
    """

    if grid is not None:
        common_grid = grid
        reversion_grid = (0.0,)
        drift_grid = grid

    selection: dict[int, dict[str, object]] = {}
    for h_steps in raw.horizon_steps_list:
        h_days = raw.steps_by_days[h_steps]
        origins = raw.origins_by_h[h_steps]
        train_origins, holdout_origins = split_origins_chronologically(
            origins, train_fraction=train_fraction, min_holdout=min_holdout
        )
        train_origin_set = set(train_origins)
        training_cases = [
            case
            for case in raw.cases
            if case.h_steps == h_steps
            and case.origin in train_origin_set
            and case.cohort == "standard"
        ]
        n_training_cases = len(training_cases)
        no_change_error = sum(
            abs(case.actual_log - case.anchor_log) for case in training_cases
        )

        best: tuple[float, float, float] | None = None
        best_lift = float("-inf")
        best_n_cases = 0
        grid_scores: list[dict[str, object]] = []

        for a in common_grid:
            for c in reversion_grid:
                for b in drift_grid:
                    if n_training_cases:
                        engine_error = sum(
                            abs(
                                case.actual_log
                                - (
                                    case.anchor_log
                                    + a * case.index_delta
                                    + c * case.reversion_o
                                    + b * case.drift_o * case.h_steps
                                )
                            )
                            for case in training_cases
                        )
                        lift = (no_change_error - engine_error) / n_training_cases
                    else:
                        lift = float("nan")
                    grid_scores.append({
                        "weightA": a, "weightC": c, "weightB": b, "nCases": n_training_cases,
                        "maeLiftOverNoChange": lift if not isnan(lift) else None,
                    })
                    if n_training_cases > 0 and not isnan(lift) and lift > best_lift:
                        best_lift = lift
                        best = (a, c, b)
                        best_n_cases = n_training_cases

        if best is None:
            # No tuple produced any standard-cohort training case at all --
            # fall back to the conservative identity tuple so downstream code always
            # has a defined weight, but this is recorded as unevaluable, not
            # silently treated as "selected."
            best = (1.0, 0.0, 1.0)
            best_lift = float("nan")

        selection[h_steps] = {
            "horizonDays": h_days,
            "weightA": best[0],
            "weightC": best[1],
            "weightB": best[2],
            "trainMaeLiftOverNoChange": best_lift if not isnan(best_lift) else None,
            "trainNCases": best_n_cases,
            "trainOrigins": list(train_origins),
            "holdoutOrigins": list(holdout_origins),
            "gridScores": grid_scores,
            "zeroWeightZeroLift": bool(best == (0.0, 0.0, 0.0) and best_lift == 0.0),
        }

    return selection


def _candidate_coefficients() -> tuple[tuple[float, float, float], ...]:
    return tuple(
        (a, c, b)
        for a in COMMON_WEIGHT_GRID
        for c in REVERSION_WEIGHT_GRID
        for b in DRIFT_WEIGHT_GRID
    )


def _raw_forecast_log(case: _RawCase, coefficients: Sequence[float]) -> float:
    a, c, b = component_coefficients(coefficients)
    return (
        case.anchor_log
        + a * case.index_delta
        + c * case.reversion_o
        + b * case.drift_o * case.h_steps
    )


def _quantiles_excluding_group(
    sorted_values: Sequence[float],
    excluded_positions: Sequence[int],
    probabilities: Sequence[float],
) -> dict[float, float]:
    """Return quantiles after removing one group from a sorted pool.

    Binary-searching ranks avoids filtering and sorting the full conformal
    pool separately for every scored set while preserving the exact linear
    interpolation used by ``empirical_quantile``.
    """

    remaining = len(sorted_values) - len(excluded_positions)
    if remaining <= 0:
        return {}

    def value_at(rank: int) -> float:
        low = 0
        high = len(sorted_values) - 1
        while low < high:
            middle = (low + high) // 2
            available = middle + 1 - bisect_right(excluded_positions, middle)
            if available > rank:
                high = middle
            else:
                low = middle + 1
        return float(sorted_values[low])

    output: dict[float, float] = {}
    for probability in probabilities:
        position = probability * (remaining - 1)
        lower_rank = int(position)
        upper_rank = min(lower_rank + 1, remaining - 1)
        fraction = position - lower_rank
        lower = value_at(lower_rank)
        upper = value_at(upper_rank)
        output[probability] = lower + (upper - lower) * fraction
    return output


def _rolling_held_out_set_cases(
    raw: _RawCollection,
) -> tuple[list[EvalCase], list[dict[str, object]]]:
    """Build cases where every scored set and time block is held out.

    At score block ``k``, coefficients and conformal residuals use blocks
    ``[:k]`` only.  For each scored group, that group's target rows are also
    removed from coefficient selection and calibration.
    """

    candidates = _candidate_coefficients()
    emitted: list[EvalCase] = []
    block_receipts: list[dict[str, object]] = []

    for h_steps in raw.horizon_steps_list:
        origins = raw.origins_by_h[h_steps]
        score_origins = origins[MIN_INITIAL_FIT_BLOCKS:]
        horizon_cases = [case for case in raw.cases if case.h_steps == h_steps]
        cases_by_origin: dict[int, list[_RawCase]] = {}
        for case in horizon_cases:
            cases_by_origin.setdefault(case.origin, []).append(case)

        fit_cases: list[_RawCase] = []
        added_fit_origins: set[int] = set()
        # These sufficient statistics grow one newly matured block at a
        # time. Recomputing every prior block at every score origin made the
        # same errors O(number_of_blocks) times.
        selection_stats: dict[
            tuple[float, float, float],
            list[object],
        ] = {
            coefficients: [0.0, 0, {}]
            for coefficients in candidates
        }

        for score_origin in score_origins:
            new_fit_cases: list[_RawCase] = []
            for fit_origin in origins:
                if fit_origin >= score_origin or fit_origin in added_fit_origins:
                    continue
                origin_cases = cases_by_origin.get(fit_origin, [])
                fit_cases.extend(origin_cases)
                new_fit_cases.extend(origin_cases)
                added_fit_origins.add(fit_origin)

            new_standard_fit = [case for case in new_fit_cases if case.cohort == "standard"]
            for coefficients, stats in selection_stats.items():
                total_error = float(stats[0])
                total_n = int(stats[1])
                by_group = stats[2]
                assert isinstance(by_group, dict)
                for case in new_standard_fit:
                    error = abs(case.actual_log - _raw_forecast_log(case, coefficients))
                    total_error += error
                    total_n += 1
                    group_error, group_n = by_group.get(case.group_id, (0.0, 0))
                    by_group[case.group_id] = (group_error + error, group_n + 1)
                stats[0] = total_error
                stats[1] = total_n

            score_cases = cases_by_origin.get(score_origin, [])
            score_groups = sorted({case.group_id for case in score_cases})

            selected_by_group: dict[int, tuple[float, float, float]] = {}
            for held_out_group in score_groups:
                best_key: tuple[float, float, tuple[float, float, float]] | None = None
                best_coefficients = (0.0, 0.0, 0.0)
                for coefficients, stats in selection_stats.items():
                    total_error = float(stats[0])
                    total_n = int(stats[1])
                    by_group = stats[2]
                    assert isinstance(by_group, dict)
                    group_error, group_n = by_group.get(held_out_group, (0.0, 0))
                    n_excluding = total_n - group_n
                    if n_excluding <= 0:
                        continue
                    mae = (total_error - group_error) / n_excluding
                    complexity = sum(abs(value) for value in coefficients)
                    key = (mae, complexity, coefficients)
                    if best_key is None or key < best_key:
                        best_key = key
                        best_coefficients = coefficients
                selected_by_group[held_out_group] = best_coefficients

            # Calibration pools are built only for coefficient tuples that
            # actually won at this block.  Entries retain group identity so
            # the scored group's own prior target residuals can be removed.
            pool_entries: dict[
                tuple[tuple[float, float, float], str], list[tuple[int, float]]
            ] = {}
            for coefficients in set(selected_by_group.values()):
                for case in fit_cases:
                    denom = max(case.mad_i, VOLATILITY_FLOOR)
                    standardized = (case.actual_log - _raw_forecast_log(case, coefficients)) / denom
                    pool_entries.setdefault((coefficients, case.volatility_bucket), []).append(
                        (case.group_id, standardized)
                    )

            sorted_pools: dict[
                tuple[tuple[float, float, float], str],
                tuple[list[float], dict[int, list[int]]],
            ] = {}
            for key, entries in pool_entries.items():
                ordered = sorted(entries, key=lambda entry: entry[1])
                values: list[float] = []
                positions_by_group: dict[int, list[int]] = {}
                for position, (group_id, value) in enumerate(ordered):
                    values.append(value)
                    positions_by_group.setdefault(group_id, []).append(position)
                sorted_pools[key] = (values, positions_by_group)

            offset_cache: dict[tuple[tuple[float, float, float], int, str], dict[float, float]] = {}
            default_offsets = {q: (q - 0.5) * 2.0 for q in REQUIRED_QUANTILES}
            coefficient_counts: dict[str, int] = {}
            for held_out_group, coefficients in selected_by_group.items():
                coefficient_counts[str(coefficients)] = coefficient_counts.get(str(coefficients), 0) + 1

            for case in score_cases:
                coefficients = selected_by_group[case.group_id]
                cache_key = (coefficients, case.group_id, case.volatility_bucket)
                offsets = offset_cache.get(cache_key)
                if offsets is None:
                    values, positions_by_group = sorted_pools.get(
                        (coefficients, case.volatility_bucket), ([], {})
                    )
                    empirical = _quantiles_excluding_group(
                        values,
                        positions_by_group.get(case.group_id, ()),
                        REQUIRED_QUANTILES,
                    )
                    if empirical:
                        offsets = {
                            q: 0.0 if q == 0.5 else min(empirical[q], 0.0) if q < 0.5 else max(empirical[q], 0.0)
                            for q in REQUIRED_QUANTILES
                        }
                    else:
                        offsets = default_offsets
                    offset_cache[cache_key] = offsets

                forecast_log = _raw_forecast_log(case, coefficients)
                mad_scale = max(case.mad_i, VOLATILITY_FLOOR)
                quantiles = {
                    q: exp(forecast_log + offsets[q] * mad_scale)
                    for q in REQUIRED_QUANTILES
                }
                quantiles[0.5] = exp(forecast_log)
                emitted.append(EvalCase(
                    product_id=case.product_id,
                    sub_type_name=case.sub_type_name,
                    group_id=case.group_id,
                    cohort=case.cohort,
                    volatility_bucket=case.volatility_bucket,
                    set_age_bucket=case.set_age_bucket,
                    horizon_days=case.horizon_days,
                    origin_date=case.origin_date,
                    target_date=case.target_date,
                    current_price=case.current_price,
                    realized_price=exp(case.actual_log),
                    engine_median_price=quantiles[0.5],
                    engine_q10_price=quantiles[0.10],
                    engine_q90_price=quantiles[0.90],
                    baseline_median_prices=case.baseline_median_prices,
                ))

            block_receipts.append({
                "horizonDays": raw.steps_by_days[h_steps],
                "origin": score_origin,
                "fitOrigins": [origin for origin in origins if origin < score_origin],
                "scoredSets": len(score_groups),
                "scoredCases": len(score_cases),
                "selectedCoefficientCounts": coefficient_counts,
            })

    return emitted, block_receipts


def gate_rolling_evaluation(
    raw: _RawCollection,
    deployment_selection: Mapping[int, Mapping[str, object]],
) -> dict[str, object]:
    cases, block_receipts = _rolling_held_out_set_cases(raw)
    by_cohort_horizon: dict[tuple[str, int], list[EvalCase]] = {}
    for case in cases:
        by_cohort_horizon.setdefault((case.cohort, case.horizon_days), []).append(case)

    cohorts = sorted({case.cohort for case in cases} | {"standard", "low-history", "insufficient-history"})
    results: list[CohortHorizonResult] = []
    for cohort in cohorts:
        for h_steps in raw.horizon_steps_list:
            horizon_days = raw.steps_by_days[h_steps]
            grouped = by_cohort_horizon.get((cohort, horizon_days), [])
            result = evaluate_cohort_horizon(raw.category_id, cohort, horizon_days, grouped)
            result = _apply_held_out_set_gate(result, grouped)
            selection = deployment_selection.get(h_steps, {})
            if result.passes and float(selection.get("weightA", 1.0)) == 0.0:
                result = replace(result, evidence_tier="relative-validated")
            results.append(result)

    eligible_by_cohort = {
        cohort: any(result.serving_eligible for result in results if result.cohort == cohort)
        for cohort in cohorts
    }
    return {
        "categoryId": raw.category_id,
        "componentWeights": {
            selection["horizonDays"]: (
                selection["weightA"], selection.get("weightC", 0.0), selection["weightB"]
            )
            for selection in deployment_selection.values()
        },
        "results": results,
        "servingEligibleByCohort": eligible_by_cohort,
        "coldStart": {
            "status": "reference-only",
            "reason": "No observed current price exists; hedonic output is an attribute-based reference range, never a directional forecast.",
        },
        "anyCohortServingEligible": any(eligible_by_cohort.values()),
        "validationProtocol": {
            "originRule": "15 + k*h, non-overlapping",
            "minimumInitialFitBlocks": MIN_INITIAL_FIT_BLOCKS,
            "minimumScoredBlocks": MIN_SCORED_BLOCKS,
            "setHoldout": "leave-one-set-out within each rolling score block",
            "bootstrap": f"{BOOTSTRAP_CONFIDENCE:.0%} cluster interval over time blocks x sets",
            "q50PinnedToPointModel": True,
            "blockReceipts": block_receipts,
        },
    }


def gate_holdout_evaluation(
    raw: _RawCollection,
    selection: Mapping[int, Mapping[str, object]],
) -> dict[str, object]:
    """Legacy chronological-holdout evaluator retained for compatibility.
    Applies
    each horizon's selected ``(a, c, b)`` and evaluates ONLY holdout-origin
    cases, with conformal offsets calibrated ONLY from that horizon's
    training origins (never recalibrated on holdout) -- fixing the
    the original evaluator's in-sample pooling bug. Produces the full
    pass/fail table per (cohort x horizon), matching ``evaluate_category``'s
    shape so older callers can treat both paths the same way. Current
    qualification uses ``gate_rolling_evaluation`` instead.
    """

    component_weights = {
        h_steps: (sel["weightA"], sel.get("weightC", 0.0), sel["weightB"])
        for h_steps, sel in selection.items()
    }
    calibration_origins = {h_steps: sel["trainOrigins"] for h_steps, sel in selection.items()}
    case_origins = {h_steps: sel["holdoutOrigins"] for h_steps, sel in selection.items()}

    cases = _finalize_eval_cases(
        raw,
        component_weights=component_weights,
        calibration_origins=calibration_origins,
        case_origins=case_origins,
    )

    by_cohort_horizon: dict[tuple[str, int], list[EvalCase]] = {}
    for case in cases:
        by_cohort_horizon.setdefault((case.cohort, case.horizon_days), []).append(case)

    cohorts = sorted({c for c, _h in by_cohort_horizon} | {"standard", "low-history", "insufficient-history"})
    horizon_days_list = sorted({sel["horizonDays"] for sel in selection.values()})
    results: list[CohortHorizonResult] = []
    for cohort in cohorts:
        for h_days in horizon_days_list:
            group_cases = by_cohort_horizon.get((cohort, h_days), [])
            result = evaluate_cohort_horizon(raw.category_id, cohort, h_days, group_cases)
            # Remediation requirement 5: a=b=0 with lift exactly 0 must be
            # recorded as FAIL, no fudging. evaluate_cohort_horizon's
            # `lift > 0` check already fails lift == 0 naturally; this is a
            # belt-and-suspenders explicit check in case a future numerical
            # tie (lift == 0.0 exactly, e.g. from an all-zero-weight
            # selection) needs to be surfaced distinctly in the receipt.
            h_steps = next((hs for hs, sel in selection.items() if sel["horizonDays"] == h_days), None)
            zero_weight_zero_lift = bool(h_steps is not None and selection[h_steps].get("zeroWeightZeroLift"))
            if zero_weight_zero_lift and result.passes:
                # Should be unreachable (lift == 0 already fails), but never
                # silently let a zero/zero selection read as a pass.
                result = replace(result, passes=False, serving_eligible=False,
                                  fail_reasons=result.fail_reasons + ["selected weights are (0, 0, 0) with lift exactly 0"])
            results.append(result)

    eligible_by_cohort = {}
    for cohort in cohorts:
        cohort_results = [r for r in results if r.cohort == cohort]
        eligible_by_cohort[cohort] = bool(cohort_results) and all(r.serving_eligible for r in cohort_results)

    return {
        "categoryId": raw.category_id,
        "componentWeights": {
            sel["horizonDays"]: (sel["weightA"], sel.get("weightC", 0.0), sel["weightB"])
            for sel in selection.values()
        },
        "results": results,
        "servingEligibleByCohort": eligible_by_cohort,
        "coldStart": {
            "status": "unevaluable",
            "reason": (
                "cold-start variants (cold_start_variants keys with no observed "
                "price anywhere in the panel) structurally cannot produce a "
                "later-truth walk-forward case from this dataset; serve only "
                "with explicit cold-start labeling per PRD Sec4 hard criterion 3b."
            ),
        },
        "anyCohortServingEligible": any(eligible_by_cohort.values()),
    }


def run_component_weight_remediation(
    panel_dir: Path,
    category_id: int,
    index_set: IndexSet,
    lifecycle_curve: LifecycleCurve,
    groups_metadata: Mapping[tuple[int, int], Mapping[str, object]],
    *,
    horizons_days: Sequence[int] = HORIZONS_DAYS,
    hedonic_log_price: Mapping[tuple[int, str], float] | None = None,
    max_origins_per_horizon: int = EVAL_MAX_ORIGINS_PER_HORIZON,
    grid: Sequence[float] | None = None,
    train_fraction: float = 1.0,
    min_holdout: int = 0,
    max_variants_per_category: int | None = DEFAULT_MAX_VARIANTS_PER_CATEGORY,
) -> dict[str, object]:
    """One-call entry point tying the remediation together for a single
    category: collect causal raw ingredients once, select deployment
    coefficients from all matured blocks, then independently validate the
    architecture with rolling time blocks and leave-one-set-out targets.
    """

    raw = _collect_raw_cases(
        panel_dir, category_id, index_set, lifecycle_curve, groups_metadata,
        horizons_days=horizons_days, hedonic_log_price=hedonic_log_price,
        max_origins_per_horizon=max_origins_per_horizon,
        max_variants_per_category=max_variants_per_category,
    )
    selection = select_component_weights(raw, grid=grid, train_fraction=train_fraction, min_holdout=min_holdout)
    gate = gate_rolling_evaluation(raw, selection)
    return {
        "categoryId": category_id,
        "selection": selection,
        "gate": gate,
        "totalVariants": raw.total_variants,
        "sampledVariants": raw.sampled_variants,
        "samplingApplied": raw.sampling_applied,
        "samplingRule": raw.sampling_rule,
    }
