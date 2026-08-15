from copy import deepcopy
from datetime import datetime, timedelta, timezone
import json
import unittest

from collectfolio_analytics.historical_import import (
    HISTORY_IMPORT_CONTRACT_VERSION,
    HISTORY_IMPORT_MODE,
    MAX_HISTORY_METADATA_BYTES,
    CentralizedHistoryImportConfig,
    HistoricalImportSeries,
    build_centralized_history_import,
)
from collectfolio_analytics.historical_import_cli import build_operator_history_import
from collectfolio_analytics.historical_import_sql import (
    build_centralized_history_import_sql,
)
from collectfolio_analytics.market_pipeline import (
    ObservationMapping,
    RawPriceRecord,
    SourceTerms,
)


UTC = timezone.utc
NOW = datetime(2026, 8, 14, 12, tzinfo=UTC)
SOURCE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
TERMS_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
VARIANT_1 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
VARIANT_2 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
MAPPING_1 = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
MAPPING_2 = "ffffffff-ffff-4fff-8fff-ffffffffffff"


def source_terms(**overrides):
    values = {
        "source_id": SOURCE_ID,
        "terms_review_id": TERMS_ID,
        "current_terms_review_id": TERMS_ID,
        "source_code": "licensed-market",
        "source_name": "Licensed Market",
        "decision": "approved",
        "active": True,
        "commercial_use_allowed": True,
        "catalog_metadata_allowed": True,
        "public_raw_display_allowed": True,
        "public_derived_display_allowed": True,
        "attribution_required": True,
        "attribution_text": "Market data from Licensed Market",
        "document_hash": "a" * 64,
        "reviewed_at": NOW - timedelta(days=30),
        "expires_at": NOW + timedelta(days=365),
    }
    values.update(overrides)
    return SourceTerms(**values)


def mapping(index=1, **overrides):
    values = {
        "mapping_id": MAPPING_1 if index == 1 else MAPPING_2,
        "source_id": SOURCE_ID,
        "variant_id": VARIANT_1 if index == 1 else VARIANT_2,
        "external_product_id": f"product-{index}",
        "external_variant_key": "holofoil",
        "mapping_confidence": 1.0,
        "review_status": "approved",
        "mapping_version": "mapping-v3",
        "finish": "holofoil",
        "condition_class": "raw",
        "language": "en",
        "market_condition": "near-mint",
    }
    values.update(overrides)
    return ObservationMapping(**values)


def records(index=1, count=4, *, available_mode="source", spike=False):
    start = NOW - timedelta(days=30)
    values = []
    for offset in range(count):
        observed = start + timedelta(days=offset)
        available = (
            NOW - timedelta(minutes=5)
            if available_mode == "first_seen"
            else observed if available_mode == "proxy"
            else observed + timedelta(hours=2)
        )
        price = 100 + index + offset
        if spike and offset == count - 1:
            price = 10_000
        values.append(RawPriceRecord(
            external_record_id=f"history-{index}-{offset}",
            external_product_id=f"product-{index}",
            external_variant_key="holofoil",
            price_semantics="market",
            currency="USD",
            market_price=price,
            observed_at=observed,
            available_at=available,
            quality_score=0.95,
        ))
    return tuple(values)


def config(**overrides):
    values = {
        "started_at": NOW - timedelta(minutes=10),
        "ingested_at": NOW - timedelta(minutes=5),
        "completed_at": NOW,
        "mapping_version": "mapping-v3",
        "parser_version": "licensed-history-parser-v1",
        "code_version": "git:123abc",
        "availability_semantics": "source_supplied",
        "operator_label": "history-import-test",
        "metadata": {"sourceBatch": "2026-08-14"},
    }
    values.update(overrides)
    return CentralizedHistoryImportConfig(**values)


def series_values():
    return (
        HistoricalImportSeries(mapping(1), "USD", "market", records(1)),
        HistoricalImportSeries(mapping(2), "USD", "market", records(2)),
    )


def packet():
    return build_centralized_history_import(
        source_terms(), series_values(), config()
    ).as_dict()


def operator_manifest():
    return {
        "mode": HISTORY_IMPORT_MODE,
        "source": {
            "id": SOURCE_ID,
            "termsReviewId": TERMS_ID,
            "currentTermsReviewId": TERMS_ID,
            "code": "licensed-market",
            "name": "Licensed Market",
            "decision": "approved",
            "active": True,
            "commercialUseAllowed": True,
            "catalogMetadataAllowed": True,
            "publicRawDisplayAllowed": True,
            "publicDerivedDisplayAllowed": True,
            "attributionRequired": True,
            "attributionText": "Market data from Licensed Market",
            "documentHash": "a" * 64,
            "reviewedAt": (NOW - timedelta(days=30)).isoformat(),
            "expiresAt": (NOW + timedelta(days=365)).isoformat(),
        },
        "approvedMappings": [{
            "mappingId": MAPPING_1,
            "externalProductId": "product-1",
            "externalVariantKey": "holofoil",
            "variantId": VARIANT_1,
            "mappingConfidence": 1,
            "finish": "holofoil",
            "conditionClass": "raw",
            "language": "en",
            "marketCondition": "near-mint",
        }],
        "historyImport": {
            "mappingVersion": "mapping-v3",
            "parserVersion": "licensed-history-parser-v1",
            "codeVersion": "git:123abc",
            "availabilitySemantics": "source_supplied",
            "operatorLabel": "history-import-test",
            "startedAt": (NOW - timedelta(minutes=10)).isoformat(),
            "ingestedAt": (NOW - timedelta(minutes=5)).isoformat(),
            "completedAt": NOW.isoformat(),
            "metadata": {"sourceBatch": "2026-08-14"},
            "series": [{
                "mappingId": MAPPING_1,
                "currency": "USD",
                "priceSemantics": "market",
                "records": [{
                    "externalRecordId": item.external_record_id,
                    "marketPrice": item.market_price,
                    "observedAt": item.observed_at.isoformat(),
                    "availableAt": item.available_at.isoformat(),
                    "qualityScore": item.quality_score,
                } for item in records(1)],
            }],
        },
    }


class CentralizedHistoryImportTests(unittest.TestCase):
    def test_builds_deterministic_multi_series_packet_without_public_outputs(self):
        first = packet()
        second = build_centralized_history_import(
            source_terms(), reversed(series_values()), config()
        ).as_dict()

        self.assertEqual(first, second)
        self.assertEqual(first["contractVersion"], HISTORY_IMPORT_CONTRACT_VERSION)
        self.assertEqual(len(first["marketSeriesRows"]), 2)
        self.assertEqual(len(first["observationRows"]), 8)
        self.assertEqual(len(first["observationMembershipRows"]), 8)
        self.assertEqual(first["publicCandidateRows"], [])
        self.assertEqual(first["forecastRows"], [])
        self.assertTrue(first["pointInTimeEligible"])
        self.assertEqual(
            first["importManifestRow"]["expected_accepted_count"], 8
        )
        self.assertEqual(first["ingestionRunRow"]["status"], "succeeded")

    def test_outlier_is_stored_and_sealed_but_not_counted_as_accepted(self):
        values = HistoricalImportSeries(
            mapping(1), "USD", "market", records(1, count=8, spike=True)
        )
        result = build_centralized_history_import(
            source_terms(), (values,), config()
        ).as_dict()

        self.assertEqual(result["ingestionRunRow"]["status"], "partial")
        self.assertEqual(result["ingestionRunRow"]["records_quarantined"], 1)
        self.assertEqual(result["importManifestRow"]["expected_accepted_count"], 7)
        self.assertEqual(result["observationRows"][-1]["observation_status"], "outlier")
        self.assertEqual(len(result["qualityEventRows"]), 1)

    def test_availability_semantics_are_explicit_without_blocking_private_storage(self):
        proxy = HistoricalImportSeries(
            mapping(1), "USD", "market", records(1, available_mode="proxy")
        )
        result = build_centralized_history_import(
            source_terms(), (proxy,), config(availability_semantics="observed_at_proxy")
        ).as_dict()
        self.assertFalse(result["pointInTimeEligible"])
        self.assertFalse(result["importManifestRow"]["point_in_time_eligible"])

        with self.assertRaisesRegex(ValueError, "observed_at_proxy"):
            build_centralized_history_import(
                source_terms(), series_values(),
                config(availability_semantics="observed_at_proxy"),
            )

        first_seen = HistoricalImportSeries(
            mapping(1), "USD", "market", records(1, available_mode="first_seen")
        )
        result = build_centralized_history_import(
            source_terms(), (first_seen,),
            config(availability_semantics="operator_first_seen"),
        ).as_dict()
        self.assertTrue(result["pointInTimeEligible"])

    def test_metadata_requires_strict_finite_json_before_sql_rendering(self):
        with self.assertRaisesRegex(ValueError, "strict finite JSON"):
            config(metadata={"notJson": float("nan")})
        with self.assertRaisesRegex(ValueError, "keys must be strings"):
            config(metadata={1: "not-a-json-object-key"})

        tampered = packet()
        tampered["importManifestRow"]["metadata"]["notJson"] = float("inf")
        with self.assertRaisesRegex(ValueError, "strict finite JSON"):
            build_centralized_history_import_sql(tampered)

    def test_metadata_limit_matches_final_postgresql_jsonb_rendering(self):
        compact_only_fit = {f"k{index}": 0 for index in range(1_458)}
        self.assertLess(
            len(json.dumps(compact_only_fit, separators=(",", ":")).encode("utf-8")),
            MAX_HISTORY_METADATA_BYTES,
        )
        self.assertGreater(
            len(json.dumps(compact_only_fit).encode("utf-8")),
            MAX_HISTORY_METADATA_BYTES,
        )
        with self.assertRaisesRegex(ValueError, "PostgreSQL JSONB rendering"):
            config(metadata=compact_only_fit)

        empty_padding_size = len(json.dumps({"padding": ""}).encode("utf-8"))
        boundary_config = config(metadata={
            "padding": "x" * (MAX_HISTORY_METADATA_BYTES - empty_padding_size),
        })
        with self.assertRaisesRegex(ValueError, "manifest metadata.*PostgreSQL JSONB"):
            build_centralized_history_import(
                source_terms(), series_values(), boundary_config
            )

        oversized_packet = packet()
        oversized_packet["importManifestRow"]["metadata"] = compact_only_fit
        with self.assertRaisesRegex(ValueError, "manifest metadata.*PostgreSQL JSONB"):
            build_centralized_history_import_sql(oversized_packet)

    def test_rejects_duplicate_series_and_duplicate_records(self):
        value = series_values()[0]
        with self.assertRaisesRegex(ValueError, "duplicate exact"):
            build_centralized_history_import(
                source_terms(), (value, value), config()
            )
        duplicated = HistoricalImportSeries(
            mapping(1), "USD", "market", (records(1)[0], records(1)[0])
        )
        with self.assertRaisesRegex(ValueError, "duplicate source-record"):
            build_centralized_history_import(
                source_terms(), (duplicated,), config()
            )

    def test_operator_manifest_compiles_to_same_bounded_contract(self):
        result = build_operator_history_import(operator_manifest())
        self.assertEqual(result["mode"], HISTORY_IMPORT_MODE)
        self.assertEqual(len(result["marketSeriesRows"]), 1)
        self.assertEqual(len(result["observationRows"]), 4)
        self.assertEqual(len(result["observationMembershipRows"]), 4)


class CentralizedHistorySQLTests(unittest.TestCase):
    def test_sql_defaults_to_rollback_and_has_exact_replay_membership(self):
        rehearsal = build_centralized_history_import_sql(packet())
        committed = build_centralized_history_import_sql(packet(), commit=True)

        self.assertTrue(rehearsal.startswith("begin;"))
        self.assertTrue(rehearsal.endswith("rollback;\n"))
        self.assertTrue(committed.endswith("commit;\n"))
        for table in (
            "source_ingestion_runs",
            "market_series",
            "price_observations",
            "centralized_historical_price_import_observations",
            "centralized_historical_price_imports",
        ):
            self.assertIn(f"insert into public.{table}", rehearsal)
        self.assertIn("observation overlap is not an exact immutable replay", rehearsal)
        self.assertIn("on conflict (id) do nothing", rehearsal)
        self.assertIn("on conflict (import_id, observation_id) do nothing", rehearsal)
        self.assertIn("on conflict (event_hash) do nothing", rehearsal)
        self.assertIn("source_available_at", rehearsal)
        self.assertIn("collectfolio_first_seen_at", rehearsal)
        self.assertIn("public_price_intelligence must remain disabled", rehearsal)
        self.assertNotIn("insert into public.card_forecast_predictions", rehearsal)
        self.assertNotIn("insert into public.card_intelligence_publications", rehearsal)

    def test_sql_rejects_price_hash_membership_and_semantics_tampering(self):
        price = deepcopy(packet())
        price["observationRows"][0]["market_price"] += 1
        with self.assertRaisesRegex(ValueError, "source-record hash"):
            build_centralized_history_import_sql(price)

        membership = deepcopy(packet())
        membership["observationMembershipRows"].pop()
        with self.assertRaisesRegex(ValueError, "membership"):
            build_centralized_history_import_sql(membership)

        semantics = deepcopy(packet())
        semantics["importManifestRow"]["availability_semantics"] = "observed_at_proxy"
        semantics["importManifestRow"]["point_in_time_eligible"] = False
        with self.assertRaisesRegex(ValueError, "metadata"):
            build_centralized_history_import_sql(semantics)

    def test_sql_rejects_public_payloads_and_non_operator_mode(self):
        public = deepcopy(packet())
        public["publicCandidateRows"] = [{"unsafe": True}]
        with self.assertRaises(PermissionError):
            build_centralized_history_import_sql(public)

        wrong_mode = deepcopy(packet())
        wrong_mode["mode"] = "research_only"
        with self.assertRaises(PermissionError):
            build_centralized_history_import_sql(wrong_mode)


if __name__ == "__main__":
    unittest.main()
