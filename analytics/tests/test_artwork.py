import unittest
from datetime import datetime, timezone

from collectfolio_analytics.artwork import PairwiseVote, artwork_scores, wilson_interval

NOW = datetime(2026, 8, 7, 12, 0, tzinfo=timezone.utc)


def votes_for(winner_count, loser_count, winner="a", loser="b"):
    wins = [PairwiseVote(variant_a_id="a", variant_b_id="b", winner_variant_id=winner)] * winner_count
    losses = [PairwiseVote(variant_a_id="a", variant_b_id="b", winner_variant_id=loser)] * loser_count
    return wins + losses


class VoteValidationTests(unittest.TestCase):
    def test_self_comparison_and_foreign_winner_are_refused(self):
        with self.assertRaisesRegex(ValueError, "two different variants"):
            PairwiseVote(variant_a_id="a", variant_b_id="a", winner_variant_id="a")
        with self.assertRaisesRegex(ValueError, "one of the two compared"):
            PairwiseVote(variant_a_id="a", variant_b_id="b", winner_variant_id="c")


class WilsonTests(unittest.TestCase):
    def test_interval_brackets_the_proportion_and_narrows_with_votes(self):
        low_small, center_small, high_small = wilson_interval(6, 10)
        low_big, center_big, high_big = wilson_interval(600, 1000)
        self.assertLess(low_small, center_small)
        self.assertLess(center_small, high_small)
        self.assertLess(high_big - low_big, high_small - low_small)
        self.assertAlmostEqual(center_big, 0.6, places=2)

    def test_extremes_stay_inside_the_unit_interval(self):
        lower, _, upper = wilson_interval(0, 10)
        self.assertGreaterEqual(lower, 0.0)
        lower_all, _, upper_all = wilson_interval(10, 10)
        self.assertLessEqual(upper_all, 1.0)
        self.assertLess(lower_all, 1.0)  # uncertainty survives a perfect record
        with self.assertRaisesRegex(ValueError, "wins must be between"):
            wilson_interval(11, 10)


class ScoreTests(unittest.TestCase):
    def test_below_threshold_variants_produce_no_snapshot(self):
        rows = artwork_scores(votes_for(4, 5), calculated_at=NOW, minimum_votes=10)
        self.assertEqual(rows, ())

    def test_scores_carry_uncertainty_and_vote_counts(self):
        rows = artwork_scores(votes_for(7, 3), calculated_at=NOW, minimum_votes=10)
        self.assertEqual(len(rows), 2)
        winner = next(row for row in rows if row["variant_id"] == "a")
        loser = next(row for row in rows if row["variant_id"] == "b")
        self.assertGreater(winner["score"], loser["score"])
        self.assertLess(winner["lower_bound"], winner["score"])
        self.assertGreater(winner["upper_bound"], winner["score"])
        self.assertEqual(winner["vote_count"], 10)
        self.assertEqual(winner["model_version"], "artwork_winrate_wilson_v0")

    def test_output_is_deterministic_and_sorted(self):
        first = artwork_scores(votes_for(7, 3), calculated_at=NOW, minimum_votes=5)
        second = artwork_scores(votes_for(7, 3), calculated_at=NOW, minimum_votes=5)
        self.assertEqual(first, second)
        self.assertEqual([row["variant_id"] for row in first], ["a", "b"])

    def test_naive_timestamp_is_refused(self):
        with self.assertRaisesRegex(ValueError, "timezone-aware"):
            artwork_scores(votes_for(7, 3), calculated_at=datetime(2026, 8, 7))


if __name__ == "__main__":
    unittest.main()
