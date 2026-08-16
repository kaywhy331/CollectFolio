"""Operator CLI for bounded centralized historical-price import packets."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys
from typing import Mapping, Sequence

from .historical_import import (
    HISTORY_IMPORT_MODE,
    MAX_HISTORY_OBSERVATIONS,
    MAX_HISTORY_SERIES,
    CentralizedHistoryImportConfig,
    HistoricalImportSeries,
    build_centralized_history_import,
)
from .historical_import_sql import build_centralized_history_import_sql
from .market_pipeline import ObservationQualityPolicy, RawPriceRecord
from .operator_cli import (
    _approved_mappings,
    _datetime,
    _mapping,
    _sequence,
    _source_terms,
    _text,
)


def _bounded_sequence(
    value: object,
    name: str,
    *,
    maximum: int,
) -> Sequence[object]:
    rows = _sequence(value, name)
    if not rows or len(rows) > maximum:
        raise ValueError(f"{name} must contain between 1 and {maximum} values")
    return rows


def _number(value: object, name: str, *, minimum: float = 0) -> float:
    if isinstance(value, bool):
        raise ValueError(f"{name} must be numeric")
    try:
        result = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} must be numeric") from exc
    if result <= minimum:
        raise ValueError(f"{name} must be greater than {minimum}")
    return result


def _quality_policy(value: object) -> ObservationQualityPolicy:
    policy = _mapping(value or {}, "historyImport.qualityPolicy")
    return ObservationQualityPolicy(
        minimum_history=int(policy.get("minimumHistory", 7)),
        max_log_mad_z=float(policy.get("maxLogMadZ", 8.0)),
        zero_mad_max_log_deviation=float(
            policy.get("zeroMadMaxLogDeviation", 1.0986122886681098)
        ),
        history_window_days=int(policy.get("historyWindowDays", 90)),
    )


def build_operator_history_import(manifest: Mapping[str, object]) -> Mapping[str, object]:
    """Compile one operator manifest into database-ready immutable rows."""

    root = _mapping(manifest, "manifest")
    if root.get("mode") != HISTORY_IMPORT_MODE:
        raise PermissionError(f"manifest.mode must be {HISTORY_IMPORT_MODE}")
    terms = _source_terms(root.get("source"))
    history = _mapping(root.get("historyImport"), "historyImport")
    mapping_version = _text(
        history.get("mappingVersion"), "historyImport.mappingVersion"
    )
    _, mappings = _approved_mappings(
        root.get("approvedMappings"),
        source_id=terms.source_id,
        mapping_version=mapping_version,
    )
    mapping_by_id = {mapping.mapping_id: mapping for mapping in mappings}
    if len(mapping_by_id) != len(mappings):
        raise ValueError("approvedMappings contains duplicate mapping IDs")

    raw_series = _bounded_sequence(
        history.get("series"), "historyImport.series", maximum=MAX_HISTORY_SERIES
    )
    series: list[HistoricalImportSeries] = []
    total_records = 0
    for series_index, raw_value in enumerate(raw_series):
        name = f"historyImport.series[{series_index}]"
        value = _mapping(raw_value, name)
        mapping_id = _text(value.get("mappingId"), f"{name}.mappingId")
        mapping = mapping_by_id.get(mapping_id)
        if mapping is None:
            raise ValueError(f"{name} references an undeclared approved mapping")
        currency = _text(value.get("currency"), f"{name}.currency")
        semantics = _text(value.get("priceSemantics"), f"{name}.priceSemantics")
        raw_records = _bounded_sequence(
            value.get("records"),
            f"{name}.records",
            maximum=MAX_HISTORY_OBSERVATIONS,
        )
        total_records += len(raw_records)
        if total_records > MAX_HISTORY_OBSERVATIONS:
            raise ValueError(
                f"historyImport exceeds {MAX_HISTORY_OBSERVATIONS} total observations"
            )
        records: list[RawPriceRecord] = []
        for record_index, raw_record in enumerate(raw_records):
            record_name = f"{name}.records[{record_index}]"
            record = _mapping(raw_record, record_name)
            quality = record.get("qualityScore", 1.0)
            if isinstance(quality, bool):
                raise ValueError(f"{record_name}.qualityScore must be numeric")
            records.append(RawPriceRecord(
                external_record_id=_text(
                    record.get("externalRecordId"), f"{record_name}.externalRecordId"
                ),
                external_product_id=mapping.external_product_id,
                external_variant_key=mapping.external_variant_key,
                price_semantics=semantics,
                currency=currency,
                market_price=_number(
                    record.get("marketPrice"), f"{record_name}.marketPrice"
                ),
                observed_at=_datetime(
                    record.get("observedAt"), f"{record_name}.observedAt"
                ),
                available_at=_datetime(
                    record.get("availableAt"), f"{record_name}.availableAt"
                ),
                quality_score=float(quality),
            ))
        series.append(HistoricalImportSeries(
            mapping=mapping,
            currency=currency,
            price_semantics=semantics,
            records=tuple(records),
        ))

    config = CentralizedHistoryImportConfig(
        started_at=_datetime(history.get("startedAt"), "historyImport.startedAt"),
        completed_at=_datetime(
            history.get("completedAt"), "historyImport.completedAt"
        ),
        ingested_at=_datetime(history.get("ingestedAt"), "historyImport.ingestedAt"),
        mapping_version=mapping_version,
        parser_version=_text(
            history.get("parserVersion"), "historyImport.parserVersion"
        ),
        code_version=_text(history.get("codeVersion"), "historyImport.codeVersion"),
        availability_semantics=_text(
            history.get("availabilitySemantics"),
            "historyImport.availabilitySemantics",
        ),
        operator_label=_text(
            history.get("operatorLabel"), "historyImport.operatorLabel"
        ),
        quality_policy=_quality_policy(history.get("qualityPolicy", {})),
        metadata=_mapping(history.get("metadata", {}), "historyImport.metadata"),
    )
    return build_centralized_history_import(terms, series, config).as_dict()


def _read_manifest(path: str) -> Mapping[str, object]:
    body = sys.stdin.read() if path == "-" else Path(path).read_text(encoding="utf-8")
    return _mapping(json.loads(body), "manifest")


def _write_new(path: str, body: str) -> None:
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as output:
        output.write(body)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Compile bounded centralized price history; output is read-only packet JSON "
            "or guarded SQL and never executes against Supabase."
        ),
    )
    parser.add_argument("manifest", help="operator JSON manifest path, or - for stdin")
    parser.add_argument("--sql", action="store_true", help="emit guarded SQL instead of JSON")
    parser.add_argument(
        "--commit",
        action="store_true",
        help="end SQL with COMMIT; without this flag SQL is a rollback rehearsal",
    )
    parser.add_argument("--pretty", action="store_true", help="indent packet JSON")
    parser.add_argument(
        "--output",
        help="write a new mode-0600 file; existing paths are refused",
    )
    args = parser.parse_args(argv)
    if args.commit and not args.sql:
        parser.error("--commit requires --sql")
    if args.pretty and args.sql:
        parser.error("--pretty applies only to packet JSON")
    packet = build_operator_history_import(_read_manifest(args.manifest))
    if args.sql:
        body = build_centralized_history_import_sql(packet, commit=args.commit)
    else:
        body = json.dumps(
            packet,
            ensure_ascii=False,
            indent=2 if args.pretty else None,
            sort_keys=True,
        ) + "\n"
    if args.output:
        _write_new(args.output, body)
    else:
        sys.stdout.write(body)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
