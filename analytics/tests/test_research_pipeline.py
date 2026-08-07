from datetime import date, datetime, timedelta, timezone
from math import exp
import unittest

from collectfolio_analytics.catalog_mapping import (
    CanonicalCard,
    CanonicalSet,
    CanonicalVariant,
    ExternalProduct,
    build_catalog_ingestion_packet,
)
from collectfolio_analytics.evaluation import ResearchLineage
from collectfolio_analytics.market_pipeline import (
    ObservationMapping,
    RawPriceRecord,
    SourceTerms,
    prepare_observation_batch,
)
from collectfolio_analytics.publication import PublicationLineage, build_descriptive_candidate
from collectfolio_analytics.trends import build_trend_snapshot


UTC = timezone.utc
NOW = datetime(2026, 8, 5, tzinfo=UTC)
SOURCE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
TERMS_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
INGESTION_RUN_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
MAPPING_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
ANALYTICS_RUN_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"


class ResearchPipelineTests(unittest.TestCase):
    def test_exact_catalog_to_reviewable_tier_two_packet(self):
        canonical_set = CanonicalSet.build(
            game="pokemon", language="en", set_code="sv08",
            name="Surging Sparks", release_date=date(2024, 11, 8),
        )
        card = CanonicalCard.build(canonical_set, name="Pikachu ex", number="238/191")
        variant = CanonicalVariant.build(card, finish="holofoil")
        product = ExternalProduct(
            source_id=SOURCE_ID,
            external_product_id="product-238",
            external_variant_key="holofoil",
            game="pokemon",
            language="en",
            canonical_set_key=canonical_set.canonical_key,
            name="Pikachu ex",
            number="238/191",
            edition="standard",
            finish="holofoil",
        )
        catalog_packet = build_catalog_ingestion_packet(
            [variant], [product],
            ingestion_run_id=INGESTION_RUN_ID,
            terms_review_id=TERMS_ID,
            mapping_version="mapping-v1",
        )
        self.assertEqual(catalog_packet.mapping_candidates[0]["disposition"], "exact")
        self.assertIn(
            "initial_mapping_review_required",
            catalog_packet.mapping_candidates[0]["reason_codes"],
        )

        source_terms = SourceTerms(
            source_id=SOURCE_ID,
            terms_review_id=TERMS_ID,
            current_terms_review_id=TERMS_ID,
            source_code="approved-market",
            source_name="Approved Market",
            decision="approved",
            active=True,
            commercial_use_allowed=True,
            catalog_metadata_allowed=True,
            public_raw_display_allowed=True,
            public_derived_display_allowed=True,
            attribution_required=True,
            attribution_text="Approved Market data",
            document_hash="1" * 64,
            reviewed_at=NOW - timedelta(days=30),
            expires_at=NOW + timedelta(days=365),
        )
        approved_mapping = ObservationMapping(
            mapping_id=MAPPING_ID,
            source_id=SOURCE_ID,
            variant_id=variant.id,
            external_product_id=product.external_product_id,
            external_variant_key=product.external_variant_key,
            mapping_confidence=1,
            review_status="approved",
            mapping_version="mapping-v1",
            finish="holofoil",
            condition_class="raw",
        )
        start = NOW - timedelta(days=99)
        records = [
            RawPriceRecord(
                external_record_id=f"record-{day:03d}",
                external_product_id=product.external_product_id,
                external_variant_key=product.external_variant_key,
                price_semantics="market",
                currency="USD",
                market_price=100 * exp(day * 0.003),
                observed_at=start + timedelta(days=day),
                available_at=start + timedelta(days=day),
                quality_score=0.95,
            )
            for day in range(100)
        ]
        observation_packet = prepare_observation_batch(
            records,
            [approved_mapping],
            source_terms,
            {},
            ingestion_run_id=INGESTION_RUN_ID,
            ingested_at=NOW,
            actor_label="approved-market-parser-v1",
        )
        self.assertEqual(observation_packet.status_counts["accepted"], 100)
        self.assertEqual(len(observation_packet.trend_observations), 100)

        trend = build_trend_snapshot(observation_packet.trend_observations, NOW)
        research_lineage = ResearchLineage(
            dataset_sha256=observation_packet.dataset_hash,
            code_version="git:abc123",
            feature_version="descriptive-trends-v1",
            mapping_version="mapping-v1",
            model_version="not-applicable-descriptive",
        )
        publication = build_descriptive_candidate(
            trend,
            approved_mapping,
            research_lineage,
            [
                PublicationLineage(source_terms, "catalog"),
                PublicationLineage(source_terms, "derived_feature"),
                PublicationLineage(source_terms, "raw_price"),
            ],
            analytics_run_id=ANALYTICS_RUN_ID,
            built_at=NOW,
            include_observed=True,
        )
        self.assertEqual(publication.candidate_row["support_tier"], 2)
        self.assertEqual(publication.candidate_row["publication_status"], "published")
        self.assertEqual(publication.candidate_row["catalog_variant_id"], variant.id)
        self.assertEqual(publication.trend_snapshot_row["trend_state"], "strong_rise")
        self.assertEqual(publication.candidate_row["payload"]["trend"]["status"], "strong_rise")
        self.assertNotIn("forecasts", publication.candidate_row["payload"])


if __name__ == "__main__":
    unittest.main()

