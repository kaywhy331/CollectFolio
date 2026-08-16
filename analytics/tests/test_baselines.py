from math import exp
import unittest

from collectfolio_analytics.baselines import (
    damped_momentum,
    lifecycle_cohort,
    market_index,
    no_change,
    structural_convergence,
)


class BaselineTests(unittest.TestCase):
    def test_no_change_preserves_current_price(self):
        forecast = no_change(125.50, 90)
        self.assertEqual(forecast.model_key, "no_change")
        self.assertEqual(forecast.predicted_log_return, 0)
        self.assertEqual(forecast.median_price, 125.50)

    def test_damped_momentum_uses_log_space(self):
        forecast = damped_momentum(100, 30, 0.01, damping=0.25, max_abs_log_return=None)
        self.assertAlmostEqual(forecast.predicted_log_return, 0.075)
        self.assertAlmostEqual(forecast.median_price, 100 * exp(0.075))

    def test_damped_momentum_caps_extreme_extrapolation(self):
        forecast = damped_momentum(100, 365, 0.10, damping=1, max_abs_log_return=0.70)
        self.assertAlmostEqual(forecast.predicted_log_return, 0.70)
        self.assertAlmostEqual(forecast.median_price, 100 * exp(0.70))

    def test_market_and_lifecycle_baselines_keep_their_identity(self):
        market = market_index(100, 30, 0.01, damping=0.2, max_abs_log_return=None)
        lifecycle = lifecycle_cohort(100, 30, -0.12)
        self.assertEqual(market.model_key, "market_index")
        self.assertAlmostEqual(market.predicted_log_return, 0.06)
        self.assertEqual(lifecycle.model_key, "lifecycle_cohort")
        self.assertAlmostEqual(lifecycle.median_price, 100 * exp(-0.12))

    def test_structural_convergence_closes_only_the_declared_gap_fraction(self):
        forecast = structural_convergence(
            100, 90, 144, convergence_fraction=0.5, max_abs_log_return=None,
        )
        self.assertEqual(forecast.model_key, "structural_convergence")
        self.assertAlmostEqual(forecast.median_price, 120)

    def test_baselines_reject_invalid_inputs(self):
        with self.assertRaises(ValueError):
            no_change(0, 30)
        with self.assertRaises(ValueError):
            damped_momentum(10, 30, 0.1, damping=1.1)
        with self.assertRaises(ValueError):
            structural_convergence(10, 30, 0)


if __name__ == "__main__":
    unittest.main()
