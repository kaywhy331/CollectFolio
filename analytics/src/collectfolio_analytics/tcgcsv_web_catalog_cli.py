"""CLI for deterministic signed-in TCGCSV web-catalog publication assets."""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Sequence

from .tcgcsv_universe import canonical_json
from .tcgcsv_web_catalog import (
    DEFAULT_SEARCH_PAGE_BYTES,
    DEFAULT_SHARD_COUNT,
    build_web_catalog,
)


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--catalog-packet", required=True, type=Path)
    result.add_argument("--prices-parquet", required=True, type=Path)
    result.add_argument("--output-dir", required=True, type=Path)
    result.add_argument("--shards", type=int, default=DEFAULT_SHARD_COUNT)
    result.add_argument("--search-page-bytes", type=int, default=DEFAULT_SEARCH_PAGE_BYTES)
    return result


def main(argv: Sequence[str] | None = None) -> int:
    args = parser().parse_args(argv)
    result = build_web_catalog(
        args.catalog_packet,
        args.prices_parquet,
        args.output_dir,
        shard_count=args.shards,
        search_page_bytes=args.search_page_bytes,
    )
    manifest = result["manifest"]
    print(canonical_json({
        "publicationId": result["publicationId"],
        "manifest": result["manifestPath"],
        "manifestBytes": result["manifestBytes"],
        "assetCount": result["assetCount"],
        "counts": manifest["counts"],
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
