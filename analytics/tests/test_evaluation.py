from datetime import datetime, timedelta, timezone
from math import log
import unittest

from collectfolio_analytics.evaluation import (
    ForecastCase,
    ResearchLineage,
    WalkForwardAudit,
    assert_features_known,
    evaluate_cases,
    realized_price_at_maturity,
    training_label_is_mature,
)
from collectfolio_analytics.observations import PriceObservation, PriceSeriesKey


UTC = timezone.utc
ORIGIN = datetime(2026, 6, 1, tzinfo=UTC)
KEY = PriceSeriesKey(
    "44444444-4444-4444-8444-444444444444",
    "market-a",
    "USD",
    "normal",
    "raw",
    "daily-median",
)
LINEAGE = ResearchLineage(
    dataset_sha256="a" * 64,
    code_version="git:abc123",
    feature_version="market-features-v1",
    mapping_version="mapping-snapshot-v1",
    model_version="candidate-v1",
)


def audit(horizon=30):
    return WalkForwardAudit(
        origin=ORIGIN,
        horizon_days=horizon,
        feature_cutoff=ORIGIN,
        training_cutoff=ORIGIN - timedelta(days=1),
        latest_training_label_maturity=ORIGIN - timedelta(days=1),
        evaluated_at=ORIGIN + timedelta(days=horizon, hours=1),
    )


class EvaluationTests(unittest.TestCase):
    def test_label_maturity_and_feature_cutoff_rules(self):
        self.assertTrue(training_label_is_mature(ORIGIN - timedelta(days=30), 30, ORIGIN))
        self.assertFalse(training_label_is_mature(ORIGIN - timedelta(days=29), 30, ORIGIN))
        assert_features_known([ORIGIN - timedelta(days=1), ORIGIN], ORIGIN)
        with self.assertRaisesRegex(ValueError, "exceeds"):
            assert_features_known([ORIGIN + timedelta(seconds=1)], ORIGIN)

    def test_walk_forward_audit_rejects_immature_training_label(self):
        with self.assertRaisesRegex(ValueError, "had not matured"):
            WalkForwardAudit(
                origin=ORIGIN,
                horizon_days=30,
                feature_cutoff=ORIGIN,
                training_cutoff=ORIGIN - timedelta(days=1),
                latest_training_label_maturity=ORIGIN,
                evaluated_at=ORIGIN + timedelta(days=30),
            )

    def test_walk_forward_audit_rejects_early_evaluation(self):
        with self.assertRaisesRegex(ValueError, "before"):
            WalkForwardAudit(
                origin=ORIGIN,
                horizon_days=30,
                feature_cutoff=ORIGIN,
                training_cutoff=ORIGIN,
                latest_training_label_maturity=ORIGIN,
                evaluated_at=ORIGIN + timedelta(days=29),
            )

    def test_realized_price_is_trailing_seven_day_median(self):
        maturity = ORIGIN + timedelta(days=30)
        observations = [
            PriceObservation(
                KEY,
                maturity - timedelta(days=offset),
                maturity - timedelta(days=offset),
                price,
            )
            for offset, price in enumerate([110, 109, 108, 107, 106, 105, 104])
        ]
        realized = realized_price_at_maturity(observations, maturity, maturity + timedelta(days=1))
        self.assertEqual(realized.trailing_seven_day_median, 107)
        self.assertEqual(realized.exact_date_price, 110)
        self.assertEqual(realized.observation_count, 7)

    def test_summary_scores_baseline_probability_and_intervals(self):
        quantiles_up = {0.10: 80, 0.25: 90, 0.50: 105, 0.75: 115, 0.90: 130}
        quantiles_down = {0.10: 70, 0.25: 80, 0.50: 95, 0.75: 100, 0.90: 120}
        cases = [
            ForecastCase(audit(), KEY, LINEAGE, 100, 105, 110, 100, 0.70, quantiles_up),
            ForecastCase(audit(), KEY, LINEAGE, 100, 95, 90, 100, 0.20, quantiles_down),
        ]
        summary = evaluate_cases(cases)
        expected_mae = (abs(log(105 / 110)) + abs(log(95 / 90))) / 2
        expected_baseline = (abs(log(100 / 110)) + abs(log(100 / 90))) / 2
        self.assertAlmostEqual(summary.mae_log_return, expected_mae)
        self.assertAlmostEqual(summary.baseline_relative_lift, 1 - expected_mae / expected_baseline)
        self.assertEqual(summary.direction_accuracy, 1)
        self.assertAlmostEqual(summary.brier_score, 0.065)
        self.assertEqual(summary.interval_50_coverage, 1)
        self.assertEqual(summary.interval_80_coverage, 1)
        self.assertEqual(summary.mean_interval_50_width, 22.5)
        self.assertEqual(summary.mean_interval_80_width, 50)
        self.assertEqual(set(summary.pinball_loss), {0.10, 0.25, 0.50, 0.75, 0.90})

    def test_evaluation_rejects_mixed_horizons_and_crossed_quantiles(self):
        with self.assertRaisesRegex(ValueError, "nondecreasing"):
            ForecastCase(
                audit(),
                KEY,
                LINEAGE,
                100,
                105,
                110,
                quantiles={0.10: 80, 0.25: 90, 0.50: 120, 0.75: 110, 0.90: 130},
            )
        with self.assertRaisesRegex(ValueError, "cannot mix"):
            evaluate_cases([
                ForecastCase(audit(7), KEY, LINEAGE, 100, 101, 102),
                ForecastCase(audit(30), KEY, LINEAGE, 100, 105, 110),
            ])

    def test_research_lineage_requires_a_real_dataset_digest(self):
        with self.assertRaisesRegex(ValueError, "64-character"):
            ResearchLineage("not-a-hash", "code", "features", "mapping", "model")


if __name__ == "__main__":
    unittest.main()
