from copy import deepcopy
from datetime import datetime, timedelta, timezone
import unittest

from collectfolio_analytics.cardbase import parse_cardbase_snapshot
from collectfolio_analytics.cardbase_history import (
    CardbaseFirstSeenEntry,
    CardbaseFirstSeenLedger,
    LEDGER_CONTRACT_VERSION,
)


UTC = timezone.utc
SCRYFALL_ID = "b0faa7f2-b547-42c4-a810-839da50dadfe"
SERIES_KEY = "tcgplayer|normal|retail|USD"
FIRST_SEEN = datetime(2026, 8, 15, 16, 30, tzinfo=UTC)


def snapshot_payload(price: float = 7700) -> dict[str, object]:
    return {
        "data": {
            "scryfall_id": SCRYFALL_ID,
            "series": [{
                "vendor": "tcgplayer",
                "finish": "normal",
                "price_type": "retail",
                "currency": "USD",
                "points": [["2026-08-15", price]],
            }],
        },
        "meta": {
            "as_of": "2026-08-15",
            "sources": ["scryfall", "mtgjson"],
            "history_begins": "2026-05-01",
        },
    }


def records(price: float = 7700, retrieved_at: datetime = FIRST_SEEN):
    snapshot = parse_cardbase_snapshot(
        snapshot_payload(price),
        retrieved_at=retrieved_at,
        expected_scryfall_id=SCRYFALL_ID,
    )
    return snapshot.raw_price_records(SERIES_KEY)


class CardbaseFirstSeenLedgerTests(unittest.TestCase):
    def test_replay_reuses_original_availability_and_round_trips_hash(self):
        initial, ledger = CardbaseFirstSeenLedger().reconcile(
            records(), first_seen_at=FIRST_SEEN
        )
        replay_at = FIRST_SEEN + timedelta(days=1)
        replay, updated = ledger.reconcile(
            records(retrieved_at=replay_at), first_seen_at=replay_at
        )

        self.assertEqual(initial[0].available_at, FIRST_SEEN)
        self.assertEqual(replay[0].available_at, FIRST_SEEN)
        self.assertEqual(initial[0].source_record_hash, replay[0].source_record_hash)
        self.assertEqual(updated, ledger)
        self.assertEqual(
            CardbaseFirstSeenLedger.from_dict(ledger.as_dict()), ledger
        )
        self.assertEqual(ledger.as_dict()["contractVersion"], LEDGER_CONTRACT_VERSION)

    def test_provider_revision_gets_a_distinct_record_and_new_first_seen_time(self):
        original, ledger = CardbaseFirstSeenLedger().reconcile(
            records(7700), first_seen_at=FIRST_SEEN
        )
        correction_at = FIRST_SEEN + timedelta(days=1)
        corrected, updated = ledger.reconcile(
            records(7750, retrieved_at=correction_at), first_seen_at=correction_at
        )

        self.assertNotEqual(
            original[0].external_record_id, corrected[0].external_record_id
        )
        self.assertEqual(corrected[0].available_at, correction_at)
        self.assertEqual(len(updated.entries), 2)

    def test_ledger_rejects_tampering_and_future_availability(self):
        _initial, ledger = CardbaseFirstSeenLedger().reconcile(
            records(), first_seen_at=FIRST_SEEN
        )
        tampered = deepcopy(ledger.as_dict())
        tampered["entries"][0]["identitySha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "hash does not match"):
            CardbaseFirstSeenLedger.from_dict(tampered)

        wrong_count = deepcopy(ledger.as_dict())
        wrong_count["recordCount"] = 0
        with self.assertRaisesRegex(ValueError, "recordCount is invalid"):
            CardbaseFirstSeenLedger.from_dict(wrong_count)

        future_ledger = CardbaseFirstSeenLedger((
            CardbaseFirstSeenEntry(
                external_record_id=ledger.entries[0].external_record_id,
                identity_sha256=ledger.entries[0].identity_sha256,
                available_at=FIRST_SEEN + timedelta(days=2),
            ),
        ))
        with self.assertRaisesRegex(ValueError, "outside valid bounds"):
            future_ledger.reconcile(
                records(retrieved_at=FIRST_SEEN + timedelta(days=1)),
                first_seen_at=FIRST_SEEN + timedelta(days=1),
            )


if __name__ == "__main__":
    unittest.main()
