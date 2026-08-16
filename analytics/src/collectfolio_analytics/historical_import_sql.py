"""Guarded, replay-safe SQL for centralized historical-price imports."""

from __future__ import annotations

from datetime import datetime, timezone
from hashlib import sha256
import json
from typing import Mapping, Sequence
from uuid import UUID, uuid5

from .historical_import import (
    HISTORY_IMPORT_CONTRACT_VERSION,
    HISTORY_IMPORT_MODE,
    HISTORY_IMPORT_NAMESPACE,
    MAX_HISTORY_OBSERVATIONS,
    MAX_HISTORY_SERIES,
    validate_history_import_metadata,
)


TABLE_COLUMNS = {
    "source_ingestion_runs": (
        "id", "source_id", "terms_review_id", "started_at", "completed_at",
        "status", "records_read", "records_written", "records_quarantined",
        "raw_payload_hash", "parser_version", "code_commit", "error_summary", "metadata",
    ),
    "market_series": (
        "id", "catalog_variant_id", "source_id", "mapping_id",
        "provider_product_id", "provider_variant_key", "mapping_version",
        "currency", "language", "finish", "condition_class",
        "market_condition", "price_semantics", "identity_hash",
    ),
    "price_observations": (
        "id", "ingestion_run_id", "source_id", "terms_review_id", "mapping_id",
        "variant_id", "market_series_id", "external_record_id", "price_semantics",
        "currency", "market_price", "observed_at", "available_at", "ingested_at",
        "quality_score", "observation_status", "reason_codes", "source_record_hash",
        "metadata",
    ),
    "data_quality_events": (
        "entity_type", "entity_id", "event_kind", "flag_code", "severity", "details",
        "actor_label", "event_hash",
    ),
    "centralized_historical_price_import_observations": (
        "import_id", "observation_id", "market_series_id", "source_record_hash",
        "observation_status",
    ),
    "centralized_historical_price_imports": (
        "id", "contract_version", "ingestion_run_id", "source_id", "terms_review_id",
        "dataset_sha256", "series_set_sha256", "observation_set_sha256",
        "quality_policy_hash", "expected_series_count", "expected_observation_count",
        "expected_accepted_count", "observed_from", "observed_through",
        "available_from", "available_through", "ingested_at",
        "availability_semantics", "point_in_time_eligible", "mapping_version",
        "parser_version", "code_version", "operator_label", "metadata",
    ),
}


def _mapping(value: object, name: str) -> Mapping[str, object]:
    if not isinstance(value, Mapping):
        raise ValueError(f"{name} must be an object")
    return value


def _rows(
    value: object,
    name: str,
    *,
    maximum: int,
    required: bool = True,
) -> tuple[Mapping[str, object], ...]:
    if not isinstance(value, list) or any(not isinstance(item, Mapping) for item in value):
        raise ValueError(f"{name} must be an array of objects")
    rows = tuple(value)
    if required and not rows:
        raise ValueError(f"{name} must not be empty")
    if len(rows) > maximum:
        raise ValueError(f"{name} exceeds the {maximum}-row limit")
    return rows


def _uuid(value: object, name: str) -> str:
    try:
        return str(UUID(str(value)))
    except (TypeError, ValueError, AttributeError) as exc:
        raise ValueError(f"{name} must be a UUID") from exc


def _text(value: object, name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{name} must be non-empty")
    return value.strip()


def _digest(value: object, name: str) -> str:
    result = _text(value, name).lower()
    if len(result) != 64 or any(character not in "0123456789abcdef" for character in result):
        raise ValueError(f"{name} must be a SHA-256 digest")
    return result


def _datetime(value: object, name: str) -> datetime:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{name} must be an ISO-8601 datetime")
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(f"{name} must be an ISO-8601 datetime") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError(f"{name} must include a timezone")
    return parsed.astimezone(timezone.utc)


def _number(value: object, name: str) -> float:
    if isinstance(value, bool):
        raise ValueError(f"{name} must be numeric")
    try:
        result = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} must be numeric") from exc
    if result <= 0:
        raise ValueError(f"{name} must be positive")
    return result


def _canonical_hash(value: object) -> str:
    try:
        payload = json.dumps(
            value, ensure_ascii=False, sort_keys=True, separators=(",", ":"),
            allow_nan=False,
        )
    except (TypeError, ValueError) as exc:
        raise ValueError("history import contains a non-JSON value") from exc
    return sha256(payload.encode("utf-8")).hexdigest()


def _line_hash(values: Sequence[str]) -> str:
    return sha256("\n".join(sorted(values)).encode("utf-8")).hexdigest()


def _require_columns(table: str, rows: Sequence[Mapping[str, object]]) -> None:
    expected = set(TABLE_COLUMNS[table])
    for index, row in enumerate(rows):
        keys = set(row)
        if keys != expected:
            raise ValueError(
                f"{table}[{index}] column mismatch; "
                f"missing={sorted(expected - keys)}, extra={sorted(keys - expected)}"
            )


def _literal(value: object) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def _json_literal(value: object, tag_name: str) -> str:
    try:
        payload = json.dumps(
            value, ensure_ascii=False, sort_keys=True, separators=(",", ":"),
            allow_nan=False,
        )
    except (TypeError, ValueError) as exc:
        raise ValueError("history import SQL requires strict finite JSON") from exc
    tag = f"$collectfolio_{tag_name}$"
    if tag in payload:
        raise ValueError("history import JSON contains a reserved SQL delimiter")
    return f"{tag}{payload}{tag}::jsonb"


def _series_identity_hash(row: Mapping[str, object]) -> str:
    fields = (
        _uuid(row.get("catalog_variant_id"), "series catalog_variant_id"),
        _uuid(row.get("source_id"), "series source_id"),
        _uuid(row.get("mapping_id"), "series mapping_id"),
        _text(row.get("provider_product_id"), "series provider_product_id"),
        str(row.get("provider_variant_key") or ""),
        _text(row.get("mapping_version"), "series mapping_version"),
        _text(row.get("currency"), "series currency"),
        _text(row.get("language"), "series language"),
        _text(row.get("finish"), "series finish"),
        _text(row.get("condition_class"), "series condition_class"),
        _text(row.get("market_condition"), "series market_condition"),
        _text(row.get("price_semantics"), "series price_semantics"),
    )
    return sha256("|".join(fields).encode("utf-8")).hexdigest()


def _source_record_hash(
    row: Mapping[str, object],
    series: Mapping[str, object],
) -> str:
    return _canonical_hash({
        "externalRecordId": _text(row.get("external_record_id"), "external_record_id"),
        "externalProductId": _text(
            series.get("provider_product_id"), "provider_product_id"
        ),
        "externalVariantKey": str(series.get("provider_variant_key") or ""),
        "priceSemantics": _text(row.get("price_semantics"), "price_semantics"),
        "currency": _text(row.get("currency"), "currency"),
        "marketPrice": _number(row.get("market_price"), "market_price"),
        "observedAt": _datetime(row.get("observed_at"), "observed_at").isoformat(),
        "availableAt": _datetime(row.get("available_at"), "available_at").isoformat(),
        "quality": float(row.get("quality_score")),
    })


def _validated_packet(packet: Mapping[str, object]) -> tuple[
    Mapping[str, object],
    tuple[Mapping[str, object], ...],
    tuple[Mapping[str, object], ...],
    tuple[Mapping[str, object], ...],
    tuple[Mapping[str, object], ...],
    Mapping[str, object],
]:
    root = _mapping(packet, "packet")
    if root.get("mode") != HISTORY_IMPORT_MODE:
        raise PermissionError("SQL export requires operator-owned centralized history")
    if root.get("contractVersion") != HISTORY_IMPORT_CONTRACT_VERSION:
        raise ValueError("unsupported centralized-history contract version")
    if root.get("publicCandidateRows") != [] or root.get("forecastRows") != []:
        raise PermissionError("history import cannot contain publications or forecasts")

    ingestion = _mapping(root.get("ingestionRunRow"), "ingestionRunRow")
    series_rows = _rows(
        root.get("marketSeriesRows"), "marketSeriesRows", maximum=MAX_HISTORY_SERIES
    )
    observation_rows = _rows(
        root.get("observationRows"),
        "observationRows",
        maximum=MAX_HISTORY_OBSERVATIONS,
    )
    quality_rows = _rows(
        root.get("qualityEventRows", []),
        "qualityEventRows",
        maximum=MAX_HISTORY_OBSERVATIONS,
        required=False,
    )
    membership_rows = _rows(
        root.get("observationMembershipRows"),
        "observationMembershipRows",
        maximum=MAX_HISTORY_OBSERVATIONS,
    )
    manifest = _mapping(root.get("importManifestRow"), "importManifestRow")
    _require_columns("source_ingestion_runs", (ingestion,))
    _require_columns("market_series", series_rows)
    _require_columns("price_observations", observation_rows)
    _require_columns("data_quality_events", quality_rows)
    _require_columns(
        "centralized_historical_price_import_observations", membership_rows
    )
    _require_columns("centralized_historical_price_imports", (manifest,))
    validate_history_import_metadata(manifest.get("metadata"), "manifest metadata")

    import_id = _uuid(manifest.get("id"), "import id")
    run_id = _uuid(manifest.get("ingestion_run_id"), "ingestion run id")
    source_id = _uuid(manifest.get("source_id"), "source id")
    terms_id = _uuid(manifest.get("terms_review_id"), "terms review id")
    mapping_version = _text(manifest.get("mapping_version"), "mapping_version")
    dataset_hash = _digest(manifest.get("dataset_sha256"), "dataset_sha256")
    quality_policy_hash = _digest(
        manifest.get("quality_policy_hash"), "quality_policy_hash"
    )
    if manifest.get("contract_version") != HISTORY_IMPORT_CONTRACT_VERSION:
        raise ValueError("manifest contract version differs from its packet")
    if (
        _uuid(ingestion.get("id"), "ingestion id") != run_id
        or _uuid(ingestion.get("source_id"), "ingestion source") != source_id
        or _uuid(ingestion.get("terms_review_id"), "ingestion terms") != terms_id
    ):
        raise ValueError("ingestion run differs from the sealed manifest lineage")
    metadata = _mapping(ingestion.get("metadata"), "ingestion metadata")
    if (
        metadata.get("contractVersion") != HISTORY_IMPORT_CONTRACT_VERSION
        or metadata.get("historyImportId") != import_id
        or metadata.get("qualityPolicyHash") != quality_policy_hash
        or metadata.get("availabilitySemantics") != manifest.get("availability_semantics")
        or metadata.get("pointInTimeEligible") is not manifest.get("point_in_time_eligible")
    ):
        raise ValueError("ingestion metadata differs from the sealed history declaration")
    if ingestion.get("raw_payload_hash") != dataset_hash:
        raise ValueError("ingestion payload hash differs from the dataset hash")
    if ingestion.get("parser_version") != manifest.get("parser_version"):
        raise ValueError("parser version differs across history lineage")
    if ingestion.get("code_commit") != manifest.get("code_version"):
        raise ValueError("code version differs across history lineage")

    series_by_id: dict[str, Mapping[str, object]] = {}
    identity_hashes: list[str] = []
    for row in series_rows:
        series_id = _uuid(row.get("id"), "market series id")
        if series_id in series_by_id:
            raise ValueError("market-series IDs must be unique")
        if _uuid(row.get("source_id"), "market series source") != source_id:
            raise ValueError("market series crossed the import source")
        if row.get("mapping_version") != mapping_version:
            raise ValueError("market series crossed the import mapping version")
        expected_identity_hash = _series_identity_hash(row)
        if _digest(row.get("identity_hash"), "series identity_hash") != expected_identity_hash:
            raise ValueError("market-series identity hash was tampered")
        expected_id = str(uuid5(
            UUID(_uuid(row.get("catalog_variant_id"), "catalog_variant_id")),
            f"collectfolio:market-series:{expected_identity_hash}",
        ))
        if series_id != expected_id:
            raise ValueError("market-series deterministic ID was tampered")
        series_by_id[series_id] = row
        identity_hashes.append(expected_identity_hash)
    if len(set(identity_hashes)) != len(identity_hashes):
        raise ValueError("market-series identity hashes must be unique")

    observation_ids: set[str] = set()
    source_hashes: set[str] = set()
    dataset_lines: list[str] = []
    observation_lines: list[str] = []
    observed_times: list[datetime] = []
    available_times: list[datetime] = []
    accepted_count = 0
    for row in observation_rows:
        observation_id = _uuid(row.get("id"), "observation id")
        market_series_id = _uuid(row.get("market_series_id"), "observation series")
        series = series_by_id.get(market_series_id)
        if series is None:
            raise ValueError("observation references an undeclared market series")
        if observation_id in observation_ids:
            raise ValueError("observation IDs must be unique")
        observation_ids.add(observation_id)
        if (
            _uuid(row.get("ingestion_run_id"), "observation run") != run_id
            or _uuid(row.get("source_id"), "observation source") != source_id
            or _uuid(row.get("terms_review_id"), "observation terms") != terms_id
            or _uuid(row.get("mapping_id"), "observation mapping")
                != _uuid(series.get("mapping_id"), "series mapping")
            or _uuid(row.get("variant_id"), "observation variant")
                != _uuid(series.get("catalog_variant_id"), "series variant")
            or row.get("currency") != series.get("currency")
            or row.get("price_semantics") != series.get("price_semantics")
        ):
            raise ValueError("observation differs from exact series or import lineage")
        if _datetime(row.get("ingested_at"), "observation ingested_at") != _datetime(
            manifest.get("ingested_at"), "manifest ingested_at"
        ):
            raise ValueError("observation ingested_at differs from its manifest")
        observed = _datetime(row.get("observed_at"), "observation observed_at")
        available = _datetime(row.get("available_at"), "observation available_at")
        if available < observed:
            raise ValueError("observation available_at precedes observed_at")
        source_hash = _source_record_hash(row, series)
        if _digest(row.get("source_record_hash"), "source_record_hash") != source_hash:
            raise ValueError("source-record hash was tampered")
        if source_hash in source_hashes:
            raise ValueError("source-record hashes must be unique")
        source_hashes.add(source_hash)
        expected_observation_id = str(uuid5(
            UUID(_uuid(row.get("variant_id"), "observation variant")),
            f"collectfolio:price-observation:{source_id}:{source_hash}",
        ))
        if observation_id != expected_observation_id:
            raise ValueError("observation deterministic ID was tampered")
        status = row.get("observation_status")
        if status not in {"accepted", "outlier", "quarantined"}:
            raise ValueError("centralized price points require accepted/outlier/quarantined status")
        accepted_count += status == "accepted"
        identity_hash = str(series["identity_hash"])
        dataset_lines.append(f"{identity_hash}|{source_hash}")
        observation_lines.append(f"{identity_hash}|{source_hash}|{status}")
        observed_times.append(observed)
        available_times.append(available)

    if _line_hash(dataset_lines) != dataset_hash:
        raise ValueError("dataset hash differs from canonical exact-series membership")
    if _line_hash(identity_hashes) != manifest.get("series_set_sha256"):
        raise ValueError("series-set hash differs from canonical membership")
    if _line_hash(observation_lines) != manifest.get("observation_set_sha256"):
        raise ValueError("observation-set hash differs from canonical membership")
    if (
        manifest.get("expected_series_count") != len(series_rows)
        or manifest.get("expected_observation_count") != len(observation_rows)
        or manifest.get("expected_accepted_count") != accepted_count
        or ingestion.get("records_read") != len(observation_rows)
        or ingestion.get("records_written") != len(observation_rows)
        or ingestion.get("records_quarantined") != len(observation_rows) - accepted_count
    ):
        raise ValueError("history counts differ from canonical membership")
    expected_status = "succeeded" if accepted_count == len(observation_rows) else "partial"
    if ingestion.get("status") != expected_status or ingestion.get("completed_at") is None:
        raise ValueError("ingestion terminal status differs from quality counts")
    bounds = (
        ("observed_from", min(observed_times)),
        ("observed_through", max(observed_times)),
        ("available_from", min(available_times)),
        ("available_through", max(available_times)),
    )
    for field, expected in bounds:
        if _datetime(manifest.get(field), field) != expected:
            raise ValueError(f"{field} differs from canonical observation bounds")
    ingested_at = _datetime(manifest.get("ingested_at"), "ingested_at")
    if max(available_times) > ingested_at:
        raise ValueError("source availability exceeds the declared ingestion time")
    semantics = manifest.get("availability_semantics")
    if semantics == "operator_first_seen" and any(value != ingested_at for value in available_times):
        raise ValueError("operator_first_seen requires availability at ingestion")
    if semantics == "observed_at_proxy" and any(
        available != observed
        for available, observed in zip(available_times, observed_times, strict=True)
    ):
        raise ValueError("observed_at_proxy requires observed-time availability labels")
    expected_point_in_time = semantics != "observed_at_proxy"
    if manifest.get("point_in_time_eligible") is not expected_point_in_time:
        raise ValueError("point-in-time eligibility differs from availability semantics")

    expected_import_id = str(uuid5(HISTORY_IMPORT_NAMESPACE, "import|" + "|".join((
        source_id,
        terms_id,
        dataset_hash,
        mapping_version,
        quality_policy_hash,
        str(semantics),
    ))))
    if import_id != expected_import_id:
        raise ValueError("history-import deterministic ID was tampered")
    if run_id != str(uuid5(UUID(import_id), "source-ingestion-run")):
        raise ValueError("history ingestion-run deterministic ID was tampered")

    expected_membership = {
        (
            import_id,
            _uuid(row.get("id"), "observation id"),
            _uuid(row.get("market_series_id"), "market series id"),
            _digest(row.get("source_record_hash"), "source record hash"),
            str(row.get("observation_status")),
        )
        for row in observation_rows
    }
    actual_membership = {
        (
            _uuid(row.get("import_id"), "membership import id"),
            _uuid(row.get("observation_id"), "membership observation id"),
            _uuid(row.get("market_series_id"), "membership market series id"),
            _digest(row.get("source_record_hash"), "membership source record hash"),
            str(row.get("observation_status")),
        )
        for row in membership_rows
    }
    if len(actual_membership) != len(membership_rows) or actual_membership != expected_membership:
        raise ValueError("history observation membership differs from canonical packet rows")

    for row in quality_rows:
        event_hash = _digest(row.get("event_hash"), "quality event hash")
        event = {key: value for key, value in row.items() if key != "event_hash"}
        if _canonical_hash(event) != event_hash:
            raise ValueError("quality-event hash was tampered")
    return ingestion, series_rows, observation_rows, membership_rows, quality_rows, manifest


def build_centralized_history_import_sql(
    packet: Mapping[str, object],
    *,
    commit: bool = False,
) -> str:
    """Return an exact-replay-safe transaction; rollback rehearsal is default."""

    (
        ingestion,
        series_rows,
        observation_rows,
        membership_rows,
        quality_rows,
        manifest,
    ) = _validated_packet(packet)
    import_id = str(manifest["id"])
    run_id = str(ingestion["id"])
    source_id = str(manifest["source_id"])
    terms_id = str(manifest["terms_review_id"])
    manifest_json = _json_literal(manifest, "history_manifest_json")
    ingestion_json = _json_literal(ingestion, "history_ingestion_json")
    series_json = _json_literal(series_rows, "history_series_json")
    observation_json = _json_literal(observation_rows, "history_observations_json")
    membership_json = _json_literal(membership_rows, "history_membership_json")
    quality_json = _json_literal(quality_rows, "history_quality_json")

    preflight = f"""do $collectfolio_history_guard$
declare
  requested_manifest public.centralized_historical_price_imports%rowtype;
  requested_run public.source_ingestion_runs%rowtype;
begin
  select * into requested_manifest
  from jsonb_populate_record(null::public.centralized_historical_price_imports, {manifest_json});
  select * into requested_run
  from jsonb_populate_record(null::public.source_ingestion_runs, {ingestion_json});
  if coalesce((select enabled from public.product_feature_flags
               where key = 'public_price_intelligence'), false) then
    raise exception 'public_price_intelligence must remain disabled during history import';
  end if;
  if not exists (
    select 1
    from public.data_sources source
    join public.source_terms_reviews review
      on review.id = source.current_terms_review_id and review.source_id = source.id
    where source.id = {_literal(source_id)}::uuid
      and review.id = {_literal(terms_id)}::uuid
      and source.active
      and review.decision in ('research_only', 'approved')
      and review.reviewed_at <= {_literal(manifest['ingested_at'])}::timestamptz
      and (review.expires_at is null or review.expires_at > greatest(
        {_literal(manifest['ingested_at'])}::timestamptz, clock_timestamp()
      ))
  ) then
    raise exception 'centralized-history source review is not current';
  end if;
  if exists (
    select 1 from public.centralized_historical_price_imports existing
    where existing.id = requested_manifest.id
      and (to_jsonb(existing) - array[
        'stored_rows_sha256','first_seen_from','first_seen_through','created_at'
      ])
          is distinct from
          (to_jsonb(requested_manifest) - array[
            'stored_rows_sha256','first_seen_from','first_seen_through','created_at'
          ])
  ) then
    raise exception 'history import ID already exists with different sealed content';
  end if;
  if exists (
    select 1 from public.centralized_historical_price_imports existing
    where existing.source_id = requested_manifest.source_id
      and existing.terms_review_id = requested_manifest.terms_review_id
      and existing.dataset_sha256 = requested_manifest.dataset_sha256
      and existing.mapping_version = requested_manifest.mapping_version
      and existing.quality_policy_hash = requested_manifest.quality_policy_hash
      and existing.availability_semantics = requested_manifest.availability_semantics
      and existing.id <> requested_manifest.id
  ) then
    raise exception 'history dataset is already sealed under a different import ID';
  end if;
  if exists (
    select 1 from public.source_ingestion_runs existing
    where existing.id = requested_run.id
      and to_jsonb(existing) is distinct from to_jsonb(requested_run)
  ) then
    raise exception 'history ingestion-run ID already exists with different content';
  end if;
  if exists (
    select 1
    from jsonb_populate_recordset(null::public.market_series, {series_json}) requested
    join public.market_series existing
      on existing.id = requested.id or existing.identity_hash = requested.identity_hash
    where (to_jsonb(existing) - 'created_at')
          is distinct from (to_jsonb(requested) - 'created_at')
  ) then
    raise exception 'market-series overlap is not an exact replay';
  end if;
  if exists (
    select 1
    from jsonb_populate_recordset(null::public.price_observations, {observation_json}) requested
    join public.price_observations existing on existing.id = requested.id or (
      existing.source_id = requested.source_id
      and existing.external_record_id = requested.external_record_id
      and existing.price_semantics = requested.price_semantics
      and existing.observed_at = requested.observed_at
      and existing.source_record_hash = requested.source_record_hash
    )
    where (
      (to_jsonb(existing) - array[
        'created_at','source_available_at','collectfolio_first_seen_at','available_at',
        'ingestion_run_id','ingested_at'
      ]) || jsonb_build_object('available_at', existing.source_available_at)
    ) is distinct from (
      to_jsonb(requested) - array[
        'created_at','source_available_at','collectfolio_first_seen_at',
        'ingestion_run_id','ingested_at'
      ]
    )
  ) then
    raise exception 'observation overlap is not an exact immutable replay';
  end if;
  if exists (
    select 1
    from jsonb_populate_recordset(null::public.data_quality_events, {quality_json}) requested
    join public.data_quality_events existing on existing.event_hash = requested.event_hash
    where (to_jsonb(existing) - array['id','created_at'])
          is distinct from (to_jsonb(requested) - array['id','created_at'])
  ) then
    raise exception 'quality-event overlap is not an exact replay';
  end if;
  if exists (
    select 1 from public.source_ingestion_runs existing
    where existing.id = requested_run.id
  ) and not exists (
    select 1 from public.centralized_historical_price_imports
    where id = requested_manifest.id
  ) and (
    select count(*) from public.centralized_historical_price_import_observations
    where import_id = requested_manifest.id
  ) <> requested_manifest.expected_observation_count then
    raise exception 'unsealed terminal history run has incomplete observation membership';
  end if;
end
$collectfolio_history_guard$;"""

    staging_run = dict(ingestion)
    staging_run.update({
        "completed_at": None,
        "status": "running",
        "records_read": 0,
        "records_written": 0,
        "records_quarantined": 0,
    })
    staging_json = _json_literal(staging_run, "history_staging_run_json")
    run_columns = ", ".join(TABLE_COLUMNS["source_ingestion_runs"])
    series_columns = ", ".join(TABLE_COLUMNS["market_series"])
    observation_columns = ", ".join(TABLE_COLUMNS["price_observations"])
    membership_columns = ", ".join(
        TABLE_COLUMNS["centralized_historical_price_import_observations"]
    )
    quality_columns = ", ".join(TABLE_COLUMNS["data_quality_events"])
    manifest_columns = ", ".join(TABLE_COLUMNS["centralized_historical_price_imports"])
    inserts = f"""insert into public.source_ingestion_runs ({run_columns})
select {run_columns}
from jsonb_populate_record(null::public.source_ingestion_runs, {staging_json}) requested
where not exists (
  select 1 from public.source_ingestion_runs where id = requested.id
)
on conflict (id) do nothing;

insert into public.market_series ({series_columns})
select {series_columns}
from jsonb_populate_recordset(null::public.market_series, {series_json}) requested
where not exists (
  select 1 from public.centralized_historical_price_imports
  where id = {_literal(import_id)}::uuid
)
and not exists (
  select 1 from public.market_series existing where existing.id = requested.id
)
on conflict do nothing;

insert into public.price_observations ({observation_columns})
select {observation_columns}
from jsonb_populate_recordset(null::public.price_observations, {observation_json}) requested
where not exists (
  select 1 from public.centralized_historical_price_imports
  where id = {_literal(import_id)}::uuid
)
and not exists (
  select 1 from public.price_observations existing where existing.id = requested.id
)
on conflict do nothing;

insert into public.centralized_historical_price_import_observations ({membership_columns})
select {membership_columns}
from jsonb_populate_recordset(
  null::public.centralized_historical_price_import_observations, {membership_json}
) requested
where not exists (
  select 1 from public.centralized_historical_price_imports
  where id = {_literal(import_id)}::uuid
)
and not exists (
  select 1 from public.centralized_historical_price_import_observations existing
  where existing.import_id = requested.import_id
    and existing.observation_id = requested.observation_id
)
on conflict (import_id, observation_id) do nothing;

insert into public.data_quality_events ({quality_columns})
select {quality_columns}
from jsonb_populate_recordset(null::public.data_quality_events, {quality_json}) requested
where not exists (
  select 1 from public.centralized_historical_price_imports
  where id = {_literal(import_id)}::uuid
)
and not exists (
  select 1 from public.data_quality_events existing
  where existing.event_hash = requested.event_hash
)
on conflict (event_hash) do nothing;

update public.source_ingestion_runs target
set completed_at = requested.completed_at,
    status = requested.status,
    records_read = requested.records_read,
    records_written = requested.records_written,
    records_quarantined = requested.records_quarantined,
    raw_payload_hash = requested.raw_payload_hash,
    parser_version = requested.parser_version,
    code_commit = requested.code_commit,
    error_summary = requested.error_summary,
    metadata = requested.metadata
from jsonb_populate_record(null::public.source_ingestion_runs, {ingestion_json}) requested
where target.id = requested.id and target.status = 'running';

insert into public.centralized_historical_price_imports ({manifest_columns})
select {manifest_columns}
from jsonb_populate_record(
  null::public.centralized_historical_price_imports, {manifest_json}
) requested
where not exists (
  select 1 from public.centralized_historical_price_imports existing
  where existing.id = requested.id
)
on conflict (id) do nothing;"""

    verification = f"""do $collectfolio_history_verify$
begin
  if not exists (
    select 1 from public.centralized_historical_price_imports
    where id = {_literal(import_id)}::uuid
      and ingestion_run_id = {_literal(run_id)}::uuid
      and dataset_sha256 = {_literal(manifest['dataset_sha256'])}
      and series_set_sha256 = {_literal(manifest['series_set_sha256'])}
      and observation_set_sha256 = {_literal(manifest['observation_set_sha256'])}
      and stored_rows_sha256 ~ '^[0-9a-f]{{64}}$'
      and expected_series_count = {manifest['expected_series_count']}
      and expected_observation_count = {manifest['expected_observation_count']}
      and expected_accepted_count = {manifest['expected_accepted_count']}
      and first_seen_from is not null and first_seen_through is not null
  ) then
    raise exception 'centralized-history manifest verification failed';
  end if;
  if (select count(*) from public.centralized_historical_price_import_observations
      where import_id = {_literal(import_id)}::uuid)
       <> {manifest['expected_observation_count']} then
    raise exception 'centralized-history observation count changed after sealing';
  end if;
  if exists (
    select 1
    from public.centralized_historical_price_import_observations membership
    join public.price_observations observation
      on observation.id = membership.observation_id
    where membership.import_id = {_literal(import_id)}::uuid
      and (observation.source_available_at is null
           or observation.collectfolio_first_seen_at is null
           or observation.available_at < observation.collectfolio_first_seen_at)
  ) then
    raise exception 'centralized-history effective availability was not database-sealed';
  end if;
  if coalesce((select enabled from public.product_feature_flags
               where key = 'public_price_intelligence'), false) then
    raise exception 'history import changed the public intelligence boundary';
  end if;
end
$collectfolio_history_verify$;"""
    terminator = "commit;" if commit else "rollback;"
    return f"begin;\n\n{preflight}\n\n{inserts}\n\n{verification}\n\n{terminator}\n"
