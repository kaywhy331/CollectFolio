"""Build reviewable Tier-0–2 publication candidates; never auto-promote."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from hashlib import sha256
import json
from math import isfinite
from typing import Iterable, Mapping
from uuid import NAMESPACE_URL, UUID, uuid5

from .evaluation import ResearchLineage
from .market_pipeline import ObservationMapping, SourceTerms
from .trends import TrendSnapshot

PUBLICATION_NAMESPACE = uuid5(NAMESPACE_URL, "https://collectfolio.app/intelligence-publication/v1")
USAGE_KINDS = {"catalog", "raw_price", "derived_feature"}


def _uuid(value: str, name: str) -> str:
    try:
        return str(UUID(str(value)))
    except (TypeError, ValueError, AttributeError) as exc:
        raise ValueError(f"{name} must be a UUID") from exc


def _utc(value: datetime, name: str) -> datetime:
    if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() is None:
        raise ValueError(f"{name} must be timezone-aware")
    return value.astimezone(timezone.utc)


def _hash(value: object) -> str:
    payload = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return sha256(payload.encode("utf-8")).hexdigest()


@dataclass(frozen=True, slots=True)
class PublicationLineage:
    terms: SourceTerms
    usage_kind: str

    def __post_init__(self) -> None:
        if not isinstance(self.terms, SourceTerms):
            raise ValueError("terms must be SourceTerms")
        if self.usage_kind not in USAGE_KINDS:
            raise ValueError(f"usage_kind must be one of {sorted(USAGE_KINDS)}")


@dataclass(frozen=True, slots=True)
class DescriptiveCandidatePacket:
    trend_snapshot_row: Mapping[str, object]
    candidate_row: Mapping[str, object]
    candidate_source_rows: tuple[Mapping[str, object], ...]

    @property
    def candidate_id(self) -> str:
        return str(self.candidate_row["id"])


def aggregate_source_policy_hash(lineage: Iterable[PublicationLineage]) -> str:
    values = tuple(lineage)
    if not values:
        raise ValueError("publication lineage cannot be empty")
    return _hash(sorted(
        {
            (item.terms.source_id, item.terms.terms_review_id, item.usage_kind, item.terms.policy_hash)
            for item in values
        }
    ))


def build_trend_snapshot_row(
    snapshot: TrendSnapshot,
    mapping: ObservationMapping,
    source_terms: SourceTerms,
    research_lineage: ResearchLineage,
    *,
    analytics_run_id: str,
) -> dict[str, object]:
    if not isinstance(snapshot, TrendSnapshot):
        raise ValueError("snapshot must be a TrendSnapshot")
    if not isinstance(mapping, ObservationMapping) or not mapping.approved:
        raise ValueError("trend snapshots require an approved exact mapping")
    if not isinstance(source_terms, SourceTerms):
        raise ValueError("source_terms must be SourceTerms")
    if not isinstance(research_lineage, ResearchLineage):
        raise ValueError("research_lineage must be ResearchLineage")
    if mapping.variant_id != snapshot.key.canonical_variant_id:
        raise ValueError("mapping and trend snapshot variant IDs differ")
    if mapping.source_id != source_terms.source_id or snapshot.key.source_id != source_terms.source_id:
        raise ValueError("mapping, source terms, and trend snapshot source IDs differ")
    if mapping.mapping_version != research_lineage.mapping_version:
        raise ValueError("mapping version differs from research lineage")
    if mapping.finish != snapshot.key.finish or mapping.condition_class != snapshot.key.condition_class:
        raise ValueError("mapping finish/condition differs from trend series")

    run_id = _uuid(analytics_run_id, "analytics_run_id")
    trend_state = "insufficient" if snapshot.trend_state == "insufficient_data" else snapshot.trend_state
    hash_input = {
        "analyticsRunId": run_id,
        "variantId": mapping.variant_id,
        "sourceId": source_terms.source_id,
        "termsReviewId": source_terms.terms_review_id,
        "featureCutoff": snapshot.feature_cutoff.isoformat(),
        "datasetHash": research_lineage.dataset_sha256,
        "featureVersion": research_lineage.feature_version,
        "mappingVersion": research_lineage.mapping_version,
        "metrics": {
            "priceCurrent": snapshot.current_price,
            "return7d": snapshot.return_7d,
            "return30d": snapshot.return_30d,
            "return90d": snapshot.return_90d,
            "return180d": snapshot.return_180d,
            "return365d": snapshot.return_365d,
            "slope30d": snapshot.robust_slope_30d,
            "slope90d": snapshot.robust_slope_90d,
            "acceleration": snapshot.momentum_acceleration,
            "volatility30d": snapshot.volatility_30d,
            "volatility90d": snapshot.volatility_90d,
            "drawdown180d": snapshot.max_drawdown_180d,
            "density90d": snapshot.history_density_90d,
            "stalenessHours": snapshot.staleness_hours,
            "sourceQuality": snapshot.source_quality_90d,
            "evidenceQuality": snapshot.evidence_quality,
            "slopeZ90d": snapshot.slope_z_90d,
            "trendState": trend_state,
            "observationCount90d": snapshot.observation_count_90d,
        },
    }
    snapshot_hash = _hash(hash_input)
    snapshot_id = str(uuid5(PUBLICATION_NAMESPACE, f"trend-snapshot|{snapshot_hash}"))
    return {
        "id": snapshot_id,
        "analytics_run_id": run_id,
        "variant_id": mapping.variant_id,
        "source_id": source_terms.source_id,
        "terms_review_id": source_terms.terms_review_id,
        "feature_cutoff": snapshot.feature_cutoff.isoformat(),
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
        "reason_codes": [],
        "snapshot_hash": snapshot_hash,
    }


def _drivers(snapshot: TrendSnapshot) -> dict[str, list[str]]:
    supporting: list[str] = []
    limiting: list[str] = []
    if snapshot.return_30d is not None:
        if snapshot.return_30d > 0:
            supporting.append("Positive observed 30-day return")
        elif snapshot.return_30d < 0:
            limiting.append("Negative observed 30-day return")
    if snapshot.history_density_90d >= 0.80:
        supporting.append("Dense 90-day observation history")
    else:
        limiting.append("Sparse 90-day observation history")
    if snapshot.staleness_hours > 24:
        limiting.append("Latest source observation is more than 24 hours old")
    if snapshot.volatility_90d is not None and snapshot.slope_z_90d is not None:
        if abs(snapshot.slope_z_90d) < 0.5:
            limiting.append("Observed movement is small relative to volatility")
    return {"supporting": supporting[:5], "limiting": limiting[:5]}


def _reason_codes(snapshot: TrendSnapshot, *, include_observed: bool) -> list[str]:
    reasons = ["descriptive_trend_only"]
    if not include_observed:
        reasons.append("observed_price_withheld")
    for horizon, value in (
        (7, snapshot.return_7d), (30, snapshot.return_30d), (90, snapshot.return_90d),
        (180, snapshot.return_180d), (365, snapshot.return_365d),
    ):
        if value is None:
            reasons.append(f"insufficient_{horizon}d_history")
    if snapshot.staleness_hours > 24:
        reasons.append("stale_source_observation")
    if snapshot.evidence_quality < 0.5:
        reasons.append("low_evidence_quality")
    if snapshot.trend_state == "insufficient_data":
        reasons.append("insufficient_trend_evidence")
    return reasons


def build_descriptive_candidate(
    snapshot: TrendSnapshot,
    mapping: ObservationMapping,
    research_lineage: ResearchLineage,
    publication_lineage: Iterable[PublicationLineage],
    *,
    analytics_run_id: str,
    built_at: datetime,
    include_observed: bool = False,
    ttl_hours: float = 26,
) -> DescriptiveCandidatePacket:
    """Build an immutable review packet; database review/promotion stays separate."""

    built = _utc(built_at, "built_at")
    if built < snapshot.feature_cutoff:
        raise ValueError("built_at cannot precede the feature cutoff")
    if isinstance(ttl_hours, bool) or not isfinite(ttl_hours) or ttl_hours <= 0 or ttl_hours > 168:
        raise ValueError("ttl_hours must be inside (0, 168]")
    lineage = tuple(publication_lineage)
    unique_lineage = {
        (item.terms.source_id, item.terms.terms_review_id, item.usage_kind): item
        for item in lineage
    }
    lineage = tuple(unique_lineage[key] for key in sorted(unique_lineage))
    if not any(item.usage_kind == "catalog" for item in lineage):
        raise PermissionError("a catalog-metadata lineage review is required")
    derived = [
        item for item in lineage
        if item.usage_kind == "derived_feature" and item.terms.source_id == snapshot.key.source_id
    ]
    if not derived:
        raise PermissionError("the trend source lacks derived-feature lineage")
    if include_observed and not any(
        item.usage_kind == "raw_price" and item.terms.source_id == snapshot.key.source_id
        for item in lineage
    ):
        raise PermissionError("observed price display requires raw-price lineage")
    denied = [
        f"{item.terms.source_code}:{item.usage_kind}"
        for item in lineage
        if not item.terms.permits_public_usage(item.usage_kind, built)
    ]
    if denied:
        raise PermissionError(f"current source terms deny publication usage: {', '.join(denied)}")

    source_terms = derived[0].terms
    snapshot_row = build_trend_snapshot_row(
        snapshot,
        mapping,
        source_terms,
        research_lineage,
        analytics_run_id=analytics_run_id,
    )
    status = "published" if snapshot.trend_state != "insufficient_data" else "unsupported"
    support_tier = 2 if status == "published" else 0
    trend_status = "insufficient" if snapshot.trend_state == "insufficient_data" else snapshot.trend_state
    payload: dict[str, object] = {
        "trend": {
            "return7d": snapshot.return_7d,
            "return30d": snapshot.return_30d,
            "return90d": snapshot.return_90d,
            "return180d": snapshot.return_180d,
            "return365d": snapshot.return_365d,
            "status": trend_status,
            "volatility": snapshot.volatility_90d,
            "confidence": round(snapshot.evidence_quality * 100, 2),
            "historyDensity": snapshot.history_density_90d,
        },
        "drivers": _drivers(snapshot),
    }
    if include_observed:
        payload["observed"] = {
            "price": snapshot.current_price,
            "currency": snapshot.key.currency,
            "source": source_terms.source_name,
            "observedAt": snapshot.latest_observed_at.isoformat(),
            "quality": snapshot.source_quality_90d,
        }
    if "fairValue" in payload or "forecasts" in payload:
        raise ValueError("descriptive candidates cannot contain model outputs")

    policy_hash = aggregate_source_policy_hash(lineage)
    payload_hash = _hash(payload)
    candidate_id = str(uuid5(
        PUBLICATION_NAMESPACE,
        f"candidate|{mapping.variant_id}|{snapshot.feature_cutoff.isoformat()}|{payload_hash}|{policy_hash}",
    ))
    expiry_candidates = [built + timedelta(hours=ttl_hours)]
    expiry_candidates.extend(item.terms.expires_at for item in lineage if item.terms.expires_at is not None)
    expires_at = min(expiry_candidates)
    attributions: list[dict[str, str]] = []
    seen_sources: set[str] = set()
    for item in lineage:
        if item.terms.source_id in seen_sources:
            continue
        seen_sources.add(item.terms.source_id)
        attributions.append({
            "name": item.terms.source_name,
            "observedAt": snapshot.latest_observed_at.isoformat()
            if item.terms.source_id == snapshot.key.source_id else built.isoformat(),
            "attribution": item.terms.attribution_text,
        })

    candidate_row = {
        "id": candidate_id,
        "analytics_run_id": _uuid(analytics_run_id, "analytics_run_id"),
        "trend_snapshot_id": snapshot_row["id"],
        "catalog_variant_id": mapping.variant_id,
        "support_tier": support_tier,
        "publication_status": status,
        "reason_codes": _reason_codes(snapshot, include_observed=include_observed),
        "payload": payload,
        "source_attributions": attributions,
        "source_policy_hash": policy_hash,
        "payload_hash": payload_hash,
        "proposed_expires_at": expires_at.isoformat(),
        "created_at": built.isoformat(),
    }
    source_rows = tuple({
        "candidate_id": candidate_id,
        "source_id": item.terms.source_id,
        "terms_review_id": item.terms.terms_review_id,
        "usage_kind": item.usage_kind,
    } for item in lineage)
    return DescriptiveCandidatePacket(snapshot_row, candidate_row, source_rows)

