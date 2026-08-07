import unittest
from datetime import date, datetime, timezone

from collectfolio_analytics.pull_rates import (
    PullRateSource,
    SetPullRateEntry,
    build_pull_rate_packet,
    entry_from_mapping,
)

SET_ID = "123e4567-e89b-42d3-a456-426614174000"
GENERATED_AT = datetime(2026, 8, 7, 12, 0, tzinfo=timezone.utc)


def source(**overrides):
    values = dict(
        publisher="TCGplayer Infinite",
        title="Phantasmal Flames Pull Rates",
        url="https://example.test/pull-rates",
        retrieved_at=GENERATED_AT,
        sample_size=4000,
        confidence_grade="medium",
        published_at=date(2026, 7, 1),
    )
    values.update(overrides)
    return PullRateSource(**values)


def entry(**overrides):
    values = dict(
        set_id=SET_ID,
        rarity_slot="special-illustration-rare",
        probability=0.10,
        one_in_packs=10.0,
        effective_from=date(2026, 7, 1),
        ci_lower=0.08,
        ci_upper=0.12,
        eligible_count=10,
        equal_distribution_assumed=True,
    )
    values.update(overrides)
    return SetPullRateEntry(**values)


class SourceTests(unittest.TestCase):
    def test_http_url_and_bad_grade_are_refused(self):
        with self.assertRaisesRegex(ValueError, "https"):
            source(url="http://example.test/insecure")
        with self.assertRaisesRegex(ValueError, "confidence_grade"):
            source(confidence_grade="excellent")

    def test_source_id_is_deterministic(self):
        self.assertEqual(source().id, source().id)


class EntryValidationTests(unittest.TestCase):
    def test_one_in_packs_must_agree_with_probability(self):
        with self.assertRaisesRegex(ValueError, "disagrees with probability"):
            entry(one_in_packs=20.0)

    def test_rounded_one_in_packs_within_tolerance_passes(self):
        self.assertEqual(entry(probability=0.0834, one_in_packs=12.0).probability, 0.0834)

    def test_confidence_interval_must_bracket_the_estimate(self):
        with self.assertRaisesRegex(ValueError, "bracket the probability from below"):
            entry(ci_lower=0.11)
        with self.assertRaisesRegex(ValueError, "provided together"):
            entry(ci_upper=None)

    def test_specific_probability_requires_explicit_equal_distribution(self):
        with self.assertRaisesRegex(ValueError, "equal-distribution acknowledgment"):
            entry(equal_distribution_assumed=False)

    def test_specific_scarcity_matches_prd_formulas(self):
        row = entry().database_row(source())
        self.assertAlmostEqual(row["specific_probability"], 0.01)
        self.assertAlmostEqual(row["specific_one_in_packs"], 100.0)

    def test_rarity_only_entry_omits_specific_fields(self):
        row = entry(eligible_count=None, equal_distribution_assumed=False).database_row(source())
        self.assertIsNone(row["specific_probability"])
        self.assertIsNone(row["specific_one_in_packs"])

    def test_effective_window_must_be_ordered(self):
        with self.assertRaisesRegex(ValueError, "after effective_from"):
            entry(effective_to=date(2026, 6, 1))


class PacketTests(unittest.TestCase):
    def test_packet_is_deterministic_review_gated_and_duplicate_safe(self):
        first = build_pull_rate_packet(source(), [entry()], generated_at=GENERATED_AT)
        second = build_pull_rate_packet(source(), [entry()], generated_at=GENERATED_AT)
        self.assertEqual(first["packet_hash"], second["packet_hash"])
        self.assertTrue(first["review_required"])
        self.assertEqual(first["public_display_candidates"], [])
        with self.assertRaisesRegex(ValueError, "must not repeat"):
            build_pull_rate_packet(source(), [entry(), entry()], generated_at=GENERATED_AT)

    def test_curated_json_round_trip(self):
        parsed = entry_from_mapping({
            "set_id": SET_ID,
            "rarity_slot": "special-illustration-rare",
            "probability": 0.10,
            "one_in_packs": 10,
            "effective_from": "2026-07-01",
            "ci_lower": 0.08,
            "ci_upper": 0.12,
            "eligible_count": 10,
            "equal_distribution_assumed": True,
        })
        self.assertEqual(parsed.database_row(source())["version"], 1)


if __name__ == "__main__":
    unittest.main()
