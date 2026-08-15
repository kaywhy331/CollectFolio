"""Optional DuckDB and PostgreSQL adapters for the private TCGCSV universe."""

from __future__ import annotations

from contextlib import closing
import csv
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
import json
from pathlib import Path
from typing import Iterable, Iterator, Mapping, Sequence
from uuid import UUID

from .tcgcsv_universe import (
    CATALOG_SNAPSHOT_CONTRACT_VERSION,
    FEATURE_COLUMNS,
    SET_FEATURE_COLUMNS,
    TCGCSVUniverseError,
    build_shadow_feature,
    content_hash,
    feature_csv_row,
    file_sha256,
    set_feature_csv_row,
    set_feature_record,
)


def _duckdb():
    try:
        import duckdb  # type: ignore[import-not-found]
    except ImportError as exc:
        raise RuntimeError(
            "DuckDB is required; install collectfolio-analytics[market-universe]"
        ) from exc
    return duckdb


def _psycopg():
    try:
        import psycopg  # type: ignore[import-not-found]
        from psycopg.types.json import Jsonb  # type: ignore[import-not-found]
    except ImportError as exc:
        raise RuntimeError(
            "psycopg is required; install collectfolio-analytics[market-universe]"
        ) from exc
    return psycopg, Jsonb


def _sql_literal(value: str) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def _new_output(path: Path) -> Path:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        raise FileExistsError(f"refusing to overwrite {target}")
    return target


def write_price_parquet(csv_path: Path, parquet_path: Path) -> dict[str, object]:
    """Convert one normalized daily CSV into a typed, sorted Parquet object."""

    source = Path(csv_path)
    if not source.is_file():
        raise FileNotFoundError(source)
    target = _new_output(Path(parquet_path))
    duckdb = _duckdb()
    columns = {
        "archive_date": "DATE",
        "source_available_at": "TIMESTAMPTZ",
        "category_id": "INTEGER",
        "group_id": "INTEGER",
        "product_id": "BIGINT",
        "subtype_name": "VARCHAR",
        "series_sha256": "VARCHAR",
        "low_price": "DECIMAL(16,4)",
        "mid_price": "DECIMAL(16,4)",
        "high_price": "DECIMAL(16,4)",
        "market_price": "DECIMAL(16,4)",
        "direct_low_price": "DECIMAL(16,4)",
        "price_tuple_sha256": "VARCHAR",
    }
    with closing(duckdb.connect(database=":memory:")) as connection:
        connection.execute(
            "create temp table normalized_prices as select * from read_csv(?, "
            "header=true, columns=?, nullstr='', strict_mode=true)",
            [str(source), columns],
        )
        row_count = int(connection.execute(
            "select count(*) from normalized_prices"
        ).fetchone()[0])
        if row_count <= 0:
            raise TCGCSVUniverseError("normalized price CSV contains no rows")
        connection.execute(
            "copy (select * from normalized_prices order by category_id, group_id, "
            "product_id, subtype_name) to " + _sql_literal(str(target))
            + " (format parquet, compression zstd, row_group_size 100000)"
        )
        written_count = int(connection.execute(
            "select count(*) from read_parquet(?)", [str(target)]
        ).fetchone()[0])
    if written_count != row_count:
        target.unlink(missing_ok=True)
        raise TCGCSVUniverseError("Parquet row count does not match normalized CSV")
    return {
        "rowCount": row_count,
        "sha256": file_sha256(target),
        "bytes": target.stat().st_size,
    }


def _history_sources(values: Sequence[str | Path]) -> list[str]:
    sources = [str(value) for value in values if str(value).strip()]
    if not sources:
        raise ValueError("at least one Parquet history source is required")
    return sources


def _metric_sql(as_of: date) -> str:
    day = _sql_literal(as_of.isoformat()) + "::date"

    def reference(horizon: int) -> str:
        target = as_of - timedelta(days=horizon)
        earliest = target - timedelta(days=3)
        return (
            "arg_max(market_price, archive_date) filter (where archive_date between "
            f"{_sql_literal(earliest.isoformat())}::date and "
            f"{_sql_literal(target.isoformat())}::date)"
        )

    return f"""
create temp table market_metrics as
with raw as (
  select archive_date, source_available_at, category_id, group_id, product_id, subtype_name,
         series_sha256, market_price::double as market_price
  from history_input
  where archive_date between {day} - interval '368 days' and {day}
),
today as (
  select category_id, group_id, product_id, subtype_name, series_sha256,
         max(market_price) as current_price,
         max(source_available_at) as source_available_at
  from raw where archive_date = {day}
  group by all
),
daily as (
  select archive_date, category_id, group_id, product_id, subtype_name,
         any_value(series_sha256) as series_sha256,
         max(market_price) as market_price
  from raw where market_price > 0
  group by archive_date, category_id, group_id, product_id, subtype_name
),
windowed as (
  select *,
    lag(market_price) over series_window as previous_price,
    lag(archive_date) over series_window as previous_date,
    max(market_price) over (
      partition by category_id, group_id, product_id, subtype_name
      order by archive_date rows between unbounded preceding and current row
    ) as running_peak
  from daily
  window series_window as (
    partition by category_id, group_id, product_id, subtype_name order by archive_date
  )
),
enriched as (
  select *,
    case when previous_price > 0 and date_diff('day', previous_date, archive_date) > 0
      then ln(market_price / previous_price)
           / sqrt(date_diff('day', previous_date, archive_date)) end as daily_log_return,
    case when running_peak > 0 then 1 - market_price / running_peak end as drawdown
  from windowed
),
aggregated as (
  select category_id, group_id, product_id, subtype_name,
    count(*) as observation_count,
    {reference(7)} as reference_7d,
    {reference(30)} as reference_30d,
    {reference(90)} as reference_90d,
    {reference(180)} as reference_180d,
    {reference(365)} as reference_365d,
    regr_slope(ln(market_price), date_diff('day', date '1970-01-01', archive_date))
      filter (where archive_date >= {day} - interval '30 days') as daily_log_slope_30d,
    stddev_samp(daily_log_return)
      filter (where archive_date >= {day} - interval '30 days') as volatility_30d,
    max(drawdown) as max_drawdown_365d,
    count(*)::double / 366.0 as history_density_365d
  from enriched group by category_id, group_id, product_id, subtype_name
)
select today.category_id, today.group_id, today.product_id, today.subtype_name,
       today.series_sha256,
       cast(today.source_available_at as varchar) as source_available_at,
       case when today.current_price > 0 then today.current_price end as current_price,
       coalesce(aggregated.observation_count, 0) as observation_count,
       case when today.current_price > 0 and reference_7d > 0
            then today.current_price / reference_7d - 1 end as return_7d,
       case when today.current_price > 0 and reference_30d > 0
            then today.current_price / reference_30d - 1 end as return_30d,
       case when today.current_price > 0 and reference_90d > 0
            then today.current_price / reference_90d - 1 end as return_90d,
       case when today.current_price > 0 and reference_180d > 0
            then today.current_price / reference_180d - 1 end as return_180d,
       case when today.current_price > 0 and reference_365d > 0
            then today.current_price / reference_365d - 1 end as return_365d,
       case when isfinite(aggregated.daily_log_slope_30d)
            then aggregated.daily_log_slope_30d end as daily_log_slope_30d,
       case when isfinite(aggregated.volatility_30d)
            then aggregated.volatility_30d end as volatility_30d,
       case when isfinite(aggregated.max_drawdown_365d)
            then aggregated.max_drawdown_365d end as max_drawdown_365d,
       case when isfinite(aggregated.history_density_365d)
            then least(1.0, aggregated.history_density_365d)
            end as history_density_365d
from today left join aggregated using (category_id, group_id, product_id, subtype_name)
order by today.category_id, today.group_id, today.product_id, today.subtype_name
"""


def _rows(cursor, size: int = 5000) -> Iterator[dict[str, object]]:
    names = [item[0] for item in cursor.description]
    while True:
        batch = cursor.fetchmany(size)
        if not batch:
            return
        for values in batch:
            yield dict(zip(names, values, strict=True))


def compile_market_feature_csvs(
    parquet_sources: Sequence[str | Path],
    *,
    as_of_date: date,
    group_keys: Iterable[tuple[int, int]],
    feature_csv_path: Path,
    set_feature_csv_path: Path,
) -> dict[str, object]:
    """Compile one current feature and forecast-estimate row per daily series."""

    feature_target = _new_output(Path(feature_csv_path))
    set_target = _new_output(Path(set_feature_csv_path))
    duckdb = _duckdb()
    sources = _history_sources(parquet_sources)
    try:
        with closing(duckdb.connect(database=":memory:")) as connection:
            source_literal = (
                _sql_literal(sources[0]) if len(sources) == 1
                else "[" + ",".join(_sql_literal(value) for value in sources) + "]"
            )
            connection.execute(
                "create temp view history_input as select * from read_parquet("
                + source_literal + ", union_by_name=true)"
            )
            connection.execute(_metric_sql(as_of_date))
            feature_count = 0
            with feature_target.open("x", newline="", encoding="utf-8") as output:
                writer = csv.writer(output, lineterminator="\n")
                writer.writerow(FEATURE_COLUMNS)
                cursor = connection.execute("select * from market_metrics")
                for metric in _rows(cursor):
                    writer.writerow(feature_csv_row(build_shadow_feature(
                        metric, metric["source_available_at"],
                    )))
                    feature_count += 1

            set_metrics = {}
            cursor = connection.execute("""
              select category_id, group_id,
                     count(*) as series_count,
                     count(current_price) as priced_series_count,
                     median(return_30d) as median_return_30d,
                     avg(case when return_30d > 0 then 1.0 else 0.0 end)
                       filter (where return_30d is not null) as breadth_30d,
                     median(volatility_30d) as median_volatility_30d
              from market_metrics group by category_id, group_id
              order by category_id, group_id
            """)
            for row in _rows(cursor):
                set_metrics[(int(row["category_id"]), int(row["group_id"]))] = row

        keys = sorted({(int(category), int(group)) for category, group in group_keys})
        with set_target.open("x", newline="", encoding="utf-8") as output:
            writer = csv.writer(output, lineterminator="\n")
            writer.writerow(SET_FEATURE_COLUMNS)
            for category_id, group_id in keys:
                metric = set_metrics.get((category_id, group_id), {
                    "category_id": category_id,
                    "group_id": group_id,
                    "series_count": 0,
                    "priced_series_count": 0,
                    "median_return_30d": None,
                    "breadth_30d": None,
                    "median_volatility_30d": None,
                })
                writer.writerow(set_feature_csv_row(set_feature_record(metric)))
        return {
            "featureCount": feature_count,
            "featureCsvSha256": file_sha256(feature_target),
            "setFeatureCount": len(keys),
            "setFeatureCsvSha256": file_sha256(set_target),
        }
    except BaseException:
        feature_target.unlink(missing_ok=True)
        set_target.unlink(missing_ok=True)
        raise


def _chunks(values: Iterable[tuple[object, ...]], size: int = 1000) -> Iterator[list[tuple[object, ...]]]:
    batch: list[tuple[object, ...]] = []
    for value in values:
        batch.append(value)
        if len(batch) >= size:
            yield batch
            batch = []
    if batch:
        yield batch


def _insert_chunks(cursor, table: str, columns: Sequence[str], values: Iterable[tuple[object, ...]]) -> None:
    row_template = "(" + ",".join(["%s"] * len(columns)) + ")"
    prefix = f"insert into public.{table} ({','.join(columns)}) values "
    for batch in _chunks(values):
        parameters = [item for row in batch for item in row]
        # A persisted open run must never mix rows from two caller-authored
        # packets. Sealed replay returns before this point; duplicate staging
        # keys therefore indicate an unsafe partial retry and fail closed.
        cursor.execute(prefix + ",".join([row_template] * len(batch)), parameters)


def _csv_dicts(path: Path) -> Iterator[dict[str, str]]:
    with Path(path).open(newline="", encoding="utf-8") as handle:
        yield from csv.DictReader(handle)


def _nullable(value: str) -> object:
    return None if value == "" else value


def _verify_packet_file(
    path_value: object,
    sha256_value: object,
    *,
    label: str,
    byte_count: object | None = None,
) -> None:
    path = Path(str(path_value))
    if not path.is_file():
        raise TCGCSVUniverseError(f"{label} packet file is absent")
    if byte_count is not None and path.stat().st_size != int(byte_count):
        raise TCGCSVUniverseError(f"{label} packet byte count changed")
    if file_sha256(path) != str(sha256_value).lower():
        raise TCGCSVUniverseError(f"{label} packet hash changed")


def ingest_archive_packet(database_url: str, packet: Mapping[str, object]) -> Mapping[str, object]:
    """Stage and atomically seal one exact archive packet using the narrow DB role."""

    normalization = packet["normalization"]
    archive = packet["archive"]
    parquet = packet["parquet"]
    features = packet["features"]
    if not all(isinstance(value, Mapping) for value in (normalization, archive, parquet, features)):
        raise ValueError("archive packet sections must be objects")
    _verify_packet_file(
        archive["localPath"], archive["sha256"], label="raw archive",
        byte_count=archive["bytes"],
    )
    _verify_packet_file(
        parquet["localPath"], parquet["sha256"], label="Parquet",
        byte_count=parquet["bytes"],
    )
    _verify_packet_file(
        archive["normalizedCsvPath"], normalization["csvSha256"],
        label="normalized CSV",
    )
    _verify_packet_file(
        features["featureCsvPath"], features["featureCsvSha256"],
        label="market-feature CSV",
    )
    _verify_packet_file(
        features["setFeatureCsvPath"], features["setFeatureCsvSha256"],
        label="set-feature CSV",
    )
    psycopg, Jsonb = _psycopg()
    with psycopg.connect(database_url) as connection:
        with connection.cursor() as cursor:
            cursor.execute("set local role collectfolio_tcgcsv_ingest")
            cursor.execute(
                "select public.begin_tcgcsv_archive_run(" + ",".join(["%s"] * 25) + ")",
                (
                    packet["sourceId"], packet["termsReviewId"], packet["archiveDate"],
                    packet["sourceUpdatedAt"], packet["sourceAvailableAt"],
                    archive["sha256"], archive["bytes"],
                    normalization["expandedBytes"], archive["objectUri"],
                    parquet["objectUri"], parquet["sha256"], parquet["bytes"],
                    features["featureObjectUri"], features["setFeatureObjectUri"],
                    normalization["scopeSha256"], normalization["csvSha256"],
                    features["featureCsvSha256"], features["setFeatureCsvSha256"],
                    packet["parserVersion"],
                    len(normalization["categoryIds"]), len(normalization["groupReceipts"]),
                    normalization["priceCount"], features["featureCount"],
                    features["setFeatureCount"], Jsonb(packet.get("metadata", {})),
                ),
            )
            run_id = cursor.fetchone()[0]
            cursor.execute("select public.tcgcsv_archive_run_is_open(%s)", (run_id,))
            if not cursor.fetchone()[0]:
                cursor.execute("select public.finalize_tcgcsv_archive_run(%s)", (run_id,))
                return cursor.fetchone()[0]

            _insert_chunks(cursor, "tcgcsv_archive_run_categories", ("run_id", "category_id"), (
                (run_id, category_id) for category_id in normalization["categoryIds"]
            ))
            _insert_chunks(cursor, "tcgcsv_archive_group_receipts", (
                "run_id", "category_id", "group_id", "member_path",
                "member_sha256", "row_count", "member_bytes",
            ), (
                (run_id, item["categoryId"], item["groupId"], item["memberPath"],
                 item["memberSha256"], item["rowCount"], item["memberBytes"])
                for item in normalization["groupReceipts"]
            ))
            _insert_chunks(cursor, "tcgcsv_price_stage", (
                "run_id", "category_id", "group_id", "product_id", "subtype_name",
                "series_sha256", "low_price", "mid_price", "high_price",
                "market_price", "direct_low_price", "price_tuple_sha256",
            ), (
                (run_id, row["category_id"], row["group_id"], row["product_id"],
                 row["subtype_name"], row["series_sha256"], _nullable(row["low_price"]),
                 _nullable(row["mid_price"]), _nullable(row["high_price"]),
                 _nullable(row["market_price"]), _nullable(row["direct_low_price"]),
                 row["price_tuple_sha256"])
                for row in _csv_dicts(Path(archive["normalizedCsvPath"]))
            ))
            _insert_chunks(cursor, "tcgcsv_market_feature_stage", (
                "run_id", *FEATURE_COLUMNS,
            ), (
                (run_id, *(
                    Jsonb(json.loads(row[name])) if name == "forecast_estimates"
                    else _nullable(row[name])
                    for name in FEATURE_COLUMNS
                ))
                for row in _csv_dicts(Path(features["featureCsvPath"]))
            ))
            _insert_chunks(cursor, "tcgcsv_set_feature_stage", (
                "run_id", *SET_FEATURE_COLUMNS,
            ), (
                (run_id, *(_nullable(row[name]) for name in SET_FEATURE_COLUMNS))
                for row in _csv_dicts(Path(features["setFeatureCsvPath"]))
            ))
            cursor.execute("select public.finalize_tcgcsv_archive_run(%s)", (run_id,))
            result = cursor.fetchone()[0]
        connection.commit()
    return result


def load_catalog_planning_state(
    database_url: str,
    source_id: str,
) -> tuple[dict[tuple[int, int], dict[str, object]], set[tuple[int, int]]]:
    psycopg, _ = _psycopg()
    current: dict[tuple[int, int], dict[str, object]] = {}
    unresolved: set[tuple[int, int]] = set()
    with psycopg.connect(database_url) as connection:
        with connection.cursor() as cursor:
            cursor.execute("set local role collectfolio_tcgcsv_ingest")
            cursor.execute(
                "select category_id, group_id, group_sha256, modified_on "
                "from public.tcgcsv_groups_current where source_id = %s",
                (source_id,),
            )
            for category_id, group_id, group_hash, modified_on in cursor:
                current[(category_id, group_id)] = {
                    "group_sha256": group_hash, "modified_on": modified_on,
                }
            cursor.execute(
                "select distinct category_id, group_id from public.tcgcsv_unresolved_products "
                "where source_id = %s and resolved_at is null",
                (source_id,),
            )
            unresolved.update((row[0], row[1]) for row in cursor)
    return current, unresolved


def _snapshot_value(value: object) -> object:
    if isinstance(value, datetime):
        if value.tzinfo is None or value.utcoffset() is None:
            raise TCGCSVUniverseError("database returned a naive snapshot timestamp")
        return value.astimezone(timezone.utc).isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, (UUID, Decimal)):
        return str(value)
    return value


def _snapshot_rows(cursor, sql: str, parameters: tuple[object, ...], columns: Sequence[str]) -> list[dict[str, object]]:
    cursor.execute(sql, parameters)
    return [
        {name: _snapshot_value(value) for name, value in zip(columns, row)}
        for row in cursor
    ]


def export_catalog_snapshot(database_url: str, source_id: str) -> Mapping[str, object]:
    """Read one repeatable, DB-timestamped provider catalog and reconciliation receipt."""

    psycopg, _ = _psycopg()
    with psycopg.connect(database_url) as connection:
        with connection.cursor() as cursor:
            cursor.execute("set transaction isolation level repeatable read")
            cursor.execute("set local role collectfolio_tcgcsv_ingest")
            cursor.execute("select clock_timestamp()")
            catalog_available_at = _snapshot_value(cursor.fetchone()[0])
            cursor.execute(
                "select latest_archive_run_id::text, latest_archive_date, "
                "latest_source_updated_at, latest_catalog_run_id::text, "
                "latest_catalog_updated_at from public.tcgcsv_sync_state "
                "where source_id = %s",
                (source_id,),
            )
            state = cursor.fetchone()
            if state is None or state[3] is None:
                raise TCGCSVUniverseError("catalog snapshot requires a sealed current catalog run")
            if state[0] is None:
                raise TCGCSVUniverseError("catalog snapshot requires a sealed current archive run")
            cursor.execute(
                "select id::text, archive_date, source_updated_at, source_available_at, "
                "scope_sha256, feature_csv_sha256, set_feature_csv_sha256, "
                "expected_feature_count, expected_set_feature_count, status, sealed_at, "
                "current_state_applied from public.tcgcsv_archive_runs "
                "where id = %s and source_id = %s",
                (state[0], source_id),
            )
            archive_run = cursor.fetchone()
            if archive_run is None:
                raise TCGCSVUniverseError("latest archive pointer does not resolve")
            latest_archive = dict(zip((
                "runId", "archiveDate", "sourceUpdatedAt", "sourceAvailableAt",
                "scopeSha256", "featureCsvSha256", "setFeatureCsvSha256",
                "featureCount", "setFeatureCount", "status", "sealedAt",
                "currentStateApplied",
            ), (_snapshot_value(value) for value in archive_run)))
            cursor.execute(
                "select id::text, terms_review_id::text, source_updated_at, "
                "scope_sha256, catalog_content_sha256, parser_version, status, "
                "started_at, sealed_at, current_state_applied, "
                "expected_category_count, expected_group_count, expected_product_count "
                "from public.tcgcsv_catalog_runs where id = %s and source_id = %s",
                (state[3], source_id),
            )
            run = cursor.fetchone()
            if run is None:
                raise TCGCSVUniverseError("latest catalog pointer does not resolve")
            latest_catalog = dict(zip((
                "runId", "termsReviewId", "sourceUpdatedAt", "scopeSha256",
                "catalogContentSha256", "parserVersion", "status", "startedAt",
                "sealedAt", "currentStateApplied", "expectedCategoryCount",
                "expectedGroupCount", "expectedProductCount",
            ), (_snapshot_value(value) for value in run)))

            categories = _snapshot_rows(cursor, (
                "select category_id, name, display_name, is_card_category, "
                "category_sha256, metadata, first_seen_at, last_seen_at, changed_at, "
                "changed_by_run_id::text from public.tcgcsv_categories_current "
                "where source_id = %s order by category_id"
            ), (source_id,), (
                "categoryId", "name", "displayName", "isCardCategory",
                "categorySha256", "metadata", "firstSeenAt", "lastSeenAt",
                "changedAt", "changedByRunId",
            ))
            groups = _snapshot_rows(cursor, (
                "select category_id, group_id, name, abbreviation, published_on, "
                "modified_on, group_sha256, metadata, first_seen_at, last_seen_at, "
                "changed_at, changed_by_run_id::text from public.tcgcsv_groups_current "
                "where source_id = %s order by category_id, group_id"
            ), (source_id,), (
                "categoryId", "groupId", "name", "abbreviation", "publishedOn",
                "modifiedOn", "groupSha256", "metadata", "firstSeenAt", "lastSeenAt",
                "changedAt", "changedByRunId",
            ))
            products = _snapshot_rows(cursor, (
                "select category_id, group_id, product_id, name, clean_name, card_number, "
                "rarity, card_type, modified_on, product_sha256, metadata, first_seen_at, "
                "last_seen_at, changed_at, changed_by_run_id::text "
                "from public.tcgcsv_products_current where source_id = %s "
                "order by category_id, group_id, product_id"
            ), (source_id,), (
                "categoryId", "groupId", "productId", "name", "cleanName", "cardNumber",
                "rarity", "cardType", "modifiedOn", "productSha256", "metadata",
                "firstSeenAt", "lastSeenAt", "changedAt", "changedByRunId",
            ))
            current_series = _snapshot_rows(cursor, (
                "select category_id, group_id, product_id, subtype_name, series_sha256 "
                "from public.tcgcsv_price_current where source_id = %s "
                "order by category_id, group_id, product_id, subtype_name"
            ), (source_id,), (
                "categoryId", "groupId", "productId", "subtypeName", "seriesSha256",
            ))
            latest_archive["seriesManifestSha256"] = content_hash(current_series)
            cursor.execute(
                "select count(*) filter (where price.market_price > 0), "
                "count(distinct (price.category_id, price.group_id, price.product_id)), "
                "count(*) filter (where product.product_id is null) "
                "from public.tcgcsv_price_current price left join public.tcgcsv_products_current product "
                "on product.source_id = price.source_id and product.category_id = price.category_id "
                "and product.group_id = price.group_id and product.product_id = price.product_id "
                "where price.source_id = %s",
                (source_id,),
            )
            positively_priced_series_count, priced_product_count, unmatched_series_count = cursor.fetchone()
            cursor.execute(
                "select count(*) from public.tcgcsv_unresolved_products "
                "where source_id = %s and resolved_at is null",
                (source_id,),
            )
            unresolved_product_count = cursor.fetchone()[0]

    reasons: list[str] = []
    if latest_catalog["status"] != "sealed":
        reasons.append("latest_catalog_refresh_partial")
    if latest_catalog["currentStateApplied"] is not True:
        reasons.append("latest_catalog_not_current")
    if not categories or not groups or not products:
        reasons.append("catalog_rows_incomplete")
    if (
        latest_archive["status"] != "sealed"
        or latest_archive["currentStateApplied"] is not True
        or len(current_series) < 1
    ):
        reasons.append("current_price_snapshot_absent")
    if latest_archive["sourceUpdatedAt"] != latest_catalog["sourceUpdatedAt"]:
        reasons.append("price_catalog_source_mismatch")
    if unmatched_series_count:
        reasons.append("priced_series_missing_catalog_product")
    if unresolved_product_count:
        reasons.append("unresolved_catalog_products")

    content: dict[str, object] = {
        "contractVersion": CATALOG_SNAPSHOT_CONTRACT_VERSION,
        "sourceId": source_id,
        "catalogAvailableAt": catalog_available_at,
        "latestArchive": latest_archive,
        "latestCatalog": latest_catalog,
        "rowCounts": {
            "categories": len(categories),
            "groups": len(groups),
            "products": len(products),
            "currentSeries": len(current_series),
            "positivelyPricedSeries": positively_priced_series_count,
            "pricedProducts": priced_product_count,
        },
        "reconciliation": {
            "status": "eligible" if not reasons else "abstain",
            "reasonCodes": reasons,
            "unmatchedPricedSeries": unmatched_series_count,
            "unresolvedProducts": unresolved_product_count,
        },
        "categories": categories,
        "groups": groups,
        "products": products,
        "privateResearchOnly": True,
        "publicPublicationAllowed": False,
    }
    return {**content, "catalogSnapshotContentSha256": content_hash(content)}


def ingest_catalog_packet(database_url: str, packet: Mapping[str, object]) -> Mapping[str, object]:
    categories = packet.get("categories", [])
    groups = packet.get("groups", [])
    products = packet.get("products", [])
    errors = packet.get("errors", [])
    expected_content_hash = str(packet.get("catalogContentSha256", "")).lower()
    actual_content_hash = content_hash({
        "categories": categories,
        "groups": groups,
        "products": products,
        "partial": bool(packet.get("partial")),
        "errors": errors,
    })
    if actual_content_hash != expected_content_hash:
        raise TCGCSVUniverseError("catalog packet content hash changed")
    psycopg, Jsonb = _psycopg()
    with psycopg.connect(database_url) as connection:
        with connection.cursor() as cursor:
            cursor.execute("set local role collectfolio_tcgcsv_ingest")
            cursor.execute(
                "select public.begin_tcgcsv_catalog_run(" + ",".join(["%s"] * 10) + ")",
                (
                    packet["sourceId"], packet["termsReviewId"], packet["sourceUpdatedAt"],
                    packet["scopeSha256"], packet["catalogContentSha256"],
                    packet["parserVersion"], len(categories), len(groups), len(products),
                    Jsonb(packet.get("metadata", {})),
                ),
            )
            run_id = cursor.fetchone()[0]
            cursor.execute("select public.tcgcsv_catalog_run_is_open(%s)", (run_id,))
            if not cursor.fetchone()[0]:
                cursor.execute(
                    "select public.finalize_tcgcsv_catalog_run(%s, %s)",
                    (run_id, bool(packet.get("partial"))),
                )
                return cursor.fetchone()[0]
            _insert_chunks(cursor, "tcgcsv_category_stage", (
                "run_id", "category_id", "name", "display_name", "is_card_category",
                "category_sha256", "metadata",
            ), (
                (run_id, row["category_id"], row["name"], row["display_name"],
                 row["is_card_category"], row["category_sha256"], Jsonb(row["metadata"]))
                for row in categories
            ))
            _insert_chunks(cursor, "tcgcsv_group_stage", (
                "run_id", "category_id", "group_id", "name", "abbreviation",
                "published_on", "modified_on", "group_sha256", "metadata",
            ), (
                (run_id, row["category_id"], row["group_id"], row["name"],
                 row["abbreviation"], row["published_on"] or None, row["modified_on"],
                 row["group_sha256"], Jsonb(row["metadata"]))
                for row in groups
            ))
            _insert_chunks(cursor, "tcgcsv_product_stage", (
                "run_id", "category_id", "group_id", "product_id", "name",
                "clean_name", "card_number", "rarity", "card_type", "modified_on",
                "product_sha256", "metadata",
            ), (
                (run_id, row["category_id"], row["group_id"], row["product_id"],
                 row["name"], row["clean_name"], row["card_number"], row["rarity"],
                 row["card_type"], row["modified_on"], row["product_sha256"],
                 Jsonb(row["metadata"]))
                for row in products
            ))
            cursor.execute(
                "select public.finalize_tcgcsv_catalog_run(%s, %s)",
                (run_id, bool(packet.get("partial"))),
            )
            result = cursor.fetchone()[0]
        connection.commit()
    return result
