from datetime import date, datetime, timedelta, timezone
import json
import unittest

from collectfolio_analytics.market_pipeline import (
    ObservationMapping,
    RawPriceRecord,
    SourceTerms,
    prepare_observation_batch,
)
from collectfolio_analytics.qualification import (
    PrivateQualificationConfig,
    build_private_research_evidence,
    prepare_archive_observations,
)
from collectfolio_analytics.private_sql import build_private_evidence_sql
from collectfolio_analytics.tcgcsv import TCGCSVArchiveHistory, TCGCSVArchiveSnapshot


UTC = timezone.utc
SOURCE_ID = "f24c78f8-d4b9-55a3-a8f7-b05d484c052e"
TERMS_ID = "3bc792cf-ad71-54d1-a2f6-d5d5d521fba5"
MAPPING_ID = "874f918c-8988-59f5-93ba-ff1ea961bd5a"
VARIANT_ID = "80b4934a-96db-5f4c-8641-f7c74e0eb949"
INGESTED_AT = datetime(2026, 8, 5, 21, 0, tzinfo=UTC)


def terms(**overrides) -> SourceTerms:
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
        "reviewed_at": INGESTED_AT - timedelta(hours=1),
        "expires_at": INGESTED_AT + timedelta(days=30),
    }
    values.update(overrides)
    return SourceTerms(**values)


def mapping() -> ObservationMapping:
    return ObservationMapping(
        mapping_id=MAPPING_ID,
        source_id=SOURCE_ID,
        variant_id=VARIANT_ID,
        external_product_id="590027",
        external_variant_key="holofoil",
        mapping_confidence=1,
        review_status="approved",
        mapping_version="tcgcsv-research-mapping-v1",
        finish="holofoil",
        condition_class="raw",
        language="en",
        market_condition="provider-aggregate",
    )


def archive_history(count: int = 35, *, prices: list[float] | None = None) -> TCGCSVArchiveHistory:
    end = date(2026, 8, 1)
    start = end - timedelta(days=7 * (count - 1))
    values = prices or [200 + index * 2 + (index % 3) for index in range(count)]
    snapshots = tuple(
        TCGCSVArchiveSnapshot(
            archive_date=start + timedelta(days=7 * index),
            category_id=3,
            group_id=23651,
            prices=({
                "productId": 590027,
                "subTypeName": "Holofoil",
                "marketPrice": values[index],
            },),
            artifact_hash=f"{index + 1:064x}",
            snapshot_hash=f"{index + 101:064x}",
        )
        for index in range(count)
    )
    return TCGCSVArchiveHistory(snapshots=snapshots, history_hash="a" * 64)


def config() -> PrivateQualificationConfig:
    return PrivateQualificationConfig(
        history_ingestion_run_id="10000000-0000-4000-8000-000000000001",
        trend_analytics_run_id="10000000-0000-4000-8000-000000000002",
        forecast_analytics_run_id="10000000-0000-4000-8000-000000000003",
        trend_snapshot_id="10000000-0000-4000-8000-000000000004",
        model_version_id="10000000-0000-4000-8000-000000000005",
        model_key="tcgcsv-weekly-damped-momentum",
        model_version="research-v1",
        model_family="damped_momentum_baseline",
        allowed_horizons=(7, 30),
        mapping_version="tcgcsv-research-mapping-v1",
        feature_version="weekly-trends-v1",
        code_version="collectfolio-price-intelligence-v1",
        ingested_at=INGESTED_AT,
        feature_cutoff=INGESTED_AT,
        forecast_origin=INGESTED_AT,
        model_config={"damping": 0.25, "maxAbsLogReturn": 0.7},
    )


class PrivateQualificationTests(unittest.TestCase):
    def test_private_evidence_builds_db_rows_without_public_candidate(self):
        source_terms = terms()
        approved_mapping = mapping()
        history = archive_history()
        historical = prepare_archive_observations(
            history,
            [approved_mapping],
            source_terms,
            product_ids=[590027],
            ingestion_run_id=config().history_ingestion_run_id,
            ingested_at=INGESTED_AT,
        )
        current_record = RawPriceRecord(
            external_record_id="tcgcsv:3:23651:590027:holofoil:2026-08-05",
            external_product_id="590027",
            external_variant_key="holofoil",
            price_semantics="tcgplayer_market",
            currency="USD",
            market_price=271.5,
            observed_at=INGESTED_AT - timedelta(minutes=30),
            available_at=INGESTED_AT - timedelta(minutes=30),
            quality_score=0.80,
        )
        current = prepare_observation_batch(
            [current_record],
            [approved_mapping],
            source_terms,
            {VARIANT_ID: historical.trend_observations},
            ingestion_run_id="10000000-0000-4000-8000-000000000006",
            ingested_at=INGESTED_AT,
            actor_label="tests",
        )

        evidence = build_private_research_evidence(
            history,
            historical,
            current,
            source_terms,
            config(),
        )
        packet = evidence.as_dict()

        self.assertEqual(historical.status_counts["accepted"], 35)
        self.assertEqual(packet["gateStatus"]["historicalEvidence"], "qualified")
        self.assertEqual(packet["gateStatus"]["publicPublication"], "blocked")
        self.assertEqual(packet["publicCandidateRows"], [])
        self.assertFalse(packet["forecasting"]["publicPublicationAllowed"])
        self.assertTrue(packet["forecasting"]["modelRow"]["research_only"])
        self.assertEqual(len(packet["forecasting"]["predictionRows"]), 2)
        self.assertTrue(all(
            row["prediction_status"] in {"research_only", "quarantined"}
            for row in packet["forecasting"]["predictionRows"]
        ))
        self.assertEqual(packet["sampling"]["expectedIntervalDays"], 7)
        self.assertEqual(packet["sampling"]["availabilityLagDays"], 1)
        self.assertEqual(packet["sampling"]["maxReferenceLagDays"], 7)
        json.dumps(packet)
        rehearsal_sql = build_private_evidence_sql(packet)
        commit_sql = build_private_evidence_sql(packet, commit=True)
        self.assertTrue(rehearsal_sql.startswith("begin;"))
        self.assertTrue(rehearsal_sql.endswith("rollback;\n"))
        self.assertTrue(commit_sql.endswith("commit;\n"))
        self.assertNotIn("insert into public.intelligence_publication", rehearsal_sql)

    def test_archive_preparation_uses_rolling_history_for_outliers(self):
        history = archive_history(8, prices=[100] * 7 + [1000])
        prepared = prepare_archive_observations(
            history,
            [mapping()],
            terms(),
            product_ids=[590027],
            ingestion_run_id=config().history_ingestion_run_id,
            ingested_at=INGESTED_AT,
        )

        self.assertEqual(prepared.status_counts["accepted"], 7)
        self.assertEqual(prepared.status_counts["outlier"], 1)
        self.assertEqual(prepared.prepared[-1].reason_codes, ("zero_mad_price_jump",))

    def test_expired_source_terms_block_private_qualification(self):
        source_terms = terms(
            reviewed_at=INGESTED_AT - timedelta(days=2),
            expires_at=INGESTED_AT - timedelta(days=1),
        )
        history = archive_history(1)
        empty_current = prepare_observation_batch(
            [],
            [mapping()],
            terms(),
            {},
            ingestion_run_id="10000000-0000-4000-8000-000000000006",
            ingested_at=INGESTED_AT,
            actor_label="tests",
        )
        with self.assertRaises(PermissionError):
            build_private_research_evidence(
                history,
                empty_current,
                empty_current,
                source_terms,
                config(),
            )


if __name__ == "__main__":
    unittest.main()
