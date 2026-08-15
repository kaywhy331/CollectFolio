from datetime import datetime, timedelta, timezone
import unittest

from collectfolio_analytics.observations import (
    PriceObservation,
    PriceSeriesKey,
    point_in_time_series,
)


UTC = timezone.utc
START = datetime(2026, 1, 1, tzinfo=UTC)
KEY = PriceSeriesKey(
    canonical_variant_id="11111111-1111-4111-8111-111111111111",
    source_id="approved-market-source",
    currency="usd",
    finish="Holo",
    condition_class="Raw",
    price_semantics="Market",
    language="EN",
    market_condition="Near_Mint",
)


def observation(day, price, *, available_day=None, key=KEY, source_id=None):
    observed_at = START + timedelta(days=day)
    available_at = START + timedelta(days=day if available_day is None else available_day)
    return PriceObservation(
        key=key,
        observed_at=observed_at,
        available_at=available_at,
        price=price,
        source_observation_id=source_id,
    )


class ObservationTests(unittest.TestCase):
    def test_series_key_normalizes_exact_identity(self):
        self.assertEqual(KEY.currency, "USD")
        self.assertEqual(KEY.finish, "holo")
        self.assertEqual(KEY.condition_class, "raw")
        self.assertEqual(KEY.language, "en")
        self.assertEqual(KEY.market_condition, "near-mint")

    def test_observation_requires_aware_times_and_positive_price(self):
        with self.assertRaisesRegex(ValueError, "timezone-aware"):
            PriceObservation(KEY, datetime(2026, 1, 1), START, 10)
        with self.assertRaisesRegex(ValueError, "positive"):
            PriceObservation(KEY, START, START, 0)
        with self.assertRaisesRegex(ValueError, "cannot precede"):
            PriceObservation(KEY, START, START - timedelta(seconds=1), 10)

    def test_point_in_time_excludes_future_and_late_revisions(self):
        values = [
            observation(0, 10, source_id="original"),
            observation(0, 99, available_day=3, source_id="late-revision"),
            observation(1, 11),
            observation(4, 14),
        ]
        selected = point_in_time_series(values, START + timedelta(days=2))
        self.assertEqual([item.price for item in selected], [10, 11])

    def test_latest_revision_known_at_cutoff_wins(self):
        values = [
            observation(0, 10, source_id="a"),
            observation(0, 12, available_day=1, source_id="b"),
        ]
        selected = point_in_time_series(values, START + timedelta(days=2))
        self.assertEqual(selected[0].price, 12)

    def test_mixed_identity_requires_explicit_selection(self):
        second_key = PriceSeriesKey(
            "22222222-2222-4222-8222-222222222222",
            "approved-market-source",
            "USD",
            "holo",
            "raw",
            "market",
        )
        values = [observation(0, 10), observation(0, 20, key=second_key)]
        with self.assertRaisesRegex(ValueError, "mixed"):
            point_in_time_series(values, START + timedelta(days=1))
        selected = point_in_time_series(values, START + timedelta(days=1), key=second_key)
        self.assertEqual([item.price for item in selected], [20])

    def test_exact_identity_separates_market_condition_and_language(self):
        lightly_played = PriceSeriesKey(
            KEY.canonical_variant_id, KEY.source_id, KEY.currency, KEY.finish,
            KEY.condition_class, KEY.price_semantics, KEY.language, "lightly-played",
        )
        japanese = PriceSeriesKey(
            KEY.canonical_variant_id, KEY.source_id, KEY.currency, KEY.finish,
            KEY.condition_class, KEY.price_semantics, "ja", KEY.market_condition,
        )
        self.assertNotEqual(KEY, lightly_played)
        self.assertNotEqual(KEY, japanese)
        self.assertEqual(len(KEY.exact_identity), 8)


if __name__ == "__main__":
    unittest.main()
