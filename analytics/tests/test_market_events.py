import unittest
from datetime import date, datetime, timezone

from collectfolio_analytics.market_events import MarketEvent, build_event_packet, event_age_days

SET_ID = "123e4567-e89b-42d3-a456-426614174000"
NOW = datetime(2026, 8, 7, 12, 0, tzinfo=timezone.utc)


def event(**overrides):
    values = dict(
        scope="set", target_id=SET_ID, event_type="reprint",
        occurred_on=date(2026, 6, 1), title="Reprint wave announced",
        source_url="https://example.test/news",
    )
    values.update(overrides)
    return MarketEvent(**values)


class MarketEventTests(unittest.TestCase):
    def test_scope_winner_and_url_validation(self):
        with self.assertRaisesRegex(ValueError, "scope"):
            event(scope="card")
        with self.assertRaisesRegex(ValueError, "event_type"):
            event(event_type="hype")
        with self.assertRaisesRegex(ValueError, "https"):
            event(source_url="http://example.test/insecure")
        with self.assertRaisesRegex(ValueError, "announced_on"):
            event(announced_on=date(2026, 7, 1))

    def test_database_row_puts_target_in_exactly_one_scope_column(self):
        set_row = event().database_row()
        self.assertEqual(set_row["set_id"], SET_ID)
        self.assertIsNone(set_row["variant_id"])
        variant_row = event(scope="variant").database_row()
        self.assertIsNone(variant_row["set_id"])
        self.assertEqual(variant_row["variant_id"], SET_ID)

    def test_event_age_is_point_in_time(self):
        events = [event(), event(occurred_on=date(2026, 9, 1), version=2)]
        # The September event has not happened yet at an August origin.
        self.assertEqual(event_age_days(events, "reprint", date(2026, 8, 7)), 67)
        self.assertIsNone(event_age_days(events, "restock", date(2026, 8, 7)))
        self.assertIsNone(event_age_days(events, "reprint", date(2026, 5, 1)))

    def test_packet_is_deterministic_and_duplicate_safe(self):
        first = build_event_packet([event()], generated_at=NOW)
        second = build_event_packet([event()], generated_at=NOW)
        self.assertEqual(first["packet_hash"], second["packet_hash"])
        self.assertTrue(first["review_required"])
        with self.assertRaisesRegex(ValueError, "must not repeat"):
            build_event_packet([event(), event()], generated_at=NOW)


if __name__ == "__main__":
    unittest.main()
