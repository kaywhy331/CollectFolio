"""Operator CLI for the resumable catalog-v2 B2 provider <-> TCGCSV bridge.

Subcommands:
  fetch-sets    resumable fetch of one provider's set catalog (near-always
                a single request; cached, force-refreshable)
  fetch-cards   resumable, politely-paced fetch of provider cards for the
                provider sets that already matched a TCGCSV group -- see
                `catalog_bridge_fetch.fetch_provider_cards` for the
                per-unit-of-work resume semantics (state.json)
  build         run set-level + product-level matching (`catalog_bridge`)
                for one flagship category and write the publishable
                bridge/<categoryId>.json.gz payload; --write-receipts
                additionally writes docs/receipts/catalog-v2/bridge-*.json
                + a summary markdown (reserved for the supervisor's real,
                full-coverage run -- do not pass --write-receipts against
                a bounded/smoke fetch)

Cache layout (mirrors tcgcsv_panel's <panel-dir>/state.json convention):
  <cache-dir>/<provider>/sets.json.gz
  <cache-dir>/<provider>/cards.json.gz
  <cache-dir>/<provider>/state.json     (per-set-id fetch progress ledger)

`fetch-sets` and `fetch-cards` are both safe to interrupt and rerun: already
-completed units are skipped without a network call.
"""

from __future__ import annotations

import argparse
import gzip
import json
import sys
from dataclasses import asdict
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Sequence

from .catalog_bridge import (
    BRIDGE_CONTRACT_VERSION,
    FLAGSHIP_PROVIDERS,
    build_bridge_table,
    match_products,
    match_sets,
    summarize_match_rates,
)
from .catalog_bridge_fetch import (
    BridgeFetchError,
    DEFAULT_REQUEST_DELAY_SECONDS,
    DEFAULT_TIMEOUT_SECONDS,
    DEFAULT_USER_AGENT,
    SUPPORTED_PROVIDERS,
    fetch_provider_cards,
    fetch_provider_sets,
    pokemontcg_api_key_from_env,
)
from .hedonic_features import load_or_fetch_products_metadata
from .lifecycle import GROUPS_CACHE_FILENAME


def _read_gzip_json(path: Path) -> object | None:
    if not path.is_file():
        return None
    with gzip.open(path, "rt", encoding="utf-8") as handle:
        return json.load(handle)


def _write_gzip_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(path.suffix + ".part")
    with gzip.open(tmp_path, "wt", encoding="utf-8") as handle:
        handle.write(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
    tmp_path.replace(path)


def _provider_for_category(category_id: int) -> str:
    provider = FLAGSHIP_PROVIDERS.get(category_id)
    if provider is None:
        raise SystemExit(f"catalog-bridge: category {category_id} is not a flagship category ({FLAGSHIP_PROVIDERS})")
    return provider


def _parse_date(value: object) -> date | None:
    text = str(value or "").strip()[:10]
    try:
        return date.fromisoformat(text) if text else None
    except ValueError:
        return None


def _load_tcgcsv_groups(groups_cache_path: Path, category_id: int) -> list[dict[str, object]]:
    raw = _read_gzip_json(groups_cache_path)
    if not isinstance(raw, dict):
        raise SystemExit(f"catalog-bridge: no TCGCSV groups cache at {groups_cache_path} -- run trajectory `build-indices` first")
    groups = [row for row in raw.get("groups", []) if int(row.get("category_id", -1)) == category_id]
    if not groups:
        raise SystemExit(f"catalog-bridge: TCGCSV groups cache has no rows for category {category_id}")
    return groups


def _as_provider_sets(rows: Sequence[dict[str, object]]) -> list[dict[str, object]]:
    # catalog_bridge_fetch's normalized shape ({"id","name","abbreviation",
    # "releaseDate"}) -> catalog_bridge.match_sets's expected shape
    # ({"id","name","code","released_at": date | None}).
    return [
        {"id": row["id"], "name": row["name"], "code": row.get("abbreviation"), "released_at": _parse_date(row.get("releaseDate"))}
        for row in rows
    ]


def _as_match_sets_groups(rows: Sequence[dict[str, object]]) -> list[dict[str, object]]:
    return [
        {**row, "published_on": _parse_date(row.get("published_on"))}
        for row in rows
    ]


def _fetch_sets_command(args: argparse.Namespace) -> int:
    cache_dir = Path(args.cache_dir)
    api_key = pokemontcg_api_key_from_env() if args.provider == "pokemon" else None
    sets, result = fetch_provider_sets(
        args.provider, cache_dir,
        api_key=api_key, user_agent=args.user_agent, timeout_seconds=args.timeout_seconds,
        force_refresh=args.force_refresh,
    )
    print(json.dumps({"provider": args.provider, "setCount": len(sets), **asdict(result)}, indent=2, sort_keys=True, default=str))
    return 0 if not result.truncated else 1


def _matched_provider_set_ids(args: argparse.Namespace) -> list[str]:
    cache_dir = Path(args.cache_dir)
    provider_sets_raw = _read_gzip_json(cache_dir / args.provider / "sets.json.gz")
    if not isinstance(provider_sets_raw, dict):
        raise SystemExit(f"catalog-bridge: no cached sets for provider {args.provider} -- run fetch-sets first")
    category_id = next(cat for cat, prov in FLAGSHIP_PROVIDERS.items() if prov == args.provider)
    tcgcsv_groups = _as_match_sets_groups(_load_tcgcsv_groups(Path(args.groups_cache), category_id))
    provider_sets = _as_provider_sets(provider_sets_raw.get("sets", []))
    matched, _unmatched = match_sets(category_id, args.provider, tcgcsv_groups, provider_sets)
    return sorted({row.provider_set_id for row in matched})


def _fetch_cards_command(args: argparse.Namespace) -> int:
    cache_dir = Path(args.cache_dir)
    provider_set_ids = _matched_provider_set_ids(args)
    if not provider_set_ids and args.provider != "ygoprodeck":
        print(f"[catalog-bridge] no matched TCGCSV sets for provider={args.provider}; nothing to fetch")
        return 0
    api_key = pokemontcg_api_key_from_env() if args.provider == "pokemon" else None
    cards, result = fetch_provider_cards(
        args.provider, cache_dir, provider_set_ids,
        max_requests=args.max_requests, request_delay_seconds=args.request_delay_seconds,
        api_key=api_key, user_agent=args.user_agent, timeout_seconds=args.timeout_seconds,
    )
    print(json.dumps({"provider": args.provider, "cardCount": len(cards), **asdict(result)}, indent=2, sort_keys=True, default=str))
    return 0 if not result.truncated else 1


def _load_tcgcsv_products(args: argparse.Namespace, category_id: int, group_ids: Sequence[int]) -> dict[int, list[dict[str, object]]]:
    # Reuses hedonic_features' resumable products-metadata cache (card_number
    # + rarity, keyed by (category_id, product_id)) as the TCGCSV-side input
    # to product-level matching -- it does not retain clean_name (PRD Sec1
    # source-rights minimalism in that cache), so product matching here is
    # collector-number-only; the name-fallback path in
    # catalog_bridge.match_products is simply never reached for TCGCSV
    # products sourced this way. This is a known, deliberate limitation --
    # collector number is the dominant, reliable match key for singles.
    cache_path = Path(args.products_cache)
    group_keys = [(category_id, gid) for gid in group_ids]
    products, _result = load_or_fetch_products_metadata(
        cache_path, group_keys, max_requests=0,  # cache-read-only: never fetches from this CLI
    )
    by_group: dict[int, list[dict[str, object]]] = {}
    for (cat, _product_id), row in products.items():
        if cat != category_id or int(row.get("group_id", -1)) not in group_ids:
            continue
        by_group.setdefault(int(row["group_id"]), []).append(
            {"product_id": row["product_id"], "card_number": row.get("card_number"), "clean_name": None}
        )
    return by_group


def _build_command(args: argparse.Namespace) -> int:
    category_id = args.category_id
    provider = _provider_for_category(category_id)
    cache_dir = Path(args.cache_dir)

    tcgcsv_groups_raw = _load_tcgcsv_groups(Path(args.groups_cache), category_id)
    tcgcsv_groups = _as_match_sets_groups(tcgcsv_groups_raw)

    provider_sets_raw = _read_gzip_json(cache_dir / provider / "sets.json.gz")
    if not isinstance(provider_sets_raw, dict):
        raise SystemExit(f"catalog-bridge: no cached sets for provider {provider} -- run fetch-sets first")
    provider_sets = _as_provider_sets(provider_sets_raw.get("sets", []))

    set_matched, set_unmatched = match_sets(category_id, provider, tcgcsv_groups, provider_sets)

    provider_cards_raw = _read_gzip_json(cache_dir / provider / "cards.json.gz")
    provider_cards_by_set: dict[str, list[dict[str, object]]] = {}
    for row in (provider_cards_raw or {}).get("cards", []):
        provider_cards_by_set.setdefault(str(row["setId"]), []).append(row)

    group_ids = [row.tcgcsv_group_id for row in set_matched]
    tcgcsv_products_by_group = _load_tcgcsv_products(args, category_id, group_ids)

    product_matched: list = []
    product_unmatched: list = []
    for set_match in set_matched:
        products = tcgcsv_products_by_group.get(set_match.tcgcsv_group_id, [])
        cards = provider_cards_by_set.get(set_match.provider_set_id, [])
        matched, unmatched = match_products(
            category_id, set_match.tcgcsv_group_id, provider, set_match.provider_set_id, products, cards,
        )
        product_matched.extend(matched)
        product_unmatched.extend(unmatched)

    as_of = args.as_of or datetime.now(timezone.utc).date().isoformat()
    bridge_table = build_bridge_table(category_id, provider, as_of, set_matched, product_matched)

    out_path = Path(args.out) if args.out else cache_dir / "bridge" / f"{category_id}.json.gz"
    _write_gzip_json(out_path, bridge_table)

    rates = summarize_match_rates(set_matched, set_unmatched, product_matched, product_unmatched)
    print(json.dumps({
        "categoryId": category_id, "provider": provider, "outPath": str(out_path),
        "modelVersion": BRIDGE_CONTRACT_VERSION, "matchRates": asdict(rates),
    }, indent=2, sort_keys=True))

    if args.write_receipts:
        _write_receipts(category_id, provider, rates, Path(args.receipts_dir), args.receipt_name)

    return 0


def _write_receipts(category_id: int, provider: str, rates, receipts_dir: Path, receipt_name: str) -> None:
    receipts_dir.mkdir(parents=True, exist_ok=True)
    summary = {
        "contractVersion": BRIDGE_CONTRACT_VERSION,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "categoryId": category_id,
        "provider": provider,
        "matchRates": asdict(rates),
    }
    json_path = receipts_dir / f"{receipt_name}-{category_id}.json"
    json_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    md_path = receipts_dir / f"{receipt_name}-{category_id}.md"
    md_path.write_text(
        "\n".join([
            f"# catalog-v2 bridge -- category {category_id} ({provider})",
            "",
            f"- Generated at: {summary['generatedAt']}",
            f"- Sets matched: {rates.set_matched} / {rates.set_total}",
            f"- Products matched: {rates.product_matched} / {rates.product_total}",
            f"- Set match methods: {rates.set_by_method}",
            f"- Set unmatched reasons: {rates.set_unmatched_by_reason}",
            f"- Product match methods: {rates.product_by_method}",
            f"- Product unmatched reasons: {rates.product_unmatched_by_reason}",
            "",
        ]),
        encoding="utf-8",
    )


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Resumable provider <-> TCGCSV bridge builder for catalog-v2 (B2).")
    subparsers = parser.add_subparsers(dest="command", required=True)

    fetch_sets = subparsers.add_parser("fetch-sets", help="fetch (and cache) one provider's full set list")
    fetch_sets.add_argument("--provider", required=True, choices=SUPPORTED_PROVIDERS)
    fetch_sets.add_argument("--cache-dir", default="analytics/data/bridge")
    fetch_sets.add_argument("--user-agent", default=DEFAULT_USER_AGENT)
    fetch_sets.add_argument("--timeout-seconds", type=float, default=DEFAULT_TIMEOUT_SECONDS)
    fetch_sets.add_argument("--force-refresh", action="store_true")
    fetch_sets.set_defaults(handler=_fetch_sets_command)

    fetch_cards = subparsers.add_parser(
        "fetch-cards",
        help="resumably fetch provider cards for TCGCSV-matched provider sets (politely paced, --max-requests bounded)",
    )
    fetch_cards.add_argument("--provider", required=True, choices=SUPPORTED_PROVIDERS)
    fetch_cards.add_argument("--cache-dir", default="analytics/data/bridge")
    fetch_cards.add_argument("--groups-cache", default=f"analytics/data/trajectory/{GROUPS_CACHE_FILENAME}")
    fetch_cards.add_argument("--user-agent", default=DEFAULT_USER_AGENT)
    fetch_cards.add_argument("--timeout-seconds", type=float, default=DEFAULT_TIMEOUT_SECONDS)
    fetch_cards.add_argument("--max-requests", type=int, default=500)
    fetch_cards.add_argument("--request-delay-seconds", type=float, default=DEFAULT_REQUEST_DELAY_SECONDS)
    fetch_cards.set_defaults(handler=_fetch_cards_command)

    build = subparsers.add_parser(
        "build",
        help="run set + product matching for one flagship category and write the publishable bridge table",
    )
    build.add_argument("--category-id", type=int, required=True, choices=sorted(FLAGSHIP_PROVIDERS))
    build.add_argument("--cache-dir", default="analytics/data/bridge")
    build.add_argument("--groups-cache", default=f"analytics/data/trajectory/{GROUPS_CACHE_FILENAME}")
    build.add_argument("--products-cache", default="analytics/data/trajectory/hedonic/products_metadata.json.gz")
    build.add_argument("--out", help="defaults to <cache-dir>/bridge/<categoryId>.json.gz")
    build.add_argument("--as-of", help="defaults to today (UTC)")
    build.add_argument("--write-receipts", action="store_true", help="reserved for the supervisor's real, full-coverage run")
    build.add_argument("--receipts-dir", default="docs/receipts/catalog-v2")
    build.add_argument("--receipt-name", default="bridge-coverage-summary")
    build.set_defaults(handler=_build_command)

    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        return int(args.handler(args))
    except (OSError, ValueError, RuntimeError, BridgeFetchError) as exc:
        print(f"catalog-bridge: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
