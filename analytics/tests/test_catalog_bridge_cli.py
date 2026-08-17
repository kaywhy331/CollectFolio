import gzip
import json
import tempfile
import unittest
from pathlib import Path

from collectfolio_analytics import catalog_bridge_cli


def _write_gzip_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(path, "wt", encoding="utf-8") as handle:
        handle.write(json.dumps(value))


class BuildCommandTests(unittest.TestCase):
    def test_build_matches_sets_and_products_and_writes_bridge_table(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            groups_cache = root / "trajectory" / "groups_metadata.json.gz"
            _write_gzip_json(groups_cache, {
                "groups": [
                    {
                        "category_id": 3, "group_id": 10, "name": "Silver Tempest",
                        "abbreviation": "SIT", "published_on": "2022-11-11",
                        "modified_on": "", "group_sha256": "x", "metadata": {"isSupplemental": False},
                    },
                ],
            })

            products_cache = root / "trajectory" / "hedonic" / "products_metadata.json.gz"
            _write_gzip_json(products_cache, {
                "fetchedGroups": [[3, 10]],
                "products": [
                    {
                        "category_id": 3, "group_id": 10, "product_id": 500,
                        "card_number": "007", "rarity": "Rare Holo VMAX",
                        "card_type": "single", "product_sha256": "y",
                    },
                ],
            })

            bridge_cache_dir = root / "bridge"
            _write_gzip_json(bridge_cache_dir / "pokemon" / "sets.json.gz", {
                "provider": "pokemon",
                "sets": [{"id": "swsh12", "name": "Silver Tempest", "abbreviation": "SIT", "releaseDate": "2022-11-11"}],
            })
            _write_gzip_json(bridge_cache_dir / "pokemon" / "cards.json.gz", {
                "provider": "pokemon",
                "cards": [{"id": "swsh12-7", "name": "Pikachu VMAX", "number": "7", "rarity": "Rare Holo VMAX", "setId": "swsh12"}],
            })

            out_path = root / "out.json.gz"
            exit_code = catalog_bridge_cli.main([
                "build", "--category-id", "3",
                "--cache-dir", str(bridge_cache_dir),
                "--groups-cache", str(groups_cache),
                "--products-cache", str(products_cache),
                "--out", str(out_path),
                "--as-of", "2026-08-17",
            ])
            self.assertEqual(exit_code, 0)

            with gzip.open(out_path, "rt", encoding="utf-8") as handle:
                bridge_table = json.load(handle)
            self.assertEqual(bridge_table["categoryId"], 3)
            self.assertEqual(bridge_table["provider"], "pokemon")
            self.assertEqual(len(bridge_table["sets"]), 1)
            self.assertEqual(bridge_table["sets"][0]["groupId"], 10)
            self.assertEqual(len(bridge_table["products"]), 1)
            self.assertEqual(bridge_table["products"][0]["providerCardId"], "swsh12-7")
            self.assertIn("contentHash", bridge_table)

    def test_build_without_receipts_flag_writes_no_receipt_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            groups_cache = root / "groups_metadata.json.gz"
            _write_gzip_json(groups_cache, {"groups": [
                {"category_id": 3, "group_id": 1, "name": "Some Set", "abbreviation": "SS", "published_on": ""},
            ]})
            bridge_cache_dir = root / "bridge"
            _write_gzip_json(bridge_cache_dir / "pokemon" / "sets.json.gz", {"provider": "pokemon", "sets": []})
            receipts_dir = root / "receipts"

            exit_code = catalog_bridge_cli.main([
                "build", "--category-id", "3",
                "--cache-dir", str(bridge_cache_dir),
                "--groups-cache", str(groups_cache),
                "--products-cache", str(root / "no-products.json.gz"),
                "--out", str(root / "out.json.gz"),
                "--receipts-dir", str(receipts_dir),
            ])
            self.assertEqual(exit_code, 0)
            self.assertFalse(receipts_dir.exists())

    def test_build_rejects_non_flagship_category(self):
        with self.assertRaises(SystemExit):
            catalog_bridge_cli._parser().parse_args(["build", "--category-id", "999"])


class FetchSetsCommandTests(unittest.TestCase):
    def test_fetch_sets_cli_wiring_writes_cache(self):
        import collectfolio_analytics.catalog_bridge_fetch as fetch_module

        original = fetch_module._default_fetch_json
        fetch_module._default_fetch_json = lambda *a, **k: {"data": [{"code": "neo", "name": "Neon Dynasty", "released_at": "2022-02-18"}]}
        try:
            with tempfile.TemporaryDirectory() as tmp:
                cache_dir = Path(tmp)
                exit_code = catalog_bridge_cli.main([
                    "fetch-sets", "--provider", "scryfall", "--cache-dir", str(cache_dir),
                ])
                self.assertEqual(exit_code, 0)
                self.assertTrue((cache_dir / "scryfall" / "sets.json.gz").is_file())
        finally:
            fetch_module._default_fetch_json = original


if __name__ == "__main__":
    unittest.main()
