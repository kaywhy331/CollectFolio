from datetime import datetime, timedelta, timezone
from math import exp
import unittest

from collectfolio_analytics.evaluation import ResearchLineage
from collectfolio_analytics.market_pipeline import ObservationMapping, SourceTerms
from collectfolio_analytics.observations import PriceObservation, PriceSeriesKey
from collectfolio_analytics.publication import PublicationLineage, build_descriptive_candidate
from collectfolio_analytics.trends import build_trend_snapshot


UTC = timezone.utc
NOW = datetime(2026, 8, 5, tzinfo=UTC)
SOURCE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
TERMS_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
VARIANT_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
MAPPING_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
RUN_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"


def source_terms(**overrides):
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
        "reviewed_at": NOW - timedelta(days=30),
        "expires_at": NOW + timedelta(days=365),
    }
    values.update(overrides)
    return SourceTerms(**values)


def approved_mapping(**overrides):
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
    }
    values.update(overrides)
    return ObservationMapping(**values)


def research_lineage():
    return ResearchLineage(
        dataset_sha256="f" * 64,
        code_version="git:abc123",
        feature_version="descriptive-trends-v1",
        mapping_version="mapping-v1",
        model_version="not-applicable-descriptive",
    )


def trend_snapshot(days=100):
    key = PriceSeriesKey(VARIANT_ID, SOURCE_ID, "USD", "holofoil", "raw", "market")
    start = NOW - timedelta(days=days - 1)
    observations = [
        PriceObservation(
            key,
            start + timedelta(days=day),
            start + timedelta(days=day),
            100 * exp(day * 0.005),
            quality=0.95,
        )
        for day in range(days)
    ]
    return build_trend_snapshot(observations, NOW)


class PublicationTests(unittest.TestCase):
    def test_descriptive_candidate_matches_browser_contract_without_model_keys(self):
        terms = source_terms()
        packet = build_descriptive_candidate(
            trend_snapshot(), approved_mapping(), research_lineage(),
            [
                PublicationLineage(terms, "catalog"),
                PublicationLineage(terms, "derived_feature"),
                PublicationLineage(terms, "raw_price"),
            ],
            analytics_run_id=RUN_ID,
            built_at=NOW,
            include_observed=True,
        )
        candidate = packet.candidate_row
        self.assertEqual(candidate["support_tier"], 2)
        self.assertEqual(candidate["publication_status"], "published")
        self.assertIn("observed", candidate["payload"])
        self.assertIn("trend", candidate["payload"])
        self.assertNotIn("fairValue", candidate["payload"])
        self.assertNotIn("forecasts", candidate["payload"])
        self.assertEqual(len(packet.candidate_source_rows), 3)

    def test_derived_only_candidate_withholds_observed_price(self):
        terms = source_terms(public_raw_display_allowed=False)
        packet = build_descriptive_candidate(
            trend_snapshot(), approved_mapping(), research_lineage(),
            [PublicationLineage(terms, "catalog"), PublicationLineage(terms, "derived_feature")],
            analytics_run_id=RUN_ID,
            built_at=NOW,
        )
        self.assertNotIn("observed", packet.candidate_row["payload"])
        self.assertIn("observed_price_withheld", packet.candidate_row["reason_codes"])

    def test_observed_price_requires_raw_lineage_and_permission(self):
        terms = source_terms()
        with self.assertRaisesRegex(PermissionError, "raw-price"):
            build_descriptive_candidate(
                trend_snapshot(), approved_mapping(), research_lineage(),
                [PublicationLineage(terms, "catalog"), PublicationLineage(terms, "derived_feature")],
                analytics_run_id=RUN_ID,
                built_at=NOW,
                include_observed=True,
            )

    def test_research_only_terms_cannot_build_public_candidate(self):
        restricted = source_terms(
            decision="research_only",
            commercial_use_allowed=False,
            public_raw_display_allowed=False,
            public_derived_display_allowed=False,
        )
        with self.assertRaisesRegex(PermissionError, "deny"):
            build_descriptive_candidate(
                trend_snapshot(), approved_mapping(), research_lineage(),
                [PublicationLineage(restricted, "catalog"), PublicationLineage(restricted, "derived_feature")],
                analytics_run_id=RUN_ID,
                built_at=NOW,
            )

    def test_mapping_version_must_match_snapshot_lineage(self):
        terms = source_terms()
        with self.assertRaisesRegex(ValueError, "mapping version"):
            build_descriptive_candidate(
                trend_snapshot(), approved_mapping(mapping_version="other"), research_lineage(),
                [PublicationLineage(terms, "catalog"), PublicationLineage(terms, "derived_feature")],
                analytics_run_id=RUN_ID,
                built_at=NOW,
            )

    def test_candidate_hash_and_id_are_deterministic(self):
        terms = source_terms()
        args = (
            trend_snapshot(), approved_mapping(), research_lineage(),
            [PublicationLineage(terms, "catalog"), PublicationLineage(terms, "derived_feature")],
        )
        first = build_descriptive_candidate(*args, analytics_run_id=RUN_ID, built_at=NOW)
        second = build_descriptive_candidate(*args, analytics_run_id=RUN_ID, built_at=NOW)
        self.assertEqual(first.candidate_id, second.candidate_id)
        self.assertEqual(first.candidate_row["payload_hash"], second.candidate_row["payload_hash"])
        self.assertEqual(first.trend_snapshot_row["snapshot_hash"], second.trend_snapshot_row["snapshot_hash"])

    def test_insufficient_history_produces_non_promotable_tier_zero_candidate(self):
        terms = source_terms()
        packet = build_descriptive_candidate(
            trend_snapshot(days=2), approved_mapping(), research_lineage(),
            [PublicationLineage(terms, "catalog"), PublicationLineage(terms, "derived_feature")],
            analytics_run_id=RUN_ID,
            built_at=NOW,
        )
        self.assertEqual(packet.candidate_row["support_tier"], 0)
        self.assertEqual(packet.candidate_row["publication_status"], "unsupported")
        self.assertIn("insufficient_trend_evidence", packet.candidate_row["reason_codes"])


if __name__ == "__main__":
    unittest.main()

