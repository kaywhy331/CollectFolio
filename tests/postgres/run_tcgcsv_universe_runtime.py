#!/usr/bin/env python3
"""Exercise migration 0020 and its Python adapter against disposable PostgreSQL."""

from __future__ import annotations

import csv
from datetime import date, datetime, timedelta, timezone
import json
import os
from pathlib import Path
import tempfile

import psycopg
from psycopg.conninfo import make_conninfo

from collectfolio_analytics.tcgcsv_universe import (
    UNIVERSE_CONTRACT_VERSION,
    UNIVERSE_PARSER_VERSION,
    TCGCSVUniverseError,
    content_hash,
    file_sha256,
    normalize_category,
    normalize_extracted_archive,
    normalize_group,
    normalize_product,
)
from collectfolio_analytics.tcgcsv_universe_io import (
    compile_market_feature_csvs,
    export_catalog_snapshot,
    ingest_archive_packet,
    ingest_catalog_packet,
    load_catalog_planning_state,
    write_price_parquet,
)


SOURCE_ID = "00000000-0000-0000-0000-000000000201"
TERMS_ID = "00000000-0000-0000-0000-000000000202"
LOADER_ROLE = "collectfolio_tcgcsv_runtime_loader"
CATEGORY_ID = 3
GROUP_ID = 23651
PRODUCT_ID = 590027


class RuntimeFailure(RuntimeError):
    pass


def expect(value: bool, message: str) -> None:
    if not value:
        raise RuntimeFailure(message)


def connection_info(*, user: str | None = None) -> str:
    explicit = os.environ.get("TCGCSV_RUNTIME_ADMIN_DATABASE_URL")
    if explicit and user is None:
        return explicit
    values: dict[str, str] = {}
    for environment, keyword in (
        ("PGDATABASE", "dbname"),
        ("PGHOST", "host"),
        ("PGPORT", "port"),
        ("PGUSER", "user"),
        ("PGPASSWORD", "password"),
    ):
        if os.environ.get(environment):
            values[keyword] = os.environ[environment]
    if user is not None:
        values["user"] = user
        values.pop("password", None)
    return make_conninfo(**values)


def bootstrap(admin_info: str) -> None:
    database = os.environ.get("PGDATABASE", "")
    if not database or os.environ.get("COLLECTFOLIO_TCGCSV_DB_TEST") != database:
        raise RuntimeFailure(
            "COLLECTFOLIO_TCGCSV_DB_TEST must exactly match PGDATABASE for the disposable DB"
        )
    with psycopg.connect(admin_info) as connection:
        with connection.cursor() as cursor:
            cursor.execute("select count(*) from public.tcgcsv_archive_runs")
            if cursor.fetchone()[0]:
                raise RuntimeFailure("TCGCSV runtime test requires an unused migration-0020 schema")
            cursor.execute(f"""
do $$
begin
  if not exists (select 1 from pg_roles where rolname = '{LOADER_ROLE}') then
    create role {LOADER_ROLE}
      login noinherit nosuperuser nocreatedb nocreaterole nobypassrls;
  elsif exists (
    select 1 from pg_roles where rolname = '{LOADER_ROLE}'
      and (not rolcanlogin or rolinherit or rolsuper or rolcreatedb
           or rolcreaterole or rolbypassrls)
  ) then
    raise exception '{LOADER_ROLE} is not a restricted NOINHERIT login';
  end if;
end;
$$;
grant collectfolio_tcgcsv_ingest to {LOADER_ROLE};
insert into public.data_sources (
  id, code, name, source_type, terms_url, active
) values (
  '{SOURCE_ID}', 'tcgcsv-research', 'TCGCSV disposable runtime',
  'bulk_archive', 'https://tcgcsv.com', true
);
insert into public.source_terms_reviews (
  id, source_id, terms_version, terms_url, decision,
  commercial_use_allowed, catalog_metadata_allowed, image_display_allowed,
  public_raw_display_allowed, public_derived_display_allowed,
  attribution_required, reviewed_at, expires_at, review_notes, document_hash
) values (
  '{TERMS_ID}', '{SOURCE_ID}', 'runtime-private-v1',
  'https://tcgcsv.com', 'research_only', false, false, false, false, false,
  false, clock_timestamp() - interval '1 day',
  clock_timestamp() + interval '30 days', 'Disposable local fixture', repeat('2', 64)
);
update public.data_sources set current_terms_review_id = '{TERMS_ID}'
where id = '{SOURCE_ID}';
""")


def provider_rows(price: float, *, include_reverse: bool) -> list[dict[str, object]]:
    normal = {
        "productId": PRODUCT_ID,
        "subTypeName": "Holofoil",
        "lowPrice": price - 5,
        "midPrice": price + 5,
        "highPrice": price + 20,
        "marketPrice": price,
        "directLowPrice": price - 2,
    }
    rows = [normal]
    if include_reverse:
        rows.append({
            **normal,
            "subTypeName": "Reverse Holofoil",
            "marketPrice": price / 2,
        })
    return rows


def build_archive_packet(
    root: Path,
    archive_date: date,
    rows: list[dict[str, object]],
    history: list[Path],
) -> tuple[dict[str, object], Path]:
    run = root / archive_date.isoformat()
    extracted = run / "extracted"
    member = extracted / archive_date.isoformat() / str(CATEGORY_ID) / str(GROUP_ID) / "prices"
    member.parent.mkdir(parents=True)
    member.write_text(
        json.dumps({"success": True, "errors": [], "results": rows}),
        encoding="utf-8",
    )
    source_updated_at = datetime.combine(
        archive_date, datetime.min.time(), tzinfo=timezone.utc
    ).replace(hour=20)
    source_available_at = source_updated_at + timedelta(hours=11)
    normalized_csv = run / "prices.csv"
    normalization = normalize_extracted_archive(
        extracted, archive_date, [CATEGORY_ID], normalized_csv,
        source_available_at=source_available_at,
    )
    parquet_path = run / "prices.parquet"
    parquet = write_price_parquet(normalized_csv, parquet_path)
    feature_csv = run / "market-features.csv"
    set_feature_csv = run / "set-features.csv"
    features = compile_market_feature_csvs(
        [*history, parquet_path],
        as_of_date=archive_date,
        group_keys=[(CATEGORY_ID, GROUP_ID)],
        feature_csv_path=feature_csv,
        set_feature_csv_path=set_feature_csv,
    )
    raw = run / "prices.ppmd.7z"
    raw.write_bytes(("runtime-archive-" + archive_date.isoformat()).encode("ascii"))
    packet: dict[str, object] = {
        "contractVersion": UNIVERSE_CONTRACT_VERSION,
        "parserVersion": UNIVERSE_PARSER_VERSION,
        "sourceId": SOURCE_ID,
        "termsReviewId": TERMS_ID,
        "archiveDate": archive_date.isoformat(),
        "sourceUpdatedAt": source_updated_at.isoformat(),
        "sourceAvailableAt": source_available_at.isoformat(),
        "archive": {
            "localPath": str(raw),
            "normalizedCsvPath": str(normalized_csv),
            "objectUri": f"s3://runtime-private/raw/{archive_date.isoformat()}.7z",
            "sha256": file_sha256(raw),
            "bytes": raw.stat().st_size,
        },
        "parquet": {
            "localPath": str(parquet_path),
            "objectUri": f"s3://runtime-private/history/{archive_date.isoformat()}.parquet",
            **parquet,
        },
        "normalization": normalization.as_dict(),
        "features": {
            **features,
            "featureCsvPath": str(feature_csv),
            "setFeatureCsvPath": str(set_feature_csv),
            "featureObjectUri": f"s3://runtime-private/features/{archive_date.isoformat()}/market.csv",
            "setFeatureObjectUri": f"s3://runtime-private/features/{archive_date.isoformat()}/sets.csv",
        },
        "metadata": {"fixture": True},
    }
    return packet, parquet_path


def rewrite_feature_hash(feature_csv: Path, replacement: str) -> None:
    with feature_csv.open(newline="", encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
        columns = tuple(rows[0].keys())
    rows[0]["feature_sha256"] = replacement
    with feature_csv.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns, lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)


def tamper_market_price(price_csv: Path) -> None:
    with price_csv.open(newline="", encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
        columns = tuple(rows[0].keys())
    rows[0]["market_price"] = "999.0000"
    with price_csv.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns, lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)


def archive_arguments(packet: dict[str, object]) -> tuple[object, ...]:
    archive = packet["archive"]
    parquet = packet["parquet"]
    normalization = packet["normalization"]
    features = packet["features"]
    assert isinstance(archive, dict) and isinstance(parquet, dict)
    assert isinstance(normalization, dict) and isinstance(features, dict)
    return (
        packet["sourceId"], packet["termsReviewId"], packet["archiveDate"],
        packet["sourceUpdatedAt"], packet["sourceAvailableAt"],
        archive["sha256"], archive["bytes"],
        normalization["expandedBytes"], archive["objectUri"], parquet["objectUri"],
        parquet["sha256"], parquet["bytes"],
        features["featureObjectUri"], features["setFeatureObjectUri"],
        normalization["scopeSha256"],
        normalization["csvSha256"], features["featureCsvSha256"],
        features["setFeatureCsvSha256"], packet["parserVersion"],
        len(normalization["categoryIds"]), len(normalization["groupReceipts"]),
        normalization["priceCount"], features["featureCount"],
        features["setFeatureCount"], json.dumps(packet.get("metadata", {})),
    )


def catalog_packet(
    source_updated: datetime,
    *,
    product_name: str = "Pikachu ex - 238/191",
) -> dict[str, object]:
    category = normalize_category({
        "categoryId": CATEGORY_ID,
        "name": "Pokemon",
        "displayName": "Pokémon",
        "nonSealedLabel": "Single Cards",
    })
    group = normalize_group(CATEGORY_ID, {
        "groupId": GROUP_ID,
        "name": "Surging Sparks",
        "abbreviation": "SV08",
        "publishedOn": "2024-11-08T00:00:00",
        "modifiedOn": "runtime-v1",
    })
    product = normalize_product(CATEGORY_ID, GROUP_ID, {
        "productId": PRODUCT_ID,
        "name": product_name,
        "cleanName": "Pikachu ex 238 191",
        "modifiedOn": "runtime-v1",
        "extendedData": [
            {"name": "Number", "displayName": "Number", "value": "238/191"},
            {"name": "Rarity", "displayName": "Rarity", "value": "SIR"},
            {"name": "Card Type", "displayName": "Type", "value": "Lightning"},
        ],
    })
    errors: list[dict[str, object]] = []
    content = {
        "categories": [category], "groups": [group], "products": [product],
        "partial": False, "errors": errors,
    }
    return {
        "contractVersion": UNIVERSE_CONTRACT_VERSION,
        "parserVersion": UNIVERSE_PARSER_VERSION,
        "sourceId": SOURCE_ID,
        "termsReviewId": TERMS_ID,
        "sourceUpdatedAt": source_updated.isoformat(),
        "scopeSha256": content_hash({"fixture": "catalog-scope-v1"}),
        "catalogContentSha256": content_hash(content),
        **content,
        "metadata": {"fixture": True},
    }


def scalar(admin_info: str, sql: str, parameters: tuple[object, ...] = ()) -> object:
    with psycopg.connect(admin_info) as connection:
        with connection.cursor() as cursor:
            cursor.execute(sql, parameters)
            return cursor.fetchone()[0]


def run() -> None:
    admin_info = connection_info()
    loader_info = connection_info(user=LOADER_ROLE)
    bootstrap(admin_info)

    with tempfile.TemporaryDirectory(prefix="collectfolio-tcgcsv-runtime-") as temporary:
        root = Path(temporary)
        first_date = date(2026, 8, 14)
        first, first_parquet = build_archive_packet(
            root, first_date, provider_rows(100, include_reverse=True), []
        )
        first_result = ingest_archive_packet(loader_info, first)
        expect(first_result["status"] == "sealed", "first archive did not seal")
        expect(first_result["currentStateApplied"] is True, "first archive was not current")
        expect(first_result["priceCount"] == 2, "first archive omitted a price series")
        first_run_id = first_result["runId"]
        expect(
            scalar(admin_info, "select count(*) from public.tcgcsv_price_current") == 2,
            "current prices do not cover both first-day series",
        )
        expect(
            scalar(
                admin_info,
                "select occurrence_count from public.tcgcsv_unresolved_products "
                "where source_id = %s and product_id = %s",
                (SOURCE_ID, PRODUCT_ID),
            ) == 2,
            "unknown product did not aggregate both subtype occurrences",
        )
        replay = ingest_archive_packet(loader_info, first)
        expect(replay["runId"] == first_run_id, "exact archive replay changed run identity")
        expect(
            replay["currentStateApplied"] is True,
            "sealed archive replay lost its current-state receipt",
        )
        changed_manifest = json.loads(json.dumps(first))
        changed_manifest["archive"]["sha256"] = "f" * 64
        try:
            ingest_archive_packet(loader_info, changed_manifest)
        except TCGCSVUniverseError as error:
            expect("raw archive packet hash changed" in str(error), str(error))
        else:
            raise RuntimeFailure("adapter accepted a packet hash that did not match its file")

        first_feature_path = Path(first["features"]["featureCsvPath"])
        with first_feature_path.open(newline="", encoding="utf-8") as handle:
            first_feature_hash = next(csv.DictReader(handle))["feature_sha256"]

        second_date = first_date + timedelta(days=1)
        second, second_parquet = build_archive_packet(
            root, second_date, provider_rows(125, include_reverse=False), [first_parquet]
        )
        second_feature_path = Path(second["features"]["featureCsvPath"])
        rewrite_feature_hash(second_feature_path, first_feature_hash)
        second["features"]["featureCsvSha256"] = file_sha256(second_feature_path)
        second_result = ingest_archive_packet(loader_info, second)
        expect(second_result["status"] == "sealed", "second archive did not seal")
        expect(second_result["currentStateApplied"] is True, "newer archive was not current")
        expect(
            scalar(admin_info, "select count(*) from public.tcgcsv_price_current") == 1,
            "authoritative second archive did not remove the absent subtype",
        )
        expect(
            float(scalar(
                admin_info,
                "select current_price from public.tcgcsv_market_features_current "
                "where source_id = %s and product_id = %s",
                (SOURCE_ID, PRODUCT_ID),
            )) == 125.0,
            "concrete feature change was suppressed by a stale caller checksum",
        )

        older_date = first_date - timedelta(days=1)
        older, _ = build_archive_packet(
            root, older_date, provider_rows(80, include_reverse=True), []
        )
        older_result = ingest_archive_packet(loader_info, older)
        expect(older_result["status"] == "sealed", "older archive did not seal")
        expect(
            older_result["currentStateApplied"] is False,
            "older archive unexpectedly replaced current state",
        )
        expect(
            scalar(admin_info, "select count(*) from public.tcgcsv_price_current") == 1,
            "older archive changed the current price-series count",
        )
        expect(
            float(scalar(
                admin_info,
                "select market_price from public.tcgcsv_price_current "
                "where source_id = %s and product_id = %s",
                (SOURCE_ID, PRODUCT_ID),
            )) == 125.0,
            "older archive replaced the current card price",
        )
        expect(
            scalar(
                admin_info,
                "select occurrence_count from public.tcgcsv_unresolved_products "
                "where source_id = %s and product_id = %s",
                (SOURCE_ID, PRODUCT_ID),
            ) == 3,
            "older archive changed the unresolved-product queue",
        )
        expect(
            scalar(
                admin_info,
                "select latest_archive_run_id::text from public.tcgcsv_sync_state "
                "where source_id = %s",
                (SOURCE_ID,),
            ) == second_result["runId"],
            "older archive moved the latest archive pointer backward",
        )
        expect(
            scalar(
                admin_info,
                "select latest_archive_date from public.tcgcsv_sync_state "
                "where source_id = %s",
                (SOURCE_ID,),
            ) == second_date,
            "older archive changed the latest archive date",
        )
        expect(
            scalar(
                admin_info,
                "select current_state_applied from public.tcgcsv_archive_runs where id = %s",
                (older_result["runId"],),
            ) is False,
            "older archive did not persist its current-state decision",
        )
        expect(
            scalar(
                admin_info,
                "select "
                "(select count(*) from public.tcgcsv_price_stage where run_id = %s) + "
                "(select count(*) from public.tcgcsv_market_feature_stage where run_id = %s) + "
                "(select count(*) from public.tcgcsv_set_feature_stage where run_id = %s)",
                (older_result["runId"],) * 3,
            ) == 0,
            "older archive left staging rows after sealing",
        )
        older_replay = ingest_archive_packet(loader_info, older)
        expect(older_replay["runId"] == older_result["runId"], "older replay changed run")
        expect(
            older_replay["currentStateApplied"] is False,
            "older sealed replay did not preserve its original receipt",
        )

        third_date = second_date + timedelta(days=1)
        third, third_parquet = build_archive_packet(
            root, third_date, provider_rows(130, include_reverse=False),
            [first_parquet, second_parquet],
        )
        third_price_path = Path(third["archive"]["normalizedCsvPath"])
        tamper_market_price(third_price_path)
        third["normalization"]["csvSha256"] = file_sha256(third_price_path)
        try:
            ingest_archive_packet(loader_info, third)
        except psycopg.Error as error:
            expect(
                "staged price tuple hash is invalid" in str(error),
                f"price tamper failed for the wrong reason: {error}",
            )
        else:
            raise RuntimeFailure("tampered price tuple unexpectedly sealed")
        expect(
            scalar(
                admin_info,
                "select count(*) from public.tcgcsv_archive_runs where archive_date = %s",
                (third_date,),
            ) == 0,
            "failed price-tamper transaction left an archive run behind",
        )

        fourth_date = third_date + timedelta(days=1)
        fourth, _ = build_archive_packet(
            root, fourth_date, provider_rows(135, include_reverse=False),
            [first_parquet, second_parquet, third_parquet],
        )
        with psycopg.connect(loader_info) as connection:
            with connection.cursor() as cursor:
                cursor.execute("set local role collectfolio_tcgcsv_ingest")
                cursor.execute(
                    "select public.begin_tcgcsv_archive_run("
                    + ",".join(["%s"] * 25) + ")",
                    archive_arguments(fourth),
                )
                open_run_id = cursor.fetchone()[0]
                cursor.execute(
                    "insert into public.tcgcsv_archive_run_categories "
                    "(run_id, category_id) values (%s, %s)",
                    (open_run_id, CATEGORY_ID),
                )
        try:
            ingest_archive_packet(loader_info, fourth)
        except psycopg.errors.UniqueViolation:
            pass
        else:
            raise RuntimeFailure("partial open-run replay silently ignored a duplicate stage key")
        expect(
            scalar(
                admin_info,
                "select status from public.tcgcsv_archive_runs where id = %s",
                (open_run_id,),
            ) == "staging",
            "unsafe partial replay unexpectedly sealed",
        )

        newer_product_name = "Pikachu ex - current catalog"
        catalog_updated_at = datetime(2026, 8, 15, 20, tzinfo=timezone.utc)
        catalog = catalog_packet(
            catalog_updated_at,
            product_name=newer_product_name,
        )
        catalog_result = ingest_catalog_packet(loader_info, catalog)
        expect(catalog_result["status"] == "sealed", "catalog did not seal")
        expect(catalog_result["currentStateApplied"] is True, "newer catalog was not current")
        expect(
            scalar(
                admin_info,
                "select resolved_at is not null from public.tcgcsv_unresolved_products "
                "where source_id = %s and product_id = %s",
                (SOURCE_ID, PRODUCT_ID),
            ) is True,
            "catalog product did not resolve the unknown-product queue",
        )
        current, unresolved = load_catalog_planning_state(loader_info, SOURCE_ID)
        expect((CATEGORY_ID, GROUP_ID) in current, "restricted planner cannot read current groups")
        expect(not unresolved, "resolved product remained in the planner retry set")
        snapshot = export_catalog_snapshot(loader_info, SOURCE_ID)
        expect(
            snapshot["reconciliation"]["status"] == "eligible",
            f"reconciled catalog snapshot abstained: {snapshot['reconciliation']}",
        )
        expect(snapshot["rowCounts"]["currentSeries"] == 1, "snapshot price count changed")
        expect(
            snapshot["latestArchive"]["featureCsvSha256"]
            == second["features"]["featureCsvSha256"],
            "snapshot is not bound to the sealed feature object",
        )
        expect(snapshot["latestArchive"]["featureCount"] == 1,
               "snapshot sealed feature count changed")
        expect(len(snapshot["latestArchive"]["seriesManifestSha256"]) == 64,
               "snapshot series manifest hash is malformed")
        expect(snapshot["products"][0]["changedByRunId"] == catalog_result["runId"],
               "snapshot omitted product provenance")
        expect(len(snapshot["catalogSnapshotContentSha256"]) == 64,
               "snapshot content hash is malformed")
        catalog_replay = ingest_catalog_packet(loader_info, catalog)
        expect(
            catalog_replay["runId"] == catalog_result["runId"],
            "exact catalog replay changed run identity",
        )
        expect(
            catalog_replay["currentStateApplied"] is True,
            "sealed catalog replay lost its current-state receipt",
        )

        older_catalog = catalog_packet(
            catalog_updated_at - timedelta(days=1),
            product_name="Pikachu ex - stale catalog",
        )
        older_catalog_result = ingest_catalog_packet(loader_info, older_catalog)
        expect(older_catalog_result["status"] == "sealed", "older catalog did not seal")
        expect(
            older_catalog_result["currentStateApplied"] is False,
            "older catalog unexpectedly replaced current state",
        )
        expect(
            scalar(
                admin_info,
                "select name from public.tcgcsv_products_current "
                "where source_id = %s and product_id = %s",
                (SOURCE_ID, PRODUCT_ID),
            ) == newer_product_name,
            "older catalog replaced the current product name",
        )
        expect(
            scalar(
                admin_info,
                "select latest_catalog_run_id::text from public.tcgcsv_sync_state "
                "where source_id = %s",
                (SOURCE_ID,),
            ) == catalog_result["runId"],
            "older catalog moved the latest catalog pointer backward",
        )
        expect(
            scalar(
                admin_info,
                "select latest_catalog_updated_at from public.tcgcsv_sync_state "
                "where source_id = %s",
                (SOURCE_ID,),
            ) == catalog_updated_at,
            "older catalog changed the latest catalog timestamp",
        )
        expect(
            scalar(
                admin_info,
                "select current_state_applied from public.tcgcsv_catalog_runs where id = %s",
                (older_catalog_result["runId"],),
            ) is False,
            "older catalog did not persist its current-state decision",
        )
        expect(
            scalar(
                admin_info,
                "select "
                "(select count(*) from public.tcgcsv_category_stage where run_id = %s) + "
                "(select count(*) from public.tcgcsv_group_stage where run_id = %s) + "
                "(select count(*) from public.tcgcsv_product_stage where run_id = %s)",
                (older_catalog_result["runId"],) * 3,
            ) == 0,
            "older catalog left staging rows after sealing",
        )
        older_catalog_replay = ingest_catalog_packet(loader_info, older_catalog)
        expect(
            older_catalog_replay["runId"] == older_catalog_result["runId"],
            "older catalog replay changed run identity",
        )
        expect(
            older_catalog_replay["currentStateApplied"] is False,
            "older catalog replay did not preserve its original receipt",
        )
        changed_catalog = json.loads(json.dumps(catalog))
        changed_catalog["products"][0]["name"] = "Tampered same-timestamp product"
        try:
            ingest_catalog_packet(loader_info, changed_catalog)
        except TCGCSVUniverseError as error:
            expect("catalog packet content hash changed" in str(error), str(error))
        else:
            raise RuntimeFailure("adapter accepted catalog rows outside the content manifest")
        changed_catalog["catalogContentSha256"] = content_hash({
            "categories": changed_catalog["categories"],
            "groups": changed_catalog["groups"],
            "products": changed_catalog["products"],
            "partial": changed_catalog["partial"],
            "errors": changed_catalog["errors"],
        })
        try:
            ingest_catalog_packet(loader_info, changed_catalog)
        except psycopg.Error as error:
            expect(
                "source timestamp already exists with different content" in str(error),
                f"catalog content conflict failed for the wrong reason: {error}",
            )
        else:
            raise RuntimeFailure("same-timestamp catalog content conflict unexpectedly sealed")

        with psycopg.connect(loader_info) as connection:
            with connection.cursor() as cursor:
                cursor.execute("set local role collectfolio_tcgcsv_ingest")
                try:
                    cursor.execute("select count(*) from public.tcgcsv_price_stage")
                except psycopg.errors.InsufficientPrivilege:
                    connection.rollback()
                else:
                    raise RuntimeFailure("restricted ingest role can read private staging rows")


def main() -> int:
    try:
        run()
    except (RuntimeFailure, OSError, ValueError, psycopg.Error) as error:
        print(f"TCGCSV PostgreSQL runtime test failed: {error}", file=os.sys.stderr)
        return 1
    print(
        "TCGCSV PostgreSQL runtime test passed: restricted-role archive/catalog "
        "ingestion, exact replay, current-series replacement, checksum-independent "
        "updates, monotonic current state, price-tamper rejection, strict partial "
        "replay, and catalog resolution"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
