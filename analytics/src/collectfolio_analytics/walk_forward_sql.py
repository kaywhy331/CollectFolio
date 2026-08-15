"""Guarded SQL export for private retrospective walk-forward evidence."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from hashlib import sha256
import json
from math import isfinite
from pathlib import Path
from typing import Mapping, Sequence
from uuid import UUID

from .forecasting import REQUIRED_PROMOTION_BASELINES


SIMULATION_MODE = "retrospective_walk_forward"
TABLE_COLUMNS = {
    "model_versions": (
        "id", "model_key", "version", "model_family", "research_only",
        "allowed_horizons", "training_mode", "model_definition_hash",
        "training_dataset_hash", "feature_version",
        "mapping_version", "code_version", "model_artifact_hash", "trained_through",
        "config", "config_hash", "created_at",
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
        "market_series_id", "feature_cutoff", "price_current", "return_7d", "return_30d", "return_90d",
        "return_180d", "return_365d", "robust_slope_30d", "robust_slope_90d",
        "momentum_acceleration", "volatility_30d", "volatility_90d",
        "max_drawdown_180d", "history_density_90d", "staleness_hours",
        "source_quality_90d", "evidence_quality", "slope_z_90d", "trend_state",
        "observation_count_90d", "reason_codes", "snapshot_hash",
    ),
    "card_forecast_predictions": (
        "id", "analytics_run_id", "model_version_id", "trend_snapshot_id", "variant_id",
        "source_id", "terms_review_id", "market_series_id", "evidence_mode",
        "origin", "feature_cutoff", "horizon_days",
        "matures_at", "currency", "current_price", "q10", "q25", "q50", "q75",
        "q90", "probability_up", "confidence", "prediction_status", "reason_codes",
        "dataset_hash", "feature_version", "mapping_version", "code_version",
        "prediction_hash",
    ),
    "forecast_evaluations": (
        "id", "analytics_run_id", "prediction_id", "maturity", "evaluated_at",
        "evaluation_status", "unscorable_reason", "target_window_start",
        "target_window_end", "realized_price", "exact_date_price", "observation_count", "absolute_log_error",
        "absolute_percentage_error", "direction_correct", "brier_component",
        "pinball_losses", "evaluation_hash", "evidence_mode",
    ),
    "forecast_evaluation_observations": (
        "evaluation_id", "observation_id",
    ),
    "model_scorecards": (
        "id", "analytics_run_id", "model_version_id", "horizon_days", "cohort_key",
        "origin_start", "origin_end", "evaluation_count", "matured_count",
        "unscorable_count", "excluded_count", "metrics", "promotion_policy",
        "promotion_policy_hash", "evaluation_membership_hash",
        "promotion_recommendation", "reason_codes", "scorecard_hash",
    ),
    "model_scorecard_evaluations": (
        "scorecard_id", "evaluation_id", "evaluation_status",
        "included_in_metrics", "reason_codes",
    ),
}


def _canonical_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _hash(value: object) -> str:
    return sha256(_canonical_json(value).encode("utf-8")).hexdigest()


def _code_artifact_hash() -> str:
    digest = sha256()
    source_root = Path(__file__).resolve().parent
    for path in sorted(source_root.glob("*.py"), key=lambda value: value.name):
        digest.update(path.name.encode("utf-8"))
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def _number(value: object, name: str, *, minimum: float | None = None) -> float:
    if isinstance(value, bool):
        raise ValueError(f"{name} must be a finite number")
    try:
        numeric = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} must be a finite number") from exc
    if not isfinite(numeric) or (minimum is not None and numeric < minimum):
        raise ValueError(f"{name} must be a finite number")
    return numeric


def _mapping(value: object, name: str) -> Mapping[str, object]:
    if not isinstance(value, Mapping):
        raise ValueError(f"{name} must be an object")
    return value


def _rows(value: object, name: str, *, required: bool = True) -> tuple[Mapping[str, object], ...]:
    if not isinstance(value, list) or any(not isinstance(item, Mapping) for item in value):
        raise ValueError(f"{name} must be an array of objects")
    rows = tuple(value)
    if required and not rows:
        raise ValueError(f"{name} must not be empty")
    return rows


def _uuid(value: object, name: str) -> str:
    try:
        return str(UUID(str(value)))
    except (TypeError, ValueError, AttributeError) as exc:
        raise ValueError(f"{name} must be a UUID") from exc


def _datetime(value: object, name: str) -> datetime:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{name} must be an ISO-8601 datetime")
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(f"{name} must be an ISO-8601 datetime") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError(f"{name} must be timezone-aware")
    return parsed.astimezone(timezone.utc)


def _literal(value: object) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def _uuid_list(values: Sequence[str]) -> str:
    return ", ".join(f"{_literal(value)}::uuid" for value in values)


def _json_literal(rows: Sequence[Mapping[str, object]]) -> str:
    payload = json.dumps(rows, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    tag = "$collectfolio_walk_forward_json$"
    if tag in payload:
        raise ValueError("walk-forward JSON contains the reserved SQL delimiter")
    return f"{tag}{payload}{tag}::jsonb"


def _insert_statement(table: str, rows: Sequence[Mapping[str, object]]) -> str:
    columns = TABLE_COLUMNS[table]
    expected = set(columns)
    for index, row in enumerate(rows):
        keys = set(row)
        if keys != expected:
            raise ValueError(
                f"{table}[{index}] column mismatch; "
                f"missing={sorted(expected - keys)}, extra={sorted(keys - expected)}"
            )
    names = ", ".join(columns)
    return (
        f"insert into public.{table} ({names})\n"
        f"select {names}\n"
        f"from jsonb_populate_recordset(null::public.{table}, {_json_literal(rows)});"
    )


def _json_object_literal(value: Mapping[str, object]) -> str:
    payload = _canonical_json(value)
    tag = "$collectfolio_evaluation_rpc_json$"
    if tag in payload:
        raise ValueError("evaluation RPC JSON contains the reserved SQL delimiter")
    return f"{tag}{payload}{tag}::jsonb"


def _evaluation_rpc_statements(
    rows: Sequence[Mapping[str, object]],
) -> str:
    allowed = ("id", "analytics_run_id", "prediction_id", "evaluated_at")
    statements: list[str] = []
    for row in rows:
        request = {name: row[name] for name in allowed}
        function = (
            "record_scored_forecast_evaluation"
            if row.get("evaluation_status") == "scored"
            else "record_unscorable_forecast_evaluation"
        )
        statements.append(
            f"select public.{function}({_json_object_literal(request)});"
        )
    return "\n".join(statements)


def _membership_mismatch_condition(
    evaluation_rows: Sequence[Mapping[str, object]],
    membership_rows: Sequence[Mapping[str, object]],
) -> str:
    expected: dict[str, list[str]] = {
        _uuid(row.get("id"), "evaluation id"): [] for row in evaluation_rows
    }
    for row in membership_rows:
        evaluation_id = _uuid(row.get("evaluation_id"), "membership evaluation id")
        expected[evaluation_id].append(
            _uuid(row.get("observation_id"), "membership observation id")
        )
    conditions: list[str] = []
    for evaluation_id in sorted(expected):
        observation_ids = sorted(expected[evaluation_id])
        expected_array = (
            f"array[{_uuid_list(observation_ids)}]"
            if observation_ids else "array[]::uuid[]"
        )
        conditions.append(
            "(select coalesce(array_agg(observation_id order by observation_id), "
            "array[]::uuid[]) from public.forecast_evaluation_observations "
            f"where evaluation_id = {_literal(evaluation_id)}::uuid) "
            f"is distinct from {expected_array}"
        )
    return "\n     or ".join(conditions) or "false"


def _ids(rows: Sequence[Mapping[str, object]], name: str) -> tuple[str, ...]:
    values = tuple(_uuid(row.get("id"), f"{name} id") for row in rows)
    if len(set(values)) != len(values):
        raise ValueError(f"{name} IDs must be unique")
    return values


def build_walk_forward_evidence_sql(
    packet: Mapping[str, object],
    *,
    commit: bool = False,
) -> str:
    """Build a fail-closed transaction; rollback rehearsal is the default."""

    root = _mapping(packet, "packet")
    if root.get("mode") != "research_only" or root.get("simulationMode") != SIMULATION_MODE:
        raise PermissionError("SQL export requires retrospective research-only evidence")
    generated_at = _datetime(root.get("generatedAt"), "generatedAt")
    checked_at = _datetime(root.get("sourcePermissionCheckedAt"), "sourcePermissionCheckedAt")
    if checked_at != generated_at:
        raise PermissionError("source permission must be checked at evidence generation time")
    gates = _mapping(root.get("gateStatus"), "gateStatus")
    if (
        gates.get("sourceRights") != "research_only"
        or gates.get("simulationMode") != SIMULATION_MODE
        or gates.get("predictions") != "research_only"
        or gates.get("evaluations") != "private_only"
        or gates.get("scorecards") != "operator_evidence_only"
        or gates.get("modelReview") != "required"
        or gates.get("publicPublication") != "blocked"
    ):
        raise PermissionError("walk-forward gates are not closed")
    if root.get("publicCandidateRows") != [] or root.get("promotionReviewRows") != []:
        raise PermissionError("SQL export refuses public candidates or promotion reviews")

    model = _mapping(root.get("modelRow"), "modelRow")
    run_rows = _rows(root.get("analyticsRunRows"), "analyticsRunRows")
    source_rows = _rows(root.get("analyticsRunSourceRows"), "analyticsRunSourceRows")
    trend_rows = _rows(root.get("trendSnapshotRows"), "trendSnapshotRows")
    prediction_rows = _rows(root.get("predictionRows"), "predictionRows")
    evaluation_rows = _rows(root.get("evaluationRows"), "evaluationRows")
    target_membership_rows = _rows(
        root.get("evaluationObservationRows", []),
        "evaluationObservationRows",
        required=False,
    )
    scorecard_rows = _rows(root.get("scorecardRows"), "scorecardRows")
    membership_rows = _rows(
        root.get("scorecardEvaluationRows"), "scorecardEvaluationRows"
    )
    if model.get("research_only") is not True:
        raise PermissionError("model must be permanently research-only")
    model_config = _mapping(model.get("config"), "modelRow.config")
    if (
        model_config.get("simulationMode") != SIMULATION_MODE
        or model_config.get("trainingMode") != "none_static_baseline"
        or model_config.get("researchOnly") is not True
        or model_config.get("originSpacingDays") != 30
        or model.get("training_mode") != "none_static_baseline"
        or model.get("training_dataset_hash") is not None
    ):
        raise PermissionError("model does not declare the static retrospective contract")
    artifact_hash = str(model.get("model_artifact_hash") or "")
    if (
        len(artifact_hash) != 64
        or artifact_hash != model_config.get("codeArtifactHash")
        or artifact_hash != _code_artifact_hash()
    ):
        raise ValueError("model code-artifact lineage is inconsistent with current sources")
    if _hash(model_config) != model.get("config_hash"):
        raise ValueError("model config hash is inconsistent")
    model_definition = _mapping(
        model_config.get("modelDefinition"), "modelRow.config.modelDefinition"
    )
    if (
        _hash(model_definition) != model.get("model_definition_hash")
        or model_definition.get("simulationMode") != SIMULATION_MODE
        or model_definition.get("trainingMode") != "none_static_baseline"
        or model_definition.get("modelKey") != model.get("model_key")
        or model_definition.get("modelVersion") != model.get("version")
        or model_definition.get("modelFamily") != model.get("model_family")
        or model_definition.get("allowedHorizons") != sorted(model.get("allowed_horizons", []))
        or model_definition.get("codeArtifactHash") != artifact_hash
    ):
        raise ValueError("model-definition lineage is inconsistent")
    if _datetime(model.get("created_at"), "modelRow.created_at") != generated_at:
        raise ValueError("model created_at must equal the honest generation time")

    model_id = _uuid(model.get("id"), "model id")
    run_ids = _ids(run_rows, "analytics run")
    trend_ids = _ids(trend_rows, "trend snapshot")
    prediction_ids = _ids(prediction_rows, "prediction")
    evaluation_ids = _ids(evaluation_rows, "evaluation")
    scorecard_ids = _ids(scorecard_rows, "scorecard")
    walk_forward_ids = tuple(
        _uuid(row.get("id"), "walk-forward run id")
        for row in run_rows if row.get("run_kind") == "walk_forward"
    )
    evaluation_run_ids = tuple(
        _uuid(row.get("id"), "evaluation run id")
        for row in run_rows if row.get("run_kind") == "forecast_evaluation"
    )
    if len(evaluation_run_ids) != 1 or len(walk_forward_ids) != len(trend_rows):
        raise ValueError("packet requires one evaluation run and one snapshot per walk-forward run")
    evaluation_run_id = evaluation_run_ids[0]
    if set(run_ids) != set(walk_forward_ids) | {evaluation_run_id}:
        raise ValueError("packet contains an unsupported analytics run kind")
    if len(source_rows) != len(run_rows):
        raise ValueError("every analytics run requires exactly one source row")
    if {_uuid(row.get("analytics_run_id"), "source run id") for row in source_rows} != set(run_ids):
        raise ValueError("analytics run source lineage is incomplete")
    if any(row.get("usage_kind") != "derived_feature" for row in source_rows):
        raise PermissionError("walk-forward evidence may use only derived_feature lineage")

    source_ids = {_uuid(row.get("source_id"), "source id") for row in source_rows}
    terms_ids = {_uuid(row.get("terms_review_id"), "terms review id") for row in source_rows}
    variant_ids = {_uuid(row.get("variant_id"), "variant id") for row in trend_rows}
    if len(source_ids) != 1 or len(terms_ids) != 1 or len(variant_ids) != 1:
        raise ValueError("walk-forward packet must target one exact source, terms review, and variant")
    source_id = next(iter(source_ids))
    terms_review_id = next(iter(terms_ids))
    variant_id = next(iter(variant_ids))
    market_series_id = _uuid(root.get("marketSeriesId"), "market series id")
    trend_by_id = {_uuid(row.get("id"), "trend snapshot id"): row for row in trend_rows}

    if any(
        _datetime(row.get("started_at"), "analytics started_at") != generated_at
        or _datetime(row.get("completed_at"), "analytics completed_at") != generated_at
        for row in run_rows
    ):
        raise ValueError("analytics runs must use honest generation timestamps")
    run_by_id = {
        _uuid(row.get("id"), "analytics run id"): row for row in run_rows
    }
    for row in run_rows:
        run_config = _mapping(row.get("config"), "analytics run config")
        if (
            _hash(run_config) != row.get("config_hash")
            or run_config.get("sourcePermissionCheckedAt") != generated_at.isoformat()
            or row.get("mapping_version") != model.get("mapping_version")
            or row.get("feature_version") != model.get("feature_version")
            or row.get("code_version") != model.get("code_version")
        ):
            raise ValueError("analytics-run lineage or config hash is inconsistent")
        dataset_hash = str(row.get("dataset_hash") or "")
        if len(dataset_hash) != 64:
            raise ValueError("analytics-run dataset hash must be a SHA-256 digest")

    prediction_by_id = {
        _uuid(row.get("id"), "prediction id"): row for row in prediction_rows
    }
    for row in prediction_rows:
        if row.get("prediction_status") not in {"research_only", "quarantined"}:
            raise PermissionError("prediction status is not private-only")
        reasons = row.get("reason_codes")
        if not isinstance(reasons, list) or not {
            SIMULATION_MODE, "not_prospectively_generated", "operator_model_review_required"
        }.issubset(reasons):
            raise PermissionError("prediction omitted retrospective/operator-review labels")
        if _uuid(row.get("model_version_id"), "prediction model id") != model_id:
            raise ValueError("prediction model lineage is inconsistent")
        run_id = _uuid(row.get("analytics_run_id"), "prediction run id")
        snapshot_id = _uuid(row.get("trend_snapshot_id"), "prediction snapshot id")
        if run_id not in walk_forward_ids or snapshot_id not in trend_by_id:
            raise ValueError("prediction does not reference a walk-forward snapshot")
        if _uuid(trend_by_id[snapshot_id].get("analytics_run_id"), "snapshot run id") != run_id:
            raise ValueError("prediction run and trend snapshot run do not match")
        origin = _datetime(row.get("origin"), "prediction origin")
        if origin >= generated_at:
            raise ValueError("retrospective prediction origin must precede generation")
        if (
            _datetime(run_by_id[run_id].get("feature_cutoff"), "run feature cutoff") != origin
            or _datetime(row.get("feature_cutoff"), "prediction feature cutoff") != origin
            or _datetime(trend_by_id[snapshot_id].get("feature_cutoff"), "snapshot feature cutoff") != origin
            or row.get("dataset_hash") != run_by_id[run_id].get("dataset_hash")
            or row.get("mapping_version") != model.get("mapping_version")
            or row.get("feature_version") != model.get("feature_version")
            or row.get("code_version") != model.get("code_version")
        ):
            raise ValueError("prediction point-in-time dataset lineage is inconsistent")
        if _uuid(row.get("source_id"), "prediction source id") != source_id:
            raise ValueError("prediction source lineage is inconsistent")
        if _uuid(row.get("terms_review_id"), "prediction terms id") != terms_review_id:
            raise ValueError("prediction terms lineage is inconsistent")
        if _uuid(row.get("variant_id"), "prediction variant id") != variant_id:
            raise ValueError("prediction variant lineage is inconsistent")
        if row.get("evidence_mode") != "retrospective":
            raise ValueError("walk-forward predictions must be retrospective")
        if _uuid(row.get("market_series_id"), "prediction market series id") != market_series_id:
            raise ValueError("prediction market-series lineage is inconsistent")

    prediction_id_set = set(prediction_ids)
    evaluation_by_id = {
        _uuid(row.get("id"), "evaluation id"): row for row in evaluation_rows
    }
    for row in evaluation_rows:
        if _uuid(row.get("analytics_run_id"), "evaluation run id") != evaluation_run_id:
            raise ValueError("evaluation row does not reference the evaluation run")
        if _uuid(row.get("prediction_id"), "evaluated prediction id") not in prediction_id_set:
            raise ValueError("evaluation references a prediction outside the packet")
        if _datetime(row.get("evaluated_at"), "evaluated_at") != generated_at:
            raise ValueError("evaluation timestamp must equal evidence generation time")
        maturity = _datetime(row.get("maturity"), "evaluation maturity")
        if maturity > generated_at:
            raise ValueError("evaluation cannot precede maturity")
        if (
            _datetime(row.get("target_window_end"), "target window end") != maturity
            or _datetime(row.get("target_window_start"), "target window start")
            != maturity - timedelta(days=6)
        ):
            raise ValueError("evaluation target window is inconsistent")
        status = row.get("evaluation_status")
        if status not in {"scored", "unscorable"}:
            raise ValueError("evaluation status must be scored or unscorable")
        if row.get("evidence_mode") != "retrospective":
            raise ValueError("walk-forward evaluations must be retrospective")
        if status == "scored" and (
            row.get("realized_price") is None
            or isinstance(row.get("observation_count"), bool)
            or not isinstance(row.get("observation_count"), (int, float))
            or row.get("observation_count") <= 0
            or row.get("unscorable_reason") is not None
            or row.get("absolute_log_error") is None
            or row.get("absolute_percentage_error") is None
            or not isinstance(row.get("direction_correct"), bool)
        ):
            raise ValueError("scored evaluation is missing its realized target")
        if status == "scored":
            for field in (
                "realized_price", "observation_count", "absolute_log_error",
                "absolute_percentage_error",
            ):
                _number(row.get(field), f"scored evaluation {field}", minimum=0)
            if row.get("realized_price") <= 0:
                raise ValueError("scored evaluation realized_price must be positive")
        if status == "unscorable" and (
            row.get("realized_price") is not None
            or row.get("exact_date_price") is not None
            or row.get("observation_count") != 0
            or not str(row.get("unscorable_reason") or "").strip()
            or row.get("absolute_log_error") is not None
            or row.get("absolute_percentage_error") is not None
            or row.get("direction_correct") is not None
            or row.get("brier_component") is not None
            or row.get("pinball_losses") != {}
        ):
            raise ValueError("unscorable evaluation has inconsistent target fields")
        hash_values = dict(row)
        hash_values.pop("id")
        stored_hash = hash_values.pop("evaluation_hash")
        if stored_hash != _hash({
            **hash_values,
            "simulationMode": SIMULATION_MODE,
            "modelVersionId": model_id,
        }):
            raise ValueError("evaluation hash is inconsistent")

    target_membership: dict[str, set[str]] = {}
    for row in target_membership_rows:
        evaluation_id = _uuid(row.get("evaluation_id"), "target membership evaluation id")
        observation_id = _uuid(row.get("observation_id"), "target membership observation id")
        if evaluation_id not in evaluation_by_id:
            raise ValueError("target membership references an evaluation outside the packet")
        values = target_membership.setdefault(evaluation_id, set())
        if observation_id in values:
            raise ValueError("target observation membership must be unique")
        values.add(observation_id)
    for evaluation_id, row in evaluation_by_id.items():
        actual = len(target_membership.get(evaluation_id, set()))
        expected = int(row.get("observation_count") or 0)
        if row.get("evaluation_status") == "scored" and actual != expected:
            raise ValueError("scored evaluation target-observation membership is incomplete")
        if row.get("evaluation_status") == "unscorable" and actual:
            raise ValueError("unscorable evaluation cannot have target observations")
    scorecard_id_set = set(scorecard_ids)
    evaluation_id_set = set(evaluation_ids)
    membership_keys: set[tuple[str, str]] = set()
    membership_by_scorecard: dict[str, list[Mapping[str, object]]] = {
        scorecard_id: [] for scorecard_id in scorecard_ids
    }
    for row in membership_rows:
        scorecard_id = _uuid(row.get("scorecard_id"), "membership scorecard id")
        evaluation_id = _uuid(row.get("evaluation_id"), "membership evaluation id")
        if scorecard_id not in scorecard_id_set or evaluation_id not in evaluation_id_set:
            raise ValueError("scorecard membership references evidence outside the packet")
        key = (scorecard_id, evaluation_id)
        if key in membership_keys:
            raise ValueError("scorecard evaluation membership must be unique")
        membership_keys.add(key)
        evaluation = evaluation_by_id[evaluation_id]
        prediction_id = _uuid(evaluation.get("prediction_id"), "member prediction id")
        prediction = prediction_by_id[prediction_id]
        expected_inclusion = (
            prediction.get("prediction_status") == "research_only"
            and evaluation.get("evaluation_status") == "scored"
        )
        expected_reasons = (
            ["quarantined_prediction_excluded"]
            if prediction.get("prediction_status") == "quarantined"
            else ["unscorable_target_excluded"]
            if evaluation.get("evaluation_status") == "unscorable"
            else []
        )
        if (
            row.get("evaluation_status") != evaluation.get("evaluation_status")
            or row.get("included_in_metrics") is not expected_inclusion
            or row.get("reason_codes") != expected_reasons
        ):
            raise ValueError("scorecard membership status or exclusion reason is inconsistent")
        membership_by_scorecard[scorecard_id].append(row)

    if len(membership_keys) != len(evaluation_rows):
        raise ValueError("every matured evaluation must belong to exactly one scorecard")

    for row in scorecard_rows:
        scorecard_id = _uuid(row.get("id"), "scorecard id")
        if _uuid(row.get("analytics_run_id"), "scorecard run id") != evaluation_run_id:
            raise ValueError("scorecard does not reference the evaluation run")
        if _uuid(row.get("model_version_id"), "scorecard model id") != model_id:
            raise ValueError("scorecard model lineage is inconsistent")
        if row.get("evidence_mode") != "retrospective":
            raise ValueError("walk-forward scorecards must be retrospective")
        reasons = row.get("reason_codes")
        if not isinstance(reasons, list) or not {
            SIMULATION_MODE, "not_prospectively_generated", "operator_model_review_required"
        }.issubset(reasons):
            raise PermissionError("scorecard omitted retrospective/operator-review labels")
        policy = _mapping(row.get("promotion_policy"), "scorecard promotion_policy")
        metrics = _mapping(row.get("metrics"), "scorecard metrics")
        required_baselines = policy.get("requiredBaselines")
        if tuple(required_baselines or ()) != REQUIRED_PROMOTION_BASELINES:
            raise ValueError("scorecard must retain the declared five-baseline policy")
        if (
            _hash(policy) != row.get("promotion_policy_hash")
            or metrics.get("promotionPolicy") != policy
            or metrics.get("promotionPolicyHash") != row.get("promotion_policy_hash")
        ):
            raise ValueError("scorecard promotion policy hash is inconsistent")

        origin_start = _datetime(row.get("origin_start"), "scorecard origin start")
        origin_end = _datetime(row.get("origin_end"), "scorecard origin end")
        horizon = row.get("horizon_days")
        expected_evaluation_ids = {
            evaluation_id
            for evaluation_id, evaluation in evaluation_by_id.items()
            if prediction_by_id[
                _uuid(evaluation.get("prediction_id"), "scorecard prediction id")
            ].get("horizon_days") == horizon
            and origin_start <= _datetime(
                prediction_by_id[
                    _uuid(evaluation.get("prediction_id"), "scorecard prediction id")
                ].get("origin"),
                "scorecard prediction origin",
            ) <= origin_end
        }
        members = membership_by_scorecard[scorecard_id]
        if {
            _uuid(member.get("evaluation_id"), "scorecard member evaluation id")
            for member in members
        } != expected_evaluation_ids:
            raise ValueError("scorecard membership is not the exact horizon/origin cohort")

        canonical_membership = [
            {
                "evaluationId": _uuid(member.get("evaluation_id"), "membership hash id"),
                "evaluationStatus": member.get("evaluation_status"),
                "includedInMetrics": member.get("included_in_metrics"),
                "reasonCodes": member.get("reason_codes"),
            }
            for member in sorted(
                members, key=lambda value: str(value.get("evaluation_id"))
            )
        ]
        membership_hash = _hash(canonical_membership)
        if (
            membership_hash != row.get("evaluation_membership_hash")
            or metrics.get("evaluationMembershipHash") != membership_hash
        ):
            raise ValueError("scorecard evaluation membership hash is inconsistent")

        included_count = sum(bool(member.get("included_in_metrics")) for member in members)
        unscorable_count = sum(
            prediction_by_id[
                _uuid(evaluation_by_id[
                    _uuid(member.get("evaluation_id"), "unscorable member id")
                ].get("prediction_id"), "unscorable prediction id")
            ].get("prediction_status") == "research_only"
            and member.get("evaluation_status") == "unscorable"
            for member in members
        )
        excluded_count = sum(
            prediction_by_id[
                _uuid(evaluation_by_id[
                    _uuid(member.get("evaluation_id"), "excluded member id")
                ].get("prediction_id"), "excluded prediction id")
            ].get("prediction_status") == "quarantined"
            for member in members
        )
        if (
            row.get("matured_count") != len(members)
            or row.get("evaluation_count") != included_count
            or row.get("unscorable_count") != unscorable_count
            or row.get("excluded_count") != excluded_count
            or metrics.get("maturedCount") != len(members)
            or metrics.get("unscorableCount") != unscorable_count
            or metrics.get("excludedCount") != excluded_count
        ):
            raise ValueError("scorecard case partition is inconsistent")

        baseline_results = _mapping(metrics.get("baselineResults"), "baseline results")
        missing_baselines = [
            name for name in REQUIRED_PROMOTION_BASELINES
            if name not in baseline_results or baseline_results[name] is None
        ]
        if metrics.get("missingRequiredBaselines") != missing_baselines:
            raise ValueError("scorecard missing-baseline evidence is inconsistent")
        for name, value in baseline_results.items():
            if value is not None:
                _number(value, f"baseline result {name}")
        if missing_baselines and (
            row.get("promotion_recommendation") != "insufficient"
            or "missing_required_baselines" not in reasons
        ):
            raise ValueError("missing required baselines must block promotion")

        scorecard_values = dict(row)
        scorecard_values.pop("id")
        stored_scorecard_hash = scorecard_values.pop("scorecard_hash")
        if stored_scorecard_hash != _hash(scorecard_values):
            raise ValueError("scorecard hash is inconsistent")

    total_unscorable = sum(
        row.get("evaluation_status") == "unscorable" for row in evaluation_rows
    )
    total_excluded = sum(
        prediction_by_id[
            _uuid(row.get("prediction_id"), "excluded evaluation prediction id")
        ].get("prediction_status") == "quarantined"
        for row in evaluation_rows
    )
    if (
        root.get("unscorableMaturedTargets") != total_unscorable
        or root.get("skippedMaturedTargets") != total_unscorable
    ):
        raise ValueError("unscorable target accounting is inconsistent")
    evaluation_run = run_by_id[evaluation_run_id]
    evaluation_run_config = _mapping(
        evaluation_run.get("config"), "evaluation analytics-run config"
    )
    if (
        evaluation_run_config.get("unscorableMaturedTargets") != total_unscorable
        or evaluation_run_config.get("excludedMaturedTargets") != total_excluded
        or evaluation_run.get("records_quarantined") != total_excluded
    ):
        raise ValueError("evaluation-run excluded/quarantined accounting is inconsistent")

    input_ledger = _mapping(root.get("inputLedger"), "inputLedger")
    packet_values = {
        "simulationMode": SIMULATION_MODE,
        "generatedAt": root.get("generatedAt"),
        "ledgerHash": input_ledger.get("ledgerHash"),
        "ledgerStatusCounts": input_ledger.get("statusCounts"),
        "modelRow": model,
        "analyticsRunRows": list(run_rows),
        "analyticsRunSourceRows": list(source_rows),
        "trendSnapshotRows": list(trend_rows),
        "predictionRows": list(prediction_rows),
        "evaluationRows": list(evaluation_rows),
        "evaluationObservationRows": list(target_membership_rows),
        "marketSeriesId": market_series_id,
        "scorecardRows": list(scorecard_rows),
        "scorecardEvaluationRows": list(membership_rows),
        "promotionReviewRows": [],
        "publicCandidateRows": [],
        "unscorableMaturedTargets": total_unscorable,
    }
    if root.get("packetHash") != _hash(packet_values):
        raise ValueError("walk-forward packet hash is inconsistent")

    model_key = str(model.get("model_key"))
    model_version = str(model.get("version"))
    generated_literal = _literal(generated_at.isoformat())
    preflight = f"""do $collectfolio_walk_forward_guard$
begin
  if {generated_literal}::timestamptz > clock_timestamp() + interval '5 minutes' then
    raise exception 'walk-forward generation timestamp is unexpectedly in the future';
  end if;
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
      and review.reviewed_at <= {generated_literal}::timestamptz
      and (review.expires_at is null or review.expires_at > greatest(
        {generated_literal}::timestamptz, clock_timestamp()
      ))
  ) then
    raise exception 'source is not under the expected current research-only review';
  end if;
  if public.intelligence_publication_is_permitted({_literal(variant_id)}::uuid) then
    raise exception 'target variant unexpectedly permits public intelligence';
  end if;
  if exists (
    select 1 from public.card_intelligence_publications
    where catalog_variant_id = {_literal(variant_id)}::uuid
  ) then
    raise exception 'target variant already has a public publication row';
  end if;
  if exists (
    select 1 from public.model_versions
    where id = {_literal(model_id)}::uuid
       or (model_key = {_literal(model_key)} and version = {_literal(model_version)})
  ) or exists (
    select 1 from public.analytics_runs where id in ({_uuid_list(run_ids)})
  ) or exists (
    select 1 from public.trend_feature_snapshots where id in ({_uuid_list(trend_ids)})
  ) or exists (
    select 1 from public.card_forecast_predictions where id in ({_uuid_list(prediction_ids)})
  ) or exists (
    select 1 from public.forecast_evaluations where id in ({_uuid_list(evaluation_ids)})
  ) or exists (
    select 1 from public.model_scorecards where id in ({_uuid_list(scorecard_ids)})
  ) then
    raise exception 'retrospective walk-forward evidence already exists';
  end if;
end
$collectfolio_walk_forward_guard$;"""

    # Migration 0018 reserves evidence_mode and prospective plan lineage from
    # direct service-role inserts. Retrospective rows use the database's
    # fail-closed default after this field has already been validated above.
    scorecard_insert_rows = tuple(
        {name: value for name, value in row.items() if name != "evidence_mode"}
        for row in scorecard_rows
    )
    inserts = (
        _insert_statement("model_versions", (model,)),
        _insert_statement("analytics_runs", run_rows),
        _insert_statement("analytics_run_sources", source_rows),
        _insert_statement("trend_feature_snapshots", trend_rows),
        _insert_statement("card_forecast_predictions", prediction_rows),
        _evaluation_rpc_statements(evaluation_rows),
        _insert_statement("model_scorecards", scorecard_insert_rows),
        _insert_statement("model_scorecard_evaluations", membership_rows),
    )
    inserts_sql = "\n\n".join(inserts)
    verification = f"""do $collectfolio_walk_forward_verify$
begin
  if (select count(*) from public.analytics_runs where id in ({_uuid_list(run_ids)})) <> {len(run_ids)}
     or (select count(*) from public.trend_feature_snapshots where id in ({_uuid_list(trend_ids)})) <> {len(trend_ids)}
     or (select count(*) from public.card_forecast_predictions where id in ({_uuid_list(prediction_ids)})) <> {len(prediction_ids)}
     or (select count(*) from public.forecast_evaluations where id in ({_uuid_list(evaluation_ids)})) <> {len(evaluation_ids)}
     or (select count(*) from public.forecast_evaluation_observations
         where evaluation_id in ({_uuid_list(evaluation_ids)})) <> {len(target_membership_rows)}
     or (select count(*) from public.model_scorecards where id in ({_uuid_list(scorecard_ids)})) <> {len(scorecard_ids)}
     or (select count(*) from public.model_scorecard_evaluations
         where scorecard_id in ({_uuid_list(scorecard_ids)})) <> {len(membership_rows)} then
    raise exception 'retrospective evidence count mismatch';
  end if;
  if {_membership_mismatch_condition(evaluation_rows, target_membership_rows)} then
    raise exception 'database-derived target-observation membership differs from the complete export';
  end if;
  if exists (
    select 1 from public.card_forecast_predictions
    where id in ({_uuid_list(prediction_ids)})
      and (
        prediction_status not in ('research_only', 'quarantined')
        or not (reason_codes @> array['{SIMULATION_MODE}','not_prospectively_generated','operator_model_review_required'])
        or origin >= {generated_literal}::timestamptz
        or created_at < {generated_literal}::timestamptz
      )
  ) then
    raise exception 'prediction private/retrospective timestamp contract failed';
  end if;
  if exists (
    select 1 from public.forecast_evaluations
    where id in ({_uuid_list(evaluation_ids)})
      and (evaluated_at <> {generated_literal}::timestamptz or created_at < {generated_literal}::timestamptz)
  ) then
    raise exception 'evaluation timestamp contract failed';
  end if;
  if exists (
    select 1 from public.model_scorecards
    where id in ({_uuid_list(scorecard_ids)})
      and (
        not (reason_codes @> array['{SIMULATION_MODE}','not_prospectively_generated','operator_model_review_required'])
        or created_at < {generated_literal}::timestamptz
      )
  ) then
    raise exception 'scorecard operator-review contract failed';
  end if;
  if exists (
    select 1 from public.model_promotion_reviews where model_version_id = {_literal(model_id)}::uuid
  ) then
    raise exception 'retrospective export must not create a promotion review';
  end if;
  if exists (
    select 1 from public.intelligence_publication_candidates
    where analytics_run_id in ({_uuid_list(run_ids)})
  ) then
    raise exception 'retrospective export created a public candidate';
  end if;
  if coalesce((select enabled from public.product_feature_flags where key = 'public_price_intelligence'), false)
     or public.intelligence_publication_is_permitted({_literal(variant_id)}::uuid) then
    raise exception 'public intelligence boundary changed during retrospective evaluation';
  end if;
end
$collectfolio_walk_forward_verify$;"""
    return (
        f"begin;\n\n{preflight}\n\n{inserts_sql}\n\n{verification}\n\n"
        f"{'commit;' if commit else 'rollback;'}\n"
    )
