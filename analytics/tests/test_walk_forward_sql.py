from copy import deepcopy
import unittest

from collectfolio_analytics.walk_forward import (
    build_retrospective_walk_forward,
    parse_hosted_observation_rows,
)
from collectfolio_analytics.walk_forward_sql import build_walk_forward_evidence_sql
from collectfolio_analytics.walk_forward_cli import _code_artifact_hash

from analytics.tests.test_walk_forward import KEY, config, hosted_rows, source_terms


def packet():
    ledger = parse_hosted_observation_rows(hosted_rows(), KEY)
    return build_retrospective_walk_forward(
        ledger,
        source_terms(),
        config(origin_spacing_days=30, code_artifact_hash=_code_artifact_hash()),
    ).as_dict()


class WalkForwardSQLTests(unittest.TestCase):
    def test_defaults_to_rollback_and_contains_all_private_ledgers(self):
        rehearsal = build_walk_forward_evidence_sql(packet())
        committed = build_walk_forward_evidence_sql(packet(), commit=True)

        self.assertTrue(rehearsal.startswith("begin;"))
        self.assertTrue(rehearsal.endswith("rollback;\n"))
        self.assertTrue(committed.endswith("commit;\n"))
        for table in (
            "model_versions",
            "analytics_runs",
            "analytics_run_sources",
            "trend_feature_snapshots",
            "card_forecast_predictions",
            "forecast_evaluations",
            "model_scorecards",
            "model_scorecard_evaluations",
        ):
            self.assertIn(f"insert into public.{table}", rehearsal)
        self.assertNotIn("insert into public.model_promotion_reviews", rehearsal)
        self.assertNotIn("insert into public.intelligence_publication", rehearsal)
        self.assertIn("review.expires_at > greatest", rehearsal)
        self.assertIn("public_price_intelligence must remain disabled", rehearsal)

    def test_refuses_public_or_automatically_promoted_evidence(self):
        public = deepcopy(packet())
        public["publicCandidateRows"] = [{"unsafe": True}]
        with self.assertRaises(PermissionError):
            build_walk_forward_evidence_sql(public)

        promoted = deepcopy(packet())
        promoted["promotionReviewRows"] = [{"decision": "approved"}]
        with self.assertRaises(PermissionError):
            build_walk_forward_evidence_sql(promoted)

    def test_refuses_backdated_generation_or_missing_labels(self):
        backdated = deepcopy(packet())
        backdated["modelRow"]["created_at"] = "2025-01-01T00:00:00+00:00"
        with self.assertRaisesRegex(ValueError, "honest generation"):
            build_walk_forward_evidence_sql(backdated)

        unlabeled = deepcopy(packet())
        unlabeled["predictionRows"][0]["reason_codes"].remove(
            "not_prospectively_generated"
        )
        with self.assertRaisesRegex(PermissionError, "labels"):
            build_walk_forward_evidence_sql(unlabeled)

    def test_refuses_cross_run_prediction_lineage(self):
        crossed = deepcopy(packet())
        crossed["predictionRows"][0]["analytics_run_id"] = crossed[
            "analyticsRunRows"
        ][-1]["id"]
        with self.assertRaisesRegex(ValueError, "walk-forward snapshot"):
            build_walk_forward_evidence_sql(crossed)

    def test_refuses_invalid_unscorable_or_membership_evidence(self):
        invalid_target = deepcopy(packet())
        unscorable = next(
            row for row in invalid_target["evaluationRows"]
            if row["evaluation_status"] == "scored"
        )
        unscorable["evaluation_status"] = "unscorable"
        unscorable["realized_price"] = 100
        with self.assertRaisesRegex(ValueError, "unscorable evaluation"):
            build_walk_forward_evidence_sql(invalid_target)

        invalid_membership = deepcopy(packet())
        invalid_membership["scorecardEvaluationRows"][0]["evaluation_id"] = (
            "99999999-9999-4999-8999-999999999999"
        )
        with self.assertRaisesRegex(ValueError, "outside the packet"):
            build_walk_forward_evidence_sql(invalid_membership)

    def test_refuses_policy_membership_and_origin_dataset_tampering(self):
        policy = deepcopy(packet())
        policy["scorecardRows"][0]["promotion_policy"]["minimumCases"] = 1
        policy["scorecardRows"][0]["metrics"]["promotionPolicy"]["minimumCases"] = 1
        with self.assertRaisesRegex(ValueError, "policy hash"):
            build_walk_forward_evidence_sql(policy)

        membership = deepcopy(packet())
        membership["scorecardEvaluationRows"][0]["included_in_metrics"] = not (
            membership["scorecardEvaluationRows"][0]["included_in_metrics"]
        )
        with self.assertRaisesRegex(ValueError, "membership status"):
            build_walk_forward_evidence_sql(membership)

        dataset = deepcopy(packet())
        dataset["predictionRows"][0]["dataset_hash"] = "f" * 64
        with self.assertRaisesRegex(ValueError, "dataset lineage"):
            build_walk_forward_evidence_sql(dataset)

    def test_refuses_code_artifact_and_evaluation_hash_tampering(self):
        artifact = deepcopy(packet())
        artifact["modelRow"]["model_artifact_hash"] = "f" * 64
        with self.assertRaisesRegex(ValueError, "code-artifact"):
            build_walk_forward_evidence_sql(artifact)

        evaluation = deepcopy(packet())
        scored = next(
            row for row in evaluation["evaluationRows"]
            if row["evaluation_status"] == "scored"
        )
        scored["absolute_log_error"] = scored["absolute_log_error"] + 0.01
        with self.assertRaisesRegex(ValueError, "evaluation hash"):
            build_walk_forward_evidence_sql(evaluation)


if __name__ == "__main__":
    unittest.main()
