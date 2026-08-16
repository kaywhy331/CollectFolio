from __future__ import annotations

from datetime import date, datetime, timezone
from decimal import Decimal
import json
from pathlib import Path
import tempfile
import unittest

try:
    import duckdb
    import ijson  # noqa: F401
except ImportError:  # pragma: no cover - optional local dependency
    duckdb = None

from collectfolio_analytics.tcgcsv_universe import canonical_json, content_hash
from collectfolio_analytics.tcgcsv_web_catalog import (
    TCGCSVWebCatalogError,
    WEB_CATALOG_CONTRACT_VERSION,
    build_web_catalog,
    normalize_search_text,
    search_prefixes,
)


def category(category_id: int, name: str) -> dict[str, object]:
    value = {
        "category_id": category_id,
        "name": name,
        "display_name": name,
        "is_card_category": True,
        "metadata": {"sealedLabel": "Sealed", "nonSealedLabel": "Cards"},
    }
    value["category_sha256"] = content_hash(value)
    return value


def group(category_id: int, group_id: int, name: str) -> dict[str, object]:
    value = {
        "category_id": category_id,
        "group_id": group_id,
        "name": name,
        "abbreviation": "SET",
        "published_on": "2026-08-01",
        "modified_on": "2026-08-02T00:00:00Z",
        "metadata": {"isSupplemental": False},
    }
    value["group_sha256"] = content_hash(value)
    return value


def product(category_id: int, group_id: int, product_id: int, name: str, number: str) -> dict[str, object]:
    value = {
        "category_id": category_id,
        "group_id": group_id,
        "product_id": product_id,
        "name": name,
        "clean_name": name,
        "card_number": number,
        "rarity": "Rare",
        "card_type": "Creature",
        "modified_on": "2026-08-02T00:00:00Z",
        "metadata": {"extendedData": [{"name": "Number", "displayName": "#", "value": number}]},
    }
    value["product_sha256"] = content_hash(value)
    return value


@unittest.skipIf(duckdb is None, "market-universe dependencies are not installed")
class TCGCSVWebCatalogTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        self.packet = self.base / "catalog.json"
        self.parquet = self.base / "prices.parquet"
        payload = {
            "contractVersion": "tcgcsv-market-universe-v1",
            "parserVersion": "test",
            "sourceId": "source",
            "termsReviewId": "review",
            "sourceUpdatedAt": "2026-08-15T20:05:57+00:00",
            "categories": [category(1, "Magic"), category(3, "Pokémon")],
            "groups": [group(1, 10, "Alpha"), group(3, 20, "Test Set"), group(3, 21, "Empty Set")],
            "products": [
                product(1, 10, 100, "Ábundance", "249"),
                product(3, 20, 200, "Pikachu", "001"),
                product(3, 20, 201, "No Price", "002"),
            ],
            "partial": False,
            "errors": [],
            "metadata": {"plannedProductGroupCount": 3, "successfulProductGroupCount": 3},
        }
        self.packet.write_text(canonical_json(payload), encoding="utf-8")
        connection = duckdb.connect()
        connection.execute("""
            create table prices(
              archive_date date, source_available_at timestamptz, category_id integer,
              group_id integer, product_id bigint, subtype_name varchar,
              series_sha256 varchar, low_price decimal(16,4), mid_price decimal(16,4),
              high_price decimal(16,4), market_price decimal(16,4),
              direct_low_price decimal(16,4), price_tuple_sha256 varchar
            )
        """)
        rows = [
            (date(2026, 8, 15), datetime(2026, 8, 15, 20, 5, 57, tzinfo=timezone.utc), 1, 10, 100, "Normal", "a" * 64, Decimal("2.1000"), Decimal("2.5000"), Decimal("3.0000"), Decimal("2.4000"), None, "b" * 64),
            (date(2026, 8, 15), datetime(2026, 8, 15, 20, 5, 57, tzinfo=timezone.utc), 1, 10, 100, "Foil", "c" * 64, Decimal("5.0000"), Decimal("6.0000"), Decimal("7.0000"), Decimal("6.5000"), Decimal("4.5000"), "d" * 64),
            (date(2026, 8, 15), datetime(2026, 8, 15, 20, 5, 57, tzinfo=timezone.utc), 3, 20, 200, "Holofoil", "e" * 64, Decimal("10.0000"), None, None, Decimal("12.3400"), None, "f" * 64),
        ]
        connection.executemany("insert into prices values (?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)
        connection.execute("copy prices to ? (format parquet)", [str(self.parquet)])
        connection.close()

    def tearDown(self) -> None:
        self.temp.cleanup()

    def read_block(self, output: Path, entry: dict[str, int], kind: str) -> object:
        path = output / f"{kind}-{entry['shard']:02d}.bin"
        with path.open("rb") as handle:
            handle.seek(entry["offset"])
            return json.loads(handle.read(entry["length"]))

    def test_full_catalog_is_deterministic_and_preserves_unpriced_products(self) -> None:
        first = self.base / "first"
        second = self.base / "second"
        built = build_web_catalog(self.packet, self.parquet, first, shard_count=4, search_page_bytes=32 * 1024)
        rebuilt = build_web_catalog(self.packet, self.parquet, second, shard_count=4, search_page_bytes=32 * 1024)
        self.assertEqual(built["publicationId"], rebuilt["publicationId"])
        self.assertEqual(
            {path.name: path.read_bytes() for path in first.iterdir()},
            {path.name: path.read_bytes() for path in second.iterdir()},
        )
        manifest = built["manifest"]
        self.assertEqual(manifest["contractVersion"], WEB_CATALOG_CONTRACT_VERSION)
        self.assertEqual(manifest["counts"]["categories"], 2)
        self.assertEqual(manifest["counts"]["groups"], 3)
        self.assertEqual(manifest["counts"]["products"], 3)
        self.assertEqual(manifest["counts"]["pricedProducts"], 2)
        self.assertEqual(manifest["counts"]["priceSeries"], 3)

        category_route = next(
            row for row in manifest["routing"]["categoryRoutes"]
            if row["categoryId"] == 3
        )
        category_block = self.read_block(first, category_route, "routing")
        self.assertEqual([row["groupId"] for row in category_block["groups"]], [20, 21])
        product_routes = []
        for route in manifest["routing"]["productRoutes"]:
            product_routes.extend(self.read_block(first, route, "routing")["groups"])
        group_route = next(row for row in product_routes if row["groupId"] == 20)
        group_entry = group_route["pages"][0]
        block = self.read_block(first, group_entry, "catalog")
        self.assertEqual([row["productId"] for row in block["products"]], [200, 201])
        self.assertEqual(block["products"][0]["prices"][0]["marketPrice"], "12.3400")
        self.assertEqual(block["products"][1]["prices"], [])
        empty_route = next(row for row in product_routes if row["groupId"] == 21)
        self.assertEqual(empty_route["pages"], [])

        search_page = None
        for route in manifest["routing"]["searchRoutes"]:
            routing = self.read_block(first, route, "routing")
            if "pik" in routing["prefixes"]:
                search_page = routing["prefixes"]["pik"][0]
                break
        self.assertIsNotNone(search_page)
        search = self.read_block(first, search_page, "search")
        self.assertEqual(search[0][2], 200)
        self.assertEqual(search[0][8], "Test Set")
        self.assertEqual(search[0][9][0][4], "12.3400")
        self.assertNotIn("groups", manifest)
        self.assertNotIn("catalogIndex", manifest)
        self.assertNotIn("searchIndex", manifest)

    def test_partial_catalog_is_rejected(self) -> None:
        payload = json.loads(self.packet.read_text(encoding="utf-8"))
        payload["partial"] = True
        self.packet.write_text(canonical_json(payload), encoding="utf-8")
        with self.assertRaisesRegex(TCGCSVWebCatalogError, "partial"):
            build_web_catalog(self.packet, self.parquet, self.base / "partial", shard_count=2)

    def test_search_normalization_is_stable(self) -> None:
        self.assertEqual(normalize_search_text("Ábundance", "#249"), "abundance 249")
        self.assertIn("abu", search_prefixes({"name": "Ábundance", "cleanName": "", "cardNumber": "249"}))


if __name__ == "__main__":
    unittest.main()
