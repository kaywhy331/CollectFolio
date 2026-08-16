from datetime import datetime, timedelta, timezone
import json
import unittest
from urllib.parse import urlparse
from uuid import UUID

from collectfolio_analytics.cardbase import CardbaseClient
from collectfolio_analytics.cardbase_history import CardbaseFirstSeenLedger
from collectfolio_analytics.cardbase_history_cli import (
    MODE,
    build_cardbase_history_import,
)


UTC = timezone.utc
SOURCE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
TERMS_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
PRINTING_ONE = "b0faa7f2-b547-42c4-a810-839da50dadfe"
PRINTING_TWO = "c4300d24-1cae-4dd5-be7e-38cc677cf5bd"
MAPPING_ONE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
MAPPING_TWO = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
VARIANT_ONE = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
VARIANT_TWO = "ffffffff-ffff-4fff-8fff-ffffffffffff"
STARTED = datetime(2026, 8, 15, 16, 0, tzinfo=UTC)


def manifest() -> dict[str, object]:
    return {
        "mode": MODE,
        "source": {
            "id": SOURCE_ID,
            "termsReviewId": TERMS_ID,
            "currentTermsReviewId": TERMS_ID,
            "code": "cardbase",
            "name": "Cardbase MTG price history API",
            "decision": "research_only",
            "active": True,
            "commercialUseAllowed": True,
            "catalogMetadataAllowed": True,
            "publicRawDisplayAllowed": False,
            "publicDerivedDisplayAllowed": False,
            "attributionRequired": False,
            "attributionText": "",
            "documentHash": "1" * 64,
            "reviewedAt": "2026-08-15T15:00:00+00:00",
            "expiresAt": "2026-11-13T15:00:00+00:00",
        },
        "mappingVersion": "cardbase-mtg-mapping-v1",
        "mappingReview": {
            "decision": "approved",
            "scope": "private_research",
            "documentHash": "2" * 64,
            "reviewedAt": "2026-08-15T15:30:00+00:00",
        },
        "cardbase": {
            "historyDays": 365,
            "requestIntervalSeconds": 1.05,
            "qualityScore": 0.85,
            "printings": [{
                "scryfallId": PRINTING_ONE,
                "series": [{
                    "mappingId": MAPPING_ONE,
                    "variantId": VARIANT_ONE,
                    "vendor": "tcgplayer",
                    "finish": "normal",
                    "priceType": "retail",
                    "currency": "USD",
                    "minimumPoints": 3,
                }],
            }, {
                "scryfallId": PRINTING_TWO,
                "series": [{
                    "mappingId": MAPPING_TWO,
                    "variantId": VARIANT_TWO,
                    "vendor": "cardmarket",
                    "finish": "foil",
                    "priceType": "retail",
                    "currency": "EUR",
                    "minimumPoints": 3,
                }],
            }],
        },
        "operator": {
            "label": "cardbase-mtg-private-research",
            "parserVersion": "cardbase-api-v1",
            "codeVersion": "test-revision",
            "metadata": {"cohort": "unit-test"},
            "qualityPolicy": {
                "minimumHistory": 2,
                "historyWindowDays": 90,
            },
        },
    }


def response(printing_id: str, *, include_next_day: bool = False) -> dict[str, object]:
    if printing_id == PRINTING_ONE:
        series = {
            "vendor": "tcgplayer",
            "finish": "normal",
            "price_type": "retail",
            "currency": "USD",
            "points": [
                ["2026-08-13", 10],
                ["2026-08-14", 11],
                ["2026-08-15", 12],
            ],
        }
    else:
        series = {
            "vendor": "cardmarket",
            "finish": "foil",
            "price_type": "retail",
            "currency": "EUR",
            "points": [
                ["2026-08-13", 20],
                ["2026-08-14", 21],
                ["2026-08-15", 22],
            ],
        }
    if include_next_day:
        series["points"].append(["2026-08-16", 13 if printing_id == PRINTING_ONE else 23])
    return {
        "data": {"scryfall_id": printing_id, "series": [series]},
        "meta": {
            "as_of": "2026-08-16" if include_next_day else "2026-08-15",
            "sources": ["scryfall", "mtgjson"],
            "history_begins": "2026-05-01",
        },
    }


def client(*, authenticated: bool = True, include_next_day: bool = False) -> CardbaseClient:
    def fetch(url: str, _headers: dict[str, str]) -> object:
        printing_id = urlparse(url).path.split("/")[-2]
        return response(printing_id, include_next_day=include_next_day)

    return CardbaseClient(
        "cbdev_one-key" if authenticated else "",
        fetch_json=fetch,
        sleep=lambda _seconds: None,
    )


def clock(start: datetime):
    values = iter([
        start,
        start + timedelta(seconds=1),
        start + timedelta(seconds=2),
        start + timedelta(seconds=3),
    ])
    return lambda: next(values)


class CardbaseHistoryCLITests(unittest.TestCase):
    def test_builds_incremental_centralized_packet_with_single_key_pacing(self):
        waits: list[float] = []
        packet, ledger = build_cardbase_history_import(
            manifest(),
            client=client(),
            clock=clock(STARTED),
            sleep=waits.append,
        )

        self.assertEqual(waits, [1.05])
        self.assertEqual(packet["mode"], "operator_centralized_history")
        self.assertEqual(packet["cardbaseReceipt"]["outcome"], "new_history")
        self.assertEqual(packet["cardbaseReceipt"]["printingCount"], 2)
        self.assertEqual(packet["cardbaseReceipt"]["seriesCount"], 2)
        self.assertEqual(packet["cardbaseReceipt"]["observationCount"], 6)
        self.assertEqual(packet["cardbaseReceipt"]["responseObservationCount"], 6)
        self.assertEqual(len(packet["marketSeriesRows"]), 2)
        self.assertEqual(len(packet["observationRows"]), 6)
        self.assertEqual(len(ledger.entries), 6)
        self.assertEqual(packet["publicCandidateRows"], [])
        self.assertEqual(packet["forecastRows"], [])
        self.assertTrue(all(
            row["available_at"] == (STARTED + timedelta(seconds=3)).isoformat()
            for row in packet["observationRows"]
        ))
        self.assertEqual(
            packet["importManifestRow"]["metadata"]["cardbase"]["rateLimitStrategy"],
            "single-key-paced-retry-after",
        )
        json.dumps(packet, allow_nan=False)
        CardbaseFirstSeenLedger.from_dict(ledger.as_dict())

    def test_exact_replay_is_noop_and_next_day_adds_only_new_points(self):
        first_packet, ledger = build_cardbase_history_import(
            manifest(), client=client(), clock=clock(STARTED), sleep=lambda _seconds: None
        )
        later = STARTED + timedelta(days=1)
        replay, replay_ledger = build_cardbase_history_import(
            manifest(),
            client=client(),
            prior_ledger=ledger,
            clock=clock(later),
            sleep=lambda _seconds: None,
        )

        self.assertEqual(first_packet["cardbaseReceipt"]["observationCount"], 6)
        self.assertEqual(replay["mode"], "private_cardbase_mtg_history_noop")
        self.assertEqual(replay["cardbaseReceipt"]["outcome"], "no_change")
        self.assertEqual(replay["cardbaseReceipt"]["observationCount"], 0)
        self.assertEqual(replay_ledger, ledger)

        next_day, next_ledger = build_cardbase_history_import(
            manifest(),
            client=client(include_next_day=True),
            prior_ledger=ledger,
            clock=clock(later),
            sleep=lambda _seconds: None,
        )
        self.assertEqual(next_day["cardbaseReceipt"]["observationCount"], 2)
        self.assertEqual(next_day["cardbaseReceipt"]["responseObservationCount"], 8)
        self.assertEqual(len(next_day["observationRows"]), 2)
        self.assertEqual(len(next_ledger.entries), 8)
        self.assertTrue(all(
            row["available_at"] == (later + timedelta(seconds=3)).isoformat()
            for row in next_day["observationRows"]
        ))

    def test_requires_one_key_for_deep_history_and_rejects_rotation_contracts(self):
        with self.assertRaisesRegex(PermissionError, "one server-side API key"):
            build_cardbase_history_import(
                manifest(),
                client=client(authenticated=False),
                clock=clock(STARTED),
                sleep=lambda _seconds: None,
            )

        rotating = manifest()
        rotating["cardbase"]["apiKeys"] = ["key-one", "key-two"]
        with self.assertRaisesRegex(PermissionError, "key rotation is prohibited"):
            build_cardbase_history_import(
                rotating,
                client=client(),
                clock=clock(STARTED),
                sleep=lambda _seconds: None,
            )

    def test_fails_when_expected_series_depth_or_identity_is_missing(self):
        too_deep = manifest()
        too_deep["cardbase"]["printings"][0]["series"][0]["minimumPoints"] = 4
        with self.assertRaisesRegex(ValueError, "fewer than 4"):
            build_cardbase_history_import(
                too_deep,
                client=client(),
                clock=clock(STARTED),
                sleep=lambda _seconds: None,
            )

        wrong_finish = manifest()
        wrong_finish["cardbase"]["printings"][0]["series"][0]["finish"] = "etched"
        with self.assertRaisesRegex(Exception, "missing exact series"):
            build_cardbase_history_import(
                wrong_finish,
                client=client(),
                clock=clock(STARTED),
                sleep=lambda _seconds: None,
            )

    def test_manifest_mode_and_minimum_pacing_are_fail_closed(self):
        wrong_mode = manifest()
        wrong_mode["mode"] = "production"
        with self.assertRaisesRegex(PermissionError, "manifest mode"):
            build_cardbase_history_import(
                wrong_mode,
                client=client(),
                clock=clock(STARTED),
                sleep=lambda _seconds: None,
            )

        fast = manifest()
        fast["cardbase"]["requestIntervalSeconds"] = 0
        with self.assertRaisesRegex(ValueError, "between 1.05 and 10"):
            build_cardbase_history_import(
                fast,
                client=client(),
                clock=clock(STARTED),
                sleep=lambda _seconds: None,
            )

    def test_manifest_caps_exact_series_before_any_provider_request(self):
        oversized = manifest()
        printings = []
        next_identity = 100
        for printing_index in range(3):
            series = []
            for series_index in range(84):
                currency = (
                    chr(65 + series_index // 26)
                    + chr(65 + series_index % 26)
                    + chr(65 + printing_index)
                )
                series.append({
                    "mappingId": str(UUID(int=next_identity)),
                    "variantId": str(UUID(int=next_identity + 1_000)),
                    "vendor": "tcgplayer",
                    "finish": "normal",
                    "priceType": "retail",
                    "currency": currency,
                })
                next_identity += 1
            printings.append({
                "scryfallId": str(UUID(int=10_000 + printing_index)),
                "series": series,
            })
        oversized["cardbase"]["printings"] = printings

        calls = 0

        def fetch(_url: str, _headers: dict[str, str]) -> object:
            nonlocal calls
            calls += 1
            raise AssertionError("oversized manifest must fail before fetching")

        with self.assertRaisesRegex(ValueError, "cannot exceed 250 exact series"):
            build_cardbase_history_import(
                oversized,
                client=CardbaseClient("cbdev_one-key", fetch_json=fetch),
                clock=clock(STARTED),
                sleep=lambda _seconds: None,
            )
        self.assertEqual(calls, 0)


if __name__ == "__main__":
    unittest.main()
