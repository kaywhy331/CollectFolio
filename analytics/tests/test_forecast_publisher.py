import gzip
import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from collectfolio_analytics.forecast_publisher import (
    DEFAULT_MAX_OBJECT_BYTES,
    GroupPart,
    is_packet_eligible,
    load_serving_eligibility,
    load_source_terms,
    object_key,
    publish_category,
    publish_forecasts,
    split_group_variants_deterministic,
)
from collectfolio_analytics.tcgcsv import assert_tcgcsv_community_free_access_terms
from dataclasses import replace as dataclass_replace

from collectfolio_analytics.market_pipeline import SourceTerms

REPO_ROOT = Path(__file__).resolve().parents[2]
SOURCE_TERMS_PATH = REPO_ROOT / "analytics/manifests/tcgcsv-community-free-access-derived-forecasts.json"
EVALUATION_SUMMARY_PATH = REPO_ROOT / "docs/receipts/trajectory-v1/evaluation-summary.json"


def _variant(product_id, sub_type="Normal", *, confidence="standard", price=5.0, medium_path_points=1):
    return {
        "modelVersion": "trajectory-v1",
        "categoryId": 3,
        "groupId": 1,
        "productId": product_id,
        "subTypeName": sub_type,
        "confidence": confidence,
        "sampleSize": 10,
        "volatilityBucket": "low",
        "lastKnownDate": "2026-01-01",
        "lastKnownPrice": price,
        "asOf": "2026-01-01T00:00:00+00:00",
        "horizons": {
            "30": {"q10": 1, "q25": 2, "q50": 3, "q75": 4, "q90": 5},
            "90": {"q10": 1, "q25": 2, "q50": 3, "q75": 4, "q90": 5},
        },
        "medianPath": [
            {"date": f"2026-01-{d:02d}", "price": price + d * 0.123456}
            for d in range(1, 1 + medium_path_points)
        ],
    }


def _write_packets(path: Path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(path, "wt", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row) + "\n")


class IsPacketEligibleTests(unittest.TestCase):
    def setUp(self):
        self.serving_eligibility = {
            3: {"standard": True, "low-history": False, "insufficient-history": False},
            1: {"standard": False, "low-history": False, "insufficient-history": False},
        }

    def test_cat3_standard_is_eligible(self):
        self.assertTrue(is_packet_eligible(3, "standard", self.serving_eligibility))

    def test_cat3_low_history_is_not_eligible(self):
        self.assertFalse(is_packet_eligible(3, "low-history", self.serving_eligibility))

    def test_cold_start_is_always_eligible(self):
        self.assertTrue(is_packet_eligible(3, "cold-start", self.serving_eligibility))
        self.assertTrue(is_packet_eligible(1, "cold-start", self.serving_eligibility))
        self.assertTrue(is_packet_eligible(999, "cold-start", self.serving_eligibility))

    def test_unknown_category_is_not_eligible(self):
        self.assertFalse(is_packet_eligible(999, "standard", self.serving_eligibility))

    def test_unknown_cohort_string_is_not_eligible(self):
        self.assertFalse(is_packet_eligible(3, "mystery-cohort", self.serving_eligibility))


class LoadServingEligibilityTests(unittest.TestCase):
    def test_real_evaluation_summary_matches_fail_closed_gate(self):
        by_category = load_serving_eligibility(EVALUATION_SUMMARY_PATH)
        self.assertTrue(by_category[3]["standard"])
        self.assertFalse(by_category[1]["standard"])
        self.assertFalse(by_category[2]["standard"])
        self.assertFalse(by_category[85]["standard"])


class LoadSourceTermsTests(unittest.TestCase):
    def test_loads_expected_fields(self):
        terms = load_source_terms(SOURCE_TERMS_PATH)
        self.assertIsInstance(terms, SourceTerms)
        self.assertEqual(terms.decision, "approved")
        self.assertTrue(terms.commercial_use_allowed)
        self.assertTrue(terms.public_derived_display_allowed)
        self.assertFalse(terms.catalog_metadata_allowed)
        self.assertFalse(terms.public_raw_display_allowed)

    def test_gate_passes_for_real_manifest(self):
        terms = load_source_terms(SOURCE_TERMS_PATH)
        assert_tcgcsv_community_free_access_terms(terms, datetime.now(timezone.utc))

    def test_gate_rejects_non_approved_decision(self):
        terms = load_source_terms(SOURCE_TERMS_PATH)
        rejected = dataclass_replace(terms, decision="pending")
        with self.assertRaises(PermissionError):
            assert_tcgcsv_community_free_access_terms(rejected, datetime.now(timezone.utc))

    def test_gate_rejects_missing_public_derived_display(self):
        terms = load_source_terms(SOURCE_TERMS_PATH)
        narrowed = dataclass_replace(terms, public_derived_display_allowed=False)
        with self.assertRaises(PermissionError):
            assert_tcgcsv_community_free_access_terms(narrowed, datetime.now(timezone.utc))

    def test_gate_rejects_raw_display_grant(self):
        terms = load_source_terms(SOURCE_TERMS_PATH)
        widened = dataclass_replace(terms, public_raw_display_allowed=True)
        with self.assertRaises(PermissionError):
            assert_tcgcsv_community_free_access_terms(widened, datetime.now(timezone.utc))


class ObjectKeyTests(unittest.TestCase):
    def test_single_part_has_no_part_suffix(self):
        self.assertEqual(object_key(3, 604, 1, 1), "forecasts/3/604.json.gz")

    def test_multi_part_has_part_suffix(self):
        self.assertEqual(object_key(3, 604, 2, 5), "forecasts/3/604.part2.json.gz")


class SplitGroupVariantsDeterministicTests(unittest.TestCase):
    def test_empty_input_returns_no_parts(self):
        self.assertEqual(split_group_variants_deterministic(3, 1, []), [])

    def test_small_group_fits_one_part_by_default(self):
        variants = [_variant(i) for i in range(5)]
        parts = split_group_variants_deterministic(3, 1, variants)
        self.assertEqual(len(parts), 1)
        self.assertEqual(parts[0].part, 1)
        self.assertEqual(parts[0].parts_total, 1)
        self.assertEqual(len(parts[0].variants), 5)
        self.assertLessEqual(len(parts[0].gzip_bytes), DEFAULT_MAX_OBJECT_BYTES)
        self.assertFalse(parts[0].oversized)

    def test_never_drops_a_variant_across_parts(self):
        variants = [_variant(i, price=float(i), medium_path_points=14) for i in range(200)]
        parts = split_group_variants_deterministic(3, 1, variants, max_object_bytes=2_000)
        self.assertGreater(len(parts), 1)
        seen_product_ids = sorted(
            variant["productId"] for part in parts for variant in part.variants
        )
        self.assertEqual(seen_product_ids, list(range(200)))

    def test_every_part_stays_within_budget_unless_flagged_oversized(self):
        variants = [_variant(i, price=float(i), medium_path_points=14) for i in range(200)]
        parts = split_group_variants_deterministic(3, 1, variants, max_object_bytes=2_000)
        for part in parts:
            if not part.oversized:
                self.assertLessEqual(len(part.gzip_bytes), 2_000)

    def test_parts_total_and_numbering_are_consistent(self):
        variants = [_variant(i, price=float(i), medium_path_points=14) for i in range(200)]
        parts = split_group_variants_deterministic(3, 1, variants, max_object_bytes=2_000)
        self.assertEqual([part.part for part in parts], list(range(1, len(parts) + 1)))
        self.assertTrue(all(part.parts_total == len(parts) for part in parts))

    def test_correctly_numbered_size_check_not_just_probe_numbering(self):
        # Regression: a chunk that fits the part=1/partsTotal=1 probe used
        # by _max_fitting_prefix can still land over budget once rebuilt
        # with its REAL final numbering, because gzip compressed size is
        # not simply additive with content length -- perturbing even a
        # same-width digit can shift the compressed byte stream by a byte
        # or two. Found on real cat3 group 2374 data (1392 variants,
        # 128KiB budget): the first 706-variant chunk fit the probe at
        # part=1/partsTotal=1 (131071B) but the correctly-numbered
        # part=1/partsTotal=2 payload came out to 131073B, 1 byte over.
        # Every produced part must respect the budget against its REAL
        # numbering, not just the probe's.
        variants = [_variant(i, price=float(i) * 1.7, medium_path_points=14) for i in range(1500)]
        max_object_bytes = 4_000
        parts = split_group_variants_deterministic(3, 1, variants, max_object_bytes=max_object_bytes)
        self.assertGreater(len(parts), 1)
        for part in parts:
            real_payload_bytes = len(part.gzip_bytes)
            if not part.oversized:
                self.assertLessEqual(real_payload_bytes, max_object_bytes)
            else:
                # only ever legitimate for a lone, unsplittable variant
                self.assertEqual(len(part.variants), 1)
        seen_product_ids = sorted(v["productId"] for p in parts for v in p.variants)
        self.assertEqual(seen_product_ids, list(range(1500)))

    def test_single_oversized_variant_becomes_its_own_flagged_part_not_dropped(self):
        huge = _variant(0, medium_path_points=400)
        parts = split_group_variants_deterministic(3, 1, [huge], max_object_bytes=50)
        self.assertEqual(len(parts), 1)
        self.assertTrue(parts[0].oversized)
        self.assertEqual(len(parts[0].variants), 1)

    def test_deterministic_regardless_of_input_order(self):
        variants = [_variant(i, price=float(i), medium_path_points=14) for i in range(200)]
        parts_forward = split_group_variants_deterministic(3, 1, variants, max_object_bytes=2_000)
        parts_reversed = split_group_variants_deterministic(
            3, 1, list(reversed(variants)), max_object_bytes=2_000
        )
        self.assertEqual(
            [part.gzip_bytes for part in parts_forward],
            [part.gzip_bytes for part in parts_reversed],
        )

    def test_deterministic_across_repeated_calls(self):
        variants = [_variant(i, price=float(i), medium_path_points=14) for i in range(200)]
        first = split_group_variants_deterministic(3, 1, variants, max_object_bytes=2_000)
        second = split_group_variants_deterministic(3, 1, variants, max_object_bytes=2_000)
        self.assertEqual([p.gzip_bytes for p in first], [p.gzip_bytes for p in second])


class PublishCategoryTests(unittest.TestCase):
    def setUp(self):
        self.serving_eligibility = {
            3: {"standard": True, "low-history": False, "insufficient-history": False},
            1: {"standard": False, "low-history": False, "insufficient-history": False},
        }

    def test_group_with_only_excluded_cohort_is_excluded_not_dropped(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            packets_path = tmp_path / "packets.jsonl.gz"
            _write_packets(packets_path, [
                {**_variant(1), "categoryId": 1, "groupId": 5, "confidence": "low-history"},
            ])
            staging_root = tmp_path / "out"
            row = publish_category(1, packets_path, self.serving_eligibility, staging_root)
            self.assertEqual(row["groups"]["5"]["status"], "excluded")
            self.assertEqual(row["publishedGroups"], 0)
            self.assertEqual(row["excludedGroups"], 1)
            self.assertEqual(row["objectsWritten"], 0)

    def test_group_with_mixed_cohorts_publishes_only_eligible_variants(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            packets_path = tmp_path / "packets.jsonl.gz"
            standard = {**_variant(10), "categoryId": 3, "groupId": 7, "confidence": "standard"}
            low_history = {**_variant(11), "categoryId": 3, "groupId": 7, "confidence": "low-history"}
            cold_start = {**_variant(12), "categoryId": 3, "groupId": 7, "confidence": "cold-start"}
            _write_packets(packets_path, [standard, low_history, cold_start])
            staging_root = tmp_path / "out"
            row = publish_category(3, packets_path, self.serving_eligibility, staging_root)
            group = row["groups"]["7"]
            self.assertEqual(group["status"], "published")
            self.assertEqual(group["eligibleVariantCount"], 2)
            self.assertEqual(row["excludedByCohort"], {"low-history": 1})

            written_key = group["parts"][0]["objectKey"]
            dest = staging_root / written_key
            self.assertTrue(dest.is_file())
            payload = json.loads(gzip.decompress(dest.read_bytes()))
            product_ids = sorted(v["productId"] for v in payload["variants"])
            self.assertEqual(product_ids, [10, 12])

    def test_content_hash_matches_written_object_bytes(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            packets_path = tmp_path / "packets.jsonl.gz"
            _write_packets(packets_path, [
                {**_variant(1), "categoryId": 3, "groupId": 1, "confidence": "standard"},
            ])
            staging_root = tmp_path / "out"
            row = publish_category(3, packets_path, self.serving_eligibility, staging_root)
            part = row["groups"]["1"]["parts"][0]
            dest = staging_root / part["objectKey"]
            import hashlib
            self.assertEqual(part["contentHash"], hashlib.sha256(dest.read_bytes()).hexdigest())

    def test_null_last_known_date_is_excluded_from_range_not_stringified(self):
        # cold-start packets carry lastKnownDate: null (no observed price
        # history yet); the range must skip them, not coerce to "None"
        # (which would sort ahead of real ISO date strings and corrupt
        # the T6 staleness-rule range).
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            packets_path = tmp_path / "packets.jsonl.gz"
            cold_start_no_date = {
                **_variant(1), "categoryId": 3, "groupId": 1, "confidence": "cold-start",
                "lastKnownDate": None, "lastKnownPrice": None,
            }
            standard_with_date = {
                **_variant(2), "categoryId": 3, "groupId": 1, "confidence": "standard",
                "lastKnownDate": "2026-06-20",
            }
            _write_packets(packets_path, [cold_start_no_date, standard_with_date])
            staging_root = tmp_path / "out"
            row = publish_category(3, packets_path, self.serving_eligibility, staging_root)
            self.assertEqual(row["lastKnownDateRange"]["earliest"], "2026-06-20")
            self.assertEqual(row["lastKnownDateRange"]["latest"], "2026-06-20")

    def test_last_known_date_range_reflects_eligible_variants_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            packets_path = tmp_path / "packets.jsonl.gz"
            eligible = {**_variant(1), "categoryId": 3, "groupId": 1, "confidence": "standard",
                        "lastKnownDate": "2026-02-01"}
            excluded = {**_variant(2), "categoryId": 3, "groupId": 1, "confidence": "low-history",
                        "lastKnownDate": "2020-01-01"}
            _write_packets(packets_path, [eligible, excluded])
            staging_root = tmp_path / "out"
            row = publish_category(3, packets_path, self.serving_eligibility, staging_root)
            self.assertEqual(row["lastKnownDateRange"]["earliest"], "2026-02-01")
            self.assertEqual(row["lastKnownDateRange"]["latest"], "2026-02-01")


class PublishForecastsTests(unittest.TestCase):
    def test_end_to_end_writes_manifest_and_objects(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            packets_dir = tmp_path / "packets"
            _write_packets(packets_dir / "category-3" / "packets.jsonl.gz", [
                {**_variant(1), "categoryId": 3, "groupId": 1, "confidence": "standard"},
                {**_variant(2), "categoryId": 3, "groupId": 1, "confidence": "low-history"},
            ])
            _write_packets(packets_dir / "category-1" / "packets.jsonl.gz", [
                {**_variant(3), "categoryId": 1, "groupId": 9, "confidence": "cold-start"},
            ])
            staging_root = tmp_path / "out"

            manifest = publish_forecasts(
                packets_dir, EVALUATION_SUMMARY_PATH, SOURCE_TERMS_PATH, staging_root,
            )

            manifest_path = staging_root / "forecasts" / "manifest.json"
            self.assertTrue(manifest_path.is_file())
            on_disk = json.loads(manifest_path.read_text(encoding="utf-8"))
            self.assertEqual(on_disk["manifestContentHash"], manifest["manifestContentHash"])

            self.assertEqual(manifest["categories"]["3"]["eligibleVariants"], 1)
            self.assertEqual(manifest["categories"]["1"]["eligibleVariants"], 1)
            self.assertTrue(manifest["eligibilityPolicy"]["3"]["standard"])
            self.assertTrue(manifest["eligibilityPolicy"]["1"]["cold-start"])
            self.assertFalse(manifest["eligibilityPolicy"]["1"]["standard"])

            cat3_object = staging_root / "forecasts" / "3" / "1.json.gz"
            self.assertTrue(cat3_object.is_file())
            cat1_object = staging_root / "forecasts" / "1" / "9.json.gz"
            self.assertTrue(cat1_object.is_file())

    def test_category_ids_filters_to_requested_categories_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            packets_dir = tmp_path / "packets"
            _write_packets(packets_dir / "category-3" / "packets.jsonl.gz", [
                {**_variant(1), "categoryId": 3, "groupId": 1, "confidence": "standard"},
            ])
            _write_packets(packets_dir / "category-1" / "packets.jsonl.gz", [
                {**_variant(2), "categoryId": 1, "groupId": 2, "confidence": "cold-start"},
            ])
            staging_root = tmp_path / "out"
            manifest = publish_forecasts(
                packets_dir, EVALUATION_SUMMARY_PATH, SOURCE_TERMS_PATH, staging_root,
                category_ids=[3],
            )
            self.assertEqual(set(manifest["categories"].keys()), {"3"})
            self.assertFalse((staging_root / "forecasts" / "1").exists())

    def test_missing_packets_file_for_requested_category_raises(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            packets_dir = tmp_path / "packets"
            packets_dir.mkdir()
            staging_root = tmp_path / "out"
            with self.assertRaises(FileNotFoundError):
                publish_forecasts(
                    packets_dir, EVALUATION_SUMMARY_PATH, SOURCE_TERMS_PATH, staging_root,
                    category_ids=[3],
                )


if __name__ == "__main__":
    unittest.main()
