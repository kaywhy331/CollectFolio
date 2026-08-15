from datetime import datetime, timedelta, timezone
from math import exp
import unittest
from uuid import NAMESPACE_URL, uuid5

from collectfolio_analytics.evaluation import ResearchLineage
from collectfolio_analytics.market_pipeline import (
    ObservationMapping,
    SourceTerms,
    build_market_series_row,
)
from collectfolio_analytics.observations import PriceObservation, PriceSeriesKey
from collectfolio_analytics.publication import PublicationLineage, build_descriptive_candidate
from collectfolio_analytics.trends import build_trend_snapshot
from collectfolio_analytics.walk_forward import HostedObservation


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
        "language": "en",
        "market_condition": "near-mint",
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


def trend_observations(days=100):
    key = PriceSeriesKey(
        VARIANT_ID, SOURCE_ID, "USD", "holofoil", "raw", "market", "en", "near-mint"
    )
    start = NOW - timedelta(days=days - 1)
    return [
        PriceObservation(
            key,
            start + timedelta(days=day),
            start + timedelta(days=day),
            100 * exp(day * 0.005),
            quality=0.95,
        )
        for day in range(days)
    ]


def trend_snapshot(days=100):
    return build_trend_snapshot(trend_observations(days), NOW)


def hosted_history(
    observations,
    mapping_value=None,
    terms=None,
    *,
    effective_available_at=None,
):
    mapping_value = mapping_value or approved_mapping()
    terms = terms or source_terms()
    market_series_id = str(build_market_series_row(
        mapping_value, terms, currency="USD", price_semantics="market"
    )["id"])
    return [HostedObservation(
        id=str(uuid5(NAMESPACE_URL, f"publication-hosted-{index}")),
        key=item.key,
        observation_status="accepted",
        observed_at=item.observed_at,
        available_at=effective_available_at or item.available_at,
        market_price=item.price,
        quality_score=item.quality,
        external_record_id=f"record-{index}",
        market_series_id=market_series_id,
        source_available_at=effective_available_at or item.available_at,
        collectfolio_first_seen_at=effective_available_at or item.available_at,
        centralized_import_id=str(uuid5(
            NAMESPACE_URL, f"publication-import-{index}"
        )),
        centralized_import_point_in_time_eligible=True,
        centralized_import_created_at=effective_available_at or item.available_at,
    ) for index, item in enumerate(observations)]


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
            hosted_evidence=hosted_history(trend_observations(), terms=terms),
            include_observed=True,
        )
        candidate = packet.candidate_row
        self.assertEqual(candidate["support_tier"], 2)
        self.assertEqual(candidate["publication_status"], "published")
        self.assertIn("observed", candidate["payload"])
        self.assertIn("trend", candidate["payload"])
        self.assertEqual(
            candidate["payload"]["seriesIdentity"]["marketCondition"], "near-mint"
        )
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
            hosted_evidence=hosted_history(trend_observations(), terms=terms),
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
                hosted_evidence=hosted_history(trend_observations(), terms=terms),
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
                hosted_evidence=hosted_history(
                    trend_observations(), terms=restricted
                ),
            )

    def test_duplicate_lineage_cannot_select_conflicting_terms_by_input_order(self):
        allowed = source_terms()
        denied = source_terms(public_derived_display_allowed=False)
        for conflicting in ((allowed, denied), (denied, allowed)):
            with self.subTest(first_allowed=conflicting[0] is allowed):
                with self.assertRaisesRegex(ValueError, "conflicting source terms"):
                    build_descriptive_candidate(
                        trend_snapshot(), approved_mapping(), research_lineage(),
                        [
                            PublicationLineage(allowed, "catalog"),
                            PublicationLineage(conflicting[0], "derived_feature"),
                            PublicationLineage(conflicting[1], "derived_feature"),
                        ],
                        analytics_run_id=RUN_ID,
                        built_at=NOW,
                        hosted_evidence=hosted_history(
                            trend_observations(), terms=allowed
                        ),
                    )

    def test_mapping_version_must_match_snapshot_lineage(self):
        terms = source_terms()
        changed_mapping = approved_mapping(mapping_version="other")
        with self.assertRaisesRegex(ValueError, "mapping version"):
            build_descriptive_candidate(
                trend_snapshot(), changed_mapping, research_lineage(),
                [PublicationLineage(terms, "catalog"), PublicationLineage(terms, "derived_feature")],
                analytics_run_id=RUN_ID,
                built_at=NOW,
                hosted_evidence=hosted_history(
                    trend_observations(), mapping_value=changed_mapping, terms=terms
                ),
            )

    def test_candidate_hash_and_id_are_deterministic(self):
        terms = source_terms()
        args = (
            trend_snapshot(), approved_mapping(), research_lineage(),
            [PublicationLineage(terms, "catalog"), PublicationLineage(terms, "derived_feature")],
        )
        evidence = hosted_history(trend_observations(), terms=terms)
        first = build_descriptive_candidate(
            *args, analytics_run_id=RUN_ID, built_at=NOW, hosted_evidence=evidence
        )
        second = build_descriptive_candidate(
            *args, analytics_run_id=RUN_ID, built_at=NOW, hosted_evidence=reversed(evidence)
        )
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
            hosted_evidence=hosted_history(
                trend_observations(days=2), terms=terms
            ),
        )
        self.assertEqual(packet.candidate_row["support_tier"], 0)
        self.assertEqual(packet.candidate_row["publication_status"], "unsupported")
        self.assertIn("insufficient_trend_evidence", packet.candidate_row["reason_codes"])

    def test_public_history_is_cutoff_safe_deduplicated_ordered_and_bounded(self):
        terms = source_terms()
        observations = trend_observations(days=220)
        revised_at = observations[20].observed_at
        observations.extend((
            PriceObservation(
                observations[20].key,
                revised_at,
                revised_at + timedelta(hours=2),
                observations[20].price + 3,
                quality=0.9,
                source_observation_id="revision-known",
            ),
            PriceObservation(
                observations[30].key,
                observations[30].observed_at,
                NOW + timedelta(minutes=1),
                observations[30].price + 50,
                quality=0.9,
                source_observation_id="revision-future",
            ),
        ))
        snapshot = build_trend_snapshot(observations, NOW)
        hosted = hosted_history(observations, terms=terms)
        packet = build_descriptive_candidate(
            snapshot,
            approved_mapping(),
            research_lineage(),
            [
                PublicationLineage(terms, "catalog"),
                PublicationLineage(terms, "derived_feature"),
                PublicationLineage(terms, "raw_price"),
            ],
            analytics_run_id=RUN_ID,
            built_at=NOW,
            hosted_evidence=reversed(hosted),
            include_observed=True,
            include_history=True,
        )

        history = packet.candidate_row["payload"]["history"]
        self.assertEqual(len(history), 180)
        self.assertEqual(
            [item["observedAt"] for item in history],
            sorted(item["observedAt"] for item in history),
        )
        self.assertEqual(history[-1]["observedAt"], snapshot.latest_observed_at.isoformat())
        self.assertTrue(all(item["observedAt"] <= NOW.isoformat() for item in history))

    def test_history_requires_exact_series_and_raw_display_rights(self):
        terms = source_terms()
        observations = trend_observations()
        hosted = hosted_history(observations, terms=terms)
        with self.assertRaisesRegex(PermissionError, "raw-price"):
            build_descriptive_candidate(
                trend_snapshot(), approved_mapping(), research_lineage(),
                [
                    PublicationLineage(terms, "catalog"),
                    PublicationLineage(terms, "derived_feature"),
                ],
                analytics_run_id=RUN_ID,
                built_at=NOW,
                hosted_evidence=hosted,
                include_history=True,
            )

        with self.assertRaisesRegex(ValueError, "hosted ledger"):
            build_descriptive_candidate(
                trend_snapshot(), approved_mapping(), research_lineage(),
                [
                    PublicationLineage(terms, "catalog"),
                    PublicationLineage(terms, "derived_feature"),
                    PublicationLineage(terms, "raw_price"),
                ],
                analytics_run_id=RUN_ID,
                built_at=NOW,
                hosted_evidence=observations,
                include_history=True,
            )

        other_key = PriceSeriesKey(
            VARIANT_ID, SOURCE_ID, "USD", "reverse-holofoil", "raw", "market",
            "en", "near-mint",
        )
        crossed_observations = [
            *observations[:-1],
            PriceObservation(other_key, NOW, NOW, 100, quality=1),
        ]
        crossed = hosted_history(crossed_observations, terms=terms)
        with self.assertRaisesRegex(ValueError, "exact price series"):
            build_descriptive_candidate(
                trend_snapshot(), approved_mapping(), research_lineage(),
                [
                    PublicationLineage(terms, "catalog"),
                    PublicationLineage(terms, "derived_feature"),
                    PublicationLineage(terms, "raw_price"),
                ],
                analytics_run_id=RUN_ID,
                built_at=NOW,
                hosted_evidence=crossed,
                include_history=True,
            )

    def test_snapshot_and_observed_value_require_database_effective_availability(self):
        terms = source_terms()
        observations = trend_observations()
        not_yet_known = hosted_history(
            observations,
            terms=terms,
            effective_available_at=NOW + timedelta(minutes=1),
        )
        with self.assertRaisesRegex(ValueError, "no accepted observation known"):
            build_descriptive_candidate(
                build_trend_snapshot(observations, NOW),
                approved_mapping(),
                research_lineage(),
                [
                    PublicationLineage(terms, "catalog"),
                    PublicationLineage(terms, "derived_feature"),
                    PublicationLineage(terms, "raw_price"),
                ],
                analytics_run_id=RUN_ID,
                built_at=NOW,
                hosted_evidence=not_yet_known,
                include_observed=True,
            )

    def test_hosted_history_ranks_all_revisions_before_filtering_status(self):
        terms = source_terms()
        mapping_value = approved_mapping()
        observations = trend_observations()
        market_series_id = str(build_market_series_row(
            mapping_value, terms, currency="USD", price_semantics="market"
        )["id"])
        hosted = [HostedObservation(
            id=str(uuid5(NAMESPACE_URL, f"publication-observation-{index}")),
            key=item.key,
            observation_status="accepted",
            observed_at=item.observed_at,
            available_at=item.available_at,
            market_price=item.price,
            quality_score=item.quality,
            external_record_id=f"record-{index}",
            market_series_id=market_series_id,
            source_available_at=item.available_at,
            collectfolio_first_seen_at=item.available_at,
            centralized_import_id=str(uuid5(
                NAMESPACE_URL, f"publication-revision-import-{index}"
            )),
            centralized_import_point_in_time_eligible=True,
            centralized_import_created_at=item.available_at,
        ) for index, item in enumerate(observations)]
        corrected = hosted[40]
        hosted.append(HostedObservation(
            id=str(uuid5(NAMESPACE_URL, "publication-quarantine-revision")),
            key=corrected.key,
            observation_status="quarantined",
            observed_at=corrected.observed_at,
            available_at=corrected.available_at + timedelta(hours=1),
            market_price=corrected.market_price,
            quality_score=0.1,
            external_record_id="record-40-correction",
            reason_codes=("provider_correction",),
            market_series_id=market_series_id,
            source_available_at=corrected.available_at + timedelta(hours=1),
            collectfolio_first_seen_at=corrected.available_at + timedelta(hours=1),
            centralized_import_id=str(uuid5(
                NAMESPACE_URL, "publication-quarantine-import"
            )),
            centralized_import_point_in_time_eligible=True,
            centralized_import_created_at=corrected.available_at + timedelta(hours=1),
        ))
        final_observations = [
            item.accepted_price_observation()
            for item in hosted
            if item.observed_at != corrected.observed_at
        ]
        final_snapshot = build_trend_snapshot(final_observations, NOW)
        packet = build_descriptive_candidate(
            final_snapshot, mapping_value, research_lineage(),
            [
                PublicationLineage(terms, "catalog"),
                PublicationLineage(terms, "derived_feature"),
                PublicationLineage(terms, "raw_price"),
            ],
            analytics_run_id=RUN_ID,
            built_at=NOW,
            hosted_evidence=hosted,
            include_history=True,
        )

        published_times = {
            item["observedAt"] for item in packet.candidate_row["payload"]["history"]
        }
        self.assertNotIn(corrected.observed_at.isoformat(), published_times)


if __name__ == "__main__":
    unittest.main()
