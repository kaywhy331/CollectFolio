"""T4: walk-forward evaluation gate for the trajectory-v1 engine (PRD Sec4).

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
primitives (damped trend, Theta drift, lifecycle blend, the T4-capped
hedonic anchor blend, and the exact same split-conformal calibration
``_calibrate_conformal`` that ``process_category`` uses to build the packets
actually served) and ``baselines.py``'s five baseline functions completely
unmodified, computing the identical metric semantics ``evaluation.py``
implements -- just keyed by trajectory-v1's own identity instead of
evaluation.py's UUID/Supabase-lineage dataclasses. See
``docs/receipts/trajectory-v1/evaluation-summary.md`` for the pass/fail
table and serving-eligibility conclusions this module's output feeds.

Methodology note (consistent with, not a deviation from, T2's own approach):
each variant's damped-trend/Theta fits are single global fits over the
*entire* observed price history (exactly what ``process_category`` does for
production packets too); walk-forward integrity comes from only ever
*forecasting from* an origin using ``shrunk_drift_at(theta_fit, origin)`` --
the fit's causal recursion guarantees ``(level[origin], count[origin])`` use
only data at-or-before ``origin`` -- and only ever *comparing against* a
later, real, in-panel price. No origin's forecast ever uses information from
after that origin.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from hashlib import sha256
from math import exp, isnan, log
from pathlib import Path
from typing import Mapping, Sequence

from .baselines import (
    damped_momentum,
    lifecycle_cohort,
    market_index,
    no_change,
    structural_convergence,
)
from .indices import IndexSet
from .lifecycle import LifecycleCurve
from .trajectory import (
    HORIZONS_DAYS,
    REQUIRED_QUANTILES,
    VOLATILITY_FLOOR,
    WEEK_DAYS,
    _calibrate_conformal,
    _fit_group_trends,
    _load_category_prices,
    confidence_tier,
    damped_forecast_delta,
    fit_damped_trend,
    fit_theta_drift,
    group_component_delta,
    hedonic_blend_anchor_log,
    horizon_steps_for,
    last_known,
    mad_volatility,
    select_walk_forward_origins,
    shrunk_drift_at,
    variant_residual_returns,
    volatility_bucket,
)

# T4 (PRD Sec4) pass/fail thresholds.
MOVER_LOG_RETURN_THRESHOLD = log(1.05)  # ">=5% movers"
DIRECTION_ACCURACY_PASS = 0.52
COVERAGE_PASS_RANGE = (0.75, 0.88)
MIN_MOVERS_FOR_DIRECTION_CRITERION = 5

# PRD Sec4 requirement 1 ("...>=6 origins per horizon..."), and remediation's
# honest train/holdout split (requiring >=6 HOLDOUT origins alone), both need
# more walk-forward origins than production packet emission's
# MAX_ORIGINS_PER_HORIZON=5 (a deliberate compute-cost cap on the LIVE
# conformal-calibration pool, unrelated to how many origins the offline T4
# gate is allowed to walk). This evaluator therefore uses its own, larger
# origin cap. 20 (not "every available origin" -- an earlier value of 60
# made a single real ~32K-variant category's raw-case collection (O(variants
# x origins x horizons), each case computing 5 baseline forecasts) take
# several minutes) is chosen as the smallest value comfortably clearing both
# floors: at the default 0.6 train fraction / 6 min-holdout split, 20 origins
# gives ~12 train / ~8 holdout, safely above the >=6-per-side requirement
# with margin for categories where fewer origins are actually available.
EVAL_MAX_ORIGINS_PER_HORIZON = 20

# Remediation (component-weight selection): grid values for (a, b) in
# forecast_log = anchor_log + a*index_delta + b*drift_o*h_steps.
COMPONENT_WEIGHT_GRID: tuple[float, ...] = (0.0, 0.25, 0.5, 1.0)
DEFAULT_TRAIN_FRACTION = 0.6
MIN_HOLDOUT_ORIGINS = 6

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
    the component weights ``(a, b)`` -- the expensive part (per-variant
    damped-trend/Theta fits, the group/market/category index deltas at
    each origin, the T4-capped hedonic anchor, the 5 baseline predictions,
    the cohort/tier classification) is computed exactly once here.
    ``_finalize_eval_cases`` combines these into ``forecast_log = anchor_log
    + a*index_delta + b*drift_o*h_steps`` and calibrates conformal bands
    around it -- both cheap enough to redo for every grid point in
    ``select_component_weights`` without repeating any of this stage's
    O(num_variants) work.
    """

    variant_idx: int
    product_id: int
    sub_type_name: str
    group_id: int
    cohort: str
    h_steps: int
    horizon_days: int
    origin: int
    origin_date: str
    target_date: str
    current_price: float
    anchor_log: float
    index_delta: float
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
    own_mad_by_bucket_sample: list[float]  # every observed variant's own_mad (incl. nan), for tercile cutoffs
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
        h_steps: tuple(select_walk_forward_origins(n, h_steps, max_origins=max_origins_per_horizon))
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

    nan = float("nan")
    own_mad = [nan] * num_variants
    final_n = [0] * num_variants
    last_index_arr = [-1] * num_variants
    theta_fits: list = [None] * num_variants

    all_origins_seen: set[int] = set()
    for origins in origins_by_h.values():
        all_origins_seen.update(origins)
    structural_index = _StructuralPriceIndex(prices, variant_group, sorted(all_origins_seen))

    raw_cases: list[_RawCase] = []

    for i in range(num_variants):
        group_id = variant_group[i]
        residual = variant_residual_returns(prices[i], index_set, category_id, group_id)
        own_mad[i] = mad_volatility(residual)
        found = last_known(prices[i])
        if found is None:
            continue
        li, _lp = found
        last_index_arr[i] = li
        theta_fit = fit_theta_drift(list(residual))
        theta_fits[i] = theta_fit
        _drift_t, _weight_t, n_t = shrunk_drift_at(theta_fit, li)
        final_n[i] = n_t

        mad_i = own_mad[i]
        if isnan(mad_i):
            continue
        first, gfit = group_fits.get(group_id, (0, None))
        published_on = groups_metadata.get((category_id, group_id), {}).get("published_on")
        hedonic_pred = hedonic_log_price.get(key_by_index[i]) if hedonic_log_price else None
        product_id, subtype = key_by_index[i]
        weeks_stale = (dates[-1] - dates[li]).days / WEEK_DAYS
        cohort = confidence_tier(n_i=final_n[i], mad_i=mad_i, weeks_stale=weeks_stale)

        for h_steps in horizon_steps_list:
            h_days = steps_by_days[h_steps]
            for origin in origins_by_h[h_steps]:
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
                drift_o, _weight_o, n_o = shrunk_drift_at(theta_fit, origin)
                anchor_log = log(prices[i][origin])
                if hedonic_pred is not None:
                    anchor_log = hedonic_blend_anchor_log(anchor_log, hedonic_pred, n_o)
                actual_log = log(prices[i][target])
                current_price = prices[i][origin]

                daily_log_slope = drift_o / WEEK_DAYS
                market_daily_log_slope = damped_forecast_delta(market_fit, origin, 1) / WEEK_DAYS
                cohort_return = group_component_delta(
                    group_fit=gfit,
                    group_first_index=first,
                    origin_index=origin,
                    horizon_steps=h_steps,
                    horizon_days=h_days,
                    lifecycle_curve=lifecycle_curve,
                    published_on=str(published_on) if published_on else None,
                    origin_date=dates[origin],
                )
                structural_price = structural_index.median_price(group_id, origin)
                nc = no_change(current_price, h_days)
                dm = damped_momentum(current_price, h_days, daily_log_slope)
                mi = market_index(current_price, h_days, market_daily_log_slope)
                lc = lifecycle_cohort(current_price, h_days, cohort_return)
                sc = structural_convergence(current_price, h_days, structural_price)

                raw_cases.append(
                    _RawCase(
                        variant_idx=i,
                        product_id=product_id,
                        sub_type_name=subtype,
                        group_id=group_id,
                        cohort=cohort,
                        h_steps=h_steps,
                        horizon_days=h_days,
                        origin=origin,
                        origin_date=dates[origin].isoformat(),
                        target_date=dates[target].isoformat(),
                        current_price=current_price,
                        anchor_log=anchor_log,
                        index_delta=index_delta,
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
                    )
                )

    return _RawCollection(
        category_id=category_id,
        dates=dates,
        horizon_steps_list=horizon_steps_list,
        steps_by_days=steps_by_days,
        origins_by_h=origins_by_h,
        cases=raw_cases,
        own_mad_by_bucket_sample=own_mad,
        total_variants=total_variants,
        sampled_variants=sampled_variants,
        sampling_applied=sampling_applied,
        sampling_rule=SAMPLING_RULE_DESCRIPTION if sampling_applied else None,
    )


def _finalize_eval_cases(
    raw: _RawCollection,
    *,
    component_weights: Mapping[int, tuple[float, float]] | None = None,
    calibration_origins: Mapping[int, Sequence[int]] | None = None,
    case_origins: Mapping[int, Sequence[int]] | None = None,
) -> list[EvalCase]:
    """Cheap stage: combine ``_RawCase`` ingredients into forecasts under a
    given ``(a, b)`` per horizon, calibrate conformal bands from whichever
    origins are allowed to calibrate, and emit ``EvalCase`` records for
    whichever origins are allowed to be scored. See ``build_eval_cases``
    for the parameter contract (identical semantics, just split into a
    weight-independent collection stage and this weight-dependent one).
    """

    weights_by_h = {
        h_steps: (component_weights.get(h_steps, (1.0, 1.0)) if component_weights else (1.0, 1.0))
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
    # (variant_idx, h_steps, standardized) -- variant_idx (not the case-list
    # index) because _calibrate_conformal indexes `own_mad[variant_idx]`,
    # the per-variant array, exactly like process_category's own raw_pool.
    raw_pool: list[tuple[int, int, float]] = []

    for idx, rc in enumerate(raw.cases):
        weight_a, weight_b = weights_by_h[rc.h_steps]
        forecast_log = rc.anchor_log + weight_a * rc.index_delta + weight_b * rc.drift_o * rc.h_steps
        forecast_log_by_case[idx] = forecast_log
        if rc.origin in calib_allowed[rc.h_steps]:
            denom = rc.mad_i if rc.mad_i >= VOLATILITY_FLOOR else VOLATILITY_FLOOR
            standardized = (rc.actual_log - forecast_log) / denom
            raw_pool.append((rc.variant_idx, rc.h_steps, standardized))

    own_mad_for_calibration = raw.own_mad_by_bucket_sample
    (low_cut, high_cut, fallback_mad, _bucket_mad, conformal_offsets, default_offsets, _pool_sizes) = (
        _calibrate_conformal(own_mad_for_calibration, raw_pool)
    )

    cases: list[EvalCase] = []
    for idx, rc in enumerate(raw.cases):
        if rc.origin not in case_allowed[rc.h_steps]:
            continue
        forecast_log = forecast_log_by_case[idx]
        bucket = volatility_bucket(rc.mad_i, low_cut, high_cut)
        mad_for_band = rc.mad_i if (not isnan(rc.mad_i) and rc.mad_i >= VOLATILITY_FLOOR) else fallback_mad
        offsets = conformal_offsets.get((bucket, rc.h_steps)) or default_offsets
        quantile_prices = {q: exp(forecast_log + offsets.get(q, 0.0) * mad_for_band) for q in REQUIRED_QUANTILES}

        cases.append(
            EvalCase(
                product_id=rc.product_id,
                sub_type_name=rc.sub_type_name,
                group_id=rc.group_id,
                cohort=rc.cohort,
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
    component_weights: Mapping[int, tuple[float, float]] | None = None,
    calibration_origins: Mapping[int, Sequence[int]] | None = None,
    case_origins: Mapping[int, Sequence[int]] | None = None,
    max_variants_per_category: int | None = DEFAULT_MAX_VARIANTS_PER_CATEGORY,
) -> list[EvalCase]:
    """Point-in-time-safe walk-forward cases, mirroring exactly what
    ``process_category`` would have served at each historical origin: same
    damped-trend/Theta fits, same T4-capped hedonic blend, same split-
    conformal (bucket x horizon) calibration, and the same
    ``confidence_tier`` rule used to label the cohort each case belongs to
    (evaluated at the variant's *current* history state, since "should this
    cohort be served" is a forward-looking question about what confidence
    tier the variant carries today, not at each historical origin).

    ``component_weights`` (remediation): ``{horizon_steps: (a, b)}``
    overriding the default ``(1.0, 1.0)`` in
    ``forecast_log = anchor_log + a*index_delta + b*drift_o*h_steps`` --
    used by ``select_component_weights`` to grid-search per (category,
    horizon) weights, and applied honestly out-of-sample at the holdout
    gate.

    ``calibration_origins``/``case_origins`` (remediation): optional
    ``{horizon_steps: [allowed origins]}`` restricting which walk-forward
    origins contribute to (respectively) the split-conformal pool and the
    emitted ``EvalCase`` records. Both default to "every origin the (n,
    h_steps, max_origins_per_horizon) grid produces" (current, unrestricted
    T4 in-sample behavior) when ``None``. Passing disjoint sets (training
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


def drift_o_at(theta_fit, origin_index: int) -> float:
    """Unshrunk convenience accessor used only for the damped_momentum
    baseline's input slope (the baseline itself applies its own damping,
    so it deliberately uses the shrunk drift already used for the engine's
    own forecast rather than re-deriving a second slope estimate)."""

    drift_o, _weight_o, _n_o = shrunk_drift_at(theta_fit, origin_index)
    return drift_o


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
    if n_movers >= MIN_MOVERS_FOR_DIRECTION_CRITERION:
        if not (direction_accuracy > DIRECTION_ACCURACY_PASS):
            fail_reasons.append(
                f"direction accuracy on {n_movers} >=5% movers ({direction_accuracy:.4f}) <= {DIRECTION_ACCURACY_PASS}"
            )
    else:
        fail_reasons.append(f"fewer than {MIN_MOVERS_FOR_DIRECTION_CRITERION} >=5% movers ({n_movers}) -- direction accuracy not evaluable")
    if not (COVERAGE_PASS_RANGE[0] <= coverage <= COVERAGE_PASS_RANGE[1]):
        fail_reasons.append(f"80% band coverage {coverage:.4f} outside {COVERAGE_PASS_RANGE}")
    pinball_beats = pinball_e < pinball_nc
    if not pinball_beats:
        fail_reasons.append(f"pinball(q50) {pinball_e:.6f} does not beat no-change {pinball_nc:.6f}")

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
    (cohort x horizon) present. A cohort is "serving eligible" for this
    category only if it passes at BOTH horizons (matches PRD wording: "MAE
    lift over no-change > 0 at both horizons"). ``cold-start`` is not
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
    grid: Sequence[float] = COMPONENT_WEIGHT_GRID,
    train_fraction: float = DEFAULT_TRAIN_FRACTION,
    min_holdout: int = MIN_HOLDOUT_ORIGINS,
) -> dict[int, dict[str, object]]:
    """Remediation requirement 2: per (category, horizon) grid search of
    ``a, b in grid`` for ``forecast_log = anchor_log + a*index_delta +
    b*drift_o*h_steps``, selected ONLY from TRAINING origins (both the grid
    scoring itself and the conformal offsets used while scoring), and
    scored ONLY on ``cohort == "standard"`` cases -- exactly the
    remediation's wording. Returns ``{horizon_steps: {...}}`` with the
    selected ``(a, b)``, the chronological train/holdout origin split, and
    the full grid of scores for provenance.

    Deliberately takes an already-collected ``_RawCollection`` (see
    ``_collect_raw_cases``) rather than re-loading panel data, since this
    function calls the cheap ``_finalize_eval_cases`` stage once per grid
    point (``len(grid) ** 2`` times per horizon) and must not repeat the
    expensive per-variant fitting pass each time.
    """

    selection: dict[int, dict[str, object]] = {}
    for h_steps in raw.horizon_steps_list:
        h_days = raw.steps_by_days[h_steps]
        origins = raw.origins_by_h[h_steps]
        train_origins, holdout_origins = split_origins_chronologically(
            origins, train_fraction=train_fraction, min_holdout=min_holdout
        )
        train_map = {h_steps: train_origins}

        best: tuple[float, float] | None = None
        best_lift = float("-inf")
        best_result: CohortHorizonResult | None = None
        grid_scores: list[dict[str, object]] = []

        for a in grid:
            for b in grid:
                finalized = _finalize_eval_cases(
                    raw,
                    component_weights={h_steps: (a, b)},
                    calibration_origins=train_map,
                    case_origins=train_map,
                )
                standard_cases = [c for c in finalized if c.cohort == "standard" and c.horizon_days == h_days]
                result = evaluate_cohort_horizon(raw.category_id, "standard", h_days, standard_cases)
                lift = result.mae_lift_over_no_change
                grid_scores.append({
                    "weightA": a, "weightB": b, "nCases": result.n_cases,
                    "maeLiftOverNoChange": lift if not isnan(lift) else None,
                })
                # NaN lift (n_cases == 0) can never win a real (a, b); guard
                # explicitly so an all-empty grid doesn't "select" garbage.
                if result.n_cases > 0 and not isnan(lift) and lift > best_lift:
                    best_lift = lift
                    best = (a, b)
                    best_result = result

        if best is None:
            # No (a, b) produced any standard-cohort training case at all --
            # fall back to the PRD default (1, 1) so downstream code always
            # has a defined weight, but this is recorded as unevaluable, not
            # silently treated as "selected."
            best = (1.0, 1.0)
            best_lift = float("nan")

        selection[h_steps] = {
            "horizonDays": h_days,
            "weightA": best[0],
            "weightB": best[1],
            "trainMaeLiftOverNoChange": best_lift if not isnan(best_lift) else None,
            "trainNCases": best_result.n_cases if best_result else 0,
            "trainOrigins": list(train_origins),
            "holdoutOrigins": list(holdout_origins),
            "gridScores": grid_scores,
            "zeroWeightZeroLift": bool(best == (0.0, 0.0) and best_lift == 0.0),
        }

    return selection


def gate_holdout_evaluation(
    raw: _RawCollection,
    selection: Mapping[int, Mapping[str, object]],
) -> dict[str, object]:
    """Remediation requirement 3: the honest out-of-sample gate. Applies
    each horizon's selected ``(a, b)`` and evaluates ONLY holdout-origin
    cases, with conformal offsets calibrated ONLY from that horizon's
    training origins (never recalibrated on holdout) -- fixing the
    original T4 evaluator's in-sample pooling bug. Produces the full
    pass/fail table per (cohort x horizon), matching ``evaluate_category``'s
    shape so downstream receipt-writing code can treat both the same way.
    """

    component_weights = {h_steps: (sel["weightA"], sel["weightB"]) for h_steps, sel in selection.items()}
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
                                  fail_reasons=result.fail_reasons + ["selected weights are (0, 0) with lift exactly 0"])
            results.append(result)

    eligible_by_cohort = {}
    for cohort in cohorts:
        cohort_results = [r for r in results if r.cohort == cohort]
        eligible_by_cohort[cohort] = bool(cohort_results) and all(r.serving_eligible for r in cohort_results)

    return {
        "categoryId": raw.category_id,
        "componentWeights": {sel["horizonDays"]: (sel["weightA"], sel["weightB"]) for sel in selection.values()},
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
    grid: Sequence[float] = COMPONENT_WEIGHT_GRID,
    train_fraction: float = DEFAULT_TRAIN_FRACTION,
    min_holdout: int = MIN_HOLDOUT_ORIGINS,
    max_variants_per_category: int | None = DEFAULT_MAX_VARIANTS_PER_CATEGORY,
) -> dict[str, object]:
    """One-call entry point tying the remediation together for a single
    category: collect raw ingredients once, grid-search per-horizon
    component weights on training origins (``select_component_weights``),
    then gate-evaluate on holdout origins with training-fixed conformal
    calibration (``gate_holdout_evaluation``). This is what the CLI/receipt
    writer and the cat-85 smoke test call.
    """

    raw = _collect_raw_cases(
        panel_dir, category_id, index_set, lifecycle_curve, groups_metadata,
        horizons_days=horizons_days, hedonic_log_price=hedonic_log_price,
        max_origins_per_horizon=max_origins_per_horizon,
        max_variants_per_category=max_variants_per_category,
    )
    selection = select_component_weights(raw, grid=grid, train_fraction=train_fraction, min_holdout=min_holdout)
    gate = gate_holdout_evaluation(raw, selection)
    return {
        "categoryId": category_id,
        "selection": selection,
        "gate": gate,
        "totalVariants": raw.total_variants,
        "sampledVariants": raw.sampled_variants,
        "samplingApplied": raw.sampling_applied,
        "samplingRule": raw.sampling_rule,
    }
