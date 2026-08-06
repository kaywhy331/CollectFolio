from datetime import date, datetime, timedelta, timezone
import json
import unittest

from collectfolio_analytics.catalog_mapping import (
    ApprovedMapping,
    CanonicalCard,
    CanonicalSet,
    CanonicalVariant,
)
from collectfolio_analytics.market_pipeline import ObservationMapping, SourceTerms
from collectfolio_analytics.operator_cli import build_operator_packet
from collectfolio_analytics.tcgcsv import (
    ARCHIVE_AVAILABILITY_LAG_DAYS,
    ARCHIVE_INTERVAL_DAYS,
    MAX_ARCHIVE_SAMPLES,
    TCGCSVArchiveHistory,
    TCGCSVPayloadError,
    TCGCSVResearchClient,
    assert_tcgcsv_research_terms,
    build_tcgcsv_research_packet,
)


UTC = timezone.utc
UPDATED = datetime(2026, 8, 5, 20, 5, 39, tzinfo=UTC)
SOURCE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
TERMS_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
RUN_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
MAPPING_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"


def fixture_fetch(*, timestamp_after: str | None = None):
    products = {
        "success": True,
        "results": [{
            "productId": 590027,
            "name": "Pikachu ex - 238/191",
            "cleanName": "Pikachu ex 238 191",
            "extendedData": [
                {"name": "Number", "displayName": "Card Number", "value": "238/191"},
                {"name": "Rarity", "displayName": "Rarity", "value": "Special Illustration Rare"},
            ],
        }],
    }
    prices = {
        "success": True,
        "results": [{
            "productId": 590027,
            "subTypeName": "Holofoil",
            "lowPrice": 277.55,
            "midPrice": 349.99,
            "highPrice": 2808.27,
            "marketPrice": 310.79,
            "directLowPrice": 290.01,
        }],
    }
    timestamps = iter([
        "2026-08-05T20:05:39+0000",
        timestamp_after or "2026-08-05T20:05:39+0000",
    ])

    def fetch(url: str) -> str:
        if url.endswith("last-updated.txt"):
            return next(timestamps)
        if url.endswith("/products"):
            return json.dumps(products)
        if url.endswith("/prices"):
            return json.dumps(prices)
        raise AssertionError(url)

    return fetch


def fixture_archive_client(*, selected_product_id: int = 590027):
    fetched_urls: list[str] = []
    extracted_members: list[str] = []

    def fetch_archive(url: str) -> bytes:
        fetched_urls.append(url)
        return b"bounded archive fixture"

    def extract_archive_member(archive: bytes, member_path: str) -> bytes:
        assert archive == b"bounded archive fixture"
        extracted_members.append(member_path)
        return json.dumps({
            "success": True,
            "errors": [],
            "results": [{
                "productId": selected_product_id,
                "subTypeName": "Holofoil",
                "lowPrice": 274.4,
                "midPrice": 350.2,
                "highPrice": 2924.73,
                "marketPrice": 323.71,
                "directLowPrice": 294.16,
            }],
        }).encode("utf-8")

    return (
        TCGCSVResearchClient(
            fetch_archive=fetch_archive,
            extract_archive_member=extract_archive_member,
        ),
        fetched_urls,
        extracted_members,
    )


def research_terms(**overrides) -> SourceTerms:
    values = {
        "source_id": SOURCE_ID,
        "terms_review_id": TERMS_ID,
        "current_terms_review_id": TERMS_ID,
        "source_code": "tcgcsv-research",
        "source_name": "TCGCSV research archive",
        "decision": "research_only",
        "active": True,
        "commercial_use_allowed": False,
        "catalog_metadata_allowed": False,
        "public_raw_display_allowed": False,
        "public_derived_display_allowed": False,
        "attribution_required": False,
        "attribution_text": "",
        "document_hash": "1" * 64,
        "reviewed_at": UPDATED - timedelta(days=1),
        "expires_at": UPDATED + timedelta(days=30),
    }
    values.update(overrides)
    return SourceTerms(**values)


def canonical_variant() -> CanonicalVariant:
    canonical_set = CanonicalSet.build(
        game="pokemon", language="en", set_code="sv08",
        name="Surging Sparks", release_date=date(2024, 11, 8),
    )
    card = CanonicalCard.build(
        canonical_set, name="Pikachu ex", number="238/191",
        rarity="Special Illustration Rare",
    )
    return CanonicalVariant.build(card, finish="holofoil")


class TCGCSVTests(unittest.TestCase):
    def test_daily_archive_has_conservative_point_in_time_records(self):
        client, fetched_urls, extracted_members = fixture_archive_client()
        snapshot = client.price_archive(date(2026, 8, 1), 3, 23651)
        records = snapshot.raw_price_records(product_ids=[590027])

        self.assertEqual(snapshot.archive_date, date(2026, 8, 1))
        self.assertEqual(len(snapshot.artifact_hash), 64)
        self.assertEqual(len(snapshot.snapshot_hash), 64)
        self.assertEqual(records[0].market_price, 323.71)
        self.assertEqual(records[0].observed_at, datetime(2026, 8, 1, tzinfo=UTC))
        self.assertEqual(
            records[0].available_at,
            datetime(2026, 8, 1, tzinfo=UTC)
            + timedelta(days=ARCHIVE_AVAILABILITY_LAG_DAYS),
        )
        self.assertTrue(fetched_urls[0].endswith("prices-2026-08-01.ppmd.7z"))
        self.assertEqual(extracted_members, ["2026-08-01/3/23651/prices"])

    def test_weekly_archive_history_is_exact_and_bounded(self):
        client, fetched_urls, _ = fixture_archive_client()
        history = client.weekly_price_history(
            start_date=date(2026, 7, 18),
            end_date=date(2026, 8, 1),
            category_id=3,
            group_id=23651,
        )

        self.assertEqual(len(history.snapshots), 3)
        self.assertEqual(history.expected_interval_days, ARCHIVE_INTERVAL_DAYS)
        self.assertEqual(history.availability_lag_days, ARCHIVE_AVAILABILITY_LAG_DAYS)
        self.assertEqual(history.max_reference_lag_days, ARCHIVE_INTERVAL_DAYS)
        self.assertEqual(len(history.raw_price_records(product_ids=[590027])), 3)
        self.assertEqual(len(history.history_hash), 64)
        self.assertEqual(len(fetched_urls), 3)

        with self.assertRaisesRegex(ValueError, "seven-day"):
            client.weekly_price_history(
                start_date=date(2026, 7, 18),
                end_date=date(2026, 7, 19),
                category_id=3,
                group_id=23651,
            )
        with self.assertRaisesRegex(ValueError, str(MAX_ARCHIVE_SAMPLES)):
            client.weekly_price_history(
                start_date=date(2025, 7, 26),
                end_date=date(2026, 8, 1),
                category_id=3,
                group_id=23651,
            )

    def test_archive_fails_closed_when_selected_product_is_absent(self):
        client, _, _ = fixture_archive_client(selected_product_id=123)
        snapshot = client.price_archive(date(2026, 8, 1), 3, 23651)
        with self.assertRaisesRegex(TCGCSVPayloadError, "590027"):
            snapshot.raw_price_records(product_ids=[590027])

    def test_archive_overrides_must_return_binary_payloads(self):
        client = TCGCSVResearchClient(fetch_archive=lambda _url: "not bytes")
        with self.assertRaisesRegex(TCGCSVPayloadError, "return bytes"):
            client.price_archive(date(2026, 8, 1), 3, 23651)

    def test_archive_history_rejects_nonweekly_or_mixed_identity_values(self):
        client, _, _ = fixture_archive_client()
        first = client.price_archive(date(2026, 8, 1), 3, 23651)
        duplicate = client.price_archive(date(2026, 8, 1), 3, 23651)
        with self.assertRaisesRegex(ValueError, "seven-day"):
            TCGCSVArchiveHistory((first, duplicate), "a" * 64)

    def test_live_shape_builds_review_packet_but_blocks_unreviewed_observation(self):
        snapshot = TCGCSVResearchClient(fetch_text=fixture_fetch()).snapshot(3, 23651)
        variant = canonical_variant()
        packet = build_tcgcsv_research_packet(
            snapshot,
            [variant],
            research_terms(),
            canonical_set_key=variant.card.set.canonical_key,
            ingestion_run_id=RUN_ID,
            ingested_at=UPDATED + timedelta(minutes=1),
            mapping_version="tcgcsv-mapping-v1",
            product_ids=[590027],
        )

        self.assertEqual(packet.raw_record_count, 1)
        self.assertEqual(packet.catalog.mapping_candidates[0]["disposition"], "exact")
        self.assertIn(
            "initial_mapping_review_required",
            packet.catalog.mapping_candidates[0]["reason_codes"],
        )
        self.assertEqual(packet.observations.status_counts["rejected"], 1)
        self.assertEqual(packet.observations.database_rows, ())
        self.assertEqual(packet.gate_status["mapping"], "operator_review_required")
        self.assertEqual(packet.gate_status["publicPublication"], "blocked")

    def test_explicit_approved_mapping_unlocks_private_observation_only(self):
        snapshot = TCGCSVResearchClient(fetch_text=fixture_fetch()).snapshot(3, 23651)
        variant = canonical_variant()
        approved = ApprovedMapping(
            source_id=SOURCE_ID,
            external_product_id="590027",
            external_variant_key="holofoil",
            variant_id=variant.id,
            mapping_version="tcgcsv-mapping-v1",
        )
        observation_mapping = ObservationMapping(
            mapping_id=MAPPING_ID,
            source_id=SOURCE_ID,
            variant_id=variant.id,
            external_product_id="590027",
            external_variant_key="holofoil",
            mapping_confidence=1,
            review_status="approved",
            mapping_version="tcgcsv-mapping-v1",
            finish="holofoil",
            condition_class="raw",
        )
        packet = build_tcgcsv_research_packet(
            snapshot,
            [variant],
            research_terms(),
            canonical_set_key=variant.card.set.canonical_key,
            ingestion_run_id=RUN_ID,
            ingested_at=UPDATED + timedelta(minutes=1),
            mapping_version="tcgcsv-mapping-v1",
            product_ids=[590027],
            approved_mappings=[approved],
            observation_mappings=[observation_mapping],
        )

        self.assertEqual(packet.observations.status_counts["accepted"], 1)
        self.assertEqual(packet.observations.database_rows[0]["market_price"], 310.79)
        self.assertEqual(packet.observations.database_rows[0]["price_semantics"], "tcgplayer_market")
        self.assertEqual(packet.gate_status["sourceRights"], "research_only")
        self.assertEqual(packet.gate_status["publicPublication"], "blocked")

    def test_public_permissions_are_rejected_even_with_approved_decision(self):
        terms = research_terms(
            decision="approved",
            commercial_use_allowed=True,
            public_derived_display_allowed=True,
        )
        with self.assertRaises(PermissionError):
            assert_tcgcsv_research_terms(terms, UPDATED)

    def test_snapshot_change_requires_retry(self):
        client = TCGCSVResearchClient(
            fetch_text=fixture_fetch(timestamp_after="2026-08-05T20:06:39+0000")
        )
        with self.assertRaisesRegex(TCGCSVPayloadError, "changed"):
            client.snapshot(3, 23651)

    def test_operator_manifest_emits_explicit_review_and_publication_gates(self):
        variant = canonical_variant()
        manifest = {
            "mode": "research_only",
            "source": {
                "id": SOURCE_ID,
                "termsReviewId": TERMS_ID,
                "currentTermsReviewId": TERMS_ID,
                "code": "tcgcsv-research",
                "name": "TCGCSV research archive",
                "termsUrl": "https://tcgcsv.com/docs",
                "decision": "research_only",
                "active": True,
                "commercialUseAllowed": False,
                "catalogMetadataAllowed": False,
                "publicRawDisplayAllowed": False,
                "publicDerivedDisplayAllowed": False,
                "attributionRequired": False,
                "attributionText": "",
                "documentHash": "1" * 64,
                "reviewedAt": (UPDATED - timedelta(days=1)).isoformat(),
                "expiresAt": (UPDATED + timedelta(days=30)).isoformat(),
            },
            "tcgcsv": {
                "categoryId": 3,
                "groupId": 23651,
                "productIds": [590027],
                "userAgent": "CollectFolio tests",
            },
            "canonicalVariants": [{
                "game": "pokemon",
                "language": "en",
                "setCode": "sv08",
                "setName": "Surging Sparks",
                "releaseDate": "2024-11-08",
                "name": "Pikachu ex",
                "number": "238/191",
                "rarity": "Special Illustration Rare",
                "finish": "holofoil",
                "edition": "standard",
                "conditionClass": "raw",
            }],
            "ingestionRunId": RUN_ID,
            "ingestedAt": (UPDATED + timedelta(minutes=1)).isoformat(),
            "mappingVersion": "tcgcsv-mapping-v1",
        }
        packet = build_operator_packet(
            manifest,
            client=TCGCSVResearchClient(fetch_text=fixture_fetch()),
        )
        self.assertTrue(packet["operatorReviewRequired"])
        self.assertEqual(packet["gateStatus"]["sourceRights"], "research_only")
        self.assertEqual(packet["gateStatus"]["publicPublication"], "blocked")
        self.assertEqual(packet["observations"]["databaseRows"], [])

        manifest["historicalResearch"] = "intentionally not read"
        current_only = build_operator_packet(
            manifest,
            client=TCGCSVResearchClient(fetch_text=fixture_fetch()),
            include_history=False,
            execution_at=UPDATED + timedelta(hours=1),
        )
        self.assertNotIn("historicalResearch", current_only)
        self.assertEqual(
            current_only["ingestion"]["ingestedAt"],
            (UPDATED + timedelta(hours=1)).isoformat(),
        )
        self.assertEqual(
            current_only["sourcePermissionCheckedAt"],
            current_only["health"]["evaluatedAt"],
        )

        manifest["source"]["expiresAt"] = (UPDATED + timedelta(hours=2)).isoformat()
        with self.assertRaisesRegex(PermissionError, "do not permit research"):
            build_operator_packet(
                manifest,
                client=TCGCSVResearchClient(fetch_text=fixture_fetch()),
                include_history=False,
                execution_at=UPDATED + timedelta(hours=3),
            )


if __name__ == "__main__":
    unittest.main()
