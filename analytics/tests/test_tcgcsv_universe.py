from datetime import date, datetime, timedelta, timezone
import csv
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

from collectfolio_analytics.tcgcsv_universe import (
    FEATURE_COLUMNS,
    FORECAST_HORIZONS,
    PRICE_COLUMNS,
    PriceFact,
    TCGCSVUniverseError,
    build_shadow_feature,
    is_card_category,
    normalize_category,
    normalize_extracted_archive,
    normalize_group,
    normalize_product,
    plan_catalog_refresh,
    set_feature_record,
)
from collectfolio_analytics.tcgcsv_universe_io import (
    compile_market_feature_csvs,
    write_price_parquet,
)
from collectfolio_analytics.tcgcsv_universe_cli import _resolve_archive_date, _timestamp


PRICE = {
    "productId": 590027,
    "subTypeName": "Holofoil",
    "lowPrice": 277.55,
    "midPrice": 349.99,
    "highPrice": 2808.27,
    "marketPrice": 310.79,
    "directLowPrice": 290.01,
}
SOURCE_AVAILABLE = datetime(2026, 8, 15, 6, 41, tzinfo=timezone.utc)


class TCGCSVUniverseTests(unittest.TestCase):
    def test_category_policy_uses_provider_labels_and_reviewed_exceptions(self):
        self.assertTrue(is_card_category({
            "categoryId": 3, "name": "Pokemon", "nonSealedLabel": "Single Cards"
        }))
        self.assertTrue(is_card_category({
            "categoryId": 72, "name": "Battle Spirits Saga", "nonSealedLabel": None
        }))
        self.assertFalse(is_card_category({
            "categoryId": 31, "name": "Card Sleeves", "nonSealedLabel": "Non-Sealed Products"
        }))

    def test_catalog_normalization_omits_image_and_commerce_urls(self):
        category = normalize_category({
            "categoryId": 3, "name": "Pokemon", "displayName": "Pokémon",
            "sealedLabel": "Sealed Products", "nonSealedLabel": "Single Cards",
        })
        group = normalize_group(3, {
            "groupId": 23651, "name": "Surging Sparks", "abbreviation": "SV08",
            "publishedOn": "2024-11-08T00:00:00", "modifiedOn": "volatile",
        })
        product = normalize_product(3, 23651, {
            "productId": 590027,
            "name": "Pikachu ex - 238/191",
            "cleanName": "Pikachu ex 238 191",
            "imageUrl": "https://example.test/not-retained.png",
            "url": "https://example.test/not-retained",
            "extendedData": [
                {"name": "Number", "displayName": "Card Number", "value": "238/191"},
                {"name": "Rarity", "displayName": "Rarity", "value": "Special Illustration Rare"},
                {"name": "Card Type", "displayName": "Type", "value": "Lightning"},
            ],
        })
        self.assertTrue(category["is_card_category"])
        self.assertEqual(group["published_on"], "2024-11-08")
        self.assertEqual(product["card_number"], "238/191")
        self.assertEqual(product["rarity"], "Special Illustration Rare")
        self.assertEqual(product["card_type"], "Lightning")
        rendered = json.dumps(product)
        self.assertNotIn("imageUrl", rendered)
        self.assertNotIn("https://", rendered)

    def test_archive_normalization_streams_every_scoped_series_and_receipt(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            member = root / "2026-08-14" / "3" / "23651" / "prices"
            member.parent.mkdir(parents=True)
            member.write_text(json.dumps({
                "success": True,
                "errors": [],
                "results": [PRICE, {**PRICE, "subTypeName": "Reverse Holofoil", "marketPrice": None}],
            }), encoding="utf-8")
            ignored = root / "2026-08-14" / "31" / "1" / "prices"
            ignored.parent.mkdir(parents=True)
            ignored.write_text(json.dumps({"success": True, "results": [PRICE]}), encoding="utf-8")
            csv_path = root / "normalized.csv"

            result = normalize_extracted_archive(
                root, date(2026, 8, 14), [3], csv_path,
                source_available_at=SOURCE_AVAILABLE,
            )

            self.assertEqual(result.category_ids, (3,))
            self.assertEqual(result.price_count, 2)
            self.assertEqual(len(result.group_receipts), 1)
            self.assertEqual(result.group_receipts[0].row_count, 2)
            with csv_path.open(encoding="utf-8") as handle:
                rows = list(csv.DictReader(handle))
            self.assertEqual(rows[0]["archive_date"], "2026-08-14")
            self.assertEqual(rows[0]["source_available_at"], SOURCE_AVAILABLE.isoformat())
            self.assertEqual(rows[1]["market_price"], "")
            self.assertEqual(len(rows[0]["series_sha256"]), 64)
            self.assertEqual(len(rows[0]["price_tuple_sha256"]), 64)

    def test_archive_normalization_rejects_duplicate_series(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            member = root / "2026-08-14" / "3" / "23651" / "prices"
            member.parent.mkdir(parents=True)
            member.write_text(json.dumps({"success": True, "results": [PRICE, PRICE]}), encoding="utf-8")
            with self.assertRaisesRegex(TCGCSVUniverseError, "duplicate"):
                normalize_extracted_archive(
                    root, date(2026, 8, 14), [3], root / "prices.csv",
                    source_available_at=SOURCE_AVAILABLE,
                )

    def test_archive_normalization_fails_closed_when_requested_category_is_absent(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            member = root / "2026-08-14" / "3" / "23651" / "prices"
            member.parent.mkdir(parents=True)
            member.write_text(
                json.dumps({"success": True, "results": [PRICE]}),
                encoding="utf-8",
            )
            output = root / "prices.csv"
            with self.assertRaisesRegex(TCGCSVUniverseError, "missing requested card categories"):
                normalize_extracted_archive(
                    root, date(2026, 8, 14), [3, 85], output,
                    source_available_at=SOURCE_AVAILABLE,
                )
            self.assertFalse(output.exists())

    def test_archive_normalization_retains_reviewed_empty_categories_in_scope(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            member = root / "2026-08-14" / "3" / "23651" / "prices"
            member.parent.mkdir(parents=True)
            member.write_text(
                json.dumps({"success": True, "results": [PRICE]}),
                encoding="utf-8",
            )
            result = normalize_extracted_archive(
                root, date(2026, 8, 14), [3, 21, 84], root / "prices.csv",
                source_available_at=SOURCE_AVAILABLE,
                allowed_missing_category_ids=[21, 84],
            )
            self.assertEqual(result.category_ids, (3, 21, 84))
            self.assertEqual(result.empty_category_ids, (21, 84))
            self.assertEqual(result.price_count, 1)

    def test_archive_date_is_bound_to_exact_source_timestamp(self):
        source_updated = _timestamp("2026-08-14T20:05:48+0000")
        self.assertEqual(
            _resolve_archive_date(source_updated, "2026-08-14"),
            date(2026, 8, 14),
        )
        with self.assertRaisesRegex(TCGCSVUniverseError, "must match"):
            _resolve_archive_date(source_updated, "2026-08-13")

    def test_catalog_plan_covers_new_changed_unknown_and_one_audit_shard(self):
        audit_date = date(2026, 8, 14)
        groups = [
            {"category_id": 3, "group_id": 1, "group_sha256": "a", "modified_on": "1"},
            {"category_id": 3, "group_id": 2, "group_sha256": "b", "modified_on": "2"},
            {"category_id": 3, "group_id": 3, "group_sha256": "c", "modified_on": "3"},
        ]
        current = {
            (3, 1): {"group_sha256": "old", "modified_on": "1"},
            (3, 2): {"group_sha256": "b", "modified_on": "2"},
            (3, 3): {"group_sha256": "c", "modified_on": "3"},
        }
        plan = plan_catalog_refresh(
            groups, current_groups=current, unresolved_groups={(3, 2)},
            audit_date=audit_date, audit_cycle_days=1,
        )
        self.assertIn("semantic_group_change", plan[(3, 1)])
        self.assertIn("unknown_product", plan[(3, 2)])
        self.assertTrue(any("rotating_audit" in reasons for reasons in plan.values()))

    def test_shadow_feature_has_all_requested_horizons_and_ordered_ranges(self):
        metric = {
            "category_id": 3,
            "group_id": 23651,
            "product_id": 590027,
            "subtype_name": "Holofoil",
            "series_sha256": "a" * 64,
            "current_price": 100,
            "observation_count": 90,
            "return_7d": 0.02,
            "return_30d": 0.10,
            "return_90d": 0.20,
            "return_180d": None,
            "return_365d": None,
            "daily_log_slope_30d": 0.002,
            "volatility_30d": 0.03,
            "max_drawdown_365d": 0.15,
            "history_density_365d": 0.75,
            "source_available_at": SOURCE_AVAILABLE,
        }
        with self.assertRaisesRegex(TCGCSVUniverseError, "precedes source availability"):
            build_shadow_feature(metric, datetime(2026, 8, 14, 23, tzinfo=timezone.utc))
        feature = build_shadow_feature(metric, SOURCE_AVAILABLE)
        self.assertEqual(feature["estimate_status"], "research_only")
        self.assertEqual(tuple(map(int, feature["forecast_estimates"].keys())), FORECAST_HORIZONS)
        for forecast in feature["forecast_estimates"].values():
            self.assertLessEqual(forecast["q10"], forecast["q25"])
            self.assertLessEqual(forecast["q25"], forecast["q50"])
            self.assertLessEqual(forecast["q50"], forecast["q75"])
            self.assertLessEqual(forecast["q75"], forecast["q90"])
            self.assertTrue(forecast["researchOnly"])
        self.assertEqual(len(feature["feature_sha256"]), 64)

    def test_insufficient_history_does_not_invent_a_forecast(self):
        feature = build_shadow_feature({
            "category_id": 3, "group_id": 1, "product_id": 2,
            "subtype_name": "Normal", "series_sha256": "b" * 64,
            "current_price": 10, "observation_count": 1,
            "history_density_365d": 1 / 366,
            "source_available_at": SOURCE_AVAILABLE,
        }, SOURCE_AVAILABLE)
        self.assertEqual(feature["estimate_status"], "insufficient")
        self.assertEqual(feature["forecast_estimates"], {})
        self.assertIsNone(feature["opportunity_score"])

    def test_set_feature_requires_a_real_cohort(self):
        insufficient = set_feature_record({
            "category_id": 3, "group_id": 1, "series_count": 3,
            "priced_series_count": 3,
        })
        available = set_feature_record({
            "category_id": 3, "group_id": 2, "series_count": 20,
            "priced_series_count": 18, "median_return_30d": 0.08,
            "breadth_30d": 0.7, "median_volatility_30d": 0.04,
        })
        self.assertEqual(insufficient["feature_status"], "insufficient")
        self.assertEqual(available["feature_status"], "available")
        self.assertGreater(available["hotness_score"], 50)


@unittest.skipUnless(importlib.util.find_spec("duckdb"), "DuckDB optional dependency is absent")
class TCGCSVUniverseDuckDBTests(unittest.TestCase):
    def test_sparse_positive_history_becomes_insufficient_instead_of_nan(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            price_csv = root / "prices.csv"
            with price_csv.open("x", newline="", encoding="utf-8") as output:
                writer = csv.writer(output, lineterminator="\n")
                writer.writerow(PRICE_COLUMNS)
                writer.writerow(PriceFact.from_provider(
                    date(2026, 8, 14), 3, 23651, PRICE,
                    source_available_at=SOURCE_AVAILABLE,
                ).csv_row())
            parquet = root / "prices.parquet"
            write_price_parquet(price_csv, parquet)
            features = root / "features.csv"
            sets = root / "sets.csv"
            compile_market_feature_csvs(
                [parquet], as_of_date=date(2026, 8, 14),
                group_keys=[(3, 23651)], feature_csv_path=features,
                set_feature_csv_path=sets,
            )
            with features.open(encoding="utf-8") as handle:
                row = next(csv.DictReader(handle))
            self.assertEqual(row["estimate_status"], "insufficient")
            self.assertEqual(row["daily_log_slope_30d"], "")

    def test_parquet_and_feature_compiler_cover_current_null_and_empty_groups(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            price_csv = root / "prices.csv"
            with price_csv.open("x", newline="", encoding="utf-8") as output:
                writer = csv.writer(output, lineterminator="\n")
                writer.writerow(PRICE_COLUMNS)
                start = date(2026, 7, 15)
                for offset in range(31):
                    fact = PriceFact.from_provider(
                        start + timedelta(days=offset), 3, 23651,
                        {**PRICE, "marketPrice": 100 + offset},
                        source_available_at=datetime.combine(
                            start + timedelta(days=offset + 1),
                            datetime.min.time(), tzinfo=timezone.utc,
                        ),
                    )
                    writer.writerow(fact.csv_row())
                null_fact = PriceFact.from_provider(
                    date(2026, 8, 14), 3, 23651,
                    {**PRICE, "productId": 42, "subTypeName": "Normal", "marketPrice": None},
                    source_available_at=SOURCE_AVAILABLE,
                )
                writer.writerow(null_fact.csv_row())
            parquet = root / "prices.parquet"
            parquet_result = write_price_parquet(price_csv, parquet)
            self.assertEqual(parquet_result["rowCount"], 32)

            features = root / "features.csv"
            sets = root / "sets.csv"
            result = compile_market_feature_csvs(
                [parquet], as_of_date=date(2026, 8, 14),
                group_keys=[(3, 23651), (3, 99999)],
                feature_csv_path=features, set_feature_csv_path=sets,
            )
            self.assertEqual(result["featureCount"], 2)
            self.assertEqual(result["setFeatureCount"], 2)
            with features.open(encoding="utf-8") as handle:
                rows = list(csv.DictReader(handle))
            self.assertEqual(tuple(rows[0].keys()), FEATURE_COLUMNS)
            missing_market = next(row for row in rows if row["product_id"] == "42")
            self.assertEqual(missing_market["estimate_status"], "insufficient")
            with sets.open(encoding="utf-8") as handle:
                set_rows = list(csv.DictReader(handle))
            empty = next(row for row in set_rows if row["group_id"] == "99999")
            self.assertEqual(empty["feature_status"], "insufficient")


if __name__ == "__main__":
    unittest.main()
