import math
import unittest

from collectfolio_analytics.hedonic import (
    COLD_START_BAND_WIDEN_FACTOR,
    DesignMatrixSpec,
    FeatureRow,
    HedonicError,
    N0_HEDONIC,
    build_design_matrix,
    cross_validate_holdout_sets,
    fit_design_matrix_spec,
    fit_hedonic_category,
    fit_video_model_v0_ablation,
    fold_for_group,
    hedonic_level_weight,
    solve_ols_ridge,
    structural_scarcity_proxy,
)


def _row(group_id, **kwargs):
    categorical = {k: v for k, v in kwargs.items() if isinstance(v, str)}
    continuous = {k: float(v) for k, v in kwargs.items() if not isinstance(v, str)}
    return FeatureRow(group_id=group_id, categorical=categorical, continuous=continuous)


class FoldForGroupTests(unittest.TestCase):
    def test_deterministic_across_calls(self):
        self.assertEqual(fold_for_group(100, 5), fold_for_group(100, 5))

    def test_distributes_across_folds(self):
        # Not a proof of uniformity, just that it isn't degenerate: many
        # distinct group ids should not all collapse onto one fold.
        seen = {fold_for_group(gid, 5) for gid in range(200)}
        self.assertGreater(len(seen), 1)

    def test_rejects_too_few_folds(self):
        with self.assertRaises(HedonicError):
            fold_for_group(1, 1)


class HedonicLevelWeightTests(unittest.TestCase):
    def test_zero_at_n_zero(self):
        self.assertEqual(hedonic_level_weight(0), 0.0)
        self.assertEqual(hedonic_level_weight(-5), 0.0)

    def test_matches_empirical_bayes_formula(self):
        n = 20
        self.assertAlmostEqual(hedonic_level_weight(n), n / (n + N0_HEDONIC), places=9)

    def test_approaches_one_at_high_n(self):
        self.assertGreater(hedonic_level_weight(100_000), 0.999)

    def test_clamped_to_unit_interval(self):
        self.assertLessEqual(hedonic_level_weight(10 ** 9), 1.0)


class StructuralScarcityProxyTests(unittest.TestCase):
    def test_monotonic_scarcer_is_larger(self):
        self.assertGreater(structural_scarcity_proxy(1), structural_scarcity_proxy(10))

    def test_floors_at_count_one(self):
        # count <= 0 must not raise (log(0) / log(negative))
        self.assertEqual(structural_scarcity_proxy(0), structural_scarcity_proxy(1))
        self.assertEqual(structural_scarcity_proxy(-3), structural_scarcity_proxy(1))


class DesignMatrixTests(unittest.TestCase):
    def test_intercept_plus_onehot_plus_continuous_column_count(self):
        rows = [
            _row(1, setFamily="main", releaseAgeWeeks=10.0),
            _row(1, setFamily="commander", releaseAgeWeeks=20.0),
            _row(2, setFamily="main", releaseAgeWeeks=5.0),
        ]
        spec = fit_design_matrix_spec(rows, top_k=20)
        self.assertEqual(spec.column_names[0], "intercept")
        self.assertIn("setFamily=main", spec.column_names)
        self.assertIn("releaseAgeWeeks", spec.column_names)
        # intercept + 2 one-hot levels (main, commander) + 1 continuous
        self.assertEqual(len(spec.column_names), 1 + 2 + 1)

    def test_build_design_matrix_row_shape_matches_spec(self):
        rows = [_row(1, setFamily="main", releaseAgeWeeks=10.0)]
        spec = fit_design_matrix_spec(rows)
        X = build_design_matrix(rows, spec)
        self.assertEqual(len(X), 1)
        self.assertEqual(len(X[0]), len(spec.column_names))
        self.assertEqual(X[0][0], 1.0)  # intercept column

    def test_unseen_categorical_level_becomes_all_zero_onehot(self):
        rows = [_row(1, setFamily="main")]
        spec = fit_design_matrix_spec(rows)
        novel = [_row(1, setFamily="never-seen-before")]
        X = build_design_matrix(novel, spec)
        onehot_block = X[0][1 : 1 + len(spec.categorical_vocab["setFamily"])]
        self.assertTrue(all(v == 0.0 for v in onehot_block))

    def test_top_k_caps_vocabulary_size(self):
        rows = [_row(1, setFamily=f"family-{i}") for i in range(50)]
        spec = fit_design_matrix_spec(rows, top_k=5)
        self.assertEqual(len(spec.categorical_vocab["setFamily"]), 5)

    def test_empty_rows_raises(self):
        with self.assertRaises(HedonicError):
            fit_design_matrix_spec([])


class SolveOlsRidgeTests(unittest.TestCase):
    def test_recovers_exact_linear_relationship(self):
        # y = 2 + 3*x, no noise, well-conditioned design.
        X = [[1.0, x] for x in range(10)]
        y = [2.0 + 3.0 * x for x in range(10)]
        beta, used_fallback = solve_ols_ridge(X, y, ridge=1e-9)
        self.assertFalse(used_fallback)
        self.assertAlmostEqual(beta[0], 2.0, places=4)
        self.assertAlmostEqual(beta[1], 3.0, places=4)

    def test_singular_design_matrix_falls_back_to_intercept_only(self):
        # Two perfectly duplicated columns -> XtX is exactly singular even
        # after the base ridge (forced by an artificially tiny max_retries
        # / ridge so the escalation genuinely exhausts).
        X = [[1.0, 5.0, 5.0], [1.0, 3.0, 3.0], [1.0, 8.0, 8.0], [1.0, 1.0, 1.0]]
        y = [10.0, 6.0, 16.0, 2.0]
        beta, used_fallback = solve_ols_ridge(X, y, ridge=0.0, max_retries=1, retry_multiplier=1.0)
        self.assertTrue(used_fallback)
        self.assertEqual(len(beta), 3)
        self.assertAlmostEqual(beta[0], sum(y) / len(y), places=9)
        self.assertEqual(beta[1], 0.0)
        self.assertEqual(beta[2], 0.0)
        self.assertTrue(all(math.isfinite(b) for b in beta))

    def test_ridge_escalation_eventually_recovers_a_non_fallback_solution(self):
        # The same singular system, but with the real (larger) retry
        # schedule: ridge escalation alone should be enough to break the
        # tie and avoid falling back, unlike the previous test's
        # deliberately-starved schedule.
        X = [[1.0, 5.0, 5.0], [1.0, 3.0, 3.0], [1.0, 8.0, 8.0], [1.0, 1.0, 1.0]]
        y = [10.0, 6.0, 16.0, 2.0]
        beta, used_fallback = solve_ols_ridge(X, y)
        self.assertFalse(used_fallback)
        self.assertTrue(all(math.isfinite(b) for b in beta))

    def test_rejects_mismatched_lengths(self):
        with self.assertRaises(HedonicError):
            solve_ols_ridge([[1.0]], [1.0, 2.0])

    def test_rejects_empty_input(self):
        with self.assertRaises(HedonicError):
            solve_ols_ridge([], [])


class CrossValidateHoldoutSetsPerKindMaeTests(unittest.TestCase):
    """FA-04: per-productKind held-out MAE breakdown on HedonicFitMetrics."""

    def test_reports_mae_separately_for_single_and_sealed(self):
        rows, y = [], []
        # "single" rows: feature predicts them well (tight residual).
        for group_id in range(1, 21):
            for _ in range(4):
                rows.append(_row(group_id, setFamily="main", productKind="single", releaseAgeWeeks=10.0))
                y.append(1.0)
        # "sealed" rows: same feature value, but a much noisier target ->
        # the sealed slice's held-out MAE must come out worse than single's.
        import random

        rng = random.Random(11)
        for group_id in range(21, 41):
            for _ in range(4):
                rows.append(_row(group_id, setFamily="main", productKind="sealed", releaseAgeWeeks=10.0))
                y.append(1.0 + rng.uniform(-2.0, 2.0))

        metrics = cross_validate_holdout_sets(rows, y, n_folds=5)
        self.assertIn("single", metrics.holdout_mae_by_kind)
        self.assertIn("sealed", metrics.holdout_mae_by_kind)
        self.assertGreater(metrics.holdout_mae_by_kind["sealed"], metrics.holdout_mae_by_kind["single"])
        self.assertEqual(
            metrics.holdout_covered_by_kind["single"] + metrics.holdout_covered_by_kind["sealed"],
            metrics.holdout_covered,
        )

    def test_rows_without_product_kind_bucket_as_unknown(self):
        rows = [_row(g, setFamily="main", releaseAgeWeeks=float(g)) for g in range(1, 21) for _ in range(4)]
        y = [1.0 + 0.01 * row.continuous["releaseAgeWeeks"] for row in rows]
        metrics = cross_validate_holdout_sets(rows, y, n_folds=5)
        self.assertEqual(set(metrics.holdout_mae_by_kind), {"unknown"})
        self.assertEqual(metrics.holdout_covered_by_kind["unknown"], metrics.holdout_covered)

    def test_as_receipt_dict_keeps_existing_keys_and_adds_new_ones(self):
        rows = [_row(g, setFamily="main", productKind="single", releaseAgeWeeks=float(g)) for g in range(1, 21) for _ in range(4)]
        y = [1.0 + 0.01 * row.continuous["releaseAgeWeeks"] for row in rows]
        metrics = cross_validate_holdout_sets(rows, y, n_folds=5)
        receipt = metrics.as_receipt_dict()
        for existing_key in (
            "nFolds", "nObservations", "nGroups", "nFeatures",
            "holdoutCovered", "holdoutRmse", "holdoutR2", "foldsUsedFallback",
        ):
            self.assertIn(existing_key, receipt)
        self.assertIn("holdoutMaeByKind", receipt)
        self.assertIn("holdoutCoveredByKind", receipt)
        self.assertEqual(receipt["holdoutCoveredByKind"], {"single": metrics.holdout_covered})


class CrossValidateHoldoutSetsTests(unittest.TestCase):
    """Synthetic scenarios verifying held-out-SETS CV is genuinely by-group."""

    def test_pure_per_group_noise_yields_no_leakage_low_r2(self):
        import random

        rng = random.Random(42)
        rows, y = [], []
        for group_id in range(1, 61):
            base = rng.uniform(1.0, 4.0)  # independent of every feature
            for _ in range(5):
                rows.append(_row(group_id, setFamily="main", releaseAgeWeeks=rng.uniform(0, 100)))
                y.append(base + rng.uniform(-0.05, 0.05))
        metrics = cross_validate_holdout_sets(rows, y, n_folds=5)
        # A held-out group's idiosyncratic level is fundamentally
        # unpredictable from features shared with unrelated groups -- R^2
        # must NOT look artificially good (would indicate a leak).
        self.assertLess(metrics.holdout_r2, 0.3)

    def test_group_transferable_signal_is_recovered(self):
        import random

        rng = random.Random(7)
        rows, y = [], []
        families = ["main", "commander", "promos"]
        family_level = {"main": 1.0, "commander": 3.0, "promos": 5.0}
        for group_id in range(1, 61):
            fam = families[group_id % 3]
            for _ in range(5):
                rows.append(_row(group_id, setFamily=fam))
                y.append(family_level[fam] + rng.uniform(-0.02, 0.02))
        metrics = cross_validate_holdout_sets(rows, y, n_folds=5)
        self.assertGreater(metrics.holdout_r2, 0.8)

    def test_folds_never_exceed_distinct_group_count(self):
        rows = [_row(1, setFamily="main"), _row(1, setFamily="main"), _row(2, setFamily="main")]
        y = [1.0, 1.1, 2.0]
        metrics = cross_validate_holdout_sets(rows, y, n_folds=10)
        self.assertLessEqual(metrics.n_folds, metrics.n_groups)

    def test_rejects_misaligned_rows_and_y(self):
        with self.assertRaises(HedonicError):
            cross_validate_holdout_sets([_row(1, setFamily="main")], [1.0, 2.0])


class FitHedonicCategoryTests(unittest.TestCase):
    def test_full_fit_predicts_reasonably_on_training_data(self):
        rows = [_row(g, setFamily="main", releaseAgeWeeks=float(g)) for g in range(1, 31) for _ in range(4)]
        y = [1.0 + 0.01 * row.continuous["releaseAgeWeeks"] for row in rows]
        model = fit_hedonic_category(85, rows, y)
        self.assertEqual(model.category_id, 85)
        preds = [model.predict_log_price(r) for r in rows]
        mse = sum((p - t) ** 2 for p, t in zip(preds, y)) / len(y)
        self.assertLess(mse, 0.05)


class VideoModelV0AblationTests(unittest.TestCase):
    def test_uses_exactly_the_two_proxy_features(self):
        rows = [
            _row(g, scarcityProxy=float(g % 5), desirabilityProxy=float(g))
            for g in range(1, 31)
            for _ in range(4)
        ]
        y = [1.0 + 0.1 * row.continuous["scarcityProxy"] for row in rows]
        receipt = fit_video_model_v0_ablation(85, rows, y)
        self.assertEqual(receipt["categoryId"], 85)
        self.assertTrue(receipt["researchOnly"])
        self.assertEqual(set(receipt["coefficients"]), {"intercept", "scarcityProxy", "desirabilityProxy"})


class ColdStartBandWidenFactorTests(unittest.TestCase):
    def test_widens_bands_beyond_unity(self):
        self.assertGreater(COLD_START_BAND_WIDEN_FACTOR, 1.0)


if __name__ == "__main__":
    unittest.main()
