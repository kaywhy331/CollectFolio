"""Compile bounded operator-owned history into an immutable import packet.

This module is the production data-plane bridge for centralized price history.
It does not authenticate cards, publish forecasts, or write a database.  It
normalizes exact market series and preserves observed/available/ingested time
so the same stored rows can support honest point-in-time features later.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from hashlib import sha256
import json
from math import isfinite
from typing import Iterable, Mapping
from uuid import NAMESPACE_URL, UUID, uuid5

from .market_pipeline import (
    ObservationMapping,
    ObservationQualityPolicy,
    RawPriceRecord,
    SourceTerms,
    build_market_series_row,
    prepare_observation_batch,
)
from .observations import normalize_market_identity


HISTORY_IMPORT_MODE = "operator_centralized_history"
HISTORY_IMPORT_CONTRACT_VERSION = "centralized-history-import-v1"
HISTORY_IMPORT_NAMESPACE = uuid5(
    NAMESPACE_URL, "https://collectfolio.app/centralized-history-import/v1"
)
AVAILABILITY_SEMANTICS = frozenset({
    "source_supplied",
    "archive_release",
    "operator_first_seen",
    "observed_at_proxy",
})
MAX_HISTORY_SERIES = 2_000
MAX_HISTORY_OBSERVATIONS = 100_000
MAX_HISTORY_METADATA_BYTES = 16_384


def _utc(value: datetime, name: str) -> datetime:
    if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() is None:
        raise ValueError(f"{name} must be a timezone-aware datetime")
    return value.astimezone(timezone.utc)


def _text(value: str, name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{name} must be non-empty")
    return value.strip()


def _canonical_hash(value: object) -> str:
    payload = json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":"),
        allow_nan=False,
    )
    return sha256(payload.encode("utf-8")).hexdigest()


def _line_hash(values: Iterable[str]) -> str:
    return sha256("\n".join(sorted(values)).encode("utf-8")).hexdigest()


def _uuid5(namespace: UUID, value: str) -> str:
    return str(uuid5(namespace, value))


def _strict_json_value(value: object, name: str) -> object:
    if isinstance(value, Mapping):
        if any(not isinstance(key, str) for key in value):
            raise ValueError(f"{name} JSON object keys must be strings")
        return {
            key: _strict_json_value(item, f"{name}.{key}")
            for key, item in value.items()
        }
    if isinstance(value, (list, tuple)):
        return [
            _strict_json_value(item, f"{name}[{index}]")
            for index, item in enumerate(value)
        ]
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float) and isfinite(value):
        return value
    raise ValueError(f"{name} must contain strict finite JSON values")


def validate_history_import_metadata(
    value: object,
    name: str = "metadata",
) -> dict[str, object]:
    """Return strict metadata that fits its PostgreSQL JSONB text constraint."""

    if not isinstance(value, Mapping):
        raise ValueError(f"{name} must be an object")
    metadata = _strict_json_value(dict(value), name)
    assert isinstance(metadata, dict)
    # PostgreSQL jsonb::text emits a space after commas and colons. Measure the
    # same representation instead of compact packet JSON so an accepted packet
    # cannot fail the table CHECK solely because JSONB reintroduced whitespace.
    metadata_jsonb_text = json.dumps(
        metadata,
        ensure_ascii=False,
        separators=(", ", ": "),
        allow_nan=False,
    )
    if len(metadata_jsonb_text.encode("utf-8")) > MAX_HISTORY_METADATA_BYTES:
        raise ValueError(
            f"{name} exceeds the {MAX_HISTORY_METADATA_BYTES // 1024} KiB "
            "import limit after PostgreSQL JSONB rendering"
        )
    return metadata


@dataclass(frozen=True, slots=True)
class HistoricalImportSeries:
    """One declared exact market series and its source records."""

    mapping: ObservationMapping
    currency: str
    price_semantics: str
    records: tuple[RawPriceRecord, ...]

    def __post_init__(self) -> None:
        if not isinstance(self.mapping, ObservationMapping) or not self.mapping.approved:
            raise ValueError("historical series require an approved exact mapping")
        currency = _text(self.currency, "currency").upper()
        if len(currency) != 3 or not currency.isalpha():
            raise ValueError("currency must be a three-letter code")
        object.__setattr__(self, "currency", currency)
        semantics = normalize_market_identity(_text(
            self.price_semantics, "price_semantics"
        ))
        values = tuple(self.records)
        if not values or any(not isinstance(item, RawPriceRecord) for item in values):
            raise ValueError("records must contain RawPriceRecord values")
        if any(item.market_price is None or item.market_price <= 0 for item in values):
            raise ValueError("centralized historical records require positive price points")
        if any(item.external_key != self.mapping.external_key for item in values):
            raise ValueError("historical records differ from their exact provider mapping")
        if any(item.currency != currency for item in values):
            raise ValueError("historical records cannot mix currencies within a series")
        if any(item.price_semantics != semantics for item in values):
            raise ValueError("historical records cannot mix price semantics within a series")
        object.__setattr__(self, "price_semantics", semantics)
        object.__setattr__(self, "records", tuple(sorted(
            values,
            key=lambda item: (
                item.observed_at,
                item.available_at,
                item.external_record_id,
                item.source_record_hash,
            ),
        )))

@dataclass(frozen=True, slots=True)
class CentralizedHistoryImportConfig:
    """Operator declaration for one bounded, replayable import batch."""

    started_at: datetime
    completed_at: datetime
    ingested_at: datetime
    mapping_version: str
    parser_version: str
    code_version: str
    availability_semantics: str
    operator_label: str
    quality_policy: ObservationQualityPolicy = field(default_factory=ObservationQualityPolicy)
    metadata: Mapping[str, object] = field(default_factory=dict)

    def __post_init__(self) -> None:
        started = _utc(self.started_at, "started_at")
        completed = _utc(self.completed_at, "completed_at")
        ingested = _utc(self.ingested_at, "ingested_at")
        if completed < started:
            raise ValueError("completed_at cannot precede started_at")
        if ingested < started or ingested > completed:
            raise ValueError("ingested_at must fall inside the ingestion-run window")
        object.__setattr__(self, "started_at", started)
        object.__setattr__(self, "completed_at", completed)
        object.__setattr__(self, "ingested_at", ingested)
        object.__setattr__(self, "mapping_version", _text(
            self.mapping_version, "mapping_version"
        ))
        object.__setattr__(self, "parser_version", _text(
            self.parser_version, "parser_version"
        ))
        object.__setattr__(self, "code_version", _text(self.code_version, "code_version"))
        semantics = _text(self.availability_semantics, "availability_semantics")
        if semantics not in AVAILABILITY_SEMANTICS:
            raise ValueError(
                f"availability_semantics must be one of {sorted(AVAILABILITY_SEMANTICS)}"
            )
        object.__setattr__(self, "availability_semantics", semantics)
        object.__setattr__(self, "operator_label", _text(
            self.operator_label, "operator_label"
        ))
        if not isinstance(self.quality_policy, ObservationQualityPolicy):
            raise ValueError("quality_policy must be ObservationQualityPolicy")
        metadata = validate_history_import_metadata(self.metadata)
        object.__setattr__(self, "metadata", metadata)

    @property
    def point_in_time_eligible(self) -> bool:
        return self.availability_semantics != "observed_at_proxy"

    @property
    def quality_policy_hash(self) -> str:
        return _canonical_hash(asdict(self.quality_policy))


@dataclass(frozen=True, slots=True)
class CentralizedHistoryImportPacket:
    ingestion_run_row: Mapping[str, object]
    market_series_rows: tuple[Mapping[str, object], ...]
    observation_rows: tuple[Mapping[str, object], ...]
    observation_membership_rows: tuple[Mapping[str, object], ...]
    quality_event_rows: tuple[Mapping[str, object], ...]
    import_manifest_row: Mapping[str, object]

    @property
    def import_id(self) -> str:
        return str(self.import_manifest_row["id"])

    def as_dict(self) -> dict[str, object]:
        return {
            "mode": HISTORY_IMPORT_MODE,
            "contractVersion": HISTORY_IMPORT_CONTRACT_VERSION,
            "generatedAt": self.ingestion_run_row["completed_at"],
            "pointInTimeEligible": self.import_manifest_row["point_in_time_eligible"],
            "ingestionRunRow": dict(self.ingestion_run_row),
            "marketSeriesRows": [dict(row) for row in self.market_series_rows],
            "observationRows": [dict(row) for row in self.observation_rows],
            "observationMembershipRows": [
                dict(row) for row in self.observation_membership_rows
            ],
            "qualityEventRows": [dict(row) for row in self.quality_event_rows],
            "importManifestRow": dict(self.import_manifest_row),
            "publicCandidateRows": [],
            "forecastRows": [],
        }


def _validate_availability(
    records: Iterable[RawPriceRecord],
    config: CentralizedHistoryImportConfig,
) -> None:
    for record in records:
        if record.available_at > config.ingested_at:
            raise ValueError("historical available_at cannot exceed ingested_at")
        if (
            config.availability_semantics == "operator_first_seen"
            and record.available_at != config.ingested_at
        ):
            raise ValueError(
                "operator_first_seen requires every available_at to equal ingested_at"
            )
        if (
            config.availability_semantics == "observed_at_proxy"
            and record.available_at != record.observed_at
        ):
            raise ValueError(
                "observed_at_proxy requires every available_at to equal observed_at"
            )


def build_centralized_history_import(
    terms: SourceTerms,
    series: Iterable[HistoricalImportSeries],
    config: CentralizedHistoryImportConfig,
) -> CentralizedHistoryImportPacket:
    """Build one deterministic, multi-series centralized-history packet."""

    if not isinstance(terms, SourceTerms):
        raise ValueError("terms must be SourceTerms")
    if not isinstance(config, CentralizedHistoryImportConfig):
        raise ValueError("config must be CentralizedHistoryImportConfig")
    if not terms.permits_research_ingestion(config.ingested_at):
        raise PermissionError("current source terms do not permit centralized ingestion")

    values = tuple(series)
    if not values or len(values) > MAX_HISTORY_SERIES:
        raise ValueError(
            f"series must contain between 1 and {MAX_HISTORY_SERIES} exact series"
        )
    if any(not isinstance(item, HistoricalImportSeries) for item in values):
        raise ValueError("series must contain HistoricalImportSeries values")
    if any(item.mapping.source_id != terms.source_id for item in values):
        raise ValueError("historical series cannot cross source identities")
    if any(item.mapping.mapping_version != config.mapping_version for item in values):
        raise ValueError("historical series must use the declared mapping version")

    declared: list[tuple[Mapping[str, object], HistoricalImportSeries]] = []
    for item in values:
        row = build_market_series_row(
            item.mapping,
            terms,
            currency=item.currency,
            price_semantics=item.price_semantics,
        )
        declared.append((row, item))
    declared.sort(key=lambda item: (str(item[0]["identity_hash"]), str(item[0]["id"])))
    identity_hashes = [str(row["identity_hash"]) for row, _ in declared]
    if len(set(identity_hashes)) != len(identity_hashes):
        raise ValueError("duplicate exact market-series declarations must be consolidated")

    record_count = sum(len(item.records) for _, item in declared)
    if record_count > MAX_HISTORY_OBSERVATIONS:
        raise ValueError(
            f"history import exceeds the {MAX_HISTORY_OBSERVATIONS}-observation limit"
        )
    all_records = tuple(record for _, item in declared for record in item.records)
    _validate_availability(all_records, config)
    record_hashes = [item.source_record_hash for item in all_records]
    if len(set(record_hashes)) != len(record_hashes):
        raise ValueError("history import contains duplicate source-record hashes")

    dataset_lines = [
        f"{row['identity_hash']}|{record.source_record_hash}"
        for row, item in declared
        for record in item.records
    ]
    dataset_sha256 = _line_hash(dataset_lines)
    import_seed = "|".join((
        terms.source_id,
        terms.terms_review_id,
        dataset_sha256,
        config.mapping_version,
        config.quality_policy_hash,
        config.availability_semantics,
    ))
    import_id = _uuid5(HISTORY_IMPORT_NAMESPACE, f"import|{import_seed}")
    ingestion_run_id = _uuid5(UUID(import_id), "source-ingestion-run")

    ordered_records = tuple(
        record
        for _, item in declared
        for record in item.records
    )
    unique_mappings = {
        item.mapping.mapping_id: item.mapping for _, item in declared
    }
    batch = prepare_observation_batch(
        ordered_records,
        tuple(unique_mappings[key] for key in sorted(unique_mappings)),
        terms,
        {},
        ingestion_run_id=ingestion_run_id,
        ingested_at=config.ingested_at,
        actor_label=config.operator_label,
        policy=config.quality_policy,
    )
    if any(item.status == "rejected" for item in batch.prepared):
        raise ValueError("centralized history import refuses unresolved or rejected records")
    if len(batch.database_rows) != record_count:
        raise ValueError("every centralized price point must produce one stored observation")

    actual_series_rows = tuple(batch.market_series_rows)
    actual_by_hash = {str(row["identity_hash"]): row for row in actual_series_rows}
    declared_by_hash = {str(row["identity_hash"]): row for row, _ in declared}
    if actual_by_hash != declared_by_hash:
        raise ValueError("prepared observations differ from the declared exact series")
    series_rows = tuple(declared_by_hash[key] for key in sorted(declared_by_hash))
    series_identity_by_id = {
        str(row["id"]): str(row["identity_hash"]) for row in series_rows
    }
    observation_rows = tuple(sorted(
        batch.database_rows,
        key=lambda row: (
            series_identity_by_id[str(row["market_series_id"])],
            str(row["observed_at"]),
            str(row["available_at"]),
            str(row["source_record_hash"]),
        ),
    ))
    observation_set_sha256 = _line_hash(
        f"{series_identity_by_id[str(row['market_series_id'])]}|"
        f"{row['source_record_hash']}|{row['observation_status']}"
        for row in observation_rows
    )
    series_set_sha256 = _line_hash(identity_hashes)
    accepted_count = sum(row["observation_status"] == "accepted" for row in observation_rows)
    quarantined_count = len(observation_rows) - accepted_count
    membership_rows = tuple({
        "import_id": import_id,
        "observation_id": row["id"],
        "market_series_id": row["market_series_id"],
        "source_record_hash": row["source_record_hash"],
        "observation_status": row["observation_status"],
    } for row in observation_rows)

    ingestion_run_row = {
        "id": ingestion_run_id,
        "source_id": terms.source_id,
        "terms_review_id": terms.terms_review_id,
        "started_at": config.started_at.isoformat(),
        "completed_at": config.completed_at.isoformat(),
        "status": "succeeded" if quarantined_count == 0 else "partial",
        "records_read": record_count,
        "records_written": len(observation_rows),
        "records_quarantined": quarantined_count,
        "raw_payload_hash": dataset_sha256,
        "parser_version": config.parser_version,
        "code_commit": config.code_version,
        "error_summary": None,
        "metadata": {
            "contractVersion": HISTORY_IMPORT_CONTRACT_VERSION,
            "historyImportId": import_id,
            "availabilitySemantics": config.availability_semantics,
            "pointInTimeEligible": config.point_in_time_eligible,
            "qualityPolicyHash": config.quality_policy_hash,
        },
    }
    observed_values = [row["observed_at"] for row in observation_rows]
    available_values = [row["available_at"] for row in observation_rows]
    manifest_metadata = validate_history_import_metadata({
        **dict(config.metadata),
        "qualityPolicy": asdict(config.quality_policy),
    }, "manifest metadata")
    import_manifest_row = {
        "id": import_id,
        "contract_version": HISTORY_IMPORT_CONTRACT_VERSION,
        "ingestion_run_id": ingestion_run_id,
        "source_id": terms.source_id,
        "terms_review_id": terms.terms_review_id,
        "dataset_sha256": dataset_sha256,
        "series_set_sha256": series_set_sha256,
        "observation_set_sha256": observation_set_sha256,
        "quality_policy_hash": config.quality_policy_hash,
        "expected_series_count": len(series_rows),
        "expected_observation_count": len(observation_rows),
        "expected_accepted_count": accepted_count,
        "observed_from": min(observed_values),
        "observed_through": max(observed_values),
        "available_from": min(available_values),
        "available_through": max(available_values),
        "ingested_at": config.ingested_at.isoformat(),
        "availability_semantics": config.availability_semantics,
        "point_in_time_eligible": config.point_in_time_eligible,
        "mapping_version": config.mapping_version,
        "parser_version": config.parser_version,
        "code_version": config.code_version,
        "operator_label": config.operator_label,
        "metadata": manifest_metadata,
    }
    return CentralizedHistoryImportPacket(
        ingestion_run_row=ingestion_run_row,
        market_series_rows=series_rows,
        observation_rows=observation_rows,
        observation_membership_rows=membership_rows,
        quality_event_rows=tuple(batch.quality_events),
        import_manifest_row=import_manifest_row,
    )
