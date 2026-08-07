import unittest

from collectfolio_analytics.quantiles import (
    QuantileOrderError,
    rearrange_quantiles,
    validate_quantiles,
)


class QuantileTests(unittest.TestCase):
    def test_required_quantiles_are_validated_in_order(self):
        values = {0.90: 140, 0.10: 80, 0.50: 105, 0.25: 95, 0.75: 120}
        self.assertEqual(
            validate_quantiles(values),
            ((0.10, 80.0), (0.25, 95.0), (0.50, 105.0), (0.75, 120.0), (0.90, 140.0)),
        )

    def test_crossed_quantiles_are_rejected(self):
        with self.assertRaises(QuantileOrderError):
            validate_quantiles({0.10: 80, 0.25: 95, 0.50: 130, 0.75: 120, 0.90: 140})

    def test_missing_required_quantile_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "missing"):
            validate_quantiles({0.10: 80, 0.25: 95, 0.50: 100, 0.90: 140})

    def test_rearrangement_is_explicit_and_monotone(self):
        repaired = rearrange_quantiles({0.10: 80, 0.50: 130, 0.90: 100})
        self.assertEqual(repaired, {0.10: 80, 0.50: 100, 0.90: 130})


if __name__ == "__main__":
    unittest.main()

