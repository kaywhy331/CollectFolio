import gzip
import json
import tempfile
import unittest
from datetime import date
from pathlib import Path

from collectfolio_analytics.hedonic_features import (
    ColdStartFeatureSet,
    HedonicFeatureError,
    PRODUCT_KIND_IDS,
    SET_FAMILY_IDS,
    cold_start_candidates,
    build_category_feature_rows,
    load_or_fetch_products_metadata,
    product_kind,
    set_family,
)


class SetFamilyTests(unittest.TestCase):
    def test_commander_matches(self):
        self.assertEqual(set_family("Commander Legends", False), "commander")

    def test_secret_lair_matches(self):
        self.assertEqual(set_family("Secret Lair Drop Series", False), "secret-lair")

    def test_falls_back_to_main_when_no_pattern_matches(self):
        self.assertEqual(set_family("Some Ordinary Expansion", False), "main")

    def test_falls_back_to_other_supplemental_when_flagged(self):
        self.assertEqual(set_family("Totally Generic Release", True), "other-supplemental")

    def test_none_name_does_not_raise(self):
        self.assertIn(set_family(None, False), SET_FAMILY_IDS)


class ProductKindTests(unittest.TestCase):
    def test_has_card_number_is_single(self):
        self.assertEqual(product_kind("123", None), "single")

    def test_has_rarity_is_single(self):
        self.assertEqual(product_kind(None, "Rare"), "single")

    def test_neither_is_sealed(self):
        self.assertEqual(product_kind(None, None), "sealed")
        self.assertEqual(product_kind("", "  "), "sealed")

    def test_ids_tuple_contains_unknown(self):
        self.assertIn("unknown", PRODUCT_KIND_IDS)


def _write_panel_file(panel_dir: Path, category_id: int, day: date, rows: list[dict]) -> None:
    path = panel_dir / f"category-{category_id}" / f"{day.isoformat()}.jsonl.gz"
    path.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(path, "wt", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row) + "\n")


class BuildCategoryFeatureRowsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.panel_dir = Path(self.tmp.name) / "panel"
        self.category_id = 777
        self.dates = [date(2025, 1, 5), date(2025, 1, 12)]
        _write_panel_file(
            self.panel_dir, self.category_id, self.dates[0],
            [
                {"groupId": 10, "productId": 1, "subTypeName": "Normal", "price": 5.0},
                {"groupId": 10, "productId": 2, "subTypeName": "Holofoil", "price": 25.0},
            ],
        )
        _write_panel_file(
            self.panel_dir, self.category_id, self.dates[1],
            [
                {"groupId": 10, "productId": 1, "subTypeName": "Normal", "price": 5.5},
            ],
        )
        self.groups_metadata = {
            (self.category_id, 10): {
                "category_id": self.category_id, "group_id": 10,
                "name": "Commander Masters", "published_on": "2024-12-01",
            },
        }

    def test_row_count_matches_priced_variants(self):
        fs = build_category_feature_rows(
            self.panel_dir, self.category_id, self.dates, self.groups_metadata, None, self.dates[-1],
        )
        self.assertEqual(len(fs.rows), 2)
        self.assertTrue(all(fs.has_history))
        self.assertTrue(all(not v != v for v in fs.log_price))  # no NaN

    def test_kind_is_unknown_without_products_metadata(self):
        fs = build_category_feature_rows(
            self.panel_dir, self.category_id, self.dates, self.groups_metadata, None, self.dates[-1],
        )
        for row in fs.rows:
            self.assertEqual(row.categorical["productKind"], "unknown")

    def test_kind_uses_products_metadata_when_available(self):
        products_metadata = {
            (self.category_id, 1): {"card_number": "007", "rarity": "Rare"},
            (self.category_id, 2): {"card_number": "", "rarity": ""},
        }
        fs = build_category_feature_rows(
            self.panel_dir, self.category_id, self.dates, self.groups_metadata, products_metadata, self.dates[-1],
        )
        kinds = dict(zip(fs.keys, (row.categorical["productKind"] for row in fs.rows)))
        self.assertEqual(kinds[(1, "Normal")], "single")
        self.assertEqual(kinds[(2, "Holofoil")], "sealed")

    def test_set_family_derived_from_group_name(self):
        fs = build_category_feature_rows(
            self.panel_dir, self.category_id, self.dates, self.groups_metadata, None, self.dates[-1],
        )
        self.assertTrue(all(row.categorical["setFamily"] == "commander" for row in fs.rows))


class ColdStartCandidatesTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.panel_dir = Path(self.tmp.name) / "panel"
        self.category_id = 778
        self.dates = [date(2025, 1, 5)]
        _write_panel_file(
            self.panel_dir, self.category_id, self.dates[0],
            [{"groupId": 20, "productId": 1, "subTypeName": "Normal", "price": 10.0}],
        )
        self.groups_metadata = {
            (self.category_id, 20): {
                "category_id": self.category_id, "group_id": 20,
                "name": "Some Set", "published_on": "2024-12-01",
            },
        }

    def test_empty_without_products_metadata(self):
        cs = cold_start_candidates(
            self.panel_dir, self.category_id, self.dates, self.groups_metadata, None, self.dates[-1],
        )
        self.assertEqual(cs.keys, ())

    def test_only_never_priced_products_are_candidates(self):
        products_metadata = {
            (self.category_id, 1): {"group_id": 20, "card_number": "001", "rarity": "Common"},
            (self.category_id, 2): {"group_id": 20, "card_number": "002", "rarity": "Rare"},
        }
        cs = cold_start_candidates(
            self.panel_dir, self.category_id, self.dates, self.groups_metadata, products_metadata, self.dates[-1],
        )
        # product 1 already has a price -> excluded; product 2 never priced -> candidate.
        self.assertEqual(len(cs.keys), 1)
        self.assertEqual(cs.keys[0][0], 2)
        self.assertEqual(cs.group_by_key[cs.keys[0]], 20)

    def test_candidate_rows_carry_group_level_features(self):
        products_metadata = {
            (self.category_id, 2): {"group_id": 20, "card_number": "002", "rarity": "Mythic"},
        }
        cs = cold_start_candidates(
            self.panel_dir, self.category_id, self.dates, self.groups_metadata, products_metadata, self.dates[-1],
        )
        self.assertEqual(len(cs.rows), 1)
        self.assertEqual(cs.rows[0].categorical["rarity"], "Mythic")
        self.assertEqual(cs.rows[0].categorical["productKind"], "single")
        self.assertIn("releaseAgeWeeks", cs.rows[0].continuous)


class LoadOrFetchProductsMetadataTests(unittest.TestCase):
    def test_fetches_new_groups_and_caches(self):
        calls = []

        def fake_fetch(category_id, group_id):
            calls.append((category_id, group_id))
            return {
                "success": True,
                "results": [
                    {
                        "productId": 100 + group_id,
                        "name": "Test Card",
                        "cleanName": "Test Card",
                        "extendedData": [
                            {"name": "Number", "value": "007"},
                            {"name": "Rarity", "value": "Rare"},
                        ],
                    }
                ],
            }

        with tempfile.TemporaryDirectory() as tmp:
            cache_path = Path(tmp) / "products.json.gz"
            products, result = load_or_fetch_products_metadata(
                cache_path, [(85, 1), (85, 2)], fetch_json=fake_fetch, sleep=lambda _s: None,
            )
            self.assertEqual(result.groups_fetched_this_call, 2)
            self.assertEqual(result.groups_failed_this_call, 0)
            self.assertFalse(result.truncated)
            self.assertEqual(len(products), 2)
            self.assertEqual(sorted(calls), [(85, 1), (85, 2)])

    def test_second_call_skips_already_cached_groups(self):
        calls = []

        def fake_fetch(category_id, group_id):
            calls.append((category_id, group_id))
            return {"success": True, "results": []}

        with tempfile.TemporaryDirectory() as tmp:
            cache_path = Path(tmp) / "products.json.gz"
            load_or_fetch_products_metadata(cache_path, [(85, 1)], fetch_json=fake_fetch, sleep=lambda _s: None)
            load_or_fetch_products_metadata(cache_path, [(85, 1)], fetch_json=fake_fetch, sleep=lambda _s: None)
            self.assertEqual(calls, [(85, 1)])

    def test_max_requests_truncates_and_is_resumable(self):
        calls = []

        def fake_fetch(category_id, group_id):
            calls.append((category_id, group_id))
            return {"success": True, "results": []}

        with tempfile.TemporaryDirectory() as tmp:
            cache_path = Path(tmp) / "products.json.gz"
            _products, result1 = load_or_fetch_products_metadata(
                cache_path, [(85, 1), (85, 2), (85, 3)], fetch_json=fake_fetch,
                max_requests=1, sleep=lambda _s: None,
            )
            self.assertTrue(result1.truncated)
            self.assertEqual(result1.groups_fetched_this_call, 1)

            _products2, result2 = load_or_fetch_products_metadata(
                cache_path, [(85, 1), (85, 2), (85, 3)], fetch_json=fake_fetch,
                max_requests=10, sleep=lambda _s: None,
            )
            self.assertFalse(result2.truncated)
            self.assertEqual(result2.groups_already_cached, 1)
            self.assertEqual(len(calls), 3)  # 1 + 2, none repeated


if __name__ == "__main__":
    unittest.main()
