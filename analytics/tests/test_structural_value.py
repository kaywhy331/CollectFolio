from datetime import datetime, timedelta, timezone
from math import exp
import unittest

from collectfolio_analytics.structural_value import (
    StructuralFeatureRow,
    StructuralModelPolicy,
    estimate_structural_fair_value,
    fit_structural_fair_value,
)


UTC = timezone.utc
CUTOFF = datetime(2026, 8, 1, tzinfo=UTC)


def row(index, *, observed_at=None, available_at=None, price=None, aggregate=()):
    observed = observed_at or CUTOFF - timedelta(days=100 - index)
    scarcity = index / 20
    demand = (index % 7) / 7
    character = "popular" if index % 3 == 0 else "other"
    expected_log_price = 3.5 + 0.55 * scarcity + 0.35 * demand + (0.25 if character == "popular" else 0)
    return StructuralFeatureRow(
        variant_id=f"card-{index}",
        cohort_key="pokemon-en-raw-nm",
        observed_at=observed,
        price_available_at=available_at or observed,
        current_price=price or exp(expected_log_price + (index % 5 - 2) * 0.015),
        evidence_quality=0.9,
        numeric_features={
            "negative_log_pull_probability": scarcity,
            "demand_index": demand,
            "artwork_score": None if index % 11 == 0 else (index % 9) / 9,
        },
        categorical_features={"character_tier": character, "set": f"set-{index % 5}"},
        feature_timestamps=(observed,),
        aggregate_source_variant_ids=aggregate,
    )


class StructuralValueTests(unittest.TestCase):
    def test_target_card_cannot_leak_into_aggregate_features(self):
        with self.assertRaisesRegex(ValueError, "own aggregate"):
            row(1, aggregate=("card-1",))

    def test_structural_model_is_robust_calibrated_and_research_only(self):
        rows = [row(index) for index in range(80)]
        rows[10] = row(10, price=10_000)
        model = fit_structural_fair_value(
            rows,
            CUTOFF,
            policy=StructuralModelPolicy(
                minimum_training_rows=40,
                minimum_calibration_rows=12,
                calibration_fraction=0.25,
            ),
        )
        target = row(
            90,
            observed_at=CUTOFF,
            available_at=CUTOFF,
            price=50,
        )
        estimate = estimate_structural_fair_value(model, target, CUTOFF)
        self.assertEqual(model.status, "research_only")
        self.assertGreater(estimate.quantiles[0.50], target.current_price)
        self.assertEqual(estimate.position, "below_range")
        self.assertLessEqual(estimate.quantiles[0.10], estimate.quantiles[0.25])
        self.assertLessEqual(estimate.quantiles[0.25], estimate.quantiles[0.50])
        self.assertLessEqual(estimate.quantiles[0.50], estimate.quantiles[0.75])
        self.assertLessEqual(estimate.quantiles[0.75], estimate.quantiles[0.90])
        self.assertFalse(estimate.public_publication_allowed)
        self.assertEqual(len(model.artifact_hash), 64)

    def test_late_available_backfill_is_not_training_evidence(self):
        rows = [row(index) for index in range(30)]
        rows.extend(
            row(
                100 + index,
                observed_at=CUTOFF - timedelta(days=300),
                available_at=CUTOFF + timedelta(days=1),
            )
            for index in range(20)
        )
        model = fit_structural_fair_value(
            rows,
            CUTOFF,
            policy=StructuralModelPolicy(
                minimum_training_rows=30,
                minimum_calibration_rows=10,
                calibration_fraction=0.25,
            ),
        )
        self.assertLess(model.training_count + model.calibration_count, 50)
        self.assertEqual(model.status, "quarantined")

    def test_prediction_rejects_price_that_was_not_yet_available(self):
        rows = [row(index) for index in range(60)]
        model = fit_structural_fair_value(rows, CUTOFF)
        target = row(
            90,
            observed_at=CUTOFF,
            available_at=CUTOFF + timedelta(days=1),
        )
        with self.assertRaisesRegex(ValueError, "not fully available"):
            estimate_structural_fair_value(model, target, CUTOFF)


if __name__ == "__main__":
    unittest.main()
