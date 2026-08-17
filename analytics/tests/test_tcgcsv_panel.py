from datetime import date, datetime, timezone
from pathlib import Path
import gzip
import json
import tempfile
import unittest

from collectfolio_analytics.tcgcsv_panel import (
    ArchiveProbe,
    TCGCSVPanelError,
    TCGCSVPanelUnavailable,
    available_at,
    ensure_free_disk,
    observed_at,
    plan_weekly_dates,
    probe_archive_date,
    process_archive_date,
    summarize_panel,
)


PRICE = {
    "productId": 605,
    "subTypeName": "Normal",
    "lowPrice": 0.75,
    "midPrice": 1.38,
    "highPrice": 389.99,
    "marketPrice": 1.99,
    "directLowPrice": None,
}


def _write_member(root: Path, archive_date: date, category_id: int, group_id: int, results: list[dict]) -> Path:
    member = root / archive_date.isoformat() / str(category_id) / str(group_id) / "prices"
    member.parent.mkdir(parents=True, exist_ok=True)
    member.write_text(json.dumps({"success": True, "errors": [], "results": results}), encoding="utf-8")
    return member


def fake_extract(fixture: dict) -> callable:
    """Build an extract_archive fake that materializes a fixed member tree."""

    def _extract(archive_bytes: bytes, dest_dir: Path) -> None:
        assert archive_bytes == b"fixture-archive-bytes"
        for (archive_date, category_id, group_id), results in fixture.items():
            _write_member(dest_dir, archive_date, category_id, group_id, results)

    return _extract


class PlanWeeklyDatesTests(unittest.TestCase):
    def test_count_produces_exact_seven_day_steps(self):
        planned = plan_weekly_dates(date(2025, 2, 1), count=3)
        self.assertEqual(planned, (date(2025, 2, 1), date(2025, 2, 8), date(2025, 2, 15)))

    def test_end_date_must_align_to_the_interval(self):
        planned = plan_weekly_dates(date(2025, 2, 1), end_date=date(2025, 2, 15))
        self.assertEqual(planned, (date(2025, 2, 1), date(2025, 2, 8), date(2025, 2, 15)))
        with self.assertRaisesRegex(ValueError, "exact interval"):
            plan_weekly_dates(date(2025, 2, 1), end_date=date(2025, 2, 16))

    def test_exactly_one_of_count_or_end_date_is_required(self):
        with self.assertRaisesRegex(ValueError, "exactly one"):
            plan_weekly_dates(date(2025, 2, 1))
        with self.assertRaisesRegex(ValueError, "exactly one"):
            plan_weekly_dates(date(2025, 2, 1), count=2, end_date=date(2025, 2, 8))

    def test_end_date_before_start_date_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "must not precede"):
            plan_weekly_dates(date(2025, 2, 8), end_date=date(2025, 2, 1))

    def test_count_must_be_positive(self):
        with self.assertRaisesRegex(ValueError, "positive"):
            plan_weekly_dates(date(2025, 2, 1), count=0)


class PointInTimeSemanticsTests(unittest.TestCase):
    def test_available_at_is_one_day_after_observed_at(self):
        day = date(2025, 2, 1)
        self.assertEqual(observed_at(day), datetime(2025, 2, 1, tzinfo=timezone.utc))
        self.assertEqual(available_at(day), datetime(2025, 2, 2, tzinfo=timezone.utc))


class ProbeArchiveDateTests(unittest.TestCase):
    def test_probe_reports_available_when_head_returns_200(self):
        def head(url: str):
            self.assertTrue(url.endswith("archive/tcgplayer/prices-2025-02-01.ppmd.7z"))
            return 200, 3205272

        probe = probe_archive_date(date(2025, 2, 1), head=head)
        self.assertIsInstance(probe, ArchiveProbe)
        self.assertTrue(probe.available)
        self.assertEqual(probe.content_length_bytes, 3205272)

    def test_probe_reports_unavailable_on_404(self):
        probe = probe_archive_date(date(2024, 1, 1), head=lambda url: (404, None))
        self.assertFalse(probe.available)
        self.assertEqual(probe.status_code, 404)


class EnsureFreeDiskTests(unittest.TestCase):
    def test_passes_when_threshold_is_trivially_low(self):
        with tempfile.TemporaryDirectory() as temporary:
            self.assertGreaterEqual(ensure_free_disk(Path(temporary), 0), 0)

    def test_fails_closed_when_threshold_is_unreachable(self):
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaisesRegex(TCGCSVPanelError, "refusing to continue"):
                ensure_free_disk(Path(temporary), 10**18)


class ProcessArchiveDateTests(unittest.TestCase):
    def test_parses_scoped_categories_and_skips_unscoped(self):
        day = date(2025, 2, 1)
        fixture = {
            (day, 1, 100): [PRICE, {**PRICE, "productId": 606, "subTypeName": "Foil"}],
            (day, 3, 200): [{**PRICE, "productId": 700}],
            (day, 31, 1): [{**PRICE, "productId": 999}],  # sealed category: out of scope
        }
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive_dir = root / "archives"
            panel_dir = root / "panel"

            receipt = process_archive_date(
                day, [1, 3],
                archive_dir=archive_dir,
                panel_dir=panel_dir,
                fetch_archive=lambda url: b"fixture-archive-bytes",
                extract_archive=fake_extract(fixture),
            )

            self.assertEqual(receipt.archive_date, day)
            self.assertEqual(len(receipt.archive_sha256), 64)
            self.assertEqual(receipt.categories[1]["rowCount"], 2)
            self.assertEqual(receipt.categories[1]["groupCount"], 1)
            self.assertEqual(receipt.categories[3]["rowCount"], 1)
            self.assertEqual(receipt.missing_category_ids, ())

            panel_path = panel_dir / "category-1" / "2025-02-01.jsonl.gz"
            self.assertTrue(panel_path.is_file())
            with gzip.open(panel_path, "rt", encoding="utf-8") as handle:
                rows = [json.loads(line) for line in handle]
            self.assertEqual(len(rows), 2)
            self.assertEqual(rows[0]["productId"], 605)
            self.assertEqual(rows[0]["price"], 1.99)
            self.assertEqual(rows[0]["priceField"], "marketPrice")
            self.assertNotIn("directLowPrice", rows[0])  # null fields are dropped
            self.assertEqual(rows[0]["groupId"], 100)

            # Archive is deleted by default once the pass succeeds.
            self.assertFalse((archive_dir / "prices-2025-02-01.ppmd.7z").exists())

    def test_resume_skips_refetch_when_archive_already_downloaded(self):
        day = date(2025, 2, 1)
        fixture = {(day, 1, 100): [PRICE]}
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive_dir = root / "archives"
            panel_dir = root / "panel"
            archive_dir.mkdir(parents=True)
            (archive_dir / "prices-2025-02-01.ppmd.7z").write_bytes(b"fixture-archive-bytes")

            def _refuse_fetch(url: str) -> bytes:
                raise AssertionError("fetch_archive must not be called when the archive is already on disk")

            receipt = process_archive_date(
                day, [1],
                archive_dir=archive_dir,
                panel_dir=panel_dir,
                keep_archive=True,
                fetch_archive=_refuse_fetch,
                extract_archive=fake_extract(fixture),
            )
            self.assertEqual(receipt.categories[1]["rowCount"], 1)

    def test_missing_price_fields_are_rejected_and_not_written(self):
        day = date(2025, 2, 1)
        fixture = {
            (day, 1, 100): [
                PRICE,
                {**PRICE, "productId": None},  # invalid product id
                {**PRICE, "productId": 610, "subTypeName": ""},  # missing subtype
                {
                    "productId": 611, "subTypeName": "Normal",
                    "lowPrice": None, "midPrice": None, "highPrice": None,
                    "marketPrice": None, "directLowPrice": None,
                },  # no price data at all
                {**PRICE},  # duplicate of the first row (productId 605 / "Normal")
            ],
        }
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            receipt = process_archive_date(
                day, [1],
                archive_dir=root / "archives",
                panel_dir=root / "panel",
                fetch_archive=lambda url: b"fixture-archive-bytes",
                extract_archive=fake_extract(fixture),
            )
            self.assertEqual(receipt.categories[1]["rowCount"], 1)
            self.assertEqual(receipt.categories[1]["rejectCount"], 4)
            self.assertEqual(receipt.reject_counts.get("invalid_product_id"), 1)
            self.assertEqual(receipt.reject_counts.get("missing_subtype_name"), 1)
            self.assertEqual(receipt.reject_counts.get("no_price_data"), 1)
            self.assertEqual(receipt.reject_counts.get("duplicate_series"), 1)

    def test_malformed_member_payload_is_rejected_not_fatal(self):
        day = date(2025, 2, 1)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)

            def extract(archive_bytes: bytes, dest_dir: Path) -> None:
                member = dest_dir / day.isoformat() / "1" / "100" / "prices"
                member.parent.mkdir(parents=True)
                member.write_text("not json", encoding="utf-8")
                _write_member(dest_dir, day, 1, 200, [PRICE])

            receipt = process_archive_date(
                day, [1],
                archive_dir=root / "archives",
                panel_dir=root / "panel",
                fetch_archive=lambda url: b"fixture-archive-bytes",
                extract_archive=extract,
            )
            self.assertEqual(receipt.reject_counts.get("invalid_member_json"), 1)
            self.assertEqual(receipt.categories[1]["rowCount"], 1)

    def test_all_requested_categories_missing_from_archive_is_fatal(self):
        day = date(2025, 2, 1)
        fixture = {(day, 3, 200): [PRICE]}
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with self.assertRaisesRegex(TCGCSVPanelError, "none of the requested categories"):
                process_archive_date(
                    day, [1],
                    archive_dir=root / "archives",
                    panel_dir=root / "panel",
                    fetch_archive=lambda url: b"fixture-archive-bytes",
                    extract_archive=fake_extract(fixture),
                )

    def test_partial_category_miss_is_recorded_not_fatal(self):
        day = date(2025, 2, 1)
        fixture = {(day, 1, 100): [PRICE]}
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            receipt = process_archive_date(
                day, [1, 85],
                archive_dir=root / "archives",
                panel_dir=root / "panel",
                fetch_archive=lambda url: b"fixture-archive-bytes",
                extract_archive=fake_extract(fixture),
            )
            self.assertEqual(receipt.missing_category_ids, (85,))
            self.assertEqual(receipt.categories[1]["rowCount"], 1)

    def test_404_raises_unavailable_not_a_generic_error(self):
        day = date(2024, 1, 1)

        def fetch(url: str) -> bytes:
            raise TCGCSVPanelUnavailable("no archive published for this date (HTTP 404)")

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with self.assertRaises(TCGCSVPanelUnavailable):
                process_archive_date(
                    day, [1],
                    archive_dir=root / "archives",
                    panel_dir=root / "panel",
                    fetch_archive=fetch,
                    extract_archive=fake_extract({}),
                )


class SummarizePanelTests(unittest.TestCase):
    def test_reads_back_row_and_variant_counts_across_dates(self):
        with tempfile.TemporaryDirectory() as temporary:
            panel_dir = Path(temporary)
            category_dir = panel_dir / "category-1"
            category_dir.mkdir(parents=True)
            for day, rows in (
                (date(2025, 2, 1), [{"groupId": 1, "productId": 605, "subTypeName": "Normal", "price": 1.0, "priceField": "marketPrice"}]),
                (date(2025, 2, 8), [
                    {"groupId": 1, "productId": 605, "subTypeName": "Normal", "price": 1.1, "priceField": "marketPrice"},
                    {"groupId": 1, "productId": 606, "subTypeName": "Foil", "price": 5.0, "priceField": "marketPrice"},
                ]),
            ):
                path = category_dir / f"{day.isoformat()}.jsonl.gz"
                with gzip.open(path, "wt", encoding="utf-8") as handle:
                    for row in rows:
                        handle.write(json.dumps(row) + "\n")

            summaries = summarize_panel(panel_dir, [1, 85])
            by_category = {item.category_id: item for item in summaries}
            self.assertEqual(by_category[1].dates_covered, 2)
            self.assertEqual(by_category[1].row_count, 3)
            self.assertEqual(by_category[1].variant_count, 2)
            self.assertEqual(by_category[1].earliest_date, date(2025, 2, 1))
            self.assertEqual(by_category[1].latest_date, date(2025, 2, 8))
            self.assertEqual(by_category[85].dates_covered, 0)
            self.assertEqual(by_category[85].row_count, 0)


if __name__ == "__main__":
    unittest.main()
