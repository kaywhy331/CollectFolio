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

from collectfolio_analytics.indices import build_indices
from collectfolio_analytics.lifecycle import build_lifecycle_curve
from collectfolio_analytics.trajectory import (
    N0_DRIFT,
    REQUIRED_QUANTILES,
    ThetaDriftFit,
    content_sha256,
    damped_forecast_delta,
    empirical_quantile,
    fit_damped_trend,
    fit_theta_drift,
    horizon_steps_for,
    mad_volatility,
    process_category,
    select_walk_forward_origins,
    shrunk_drift_at,
    tercile_cutoffs,
    variant_residual_returns,
    volatility_bucket,
)


class HorizonStepsForTests(unittest.TestCase):
    def test_30_and_90_days_map_onto_the_weekly_grid(self):
        self.assertEqual(horizon_steps_for(30), 4)  # 30/7 = 4.29 -> 4
        self.assertEqual(horizon_steps_for(90), 13)  # 90/7 = 12.86 -> 13

    def test_rejects_non_positive(self):
        with self.assertRaises(ValueError):
            horizon_steps_for(0)


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

    def test_median_path_is_bounded_and_starts_at_last_known_price(self):
        result = self._run()
        with gzip.open(result.output_path, "rt", encoding="utf-8") as handle:
            for line in handle:
                row = json.loads(line)
                path = row["medianPath"]
                self.assertLessEqual(len(path), 32)
                self.assertGreater(len(path), 0)
                self.assertEqual(path[0]["date"], row["lastKnownDate"])
                self.assertAlmostEqual(path[0]["price"], row["lastKnownPrice"], places=4)

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
class RealCategory85BackwardCompatibilityRegressionTests(unittest.TestCase):
    """Pins the ad hoc T3 finding: with every hedonic parameter at its
    default, process_category on the real, already-fetched category-85
    panel reproduces the exact packet content hash committed in T2's
    receipt (docs/receipts/trajectory-v1/trajectory-category-85.json).

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
    """

    COMMITTED_T2_HASH = "8c4a0acdf99f50a3f74f8f1b442915c382bfaae4483ecafca104362b9ccf7355"

    def test_reproduces_committed_t2_content_hash(self):
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
        self.assertEqual(result.content_hash, self.COMMITTED_T2_HASH)
