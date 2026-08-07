from datetime import datetime, timezone
import json
from pathlib import Path
import stat
import tempfile
import unittest

from collectfolio_analytics.walk_forward_cli import build_packet_from_exports, main

from analytics.tests.test_walk_forward import GENERATED_AT, hosted_rows


ROOT = Path(__file__).resolve().parents[2]
MANIFEST_PATH = ROOT / "analytics/manifests/tcgcsv-surging-sparks-research.json"


class WalkForwardCLITests(unittest.TestCase):
    def test_checked_in_manifest_builds_bounded_private_packet(self):
        manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
        packet = build_packet_from_exports(
            manifest,
            {"rows": hosted_rows()},
            generated_at=GENERATED_AT,
        )
        self.assertEqual(packet["simulationMode"], "retrospective_walk_forward")
        self.assertEqual(len(packet["trendSnapshotRows"]), 8)
        self.assertEqual(len(packet["predictionRows"]), 40)
        self.assertTrue(all(
            row["metrics"]["originSpacingDays"] == 30
            and row["promotion_policy"]["version"] == "research-promotion-v1"
            and row["cohort_key"] == "tcgcsv_30d_origins_accepted_research_only_v2"
            and row["promotion_recommendation"] == "insufficient"
            and row["metrics"]["missingRequiredBaselines"] == [
                "damped_momentum", "market_index", "lifecycle_cohort",
                "structural_convergence",
            ]
            for row in packet["scorecardRows"]
        ))
        self.assertEqual(packet["publicCandidateRows"], [])

    def test_cli_creates_mode_0600_packet_and_refuses_overwrite(self):
        manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
        with tempfile.TemporaryDirectory() as directory:
            export_path = Path(directory) / "hosted.json"
            output_path = Path(directory) / "packet.json"
            export_path.write_text(json.dumps({"rows": hosted_rows()}), encoding="utf-8")
            result = main([
                str(MANIFEST_PATH),
                str(export_path),
                str(output_path),
                "--generated-at",
                GENERATED_AT.isoformat(),
            ])
            self.assertEqual(result, 0)
            self.assertEqual(stat.S_IMODE(output_path.stat().st_mode), 0o600)
            packet = json.loads(output_path.read_text(encoding="utf-8"))
            self.assertEqual(packet["generatedAt"], GENERATED_AT.isoformat())
            with self.assertRaises(FileExistsError):
                main([
                    str(MANIFEST_PATH),
                    str(export_path),
                    str(output_path),
                    "--generated-at",
                    GENERATED_AT.isoformat(),
                ])

    def test_cli_rejects_naive_generation_timestamp(self):
        with self.assertRaisesRegex(ValueError, "timezone"):
            main([
                str(MANIFEST_PATH),
                str(MANIFEST_PATH),
                "/unused/output.json",
                "--generated-at",
                datetime(2026, 8, 5, 23, 30).isoformat(),
            ])


if __name__ == "__main__":
    unittest.main()
