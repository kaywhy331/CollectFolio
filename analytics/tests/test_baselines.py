from math import exp
import unittest

from collectfolio_analytics.baselines import damped_momentum, no_change


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

    def test_baselines_reject_invalid_inputs(self):
        with self.assertRaises(ValueError):
            no_change(0, 30)
        with self.assertRaises(ValueError):
            damped_momentum(10, 30, 0.1, damping=1.1)


if __name__ == "__main__":
    unittest.main()

