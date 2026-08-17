from datetime import date
from pathlib import Path
from unittest import mock
import json
import tempfile
import unittest

from collectfolio_analytics import tcgcsv_panel_cli as cli
from collectfolio_analytics.tcgcsv_panel import (
    ArchiveDateReceipt,
    TCGCSVPanelUnavailable,
)


def _receipt(day: date, *, rows: int = 10) -> ArchiveDateReceipt:
    return ArchiveDateReceipt(
        archive_date=day,
        archive_sha256="a" * 64,
        archive_bytes=1234,
        members_digest="b" * 64,
        scoped_expanded_bytes=5678,
        categories={1: {"groupCount": 2, "rowCount": rows, "rejectCount": 0}},
        reject_counts={},
        missing_category_ids=(),
    )


class BackfillResumeTests(unittest.TestCase):
    def _args(self, root: Path, **overrides) -> "argparse.Namespace":
        import argparse

        defaults = dict(
            start_date="2025-02-01",
            count=3,
            end_date=None,
            interval_days=7,
            category_id=[1],
            archive_dir=str(root / "archives"),
            panel_dir=str(root / "panel"),
            state_file=None,
            receipts_dir=str(root / "receipts"),
            receipt_name="panel-coverage-summary",
            base_url="https://tcgcsv.com/",
            user_agent="test-agent",
            timeout_seconds=5.0,
            max_attempts=2,
            retry_delay_seconds=0.0,
            sleep_between_dates_seconds=0.0,
            min_free_bytes=0,
        )
        defaults.update(overrides)
        return argparse.Namespace(**defaults)

    def test_second_run_skips_completed_dates_without_reprocessing(self):
        calls: list[str] = []

        def fake_process(day, category_ids, **kwargs):
            calls.append(day.isoformat())
            return _receipt(day)

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            args = self._args(root)
            with mock.patch.object(cli, "process_archive_date", side_effect=fake_process):
                self.assertEqual(cli._backfill_command(args), 0)
            self.assertEqual(calls, ["2025-02-01", "2025-02-08", "2025-02-15"])

            state_path = root / "panel" / "state.json"
            state = json.loads(state_path.read_text(encoding="utf-8"))
            self.assertEqual(len(state["dates"]), 3)
            self.assertTrue(all(v["status"] == "completed" for v in state["dates"].values()))

            calls.clear()
            with mock.patch.object(cli, "process_archive_date", side_effect=fake_process):
                self.assertEqual(cli._backfill_command(args), 0)
            self.assertEqual(calls, [])  # resumed: nothing refetched

    def test_unavailable_date_is_recorded_and_not_fatal(self):
        def fake_process(day, category_ids, **kwargs):
            if day == date(2025, 2, 8):
                raise TCGCSVPanelUnavailable("no archive published for this date (HTTP 404)")
            return _receipt(day)

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            args = self._args(root)
            with mock.patch.object(cli, "process_archive_date", side_effect=fake_process):
                self.assertEqual(cli._backfill_command(args), 0)

            state = json.loads((root / "panel" / "state.json").read_text(encoding="utf-8"))
            self.assertEqual(state["dates"]["2025-02-08"]["status"], "unavailable")
            self.assertEqual(state["dates"]["2025-02-01"]["status"], "completed")
            self.assertEqual(state["dates"]["2025-02-15"]["status"], "completed")

    def test_transient_failure_retries_then_records_failed_after_max_attempts(self):
        attempts: dict[str, int] = {}

        def fake_process(day, category_ids, **kwargs):
            key = day.isoformat()
            attempts[key] = attempts.get(key, 0) + 1
            if key == "2025-02-08":
                raise RuntimeError("transient network error")
            return _receipt(day)

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            args = self._args(root, max_attempts=2)
            with mock.patch.object(cli, "process_archive_date", side_effect=fake_process):
                self.assertEqual(cli._backfill_command(args), 0)

            self.assertEqual(attempts["2025-02-08"], 2)
            state = json.loads((root / "panel" / "state.json").read_text(encoding="utf-8"))
            self.assertEqual(state["dates"]["2025-02-08"]["status"], "failed")
            self.assertEqual(state["dates"]["2025-02-08"]["attempts"], 2)

    def test_receipts_written_with_coverage_summary(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            args = self._args(root)
            with mock.patch.object(cli, "process_archive_date", side_effect=lambda day, cats, **kw: _receipt(day)):
                cli._backfill_command(args)

            receipt_path = root / "receipts" / "panel-coverage-summary.json"
            self.assertTrue(receipt_path.is_file())
            payload = json.loads(receipt_path.read_text(encoding="utf-8"))
            self.assertEqual(payload["coverage"]["datesCompleted"], 3)
            self.assertEqual(payload["coverage"]["datesPlanned"], 3)
            self.assertEqual(payload["coverage"]["earliestCompletedDate"], "2025-02-01")
            self.assertEqual(payload["coverage"]["latestCompletedDate"], "2025-02-15")
            self.assertEqual(payload["coverage"]["spanDays"], 14)

            md_path = root / "receipts" / "panel-coverage-summary.md"
            self.assertTrue(md_path.is_file())
            self.assertIn("coverage summary", md_path.read_text(encoding="utf-8"))


class PlanAndProbeCommandTests(unittest.TestCase):
    def test_plan_command_prints_deterministic_json(self):
        import argparse
        import io
        import contextlib

        args = argparse.Namespace(start_date="2025-02-01", count=3, end_date=None, interval_days=7)
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            self.assertEqual(cli._plan_command(args), 0)
        payload = json.loads(buffer.getvalue())
        self.assertEqual(payload["dates"], ["2025-02-01", "2025-02-08", "2025-02-15"])
        self.assertEqual(payload["count"], 3)

    def test_probe_command_reflects_head_availability(self):
        import argparse

        args = argparse.Namespace(
            date="2025-02-01", base_url="https://tcgcsv.com/",
            user_agent="test", timeout_seconds=5.0,
        )
        with mock.patch("collectfolio_analytics.tcgcsv_panel_cli.probe_archive_date") as probe:
            probe.return_value.as_dict.return_value = {"available": True}
            probe.return_value.available = True
            self.assertEqual(cli._probe_command(args), 0)


class ReportCommandTests(unittest.TestCase):
    def test_report_rebuilds_receipts_without_network(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            panel_dir = root / "panel"
            panel_dir.mkdir(parents=True)
            state_path = panel_dir / "state.json"
            state_path.write_text(json.dumps({
                "contractVersion": "tcgcsv-panel-v1",
                "categoryIds": [1],
                "dates": {
                    "2025-02-01": {"status": "completed", "archiveBytes": 100},
                },
            }), encoding="utf-8")

            import argparse
            args = argparse.Namespace(
                category_id=[1], panel_dir=str(panel_dir), state_file=None,
                receipts_dir=str(root / "receipts"), receipt_name="panel-coverage-summary",
                compact=False,
            )
            self.assertEqual(cli._report_command(args), 0)
            self.assertTrue((root / "receipts" / "panel-coverage-summary.json").is_file())


if __name__ == "__main__":
    unittest.main()
