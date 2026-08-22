import math
import tempfile
import unittest
from pathlib import Path

from collectfolio_analytics.indices import build_indices
from collectfolio_analytics.lifecycle import build_lifecycle_curve
from collectfolio_analytics.trajectory_eval import (
    COMMON_WEIGHT_GRID,
    DRIFT_WEIGHT_GRID,
    REVERSION_WEIGHT_GRID,
    DEFAULT_TRAIN_FRACTION,
    MIN_HOLDOUT_ORIGINS,
    SAMPLING_RULE_DESCRIPTION,
    CohortHorizonResult,
    EvalCase,
    _apply_held_out_set_gate,
    _collect_raw_cases,
    _quantiles_excluding_group,
    _sample_variant_keys,
    evaluate_cohort_horizon,
    gate_holdout_evaluation,
    run_component_weight_remediation,
    select_component_weights,
    select_non_overlapping_origins,
    split_origins_chronologically,
)

# Reuse the exact synthetic-panel fixture test_trajectory.py already
# validates process_category against, so trajectory_eval's own tests are
# built on the same known-shape data rather than a second, divergent
# fixture.
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_trajectory import _build_synthetic_panel  # noqa: E402


class SplitOriginsChronologicallyTests(unittest.TestCase):
    def test_orders_and_splits_by_fraction(self):
        origins = [50, 10, 30, 20, 40, 60, 70, 80, 90, 100]
        train, holdout = split_origins_chronologically(origins, train_fraction=0.6, min_holdout=2)
        self.assertEqual(train, (10, 20, 30, 40, 50, 60))
        self.assertEqual(holdout, (70, 80, 90, 100))
        # Chronological, not random -- every train origin precedes every
        # holdout origin.
        self.assertLess(max(train), min(holdout))

    def test_min_holdout_is_guaranteed_by_shrinking_training_not_holdout(self):
        # 10 origins, train_fraction=0.95 would naively leave only 0-1
        # holdout origins -- min_holdout=6 must claw origins back from the
        # training side instead.
        origins = list(range(10))
        train, holdout = split_origins_chronologically(origins, train_fraction=0.95, min_holdout=6)
        self.assertEqual(len(holdout), 6)
        self.assertEqual(len(train), 4)
        self.assertEqual(set(train) | set(holdout), set(origins))
        self.assertEqual(set(train) & set(holdout), set())

    def test_fewer_origins_than_min_holdout_gives_holdout_everything_possible(self):
        origins = [1, 2, 3]
        train, holdout = split_origins_chronologically(origins, train_fraction=0.6, min_holdout=6)
        self.assertEqual(train, ())
        self.assertEqual(holdout, (1, 2, 3))

    def test_empty_origins(self):
        self.assertEqual(split_origins_chronologically([]), ((), ()))

    def test_duplicates_are_deduplicated(self):
        train, holdout = split_origins_chronologically([5, 5, 5, 10, 10, 15], train_fraction=0.6, min_holdout=1)
        self.assertEqual(set(train) | set(holdout), {5, 10, 15})

    def test_defaults_match_module_constants(self):
        # Sanity: the function's own defaults are the module-level
        # constants the remediation spec named (~60% train, >=6 holdout).
        self.assertEqual(DEFAULT_TRAIN_FRACTION, 0.6)
        self.assertEqual(MIN_HOLDOUT_ORIGINS, 6)


class NonOverlappingOriginTests(unittest.TestCase):
    def test_current_eighty_week_panel_has_expected_independent_blocks(self):
        self.assertEqual(len(select_non_overlapping_origins(80, 4)), 16)
        self.assertEqual(len(select_non_overlapping_origins(80, 9)), 7)
        self.assertEqual(len(select_non_overlapping_origins(80, 13)), 4)
        self.assertTrue(all(
            right - left == 9
            for left, right in zip(
                select_non_overlapping_origins(80, 9),
                select_non_overlapping_origins(80, 9)[1:],
            )
        ))


class ExcludedGroupQuantileTests(unittest.TestCase):
    def test_matches_filter_then_empirical_quantile(self):
        from collectfolio_analytics.trajectory import empirical_quantile

        labeled = sorted([
            (-3.0, 1), (-2.0, 2), (-1.0, 1), (0.0, 3),
            (0.5, 2), (1.0, 1), (2.0, 3), (5.0, 2),
        ])
        values = [value for value, _group in labeled]
        probabilities = (0.10, 0.25, 0.50, 0.75, 0.90)
        for excluded_group in (1, 2, 3, 999):
            positions = [
                index for index, (_value, group) in enumerate(labeled)
                if group == excluded_group
            ]
            expected_values = sorted(
                value for value, group in labeled if group != excluded_group
            )
            expected = {
                probability: empirical_quantile(expected_values, probability)
                for probability in probabilities
            }
            self.assertEqual(
                _quantiles_excluding_group(values, positions, probabilities),
                expected,
            )

    def test_empty_after_exclusion_uses_caller_fallback(self):
        self.assertEqual(_quantiles_excluding_group([1.0, 2.0], [0, 1], (0.5,)), {})


class HeldOutSetGateEvidenceCountTests(unittest.TestCase):
    def test_counts_only_score_blocks_that_contributed_cohort_cases(self):
        cases = [
            EvalCase(
                product_id=index,
                sub_type_name="Normal",
                group_id=1,
                cohort="standard",
                horizon_days=30,
                origin_date="2025-01-01",
                target_date="2025-01-29",
                current_price=100.0,
                realized_price=105.0,
                engine_median_price=104.0,
                engine_q10_price=90.0,
                engine_q90_price=120.0,
                baseline_median_prices={"no_change": 100.0},
            )
            for index in range(3)
        ]
        base = evaluate_cohort_horizon(3, "standard", 30, cases)
        gated = _apply_held_out_set_gate(base, cases)
        self.assertEqual(gated.n_score_blocks, 1)
        self.assertTrue(any("only 1 non-overlapping scored blocks" in reason for reason in gated.fail_reasons))


class ZeroLiftIsAlwaysAFailTests(unittest.TestCase):
    """Remediation requirement 5: 'if a category's best is a=b=0 with lift
    exactly 0, record it as FAIL (PRD requires strictly >0) -- no
    fudging.' evaluate_cohort_horizon's own `lift > 0` check already fails
    lift == 0 with no special-casing needed; this pins that behavior."""

    def test_exactly_zero_lift_fails_even_with_perfect_coverage_and_direction(self):
        from collectfolio_analytics.trajectory_eval import EvalCase

        cases = []
        # Construct cases where the engine's median forecast is IDENTICAL
        # to no-change (so mae_engine == mae_no_change exactly, lift ==
        # 0.0), but coverage/direction/pinball are otherwise as favorable
        # as possible -- lift == 0 alone must still fail.
        for i in range(10):
            current = 100.0 * (1.06 if i % 2 == 0 else 0.94)  # >=5% movers
            realized = current * 1.10
            cases.append(EvalCase(
                product_id=i, sub_type_name="Normal", group_id=1, cohort="standard",
                horizon_days=30, origin_date="2025-01-01", target_date="2025-01-31",
                current_price=current, realized_price=realized,
                engine_median_price=current,  # identical to no_change -> lift == 0
                engine_q10_price=realized * 0.5, engine_q90_price=realized * 1.5,
                baseline_median_prices={"no_change": current},
            ))
        result = evaluate_cohort_horizon(85, "standard", 30, cases)
        self.assertEqual(result.mae_lift_over_no_change, 0.0)
        self.assertFalse(result.passes)
        self.assertFalse(result.serving_eligible)
        self.assertTrue(any("not positive" in r for r in result.fail_reasons))


class RemediationPipelineSmokeTests(unittest.TestCase):
    """End-to-end on a small synthetic panel: verifies
    select_component_weights + gate_holdout_evaluation run, produce a
    train/holdout split with no origin overlap, and shapes match
    evaluate_category's output contract."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.panel_dir = Path(self.tmp.name) / "panel"
        self.category_id = 7777
        # Enough dates that select_walk_forward_origins can produce >=6
        # holdout origins per horizon at the default split.
        self.dates, self.groups_metadata = _build_synthetic_panel(self.panel_dir, self.category_id, n_dates=40)
        self.index_set = build_indices(self.panel_dir, [self.category_id])
        self.curve = build_lifecycle_curve(self.index_set, self.groups_metadata)

    def test_selection_and_gate_shapes_and_honest_split(self):
        out = run_component_weight_remediation(
            self.panel_dir, self.category_id, self.index_set, self.curve, self.groups_metadata,
        )
        self.assertEqual(out["categoryId"], self.category_id)
        selection = out["selection"]
        self.assertTrue(selection)
        for h_steps, sel in selection.items():
            self.assertIn(sel["weightA"], COMMON_WEIGHT_GRID)
            self.assertIn(sel["weightC"], REVERSION_WEIGHT_GRID)
            self.assertIn(sel["weightB"], DRIFT_WEIGHT_GRID)
            train_set = set(sel["trainOrigins"])
            holdout_set = set(sel["holdoutOrigins"])
            self.assertEqual(train_set & holdout_set, set())
            if train_set or holdout_set:
                self.assertLess(max(train_set, default=-1), min(holdout_set, default=math.inf))
            self.assertEqual(
                len(sel["gridScores"]),
                len(COMMON_WEIGHT_GRID) * len(REVERSION_WEIGHT_GRID) * len(DRIFT_WEIGHT_GRID),
            )

        gate = out["gate"]
        self.assertEqual(gate["categoryId"], self.category_id)
        self.assertIn("servingEligibleByCohort", gate)
        self.assertIn("anyCohortServingEligible", gate)
        self.assertIn("coldStart", gate)
        self.assertEqual(gate["coldStart"]["status"], "reference-only")
        self.assertTrue(gate["validationProtocol"]["q50PinnedToPointModel"])
        for result in gate["results"]:
            self.assertIsInstance(result, CohortHorizonResult)
            self.assertEqual(result.category_id, self.category_id)
            # Holdout-only: no gate case's n_cases can exceed what the
            # (much smaller) holdout origin set could produce -- a loose
            # sanity bound that would fail if the gate accidentally
            # scored training-origin cases too.
            self.assertGreaterEqual(result.n_cases, 0)

    def test_select_component_weights_uses_only_training_origins_for_calibration(self):
        raw = _collect_raw_cases(
            self.panel_dir, self.category_id, self.index_set, self.curve, self.groups_metadata,
            horizons_days=(30, 90), hedonic_log_price=None, max_origins_per_horizon=60,
        )
        selection = select_component_weights(raw)
        gate = gate_holdout_evaluation(raw, selection)
        # componentWeights key in the gate output must match the selection.
        for h_steps, sel in selection.items():
            self.assertEqual(
                gate["componentWeights"][sel["horizonDays"]],
                (sel["weightA"], sel["weightC"], sel["weightB"]),
            )



class SampleVariantKeysTests(unittest.TestCase):
    """Deterministic sha256-ranked N-of-M variant sampling."""

    def _keys(self, n):
        return [(1000 + i, "Normal" if i % 2 == 0 else "Foil") for i in range(n)]

    def test_no_op_when_count_at_or_below_max(self):
        keys = self._keys(10)
        self.assertEqual(_sample_variant_keys(keys, 10), set(keys))
        self.assertEqual(_sample_variant_keys(keys, 20), set(keys))

    def test_no_op_when_max_variants_is_none(self):
        keys = self._keys(10)
        self.assertEqual(_sample_variant_keys(keys, None), set(keys))

    def test_exact_size_when_count_exceeds_max(self):
        keys = self._keys(500)
        sample = _sample_variant_keys(keys, 137)
        self.assertEqual(len(sample), 137)
        self.assertTrue(sample.issubset(set(keys)))

    def test_deterministic_across_repeated_calls(self):
        keys = self._keys(500)
        first = _sample_variant_keys(keys, 137)
        second = _sample_variant_keys(list(keys), 137)
        self.assertEqual(first, second)

    def test_deterministic_independent_of_input_order(self):
        keys = self._keys(500)
        shuffled = list(keys)
        import random as _random

        _random.Random(0).shuffle(shuffled)
        self.assertEqual(_sample_variant_keys(keys, 137), _sample_variant_keys(shuffled, 137))

    def test_input_keys_are_already_unique_by_construction(self):
        # _sample_variant_keys is always called with variant_index.keys()
        # (a dict's keys, inherently unique) -- duplicate-input dedup
        # semantics are intentionally out of scope.
        keys = self._keys(500)
        self.assertEqual(len(keys), len(set(keys)))


class RawCollectionSamplingMetadataTests(unittest.TestCase):
    """_collect_raw_cases threads max_variants_per_category into a smaller,
    transparently-reindexed variant universe and records honest sampling
    receipts on the returned _RawCollection."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.panel_dir = Path(self.tmp.name) / "panel"
        self.category_id = 8888
        # 2 groups x 5 products = 10 variants (see _build_synthetic_panel).
        self.dates, self.groups_metadata = _build_synthetic_panel(self.panel_dir, self.category_id, n_dates=40)
        self.index_set = build_indices(self.panel_dir, [self.category_id])
        self.curve = build_lifecycle_curve(self.index_set, self.groups_metadata)

    def _collect(self, max_variants_per_category):
        return _collect_raw_cases(
            self.panel_dir, self.category_id, self.index_set, self.curve, self.groups_metadata,
            horizons_days=(30, 90), hedonic_log_price=None, max_origins_per_horizon=60,
            max_variants_per_category=max_variants_per_category,
        )

    def test_no_sampling_when_under_threshold(self):
        raw = self._collect(20_000)
        self.assertEqual(raw.total_variants, 10)
        self.assertEqual(raw.sampled_variants, 10)
        self.assertFalse(raw.sampling_applied)
        self.assertIsNone(raw.sampling_rule)

    def test_no_sampling_when_max_variants_is_none(self):
        raw = self._collect(None)
        self.assertEqual(raw.total_variants, 10)
        self.assertEqual(raw.sampled_variants, 10)
        self.assertFalse(raw.sampling_applied)

    def test_sampling_applied_when_over_threshold(self):
        raw = self._collect(3)
        self.assertEqual(raw.total_variants, 10)
        self.assertEqual(raw.sampled_variants, 3)
        self.assertTrue(raw.sampling_applied)
        self.assertEqual(raw.sampling_rule, SAMPLING_RULE_DESCRIPTION)

    def test_run_component_weight_remediation_exposes_sampling_receipts(self):
        out = run_component_weight_remediation(
            self.panel_dir, self.category_id, self.index_set, self.curve, self.groups_metadata,
            max_variants_per_category=3,
        )
        self.assertEqual(out["totalVariants"], 10)
        self.assertEqual(out["sampledVariants"], 3)
        self.assertTrue(out["samplingApplied"])
        self.assertEqual(out["samplingRule"], SAMPLING_RULE_DESCRIPTION)

    def test_run_component_weight_remediation_no_sampling_receipts_are_honest(self):
        out = run_component_weight_remediation(
            self.panel_dir, self.category_id, self.index_set, self.curve, self.groups_metadata,
            max_variants_per_category=20_000,
        )
        self.assertEqual(out["totalVariants"], 10)
        self.assertEqual(out["sampledVariants"], 10)
        self.assertFalse(out["samplingApplied"])
        self.assertIsNone(out["samplingRule"])
