"""Generate guarded SQL for private research evidence; default is rollback rehearsal."""

from __future__ import annotations

import json
from typing import Mapping, Sequence
from uuid import UUID


TABLE_COLUMNS = {
    "source_ingestion_runs": (
        "id", "source_id", "terms_review_id", "started_at", "completed_at",
        "status", "records_read", "records_written", "records_quarantined",
        "raw_payload_hash", "parser_version", "code_commit", "error_summary", "metadata",
    ),
    "price_observations": (
        "ingestion_run_id", "source_id", "terms_review_id", "mapping_id", "variant_id",
        "external_record_id", "price_semantics", "currency", "market_price", "observed_at",
        "available_at", "ingested_at", "quality_score", "observation_status", "reason_codes",
        "source_record_hash", "metadata",
    ),
    "data_quality_events": (
        "entity_type", "entity_id", "event_kind", "flag_code", "severity", "details",
        "actor_label", "event_hash",
    ),
    "analytics_runs": (
        "id", "run_kind", "status", "feature_cutoff", "started_at", "completed_at",
        "dataset_hash", "source_policy_hash", "mapping_version", "feature_version",
        "code_version", "config_hash", "config", "records_read", "records_written",
        "records_quarantined", "error_summary",
    ),
    "analytics_run_sources": (
        "analytics_run_id", "source_id", "terms_review_id", "usage_kind",
    ),
    "trend_feature_snapshots": (
        "id", "analytics_run_id", "variant_id", "source_id", "terms_review_id",
        "feature_cutoff", "price_current", "return_7d", "return_30d", "return_90d",
        "return_180d", "return_365d", "robust_slope_30d", "robust_slope_90d",
        "momentum_acceleration", "volatility_30d", "volatility_90d",
        "max_drawdown_180d", "history_density_90d", "staleness_hours",
        "source_quality_90d", "evidence_quality", "slope_z_90d", "trend_state",
        "observation_count_90d", "reason_codes", "snapshot_hash",
    ),
    "model_versions": (
        "id", "model_key", "version", "model_family", "research_only", "allowed_horizons",
        "training_mode", "model_definition_hash", "training_dataset_hash",
        "feature_version", "mapping_version", "code_version",
        "model_artifact_hash", "trained_through", "config", "config_hash", "created_at",
    ),
    "card_forecast_predictions": (
        "analytics_run_id", "model_version_id", "trend_snapshot_id", "variant_id",
        "source_id", "terms_review_id", "origin", "feature_cutoff", "horizon_days",
        "matures_at", "currency", "current_price", "q10", "q25", "q50", "q75", "q90",
        "probability_up", "confidence", "prediction_status", "reason_codes", "dataset_hash",
        "feature_version", "mapping_version", "code_version", "prediction_hash",
    ),
}


def _mapping(value: object, name: str) -> Mapping[str, object]:
    if not isinstance(value, Mapping):
        raise ValueError(f"{name} must be an object")
    return value


def _rows(value: object, name: str) -> tuple[Mapping[str, object], ...]:
    if not isinstance(value, list) or any(not isinstance(item, Mapping) for item in value):
        raise ValueError(f"{name} must be an array of objects")
    return tuple(value)


def _uuid(value: object, name: str) -> str:
    try:
        return str(UUID(str(value)))
    except (TypeError, ValueError, AttributeError) as exc:
        raise ValueError(f"{name} must be a UUID") from exc


def _literal(value: object) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def _json_literal(rows: Sequence[Mapping[str, object]]) -> str:
    payload = json.dumps(rows, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    tag = "$collectfolio_research_json$"
    if tag in payload:
        raise ValueError("research JSON contains the reserved SQL delimiter")
    return f"{tag}{payload}{tag}::jsonb"


def _insert_statement(table: str, rows: Sequence[Mapping[str, object]]) -> str:
    if table not in TABLE_COLUMNS:
        raise ValueError("private SQL export received an unknown table")
    if not rows:
        return ""
    columns = TABLE_COLUMNS[table]
    expected = set(columns)
    for index, row in enumerate(rows):
        keys = set(row)
        if keys != expected:
            missing = sorted(expected - keys)
            extra = sorted(keys - expected)
            raise ValueError(
                f"{table}[{index}] column mismatch; missing={missing}, extra={extra}"
            )
    names = ", ".join(columns)
    return (
        f"insert into public.{table} ({names})\n"
        f"select {names}\n"
        f"from jsonb_populate_recordset(null::public.{table}, {_json_literal(rows)});"
    )


def _uuid_list(values: Sequence[str]) -> str:
    return ", ".join(f"{_literal(value)}::uuid" for value in values)


def build_private_evidence_sql(
    packet: Mapping[str, object],
    *,
    commit: bool = False,
) -> str:
    """Return a fail-closed SQL transaction for one private qualification packet."""

    root = _mapping(packet, "packet")
    research = _mapping(root.get("historicalResearch", root), "historicalResearch")
    if research.get("mode") != "research_only":
        raise PermissionError("private SQL export requires research_only mode")
    gates = _mapping(research.get("gateStatus"), "historicalResearch.gateStatus")
    if (
        gates.get("sourceRights") != "research_only"
        or gates.get("publicPublication") != "blocked"
        or gates.get("predictions") != "research_only"
        or gates.get("modelReview") != "required"
    ):
        raise PermissionError("research gates do not permit private SQL export")
    if research.get("publicCandidateRows") != []:
        raise PermissionError("private SQL export refuses publication candidates")

    ingestion = _mapping(research.get("ingestionRun"), "ingestionRun")
    observations = _mapping(research.get("observations"), "observations")
    analytics = _mapping(research.get("analytics"), "analytics")
    forecasting = _mapping(research.get("forecasting"), "forecasting")
    model = _mapping(forecasting.get("modelRow"), "forecasting.modelRow")
    if model.get("research_only") is not True:
        raise PermissionError("model row must be permanently research-only")
    if forecasting.get("publicPublicationAllowed") is not False:
        raise PermissionError("forecast packet must prohibit public publication")

    prediction_rows = _rows(forecasting.get("predictionRows"), "predictionRows")
    if not prediction_rows:
        raise ValueError("private SQL export requires at least one prediction")
    for row in prediction_rows:
        if row.get("prediction_status") not in {"research_only", "quarantined"}:
            raise PermissionError("prediction row is not private-only")
        reasons = row.get("reason_codes")
        if not isinstance(reasons, list) or "operator_model_review_required" not in reasons:
            raise PermissionError("prediction row omitted the operator review gate")

    history_rows = _rows(observations.get("databaseRows"), "observations.databaseRows")
    quality_rows = _rows(observations.get("qualityEvents"), "observations.qualityEvents")
    analytics_rows = _rows(analytics.get("runRows"), "analytics.runRows")
    source_rows = _rows(analytics.get("runSourceRows"), "analytics.runSourceRows")
    trend_row = _mapping(analytics.get("trendSnapshotRow"), "analytics.trendSnapshotRow")

    source_id = _uuid(ingestion.get("source_id"), "source_id")
    terms_review_id = _uuid(ingestion.get("terms_review_id"), "terms_review_id")
    variant_id = _uuid(trend_row.get("variant_id"), "variant_id")
    ingestion_run_id = _uuid(ingestion.get("id"), "ingestion run id")
    trend_snapshot_id = _uuid(trend_row.get("id"), "trend snapshot id")
    model_version_id = _uuid(model.get("id"), "model version id")
    analytics_run_ids = tuple(
        _uuid(row.get("id"), "analytics run id") for row in analytics_rows
    )
    if len(analytics_run_ids) != 2:
        raise ValueError("private SQL export requires trend and forecast analytics runs")
    forecast_run_ids = tuple(
        _uuid(row.get("id"), "forecast analytics run id")
        for row in analytics_rows
        if row.get("run_kind") == "forecast_build"
    )
    if len(forecast_run_ids) != 1:
        raise ValueError("private SQL export requires exactly one forecast_build run")
    forecast_run_id = forecast_run_ids[0]
    if any(row.get("source_id") != source_id for row in history_rows):
        raise ValueError("historical observation source IDs are inconsistent")
    if any(row.get("variant_id") != variant_id for row in history_rows):
        raise ValueError("historical observation variant IDs are inconsistent")

    model_key = str(model.get("model_key"))
    model_version = str(model.get("version"))
    preflight = f"""do $collectfolio_guard$
begin
  if coalesce((select enabled from public.product_feature_flags where key = 'public_price_intelligence'), false) then
    raise exception 'public_price_intelligence must remain disabled';
  end if;
  if not exists (
    select 1
    from public.data_sources source
    join public.source_terms_reviews review
      on review.id = source.current_terms_review_id and review.source_id = source.id
    where source.id = {_literal(source_id)}::uuid
      and review.id = {_literal(terms_review_id)}::uuid
      and source.active
      and review.decision = 'research_only'
      and not review.commercial_use_allowed
      and not review.catalog_metadata_allowed
      and not review.public_raw_display_allowed
      and not review.public_derived_display_allowed
      and (review.expires_at is null or review.expires_at > greatest(
        {_literal(ingestion.get('started_at'))}::timestamptz, clock_timestamp()
      ))
  ) then
    raise exception 'source is not under the expected current research-only review';
  end if;
  if public.intelligence_publication_is_permitted({_literal(variant_id)}::uuid) then
    raise exception 'target variant unexpectedly permits public intelligence';
  end if;
  if exists (select 1 from public.card_intelligence_publications where catalog_variant_id = {_literal(variant_id)}::uuid) then
    raise exception 'target variant already has a public publication row';
  end if;
  if exists (select 1 from public.source_ingestion_runs where id = {_literal(ingestion_run_id)}::uuid)
     or exists (select 1 from public.analytics_runs where id in ({_uuid_list(analytics_run_ids)}))
     or exists (select 1 from public.trend_feature_snapshots where id = {_literal(trend_snapshot_id)}::uuid)
     or exists (
       select 1 from public.model_versions
       where id = {_literal(model_version_id)}::uuid
          or (model_key = {_literal(model_key)} and version = {_literal(model_version)})
     ) then
    raise exception 'private qualification evidence already exists';
  end if;
end
$collectfolio_guard$;"""

    inserts = (
        _insert_statement("source_ingestion_runs", (ingestion,)),
        _insert_statement("price_observations", history_rows),
        _insert_statement("data_quality_events", quality_rows),
        _insert_statement("analytics_runs", analytics_rows),
        _insert_statement("analytics_run_sources", source_rows),
        _insert_statement("trend_feature_snapshots", (trend_row,)),
        _insert_statement("model_versions", (model,)),
        _insert_statement("card_forecast_predictions", prediction_rows),
    )
    inserts_sql = "\n\n".join(statement for statement in inserts if statement)
    verification = f"""do $collectfolio_verify$
begin
  if (select count(*) from public.price_observations where ingestion_run_id = {_literal(ingestion_run_id)}::uuid) <> {len(history_rows)} then
    raise exception 'historical observation count mismatch';
  end if;
  if (select count(*) from public.card_forecast_predictions where analytics_run_id = {_literal(forecast_run_id)}::uuid) <> {len(prediction_rows)} then
    raise exception 'forecast prediction count mismatch';
  end if;
  if exists (
    select 1 from public.card_forecast_predictions
    where analytics_run_id = {_literal(forecast_run_id)}::uuid
      and prediction_status not in ('research_only', 'quarantined')
  ) then
    raise exception 'non-research prediction was inserted';
  end if;
  if exists (
    select 1 from public.intelligence_publication_candidates
    where analytics_run_id in ({_uuid_list(analytics_run_ids)})
  ) then
    raise exception 'private qualification created a public candidate';
  end if;
  if coalesce((select enabled from public.product_feature_flags where key = 'public_price_intelligence'), false)
     or public.intelligence_publication_is_permitted({_literal(variant_id)}::uuid) then
    raise exception 'public intelligence boundary changed during qualification';
  end if;
end
$collectfolio_verify$;"""
    terminator = "commit;" if commit else "rollback;"
    return f"begin;\n\n{preflight}\n\n{inserts_sql}\n\n{verification}\n\n{terminator}\n"
