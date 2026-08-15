"""Private-only historical trend and baseline forecast qualification packets."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from hashlib import sha256
import json
from typing import Iterable, Mapping
from uuid import UUID

from .evaluation import ResearchLineage
from .forecasting import (
    ResearchForecastPacket,
    ResearchModelCard,
    build_research_baseline_packet,
)
from .market_pipeline import (
    ObservationBatch,
    ObservationMapping,
    SourceTerms,
    prepare_observation_batch,
)
from .tcgcsv import TCGCSVArchiveHistory
from .trends import TrendSnapshot, build_trend_snapshot


def _canonical_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _hash(value: object) -> str:
    return sha256(_canonical_json(value).encode("utf-8")).hexdigest()


def _uuid(value: str, name: str) -> str:
    try:
        return str(UUID(str(value)))
    except (TypeError, ValueError, AttributeError) as exc:
        raise ValueError(f"{name} must be a UUID") from exc


def _utc(value: datetime, name: str) -> datetime:
    if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() is None:
        raise ValueError(f"{name} must be timezone-aware")
    return value.astimezone(timezone.utc)


def _required(value: str, name: str) -> str:
    text = str(value or "").strip()
    if not text:
        raise ValueError(f"{name} must be non-empty")
    return text


@dataclass(frozen=True, slots=True)
class PrivateQualificationConfig:
    history_ingestion_run_id: str
    trend_analytics_run_id: str
    forecast_analytics_run_id: str
    trend_snapshot_id: str
    model_version_id: str
    model_key: str
    model_version: str
    model_family: str
    allowed_horizons: tuple[int, ...]
    mapping_version: str
    feature_version: str
    code_version: str
    ingested_at: datetime
    feature_cutoff: datetime
    forecast_origin: datetime
    model_config: Mapping[str, object]

    def __post_init__(self) -> None:
        for field_name in (
            "history_ingestion_run_id",
            "trend_analytics_run_id",
            "forecast_analytics_run_id",
            "trend_snapshot_id",
            "model_version_id",
        ):
            object.__setattr__(self, field_name, _uuid(getattr(self, field_name), field_name))
        for field_name in (
            "model_key",
            "model_version",
            "model_family",
            "mapping_version",
            "feature_version",
            "code_version",
        ):
            object.__setattr__(self, field_name, _required(getattr(self, field_name), field_name))
        horizons = tuple(sorted(set(self.allowed_horizons)))
        if not horizons:
            raise ValueError("allowed_horizons must not be empty")
        object.__setattr__(self, "allowed_horizons", horizons)
        for field_name in ("ingested_at", "feature_cutoff", "forecast_origin"):
            object.__setattr__(self, field_name, _utc(getattr(self, field_name), field_name))
        if self.feature_cutoff > self.forecast_origin:
            raise ValueError("feature_cutoff cannot exceed forecast_origin")
        if not isinstance(self.model_config, Mapping):
            raise ValueError("model_config must be an object")
        object.__setattr__(self, "model_config", dict(self.model_config))


@dataclass(frozen=True, slots=True)
class PrivateResearchEvidence:
    history: TCGCSVArchiveHistory
    history_observations: ObservationBatch
    trend_snapshot: TrendSnapshot
    history_ingestion_run_row: Mapping[str, object]
    analytics_run_rows: tuple[Mapping[str, object], ...]
    analytics_run_source_rows: tuple[Mapping[str, object], ...]
    trend_snapshot_row: Mapping[str, object]
    market_series_row: Mapping[str, object]
    forecast_packet: ResearchForecastPacket
    dataset_hash: str
    packet_hash: str

    @property
    def gate_status(self) -> Mapping[str, str]:
        accepted = self.history_observations.status_counts["accepted"]
        return {
            "sourceRights": "research_only",
            "historicalEvidence": "qualified" if accepted >= 30 else "insufficient",
            "modelReview": "required",
            "predictions": "research_only",
            "publicPublication": "blocked",
        }

    def as_dict(self) -> Mapping[str, object]:
        return {
            "schemaVersion": 1,
            "mode": "research_only",
            "sampling": {
                "startDate": self.history.snapshots[0].archive_date.isoformat(),
                "endDate": self.history.snapshots[-1].archive_date.isoformat(),
                "archiveCount": len(self.history.snapshots),
                "expectedIntervalDays": self.history.expected_interval_days,
                "availabilityLagDays": self.history.availability_lag_days,
                "maxReferenceLagDays": self.history.max_reference_lag_days,
                "historyHash": self.history.history_hash,
                "artifacts": [
                    {
                        "archiveDate": item.archive_date.isoformat(),
                        "artifactHash": item.artifact_hash,
                        "snapshotHash": item.snapshot_hash,
                    }
                    for item in self.history.snapshots
                ],
            },
            "ingestionRun": dict(self.history_ingestion_run_row),
            "observations": {
                "datasetHash": self.history_observations.dataset_hash,
                "statusCounts": self.history_observations.status_counts,
                "marketSeriesRows": [dict(self.market_series_row)],
                "databaseRows": list(self.history_observations.database_rows),
                "qualityEvents": list(self.history_observations.quality_events),
            },
            "analytics": {
                "datasetHash": self.dataset_hash,
                "runRows": list(self.analytics_run_rows),
                "runSourceRows": list(self.analytics_run_source_rows),
                "trendSnapshotRow": dict(self.trend_snapshot_row),
            },
            "forecasting": {
                "modelRow": dict(self.forecast_packet.model_row),
                "predictionRows": list(self.forecast_packet.prediction_rows),
                "packetHash": self.forecast_packet.packet_hash,
                "publicPublicationAllowed": self.forecast_packet.public_publication_allowed,
            },
            "gateStatus": dict(self.gate_status),
            "publicCandidateRows": [],
            "packetHash": self.packet_hash,
        }


def _trend_snapshot_row(
    snapshot: TrendSnapshot,
    *,
    snapshot_id: str,
    analytics_run_id: str,
    terms: SourceTerms,
    market_series_id: str,
) -> Mapping[str, object]:
    trend_state = "insufficient" if snapshot.trend_state == "insufficient_data" else snapshot.trend_state
    reasons = ["research_only_source", "weekly_archive_sampling", "uncalibrated_thresholds"]
    if trend_state == "insufficient":
        reasons.append("insufficient_trend_evidence")
    values = {
        "analytics_run_id": analytics_run_id,
        "variant_id": snapshot.key.canonical_variant_id,
        "source_id": terms.source_id,
        "terms_review_id": terms.terms_review_id,
        "market_series_id": _uuid(market_series_id, "market_series_id"),
        "feature_cutoff": snapshot.feature_cutoff.isoformat(),
        "latest_observed_at": snapshot.latest_observed_at.isoformat(),
        "price_current": snapshot.current_price,
        "return_7d": snapshot.return_7d,
        "return_30d": snapshot.return_30d,
        "return_90d": snapshot.return_90d,
        "return_180d": snapshot.return_180d,
        "return_365d": snapshot.return_365d,
        "robust_slope_30d": snapshot.robust_slope_30d,
        "robust_slope_90d": snapshot.robust_slope_90d,
        "momentum_acceleration": snapshot.momentum_acceleration,
        "volatility_30d": snapshot.volatility_30d,
        "volatility_90d": snapshot.volatility_90d,
        "max_drawdown_180d": snapshot.max_drawdown_180d,
        "history_density_90d": snapshot.history_density_90d,
        "staleness_hours": snapshot.staleness_hours,
        "source_quality_90d": snapshot.source_quality_90d,
        "evidence_quality": snapshot.evidence_quality,
        "slope_z_90d": snapshot.slope_z_90d,
        "trend_state": trend_state,
        "observation_count_90d": snapshot.observation_count_90d,
        "reason_codes": reasons,
    }
    database_values = dict(values)
    database_values.pop("latest_observed_at")
    return {
        "id": snapshot_id,
        **database_values,
        "snapshot_hash": _hash(values),
    }


def _analytics_run_row(
    *,
    run_id: str,
    run_kind: str,
    config: PrivateQualificationConfig,
    terms: SourceTerms,
    dataset_hash: str,
    run_config: Mapping[str, object],
    records_read: int,
    records_written: int,
    records_quarantined: int,
) -> Mapping[str, object]:
    return {
        "id": run_id,
        "run_kind": run_kind,
        "status": "succeeded",
        "feature_cutoff": config.feature_cutoff.isoformat(),
        "started_at": config.ingested_at.isoformat(),
        "completed_at": config.ingested_at.isoformat(),
        "dataset_hash": dataset_hash,
        "source_policy_hash": terms.policy_hash,
        "mapping_version": config.mapping_version,
        "feature_version": config.feature_version,
        "code_version": config.code_version,
        "config_hash": _hash(run_config),
        "config": dict(run_config),
        "records_read": records_read,
        "records_written": records_written,
        "records_quarantined": records_quarantined,
        "error_summary": None,
    }


def prepare_archive_observations(
    history: TCGCSVArchiveHistory,
    mappings: Iterable[ObservationMapping],
    terms: SourceTerms,
    *,
    product_ids: Iterable[int],
    ingestion_run_id: str,
    ingested_at: datetime,
    actor_label: str = "tcgcsv-archive-research-adapter-v1",
) -> ObservationBatch:
    """Prepare archive rows chronologically so later samples see prior history."""

    if not isinstance(history, TCGCSVArchiveHistory) or not history.snapshots:
        raise ValueError("history must contain at least one TCGCSV archive")
    records = history.raw_price_records(product_ids=tuple(product_ids))
    return prepare_observation_batch(
        records,
        mappings,
        terms,
        {},
        ingestion_run_id=ingestion_run_id,
        ingested_at=ingested_at,
        actor_label=actor_label,
    )


def build_private_research_evidence(
    history: TCGCSVArchiveHistory,
    history_observations: ObservationBatch,
    current_observations: ObservationBatch,
    terms: SourceTerms,
    config: PrivateQualificationConfig,
) -> PrivateResearchEvidence:
    """Build DB-ready private evidence while structurally omitting public candidates."""

    if not isinstance(history, TCGCSVArchiveHistory) or not history.snapshots:
        raise ValueError("history must contain at least one TCGCSV archive")
    if not isinstance(history_observations, ObservationBatch):
        raise ValueError("history_observations must be an ObservationBatch")
    if not isinstance(current_observations, ObservationBatch):
        raise ValueError("current_observations must be an ObservationBatch")
    if not isinstance(terms, SourceTerms):
        raise ValueError("terms must be SourceTerms")
    if not isinstance(config, PrivateQualificationConfig):
        raise ValueError("config must be PrivateQualificationConfig")
    if not terms.permits_research_ingestion(config.ingested_at):
        raise PermissionError("current source terms do not permit private qualification")

    trend_observations = tuple(sorted(
        history_observations.trend_observations + current_observations.trend_observations,
        key=lambda item: item.observed_at,
    ))
    if not trend_observations:
        raise ValueError("qualification requires accepted point-in-time observations")
    if any(item.key.source_id != terms.source_id for item in trend_observations):
        raise ValueError("qualification observations do not match source terms")
    snapshot = build_trend_snapshot(
        trend_observations,
        config.feature_cutoff,
        expected_interval_days=history.expected_interval_days,
        max_reference_lag_days=float(history.max_reference_lag_days),
    )
    series_rows = {
        str(row["identity_hash"]): row
        for row in history_observations.market_series_rows + current_observations.market_series_rows
    }
    if len(series_rows) != 1:
        raise ValueError("qualification requires one immutable market series")
    market_series_row = next(iter(series_rows.values()))
    dataset_hash = _hash({
        "historyHash": history.history_hash,
        "historyObservationDatasetHash": history_observations.dataset_hash,
        "currentObservationDatasetHash": current_observations.dataset_hash,
        "sourcePolicyHash": terms.policy_hash,
    })

    lineage = ResearchLineage(
        dataset_sha256=dataset_hash,
        code_version=config.code_version,
        feature_version=config.feature_version,
        mapping_version=config.mapping_version,
        model_version=config.model_version,
    )
    model = ResearchModelCard(
        id=config.model_version_id,
        model_key=config.model_key,
        version=config.model_version,
        model_family=config.model_family,
        lineage=lineage,
        allowed_horizons=config.allowed_horizons,
        created_at=config.ingested_at,
        config={
            **config.model_config,
            "expectedIntervalDays": history.expected_interval_days,
            "availabilityLagDays": history.availability_lag_days,
            "maxReferenceLagDays": history.max_reference_lag_days,
            "researchOnly": True,
            "trainingMode": "none_static_baseline",
        },
        training_mode="none_static_baseline",
        model_definition_hash=_hash({
            "modelKey": config.model_key,
            "modelVersion": config.model_version,
            "modelFamily": config.model_family,
            "allowedHorizons": list(config.allowed_horizons),
            "config": dict(config.model_config),
        }),
        training_dataset_hash=None,
    )
    trend_row = _trend_snapshot_row(
        snapshot,
        snapshot_id=config.trend_snapshot_id,
        analytics_run_id=config.trend_analytics_run_id,
        terms=terms,
        market_series_id=str(market_series_row["id"]),
    )
    forecast = build_research_baseline_packet(
        model,
        snapshot,
        terms,
        analytics_run_id=config.forecast_analytics_run_id,
        trend_snapshot_id=config.trend_snapshot_id,
        origin=config.forecast_origin,
        market_series_id=str(market_series_row["id"]),
        evidence_mode="retrospective",
    )

    observation_counts = history_observations.status_counts
    quarantined_observations = sum(
        observation_counts[name] for name in ("outlier", "quarantined", "rejected")
    )
    ingestion_status = "succeeded" if quarantined_observations == 0 else "partial"
    ingestion_row = {
        "id": config.history_ingestion_run_id,
        "source_id": terms.source_id,
        "terms_review_id": terms.terms_review_id,
        "started_at": config.ingested_at.isoformat(),
        "completed_at": config.ingested_at.isoformat(),
        "status": ingestion_status,
        "records_read": len(history_observations.prepared),
        "records_written": len(history_observations.database_rows),
        "records_quarantined": quarantined_observations,
        "raw_payload_hash": history.history_hash,
        "parser_version": "tcgcsv-archive-research-v1",
        "code_commit": config.code_version,
        "error_summary": None,
        "metadata": {
            "researchOnly": True,
            "expectedIntervalDays": history.expected_interval_days,
            "availabilityLagDays": history.availability_lag_days,
            "maxReferenceLagDays": history.max_reference_lag_days,
            "archiveCount": len(history.snapshots),
        },
    }
    common_run_config = {
        "researchOnly": True,
        "historyHash": history.history_hash,
        "expectedIntervalDays": history.expected_interval_days,
        "availabilityLagDays": history.availability_lag_days,
        "maxReferenceLagDays": history.max_reference_lag_days,
        "publicPublicationAllowed": False,
    }
    trend_run = _analytics_run_row(
        run_id=config.trend_analytics_run_id,
        run_kind="trend_build",
        config=config,
        terms=terms,
        dataset_hash=dataset_hash,
        run_config={**common_run_config, "operation": "weekly_trend_qualification"},
        records_read=len(trend_observations),
        records_written=1,
        records_quarantined=quarantined_observations,
    )
    quarantined_predictions = sum(
        row["prediction_status"] == "quarantined"
        for row in forecast.prediction_rows
    )
    forecast_run = _analytics_run_row(
        run_id=config.forecast_analytics_run_id,
        run_kind="forecast_build",
        config=config,
        terms=terms,
        dataset_hash=dataset_hash,
        run_config={
            **common_run_config,
            "operation": "private_baseline_forecast",
            "modelVersionId": config.model_version_id,
            "forecastPacketHash": forecast.packet_hash,
        },
        records_read=1,
        records_written=len(forecast.prediction_rows),
        records_quarantined=quarantined_predictions,
    )
    source_rows = tuple(
        {
            "analytics_run_id": run_id,
            "source_id": terms.source_id,
            "terms_review_id": terms.terms_review_id,
            "usage_kind": "derived_feature",
        }
        for run_id in (config.trend_analytics_run_id, config.forecast_analytics_run_id)
    )
    packet_values = {
        "historyIngestionRun": ingestion_row,
        "historyObservationDatasetHash": history_observations.dataset_hash,
        "analyticsRuns": (trend_run, forecast_run),
        "analyticsRunSources": source_rows,
        "trendSnapshot": trend_row,
        "marketSeries": market_series_row,
        "forecastPacketHash": forecast.packet_hash,
        "datasetHash": dataset_hash,
        "publicCandidateRows": [],
    }
    return PrivateResearchEvidence(
        history=history,
        history_observations=history_observations,
        trend_snapshot=snapshot,
        history_ingestion_run_row=ingestion_row,
        analytics_run_rows=(trend_run, forecast_run),
        analytics_run_source_rows=source_rows,
        trend_snapshot_row=trend_row,
        market_series_row=market_series_row,
        forecast_packet=forecast,
        dataset_hash=dataset_hash,
        packet_hash=_hash(packet_values),
    )
