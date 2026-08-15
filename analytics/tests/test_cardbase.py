from copy import deepcopy
from datetime import datetime, timezone
import unittest
from unittest.mock import patch
from typing import Mapping
from urllib.parse import parse_qs, urlparse

import collectfolio_analytics.cardbase as cardbase_module
from collectfolio_analytics.cardbase import (
    CardbaseClient,
    CardbasePayloadError,
    CardbaseRateLimitError,
    assert_cardbase_research_terms,
    build_cardbase_history_series,
    cardbase_series_key,
    parse_cardbase_snapshot,
)
from collectfolio_analytics.historical_import import HistoricalImportSeries
from collectfolio_analytics.market_pipeline import ObservationMapping, SourceTerms


UTC = timezone.utc
RETRIEVED = datetime(2026, 8, 15, 16, 30, tzinfo=UTC)
SCRYFALL_ID = "b0faa7f2-b547-42c4-a810-839da50dadfe"
OTHER_SCRYFALL_ID = "bd8fa327-dd41-4737-8f19-2cf5eb1f7cdd"
SOURCE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
TERMS_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
MAPPING_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
VARIANT_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
SERIES_KEY = "tcgplayer|normal|retail|USD"


def payload() -> dict[str, object]:
    return {
        "data": {
            "scryfall_id": SCRYFALL_ID,
            "series": [{
                "vendor": "tcgplayer",
                "finish": "normal",
                "price_type": "retail",
                "currency": "USD",
                "points": [
                    ["2026-08-13", 7600],
                    ["2026-08-14", 7700],
                    ["2026-08-15", 7700],
                ],
            }, {
                "vendor": "cardmarket",
                "finish": "normal",
                "price_type": "retail",
                "currency": "EUR",
                "points": [
                    ["2026-08-14", 38719.86],
                    ["2026-08-15", 38719.86],
                ],
            }],
        },
        "meta": {
            "as_of": "2026-08-15",
            "sources": ["scryfall", "mtgjson"],
            "history_begins": "2026-05-01",
        },
    }


def terms(**overrides: object) -> SourceTerms:
    values: dict[str, object] = {
        "source_id": SOURCE_ID,
        "terms_review_id": TERMS_ID,
        "current_terms_review_id": TERMS_ID,
        "source_code": "cardbase",
        "source_name": "Cardbase MTG price history API",
        "decision": "research_only",
        "active": True,
        "commercial_use_allowed": True,
        "catalog_metadata_allowed": True,
        "public_raw_display_allowed": False,
        "public_derived_display_allowed": False,
        "attribution_required": False,
        "attribution_text": "",
        "document_hash": "1" * 64,
        "reviewed_at": datetime(2026, 8, 15, 15, 0, tzinfo=UTC),
        "expires_at": datetime(2026, 11, 13, 15, 0, tzinfo=UTC),
    }
    values.update(overrides)
    return SourceTerms(**values)


def mapping(**overrides: object) -> ObservationMapping:
    values: dict[str, object] = {
        "mapping_id": MAPPING_ID,
        "source_id": SOURCE_ID,
        "variant_id": VARIANT_ID,
        "external_product_id": SCRYFALL_ID,
        "external_variant_key": SERIES_KEY,
        "mapping_confidence": 1,
        "review_status": "approved",
        "mapping_version": "cardbase-mtg-mapping-v1",
        "finish": "normal",
        "condition_class": "raw",
        "language": "en",
        "market_condition": "provider-aggregate",
    }
    values.update(overrides)
    return ObservationMapping(**values)


class CardbaseTests(unittest.TestCase):
    def test_default_transport_refuses_redirects_before_reusing_bearer_key(self):
        handlers: list[object] = []

        class Response:
            headers: dict[str, str] = {}

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self, _limit: int) -> bytes:
                return b'{"ok":true}'

        class Opener:
            def open(self, _request, *, timeout: float):
                self.timeout = timeout
                return Response()

        def build(*values: object) -> Opener:
            handlers.extend(values)
            return Opener()

        with patch.object(cardbase_module, "build_opener", side_effect=build):
            result = cardbase_module._default_fetch_json(
                f"https://api.cardbase.dev/v1/printings/{SCRYFALL_ID}/prices?days=30",
                {"Authorization": "Bearer cbdev_server-secret"},
                timeout_seconds=5,
            )

        self.assertEqual(result, {"ok": True})
        [redirect_handler] = handlers
        self.assertIsNone(redirect_handler.redirect_request(
            None, None, 302, "Found", {}, "https://redirect.invalid/"
        ))

    def test_fixed_origin_client_keeps_one_key_out_of_url_and_requests_full_history(self):
        calls: list[tuple[str, Mapping[str, str]]] = []

        def fetch(url: str, headers: Mapping[str, str]) -> object:
            calls.append((url, headers))
            return payload()

        snapshot = CardbaseClient(
            "cbdev_server-secret", fetch_json=fetch
        ).prices(
            SCRYFALL_ID,
            days=365,
            vendor="tcgplayer",
            finish="normal",
            price_type="retail",
            retrieved_at=RETRIEVED,
        )

        url, headers = calls[0]
        parsed = urlparse(url)
        self.assertEqual(parsed.scheme, "https")
        self.assertEqual(parsed.netloc, "api.cardbase.dev")
        self.assertEqual(
            parsed.path, f"/v1/printings/{SCRYFALL_ID}/prices"
        )
        self.assertNotIn("cbdev_server-secret", url)
        self.assertEqual(headers["Authorization"], "Bearer cbdev_server-secret")
        self.assertEqual(parse_qs(parsed.query), {
            "days": ["365"],
            "vendor": ["tcgplayer"],
            "finish": ["normal"],
            "price_type": ["retail"],
        })
        self.assertEqual(snapshot.scryfall_id, SCRYFALL_ID)

    def test_anonymous_client_refuses_silent_365_day_tier_capping(self):
        with self.assertRaisesRegex(ValueError, "cbdev_ prefix"):
            CardbaseClient("cbdev_")
        client = CardbaseClient(fetch_json=lambda _url, _headers: payload())
        with self.assertRaisesRegex(ValueError, "between 1 and 30"):
            client.prices(SCRYFALL_ID, days=365, retrieved_at=RETRIEVED)
        snapshot = client.prices(SCRYFALL_ID, days=30, retrieved_at=RETRIEVED)
        self.assertEqual(snapshot.history_begins.isoformat(), "2026-05-01")

    def test_rate_limit_waits_for_retry_after_without_rotating_credentials(self):
        calls: list[Mapping[str, str]] = []
        waits: list[float] = []

        def fetch(_url: str, headers: Mapping[str, str]) -> object:
            calls.append(headers)
            if len(calls) == 1:
                raise CardbaseRateLimitError(2.5)
            return payload()

        snapshot = CardbaseClient(
            "cbdev_one-key",
            fetch_json=fetch,
            sleep=waits.append,
            max_retries=1,
        ).prices(SCRYFALL_ID, days=365, retrieved_at=RETRIEVED)

        self.assertEqual(snapshot.scryfall_id, SCRYFALL_ID)
        self.assertEqual(waits, [2.5])
        self.assertEqual(len(calls), 2)
        self.assertEqual(
            {headers["Authorization"] for headers in calls},
            {"Bearer cbdev_one-key"},
        )

    def test_parser_preserves_exact_series_and_honest_backfill_availability(self):
        snapshot = parse_cardbase_snapshot(
            payload(), retrieved_at=RETRIEVED, expected_scryfall_id=SCRYFALL_ID
        )
        records = snapshot.raw_price_records(SERIES_KEY)

        self.assertEqual([record.market_price for record in records], [7600, 7700, 7700])
        self.assertTrue(all(record.available_at == RETRIEVED for record in records))
        self.assertEqual(
            [record.observed_at.isoformat() for record in records],
            [
                "2026-08-13T00:00:00+00:00",
                "2026-08-14T00:00:00+00:00",
                "2026-08-15T00:00:00+00:00",
            ],
        )
        self.assertTrue(all(
            record.external_product_id == SCRYFALL_ID for record in records
        ))
        self.assertTrue(all(
            record.external_variant_key == SERIES_KEY for record in records
        ))
        self.assertTrue(all(
            record.price_semantics == "cardbase-tcgplayer-retail"
            for record in records
        ))
        self.assertNotEqual(
            snapshot.series_for_key("cardmarket|normal|retail|EUR").currency,
            snapshot.series_for_key(SERIES_KEY).currency,
        )

    def test_reviewed_mapping_bridges_to_centralized_history_without_blending(self):
        snapshot = parse_cardbase_snapshot(
            payload(), retrieved_at=RETRIEVED, expected_scryfall_id=SCRYFALL_ID
        )
        [series] = build_cardbase_history_series(
            snapshot, [mapping()], available_at=RETRIEVED
        )

        self.assertIsInstance(series, HistoricalImportSeries)
        self.assertEqual(series.currency, "USD")
        self.assertEqual(series.price_semantics, "cardbase-tcgplayer-retail")
        self.assertEqual(len(series.records), 3)
        self.assertEqual(series.mapping.external_variant_key, SERIES_KEY)

        with self.assertRaisesRegex(ValueError, "provider-aggregate"):
            build_cardbase_history_series(
                snapshot,
                [mapping(market_condition="near-mint")],
                available_at=RETRIEVED,
            )
        with self.assertRaisesRegex(CardbasePayloadError, "missing exact series"):
            build_cardbase_history_series(
                snapshot,
                [mapping(external_variant_key="cardsphere|normal|retail|USD")],
                available_at=RETRIEVED,
            )

    def test_research_terms_are_current_and_fail_closed_for_public_capabilities(self):
        reviewed = terms()
        assert_cardbase_research_terms(reviewed, at=RETRIEVED)
        self.assertFalse(reviewed.permits_public_usage("raw_price", RETRIEVED))
        self.assertFalse(reviewed.permits_public_usage("derived_feature", RETRIEVED))

        with self.assertRaisesRegex(PermissionError, "not for Cardbase"):
            assert_cardbase_research_terms(
                terms(source_code="another-source"), at=RETRIEVED
            )
        with self.assertRaisesRegex(PermissionError, "predates"):
            assert_cardbase_research_terms(
                terms(
                    reviewed_at=datetime(2026, 7, 31, tzinfo=UTC),
                    expires_at=datetime(2026, 11, 1, tzinfo=UTC),
                ),
                at=RETRIEVED,
            )
        with self.assertRaisesRegex(PermissionError, "private research"):
            assert_cardbase_research_terms(
                terms(active=False), at=RETRIEVED
            )
        with self.assertRaisesRegex(PermissionError, "research-only"):
            assert_cardbase_research_terms(
                terms(decision="approved"), at=RETRIEVED
            )
        with self.assertRaisesRegex(PermissionError, "public capabilities"):
            assert_cardbase_research_terms(
                terms(public_derived_display_allowed=True), at=RETRIEVED
            )

    def test_payload_rejects_identity_time_and_series_contract_drift(self):
        with self.assertRaisesRegex(CardbasePayloadError, "does not match"):
            parse_cardbase_snapshot(
                payload(),
                retrieved_at=RETRIEVED,
                expected_scryfall_id=OTHER_SCRYFALL_ID,
            )

        future = payload()
        future["meta"]["as_of"] = "2026-08-16"
        with self.assertRaisesRegex(CardbasePayloadError, "future"):
            parse_cardbase_snapshot(
                future, retrieved_at=RETRIEVED, expected_scryfall_id=SCRYFALL_ID
            )

        duplicate = payload()
        duplicate["data"]["series"][0]["points"].append(
            deepcopy(duplicate["data"]["series"][0]["points"][0])
        )
        with self.assertRaisesRegex(CardbasePayloadError, "duplicate date"):
            parse_cardbase_snapshot(
                duplicate, retrieved_at=RETRIEVED, expected_scryfall_id=SCRYFALL_ID
            )

        unsorted = payload()
        unsorted["data"]["series"][0]["points"].reverse()
        with self.assertRaisesRegex(CardbasePayloadError, "sorted ascending"):
            parse_cardbase_snapshot(
                unsorted, retrieved_at=RETRIEVED, expected_scryfall_id=SCRYFALL_ID
            )

        unsupported = payload()
        unsupported["data"]["series"][0]["vendor"] = "unknown"
        with self.assertRaisesRegex(CardbasePayloadError, "vendor is unsupported"):
            parse_cardbase_snapshot(
                unsupported, retrieved_at=RETRIEVED,
                expected_scryfall_id=SCRYFALL_ID,
            )

    def test_series_key_requires_documented_dimensions(self):
        self.assertEqual(
            cardbase_series_key("TCGPlayer", "Normal", "Retail", "usd"),
            SERIES_KEY,
        )
        with self.assertRaisesRegex(CardbasePayloadError, "currency"):
            cardbase_series_key("tcgplayer", "normal", "retail", "dollars")


if __name__ == "__main__":
    unittest.main()
