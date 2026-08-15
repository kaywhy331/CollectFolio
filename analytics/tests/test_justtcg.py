from copy import deepcopy
from datetime import datetime, timedelta, timezone
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlparse

import collectfolio_analytics.justtcg as justtcg_module
from collectfolio_analytics.justtcg import (
    PRICE_SEMANTICS,
    JustTCGClient,
    JustTCGPayloadError,
    assert_justtcg_production_terms,
    parse_justtcg_snapshot,
    prepare_justtcg_observation_batch,
)
from collectfolio_analytics.market_pipeline import ObservationMapping, SourceTerms


UTC = timezone.utc
RETRIEVED = datetime(2026, 8, 5, 20, 0, tzinfo=UTC)
SOURCE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
TERMS_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
RUN_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
MAPPING_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
CANONICAL_VARIANT_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
CARD_UUID = "23edc8d4-b6b7-5d0c-a5fa-659040d24a7c"
NM_VARIANT_UUID = "c6bfa6f7-0b82-5011-b2ee-b572e2708a0e"
LP_VARIANT_UUID = "8b99e756-8e2d-55f0-b9ad-e4eb7ec9739c"


def epoch(value: str) -> int:
    return int(datetime.fromisoformat(value).timestamp())


def payload() -> dict[str, object]:
    return {
        "data": [{
            "id": "pokemon-battle-academy-fire-energy-22-charizard-stamped-promo",
            "uuid": CARD_UUID,
            "name": "Fire Energy (#22 Charizard Stamped)",
            "game": "Pokemon",
            "set": "battle-academy-pokemon",
            "set_name": "Battle Academy",
            "number": "22",
            "rarity": "Promo",
            "tcgplayerId": "219042",
            "variants": [{
                "id": "pokemon-battle-academy-fire-energy_near-mint_holofoil",
                "uuid": NM_VARIANT_UUID,
                "condition": "Near Mint",
                "printing": "Holofoil",
                "language": "English",
                "tcgplayerSkuId": "1234567",
                "price": 4.99,
                "lastUpdated": epoch("2026-08-05T12:00:00+00:00"),
                "priceHistory": [
                    {"p": 4.75, "t": epoch("2026-08-03T00:00:00+00:00")},
                    {"p": 4.85, "t": epoch("2026-08-04T00:00:00+00:00")},
                ],
            }, {
                "id": "pokemon-battle-academy-fire-energy_lightly-played_holofoil",
                "uuid": LP_VARIANT_UUID,
                "condition": "Lightly Played",
                "printing": "Holofoil",
                "language": "English",
                "price": 4.15,
                "lastUpdated": epoch("2026-08-05T12:00:00+00:00"),
                "priceHistory": [],
            }],
        }],
        "meta": {"total": 1},
    }


def approved_terms(**overrides: object) -> SourceTerms:
    values: dict[str, object] = {
        "source_id": SOURCE_ID,
        "terms_review_id": TERMS_ID,
        "current_terms_review_id": TERMS_ID,
        "source_code": "justtcg",
        "source_name": "JustTCG paid API",
        "decision": "approved",
        "active": True,
        "commercial_use_allowed": True,
        "catalog_metadata_allowed": True,
        "public_raw_display_allowed": True,
        "public_derived_display_allowed": True,
        "attribution_required": False,
        "attribution_text": "",
        "document_hash": "1" * 64,
        "reviewed_at": datetime(2026, 8, 5, 18, 0, tzinfo=UTC),
        "expires_at": datetime(2026, 11, 3, 18, 0, tzinfo=UTC),
    }
    values.update(overrides)
    return SourceTerms(**values)


class JustTCGTests(unittest.TestCase):
    def test_default_transport_refuses_redirects_before_sending_credentials_again(self):
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

        with patch.object(justtcg_module, "build_opener", side_effect=build):
            result = justtcg_module._default_fetch_json(
                "https://api.justtcg.com/v1/cards?cardId=one",
                {"X-API-Key": "server-secret"},
                timeout_seconds=5,
            )

        self.assertEqual(result, {"ok": True})
        [redirect_handler] = handlers
        self.assertIsNone(redirect_handler.redirect_request(
            None, None, 302, "Found", {}, "https://redirect.invalid/"
        ))

    def test_fixed_origin_client_keeps_key_out_of_url_and_filters_exact_condition(self):
        calls: list[tuple[str, dict[str, str]]] = []

        def fetch(url: str, headers: dict[str, str]) -> object:
            calls.append((url, headers))
            return payload()

        snapshot = JustTCGClient("server-secret", fetch_json=fetch).card(
            card_id=CARD_UUID,
            condition="NM",
            printing="Holofoil",
            history_duration="1y",
            retrieved_at=RETRIEVED,
        )

        url, headers = calls[0]
        parsed = urlparse(url)
        self.assertEqual(parsed.scheme, "https")
        self.assertEqual(parsed.netloc, "api.justtcg.com")
        self.assertNotIn("server-secret", url)
        self.assertEqual(headers["X-API-Key"], "server-secret")
        self.assertEqual(parse_qs(parsed.query), {
            "cardId": [CARD_UUID],
            "condition": ["NM"],
            "printing": ["Holofoil"],
            "priceHistoryDuration": ["1y"],
        })
        self.assertEqual(snapshot.card_uuid, CARD_UUID)
        self.assertEqual(len(snapshot.variants), 1)
        self.assertEqual(snapshot.variants[0].variant_uuid, NM_VARIANT_UUID)
        self.assertEqual(len(snapshot.payload_hash), 64)

    def test_history_backfill_uses_honest_retrieval_availability(self):
        snapshot = parse_justtcg_snapshot(
            payload(), retrieved_at=RETRIEVED, history_duration="1y"
        )
        records = snapshot.raw_price_records()

        self.assertEqual(len(records), 3)
        self.assertEqual([value.market_price for value in records], [4.75, 4.85, 4.99])
        self.assertTrue(all(value.available_at == RETRIEVED for value in records))
        self.assertTrue(all(value.observed_at <= value.available_at for value in records))
        self.assertTrue(all(value.price_semantics == PRICE_SEMANTICS for value in records))
        self.assertTrue(all(value.external_product_id == CARD_UUID for value in records))
        self.assertTrue(all(value.external_variant_key == NM_VARIANT_UUID for value in records))

    def test_missing_current_price_is_an_explicit_missing_observation(self):
        missing = payload()
        missing["data"][0]["variants"][0]["price"] = None
        snapshot = parse_justtcg_snapshot(
            missing, retrieved_at=RETRIEVED, history_duration="1y"
        )

        records = snapshot.raw_price_records()

        self.assertEqual([value.market_price for value in records], [4.75, 4.85, None])
        self.assertEqual(records[-1].observed_at, datetime(
            2026, 8, 5, 12, 0, tzinfo=UTC
        ))

    def test_external_identity_preserves_provider_printing_for_operator_review(self):
        snapshot = parse_justtcg_snapshot(
            payload(), retrieved_at=RETRIEVED, history_duration="1y"
        )
        [product] = snapshot.external_products(
            SOURCE_ID, canonical_set_key="set|pokemon|en|battle-academy"
        )

        self.assertEqual(product.external_product_id, CARD_UUID)
        self.assertEqual(product.external_variant_key, NM_VARIANT_UUID)
        self.assertEqual(product.finish, "holofoil")
        self.assertEqual(product.condition_class, "raw")
        self.assertEqual(product.market_condition, "near-mint")

    def test_payload_rejects_future_duplicate_and_mismatched_variants(self):
        future = payload()
        future["data"][0]["variants"][0]["lastUpdated"] = epoch(
            "2026-08-06T00:00:00+00:00"
        )
        with self.assertRaisesRegex(JustTCGPayloadError, "future"):
            parse_justtcg_snapshot(future, retrieved_at=RETRIEVED, history_duration="1y")

        duplicate = payload()
        duplicate["data"][0]["variants"][0]["priceHistory"].append(
            deepcopy(duplicate["data"][0]["variants"][0]["priceHistory"][0])
        )
        with self.assertRaisesRegex(JustTCGPayloadError, "duplicate timestamp"):
            parse_justtcg_snapshot(duplicate, retrieved_at=RETRIEVED, history_duration="1y")

        with self.assertRaisesRegex(JustTCGPayloadError, "no variant"):
            parse_justtcg_snapshot(
                payload(), retrieved_at=RETRIEVED, history_duration="1y",
                expected_condition="Damaged",
            )

        missing_timestamp = payload()
        missing_timestamp["data"][0]["variants"][0]["lastUpdated"] = None
        with self.assertRaisesRegex(JustTCGPayloadError, "missing lastUpdated"):
            parse_justtcg_snapshot(
                missing_timestamp, retrieved_at=RETRIEVED, history_duration="1y"
            )

        outside_window = payload()
        outside_window["data"][0]["variants"][0]["priceHistory"][0]["t"] = epoch(
            "2026-07-20T00:00:00+00:00"
        )
        with self.assertRaisesRegex(JustTCGPayloadError, "outside the requested duration"):
            parse_justtcg_snapshot(
                outside_window, retrieved_at=RETRIEVED, history_duration="7d"
            )

    def test_paid_current_terms_are_mandatory(self):
        assert_justtcg_production_terms(
            approved_terms(), at=RETRIEVED, paid_subscription_active=True
        )
        with self.assertRaisesRegex(PermissionError, "paid subscription"):
            assert_justtcg_production_terms(
                approved_terms(), at=RETRIEVED, paid_subscription_active=False
            )
        with self.assertRaisesRegex(PermissionError, "derived_feature"):
            assert_justtcg_production_terms(
                approved_terms(public_derived_display_allowed=False),
                at=RETRIEVED,
                paid_subscription_active=True,
            )
        with self.assertRaisesRegex(PermissionError, "predates"):
            assert_justtcg_production_terms(
                approved_terms(reviewed_at=datetime(2026, 7, 26, tzinfo=UTC)),
                at=RETRIEVED,
                paid_subscription_active=True,
            )
        with self.assertRaisesRegex(PermissionError, "not yet effective"):
            assert_justtcg_production_terms(
                approved_terms(
                    reviewed_at=RETRIEVED + timedelta(minutes=1),
                    expires_at=RETRIEVED + timedelta(days=30),
                ),
                at=RETRIEVED,
                paid_subscription_active=True,
            )
        with self.assertRaisesRegex(PermissionError, "explicit expiry"):
            assert_justtcg_production_terms(
                approved_terms(expires_at=None),
                at=RETRIEVED,
                paid_subscription_active=True,
            )

    def test_approved_mapping_prepares_licensed_observations(self):
        snapshot = parse_justtcg_snapshot(
            payload(), retrieved_at=RETRIEVED, history_duration="1y"
        )
        mapping = ObservationMapping(
            mapping_id=MAPPING_ID,
            source_id=SOURCE_ID,
            variant_id=CANONICAL_VARIANT_ID,
            external_product_id=CARD_UUID,
            external_variant_key=NM_VARIANT_UUID,
            mapping_confidence=1,
            review_status="approved",
            mapping_version="justtcg-mapping-v1",
            finish="holofoil",
            condition_class="raw",
            language="english",
            market_condition="near-mint",
        )
        batch = prepare_justtcg_observation_batch(
            snapshot,
            [mapping],
            approved_terms(),
            {},
            ingestion_run_id=RUN_ID,
            ingested_at=RETRIEVED + timedelta(minutes=1),
            paid_subscription_active=True,
        )

        self.assertEqual(batch.status_counts["accepted"], 3)
        self.assertEqual(batch.status_counts["rejected"], 0)
        self.assertTrue(all(
            row["price_semantics"] == PRICE_SEMANTICS for row in batch.database_rows
        ))
        self.assertTrue(all(
            row["available_at"] == RETRIEVED.isoformat() for row in batch.database_rows
        ))
        self.assertNotIn("market_condition", batch.database_rows[0])
        self.assertEqual(
            {row["market_condition"] for row in batch.market_series_rows}, {"near-mint"}
        )

    def test_client_requires_one_stable_lookup_and_supported_history(self):
        client = JustTCGClient("server-secret", fetch_json=lambda _url, _headers: payload())
        with self.assertRaisesRegex(ValueError, "exactly one"):
            client.card(retrieved_at=RETRIEVED)
        with self.assertRaisesRegex(ValueError, "exactly one"):
            client.card(card_id=CARD_UUID, tcgplayer_id="219042", retrieved_at=RETRIEVED)
        with self.assertRaisesRegex(ValueError, "history_duration"):
            client.card(card_id=CARD_UUID, history_duration="2y", retrieved_at=RETRIEVED)
        with self.assertRaisesRegex(ValueError, "history_duration"):
            client.card(card_id=CARD_UUID, history_duration=[], retrieved_at=RETRIEVED)

        for invalid_timeout in (True, "20", None, float("inf"), 0, 61):
            with self.subTest(timeout=invalid_timeout):
                with self.assertRaisesRegex(ValueError, "timeout_seconds"):
                    JustTCGClient(
                        "server-secret",
                        fetch_json=lambda _url, _headers: payload(),
                        timeout_seconds=invalid_timeout,
                    )


if __name__ == "__main__":
    unittest.main()
