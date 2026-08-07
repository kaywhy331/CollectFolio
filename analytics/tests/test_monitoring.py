from datetime import datetime, timedelta, timezone
import unittest

from collectfolio_analytics.monitoring import PipelineHealthPolicy, assess_operator_packet


UTC = timezone.utc
NOW = datetime(2026, 8, 5, 21, tzinfo=UTC)


def packet():
    return {
        "mode": "research_only",
        "source": {
            "expiresAt": (NOW + timedelta(days=90)).isoformat(),
        },
        "ingestion": {
            "sourceUpdatedAt": (NOW - timedelta(hours=1)).isoformat(),
            "rawRecordCount": 1,
        },
        "catalog": {
            "mappingCandidates": [{
                "disposition": "exact",
                "reason_codes": ["initial_mapping_review_required"],
            }],
        },
        "observations": {
            "statusCounts": {
                "accepted": 0, "missing": 0, "outlier": 0,
                "quarantined": 0, "rejected": 1,
            },
        },
        "gateStatus": {
            "sourceRights": "research_only",
            "mapping": "operator_review_required",
            "publicPublication": "blocked",
        },
    }


class MonitoringTests(unittest.TestCase):
    def test_expected_first_packet_is_review_required_and_non_public(self):
        report = assess_operator_packet(packet(), NOW)
        self.assertEqual(report.status, "review_required")
        self.assertFalse(report.public_publication_allowed)
        self.assertEqual(report.metrics["mappingCandidatesPendingReview"], 1)
        self.assertIn("mapping_review_required", {alert.code for alert in report.alerts})

    def test_public_gate_violation_is_critical(self):
        value = packet()
        value["gateStatus"]["publicPublication"] = "allowed"
        report = assess_operator_packet(value, NOW)
        self.assertEqual(report.status, "blocked")
        self.assertIn("public_gate_open", {alert.code for alert in report.alerts})

    def test_stale_empty_source_fails_health(self):
        value = packet()
        value["ingestion"]["sourceUpdatedAt"] = (NOW - timedelta(days=3)).isoformat()
        value["ingestion"]["rawRecordCount"] = 0
        value["observations"]["statusCounts"]["rejected"] = 0
        report = assess_operator_packet(value, NOW)
        self.assertEqual(report.status, "failed")
        self.assertEqual({alert.code for alert in report.alerts} & {"source_stale", "source_empty"}, {"source_stale", "source_empty"})

    def test_terms_expiry_warns_then_blocks(self):
        value = packet()
        value["catalog"]["mappingCandidates"] = []
        value["observations"]["statusCounts"].update(accepted=1, rejected=0)
        value["source"]["expiresAt"] = (NOW + timedelta(days=7)).isoformat()
        warning = assess_operator_packet(value, NOW)
        self.assertEqual(warning.status, "degraded")
        self.assertIn("source_terms_expiring", {alert.code for alert in warning.alerts})

        value["source"]["expiresAt"] = (NOW - timedelta(seconds=1)).isoformat()
        blocked = assess_operator_packet(value, NOW)
        self.assertEqual(blocked.status, "blocked")
        self.assertIn("source_terms_expired", {alert.code for alert in blocked.alerts})


if __name__ == "__main__":
    unittest.main()
