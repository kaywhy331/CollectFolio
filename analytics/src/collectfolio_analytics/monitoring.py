"""Deterministic operational health reports for private research packets."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from hashlib import sha256
import json
from math import isfinite
from typing import Mapping


def _utc(value: datetime, name: str) -> datetime:
    if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() is None:
        raise ValueError(f"{name} must be timezone-aware")
    return value.astimezone(timezone.utc)


def _timestamp(value: object, name: str) -> datetime:
    text = str(value or "").strip()
    normalized = text[:-1] + "+00:00" if text.endswith("Z") else text
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError as exc:
        raise ValueError(f"{name} must be an ISO timestamp") from exc
    return _utc(parsed, name)


def _hash(value: object) -> str:
    payload = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return sha256(payload.encode("utf-8")).hexdigest()


@dataclass(frozen=True, slots=True)
class PipelineHealthPolicy:
    maximum_source_lag_hours: float = 36
    maximum_quarantine_fraction: float = 0.25
    terms_expiry_warning_days: float = 14

    def __post_init__(self) -> None:
        if (
            isinstance(self.maximum_source_lag_hours, bool)
            or not isfinite(self.maximum_source_lag_hours)
            or self.maximum_source_lag_hours <= 0
        ):
            raise ValueError("maximum_source_lag_hours must be positive")
        if (
            isinstance(self.maximum_quarantine_fraction, bool)
            or not isfinite(self.maximum_quarantine_fraction)
            or not 0 <= self.maximum_quarantine_fraction <= 1
        ):
            raise ValueError("maximum_quarantine_fraction must be between zero and one")
        if (
            isinstance(self.terms_expiry_warning_days, bool)
            or not isfinite(self.terms_expiry_warning_days)
            or self.terms_expiry_warning_days <= 0
        ):
            raise ValueError("terms_expiry_warning_days must be positive")


@dataclass(frozen=True, slots=True)
class OperationalAlert:
    code: str
    severity: str
    message: str
    details: Mapping[str, object]
    alert_hash: str

    @classmethod
    def build(
        cls,
        code: str,
        severity: str,
        message: str,
        details: Mapping[str, object],
    ) -> "OperationalAlert":
        if severity not in {"info", "warning", "error", "critical"}:
            raise ValueError("invalid alert severity")
        evidence = dict(details)
        content = {"code": code, "severity": severity, "message": message, "details": evidence}
        return cls(code, severity, message, evidence, _hash(content))

    def as_dict(self) -> dict[str, object]:
        return {
            "code": self.code,
            "severity": self.severity,
            "message": self.message,
            "details": dict(self.details),
            "alertHash": self.alert_hash,
        }


@dataclass(frozen=True, slots=True)
class PipelineHealthReport:
    status: str
    evaluated_at: datetime
    metrics: Mapping[str, object]
    alerts: tuple[OperationalAlert, ...]
    public_publication_allowed: bool = False

    def as_dict(self) -> dict[str, object]:
        return {
            "status": self.status,
            "evaluatedAt": self.evaluated_at.isoformat(),
            "metrics": dict(self.metrics),
            "alerts": [alert.as_dict() for alert in self.alerts],
            "publicPublicationAllowed": False,
        }


def assess_operator_packet(
    packet: Mapping[str, object],
    evaluated_at: datetime,
    *,
    policy: PipelineHealthPolicy = PipelineHealthPolicy(),
) -> PipelineHealthReport:
    """Assess freshness, quarantine pressure, and non-public safety invariants."""

    if not isinstance(packet, Mapping):
        raise ValueError("packet must be an object")
    instant = _utc(evaluated_at, "evaluated_at")
    ingestion = packet.get("ingestion")
    source = packet.get("source")
    catalog = packet.get("catalog")
    observations = packet.get("observations")
    gates = packet.get("gateStatus")
    if not all(isinstance(value, Mapping) for value in (ingestion, catalog, observations, gates)):
        raise ValueError("packet is missing monitoring sections")

    source_updated = _timestamp(ingestion.get("sourceUpdatedAt"), "sourceUpdatedAt")
    source_lag_hours = (instant - source_updated).total_seconds() / 3600
    if source_lag_hours < 0:
        raise ValueError("sourceUpdatedAt cannot follow monitoring time")
    raw_count = int(ingestion.get("rawRecordCount", 0))
    if raw_count < 0:
        raise ValueError("rawRecordCount cannot be negative")
    status_counts = observations.get("statusCounts")
    if not isinstance(status_counts, Mapping):
        raise ValueError("observation statusCounts must be an object")
    quarantined = sum(int(status_counts.get(key, 0)) for key in ("outlier", "quarantined"))
    rejected = int(status_counts.get("rejected", 0))
    quarantine_fraction = quarantined / raw_count if raw_count else 0.0
    candidate_rows = catalog.get("mappingCandidates")
    if not isinstance(candidate_rows, list):
        raise ValueError("mappingCandidates must be an array")
    pending_review = sum(
        isinstance(row, Mapping)
        and (
            row.get("disposition") in {"review", "quarantined", "unmapped"}
            or "initial_mapping_review_required" in row.get("reason_codes", [])
        )
        for row in candidate_rows
    )
    terms_expires_at = None
    terms_expiry_days_remaining = None
    if isinstance(source, Mapping) and source.get("expiresAt"):
        terms_expires_at = _timestamp(source.get("expiresAt"), "source.expiresAt")
        terms_expiry_days_remaining = (terms_expires_at - instant).total_seconds() / 86400

    alerts: list[OperationalAlert] = []
    if packet.get("mode") != "research_only" or gates.get("sourceRights") != "research_only":
        alerts.append(OperationalAlert.build(
            "research_mode_violation", "critical",
            "The TCGCSV packet escaped its research-only source contract.",
            {"mode": packet.get("mode"), "sourceRights": gates.get("sourceRights")},
        ))
    if gates.get("publicPublication") != "blocked":
        alerts.append(OperationalAlert.build(
            "public_gate_open", "critical",
            "A research packet reported a public publication path.",
            {"publicPublication": gates.get("publicPublication")},
        ))
    if terms_expiry_days_remaining is not None and terms_expiry_days_remaining <= 0:
        alerts.append(OperationalAlert.build(
            "source_terms_expired", "critical", "The source terms review has expired.",
            {"expiresAt": terms_expires_at.isoformat()},
        ))
    elif (
        terms_expiry_days_remaining is not None
        and terms_expiry_days_remaining <= policy.terms_expiry_warning_days
    ):
        alerts.append(OperationalAlert.build(
            "source_terms_expiring", "warning",
            "The source terms review is approaching expiry.",
            {
                "expiresAt": terms_expires_at.isoformat(),
                "daysRemaining": round(terms_expiry_days_remaining, 3),
                "warningDays": policy.terms_expiry_warning_days,
            },
        ))
    if source_lag_hours > policy.maximum_source_lag_hours:
        alerts.append(OperationalAlert.build(
            "source_stale", "warning", "The research source snapshot is stale.",
            {
                "lagHours": round(source_lag_hours, 3),
                "maximumLagHours": policy.maximum_source_lag_hours,
            },
        ))
    if not raw_count:
        alerts.append(OperationalAlert.build(
            "source_empty", "error", "The research source returned no selected price records.", {}
        ))
    if quarantine_fraction > policy.maximum_quarantine_fraction:
        alerts.append(OperationalAlert.build(
            "quarantine_rate_high", "warning",
            "The observation quarantine rate exceeds the research policy.",
            {
                "quarantineFraction": quarantine_fraction,
                "maximumFraction": policy.maximum_quarantine_fraction,
            },
        ))
    if pending_review:
        alerts.append(OperationalAlert.build(
            "mapping_review_required", "info",
            "Initial exact-variant mappings require an independent operator review.",
            {"candidateCount": pending_review},
        ))
    if rejected and not pending_review:
        alerts.append(OperationalAlert.build(
            "observation_rejected", "error",
            "Price observations were rejected without a pending mapping-review explanation.",
            {"rejectedCount": rejected},
        ))

    severities = {alert.severity for alert in alerts}
    if "critical" in severities:
        status = "blocked"
    elif "error" in severities:
        status = "failed"
    elif "warning" in severities:
        status = "degraded"
    elif pending_review:
        status = "review_required"
    else:
        status = "healthy"
    metrics = {
        "sourceLagHours": round(source_lag_hours, 3),
        "rawRecordCount": raw_count,
        "quarantineFraction": quarantine_fraction,
        "mappingCandidatesPendingReview": pending_review,
        "acceptedObservationCount": int(status_counts.get("accepted", 0)),
        "rejectedObservationCount": rejected,
        "termsExpiresAt": terms_expires_at.isoformat() if terms_expires_at else None,
        "termsExpiryDaysRemaining": (
            round(terms_expiry_days_remaining, 3)
            if terms_expiry_days_remaining is not None else None
        ),
    }
    return PipelineHealthReport(status, instant, metrics, tuple(alerts), False)
