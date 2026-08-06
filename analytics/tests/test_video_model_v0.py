from math import exp
import unittest

from collectfolio_analytics.video_model_v0 import evaluate_video_model_v0


class VideoModelV0Tests(unittest.TestCase):
    def test_formula_reproduces_declared_coefficients(self):
        audit = evaluate_video_model_v0(18_446, 2)
        expected_log_price = 2.418749626 + 0.177451739 * 10 + 0.341586702 * 2
        self.assertEqual(audit.model_key, "video_model_v0")
        self.assertEqual(audit.pull_score, 10)
        self.assertAlmostEqual(audit.log_price, expected_log_price)
        self.assertAlmostEqual(audit.reconstructed_price, exp(expected_log_price))
        self.assertTrue(audit.research_only)

    def test_invalid_inputs_are_rejected(self):
        with self.assertRaises(ValueError):
            evaluate_video_model_v0(-1, 2)
        with self.assertRaises(ValueError):
            evaluate_video_model_v0(10, float("nan"))


if __name__ == "__main__":
    unittest.main()

