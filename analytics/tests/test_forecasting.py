from datetime import datetime, timedelta, timezone
from math import exp
import unittest

from collectfolio_analytics.evaluation import (
    ForecastCase,
    ResearchLineage,
    WalkForwardAudit,
    evaluate_cases,
)
from collectfolio_analytics.forecasting import (
    PromotionPolicy,
    ResearchModelCard,
    assess_research_scorecard,
    build_research_baseline_packet,
)
from collectfolio_analytics.market_pipeline import SourceTerms
from collectfolio_analytics.observations import PriceSeriesKey
from collectfolio_analytics.trends import TrendSnapshot


UTC = timezone.utc
NOW = datetime(2026, 8, 5, 20, 30, tzinfo=UTC)
SOURCE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
TERMS_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
RUN_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
SNAPSHOT_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
MODEL_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
VARIANT_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff"
LINEAGE = ResearchLineage("1" * 64, "git:abc", "trends-v1", "mapping-v1", "damped-v1")


def terms(decision="research_only"):
    return SourceTerms(
        SOURCE_ID, TERMS_ID, TERMS_ID, "research-market", "Research Market",
        decision, True, False, False, False, False, False, "", "2" * 64,
        NOW - timedelta(days=1), NOW + timedelta(days=30),
    )


def snapshot(*, slope=0.002, volatility=0.02):
    key = PriceSeriesKey(VARIANT_ID, SOURCE_ID, "USD", "holofoil", "raw", "market")
    return TrendSnapshot(
        key=key,
        feature_cutoff=NOW,
        latest_observed_at=NOW,
        current_price=100,
        return_7d=0.02,
        return_30d=0.05,
        return_90d=0.12,
        return_180d=None,
        return_365d=None,
        robust_slope_30d=slope,
        robust_slope_90d=slope,
        momentum_acceleration=0,
        volatility_30d=volatility,
        volatility_90d=volatility,
        max_drawdown_180d=0.10,
        history_density_90d=0.9,
        staleness_hours=0,
        source_quality_90d=0.8,
        evidence_quality=0.8,
        slope_z_90d=0.1,
        trend_state="stable",
        observation_count_90d=82,
    )


def model(family="damped_momentum_baseline"):
    return ResearchModelCard(
        MODEL_ID, "damped-momentum", "1.0.0", family, LINEAGE,
        (7, 30, 90, 180, 365), NOW,
        {"damping": 0.25, "maxAbsLogReturn": 0.70, "maxIntervalLogWidth": 1.50},
    )


class ForecastingTests(unittest.TestCase):
    def test_baseline_packet_is_probabilistic_immutable_and_never_public(self):
        packet = build_research_baseline_packet(
            model(), snapshot(), terms(),
            analytics_run_id=RUN_ID,
            trend_snapshot_id=SNAPSHOT_ID,
            origin=NOW,
        )
        self.assertEqual(len(packet.prediction_rows), 5)
        row = packet.prediction_rows[1]
        self.assertEqual(row["horizon_days"], 30)
        self.assertAlmostEqual(row["q50"], 100 * exp(0.002 * 30 * 0.25))
        self.assertLessEqual(row["q10"], row["q25"])
        self.assertLessEqual(row["q25"], row["q50"])
        self.assertLessEqual(row["q50"], row["q75"])
        self.assertLessEqual(row["q75"], row["q90"])
        self.assertEqual(row["prediction_status"], "research_only")
        self.assertIn("operator_model_review_required", row["reason_codes"])
        self.assertFalse(packet.public_publication_allowed)
        self.assertEqual(len(packet.packet_hash), 64)

    def test_missing_volatility_quarantines_every_horizon(self):
        packet = build_research_baseline_packet(
            model(), snapshot(volatility=None), terms(),
            analytics_run_id=RUN_ID,
            trend_snapshot_id=SNAPSHOT_ID,
            origin=NOW,
        )
        self.assertTrue(all(row["prediction_status"] == "quarantined" for row in packet.prediction_rows))
        self.assertTrue(all(row["confidence"] == 0 for row in packet.prediction_rows))

    def test_source_rights_and_point_in_time_cutoffs_fail_closed(self):
        with self.assertRaises(PermissionError):
            build_research_baseline_packet(
                model(), snapshot(), terms("pending"),
                analytics_run_id=RUN_ID, trend_snapshot_id=SNAPSHOT_ID, origin=NOW,
            )
        future = snapshot()
        object.__setattr__(future, "feature_cutoff", NOW + timedelta(seconds=1))
        with self.assertRaisesRegex(ValueError, "exceeds"):
            build_research_baseline_packet(
                model(), future, terms(),
                analytics_run_id=RUN_ID, trend_snapshot_id=SNAPSHOT_ID, origin=NOW,
            )

    def test_statistical_eligibility_still_requires_operator_review(self):
        audit = WalkForwardAudit(
            NOW - timedelta(days=30), 30,
            NOW - timedelta(days=30), NOW - timedelta(days=31),
            NOW - timedelta(days=31), NOW,
        )
        key = snapshot().key
        cases = [
            ForecastCase(
                audit, key, LINEAGE, 100, 110, 110, 100, 0.75,
                {0.10: 90, 0.25: 100, 0.50: 110, 0.75: 120, 0.90: 130},
            )
            for _ in range(30)
        ]
        summary = evaluate_cases(cases)
        scorecard = assess_research_scorecard(
            summary,
            policy=PromotionPolicy(
                interval_80_coverage_min=0.7, interval_80_coverage_max=1.0
            ),
            baseline_results={
                name: summary.baseline_relative_lift
                for name in PromotionPolicy().required_baselines
            },
        )
        self.assertEqual(scorecard.recommendation, "eligible_for_operator_review")
        self.assertTrue(scorecard.operator_review_required)

    def test_five_baseline_policy_fails_closed_when_only_no_change_exists(self):
        audit = WalkForwardAudit(
            NOW - timedelta(days=31), 30, NOW - timedelta(days=31),
            NOW - timedelta(days=31), None, NOW,
        )
        cases = [
            ForecastCase(
                audit, snapshot().key, LINEAGE, 100, 110, 110, 100, 0.75,
                {0.10: 90, 0.25: 100, 0.50: 110, 0.75: 120, 0.90: 130},
            )
            for _ in range(30)
        ]
        summary = evaluate_cases(cases)
        scorecard = assess_research_scorecard(
            summary,
            baseline_results={"no_change": summary.baseline_relative_lift},
        )

        self.assertEqual(scorecard.recommendation, "insufficient")
        self.assertIn("missing_required_baselines", scorecard.reason_codes)
        self.assertEqual(
            scorecard.metrics["missingRequiredBaselines"],
            [
                "damped_momentum", "market_index", "lifecycle_cohort",
                "structural_convergence",
            ],
        )


if __name__ == "__main__":
    unittest.main()
