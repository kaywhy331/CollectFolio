import gzip
import json
import math
import random
import shutil
import tempfile
import unittest
from array import array
from datetime import date, timedelta
from pathlib import Path

from collectfolio_analytics.indices import IndexSet, build_indices
from collectfolio_analytics.lifecycle import build_lifecycle_curve
from collectfolio_analytics.trajectory import (
    HORIZONS_DAYS,
    MAX_HEDONIC_BLEND_LOG_SHIFT,
    MIN_HISTORY_FOR_STANDARD,
    N0_DRIFT,
    REQUIRED_QUANTILES,
    STALE_WEEKS_THRESHOLD,
    ThetaDriftFit,
    _calibrate_conformal,
    confidence_tier,
    content_sha256,
    damped_forecast_delta,
    empirical_quantile,
    fit_damped_trend,
    fit_theta_drift,
    hedonic_blend_anchor_log,
    horizon_steps_for,
    horizon_actual_days_for,
    interpolated_component_weights,
    mad_volatility,
    own_level_reversion_at,
    process_category,
    select_walk_forward_origins,
    shrunk_drift_at,
    tercile_cutoffs,
    variant_residual_returns,
    volatility_bucket,
)


class HorizonStepsForTests(unittest.TestCase):
    def test_30_60_and_90_days_map_onto_the_weekly_grid(self):
        self.assertEqual(horizon_steps_for(30), 4)  # 30/7 = 4.29 -> 4
        self.assertEqual(horizon_steps_for(60), 9)  # 60/7 = 8.57 -> 9
        self.assertEqual(horizon_steps_for(90), 13)  # 90/7 = 12.86 -> 13
        self.assertEqual(HORIZONS_DAYS, (30, 60, 90))
        self.assertEqual(
            [horizon_actual_days_for(horizon) for horizon in HORIZONS_DAYS],
            [28, 63, 91],
        )

    def test_rejects_non_positive(self):
        with self.assertRaises(ValueError):
            horizon_steps_for(0)


class InterpolatedComponentWeightsTests(unittest.TestCase):
    def test_preserves_calibrated_endpoints_and_blends_between_them(self):
        weights = {4: (0.0, 0.25), 13: (0.9, 1.0)}

        self.assertEqual(interpolated_component_weights(weights, 1), weights[4])
        self.assertEqual(interpolated_component_weights(weights, 4), weights[4])
        self.assertEqual(interpolated_component_weights(weights, 13), weights[13])
        self.assertEqual(interpolated_component_weights(weights, 20), weights[13])

        weight_a, weight_b = interpolated_component_weights(weights, 8)
        self.assertAlmostEqual(weight_a, 0.4)
        self.assertAlmostEqual(weight_b, 0.25 + ((1.0 - 0.25) * (4 / 9)))

    def test_defaults_to_identity_when_no_horizon_weights_exist(self):
        self.assertEqual(interpolated_component_weights({}, 8), (1.0, 1.0))


class DampedTrendHandComputedTests(unittest.TestCase):
    """phi fixed to a single grid value so the recursion is hand-verifiable.

    l0=0, b0=1 (levels[1]-levels[0]); alpha=0.3, beta=0.1, phi=0.8 (defaults).
    t=1: l1 = 0.3*1 + 0.7*(0+0.8*1) = 0.86; b1 = 0.1*0.86 + 0.9*0.8*1 = 0.806
    t=2: l2 = 0.3*2 + 0.7*(0.86+0.8*0.806) = 1.65336
         b2 = 0.1*(1.65336-0.86) + 0.9*0.8*0.806 = 0.659656
    """

    def setUp(self):
        self.fit = fit_damped_trend([0.0, 1.0, 2.0], phi_grid=(0.8,))

    def test_phi_is_the_single_grid_value(self):
        self.assertEqual(self.fit.phi, 0.8)

    def test_level_and_trend_match_hand_computation(self):
        self.assertAlmostEqual(self.fit.level[0], 0.0, places=9)
        self.assertAlmostEqual(self.fit.trend[0], 1.0, places=9)
        self.assertAlmostEqual(self.fit.level[1], 0.86, places=9)
        self.assertAlmostEqual(self.fit.trend[1], 0.806, places=9)
        self.assertAlmostEqual(self.fit.level[2], 1.65336, places=9)
        self.assertAlmostEqual(self.fit.trend[2], 0.659656, places=9)

    def test_forecast_delta_one_step_from_origin_zero(self):
        # h=1: b*phi*(1-phi)/(1-phi) = b*phi = 1.0*0.8 = 0.8
        self.assertAlmostEqual(damped_forecast_delta(self.fit, 0, 1), 0.8, places=9)

    def test_forecast_delta_two_steps_from_origin_two(self):
        # h=2: b*phi*(1+phi) = 0.659656*0.8*1.8 = 0.9500...
        # b*phi*(1+phi) since (1-phi^2)/(1-phi) = 1+phi
        expected = 0.659656 * 0.8 * (1 + 0.8)
        self.assertAlmostEqual(damped_forecast_delta(self.fit, 2, 2), expected, places=9)
        self.assertAlmostEqual(damped_forecast_delta(self.fit, 2, 2), 0.94990464, places=8)

    def test_phi_near_one_uses_the_linear_limit(self):
        fit = fit_damped_trend([0.0, 1.0, 2.0], phi_grid=(0.95,))
        # abs(phi-1) is not < 1e-12 here so the ratio branch runs; just check
        # it stays finite and roughly proportional to horizon for a small h.
        d1 = damped_forecast_delta(fit, 1, 1)
        d2 = damped_forecast_delta(fit, 1, 2)
        self.assertTrue(math.isfinite(d1) and math.isfinite(d2))

    def test_rejects_degenerate_input(self):
        with self.assertRaises(ValueError):
            fit_damped_trend([1.0])
        with self.assertRaises(ValueError):
            fit_damped_trend([1.0, float("nan")])
        with self.assertRaises(ValueError):
            fit_damped_trend([1.0, 2.0], phi_grid=(1.0,))  # > 0.95 cap


class ThetaDriftHandComputedTests(unittest.TestCase):
    """alpha fixed to 0.5 so the SES recursion is hand-verifiable.

    residual_returns = [0.1, 0.2, 0.3]
    t=0: no prior level -> l=0.1, c=1
    t=1: l = 0.5*0.2 + 0.5*0.1 = 0.15, c=2
    t=2: l = 0.5*0.3 + 0.5*0.15 = 0.225, c=3
    """

    def test_level_and_count_match_hand_computation(self):
        fit = fit_theta_drift([0.1, 0.2, 0.3], alpha_grid=(0.5,))
        self.assertEqual(fit.alpha, 0.5)
        self.assertAlmostEqual(fit.level[0], 0.1, places=9)
        self.assertAlmostEqual(fit.level[1], 0.15, places=9)
        self.assertAlmostEqual(fit.level[2], 0.225, places=9)
        self.assertEqual(list(fit.count), [1, 2, 3])

    def test_nan_steps_are_skipped_but_carry_the_level_forward(self):
        nan = float("nan")
        fit = fit_theta_drift([0.1, nan, 0.3], alpha_grid=(0.5,))
        self.assertAlmostEqual(fit.level[1], 0.1, places=9)  # carried forward, no update
        self.assertEqual(fit.count[1], 1)
        # t=2: l = 0.5*0.3 + 0.5*0.1 = 0.2
        self.assertAlmostEqual(fit.level[2], 0.2, places=9)
        self.assertEqual(fit.count[2], 2)

    def test_rejects_all_nan_or_empty(self):
        with self.assertRaises(ValueError):
            fit_theta_drift([], alpha_grid=(0.5,))
        with self.assertRaises(ValueError):
            fit_theta_drift([0.1], alpha_grid=())


class ShrinkageLimitTests(unittest.TestCase):
    def test_zero_observations_is_pure_prior(self):
        fit = ThetaDriftFit(alpha=0.3, level=array("d", [0.7]), count=array("i", [0]), n0=N0_DRIFT)
        shrunk, weight, n = shrunk_drift_at(fit, 0)
        self.assertEqual(weight, 0.0)
        self.assertEqual(shrunk, 0.0)
        self.assertEqual(n, 0)

    def test_many_observations_approaches_own_drift(self):
        fit = ThetaDriftFit(alpha=0.3, level=array("d", [0.42]), count=array("i", [1_000_000]), n0=N0_DRIFT)
        shrunk, weight, n = shrunk_drift_at(fit, 0)
        self.assertGreater(weight, 0.99999)
        self.assertAlmostEqual(shrunk, 0.42, places=4)

    def test_weight_formula_is_exactly_n_over_n_plus_n0(self):
        fit = ThetaDriftFit(alpha=0.3, level=array("d", [1.0]), count=array("i", [24]), n0=N0_DRIFT)
        _, weight, _ = shrunk_drift_at(fit, 0)
        self.assertAlmostEqual(weight, 24 / (24 + N0_DRIFT), places=9)

    def test_out_of_range_origin_rejected(self):
        fit = ThetaDriftFit(alpha=0.3, level=array("d", [1.0]), count=array("i", [1]), n0=N0_DRIFT)
        with self.assertRaises(ValueError):
            shrunk_drift_at(fit, 5)


class EmpiricalQuantileTests(unittest.TestCase):
    def test_recovers_a_known_uniform_distribution(self):
        n = 2001
        pool = sorted(-1.0 + 2.0 * i / (n - 1) for i in range(n))
        for q in REQUIRED_QUANTILES:
            expected = -1.0 + 2.0 * q
            self.assertAlmostEqual(empirical_quantile(pool, q), expected, places=9)

    def test_single_value_returns_itself(self):
        self.assertEqual(empirical_quantile([5.0], 0.5), 5.0)

    def test_rejects_empty(self):
        with self.assertRaises(ValueError):
            empirical_quantile([], 0.5)


class ConformalCoverageOnSyntheticResidualsTests(unittest.TestCase):
    """Split-conformal offsets fit on a calibration pool should give
    approximately nominal coverage on an independent held-out sample from
    the same distribution -- the core split-conformal guarantee, checked
    on deterministic synthetic data (no RNG needed)."""

    def test_offsets_give_approximately_nominal_coverage(self):
        n = 4001
        calibration = sorted(-1.0 + 2.0 * i / (n - 1) for i in range(n))
        offsets = {q: empirical_quantile(calibration, q) for q in REQUIRED_QUANTILES}

        m = 4000
        held_out = [-1.0 + 2.0 * (i + 0.5) / m for i in range(m)]
        for q in REQUIRED_QUANTILES:
            covered = sum(1 for v in held_out if v <= offsets[q]) / len(held_out)
            self.assertLess(abs(covered - q), 0.01, f"quantile {q} miscovered: {covered}")

    def test_calibration_never_moves_the_point_forecast(self):
        _low, _high, _fallback, _bucket_mad, offsets, _defaults, _sizes = (
            _calibrate_conformal(array("d", [1.0]), [(0, 4, 2.0), (0, 4, 3.0)])
        )
        calibrated = offsets[("low", 4)]
        self.assertEqual(calibrated[0.5], 0.0)
        self.assertLessEqual(calibrated[0.1], 0.0)
        self.assertGreaterEqual(calibrated[0.9], 0.0)


class OwnLevelReversionTests(unittest.TestCase):
    def setUp(self):
        category_id, group_id = 1, 10
        dates = tuple(date(2025, 1, 1) + timedelta(weeks=i) for i in range(4))
        zeros = array("d", [0.0]) * len(dates)
        self.category_id = category_id
        self.group_id = group_id
        self.index_set = IndexSet(
            dates=dates,
            category_ids=(category_id,),
            market=array("d", zeros),
            category={category_id: array("d", zeros)},
            group={(category_id, group_id): array("d", zeros)},
            group_first_index={(category_id, group_id): 0},
            row_counts={category_id: 4},
            variant_counts={category_id: 1},
        )

    def test_temporarily_elevated_price_has_negative_pull(self):
        signal = own_level_reversion_at(
            array("d", [100.0, 100.0, 100.0, 200.0]),
            self.index_set,
            self.category_id,
            self.group_id,
            3,
        )
        self.assertAlmostEqual(signal, -math.log(2.0), places=9)

    def test_signal_is_causal_at_the_requested_origin(self):
        prices = array("d", [100.0, 100.0, 100.0, 10_000.0])
        signal = own_level_reversion_at(
            prices, self.index_set, self.category_id, self.group_id, 2
        )
        self.assertEqual(signal, 0.0)


class TercileAndBucketTests(unittest.TestCase):
    def test_tercile_cutoffs_and_bucket_assignment(self):
        values = [float(i) for i in range(1, 10)]  # 1..9
        low_cut, high_cut = tercile_cutoffs(values)
        self.assertAlmostEqual(low_cut, empirical_quantile(sorted(values), 1 / 3), places=9)
        self.assertAlmostEqual(high_cut, empirical_quantile(sorted(values), 2 / 3), places=9)
        self.assertEqual(volatility_bucket(1.0, low_cut, high_cut), "low")
        self.assertEqual(volatility_bucket(9.0, low_cut, high_cut), "high")
        self.assertEqual(volatility_bucket(float("nan"), low_cut, high_cut), "unknown")

    def test_empty_input_returns_zero_cutoffs(self):
        self.assertEqual(tercile_cutoffs([]), (0.0, 0.0))


class MadVolatilityTests(unittest.TestCase):
    def test_matches_1_4826_times_median_absolute_deviation(self):
        values = array("d", [1.0, 2.0, 3.0, 4.0, 5.0])
        # median = 3.0, abs deviations = [2,1,0,1,2], median of those = 1.0
        self.assertAlmostEqual(mad_volatility(values), 1.4826, places=9)

    def test_nan_values_are_ignored(self):
        nan = float("nan")
        values = array("d", [nan, 1.0, 2.0, 3.0, 4.0, 5.0, nan])
        self.assertAlmostEqual(mad_volatility(values), 1.4826, places=9)

    def test_fewer_than_two_valid_values_is_nan(self):
        values = array("d", [float("nan"), 1.0])
        self.assertTrue(math.isnan(mad_volatility(values)))


class SelectWalkForwardOriginsTests(unittest.TestCase):
    def test_returns_empty_when_too_short(self):
        self.assertEqual(select_walk_forward_origins(10, horizon_steps=4, min_origin_index=15), ())

    def test_returns_bounded_ascending_unique_origins(self):
        origins = select_walk_forward_origins(80, horizon_steps=13, max_origins=5, min_origin_index=15)
        self.assertEqual(list(origins), sorted(set(origins)))
        self.assertLessEqual(len(origins), 5)
        self.assertTrue(all(15 <= o <= 80 - 1 - 13 for o in origins))

    def test_single_valid_origin_when_span_is_zero(self):
        origins = select_walk_forward_origins(17, horizon_steps=1, min_origin_index=15)
        self.assertEqual(origins, (15,))


def _write_panel_file(panel_dir: Path, category_id: int, day: date, rows: list[dict]) -> None:
    category_dir = panel_dir / f"category-{category_id}"
    category_dir.mkdir(parents=True, exist_ok=True)
    with gzip.open(category_dir / f"{day.isoformat()}.jsonl.gz", "wt", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row) + "\n")


def _build_synthetic_panel(panel_dir: Path, category_id: int, *, n_dates: int = 20, seed: int = 42):
    start = date(2025, 1, 5)
    dates = [start + timedelta(weeks=i) for i in range(n_dates)]
    groups = {101: "2024-11-01", 102: "2025-01-01"}
    rng = random.Random(seed)
    variants = []
    for gid in groups:
        for pid in range(gid * 10, gid * 10 + 5):
            base = rng.uniform(5, 50)
            drift = rng.uniform(-0.01, 0.02)
            variants.append((gid, pid, base, drift))

    for t, day in enumerate(dates):
        rows = []
        for gid, pid, base, drift in variants:
            if rng.random() < 0.05:
                continue
            noise = rng.uniform(-0.03, 0.03)
            price = round(base * math.exp(drift * t + noise), 2)
            rows.append({"groupId": gid, "productId": pid, "subTypeName": "Normal", "price": price})
        rows.sort(key=lambda r: (r["productId"], r["subTypeName"]))
        _write_panel_file(panel_dir, category_id, day, rows)

    groups_metadata = {
        (category_id, gid): {"category_id": category_id, "group_id": gid, "published_on": published}
        for gid, published in groups.items()
    }
    return dates, groups_metadata


class VariantResidualReturnsTests(unittest.TestCase):
    def test_zero_when_index_perfectly_explains_the_price(self):
        with tempfile.TemporaryDirectory() as tmp:
            panel_dir = Path(tmp)
            category_id = 5000
            dates, groups_metadata = _build_synthetic_panel(panel_dir, category_id, n_dates=6)
            index_set = build_indices(panel_dir, [category_id])
            # A variant whose price *is* exp(combined_level) exactly should
            # have all-zero residual returns.
            n = len(index_set.dates)
            prices = array("d", [math.nan] * n)
            for t in range(n):
                prices[t] = math.exp(index_set.combined_level(category_id, 101, t))
            residual = variant_residual_returns(prices, index_set, category_id, 101)
            for v in residual:
                if not math.isnan(v):
                    self.assertAlmostEqual(v, 0.0, places=9)


class ProcessCategoryIntegrationTests(unittest.TestCase):
    """End-to-end: synthetic panel -> indices -> lifecycle curve -> packets."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.panel_dir = Path(self.tmp.name) / "panel"
        self.category_id = 999
        self.dates, self.groups_metadata = _build_synthetic_panel(self.panel_dir, self.category_id)
        self.index_set = build_indices(self.panel_dir, [self.category_id])
        self.curve = build_lifecycle_curve(self.index_set, self.groups_metadata)
        self.out_dir = Path(self.tmp.name) / "out"

    def _run(self):
        return process_category(
            self.panel_dir, self.category_id, self.index_set, self.curve,
            self.groups_metadata, self.out_dir,
        )

    def test_emits_one_packet_row_per_variant_with_history(self):
        result = self._run()
        self.assertEqual(result.packet_row_count, result.variant_count - result.rejects["no_history"])
        self.assertGreater(result.packet_row_count, 0)

    def test_deterministic_same_input_same_hash(self):
        result1 = self._run()
        result2 = self._run()
        self.assertEqual(result1.content_hash, result2.content_hash)

        # And re-derive the hash independently by rereading the emitted file
        # and hashing its canonical-JSON lines the same way -- catches any
        # accidental dependence on gzip container bytes (e.g. embedded mtime).
        with gzip.open(result1.output_path, "rt", encoding="utf-8") as handle:
            text = handle.read()
        from hashlib import sha256
        self.assertEqual(sha256(text.encode("utf-8")).hexdigest(), result1.content_hash)

    def test_all_emitted_quantiles_are_noncrossing(self):
        result = self._run()
        with gzip.open(result.output_path, "rt", encoding="utf-8") as handle:
            for line in handle:
                row = json.loads(line)
                for horizon in row["horizons"].values():
                    ordered = [horizon[f"q{int(round(p * 100)):02d}"] for p in REQUIRED_QUANTILES]
                    self.assertEqual(ordered, sorted(ordered))

    def test_median_path_contains_only_independent_forecast_checkpoints(self):
        result = self._run()
        with gzip.open(result.output_path, "rt", encoding="utf-8") as handle:
            for line in handle:
                row = json.loads(line)
                path = row["medianPath"]
                self.assertEqual(len(path), 4)
                self.assertEqual(path[0]["date"], row["lastKnownDate"])
                self.assertAlmostEqual(path[0]["price"], row["lastKnownPrice"], places=4)
                origin = date.fromisoformat(path[0]["date"])
                for index, (horizon, actual_days) in enumerate(((30, 28), (60, 63), (90, 91)), start=1):
                    band = row["horizons"][str(horizon)]
                    self.assertEqual(band["horizonDaysActual"], actual_days)
                    self.assertEqual(path[index]["date"], (origin + timedelta(days=actual_days)).isoformat())
                    self.assertAlmostEqual(path[index]["price"], band["q50"], places=4)

    def test_content_sha256_helper_is_order_independent(self):
        a = content_sha256({"b": 1, "a": 2})
        b = content_sha256({"a": 2, "b": 1})
        self.assertEqual(a, b)


class ZeroVolatilityLowBucketCalibrationTests(unittest.TestCase):
    """Regression test: >=1/3 of variants with an exactly-constant price
    series (own_mad == 0.0, a real pattern for stale/rarely-traded card
    listings) must not leave the "low" volatility bucket's split-conformal
    calibration pool permanently empty. Before the VOLATILITY_FLOOR-skip fix,
    those variants were excluded from walk-forward pool collection entirely
    while still being *labeled* "low" at packet-emission time (because the
    tercile cutoff itself collapses to 0.0 once enough variants sit at
    exactly zero) -- guaranteeing zero low:* pool entries for every horizon.
    """

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.panel_dir = Path(self.tmp.name) / "panel"
        self.category_id = 7000
        self.noisy_group = 700
        self.flat_group = 701
        self.n_dates = 30
        start = date(2025, 1, 5)
        self.dates = [start + timedelta(weeks=i) for i in range(self.n_dates)]

        rng = random.Random(1234)
        # combined_level's weekly delta telescopes down to exactly a
        # variant's *own group's* aggregate trimmed-mean return (market and
        # category excess terms cancel), so a variant's residual return is
        # zero every week -- and own_mad is exactly 0.0 -- only when its
        # whole group is flat, not merely the one variant. 6 variants in
        # their own always-flat group (own_mad == 0.0) + 6 variants in a
        # separate genuinely-noisy group: >= 1/3 of the 12 total sit at
        # exactly 0.0, enough to pull the low tercile cutoff down to 0.0
        # too -- reproducing the real category-85 pattern exactly.
        noisy = [(self.noisy_group, 1000 + i, 10.0 + i, rng.uniform(-0.01, 0.02)) for i in range(6)]
        flat = [(self.flat_group, 2000 + i, 20.0 + i, 0.0) for i in range(6)]
        self.variants = noisy + flat

        for t, day in enumerate(self.dates):
            rows = []
            for group_id, product_id, base, drift in self.variants:
                if drift == 0.0:
                    price = base
                else:
                    noise = rng.uniform(-0.02, 0.02)
                    price = round(base * math.exp(drift * t + noise), 4)
                rows.append(
                    {"groupId": group_id, "productId": product_id, "subTypeName": "Normal", "price": price}
                )
            _write_panel_file(self.panel_dir, self.category_id, day, rows)

        self.groups_metadata = {
            (self.category_id, self.noisy_group): {
                "category_id": self.category_id,
                "group_id": self.noisy_group,
                "published_on": "2024-11-01",
            },
            (self.category_id, self.flat_group): {
                "category_id": self.category_id,
                "group_id": self.flat_group,
                "published_on": "2024-11-01",
            },
        }
        self.index_set = build_indices(self.panel_dir, [self.category_id])
        self.curve = build_lifecycle_curve(self.index_set, self.groups_metadata)
        self.out_dir = Path(self.tmp.name) / "out"

    def test_flat_price_variants_populate_the_low_bucket_pool(self):
        result = process_category(
            self.panel_dir, self.category_id, self.index_set, self.curve,
            self.groups_metadata, self.out_dir,
        )
        low_keys = [k for k in result.pool_sizes if k.startswith("low:")]
        self.assertTrue(low_keys, f"expected a populated low:* pool, got {result.pool_sizes}")
        for key in low_keys:
            self.assertGreater(result.pool_sizes[key], 0)

        # And every emitted row -- including the flat-price/"low"-bucket
        # ones -- still gets a finite, noncrossing quantile band.
        with gzip.open(result.output_path, "rt", encoding="utf-8") as handle:
            saw_low_bucket_row = False
            for line in handle:
                row = json.loads(line)
                if row["volatilityBucket"] == "low":
                    saw_low_bucket_row = True
                for horizon in row["horizons"].values():
                    ordered = [horizon[f"q{int(round(p * 100)):02d}"] for p in REQUIRED_QUANTILES]
                    self.assertEqual(ordered, sorted(ordered))
                    self.assertTrue(all(math.isfinite(v) for v in ordered))
            self.assertTrue(saw_low_bucket_row)


if __name__ == "__main__":
    unittest.main()


class HedonicColdStartPacketEmissionTests(unittest.TestCase):
    """T3: cold-start packets for products that never appear in the panel
    at all (see process_category's `cold_start_variants` docstring -- `li
    < 0` is otherwise structurally unreachable through `variant_index`).
    """

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.panel_dir = Path(self.tmp.name) / "panel"
        self.category_id = 8100
        self.dates, self.groups_metadata = _build_synthetic_panel(self.panel_dir, self.category_id)
        self.index_set = build_indices(self.panel_dir, [self.category_id])
        self.curve = build_lifecycle_curve(self.index_set, self.groups_metadata)
        self.out_dir = Path(self.tmp.name) / "out"
        # A product id disjoint from _build_synthetic_panel's own id space
        # (gid*10..gid*10+5 for gid in {101, 102}), belonging to an
        # existing group so group-level components (published_on etc.)
        # resolve normally.
        self.cold_key = (999001, "Normal")
        self.cold_start_variants = {self.cold_key: 101}
        self.hedonic_log_price = {self.cold_key: math.log(12.5)}

    def _run(self, **kwargs):
        return process_category(
            self.panel_dir, self.category_id, self.index_set, self.curve,
            self.groups_metadata, self.out_dir, **kwargs,
        )

    def _rows(self, result):
        with gzip.open(result.output_path, "rt", encoding="utf-8") as handle:
            return [json.loads(line) for line in handle]

    def test_without_cold_start_inputs_the_never_priced_key_is_absent(self):
        result = self._run()
        rows = self._rows(result)
        keys = {(r["productId"], r["subTypeName"]) for r in rows}
        self.assertNotIn(self.cold_key, keys)
        self.assertEqual(result.rejects["no_history"], 0)

    def test_cold_start_variants_without_hedonic_price_is_still_skipped(self):
        # Supplying the candidate mapping alone (no hedonic prediction)
        # must not emit a packet -- graceful degradation, not a crash.
        result = self._run(cold_start_variants=self.cold_start_variants)
        rows = self._rows(result)
        keys = {(r["productId"], r["subTypeName"]) for r in rows}
        self.assertNotIn(self.cold_key, keys)
        self.assertEqual(result.rejects["no_history"], 1)

    def test_cold_start_packet_is_emitted_with_expected_shape(self):
        result = self._run(
            cold_start_variants=self.cold_start_variants,
            hedonic_log_price=self.hedonic_log_price,
        )
        rows = self._rows(result)
        cold_rows = [r for r in rows if (r["productId"], r["subTypeName"]) == self.cold_key]
        self.assertEqual(len(cold_rows), 1)
        row = cold_rows[0]
        self.assertEqual(row["confidence"], "cold-start")
        self.assertEqual(row["sampleSize"], 0)
        self.assertIsNone(row["lastKnownDate"])
        self.assertIsNone(row["lastKnownPrice"])
        self.assertEqual(row["groupId"], 101)
        self.assertEqual(result.rejects["no_history"], 0)
        self.assertEqual(result.variant_count, result.packet_row_count)

        # Anchor is the hedonic prediction: at horizon 0-ish (shortest
        # available horizon) the median path's first point should sit
        # close to exp(hedonic_log_price), before any index drift compounds.
        first_point_price = row["medianPath"][0]["price"]
        self.assertAlmostEqual(first_point_price, math.exp(self.hedonic_log_price[self.cold_key]), places=4)

    def test_cold_start_quantiles_are_noncrossing_and_finite(self):
        result = self._run(
            cold_start_variants=self.cold_start_variants,
            hedonic_log_price=self.hedonic_log_price,
        )
        rows = self._rows(result)
        row = next(r for r in rows if (r["productId"], r["subTypeName"]) == self.cold_key)
        for horizon in row["horizons"].values():
            ordered = [horizon[f"q{int(round(p * 100)):02d}"] for p in REQUIRED_QUANTILES]
            self.assertEqual(ordered, sorted(ordered))
            self.assertTrue(all(math.isfinite(v) and v > 0 for v in ordered))

    def test_cold_start_bands_are_wider_than_a_comparable_standard_packet(self):
        # A cold-start packet's band (q90/q10 ratio at a shared horizon)
        # must be wider than an ordinary packet in the same category,
        # reflecting COLD_START_BAND_WIDEN_FACTOR.
        result = self._run(
            cold_start_variants=self.cold_start_variants,
            hedonic_log_price=self.hedonic_log_price,
        )
        rows = self._rows(result)
        cold_row = next(r for r in rows if (r["productId"], r["subTypeName"]) == self.cold_key)
        standard_row = next(r for r in rows if r["confidence"] != "cold-start")
        horizon_key = sorted(cold_row["horizons"], key=int)[0]
        cold_ratio = cold_row["horizons"][horizon_key]["q90"] / cold_row["horizons"][horizon_key]["q10"]
        standard_ratio = (
            standard_row["horizons"][horizon_key]["q90"] / standard_row["horizons"][horizon_key]["q10"]
        )
        self.assertGreater(cold_ratio, standard_ratio)


class HedonicHighNInvarianceTests(unittest.TestCase):
    """T3: a variant with a rich own price history must not change
    materially when a hedonic prediction is also supplied -- at high `n`,
    hedonic_level_weight(n) -> 1, so the blended anchor collapses back to
    the variant's own observed price (within floating point noise).
    """

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.panel_dir = Path(self.tmp.name) / "panel"
        self.category_id = 8200
        # Long, densely-observed history (~2 years weekly) so every
        # variant's final_n is comfortably >> N0_HEDONIC (8.0).
        self.dates, self.groups_metadata = _build_synthetic_panel(self.panel_dir, self.category_id, n_dates=104)
        self.index_set = build_indices(self.panel_dir, [self.category_id])
        self.curve = build_lifecycle_curve(self.index_set, self.groups_metadata)

    def _rows(self, out_dir, **kwargs):
        result = process_category(
            self.panel_dir, self.category_id, self.index_set, self.curve,
            self.groups_metadata, out_dir, **kwargs,
        )
        with gzip.open(result.output_path, "rt", encoding="utf-8") as handle:
            return {
                (row["productId"], row["subTypeName"]): row for row in (json.loads(line) for line in handle)
            }

    def test_high_n_packets_change_by_at_most_epsilon(self):
        baseline = self._rows(Path(self.tmp.name) / "out-baseline")

        # A modest but genuinely-wrong hedonic prior (~5% off in price
        # space -- a plausible hedonic-model residual, unlike an
        # implausibly huge offset) must barely move a high-n variant's
        # packet, because hedonic_level_weight(n) is close to 1 at this n:
        # blended_log - own_log = (1 - weight) * PRIOR_LOG_OFFSET, and
        # (1 - weight) = N0_HEDONIC / (n + N0_HEDONIC) is small whenever n
        # is comfortably above N0_HEDONIC (8.0).
        PRIOR_LOG_OFFSET = 0.05
        hedonic_log_price = {
            key: math.log(row["lastKnownPrice"]) + PRIOR_LOG_OFFSET
            for key, row in baseline.items()
            if row["lastKnownPrice"] is not None
        }
        blended = self._rows(Path(self.tmp.name) / "out-blended", hedonic_log_price=hedonic_log_price)

        self.assertEqual(set(baseline), set(blended))
        checked = 0
        for key, base_row in baseline.items():
            if base_row["sampleSize"] < 50:
                continue  # only the "high-n" subset is under test here
            blend_row = blended[key]
            self.assertEqual(blend_row["confidence"], base_row["confidence"])
            for horizon_key, base_horizon in base_row["horizons"].items():
                blend_horizon = blend_row["horizons"][horizon_key]
                for q_key, base_value in base_horizon.items():
                    rel_diff = abs(blend_horizon[q_key] - base_value) / max(abs(base_value), 1e-9)
                    self.assertLess(rel_diff, 0.01, msg=f"{key} {horizon_key} {q_key} moved too much")
            checked += 1
        self.assertGreater(checked, 0)

    def test_no_hedonic_input_is_byte_identical_to_pre_t3_defaults(self):
        # Calling with every T3 parameter at its default must reproduce
        # exactly the same content hash as calling with no T3 parameters
        # supplied at all -- the omission itself is the backward
        # compatibility contract (see process_category's docstring).
        result_implicit = process_category(
            self.panel_dir, self.category_id, self.index_set, self.curve,
            self.groups_metadata, Path(self.tmp.name) / "out-implicit",
        )
        result_explicit = process_category(
            self.panel_dir, self.category_id, self.index_set, self.curve,
            self.groups_metadata, Path(self.tmp.name) / "out-explicit",
            hedonic_log_price=None, cold_start_variants=None,
        )
        self.assertEqual(result_implicit.content_hash, result_explicit.content_hash)


_STATE_DIR = Path(__file__).resolve().parents[2] / "analytics" / "data" / "trajectory"


@unittest.skipUnless(
    (Path(__file__).resolve().parents[2] / "analytics" / "data" / "panel" / "category-85").is_dir()
    and (_STATE_DIR / "indices.json.gz").is_file()
    and (_STATE_DIR / "lifecycle_curve.json.gz").is_file()
    and (_STATE_DIR / "groups_metadata.json.gz").is_file(),
    "real category-85 panel + build-indices state cache not present on disk",
)
class RealCategory85TrajectoryV11RegressionTests(unittest.TestCase):
    """Pins trajectory-v1.1 output for the locally cached category-85 panel.

    Deliberately loads the *cached* shared-state files
    (indices.json.gz/lifecycle_curve.json.gz/groups_metadata.json.gz --
    exactly what `run-category` itself reads via
    `trajectory_cli._load_shared_inputs`) rather than recomputing
    build_indices/build_lifecycle_curve fresh: recomputation is not
    guaranteed byte-identical to whatever categories/trim-fraction the
    original `build-indices` invocation actually used (e.g. a narrower
    category scope), whereas the cached state is exactly what produced
    the committed T2 receipt. Network-free; skipped automatically
    wherever that local cache is absent (e.g. a fresh checkout without
    analytics/data populated).

    T4 note: the pinned hash below was updated from the original T2 value
    (``8c4a0acdf99f50a3f74f8f1b442915c382bfaae4483ecafca104362b9ccf7355``)
    because T4's staleness-based confidence degradation (PRD Sec4 hard
    criterion 3a, ``confidence_tier``/``STALE_WEEKS_THRESHOLD`` in
    trajectory.py) intentionally changes the ``confidence`` field of any
    real category-85 variant whose last-known price is more than 8 weeks
    old from "standard" to "low-history" -- an engine behavior change, not
    a regression. Prices/bands are unaffected by this change (it only
    downgrades a tier), so this is still a meaningful reproducibility pin
    on prices+bands going forward, just anchored to the post-T4 baseline.
    """

    COMMITTED_V11_HASH = "d97bc0f0bd8e48cc5a421ae8f655716cb71541b2ae8829dcc1a404bef8aeae90"

    def test_reproduces_trajectory_v11_content_hash(self):
        from collectfolio_analytics.trajectory_cli import _load_shared_inputs

        repo_root = Path(__file__).resolve().parents[2]
        panel_dir = repo_root / "analytics" / "data" / "panel"
        category_id = 85

        index_set, curve, groups_metadata = _load_shared_inputs(_STATE_DIR)

        with tempfile.TemporaryDirectory() as tmp:
            # as_of intentionally omitted: process_category's own default
            # (dates[-1] + 1 day, UTC midnight) is what the committed T2
            # receipt was generated with; passing anything else here would
            # change every row's "asOf" field and therefore the hash.
            result = process_category(
                panel_dir, category_id, index_set, curve, groups_metadata, Path(tmp) / "out",
            )
        self.assertEqual(result.content_hash, self.COMMITTED_V11_HASH)


class ConfidenceTierTests(unittest.TestCase):
    """T4 (PRD Sec4 hard criterion 3a): staleness-based confidence degradation."""

    def test_insufficient_history_wins_regardless_of_staleness(self):
        self.assertEqual(
            confidence_tier(n_i=0, mad_i=float("nan"), weeks_stale=0.0),
            "insufficient-history",
        )
        self.assertEqual(
            confidence_tier(n_i=0, mad_i=float("nan"), weeks_stale=100.0),
            "insufficient-history",
        )

    def test_low_history_below_min_sample_size(self):
        self.assertEqual(
            confidence_tier(n_i=MIN_HISTORY_FOR_STANDARD - 1, mad_i=0.01, weeks_stale=0.0),
            "low-history",
        )

    def test_standard_when_well_sampled_and_fresh(self):
        self.assertEqual(
            confidence_tier(n_i=MIN_HISTORY_FOR_STANDARD, mad_i=0.01, weeks_stale=0.0),
            "standard",
        )
        self.assertEqual(
            confidence_tier(
                n_i=MIN_HISTORY_FOR_STANDARD, mad_i=0.01, weeks_stale=STALE_WEEKS_THRESHOLD,
            ),
            "standard",
        )

    def test_staleness_degrades_standard_to_low_history(self):
        self.assertEqual(
            confidence_tier(
                n_i=100, mad_i=0.01, weeks_stale=STALE_WEEKS_THRESHOLD + 0.01,
            ),
            "low-history",
        )

    def test_staleness_never_upgrades_low_history(self):
        # Already low-history on sample size alone -- staleness must not
        # change the outcome (there's nothing worse than low-history for a
        # non-cold-start variant except insufficient-history, which is
        # governed purely by mad_i, not staleness).
        self.assertEqual(
            confidence_tier(n_i=1, mad_i=0.01, weeks_stale=0.0),
            confidence_tier(n_i=1, mad_i=0.01, weeks_stale=1000.0),
        )

    def test_none_weeks_stale_is_treated_as_not_stale(self):
        self.assertEqual(
            confidence_tier(n_i=100, mad_i=0.01, weeks_stale=None),
            "standard",
        )


class HedonicBlendAnchorCapTests(unittest.TestCase):
    """T4 (PRD Sec4 hard criterion 3c): cap the hedonic level-blend shift."""

    def test_unclamped_shift_within_cap_is_unaffected(self):
        own_log = math.log(100.0)
        hedonic_pred = math.log(120.0)
        n_i = 4
        anchor = hedonic_blend_anchor_log(own_log, hedonic_pred, n_i)
        weight = n_i / (n_i + 8.0)  # N0_HEDONIC
        expected = weight * own_log + (1.0 - weight) * hedonic_pred
        self.assertAlmostEqual(anchor, expected, places=9)

    def test_extreme_low_n_shift_is_clamped_to_max_abs_shift(self):
        # The sampled T3 packet: own last-known price $81,421, hedonic
        # prediction implying a blended anchor around $111 unclamped.
        own_log = math.log(81421.0)
        hedonic_pred = math.log(100.0)
        anchor = hedonic_blend_anchor_log(own_log, hedonic_pred, n_i=0)
        self.assertAlmostEqual(anchor, own_log - MAX_HEDONIC_BLEND_LOG_SHIFT, places=9)
        # 3x below the own price, per the ln(3) cap -- not a ~660x swing.
        self.assertAlmostEqual(math.exp(anchor), 81421.0 / 3.0, places=3)

    def test_clamp_is_symmetric(self):
        own_log = math.log(100.0)
        hedonic_pred = math.log(100_000.0)
        anchor = hedonic_blend_anchor_log(own_log, hedonic_pred, n_i=0)
        self.assertAlmostEqual(anchor, own_log + MAX_HEDONIC_BLEND_LOG_SHIFT, places=9)

    def test_high_n_shift_is_far_inside_the_cap(self):
        # HighNInvarianceTests companion: at high n the unclamped shift is
        # already tiny, so the cap changes nothing (within float noise).
        own_log = math.log(100.0)
        hedonic_pred = math.log(50.0)
        anchor = hedonic_blend_anchor_log(own_log, hedonic_pred, n_i=100_000)
        self.assertAlmostEqual(anchor, own_log, places=3)

    def test_anchor_is_exactly_own_log_at_and_above_the_standard_threshold(self):
        # T4 incident fix (2026-08): once a variant has enough own history
        # to be "standard" confidence, the blend must not move the anchor
        # at all -- not "far inside the cap", exactly equal -- regardless
        # of how extreme the hedonic prediction is.
        own_log = math.log(100.0)
        extreme_hedonic_pred = math.log(100_000.0)
        for n_i in (MIN_HISTORY_FOR_STANDARD, MIN_HISTORY_FOR_STANDARD + 1, 50, 100_000):
            anchor = hedonic_blend_anchor_log(own_log, extreme_hedonic_pred, n_i)
            self.assertEqual(anchor, own_log, f"n_i={n_i} must anchor purely on own_log")

    def test_below_threshold_still_uses_the_old_weighted_and_clamped_blend(self):
        # The early return must not swallow the below-threshold path: it
        # keeps the exact same empirical-Bayes weight and ln(3) clamp as
        # before, one step below the standard cutoff.
        own_log = math.log(100.0)
        hedonic_pred = math.log(120.0)
        n_i = MIN_HISTORY_FOR_STANDARD - 1
        anchor = hedonic_blend_anchor_log(own_log, hedonic_pred, n_i)
        weight = n_i / (n_i + 8.0)  # N0_HEDONIC
        expected = weight * own_log + (1.0 - weight) * hedonic_pred
        self.assertAlmostEqual(anchor, expected, places=9)

        own_log_extreme = math.log(81421.0)
        hedonic_pred_extreme = math.log(100.0)
        anchor_extreme = hedonic_blend_anchor_log(own_log_extreme, hedonic_pred_extreme, n_i=0)
        self.assertAlmostEqual(anchor_extreme, own_log_extreme - MAX_HEDONIC_BLEND_LOG_SHIFT, places=9)

    def test_incident_shape_no_longer_saturates_the_clamp_at_standard_confidence(self):
        # Live incident fixture (2026-08, cat2 product 695695, "1st
        # Edition"): own last-known price $1,196.63, hedonic prediction
        # ~$30, n_i=10 -- one above MIN_HISTORY_FOR_STANDARD=8, so this
        # card is "standard" confidence yet only has 11 weekly
        # observations. Pre-fix, weight = 10/18 (44% hedonic contribution)
        # drove a raw shift far past the ln(3) clamp bound, serving a
        # medianPath that opened at exactly own_price/3 -- a 3x instant
        # drop presented as "standard" confidence. Post-fix, standard
        # confidence anchors purely on the card's own last-known price.
        own_price = 1196.63
        hedonic_pred_price = 30.0
        own_log = math.log(own_price)
        hedonic_pred = math.log(hedonic_pred_price)
        n_i = 10
        self.assertGreaterEqual(n_i, MIN_HISTORY_FOR_STANDARD)

        anchor = hedonic_blend_anchor_log(own_log, hedonic_pred, n_i)
        self.assertEqual(anchor, own_log)
        self.assertAlmostEqual(math.exp(anchor), own_price, places=6)

        # Sanity check against the pre-fix regression: the old unclamped
        # weighted blend really did saturate the ln(3) bound for this
        # shape, confirming the fixture reproduces the incident.
        weight = n_i / (n_i + 8.0)  # N0_HEDONIC
        raw_shift = (1.0 - weight) * (hedonic_pred - own_log)
        self.assertLess(raw_shift, -MAX_HEDONIC_BLEND_LOG_SHIFT)


class ComponentWeightsApplicationTests(unittest.TestCase):
    """T4 remediation: process_category's component_weights parameter."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.panel_dir = Path(self.tmp.name) / "panel"
        self.category_id = 4242
        self.dates, self.groups_metadata = _build_synthetic_panel(self.panel_dir, self.category_id)
        self.index_set = build_indices(self.panel_dir, [self.category_id])
        self.curve = build_lifecycle_curve(self.index_set, self.groups_metadata)
        self.out_dir = Path(self.tmp.name) / "out"
        self._run_count = 0

    def _run(self, **kwargs):
        # Each call gets its own output subdirectory: process_category
        # writes to a fixed <out_dir>/category-<id>/packets.jsonl.gz path,
        # so two calls sharing one out_dir would have the second silently
        # overwrite the first's file on disk before a test gets a chance
        # to read both.
        self._run_count += 1
        return process_category(
            self.panel_dir, self.category_id, self.index_set, self.curve,
            self.groups_metadata, self.out_dir / f"run-{self._run_count}", **kwargs,
        )

    def test_none_is_byte_identical_to_pre_remediation_default(self):
        # component_weights=None means the trajectory-v1.1 identity
        # coefficients (common=1, reversion=0, drift=1).
        baseline = self._run()
        explicit_identity = self._run(component_weights={
            4: (1.0, 0.0, 1.0),
            9: (1.0, 0.0, 1.0),
            13: (1.0, 0.0, 1.0),
        })
        self.assertEqual(baseline.content_hash, explicit_identity.content_hash)

    def test_zero_weights_change_the_output_hash(self):
        baseline = self._run()
        zeroed = self._run(component_weights={
            4: (0.0, 0.0, 0.0),
            9: (0.0, 0.0, 0.0),
            13: (0.0, 0.0, 0.0),
        })
        self.assertNotEqual(baseline.content_hash, zeroed.content_hash)

    def test_zero_weights_flatten_median_path_to_the_anchor_price(self):
        # With a=c=b=0 at every modeled checkpoint, every median point must
        # equal lastKnownPrice exactly
        # (medianPath carries no conformal offset, unlike the quantiles).
        zeroed = self._run(component_weights={
            4: (0.0, 0.0, 0.0),
            9: (0.0, 0.0, 0.0),
            13: (0.0, 0.0, 0.0),
        })
        with gzip.open(zeroed.output_path, "rt", encoding="utf-8") as handle:
            rows = [json.loads(line) for line in handle]
        self.assertTrue(rows)
        for row in rows:
            for point in row["medianPath"]:
                self.assertAlmostEqual(point["price"], row["lastKnownPrice"], places=5)

    def test_full_weights_move_the_path_away_from_the_anchor(self):
        # Sanity companion: the default (1, 1) run's medianPath actually
        # moves over the horizon on this synthetic panel (drift/index are
        # non-trivial), so the zeroed test above is a meaningful contrast,
        # not vacuously true because nothing ever moves.
        full = self._run()
        with gzip.open(full.output_path, "rt", encoding="utf-8") as handle:
            rows = [json.loads(line) for line in handle]
        self.assertTrue(any(
            abs(point["price"] - row["lastKnownPrice"]) > 1e-6
            for row in rows for point in row["medianPath"][1:]
        ))

    def test_missing_horizon_key_defaults_to_identity_for_that_horizon(self):
        # A weights map that only covers one horizon must not KeyError or
        # silently zero out the others; omitted horizons keep identity.
        baseline = self._run()
        partial = self._run(component_weights={4: (1.0, 1.0)})
        self.assertEqual(baseline.content_hash, partial.content_hash)
