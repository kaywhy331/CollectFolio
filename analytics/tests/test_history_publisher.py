import gzip
import json
import tempfile
import unittest
from dataclasses import replace as dataclass_replace
from datetime import datetime, timezone
from pathlib import Path

from collectfolio_analytics.forecast_publisher import load_source_terms
from collectfolio_analytics.history_publisher import (
    DEFAULT_MAX_OBJECT_BYTES,
    MAX_POINTS_PER_VARIANT,
    load_category_history,
    object_key,
    publish_category_history,
    publish_history,
    split_group_variants_deterministic,
)
from collectfolio_analytics.tcgcsv import assert_tcgcsv_community_free_access_history_terms

REPO_ROOT = Path(__file__).resolve().parents[2]
SOURCE_TERMS_PATH = REPO_ROOT / "analytics/manifests/tcgcsv-community-free-access-history.json"
AT = datetime(2026, 8, 17, tzinfo=timezone.utc)


def _write_panel_date(panel_dir: Path, category_id: int, date_str: str, rows):
    dest = Path(panel_dir) / f"category-{category_id}" / f"{date_str}.jsonl.gz"
    dest.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(dest, "wt", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row) + "\n")


class SourceTermsManifestTests(unittest.TestCase):
    def test_source_terms_manifest_loads_and_grants_raw_display_only(self):
        terms = load_source_terms(SOURCE_TERMS_PATH)
        self.assertTrue(terms.public_raw_display_allowed)
        self.assertFalse(terms.public_derived_display_allowed)
        self.assertFalse(terms.catalog_metadata_allowed)
        self.assertTrue(terms.commercial_use_allowed)

    def test_history_gate_passes_on_the_real_manifest(self):
        terms = load_source_terms(SOURCE_TERMS_PATH)
        assert_tcgcsv_community_free_access_history_terms(terms, AT)  # must not raise

    def test_history_gate_rejects_the_derived_forecast_record(self):
        # The T5 derived-forecast record explicitly does NOT grant raw
        # display -- history publication must refuse to run against it.
        derived_terms_path = REPO_ROOT / "analytics/manifests/tcgcsv-community-free-access-derived-forecasts.json"
        terms = load_source_terms(derived_terms_path)
        with self.assertRaises(PermissionError):
            assert_tcgcsv_community_free_access_history_terms(terms, AT)

    def test_history_gate_rejects_catalog_metadata_grant(self):
        terms = load_source_terms(SOURCE_TERMS_PATH)
        terms = dataclass_replace(terms, catalog_metadata_allowed=True)
        with self.assertRaises(PermissionError):
            assert_tcgcsv_community_free_access_history_terms(terms, AT)

    def test_history_gate_rejects_unapproved_decision(self):
        terms = load_source_terms(SOURCE_TERMS_PATH)
        terms = dataclass_replace(terms, decision="research_only")
        with self.assertRaises(PermissionError):
            assert_tcgcsv_community_free_access_history_terms(terms, AT)


class LoadCategoryHistoryTests(unittest.TestCase):
    def test_groups_variants_by_group_and_skips_nulls(self):
        with tempfile.TemporaryDirectory() as tmp:
            panel_dir = Path(tmp)
            _write_panel_date(panel_dir, 3, "2026-06-06", [
                {"groupId": 100, "productId": 5001, "subTypeName": "Holofoil", "price": 100.0},
                {"groupId": 100, "productId": 5002, "subTypeName": "Normal", "price": 0},  # skipped: non-positive
                {"groupId": 101, "productId": 6001, "subTypeName": "Normal", "price": 5.0},
            ])
            _write_panel_date(panel_dir, 3, "2026-06-13", [
                {"groupId": 100, "productId": 5001, "subTypeName": "Holofoil", "price": 101.0},
            ])

            by_group = load_category_history(panel_dir, 3)
            self.assertEqual(set(by_group.keys()), {100, 101})
            self.assertEqual(
                by_group[100][(5001, "Holofoil")],
                [("2026-06-06", 100.0), ("2026-06-13", 101.0)],
            )
            self.assertNotIn((5002, "Normal"), by_group[100])
            self.assertEqual(by_group[101][(6001, "Normal")], [("2026-06-06", 5.0)])

    def test_caps_points_per_variant_at_the_trailing_window(self):
        with tempfile.TemporaryDirectory() as tmp:
            panel_dir = Path(tmp)
            for week in range(MAX_POINTS_PER_VARIANT + 5):
                date_str = f"2026-{1 + week // 28:02d}-{1 + week % 28:02d}"
                _write_panel_date(panel_dir, 3, date_str, [
                    {"groupId": 100, "productId": 5001, "subTypeName": "Holofoil", "price": 100.0 + week},
                ])
            by_group = load_category_history(panel_dir, 3)
            self.assertEqual(len(by_group[100][(5001, "Holofoil")]), MAX_POINTS_PER_VARIANT)


class SplitDeterministicTests(unittest.TestCase):
    def test_empty_variants_produce_no_parts(self):
        self.assertEqual(split_group_variants_deterministic(3, 100, []), [])

    def test_single_object_when_it_fits(self):
        variants = [{"productId": 1, "subTypeName": "Normal", "points": [["2026-06-06", 1.0]]}]
        parts = split_group_variants_deterministic(3, 100, variants)
        self.assertEqual(len(parts), 1)
        self.assertEqual(parts[0].parts_total, 1)
        self.assertFalse(parts[0].oversized)
        self.assertEqual(object_key(3, 100, 1, 1), "history/3/100.json.gz")

    def test_splits_into_multiple_parts_when_too_large(self):
        # 80 points/variant * many variants comfortably exceeds a tiny cap.
        variants = [
            {
                "productId": i,
                "subTypeName": "Normal",
                "points": [[f"2026-{1 + (d // 28):02d}-{1 + (d % 28):02d}", 1.0 + d] for d in range(80)],
            }
            for i in range(1, 60)
        ]
        parts = split_group_variants_deterministic(3, 100, variants, max_object_bytes=512)
        self.assertGreater(len(parts), 1)
        seen_variants = set()
        for part in parts:
            self.assertEqual(part.parts_total, len(parts))
            for v in part.variants:
                seen_variants.add((v["productId"], v["subTypeName"]))
        self.assertEqual(len(seen_variants), len(variants))  # never drops a variant

    def test_never_drops_a_single_oversized_variant(self):
        huge_points = [[f"2026-01-{(d % 28) + 1:02d}", 1.0 + d] for d in range(200)]
        variants = [{"productId": 1, "subTypeName": "Normal", "points": huge_points}]
        parts = split_group_variants_deterministic(3, 100, variants, max_object_bytes=16)
        self.assertEqual(len(parts), 1)
        self.assertTrue(parts[0].oversized)


class PublishCategoryHistoryTests(unittest.TestCase):
    def test_publishes_all_variants_no_eligibility_gate(self):
        with tempfile.TemporaryDirectory() as tmp:
            panel_dir = Path(tmp) / "panel"
            staging = Path(tmp) / "staging"
            _write_panel_date(panel_dir, 3, "2026-06-06", [
                {"groupId": 100, "productId": 5001, "subTypeName": "Holofoil", "price": 100.0},
                {"groupId": 100, "productId": 5002, "subTypeName": "Reverse Holofoil", "price": 90.0},
            ])
            row = publish_category_history(3, panel_dir, staging)
            self.assertEqual(row["totalGroups"], 1)
            self.assertEqual(row["publishedGroups"], 1)
            self.assertEqual(row["totalVariants"], 2)
            self.assertEqual(row["objectsWritten"], 1)
            obj_path = staging / "history" / "3" / "100.json.gz"
            self.assertTrue(obj_path.is_file())
            body = json.loads(gzip.decompress(obj_path.read_bytes()))
            self.assertEqual(body["modelVersion"], "tcgcsv-history-v1")
            self.assertEqual(len(body["variants"]), 2)


class PublishHistoryEndToEndTests(unittest.TestCase):
    def test_full_run_writes_manifest_and_asserts_source_terms(self):
        with tempfile.TemporaryDirectory() as tmp:
            panel_dir = Path(tmp) / "panel"
            staging = Path(tmp) / "staging"
            _write_panel_date(panel_dir, 3, "2026-06-06", [
                {"groupId": 100, "productId": 5001, "subTypeName": "Holofoil", "price": 100.0},
            ])
            _write_panel_date(panel_dir, 85, "2026-06-06", [
                {"groupId": 200, "productId": 9001, "subTypeName": "Normal", "price": 5.0},
            ])
            manifest = publish_history(
                panel_dir, SOURCE_TERMS_PATH, staging, category_ids=[3, 85], at=AT,
            )
            self.assertEqual(manifest["modelVersion"], "tcgcsv-history-v1")
            self.assertEqual(set(manifest["categories"].keys()), {"3", "85"})
            self.assertEqual(manifest["maxObjectBytes"], DEFAULT_MAX_OBJECT_BYTES)
            manifest_path = staging / "history" / "manifest.json"
            self.assertTrue(manifest_path.is_file())
            on_disk = json.loads(manifest_path.read_text(encoding="utf-8"))
            self.assertEqual(on_disk["manifestContentHash"], manifest["manifestContentHash"])

    def test_full_run_refuses_when_source_terms_deny_raw_display(self):
        with tempfile.TemporaryDirectory() as tmp:
            panel_dir = Path(tmp) / "panel"
            staging = Path(tmp) / "staging"
            _write_panel_date(panel_dir, 3, "2026-06-06", [
                {"groupId": 100, "productId": 5001, "subTypeName": "Holofoil", "price": 100.0},
            ])
            derived_terms_path = REPO_ROOT / "analytics/manifests/tcgcsv-community-free-access-derived-forecasts.json"
            with self.assertRaises(PermissionError):
                publish_history(panel_dir, derived_terms_path, staging, category_ids=[3], at=AT)
            self.assertFalse((staging / "history" / "manifest.json").exists())


if __name__ == "__main__":
    unittest.main()
