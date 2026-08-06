from datetime import datetime, timedelta, timezone
import unittest

from collectfolio_analytics.market_pipeline import SourceTerms
from collectfolio_analytics.observations import PriceSeriesKey
from collectfolio_analytics.walk_forward import (
    RetrospectiveWalkForwardConfig,
    build_retrospective_walk_forward,
    parse_hosted_observation_rows,
)


UTC = timezone.utc
GENERATED_AT = datetime(2026, 8, 5, 23, 30, tzinfo=UTC)
SOURCE_ID = "f24c78f8-d4b9-55a3-a8f7-b05d484c052e"
TERMS_ID = "3bc792cf-ad71-54d1-a2f6-d5d5d521fba5"
VARIANT_ID = "80b4934a-96db-5f4c-8641-f7c74e0eb949"
KEY = PriceSeriesKey(
    VARIANT_ID, SOURCE_ID, "USD", "holofoil", "raw", "tcgplayer_market"
)


def source_terms(**overrides):
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
        "document_hash": "a" * 64,
        "reviewed_at": GENERATED_AT - timedelta(hours=2),
        "expires_at": GENERATED_AT + timedelta(days=30),
    }
    values.update(overrides)
    return SourceTerms(**values)


def config(**overrides):
    values = {
        "model_key": "tcgcsv-weekly-damped-momentum-retrospective",
        "model_version": "research-retrospective-v1",
        "model_family": "damped_momentum_baseline",
        "allowed_horizons": (7, 30),
        "mapping_version": "tcgcsv-research-mapping-v1",
        "feature_version": "tcgcsv-weekly-trends-v1",
        "code_version": "collectfolio-price-intelligence-research-v1",
        "generated_at": GENERATED_AT,
        "model_config": {
            "damping": 0.25,
            "maxAbsLogReturn": 0.7,
            "maxIntervalLogWidth": 1.5,
        },
        "origin_spacing_days": 7,
        "code_artifact_hash": "c" * 64,
    }
    values.update(overrides)
    return RetrospectiveWalkForwardConfig(**values)


def hosted_rows(count=40, *, include_outlier=False):
    start = datetime(2025, 9, 1, tzinfo=UTC)
    rows = []
    for index in range(count):
        observed = start + timedelta(days=7 * index)
        rows.append({
            "id": f"00000000-0000-4000-8000-{index + 1:012d}",
            "observation_status": "accepted",
            "observed_at": observed.isoformat(),
            "available_at": (observed + timedelta(days=1)).isoformat(),
            "market_price": 100 + index * 1.5 + (index % 4),
            "quality_score": 0.75,
            "external_record_id": f"archive:{index}",
            "reason_codes": [],
            "currency": "USD",
            "price_semantics": "tcgplayer_market",
        })
    if include_outlier:
        observed = start + timedelta(days=7 * 10, hours=1)
        rows.append({
            "id": "10000000-0000-4000-8000-000000000001",
            "observation_status": "outlier",
            "observed_at": observed.isoformat(),
            "available_at": (observed + timedelta(days=1)).isoformat(),
            "market_price": 1000000,
            "quality_score": 0.75,
            "external_record_id": "archive:outlier",
            "reason_codes": ["robust_price_outlier"],
            "currency": "USD",
            "price_semantics": "tcgplayer_market",
        })
    return rows


class RetrospectiveWalkForwardTests(unittest.TestCase):
    def test_builds_honestly_labeled_private_predictions_and_scorecards(self):
        ledger = parse_hosted_observation_rows(hosted_rows(), KEY)
        evidence = build_retrospective_walk_forward(ledger, source_terms(), config())
        packet = evidence.as_dict()

        self.assertEqual(len(packet["trendSnapshotRows"]), 40)
        self.assertEqual(len(packet["predictionRows"]), 80)
        self.assertGreater(len(packet["evaluationRows"]), 30)
        self.assertEqual(len(packet["scorecardRows"]), 2)
        self.assertEqual(packet["simulationMode"], "retrospective_walk_forward")
        self.assertEqual(packet["publicCandidateRows"], [])
        self.assertEqual(packet["promotionReviewRows"], [])
        self.assertEqual(packet["gateStatus"]["publicPublication"], "blocked")
        self.assertTrue(packet["modelRow"]["research_only"])
        self.assertEqual(packet["modelRow"]["training_mode"], "none_static_baseline")
        self.assertIsNone(packet["modelRow"]["training_dataset_hash"])
        self.assertEqual(len(packet["modelRow"]["model_definition_hash"]), 64)
        self.assertEqual(packet["modelRow"]["model_artifact_hash"], "c" * 64)
        self.assertEqual(packet["modelRow"]["created_at"], GENERATED_AT.isoformat())
        self.assertTrue(all(
            row["started_at"] == GENERATED_AT.isoformat()
            and row["completed_at"] == GENERATED_AT.isoformat()
            for row in packet["analyticsRunRows"]
        ))
        self.assertTrue(all(
            "retrospective_walk_forward" in row["reason_codes"]
            and "not_prospectively_generated" in row["reason_codes"]
            and row["prediction_status"] in {"research_only", "quarantined"}
            for row in packet["predictionRows"]
        ))
        self.assertTrue(all(
            row["promotion_recommendation"]
            in {"insufficient", "reject", "eligible_for_operator_review"}
            and "operator_model_review_required" in row["reason_codes"]
            for row in packet["scorecardRows"]
        ))
        unscorable = [
            row for row in packet["evaluationRows"]
            if row["evaluation_status"] == "unscorable"
        ]
        self.assertEqual(len(unscorable), packet["unscorableMaturedTargets"])
        self.assertEqual(
            packet["unscorableMaturedTargets"], packet["skippedMaturedTargets"]
        )
        self.assertGreater(len(unscorable), 0)
        self.assertTrue(all(
            row["realized_price"] is None
            and row["observation_count"] == 0
            and row["unscorable_reason"]
            for row in unscorable
        ))
        self.assertEqual(
            len(packet["scorecardEvaluationRows"]), len(packet["evaluationRows"])
        )
        self.assertTrue(all(
            row["matured_count"]
            == row["evaluation_count"] + row["unscorable_count"] + row["excluded_count"]
            and len(row["promotion_policy_hash"]) == 64
            and len(row["evaluation_membership_hash"]) == 64
            for row in packet["scorecardRows"]
        ))
        hashes_by_origin = {}
        for row in packet["predictionRows"]:
            hashes_by_origin.setdefault(row["origin"], set()).add(row["dataset_hash"])
        self.assertTrue(all(len(values) == 1 for values in hashes_by_origin.values()))
        self.assertGreater(len({next(iter(values)) for values in hashes_by_origin.values()}), 1)
        evaluation_run = next(
            row for row in packet["analyticsRunRows"]
            if row["run_kind"] == "forecast_evaluation"
        )
        excluded = sum(row["excluded_count"] for row in packet["scorecardRows"])
        self.assertEqual(evaluation_run["records_quarantined"], excluded)
        self.assertNotEqual(
            evaluation_run["records_quarantined"], packet["unscorableMaturedTargets"]
        )

    def test_outlier_stays_in_ledger_but_never_changes_features_or_predictions(self):
        without = build_retrospective_walk_forward(
            parse_hosted_observation_rows(hosted_rows(), KEY), source_terms(), config()
        )
        with_outlier = build_retrospective_walk_forward(
            parse_hosted_observation_rows(hosted_rows(include_outlier=True), KEY),
            source_terms(),
            config(),
        )

        self.assertEqual(with_outlier.ledger_status_counts["outlier"], 1)
        self.assertNotEqual(without.ledger_hash, with_outlier.ledger_hash)
        comparable_without = [
            {key: value for key, value in row.items() if key not in {"evaluation_hash"}}
            for row in without.prediction_rows
        ]
        comparable_with = [
            {key: value for key, value in row.items() if key not in {"evaluation_hash"}}
            for row in with_outlier.prediction_rows
        ]
        self.assertEqual(comparable_without, comparable_with)

    def test_rights_are_checked_at_generation_not_historical_origins(self):
        ledger = parse_hosted_observation_rows(hosted_rows(), KEY)
        evidence = build_retrospective_walk_forward(ledger, source_terms(), config())
        earliest_origin = min(row["origin"] for row in evidence.prediction_rows)
        self.assertLess(earliest_origin, source_terms().reviewed_at.isoformat())

        with self.assertRaisesRegex(PermissionError, "generation time"):
            build_retrospective_walk_forward(
                ledger,
                source_terms(
                    reviewed_at=GENERATED_AT - timedelta(days=2),
                    expires_at=GENERATED_AT - timedelta(seconds=1),
                ),
                config(),
            )
        with self.assertRaisesRegex(PermissionError, "closed research-only"):
            build_retrospective_walk_forward(
                ledger,
                source_terms(commercial_use_allowed=True),
                config(),
            )

    def test_packet_is_deterministic_for_the_same_generation_receipt(self):
        ledger = parse_hosted_observation_rows(hosted_rows(), KEY)
        first = build_retrospective_walk_forward(ledger, source_terms(), config())
        second = build_retrospective_walk_forward(ledger, source_terms(), config())
        self.assertEqual(first.as_dict(), second.as_dict())
        self.assertEqual(len({row["id"] for row in first.prediction_rows}), 80)

    def test_monthly_origin_spacing_reduces_overlapping_cases(self):
        ledger = parse_hosted_observation_rows(hosted_rows(), KEY)
        weekly = build_retrospective_walk_forward(
            ledger, source_terms(), config(origin_spacing_days=7)
        )
        monthly = build_retrospective_walk_forward(
            ledger, source_terms(), config(origin_spacing_days=30)
        )
        self.assertEqual(len(weekly.trend_snapshot_rows), 40)
        self.assertEqual(len(monthly.trend_snapshot_rows), 8)
        self.assertTrue(all(
            row["metrics"]["originSpacingDays"] == 30
            for row in monthly.scorecard_rows
        ))


if __name__ == "__main__":
    unittest.main()
