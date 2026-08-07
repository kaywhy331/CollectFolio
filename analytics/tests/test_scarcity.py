import unittest

from collectfolio_analytics.scarcity import hit_probability, pull_metrics


class ScarcityTests(unittest.TestCase):
    def test_pull_metrics_match_prd_formulas(self):
        metrics = pull_metrics(0.10, 10, equal_distribution_assumed=True)
        self.assertAlmostEqual(metrics.specific_card_probability, 0.01)
        self.assertAlmostEqual(metrics.negative_log_specific_probability, 4.605170185988091)
        self.assertAlmostEqual(metrics.expected_packs, 100)
        self.assertEqual(metrics.packs_for_50_percent_hit, 69)
        self.assertEqual(metrics.packs_for_90_percent_hit, 230)
        self.assertEqual(metrics.packs_for_95_percent_hit, 299)

    def test_integer_pack_threshold_meets_target_but_prior_pack_does_not(self):
        metrics = pull_metrics(0.10, 10, equal_distribution_assumed=True)
        count = metrics.packs_for_90_percent_hit
        self.assertGreaterEqual(hit_probability(metrics.specific_card_probability, count), 0.90)
        self.assertLess(hit_probability(metrics.specific_card_probability, count - 1), 0.90)

    def test_guaranteed_specific_hit_needs_one_pack(self):
        metrics = pull_metrics(1, 1, equal_distribution_assumed=True)
        self.assertEqual(metrics.expected_packs, 1)
        self.assertEqual(metrics.packs_for_95_percent_hit, 1)

    def test_equal_distribution_assumption_must_be_explicit(self):
        with self.assertRaisesRegex(ValueError, "explicit"):
            pull_metrics(0.10, 10, equal_distribution_assumed=False)


if __name__ == "__main__":
    unittest.main()

