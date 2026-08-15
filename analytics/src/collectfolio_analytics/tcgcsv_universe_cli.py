"""Operator CLI for private, provider-wide TCGCSV market ingestion."""

from __future__ import annotations

import argparse
from datetime import date, datetime, timezone
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
from typing import Mapping, Sequence
from urllib.parse import urljoin
from urllib.request import Request, urlopen

from .tcgcsv_universe import (
    UNIVERSE_CONTRACT_VERSION,
    UNIVERSE_PARSER_VERSION,
    TCGCSVUniverseError,
    canonical_json,
    content_hash,
    file_sha256,
    is_card_category,
    normalize_category,
    normalize_extracted_archive,
    normalize_group,
    normalize_product,
    plan_catalog_refresh,
)
from .tcgcsv_universe_io import (
    compile_market_feature_csvs,
    export_catalog_snapshot,
    ingest_archive_packet,
    ingest_catalog_packet,
    load_catalog_planning_state,
    write_price_parquet,
)


DEFAULT_BASE_URL = "https://tcgcsv.com/"
DEFAULT_USER_AGENT = "CollectFolio/0.8.3 private-market-research"
MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
MAX_JSON_BYTES = 64 * 1024 * 1024
MAX_EXPANDED_BYTES = 512 * 1024 * 1024
MAX_EXTRACTED_FILES = 20_000
MAX_REQUESTS = 9_000
REQUEST_DELAY_SECONDS = 0.11


class RequestBudget:
    def __init__(self, *, delay_seconds: float = REQUEST_DELAY_SECONDS) -> None:
        self.delay_seconds = delay_seconds
        self.count = 0
        self._last_request_at: float | None = None

    def before_request(self) -> None:
        if self.count >= MAX_REQUESTS:
            raise TCGCSVUniverseError("TCGCSV request budget exhausted")
        if self._last_request_at is not None:
            remaining = self.delay_seconds - (time.monotonic() - self._last_request_at)
            if remaining > 0:
                time.sleep(remaining)
        self.count += 1

    def after_request(self) -> None:
        self._last_request_at = time.monotonic()


def _timestamp(value: str) -> datetime:
    text = str(value or "").strip()
    normalized = text[:-1] + "+00:00" if text.endswith("Z") else text
    try:
        result = datetime.fromisoformat(normalized)
    except ValueError as exc:
        raise TCGCSVUniverseError("source timestamp is not valid ISO-8601") from exc
    if result.tzinfo is None or result.utcoffset() is None:
        raise TCGCSVUniverseError("source timestamp must include an offset")
    return result.astimezone(timezone.utc)


def _url(base_url: str, path: str) -> str:
    base = base_url.rstrip("/") + "/"
    result = urljoin(base, path.lstrip("/"))
    if not result.startswith(base):
        raise ValueError("TCGCSV path escaped the configured origin")
    return result


def _fetch_bytes(
    base_url: str,
    path: str,
    *,
    user_agent: str,
    budget: RequestBudget,
    maximum: int,
    accept: str,
) -> bytes:
    budget.before_request()
    try:
        request = Request(
            _url(base_url, path),
            headers={"User-Agent": user_agent, "Accept": accept},
        )
        with urlopen(request, timeout=60) as response:  # noqa: S310 - fixed HTTPS origin
            declared = response.headers.get("Content-Length")
            if declared:
                try:
                    if int(declared) > maximum:
                        raise TCGCSVUniverseError("TCGCSV response exceeds its size limit")
                except ValueError as exc:
                    raise TCGCSVUniverseError("TCGCSV response size is invalid") from exc
            payload = response.read(maximum + 1)
    finally:
        budget.after_request()
    if len(payload) > maximum:
        raise TCGCSVUniverseError("TCGCSV response exceeds its size limit")
    return payload


def _fetch_text(
    base_url: str,
    path: str,
    *,
    user_agent: str,
    budget: RequestBudget,
) -> str:
    payload = _fetch_bytes(
        base_url, path, user_agent=user_agent, budget=budget,
        maximum=MAX_JSON_BYTES, accept="application/json,text/plain",
    )
    try:
        return payload.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise TCGCSVUniverseError("TCGCSV response is not UTF-8") from exc


def _fetch_json(
    base_url: str,
    path: str,
    *,
    user_agent: str,
    budget: RequestBudget,
) -> object:
    try:
        return json.loads(_fetch_text(
            base_url, path, user_agent=user_agent, budget=budget
        ))
    except json.JSONDecodeError as exc:
        raise TCGCSVUniverseError("TCGCSV response is not valid JSON") from exc


def _results(payload: object, label: str) -> tuple[Mapping[str, object], ...]:
    if not isinstance(payload, Mapping) or payload.get("success") is not True:
        raise TCGCSVUniverseError(f"{label} response was not successful")
    rows = payload.get("results")
    if not isinstance(rows, list) or any(not isinstance(row, Mapping) for row in rows):
        raise TCGCSVUniverseError(f"{label} results must be an array of objects")
    return tuple(rows)


def _write_bytes_new(path: Path, payload: bytes, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(payload)
    except BaseException:
        path.unlink(missing_ok=True)
        raise


def _write_json_new(path: Path, value: object, *, pretty: bool = False) -> None:
    rendered = (
        json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2, allow_nan=False)
        if pretty else canonical_json(value)
    ) + "\n"
    _write_bytes_new(path, rendered.encode("utf-8"))


def _extract_archive(archive_path: Path, destination: Path) -> int:
    executable = shutil.which("7z")
    if not executable:
        raise TCGCSVUniverseError("7z is required to extract TCGCSV PPMd archives")
    destination.mkdir(parents=True, exist_ok=False)
    result = subprocess.run(  # noqa: S603 - fixed binary and local paths
        [executable, "x", "-bd", "-y", f"-o{destination}", str(archive_path)],
        capture_output=True,
        text=True,
        timeout=300,
        check=False,
    )
    if result.returncode:
        raise TCGCSVUniverseError(
            f"7z extraction failed: {(result.stderr or result.stdout)[-500:].strip()}"
        )
    root = destination.resolve()
    total = 0
    count = 0
    for path in destination.rglob("*"):
        resolved = path.resolve()
        if not resolved.is_relative_to(root) or path.is_symlink():
            raise TCGCSVUniverseError("archive extraction produced an unsafe path")
        if path.is_file():
            count += 1
            total += path.stat().st_size
            if count > MAX_EXTRACTED_FILES or total > MAX_EXPANDED_BYTES:
                raise TCGCSVUniverseError("archive expansion exceeds safety limits")
    if not count:
        raise TCGCSVUniverseError("archive extracted no files")
    return total


def _database_url(argument: str | None) -> str:
    value = argument or os.environ.get("TCGCSV_INGEST_DATABASE_URL", "")
    if not value:
        raise ValueError("database URL is required via --database-url or TCGCSV_INGEST_DATABASE_URL")
    return value


def _resolve_archive_date(source_updated: datetime, requested: str | None) -> date:
    try:
        archive_date = date.fromisoformat(requested) if requested else source_updated.date()
    except ValueError as exc:
        raise TCGCSVUniverseError("archive date is not a valid ISO date") from exc
    if archive_date != source_updated.date():
        raise TCGCSVUniverseError(
            "archive date must match the exact last-updated source timestamp date; "
            "historical preparation must supply its matching --source-updated-at"
        )
    return archive_date


def _prepare_archive(args: argparse.Namespace) -> dict[str, object]:
    output = Path(args.output_dir)
    output.mkdir(parents=True, exist_ok=False, mode=0o700)
    budget = RequestBudget()
    source_updated = (
        _timestamp(args.source_updated_at)
        if args.source_updated_at else _timestamp(_fetch_text(
            args.base_url, "last-updated.txt", user_agent=args.user_agent, budget=budget
        ))
    )
    archive_date = _resolve_archive_date(source_updated, args.archive_date)
    categories_payload = _fetch_json(
        args.base_url, "tcgplayer/categories",
        user_agent=args.user_agent, budget=budget,
    )
    categories = _results(categories_payload, "categories")
    card_category_ids = sorted(
        int(category["categoryId"]) for category in categories if is_card_category(category)
    )
    if args.category_id:
        requested = {int(value) for value in args.category_id}
        unknown = requested - set(card_category_ids)
        if unknown:
            raise TCGCSVUniverseError(f"requested categories are not classified as cards: {sorted(unknown)}")
        card_category_ids = sorted(requested)

    archive_path = output / f"prices-{archive_date.isoformat()}.ppmd.7z"
    if args.archive_file:
        source_archive = Path(args.archive_file)
        if not source_archive.is_file() or source_archive.stat().st_size > MAX_ARCHIVE_BYTES:
            raise TCGCSVUniverseError("local archive is absent or exceeds its size limit")
        _write_bytes_new(archive_path, source_archive.read_bytes())
    else:
        payload = _fetch_bytes(
            args.base_url,
            f"archive/tcgplayer/prices-{archive_date.isoformat()}.ppmd.7z",
            user_agent=args.user_agent,
            budget=budget,
            maximum=MAX_ARCHIVE_BYTES,
            accept="application/octet-stream",
        )
        _write_bytes_new(archive_path, payload)
    # Availability is when CollectFolio actually finished acquiring this source
    # object, not the provider's historical archive date. This keeps local
    # backfills from fabricating earlier point-in-time evidence.
    source_available = datetime.now(timezone.utc)
    if source_available < source_updated:
        raise TCGCSVUniverseError("source availability cannot precede the provider timestamp")
    archive_hash = file_sha256(archive_path)

    normalized_csv = output / "prices.csv"
    parquet_path = output / "prices.parquet"
    feature_csv = output / "market-features.csv"
    set_feature_csv = output / "set-features.csv"
    with tempfile.TemporaryDirectory(prefix="collectfolio-tcgcsv-extract-") as temporary:
        extracted = Path(temporary) / "archive"
        expanded_bytes = _extract_archive(archive_path, extracted)
        normalization = normalize_extracted_archive(
            extracted, archive_date, card_category_ids, normalized_csv,
            source_available_at=source_available,
        )
    parquet = write_price_parquet(normalized_csv, parquet_path)
    history = [Path(value) for value in (args.history_parquet or [])]
    history.append(parquet_path)
    features = compile_market_feature_csvs(
        history,
        as_of_date=archive_date,
        group_keys=(
            (receipt.category_id, receipt.group_id)
            for receipt in normalization.group_receipts
        ),
        feature_csv_path=feature_csv,
        set_feature_csv_path=set_feature_csv,
    )
    if features["featureCount"] != normalization.price_count:
        raise TCGCSVUniverseError("feature compiler did not cover every current price series")

    # Live downloads always recheck the source after the expensive archive and
    # feature pass, even when the workflow supplied the exact initial timestamp.
    # An explicit local archive file is the bounded historical-backfill path.
    if not args.archive_file:
        source_after = _timestamp(_fetch_text(
            args.base_url, "last-updated.txt", user_agent=args.user_agent, budget=budget
        ))
        if source_after != source_updated:
            raise TCGCSVUniverseError("TCGCSV changed during archive preparation; retry")

    normalized = normalization.as_dict()
    normalized["expandedBytes"] = expanded_bytes
    packet = {
        "contractVersion": UNIVERSE_CONTRACT_VERSION,
        "parserVersion": UNIVERSE_PARSER_VERSION,
        "sourceId": args.source_id,
        "termsReviewId": args.terms_review_id,
        "archiveDate": archive_date.isoformat(),
        "sourceUpdatedAt": source_updated.isoformat(),
        "sourceAvailableAt": source_available.isoformat(),
        "archive": {
            "localPath": str(archive_path.resolve()),
            "normalizedCsvPath": str(normalized_csv.resolve()),
            "objectUri": args.archive_object_uri,
            "sha256": archive_hash,
            "bytes": archive_path.stat().st_size,
        },
        "parquet": {
            "localPath": str(parquet_path.resolve()),
            "objectUri": args.parquet_object_uri,
            **parquet,
        },
        "normalization": normalized,
        "features": {
            **features,
            "featureCsvPath": str(feature_csv.resolve()),
            "setFeatureCsvPath": str(set_feature_csv.resolve()),
            "featureObjectUri": args.feature_object_uri,
            "setFeatureObjectUri": args.set_feature_object_uri,
        },
        "metadata": {
            "requestCount": budget.count,
            "cardCategoryPolicy": "provider-label-plus-reviewed-exceptions-v1",
            "forecastMode": "private_research_only",
        },
    }
    _write_json_new(output / "archive-packet.json", packet, pretty=args.pretty)
    return packet


def _archive_command(args: argparse.Namespace) -> int:
    packet = _prepare_archive(args)
    if args.ingest:
        result = ingest_archive_packet(_database_url(args.database_url), packet)
        print(canonical_json(result))
    else:
        print(canonical_json({
            "packet": str((Path(args.output_dir) / "archive-packet.json").resolve()),
            "archiveDate": packet["archiveDate"],
            "priceCount": packet["normalization"]["priceCount"],
            "featureCount": packet["features"]["featureCount"],
        }))
    return 0


def _read_packet(path: str) -> Mapping[str, object]:
    with Path(path).open(encoding="utf-8") as handle:
        value = json.load(handle)
    if not isinstance(value, Mapping):
        raise ValueError("packet must be a JSON object")
    return value


def _ingest_archive_command(args: argparse.Namespace) -> int:
    result = ingest_archive_packet(_database_url(args.database_url), _read_packet(args.packet))
    print(canonical_json(result))
    return 0


def _catalog_packet(args: argparse.Namespace) -> dict[str, object]:
    budget = RequestBudget()
    source_updated = _timestamp(_fetch_text(
        args.base_url, "last-updated.txt", user_agent=args.user_agent, budget=budget
    ))
    category_rows = _results(_fetch_json(
        args.base_url, "tcgplayer/categories", user_agent=args.user_agent, budget=budget
    ), "categories")
    categories = [normalize_category(row) for row in category_rows]
    card_categories = [row for row in categories if row["is_card_category"]]
    groups: list[dict[str, object]] = []
    errors: list[dict[str, object]] = []
    for category in card_categories:
        category_id = int(category["category_id"])
        try:
            rows = _results(_fetch_json(
                args.base_url, f"tcgplayer/{category_id}/groups",
                user_agent=args.user_agent, budget=budget,
            ), f"groups {category_id}")
        except Exception as exc:  # preserve other categories and seal partial
            errors.append({"categoryId": category_id, "stage": "groups", "error": str(exc)[:500]})
            continue
        groups.extend(normalize_group(category_id, row) for row in rows)

    database_url = _database_url(args.database_url) if args.use_database_state or args.ingest else ""
    if database_url:
        current, unresolved = load_catalog_planning_state(database_url, args.source_id)
    else:
        current, unresolved = {}, set()
    plan = plan_catalog_refresh(
        groups,
        current_groups=current,
        unresolved_groups=unresolved,
        audit_date=source_updated.date(),
    )
    products: list[dict[str, object]] = []
    for (category_id, group_id), reasons in sorted(plan.items()):
        try:
            rows = _results(_fetch_json(
                args.base_url, f"tcgplayer/{category_id}/{group_id}/products",
                user_agent=args.user_agent, budget=budget,
            ), f"products {category_id}/{group_id}")
        except Exception as exc:
            errors.append({
                "categoryId": category_id, "groupId": group_id,
                "stage": "products", "reasons": list(reasons), "error": str(exc)[:500],
            })
            continue
        products.extend(normalize_product(category_id, group_id, row) for row in rows)

    source_after = _timestamp(_fetch_text(
        args.base_url, "last-updated.txt", user_agent=args.user_agent, budget=budget
    ))
    if source_after != source_updated:
        raise TCGCSVUniverseError("TCGCSV changed during catalog refresh; retry")
    scope = {
        "contractVersion": UNIVERSE_CONTRACT_VERSION,
        "cardCategoryIds": sorted(int(row["category_id"]) for row in card_categories),
        "plannedGroups": [
            {"categoryId": key[0], "groupId": key[1], "reasons": list(reasons)}
            for key, reasons in sorted(plan.items())
        ],
    }
    catalog_content = {
        "categories": categories,
        "groups": groups,
        "products": products,
        "partial": bool(errors),
        "errors": errors,
    }
    return {
        "contractVersion": UNIVERSE_CONTRACT_VERSION,
        "parserVersion": UNIVERSE_PARSER_VERSION,
        "sourceId": args.source_id,
        "termsReviewId": args.terms_review_id,
        "sourceUpdatedAt": source_updated.isoformat(),
        "scopeSha256": content_hash(scope),
        "catalogContentSha256": content_hash(catalog_content),
        "categories": categories,
        "groups": groups,
        "products": products,
        "partial": bool(errors),
        "errors": errors,
        "metadata": {
            "requestCount": budget.count,
            "plannedProductGroupCount": len(plan),
            "successfulProductGroupCount": len(plan) - sum(
                1 for error in errors if error["stage"] == "products"
            ),
            "auditCycleDays": 7,
        },
    }


def _catalog_command(args: argparse.Namespace) -> int:
    packet = _catalog_packet(args)
    _write_json_new(Path(args.output), packet, pretty=args.pretty)
    if args.ingest:
        result = ingest_catalog_packet(_database_url(args.database_url), packet)
        print(canonical_json(result))
    else:
        print(canonical_json({
            "packet": str(Path(args.output).resolve()),
            "categories": len(packet["categories"]),
            "groups": len(packet["groups"]),
            "products": len(packet["products"]),
            "partial": packet["partial"],
        }))
    return 0


def _ingest_catalog_command(args: argparse.Namespace) -> int:
    result = ingest_catalog_packet(_database_url(args.database_url), _read_packet(args.packet))
    print(canonical_json(result))
    return 0


def _export_catalog_snapshot_command(args: argparse.Namespace) -> int:
    snapshot = export_catalog_snapshot(_database_url(args.database_url), args.source_id)
    _write_json_new(Path(args.output), snapshot, pretty=args.pretty)
    print(canonical_json({
        "snapshot": str(Path(args.output).resolve()),
        "catalogAvailableAt": snapshot["catalogAvailableAt"],
        "reconciliation": snapshot["reconciliation"],
        "catalogSnapshotContentSha256": snapshot["catalogSnapshotContentSha256"],
    }))
    return 0


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    archive = subparsers.add_parser("prepare-archive", help="download, normalize, and optionally ingest one archive")
    archive.add_argument("--source-id", required=True)
    archive.add_argument("--terms-review-id", required=True)
    archive.add_argument("--archive-date")
    archive.add_argument("--source-updated-at")
    archive.add_argument("--archive-file")
    archive.add_argument("--category-id", action="append", type=int)
    archive.add_argument("--history-parquet", action="append")
    archive.add_argument("--output-dir", required=True)
    archive.add_argument("--archive-object-uri", required=True)
    archive.add_argument("--parquet-object-uri", required=True)
    archive.add_argument("--feature-object-uri", required=True)
    archive.add_argument("--set-feature-object-uri", required=True)
    archive.add_argument("--base-url", default=DEFAULT_BASE_URL)
    archive.add_argument("--user-agent", default=DEFAULT_USER_AGENT)
    archive.add_argument("--database-url")
    archive.add_argument("--ingest", action="store_true")
    archive.add_argument("--pretty", action="store_true")
    archive.set_defaults(handler=_archive_command)

    ingest_archive = subparsers.add_parser("ingest-archive", help="ingest a prepared archive packet")
    ingest_archive.add_argument("packet")
    ingest_archive.add_argument("--database-url")
    ingest_archive.set_defaults(handler=_ingest_archive_command)

    catalog = subparsers.add_parser("sync-catalog", help="refresh categories, groups, and selected products")
    catalog.add_argument("--source-id", required=True)
    catalog.add_argument("--terms-review-id", required=True)
    catalog.add_argument("--output", required=True)
    catalog.add_argument("--base-url", default=DEFAULT_BASE_URL)
    catalog.add_argument("--user-agent", default=DEFAULT_USER_AGENT)
    catalog.add_argument("--database-url")
    catalog.add_argument("--use-database-state", action="store_true")
    catalog.add_argument("--ingest", action="store_true")
    catalog.add_argument("--pretty", action="store_true")
    catalog.set_defaults(handler=_catalog_command)

    ingest_catalog = subparsers.add_parser("ingest-catalog", help="ingest a prepared catalog packet")
    ingest_catalog.add_argument("packet")
    ingest_catalog.add_argument("--database-url")
    ingest_catalog.set_defaults(handler=_ingest_catalog_command)

    snapshot = subparsers.add_parser(
        "export-catalog-snapshot",
        help="export a repeatable current catalog and reconciliation receipt",
    )
    snapshot.add_argument("--source-id", required=True)
    snapshot.add_argument("--output", required=True)
    snapshot.add_argument("--database-url")
    snapshot.add_argument("--pretty", action="store_true")
    snapshot.set_defaults(handler=_export_catalog_snapshot_command)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        return int(args.handler(args))
    except (OSError, ValueError, RuntimeError, TCGCSVUniverseError) as exc:
        print(f"tcgcsv-universe: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
