"""Rights-aware preparation of point-in-time market observations."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from hashlib import sha256
import json
from math import isfinite, log
from statistics import median
from typing import Iterable, Mapping
from uuid import UUID

from .observations import PriceObservation, PriceSeriesKey, point_in_time_series


def _uuid(value: str, name: str) -> str:
    try:
        return str(UUID(str(value)))
    except (TypeError, ValueError, AttributeError) as exc:
        raise ValueError(f"{name} must be a UUID") from exc


def _required(value: str, name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{name} must be non-empty")
    return value.strip()


def _utc(value: datetime, name: str) -> datetime:
    if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() is None:
        raise ValueError(f"{name} must be timezone-aware")
    return value.astimezone(timezone.utc)


def _canonical_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _hash(value: object) -> str:
    return sha256(_canonical_json(value).encode("utf-8")).hexdigest()


@dataclass(frozen=True, slots=True)
class SourceTerms:
    source_id: str
    terms_review_id: str
    current_terms_review_id: str
    source_code: str
    source_name: str
    decision: str
    active: bool
    commercial_use_allowed: bool
    catalog_metadata_allowed: bool
    public_raw_display_allowed: bool
    public_derived_display_allowed: bool
    attribution_required: bool
    attribution_text: str
    document_hash: str
    reviewed_at: datetime
    expires_at: datetime | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "source_id", _uuid(self.source_id, "source_id"))
        object.__setattr__(self, "terms_review_id", _uuid(self.terms_review_id, "terms_review_id"))
        object.__setattr__(self, "current_terms_review_id", _uuid(self.current_terms_review_id, "current_terms_review_id"))
        object.__setattr__(self, "source_code", _required(self.source_code, "source_code"))
        object.__setattr__(self, "source_name", _required(self.source_name, "source_name"))
        if self.decision not in {"pending", "research_only", "approved", "rejected", "expired"}:
            raise ValueError("invalid source terms decision")
        document_hash = str(self.document_hash).strip().lower()
        if len(document_hash) != 64 or any(character not in "0123456789abcdef" for character in document_hash):
            raise ValueError("document_hash must be a SHA-256 digest")
        object.__setattr__(self, "document_hash", document_hash)
        object.__setattr__(self, "reviewed_at", _utc(self.reviewed_at, "reviewed_at"))
        if self.expires_at is not None:
            expiry = _utc(self.expires_at, "expires_at")
            if expiry <= self.reviewed_at:
                raise ValueError("expires_at must follow reviewed_at")
            object.__setattr__(self, "expires_at", expiry)
        object.__setattr__(self, "attribution_text", str(self.attribution_text or "").strip())
        if self.attribution_required and not self.attribution_text:
            raise ValueError("attribution_text is required by these source terms")

    @property
    def is_current(self) -> bool:
        return self.current_terms_review_id == self.terms_review_id

    def is_unexpired(self, at: datetime) -> bool:
        instant = _utc(at, "at")
        return self.expires_at is None or self.expires_at > instant

    def permits_research_ingestion(self, at: datetime) -> bool:
        instant = _utc(at, "at")
        return (
            self.active
            and self.is_current
            and self.decision in {"research_only", "approved"}
            and self.reviewed_at <= instant
            and self.is_unexpired(instant)
        )

    def permits_public_usage(self, usage_kind: str, at: datetime) -> bool:
        instant = _utc(at, "at")
        if not (
            self.active
            and self.is_current
            and self.decision == "approved"
            and self.commercial_use_allowed
            and self.reviewed_at <= instant
            and self.is_unexpired(instant)
        ):
            return False
        return {
            "catalog": self.catalog_metadata_allowed,
            "raw_price": self.public_raw_display_allowed,
            "derived_feature": self.public_derived_display_allowed,
        }.get(usage_kind, False)

    @property
    def policy_hash(self) -> str:
        return _hash({
            "sourceId": self.source_id,
            "termsReviewId": self.terms_review_id,
            "currentTermsReviewId": self.current_terms_review_id,
            "decision": self.decision,
            "active": self.active,
            "commercial": self.commercial_use_allowed,
            "catalog": self.catalog_metadata_allowed,
            "raw": self.public_raw_display_allowed,
            "derived": self.public_derived_display_allowed,
            "attributionRequired": self.attribution_required,
            "attributionText": self.attribution_text,
            "documentHash": self.document_hash,
            "reviewedAt": self.reviewed_at.isoformat(),
            "expiresAt": self.expires_at.isoformat() if self.expires_at else None,
        })


@dataclass(frozen=True, slots=True)
class ObservationMapping:
    mapping_id: str
    source_id: str
    variant_id: str
    external_product_id: str
    external_variant_key: str
    mapping_confidence: float
    review_status: str
    mapping_version: str
    finish: str
    condition_class: str

    def __post_init__(self) -> None:
        object.__setattr__(self, "mapping_id", _uuid(self.mapping_id, "mapping_id"))
        object.__setattr__(self, "source_id", _uuid(self.source_id, "source_id"))
        object.__setattr__(self, "variant_id", _uuid(self.variant_id, "variant_id"))
        object.__setattr__(self, "external_product_id", _required(self.external_product_id, "external_product_id"))
        object.__setattr__(self, "external_variant_key", str(self.external_variant_key or "").strip())
        if isinstance(self.mapping_confidence, bool) or not isfinite(self.mapping_confidence) or not 0 <= self.mapping_confidence <= 1:
            raise ValueError("mapping_confidence must be between zero and one")
        if self.review_status not in {"pending", "approved", "rejected", "quarantined"}:
            raise ValueError("invalid mapping review_status")
        object.__setattr__(self, "mapping_version", _required(self.mapping_version, "mapping_version"))
        object.__setattr__(self, "finish", _required(self.finish, "finish").lower())
        object.__setattr__(self, "condition_class", _required(self.condition_class, "condition_class").lower())

    @property
    def external_key(self) -> tuple[str, str]:
        return self.external_product_id, self.external_variant_key

    @property
    def approved(self) -> bool:
        return self.review_status == "approved" and self.mapping_confidence >= 0.98


@dataclass(frozen=True, slots=True)
class RawPriceRecord:
    external_record_id: str
    external_product_id: str
    external_variant_key: str
    price_semantics: str
    currency: str
    market_price: float | None
    observed_at: datetime
    available_at: datetime
    quality_score: float = 1.0

    def __post_init__(self) -> None:
        object.__setattr__(self, "external_record_id", _required(self.external_record_id, "external_record_id"))
        object.__setattr__(self, "external_product_id", _required(self.external_product_id, "external_product_id"))
        object.__setattr__(self, "external_variant_key", str(self.external_variant_key or "").strip())
        object.__setattr__(self, "price_semantics", _required(self.price_semantics, "price_semantics").lower())
        currency = _required(self.currency, "currency").upper()
        if len(currency) != 3 or not currency.isalpha():
            raise ValueError("currency must be a three-letter code")
        object.__setattr__(self, "currency", currency)
        object.__setattr__(self, "observed_at", _utc(self.observed_at, "observed_at"))
        available = _utc(self.available_at, "available_at")
        if available < self.observed_at:
            raise ValueError("available_at cannot precede observed_at")
        object.__setattr__(self, "available_at", available)
        if self.market_price is not None:
            if isinstance(self.market_price, bool) or not isfinite(self.market_price):
                raise ValueError("market_price must be finite or None")
            object.__setattr__(self, "market_price", float(self.market_price))
        if isinstance(self.quality_score, bool) or not isfinite(self.quality_score) or not 0 <= self.quality_score <= 1:
            raise ValueError("quality_score must be between zero and one")
        object.__setattr__(self, "quality_score", float(self.quality_score))

    @property
    def external_key(self) -> tuple[str, str]:
        return self.external_product_id, self.external_variant_key

    @property
    def source_record_hash(self) -> str:
        return _hash({
            "externalRecordId": self.external_record_id,
            "externalProductId": self.external_product_id,
            "externalVariantKey": self.external_variant_key,
            "priceSemantics": self.price_semantics,
            "currency": self.currency,
            "marketPrice": self.market_price,
            "observedAt": self.observed_at.isoformat(),
            "availableAt": self.available_at.isoformat(),
            "quality": self.quality_score,
        })


@dataclass(frozen=True, slots=True)
class ObservationQualityPolicy:
    minimum_history: int = 7
    max_log_mad_z: float = 8.0
    zero_mad_max_log_deviation: float = log(3)
    history_window_days: int = 90

    def __post_init__(self) -> None:
        if isinstance(self.minimum_history, bool) or not isinstance(self.minimum_history, int) or self.minimum_history < 2:
            raise ValueError("minimum_history must be at least two")
        if not isfinite(self.max_log_mad_z) or self.max_log_mad_z <= 0:
            raise ValueError("max_log_mad_z must be positive")
        if not isfinite(self.zero_mad_max_log_deviation) or self.zero_mad_max_log_deviation <= 0:
            raise ValueError("zero_mad_max_log_deviation must be positive")
        if (
            isinstance(self.history_window_days, bool)
            or not isinstance(self.history_window_days, int)
            or self.history_window_days < 1
        ):
            raise ValueError("history_window_days must be a positive integer")


@dataclass(frozen=True, slots=True)
class PreparedObservation:
    record: RawPriceRecord
    mapping: ObservationMapping | None
    status: str
    reason_codes: tuple[str, ...]
    database_row: Mapping[str, object] | None
    trend_observation: PriceObservation | None
    quality_event: Mapping[str, object] | None


@dataclass(frozen=True, slots=True)
class ObservationBatch:
    prepared: tuple[PreparedObservation, ...]
    dataset_hash: str

    @property
    def status_counts(self) -> dict[str, int]:
        return {
            status: sum(item.status == status for item in self.prepared)
            for status in ("accepted", "missing", "outlier", "quarantined", "rejected")
        }

    @property
    def database_rows(self) -> tuple[Mapping[str, object], ...]:
        return tuple(item.database_row for item in self.prepared if item.database_row is not None)

    @property
    def trend_observations(self) -> tuple[PriceObservation, ...]:
        return tuple(item.trend_observation for item in self.prepared if item.trend_observation is not None)

    @property
    def quality_events(self) -> tuple[Mapping[str, object], ...]:
        return tuple(item.quality_event for item in self.prepared if item.quality_event is not None)


def _outlier_reason(
    price: float,
    history: Iterable[PriceObservation],
    policy: ObservationQualityPolicy,
) -> str | None:
    values = tuple(history)
    if len(values) < policy.minimum_history:
        return None
    logs = [log(item.price) for item in values]
    center = median(logs)
    mad = median(abs(value - center) for value in logs)
    deviation = abs(log(price) - center)
    if mad == 0:
        return "zero_mad_price_jump" if deviation > policy.zero_mad_max_log_deviation else None
    robust_z = deviation / (1.4826 * mad)
    return "robust_price_outlier" if robust_z > policy.max_log_mad_z else None


def _quality_event(
    record: RawPriceRecord,
    status: str,
    reasons: tuple[str, ...],
    *,
    actor_label: str,
) -> dict[str, object] | None:
    if status == "accepted":
        return None
    flag_code = reasons[0] if reasons else status
    event = {
        "entity_type": "observation",
        "entity_id": record.source_record_hash,
        "event_kind": "quarantined" if status in {"outlier", "quarantined", "rejected"} else "opened",
        "flag_code": flag_code,
        "severity": "error" if status in {"quarantined", "rejected"} else "warning",
        "details": {"reasonCodes": list(reasons), "externalRecordId": record.external_record_id},
        "actor_label": actor_label,
    }
    return {**event, "event_hash": _hash(event)}


def prepare_price_record(
    record: RawPriceRecord,
    mapping: ObservationMapping | None,
    terms: SourceTerms,
    history: Iterable[PriceObservation],
    *,
    ingestion_run_id: str,
    ingested_at: datetime,
    actor_label: str,
    policy: ObservationQualityPolicy = ObservationQualityPolicy(),
) -> PreparedObservation:
    """Prepare one row; disallowed source terms fail before source data is stored."""

    if not isinstance(record, RawPriceRecord):
        raise ValueError("record must be a RawPriceRecord")
    if not isinstance(terms, SourceTerms):
        raise ValueError("terms must be SourceTerms")
    instant = _utc(ingested_at, "ingested_at")
    if instant < record.available_at:
        raise ValueError("ingested_at cannot precede available_at")
    if not terms.permits_research_ingestion(instant):
        raise PermissionError("current source terms do not permit research ingestion")
    run_id = _uuid(ingestion_run_id, "ingestion_run_id")
    actor = _required(actor_label, "actor_label")

    if mapping is None or mapping.source_id != terms.source_id or mapping.external_key != record.external_key:
        reasons = ("unresolved_exact_mapping",)
        return PreparedObservation(
            record, mapping, "rejected", reasons, None, None,
            _quality_event(record, "rejected", reasons, actor_label=actor),
        )
    if not mapping.approved:
        reasons = ("mapping_not_approved",)
        return PreparedObservation(
            record, mapping, "rejected", reasons, None, None,
            _quality_event(record, "rejected", reasons, actor_label=actor),
        )
    if record.market_price is not None and record.market_price <= 0:
        reasons = ("non_positive_price",)
        return PreparedObservation(
            record, mapping, "rejected", reasons, None, None,
            _quality_event(record, "rejected", reasons, actor_label=actor),
        )

    series_key = PriceSeriesKey(
        mapping.variant_id,
        terms.source_id,
        record.currency,
        mapping.finish,
        mapping.condition_class,
        record.price_semantics,
    )
    history_values = tuple(history)
    if any(item.key != series_key for item in history_values):
        raise ValueError("outlier history cannot mix exact price-series identities")
    known_history = tuple(
        item for item in point_in_time_series(history_values, record.available_at, key=series_key)
        if item.observed_at < record.observed_at
        and item.observed_at >= record.observed_at - timedelta(days=policy.history_window_days)
    )

    status = "missing" if record.market_price is None else "accepted"
    reasons: tuple[str, ...] = ("source_value_missing",) if status == "missing" else ()
    if record.market_price is not None:
        outlier = _outlier_reason(record.market_price, known_history, policy)
        if outlier:
            status = "outlier"
            reasons = (outlier,)

    database_row = {
        "ingestion_run_id": run_id,
        "source_id": terms.source_id,
        "terms_review_id": terms.terms_review_id,
        "mapping_id": mapping.mapping_id,
        "variant_id": mapping.variant_id,
        "external_record_id": record.external_record_id,
        "price_semantics": record.price_semantics,
        "currency": record.currency,
        "market_price": record.market_price,
        "observed_at": record.observed_at.isoformat(),
        "available_at": record.available_at.isoformat(),
        "ingested_at": instant.isoformat(),
        "quality_score": record.quality_score,
        "observation_status": status,
        "reason_codes": list(reasons),
        "source_record_hash": record.source_record_hash,
        "metadata": {"mappingVersion": mapping.mapping_version},
    }
    trend_observation = None
    if status == "accepted":
        trend_observation = PriceObservation(
            key=series_key,
            observed_at=record.observed_at,
            available_at=record.available_at,
            price=record.market_price,
            quality=record.quality_score,
            source_observation_id=record.source_record_hash,
        )
    return PreparedObservation(
        record, mapping, status, reasons, database_row, trend_observation,
        _quality_event(record, status, reasons, actor_label=actor),
    )


def prepare_observation_batch(
    records: Iterable[RawPriceRecord],
    mappings: Iterable[ObservationMapping],
    terms: SourceTerms,
    history_by_variant: Mapping[str, Iterable[PriceObservation]],
    *,
    ingestion_run_id: str,
    ingested_at: datetime,
    actor_label: str,
    policy: ObservationQualityPolicy = ObservationQualityPolicy(),
) -> ObservationBatch:
    mapping_index = {mapping.external_key: mapping for mapping in mappings}
    rolling_history = {
        variant_id: list(values)
        for variant_id, values in history_by_variant.items()
    }
    prepared_values: list[PreparedObservation] = []
    for record in records:
        mapping = mapping_index.get(record.external_key)
        prepared = prepare_price_record(
            record,
            mapping,
            terms,
            rolling_history.get(mapping.variant_id, ()) if mapping else (),
            ingestion_run_id=ingestion_run_id,
            ingested_at=ingested_at,
            actor_label=actor_label,
            policy=policy,
        )
        prepared_values.append(prepared)
        if prepared.trend_observation is not None and mapping is not None:
            rolling_history.setdefault(mapping.variant_id, []).append(
                prepared.trend_observation
            )
    prepared_rows = tuple(prepared_values)
    dataset_hash = _hash({
        "sourcePolicyHash": terms.policy_hash,
        "records": [
            {
                "sourceRecordHash": item.record.source_record_hash,
                "status": item.status,
                "variantId": item.mapping.variant_id if item.mapping else None,
            }
            for item in prepared_rows
        ],
    })
    return ObservationBatch(prepared_rows, dataset_hash)
