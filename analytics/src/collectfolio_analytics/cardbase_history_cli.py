"""Collect a bounded Cardbase MTG cohort into a centralized-history packet."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from datetime import datetime, timezone
import json
from math import isfinite
import os
from pathlib import Path
import time
from typing import Callable, Mapping, Sequence
from uuid import UUID

from .cardbase import (
    ANONYMOUS_HISTORY_DAYS,
    AUTHENTICATED_HISTORY_DAYS,
    MAX_PRICE_SERIES,
    CardbaseClient,
    CardbaseSnapshot,
    assert_cardbase_research_terms,
    cardbase_series_key,
)
from .cardbase_history import CardbaseFirstSeenLedger
from .historical_import import (
    CentralizedHistoryImportConfig,
    HistoricalImportSeries,
    build_centralized_history_import,
)
from .historical_import_sql import build_centralized_history_import_sql
from .market_pipeline import (
    ObservationMapping,
    ObservationQualityPolicy,
    RawPriceRecord,
    SourceTerms,
)


MODE = "private_cardbase_mtg_history"
MAX_PRINTINGS_PER_RUN = 50
MAX_SERIES_PER_RUN = 250
MIN_REQUEST_INTERVAL_SECONDS = 1.05
MAX_REQUEST_INTERVAL_SECONDS = 10.0
Clock = Callable[[], datetime]
Sleep = Callable[[float], None]


def _mapping(value: object, name: str) -> Mapping[str, object]:
    if not isinstance(value, Mapping):
        raise ValueError(f"{name} must be an object")
    return value


def _sequence(value: object, name: str) -> list[object]:
    if not isinstance(value, list):
        raise ValueError(f"{name} must be an array")
    return value


def _text(value: object, name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{name} must be non-empty")
    return value.strip()


def _bool(value: object, name: str) -> bool:
    if not isinstance(value, bool):
        raise ValueError(f"{name} must be boolean")
    return value


def _datetime(value: object, name: str) -> datetime:
    raw = _text(value, name)
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(f"{name} must be an ISO timestamp") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError(f"{name} must include a timezone")
    return parsed.astimezone(timezone.utc)


def _clock_utc(clock: Clock, name: str) -> datetime:
    value = clock()
    if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() is None:
        raise ValueError(f"{name} must return a timezone-aware datetime")
    return value.astimezone(timezone.utc)


def _optional_datetime(value: object, name: str) -> datetime | None:
    return None if value in (None, "") else _datetime(value, name)


def _uuid(value: object, name: str) -> str:
    try:
        return str(UUID(_text(value, name)))
    except ValueError as exc:
        raise ValueError(f"{name} must be a UUID") from exc


def _sha256(value: object, name: str) -> str:
    digest = _text(value, name).lower()
    if len(digest) != 64 or any(char not in "0123456789abcdef" for char in digest):
        raise ValueError(f"{name} must be a SHA-256 digest")
    return digest


def _integer(value: object, name: str, *, minimum: int, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{name} must be an integer")
    if not minimum <= value <= maximum:
        raise ValueError(f"{name} must be between {minimum} and {maximum}")
    return value


def _number(value: object, name: str, *, minimum: float, maximum: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name} must be numeric")
    result = float(value)
    if not isfinite(result) or not minimum <= result <= maximum:
        raise ValueError(f"{name} must be between {minimum:g} and {maximum:g}")
    return result


def _source_terms(value: object) -> SourceTerms:
    source = _mapping(value, "source")
    return SourceTerms(
        source_id=_uuid(source.get("id"), "source.id"),
        terms_review_id=_uuid(source.get("termsReviewId"), "source.termsReviewId"),
        current_terms_review_id=_uuid(
            source.get("currentTermsReviewId"), "source.currentTermsReviewId"
        ),
        source_code=_text(source.get("code"), "source.code"),
        source_name=_text(source.get("name"), "source.name"),
        decision=_text(source.get("decision"), "source.decision"),
        active=_bool(source.get("active"), "source.active"),
        commercial_use_allowed=_bool(
            source.get("commercialUseAllowed"), "source.commercialUseAllowed"
        ),
        catalog_metadata_allowed=_bool(
            source.get("catalogMetadataAllowed"), "source.catalogMetadataAllowed"
        ),
        public_raw_display_allowed=_bool(
            source.get("publicRawDisplayAllowed"), "source.publicRawDisplayAllowed"
        ),
        public_derived_display_allowed=_bool(
            source.get("publicDerivedDisplayAllowed"),
            "source.publicDerivedDisplayAllowed",
        ),
        attribution_required=_bool(
            source.get("attributionRequired"), "source.attributionRequired"
        ),
        attribution_text=str(source.get("attributionText") or "").strip(),
        document_hash=_text(source.get("documentHash"), "source.documentHash"),
        reviewed_at=_datetime(source.get("reviewedAt"), "source.reviewedAt"),
        expires_at=_optional_datetime(source.get("expiresAt"), "source.expiresAt"),
    )


def _quality_policy(value: object) -> ObservationQualityPolicy:
    if value is None:
        return ObservationQualityPolicy()
    policy = _mapping(value, "operator.qualityPolicy")
    return ObservationQualityPolicy(
        minimum_history=_integer(
            policy.get("minimumHistory", 7),
            "operator.qualityPolicy.minimumHistory",
            minimum=2,
            maximum=365,
        ),
        max_log_mad_z=_number(
            policy.get("maxLogMadZ", 8),
            "operator.qualityPolicy.maxLogMadZ",
            minimum=0.01,
            maximum=100,
        ),
        zero_mad_max_log_deviation=_number(
            policy.get("zeroMadMaxLogDeviation", 1.0986122886681098),
            "operator.qualityPolicy.zeroMadMaxLogDeviation",
            minimum=0.01,
            maximum=100,
        ),
        history_window_days=_integer(
            policy.get("historyWindowDays", 90),
            "operator.qualityPolicy.historyWindowDays",
            minimum=1,
            maximum=365,
        ),
    )


@dataclass(frozen=True, slots=True)
class CardbaseSeriesRequest:
    mapping: ObservationMapping
    minimum_points: int


@dataclass(frozen=True, slots=True)
class CardbasePrintingRequest:
    scryfall_id: str
    series: tuple[CardbaseSeriesRequest, ...]


def _printing_requests(
    value: object,
    *,
    source_id: str,
    mapping_version: str,
) -> tuple[CardbasePrintingRequest, ...]:
    rows = _sequence(value, "cardbase.printings")
    if not rows or len(rows) > MAX_PRINTINGS_PER_RUN:
        raise ValueError(
            f"cardbase.printings must contain 1 to {MAX_PRINTINGS_PER_RUN} entries"
        )
    requests: list[CardbasePrintingRequest] = []
    seen_printings: set[str] = set()
    seen_mappings: set[str] = set()
    series_count = 0
    for index, raw in enumerate(rows):
        item = _mapping(raw, f"cardbase.printings[{index}]")
        scryfall_id = _uuid(
            item.get("scryfallId"), f"cardbase.printings[{index}].scryfallId"
        )
        if scryfall_id in seen_printings:
            raise ValueError("cardbase.printings contains a duplicate Scryfall printing")
        seen_printings.add(scryfall_id)
        series_rows = _sequence(
            item.get("series"), f"cardbase.printings[{index}].series"
        )
        if not series_rows or len(series_rows) > MAX_PRICE_SERIES:
            raise ValueError(
                f"cardbase.printings[{index}].series must contain 1 to "
                f"{MAX_PRICE_SERIES} entries"
            )
        series_count += len(series_rows)
        if series_count > MAX_SERIES_PER_RUN:
            raise ValueError(
                f"Cardbase cohort cannot exceed {MAX_SERIES_PER_RUN} exact series"
            )
        series_requests: list[CardbaseSeriesRequest] = []
        seen_series: set[str] = set()
        for series_index, raw_series in enumerate(series_rows):
            name = f"cardbase.printings[{index}].series[{series_index}]"
            series = _mapping(raw_series, name)
            external_variant_key = cardbase_series_key(
                series.get("vendor"),
                series.get("finish"),
                series.get("priceType"),
                series.get("currency"),
            )
            if external_variant_key in seen_series:
                raise ValueError(f"{name} duplicates an exact provider series")
            seen_series.add(external_variant_key)
            mapping_id = _uuid(series.get("mappingId"), f"{name}.mappingId")
            if mapping_id in seen_mappings:
                raise ValueError("Cardbase cohort contains a duplicate mappingId")
            seen_mappings.add(mapping_id)
            mapping = ObservationMapping(
                mapping_id=mapping_id,
                source_id=source_id,
                variant_id=_uuid(series.get("variantId"), f"{name}.variantId"),
                external_product_id=scryfall_id,
                external_variant_key=external_variant_key,
                mapping_confidence=_number(
                    series.get("mappingConfidence", 1),
                    f"{name}.mappingConfidence",
                    minimum=0,
                    maximum=1,
                ),
                review_status="approved",
                mapping_version=mapping_version,
                finish=_text(series.get("finish"), f"{name}.finish"),
                condition_class=_text(
                    series.get("conditionClass", "raw"), f"{name}.conditionClass"
                ),
                language=_text(series.get("language", "en"), f"{name}.language"),
                market_condition=_text(
                    series.get("marketCondition", "provider-aggregate"),
                    f"{name}.marketCondition",
                ),
            )
            series_requests.append(CardbaseSeriesRequest(
                mapping=mapping,
                minimum_points=_integer(
                    series.get("minimumPoints", 7),
                    f"{name}.minimumPoints",
                    minimum=1,
                    maximum=AUTHENTICATED_HISTORY_DAYS,
                ),
            ))
        requests.append(CardbasePrintingRequest(
            scryfall_id=scryfall_id,
            series=tuple(series_requests),
        ))
    return tuple(requests)


def build_cardbase_history_import(
    manifest: Mapping[str, object],
    *,
    client: CardbaseClient,
    prior_ledger: CardbaseFirstSeenLedger = CardbaseFirstSeenLedger(),
    clock: Clock = lambda: datetime.now(timezone.utc),
    sleep: Sleep = time.sleep,
) -> tuple[dict[str, object], CardbaseFirstSeenLedger]:
    """Fetch one reviewed cohort and return a replay-safe import plus ledger."""

    if not isinstance(manifest, Mapping):
        raise ValueError("manifest must be an object")
    if manifest.get("mode") != MODE:
        raise PermissionError(f"Cardbase manifest mode must be {MODE!r}")
    if not isinstance(client, CardbaseClient):
        raise ValueError("client must be a CardbaseClient")
    if not isinstance(prior_ledger, CardbaseFirstSeenLedger):
        raise ValueError("prior_ledger must be a CardbaseFirstSeenLedger")
    terms = _source_terms(manifest.get("source"))
    mapping_version = _text(manifest.get("mappingVersion"), "mappingVersion")
    cardbase = _mapping(manifest.get("cardbase"), "cardbase")
    if any(key in cardbase for key in ("apiKeys", "keyRotation", "rotateKeys")):
        raise PermissionError(
            "Cardbase key rotation is prohibited; configure one server-side key"
        )
    history_days = _integer(
        cardbase.get("historyDays", AUTHENTICATED_HISTORY_DAYS),
        "cardbase.historyDays",
        minimum=1,
        maximum=AUTHENTICATED_HISTORY_DAYS,
    )
    if history_days > ANONYMOUS_HISTORY_DAYS and not client.authenticated:
        raise PermissionError(
            "Cardbase history beyond 30 days requires one server-side API key"
        )
    request_interval = _number(
        cardbase.get("requestIntervalSeconds", MIN_REQUEST_INTERVAL_SECONDS),
        "cardbase.requestIntervalSeconds",
        minimum=MIN_REQUEST_INTERVAL_SECONDS,
        maximum=MAX_REQUEST_INTERVAL_SECONDS,
    )
    quality_score = _number(
        cardbase.get("qualityScore", 0.85),
        "cardbase.qualityScore",
        minimum=0,
        maximum=1,
    )
    requests = _printing_requests(
        cardbase.get("printings"),
        source_id=terms.source_id,
        mapping_version=mapping_version,
    )
    operator = _mapping(manifest.get("operator"), "operator")
    mapping_review = _mapping(manifest.get("mappingReview"), "mappingReview")
    if mapping_review.get("decision") != "approved":
        raise PermissionError("Cardbase exact mappings require an approved review")
    if mapping_review.get("scope") != "private_research":
        raise PermissionError("Cardbase mapping approval must remain private-research scoped")
    mapping_review_metadata = {
        "decision": "approved",
        "scope": "private_research",
        "documentHash": _sha256(
            mapping_review.get("documentHash"), "mappingReview.documentHash"
        ),
        "reviewedAt": _datetime(
            mapping_review.get("reviewedAt"), "mappingReview.reviewedAt"
        ).isoformat(),
    }
    metadata = operator.get("metadata", {})
    if not isinstance(metadata, Mapping):
        raise ValueError("operator.metadata must be an object")

    started_at = _clock_utc(clock, "clock")
    assert_cardbase_research_terms(terms, at=started_at)
    if _datetime(
        mapping_review_metadata["reviewedAt"], "mappingReview.reviewedAt"
    ) > started_at:
        raise PermissionError("Cardbase mapping review is not yet effective")
    snapshots: dict[str, CardbaseSnapshot] = {}
    for index, request in enumerate(requests):
        if index:
            sleep(request_interval)
        retrieved_at = _clock_utc(clock, "clock")
        snapshots[request.scryfall_id] = client.prices(
            request.scryfall_id,
            days=history_days,
            retrieved_at=retrieved_at,
        )
    completed_at = _clock_utc(clock, "clock")
    if completed_at < started_at:
        raise ValueError("clock moved backward during Cardbase collection")
    assert_cardbase_research_terms(terms, at=completed_at)

    fresh_records = []
    request_by_key: dict[tuple[str, str], CardbaseSeriesRequest] = {}
    series_metadata: dict[tuple[str, str], tuple[str, str]] = {}
    for request in requests:
        snapshot = snapshots[request.scryfall_id]
        for requested_series in request.series:
            mapping = requested_series.mapping
            series = snapshot.series_for_key(mapping.external_variant_key)
            if mapping.finish != series.finish:
                raise ValueError("Cardbase mapping finish differs from provider series")
            if (
                mapping.condition_class != "raw"
                or mapping.market_condition != "provider-aggregate"
            ):
                raise ValueError(
                    "Cardbase mappings must retain provider-aggregate condition scope"
                )
            if len(series.points) < requested_series.minimum_points:
                raise ValueError(
                    f"Cardbase series {mapping.external_variant_key!r} returned fewer "
                    f"than {requested_series.minimum_points} required points"
                )
            key = (request.scryfall_id, mapping.external_variant_key)
            request_by_key[key] = requested_series
            series_metadata[key] = (series.currency, series.price_semantics)
            fresh_records.extend(snapshot.raw_price_records(
                mapping.external_variant_key,
                available_at=completed_at,
                quality_score=quality_score,
            ))

    prior_record_ids = {item.external_record_id for item in prior_ledger.entries}
    reconciled, updated_ledger = prior_ledger.reconcile(
        fresh_records, first_seen_at=completed_at
    )
    new_records = tuple(
        record for record in reconciled
        if record.external_record_id not in prior_record_ids
    )
    records_by_key: dict[tuple[str, str], list[RawPriceRecord]] = {}
    for record in new_records:
        records_by_key.setdefault(record.external_key, []).append(record)
    history_series: list[HistoricalImportSeries] = []
    for key in sorted(records_by_key):
        requested_series = request_by_key[key]
        currency, price_semantics = series_metadata[key]
        history_series.append(HistoricalImportSeries(
            mapping=requested_series.mapping,
            currency=currency,
            price_semantics=price_semantics,
            records=tuple(records_by_key.get(key, ())),
        ))

    as_of_dates = [snapshot.as_of for snapshot in snapshots.values()]
    history_begins = [snapshot.history_begins for snapshot in snapshots.values()]
    provider_metadata = {
        "apiVersion": "v1",
        "authenticated": client.authenticated,
        "requestedHistoryDays": history_days,
        "printingCount": len(requests),
        "seriesCount": len(history_series),
        "responseObservationCount": len(reconciled),
        "observationCount": len(new_records),
        "asOfFrom": min(as_of_dates).isoformat(),
        "asOfThrough": max(as_of_dates).isoformat(),
        "historyBeginsFrom": min(history_begins).isoformat(),
        "historyBeginsThrough": max(history_begins).isoformat(),
        "firstSeenLedgerSha256": updated_ledger.ledger_sha256,
        "rateLimitStrategy": "single-key-paced-retry-after",
    }
    receipt = {
        **provider_metadata,
        "sourceCode": terms.source_code,
        "termsReviewId": terms.terms_review_id,
        "publicCandidateCount": 0,
        "forecastCount": 0,
    }
    if not history_series:
        return {
            "mode": "private_cardbase_mtg_history_noop",
            "contractVersion": "cardbase-history-noop-v1",
            "generatedAt": completed_at.isoformat(),
            "cardbaseReceipt": {**receipt, "outcome": "no_change"},
            "publicCandidateRows": [],
            "forecastRows": [],
        }, updated_ledger
    config = CentralizedHistoryImportConfig(
        started_at=started_at,
        completed_at=completed_at,
        ingested_at=completed_at,
        mapping_version=mapping_version,
        parser_version=_text(operator.get("parserVersion"), "operator.parserVersion"),
        code_version=_text(operator.get("codeVersion"), "operator.codeVersion"),
        availability_semantics="operator_first_seen",
        operator_label=_text(operator.get("label"), "operator.label"),
        quality_policy=_quality_policy(operator.get("qualityPolicy")),
        metadata={
            **dict(metadata),
            "cardbase": provider_metadata,
            "mappingReview": mapping_review_metadata,
        },
    )
    packet = build_centralized_history_import(
        terms, tuple(history_series), config
    ).as_dict()
    packet["cardbaseReceipt"] = {**receipt, "outcome": "new_history"}
    return packet, updated_ledger


def _load_json(path: str, name: str) -> Mapping[str, object]:
    try:
        value = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"{name} is not readable strict JSON") from exc
    if not isinstance(value, Mapping):
        raise ValueError(f"{name} must contain a JSON object")
    return value


def _write_new(path: str, body: str) -> None:
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        handle.write(body)
        if not body.endswith("\n"):
            handle.write("\n")


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Fetch a bounded Cardbase MTG cohort into a private, replay-safe "
            "centralized-history packet. This command never writes a database."
        )
    )
    parser.add_argument("manifest")
    parser.add_argument("--state", help="prior private first-seen ledger")
    parser.add_argument("--output", required=True, help="new import packet path")
    parser.add_argument("--state-output", required=True, help="new private ledger path")
    parser.add_argument("--sql-output", help="optional rollback-only rehearsal SQL")
    args = parser.parse_args(argv)

    manifest = _load_json(args.manifest, "manifest")
    prior = CardbaseFirstSeenLedger.from_dict(
        _load_json(args.state, "state") if args.state else None
    )
    client = CardbaseClient(os.environ.get("CARDBASE_API_KEY", ""))
    packet, ledger = build_cardbase_history_import(
        manifest, client=client, prior_ledger=prior
    )
    if args.sql_output and "importManifestRow" not in packet:
        raise ValueError("--sql-output is unavailable when Cardbase has no new records")
    _write_new(args.output, json.dumps(
        packet, ensure_ascii=False, sort_keys=True, indent=2, allow_nan=False
    ))
    _write_new(args.state_output, json.dumps(
        ledger.as_dict(), ensure_ascii=False, sort_keys=True, indent=2, allow_nan=False
    ))
    if args.sql_output:
        _write_new(
            args.sql_output,
            build_centralized_history_import_sql(packet, commit=False),
        )
    print(json.dumps({
        "outcome": packet["cardbaseReceipt"]["outcome"],
        "importId": packet.get("importManifestRow", {}).get("id"),
        "cardbaseReceipt": packet["cardbaseReceipt"],
        "stateRecordCount": len(ledger.entries),
    }, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
