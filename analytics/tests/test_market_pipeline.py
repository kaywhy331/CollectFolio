from datetime import datetime, timedelta, timezone
from math import exp
import unittest

from collectfolio_analytics.market_pipeline import (
    ObservationMapping,
    ObservationQualityPolicy,
    RawPriceRecord,
    SourceTerms,
    prepare_observation_batch,
    prepare_price_record,
)
from collectfolio_analytics.observations import PriceObservation, PriceSeriesKey


UTC = timezone.utc
NOW = datetime(2026, 8, 5, tzinfo=UTC)
SOURCE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
TERMS_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
VARIANT_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
MAPPING_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
RUN_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"


def terms(**overrides):
    values = {
        "source_id": SOURCE_ID,
        "terms_review_id": TERMS_ID,
        "current_terms_review_id": TERMS_ID,
        "source_code": "market-a",
        "source_name": "Market A",
        "decision": "approved",
        "active": True,
        "commercial_use_allowed": True,
        "catalog_metadata_allowed": True,
        "public_raw_display_allowed": True,
        "public_derived_display_allowed": True,
        "attribution_required": True,
        "attribution_text": "Market A data",
        "document_hash": "a" * 64,
        "reviewed_at": NOW - timedelta(days=1),
        "expires_at": NOW + timedelta(days=365),
    }
    values.update(overrides)
    return SourceTerms(**values)


def mapping(**overrides):
    values = {
        "mapping_id": MAPPING_ID,
        "source_id": SOURCE_ID,
        "variant_id": VARIANT_ID,
        "external_product_id": "product-1",
        "external_variant_key": "holofoil",
        "mapping_confidence": 1,
        "review_status": "approved",
        "mapping_version": "mapping-v1",
        "finish": "holofoil",
        "condition_class": "raw",
        "language": "en",
        "market_condition": "near-mint",
    }
    values.update(overrides)
    return ObservationMapping(**values)


def record(price=100, **overrides):
    values = {
        "external_record_id": "record-1",
        "external_product_id": "product-1",
        "external_variant_key": "holofoil",
        "price_semantics": "market",
        "currency": "USD",
        "market_price": price,
        "observed_at": NOW - timedelta(hours=2),
        "available_at": NOW - timedelta(hours=1),
        "quality_score": 0.9,
    }
    values.update(overrides)
    return RawPriceRecord(**values)


def history():
    key = PriceSeriesKey(
        VARIANT_ID, SOURCE_ID, "USD", "holofoil", "raw", "market", "en", "near-mint"
    )
    return [
        PriceObservation(
            key,
            NOW - timedelta(days=20 - day),
            NOW - timedelta(days=20 - day),
            100 * exp(day * 0.001),
        )
        for day in range(14)
    ]


class MarketPipelineTests(unittest.TestCase):
    def test_approved_mapping_and_research_terms_prepare_point_in_time_row(self):
        prepared = prepare_price_record(
            record(), mapping(), terms(), history(),
            ingestion_run_id=RUN_ID, ingested_at=NOW,
            actor_label="market-parser-v1",
        )
        self.assertEqual(prepared.status, "accepted")
        self.assertEqual(prepared.database_row["variant_id"], VARIANT_ID)
        self.assertEqual(prepared.database_row["terms_review_id"], TERMS_ID)
        self.assertNotIn("market_condition", prepared.database_row)
        self.assertNotIn("language", prepared.database_row)
        self.assertEqual(prepared.market_series_row["market_condition"], "near-mint")
        self.assertEqual(prepared.market_series_row["language"], "en")
        self.assertEqual(
            prepared.database_row["market_series_id"], prepared.market_series_row["id"]
        )
        self.assertIsNotNone(prepared.trend_observation)
        self.assertIsNone(prepared.quality_event)

    def test_unapproved_mapping_is_rejected_without_storing_source_price(self):
        prepared = prepare_price_record(
            record(), mapping(review_status="pending", mapping_confidence=0.99), terms(), (),
            ingestion_run_id=RUN_ID, ingested_at=NOW,
            actor_label="market-parser-v1",
        )
        self.assertEqual(prepared.status, "rejected")
        self.assertIsNone(prepared.database_row)
        self.assertEqual(prepared.quality_event["flag_code"], "mapping_not_approved")

    def test_observation_semantics_match_the_normalized_market_series(self):
        prepared = prepare_price_record(
            record(price_semantics="Market Price"), mapping(), terms(), (),
            ingestion_run_id=RUN_ID, ingested_at=NOW,
            actor_label="market-parser-v1",
        )
        self.assertEqual(prepared.database_row["price_semantics"], "market-price")
        self.assertEqual(prepared.market_series_row["price_semantics"], "market-price")
        self.assertEqual(prepared.trend_observation.key.price_semantics, "market-price")

    def test_disallowed_terms_stop_ingestion_before_a_row_is_built(self):
        with self.assertRaises(PermissionError):
            prepare_price_record(
                record(), mapping(), terms(decision="pending"), (),
                ingestion_run_id=RUN_ID, ingested_at=NOW,
                actor_label="market-parser-v1",
            )
        with self.assertRaises(PermissionError):
            prepare_price_record(
                record(), mapping(), terms(
                    reviewed_at=NOW + timedelta(minutes=1),
                    expires_at=NOW + timedelta(days=365),
                ), (),
                ingestion_run_id=RUN_ID, ingested_at=NOW,
                actor_label="market-parser-v1",
            )

    def test_missing_value_is_preserved_as_missing(self):
        prepared = prepare_price_record(
            record(None), mapping(), terms(), history(),
            ingestion_run_id=RUN_ID, ingested_at=NOW,
            actor_label="market-parser-v1",
        )
        self.assertEqual(prepared.status, "missing")
        self.assertIsNone(prepared.database_row["market_price"])
        self.assertIsNone(prepared.trend_observation)

    def test_extreme_positive_price_is_quarantined_as_outlier_not_deleted(self):
        prepared = prepare_price_record(
            record(10_000), mapping(), terms(), history(),
            ingestion_run_id=RUN_ID, ingested_at=NOW,
            actor_label="market-parser-v1",
        )
        self.assertEqual(prepared.status, "outlier")
        self.assertEqual(prepared.database_row["market_price"], 10_000)
        self.assertIsNone(prepared.trend_observation)
        self.assertIn(prepared.reason_codes[0], {"robust_price_outlier", "zero_mad_price_jump"})

    def test_outlier_history_rejects_mixed_exact_identity(self):
        wrong_key = PriceSeriesKey(VARIANT_ID, SOURCE_ID, "EUR", "holofoil", "raw", "market")
        wrong_history = [PriceObservation(wrong_key, NOW - timedelta(days=2), NOW - timedelta(days=2), 100)]
        with self.assertRaisesRegex(ValueError, "cannot mix"):
            prepare_price_record(
                record(), mapping(), terms(), wrong_history,
                ingestion_run_id=RUN_ID, ingested_at=NOW,
                actor_label="market-parser-v1",
            )

    def test_future_available_history_cannot_drive_outlier_detection(self):
        key = PriceSeriesKey(
            VARIANT_ID, SOURCE_ID, "USD", "holofoil", "raw", "market", "en", "near-mint"
        )
        future_history = [
            PriceObservation(
                key,
                NOW - timedelta(days=10 - day),
                NOW + timedelta(days=1),
                100,
            )
            for day in range(7)
        ]
        prepared = prepare_price_record(
            record(10_000), mapping(), terms(), future_history,
            ingestion_run_id=RUN_ID, ingested_at=NOW,
            actor_label="market-parser-v1",
        )
        self.assertEqual(prepared.status, "accepted")

    def test_batch_keeps_conditions_in_separate_rolling_histories(self):
        lp_mapping = mapping(
            mapping_id="ffffffff-ffff-4fff-8fff-ffffffffffff",
            external_variant_key="holofoil-lp",
            market_condition="lightly-played",
        )
        lp_record = record(
            external_record_id="record-lp",
            external_variant_key="holofoil-lp",
            market_price=30,
        )
        batch = prepare_observation_batch(
            [record(), lp_record], [mapping(), lp_mapping], terms(), {VARIANT_ID: history()},
            ingestion_run_id=RUN_ID, ingested_at=NOW, actor_label="market-parser-v1",
        )
        self.assertEqual(batch.status_counts["accepted"], 2)
        self.assertEqual(
            {item.key.market_condition for item in batch.trend_observations},
            {"near-mint", "lightly-played"},
        )

    def test_outlier_baseline_excludes_obsolete_price_regimes(self):
        obsolete_history = [
            PriceObservation(
                item.key,
                item.observed_at - timedelta(days=365),
                item.available_at - timedelta(days=365),
                item.price,
            )
            for item in history()
        ]
        prepared = prepare_price_record(
            record(500), mapping(), terms(), obsolete_history,
            ingestion_run_id=RUN_ID, ingested_at=NOW,
            actor_label="market-parser-v1",
        )
        self.assertEqual(prepared.status, "accepted")

    def test_outlier_history_window_is_validated(self):
        with self.assertRaisesRegex(ValueError, "history_window_days"):
            ObservationQualityPolicy(history_window_days=0)

    def test_batch_retains_counts_quality_events_and_stable_dataset_hash(self):
        records = [
            record(100),
            record(None, external_record_id="record-2"),
            record(100, external_record_id="record-unmapped", external_product_id="unknown"),
        ]
        first = prepare_observation_batch(
            records, [mapping()], terms(), {VARIANT_ID: history()},
            ingestion_run_id=RUN_ID, ingested_at=NOW,
            actor_label="market-parser-v1",
        )
        second = prepare_observation_batch(
            records, [mapping()], terms(), {VARIANT_ID: history()},
            ingestion_run_id=RUN_ID, ingested_at=NOW,
            actor_label="market-parser-v1",
        )
        self.assertEqual(first.status_counts["accepted"], 1)
        self.assertEqual(first.status_counts["missing"], 1)
        self.assertEqual(first.status_counts["rejected"], 1)
        self.assertEqual(len(first.database_rows), 2)
        self.assertEqual(len(first.quality_events), 2)
        self.assertEqual(first.dataset_hash, second.dataset_hash)


if __name__ == "__main__":
    unittest.main()
