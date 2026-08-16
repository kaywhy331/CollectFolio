"""Deterministic, range-readable TCGCSV catalog artifacts for private app testing.

The source catalog is intentionally too large for a browser or Worker to parse
as one JSON document.  This module preserves the complete normalized catalog
and every current finish-price row while packing group and search blocks into a
bounded number of R2 objects.  The generated manifest contains exact byte
offsets so the Worker can retrieve only the requested group or search page.
"""

from __future__ import annotations

from collections import defaultdict
from contextlib import contextmanager
from datetime import date, datetime, timezone
from decimal import Decimal
import gzip
from hashlib import sha256
import json
from pathlib import Path
import re
import tempfile
from typing import BinaryIO, Iterator, Mapping, Sequence
import unicodedata

try:
    import duckdb
    import ijson
except ImportError:  # Optional outside the market-universe workflow.
    duckdb = None  # type: ignore[assignment]
    ijson = None  # type: ignore[assignment]

from .tcgcsv_universe import canonical_json, file_sha256


WEB_CATALOG_CONTRACT_VERSION = "collectfolio-tcgcsv-web-catalog-v2"
DEFAULT_SHARD_COUNT = 64
DEFAULT_SEARCH_PAGE_BYTES = 128 * 1024
MAX_SEARCH_PAGE_BYTES = 128 * 1024
MAX_SEARCH_PREFIXES_PER_PRODUCT = 16
MAX_CATALOG_PAGE_BYTES = 128 * 1024
CATALOG_PRODUCT_PAGE_SIZE = 100
MAX_ROUTING_BLOCK_BYTES = 512 * 1024
ROUTING_GROUP_PAGE_SIZE = 500
TOKEN = re.compile(r"[a-z0-9]+")


class TCGCSVWebCatalogError(ValueError):
    """Raised when a complete, deterministic web catalog cannot be produced."""


def _require_dependencies() -> None:
    if duckdb is None or ijson is None:
        raise TCGCSVWebCatalogError(
            "web catalog generation requires analytics[market-universe] dependencies"
        )


def _json_bytes(value: object) -> bytes:
    return canonical_json(value).encode("utf-8")


def _plain(value: object) -> object:
    if isinstance(value, Decimal):
        return format(value, "f")
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    if isinstance(value, Mapping):
        return {str(key): _plain(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_plain(item) for item in value]
    return value


@contextmanager
def _packet_stream(path: Path) -> Iterator[BinaryIO]:
    with path.open("rb") as raw:
        magic = raw.read(2)
    if magic == b"\x1f\x8b":
        with gzip.open(path, "rb") as handle:
            yield handle
    else:
        with path.open("rb") as handle:
            yield handle


def _items(path: Path, prefix: str) -> Iterator[dict[str, object]]:
    _require_dependencies()
    with _packet_stream(path) as handle:
        for item in ijson.items(handle, f"{prefix}.item"):
            if not isinstance(item, Mapping):
                raise TCGCSVWebCatalogError(f"{prefix} entries must be JSON objects")
            plain = _plain(item)
            if not isinstance(plain, Mapping):
                raise TCGCSVWebCatalogError(f"{prefix} entries could not be normalized")
            yield dict(plain)


def _scalar(path: Path, prefix: str) -> object:
    _require_dependencies()
    with _packet_stream(path) as handle:
        try:
            return _plain(next(ijson.items(handle, prefix)))
        except StopIteration as exc:
            raise TCGCSVWebCatalogError(f"catalog packet is missing {prefix}") from exc


def _validate_packet_completion(path: Path) -> None:
    _require_dependencies()
    partial: bool | None = None
    errors = 0
    with _packet_stream(path) as handle:
        for prefix, event, value in ijson.parse(handle):
            if prefix == "partial" and event == "boolean":
                partial = bool(value)
            elif prefix == "errors.item" and event == "start_map":
                errors += 1
    if partial is not False or errors:
        raise TCGCSVWebCatalogError("catalog packet is partial or contains errors")


def _positive_int(value: object, name: str) -> int:
    try:
        result = int(value)
    except (TypeError, ValueError) as exc:
        raise TCGCSVWebCatalogError(f"{name} must be a positive integer") from exc
    if result <= 0:
        raise TCGCSVWebCatalogError(f"{name} must be a positive integer")
    return result


def _text(value: object, maximum: int = 4000) -> str:
    result = str(value or "").strip()
    if len(result) > maximum:
        raise TCGCSVWebCatalogError("catalog text exceeds its bound")
    return result


def _timestamp(value: object) -> str:
    text = _text(value, 80)
    normalized = text[:-1] + "+00:00" if text.endswith("Z") else text
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError as exc:
        raise TCGCSVWebCatalogError("sourceUpdatedAt must be an ISO-8601 timestamp") from exc
    if parsed.tzinfo is None:
        raise TCGCSVWebCatalogError("sourceUpdatedAt must include a timezone")
    return parsed.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def normalize_search_text(*values: object) -> str:
    text = " ".join(str(value or "") for value in values)
    folded = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii")
    return " ".join(TOKEN.findall(folded.casefold()))


def search_prefixes(product: Mapping[str, object]) -> tuple[str, ...]:
    normalized = normalize_search_text(
        product.get("name"), product.get("cleanName"), product.get("cardNumber")
    )
    tokens = normalized.split()
    prefixes = {token[:3] for token in tokens if len(token) >= 3}
    if len(normalized) >= 3:
        prefixes.add(normalized[:3])
    if not prefixes:
        prefixes.add("___")
    return tuple(sorted(prefixes)[:MAX_SEARCH_PREFIXES_PER_PRODUCT])


def _shard_for(value: str, shard_count: int) -> int:
    return int(sha256(value.encode("utf-8")).hexdigest()[:8], 16) % shard_count


def _catalog_category(row: Mapping[str, object]) -> dict[str, object]:
    return {
        "categoryId": _positive_int(row.get("category_id"), "category_id"),
        "name": _text(row.get("name"), 300),
        "displayName": _text(row.get("display_name"), 300),
        "isCardCategory": bool(row.get("is_card_category")),
        "categorySha256": _text(row.get("category_sha256"), 64),
        "metadata": _plain(row.get("metadata") or {}),
    }


def _catalog_group(row: Mapping[str, object]) -> dict[str, object]:
    metadata = row.get("metadata") if isinstance(row.get("metadata"), Mapping) else {}
    return {
        "categoryId": _positive_int(row.get("category_id"), "category_id"),
        "groupId": _positive_int(row.get("group_id"), "group_id"),
        "name": _text(row.get("name"), 500),
        "abbreviation": _text(row.get("abbreviation"), 120),
        "publishedOn": _text(row.get("published_on"), 20),
        "modifiedOn": _text(row.get("modified_on"), 160),
        "supplemental": bool(metadata.get("isSupplemental", False)),
        "groupSha256": _text(row.get("group_sha256"), 64),
        "metadata": _plain(metadata),
    }


def _price(value: object) -> str | None:
    if value is None or value == "":
        return None
    if isinstance(value, Decimal):
        return format(value, "f")
    return format(Decimal(str(value)), "f")


def _price_record(row: Sequence[object]) -> dict[str, object]:
    return {
        "subtypeName": _text(row[0], 200),
        "seriesSha256": _text(row[1], 64),
        "lowPrice": _price(row[2]),
        "midPrice": _price(row[3]),
        "highPrice": _price(row[4]),
        "marketPrice": _price(row[5]),
        "directLowPrice": _price(row[6]),
        "priceTupleSha256": _text(row[7], 64),
    }


def _product_record(
    row: Mapping[str, object], prices: Sequence[Mapping[str, object]]
) -> dict[str, object]:
    metadata = row.get("metadata") if isinstance(row.get("metadata"), Mapping) else {}
    extended = metadata.get("extendedData", []) if isinstance(metadata, Mapping) else []
    return {
        "categoryId": _positive_int(row.get("category_id"), "category_id"),
        "groupId": _positive_int(row.get("group_id"), "group_id"),
        "productId": _positive_int(row.get("product_id"), "product_id"),
        "name": _text(row.get("name"), 700),
        "cleanName": _text(row.get("clean_name"), 700),
        "cardNumber": _text(row.get("card_number"), 160),
        "rarity": _text(row.get("rarity"), 300),
        "cardType": _text(row.get("card_type"), 300),
        "modifiedOn": _text(row.get("modified_on"), 160),
        "productSha256": _text(row.get("product_sha256"), 64),
        "extendedData": _plain(extended if isinstance(extended, list) else []),
        "prices": list(prices),
    }


def _search_record(product: Mapping[str, object], group_name: str) -> list[object]:
    prices: list[list[object]] = []
    for row in product.get("prices", []):
        if not isinstance(row, Mapping):
            continue
        # Search blocks intentionally use positional tuples to avoid repeating
        # field names several million times.  Full hashes and extended metadata
        # remain available from the lossless group block.
        prices.append([
            row.get("subtypeName"), row.get("lowPrice"), row.get("midPrice"),
            row.get("highPrice"), row.get("marketPrice"), row.get("directLowPrice"),
        ])
    return [
        product["categoryId"], product["groupId"], product["productId"],
        product["name"], product["cleanName"], product["cardNumber"],
        product["rarity"], product["cardType"], group_name, prices,
    ]


def _asset(path: Path, kind: str, shard: int) -> dict[str, object]:
    return {
        "file": path.name,
        "kind": kind,
        "shard": shard,
        "bytes": path.stat().st_size,
        "sha256": file_sha256(path),
    }


def _write_search_pages(
    output_dir: Path,
    spool_paths: Sequence[Path],
    shard_count: int,
    page_bytes: int,
) -> tuple[dict[str, list[dict[str, int]]], list[dict[str, object]]]:
    index: dict[str, list[dict[str, int]]] = {}
    assets: list[dict[str, object]] = []
    for shard in range(shard_count):
        spool = spool_paths[shard]
        if not spool.exists() or not spool.stat().st_size:
            continue
        destination = output_dir / f"search-{shard:02d}.bin"
        connection = duckdb.connect()
        query = connection.execute(
            "select prefix, payload from read_csv(?, delim='\\t', header=false, "
            "columns={'prefix':'VARCHAR','sort_key':'VARCHAR','payload':'VARCHAR'}, quote='') "
            "order by prefix, sort_key",
            [str(spool)],
        )
        with destination.open("wb") as target:
            active_prefix = ""
            page: list[bytes] = []
            page_size = 2

            def flush() -> None:
                nonlocal page, page_size
                if not page:
                    return
                payload = b"[" + b",".join(page) + b"]"
                offset = target.tell()
                target.write(payload)
                index.setdefault(active_prefix, []).append({
                    "shard": shard,
                    "offset": offset,
                    "length": len(payload),
                    "count": len(page),
                })
                page = []
                page_size = 2

            while True:
                rows = query.fetchmany(4096)
                if not rows:
                    break
                for prefix, payload_text in rows:
                    payload = str(payload_text).encode("utf-8")
                    if active_prefix and prefix != active_prefix:
                        flush()
                    active_prefix = str(prefix)
                    added = len(payload) + (1 if page else 0)
                    if page and page_size + added > page_bytes:
                        flush()
                    page.append(payload)
                    page_size += added
            flush()
        connection.close()
        assets.append(_asset(destination, "search", shard))
    return index, assets


def _write_routing_assets(
    output_dir: Path,
    categories: Sequence[Mapping[str, object]],
    groups: Sequence[Mapping[str, object]],
    catalog_index: Sequence[Mapping[str, object]],
    search_index: Mapping[str, Sequence[Mapping[str, int]]],
    shard_count: int,
) -> tuple[dict[str, object], list[dict[str, object]]]:
    paths = [output_dir / f"routing-{shard:02d}.bin" for shard in range(shard_count)]
    handles = [path.open("wb") for path in paths]

    def append(shard: int, value: object) -> dict[str, int]:
        payload = _json_bytes(value)
        if not payload or len(payload) > MAX_ROUTING_BLOCK_BYTES:
            raise TCGCSVWebCatalogError("catalog routing block exceeds its serving limit")
        target = handles[shard]
        offset = target.tell()
        target.write(payload)
        return {"shard": shard, "offset": offset, "length": len(payload)}

    try:
        groups_by_category: dict[int, list[Mapping[str, object]]] = defaultdict(list)
        group_by_key: dict[tuple[int, int], Mapping[str, object]] = {}
        for row in groups:
            groups_by_category[int(row["categoryId"])].append(row)
            group_by_key[(int(row["categoryId"]), int(row["groupId"]))] = row

        product_routes_by_shard: dict[int, list[dict[str, object]]] = defaultdict(list)
        for entry in catalog_index:
            category_id = int(entry["categoryId"])
            group_id = int(entry["groupId"])
            group = group_by_key.get((category_id, group_id))
            if group is None:
                raise TCGCSVWebCatalogError("product routing is missing catalog group metadata")
            shard = _shard_for(f"group:{category_id}:{group_id}", shard_count)
            product_routes_by_shard[shard].append({**entry, "group": group})

        product_routes: list[dict[str, int]] = []
        for shard, routed_groups in sorted(product_routes_by_shard.items()):
            product_routes.append({
                "shard": shard,
                "groupCount": len(routed_groups),
                **append(shard, {"groups": routed_groups}),
            })

        category_routes: list[dict[str, int]] = []
        for category in categories:
            category_id = int(category["categoryId"])
            category_groups = groups_by_category.get(category_id, [])
            shard = _shard_for(f"category:{category_id}", shard_count)
            route = append(shard, {
                "categoryId": category_id,
                "groups": category_groups,
            })
            category_routes.append({
                "categoryId": category_id,
                "groupCount": len(category_groups),
                **route,
            })

        group_pages: list[dict[str, int]] = []
        for start in range(0, len(groups), ROUTING_GROUP_PAGE_SIZE):
            page = list(groups[start:start + ROUTING_GROUP_PAGE_SIZE])
            shard = _shard_for(f"groups:{start}", shard_count)
            group_pages.append({
                "start": start,
                "count": len(page),
                **append(shard, {"groups": page}),
            })

        prefixes_by_shard: dict[int, dict[str, Sequence[Mapping[str, int]]]] = defaultdict(dict)
        for prefix, pages in sorted(search_index.items()):
            page_shards = {int(page["shard"]) for page in pages}
            if len(page_shards) != 1:
                raise TCGCSVWebCatalogError("search prefix pages cross routing shards")
            prefixes_by_shard[next(iter(page_shards))][prefix] = pages
        search_routes: list[dict[str, int]] = []
        for shard, prefixes in sorted(prefixes_by_shard.items()):
            search_routes.append({
                "shard": shard,
                "prefixCount": len(prefixes),
                **append(shard, {"prefixes": prefixes}),
            })
    finally:
        for handle in handles:
            handle.close()

    assets = [
        _asset(path, "routing", shard)
        for shard, path in enumerate(paths) if path.stat().st_size
    ]
    return {
        "categoryRoutes": category_routes,
        "groupPages": group_pages,
        "productRoutes": product_routes,
        "searchRoutes": search_routes,
    }, assets


def build_web_catalog(
    catalog_packet: Path,
    prices_parquet: Path,
    output_dir: Path,
    *,
    shard_count: int = DEFAULT_SHARD_COUNT,
    search_page_bytes: int = DEFAULT_SEARCH_PAGE_BYTES,
) -> dict[str, object]:
    """Build and return a deterministic full-catalog publication manifest."""

    _require_dependencies()

    catalog_packet = Path(catalog_packet)
    prices_parquet = Path(prices_parquet)
    output_dir = Path(output_dir)
    if not catalog_packet.is_file() or not prices_parquet.is_file():
        raise TCGCSVWebCatalogError("catalog packet and prices parquet are required")
    if not 1 <= shard_count <= 256:
        raise TCGCSVWebCatalogError("shard_count must be between 1 and 256")
    if not 32 * 1024 <= search_page_bytes <= MAX_SEARCH_PAGE_BYTES:
        raise TCGCSVWebCatalogError("search_page_bytes is outside its bound")
    if output_dir.exists():
        if not output_dir.is_dir() or any(output_dir.iterdir()):
            raise TCGCSVWebCatalogError("output directory must be empty")
    output_dir.mkdir(parents=True, exist_ok=True)

    contract = _scalar(catalog_packet, "contractVersion")
    source_updated_at = _timestamp(_scalar(catalog_packet, "sourceUpdatedAt"))
    _validate_packet_completion(catalog_packet)
    categories = sorted(
        (_catalog_category(row) for row in _items(catalog_packet, "categories")),
        key=lambda row: int(row["categoryId"]),
    )
    groups = sorted(
        (_catalog_group(row) for row in _items(catalog_packet, "groups")),
        key=lambda row: (int(row["categoryId"]), int(row["groupId"])),
    )
    category_by_id = {int(row["categoryId"]): row for row in categories}
    group_by_key = {
        (int(row["categoryId"]), int(row["groupId"])): row for row in groups
    }
    if len(category_by_id) != len(categories) or len(group_by_key) != len(groups):
        raise TCGCSVWebCatalogError("catalog category or group identities are duplicated")

    with tempfile.TemporaryDirectory(prefix="collectfolio-web-catalog-") as temporary:
        temporary_dir = Path(temporary)
        database = duckdb.connect(str(temporary_dir / "prices.duckdb"))
        database.execute(
            "create table prices as select category_id, group_id, product_id, subtype_name, "
            "series_sha256, low_price, mid_price, high_price, market_price, direct_low_price, "
            "price_tuple_sha256 from read_parquet(?)",
            [str(prices_parquet)],
        )
        database.execute(
            "create index price_identity on prices(category_id, group_id, product_id)"
        )
        price_count = int(database.execute("select count(*) from prices").fetchone()[0])

        catalog_paths = [output_dir / f"catalog-{shard:02d}.bin" for shard in range(shard_count)]
        catalog_handles = [path.open("wb") for path in catalog_paths]
        spool_paths = [temporary_dir / f"search-{shard:02d}.tsv" for shard in range(shard_count)]
        spool_handles = [path.open("w", encoding="utf-8", newline="") for path in spool_paths]
        catalog_index: list[dict[str, object]] = []
        product_count = 0
        priced_product_count = 0
        processed_price_count = 0
        group_product_counts: dict[tuple[int, int], int] = defaultdict(int)

        def write_group(key: tuple[int, int], raw_products: list[Mapping[str, object]]) -> None:
            nonlocal product_count, priced_product_count, processed_price_count
            if key not in group_by_key or key[0] not in category_by_id:
                raise TCGCSVWebCatalogError(f"product group {key} is missing catalog metadata")
            price_rows = database.execute(
                "select subtype_name, series_sha256, low_price, mid_price, high_price, "
                "market_price, direct_low_price, price_tuple_sha256 from prices "
                "where category_id=? and group_id=? order by product_id, subtype_name",
                list(key),
            ).fetchall()
            price_ids = database.execute(
                "select product_id from prices where category_id=? and group_id=? "
                "order by product_id, subtype_name",
                list(key),
            ).fetchall()
            prices_by_product: dict[int, list[dict[str, object]]] = defaultdict(list)
            for identity, row in zip(price_ids, price_rows):
                prices_by_product[int(identity[0])].append(_price_record(row))
            products: list[dict[str, object]] = []
            seen_ids: set[int] = set()
            for raw in sorted(raw_products, key=lambda item: _positive_int(item.get("product_id"), "product_id")):
                product_id = _positive_int(raw.get("product_id"), "product_id")
                if product_id in seen_ids:
                    raise TCGCSVWebCatalogError(f"duplicate product {key}/{product_id}")
                seen_ids.add(product_id)
                product_prices = prices_by_product.pop(product_id, [])
                product = _product_record(raw, product_prices)
                products.append(product)
                product_count += 1
                processed_price_count += len(product_prices)
                if product_prices:
                    priced_product_count += 1
                search = _search_record(product, str(group_by_key[key]["name"]))
                payload = canonical_json(search)
                sort_key = f"{key[0]:04d}:{key[1]:010d}:{product_id:012d}"
                for prefix in search_prefixes(product):
                    search_shard = _shard_for(prefix, shard_count)
                    # canonical_json escapes tabs and newlines inside payloads,
                    # so a literal TSV row remains unambiguous without CSV
                    # quote escaping (which would corrupt the JSON bytes).
                    spool_handles[search_shard].write(
                        f"{prefix}\t{sort_key}\t{payload}\n"
                    )
            if prices_by_product:
                raise TCGCSVWebCatalogError(f"prices reference missing products in group {key}")
            shard = _shard_for(f"{key[0]}:{key[1]}", shard_count)
            target = catalog_handles[shard]
            pages: list[dict[str, object]] = []
            start = 0
            while start < len(products):
                end = min(len(products), start + CATALOG_PRODUCT_PAGE_SIZE)
                while True:
                    page_products = products[start:end]
                    block = _json_bytes({
                        "contractVersion": WEB_CATALOG_CONTRACT_VERSION,
                        "sourceUpdatedAt": source_updated_at,
                        "category": category_by_id[key[0]],
                        "group": group_by_key[key],
                        "products": page_products,
                    })
                    if len(block) <= MAX_CATALOG_PAGE_BYTES:
                        break
                    if end - start <= 1:
                        raise TCGCSVWebCatalogError(
                            f"product {key}/{page_products[0]['productId']} exceeds the serving page limit"
                        )
                    end = start + max(1, (end - start) // 2)
                offset = target.tell()
                target.write(block)
                pages.append({
                    "shard": shard,
                    "offset": offset,
                    "length": len(block),
                    "start": start,
                    "count": len(page_products),
                    "firstProductId": page_products[0]["productId"],
                    "lastProductId": page_products[-1]["productId"],
                })
                start = end
            catalog_index.append({
                "categoryId": key[0], "groupId": key[1], "pages": pages,
                "productCount": len(products),
                "priceCount": sum(len(product["prices"]) for product in products),
            })
            group_product_counts[key] = len(products)

        active_key: tuple[int, int] | None = None
        active_products: list[Mapping[str, object]] = []
        previous_identity: tuple[int, int, int] | None = None
        for raw_product in _items(catalog_packet, "products"):
            identity = (
                _positive_int(raw_product.get("category_id"), "category_id"),
                _positive_int(raw_product.get("group_id"), "group_id"),
                _positive_int(raw_product.get("product_id"), "product_id"),
            )
            if previous_identity is not None and identity <= previous_identity:
                raise TCGCSVWebCatalogError("catalog products are not strictly identity ordered")
            previous_identity = identity
            key = identity[:2]
            if active_key is not None and key != active_key:
                write_group(active_key, active_products)
                active_products = []
            active_key = key
            active_products.append(raw_product)
        if active_key is not None:
            write_group(active_key, active_products)

        for group_key in sorted(set(group_by_key) - set(group_product_counts)):
            write_group(group_key, [])
        for handle in catalog_handles:
            handle.close()
        for handle in spool_handles:
            handle.close()
        database.close()

        if processed_price_count != price_count:
            raise TCGCSVWebCatalogError(
                f"published {processed_price_count} of {price_count} price rows"
            )
        catalog_assets = [
            _asset(path, "catalog", shard)
            for shard, path in enumerate(catalog_paths) if path.stat().st_size
        ]
        search_index, search_assets = _write_search_pages(
            output_dir, spool_paths, shard_count, search_page_bytes
        )
        published_groups = [
            {
                **group,
                "productCount": group_product_counts.get(
                    (int(group["categoryId"]), int(group["groupId"])), 0
                ),
            }
            for group in groups
        ]
        sorted_catalog_index = sorted(
            catalog_index, key=lambda row: (row["categoryId"], row["groupId"])
        )
        routing, routing_assets = _write_routing_assets(
            output_dir,
            categories,
            published_groups,
            sorted_catalog_index,
            search_index,
            shard_count,
        )

    manifest = {
        "contractVersion": WEB_CATALOG_CONTRACT_VERSION,
        "sourceContractVersion": contract,
        "sourceUpdatedAt": source_updated_at,
        "generatedAt": source_updated_at,
        "shardCount": shard_count,
        "counts": {
            "categories": len(categories),
            "groups": len(groups),
            "products": product_count,
            "pricedProducts": priced_product_count,
            "priceSeries": price_count,
            "searchPrefixes": len(search_index),
        },
        "categories": categories,
        "routing": routing,
        "assets": sorted(
            catalog_assets + search_assets + routing_assets,
            key=lambda row: str(row["file"]),
        ),
    }
    manifest_path = output_dir / "manifest.json"
    manifest_path.write_bytes(_json_bytes(manifest) + b"\n")
    return {
        "manifest": manifest,
        "manifestPath": str(manifest_path),
        "publicationId": file_sha256(manifest_path),
        "manifestBytes": manifest_path.stat().st_size,
        "assetCount": len(manifest["assets"]),
    }
