"""Bounded CLI for compiling hosted observation exports into Forecast Lab input."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
from hashlib import sha256
import json
import os
from pathlib import Path
import sys
from typing import Mapping, Sequence
from uuid import UUID

from .forecast_dataset import (
    ForecastDatasetConfig,
    ForecastPanelSeries,
    compile_forecast_dataset,
)
from .forecast_lab_cli import _engine_policy, _evaluation_policy
from .observations import PriceSeriesKey, normalize_market_identity
from .operator_cli import _source_terms
from .walk_forward import parse_hosted_observation_rows


MAX_SERIES = 500
MAX_HOSTED_ROWS = 100_000
MAX_ORIGINS = 64
MAX_COMPILED_CELLS = 5_000


def _mapping(value: object, name: str) -> Mapping[str, object]:
    if not isinstance(value, Mapping):
        raise ValueError(f"{name} must be an object")
    return value


def _array(
    value: object,
    name: str,
    *,
    maximum: int,
) -> list[object]:
    if not isinstance(value, list) or not value or len(value) > maximum:
        raise ValueError(f"{name} must contain between 1 and {maximum} values")
    return value


def _text(value: object, name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{name} must be non-empty")
    return value.strip()


def _uuid(value: object, name: str) -> str:
    try:
        return str(UUID(str(value)))
    except (TypeError, ValueError, AttributeError) as exc:
        raise ValueError(f"{name} must be a UUID") from exc


def _digest(value: object, name: str) -> str:
    result = _text(value, name).lower()
    if len(result) != 64 or any(character not in "0123456789abcdef" for character in result):
        raise ValueError(f"{name} must be a SHA-256 digest")
    return result


def _datetime(value: object, name: str) -> datetime:
    if not isinstance(value, str):
        raise ValueError(f"{name} must be an ISO-8601 datetime")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(f"{name} must be an ISO-8601 datetime") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError(f"{name} must include a timezone")
    return parsed.astimezone(timezone.utc)


def _code_artifact_hash() -> str:
    digest = sha256()
    source_root = Path(__file__).resolve().parent
    for path in sorted(source_root.glob("*.py"), key=lambda item: item.name):
        digest.update(path.name.encode("utf-8"))
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def _series_key(value: Mapping[str, object], name: str) -> PriceSeriesKey:
    series = _mapping(value.get("series"), f"{name}.series")
    return PriceSeriesKey(
        canonical_variant_id=_text(value.get("variantId"), f"{name}.variantId"),
        source_id=_text(series.get("sourceId"), f"{name}.series.sourceId"),
        currency=_text(series.get("currency"), f"{name}.series.currency"),
        language=_text(series.get("language"), f"{name}.series.language"),
        finish=_text(series.get("finish"), f"{name}.series.finish"),
        condition_class=_text(
            series.get("conditionClass"), f"{name}.series.conditionClass",
        ),
        market_condition=_text(
            series.get("marketCondition"), f"{name}.series.marketCondition",
        ),
        price_semantics=_text(
            series.get("priceSemantics"), f"{name}.series.priceSemantics",
        ),
    )


def _hosted_row_key(value: Mapping[str, object], name: str) -> PriceSeriesKey:
    return PriceSeriesKey(
        canonical_variant_id=_text(value.get("variant_id"), f"{name}.variant_id"),
        source_id=_text(value.get("source_id"), f"{name}.source_id"),
        currency=_text(value.get("currency"), f"{name}.currency"),
        language=_text(value.get("language"), f"{name}.language"),
        finish=_text(value.get("finish"), f"{name}.finish"),
        condition_class=_text(
            value.get("condition_class"), f"{name}.condition_class",
        ),
        market_condition=_text(
            value.get("market_condition"), f"{name}.market_condition",
        ),
        price_semantics=_text(
            value.get("price_semantics"), f"{name}.price_semantics",
        ),
    )


def build_manifest_from_exports(
    operator_manifest: Mapping[str, object],
    hosted_export: Mapping[str, object] | list[Mapping[str, object]],
    *,
    generated_at: datetime,
) -> Mapping[str, object]:
    """Validate a joined hosted export and compile private Forecast v2 input."""

    if operator_manifest.get("mode") != "research_only":
        raise PermissionError("forecast dataset manifest must remain research_only")
    terms = _source_terms(operator_manifest.get("source"))
    source = _mapping(operator_manifest.get("forecastDataset"), "forecastDataset")
    mapping_version = _text(
        source.get("mappingVersion"), "forecastDataset.mappingVersion",
    )
    engine_policy = _mapping(
        source.get("enginePolicy", {}), "forecastDataset.enginePolicy",
    )
    evaluation_policy = _mapping(
        source.get("evaluationPolicy", {}), "forecastDataset.evaluationPolicy",
    )
    _engine_policy(engine_policy)
    _evaluation_policy(evaluation_policy)
    raw_specs = _array(source.get("series"), "forecastDataset.series", maximum=MAX_SERIES)
    specs: dict[str, tuple[PriceSeriesKey, Mapping[str, object]]] = {}
    for index, raw in enumerate(raw_specs):
        name = f"forecastDataset.series[{index}]"
        value = _mapping(raw, name)
        market_series_id = _uuid(value.get("marketSeriesId"), f"{name}.marketSeriesId")
        if market_series_id in specs:
            raise ValueError("forecastDataset.series contains duplicate marketSeriesId values")
        _digest(value.get("identityHash"), f"{name}.identityHash")
        _uuid(value.get("setId"), f"{name}.setId")
        normalize_market_identity(_text(value.get("game"), f"{name}.game"))
        specs[market_series_id] = (_series_key(value, name), value)

    raw_rows: object = (
        hosted_export.get("rows") if isinstance(hosted_export, Mapping) else hosted_export
    )
    rows = _array(raw_rows, "hosted export rows", maximum=MAX_HOSTED_ROWS)
    grouped: dict[str, list[Mapping[str, object]]] = {value: [] for value in specs}
    for index, raw in enumerate(rows):
        name = f"hosted export rows[{index}]"
        row = _mapping(raw, name)
        market_series_id = _uuid(row.get("market_series_id"), f"{name}.market_series_id")
        if market_series_id not in specs:
            raise ValueError("hosted export contains an undeclared market-series ID")
        expected_key = specs[market_series_id][0]
        if _hosted_row_key(row, name) != expected_key:
            raise ValueError(f"{name} differs from its exact market-series identity")
        declared_identity_hash = _digest(
            specs[market_series_id][1].get("identityHash"),
            "forecastDataset.series[].identityHash",
        )
        if _digest(row.get("identity_hash"), f"{name}.identity_hash") != declared_identity_hash:
            raise ValueError(f"{name} differs from its market-series identity hash")
        if _text(row.get("mapping_version"), f"{name}.mapping_version") != mapping_version:
            raise ValueError(f"{name} differs from the declared mapping version")
        declared_set_id = _uuid(
            specs[market_series_id][1].get("setId"),
            "forecastDataset.series[].setId",
        )
        if _uuid(row.get("set_id"), f"{name}.set_id") != declared_set_id:
            raise ValueError(f"{name} differs from its canonical catalog set")
        declared_game = normalize_market_identity(_text(
            specs[market_series_id][1].get("game"),
            "forecastDataset.series[].game",
        ))
        if normalize_market_identity(_text(row.get("game"), f"{name}.game")) != declared_game:
            raise ValueError(f"{name} differs from its canonical catalog game")
        grouped[market_series_id].append(row)

    panels: list[ForecastPanelSeries] = []
    for market_series_id, (key, raw_spec) in specs.items():
        if not grouped[market_series_id]:
            raise ValueError("every declared market series requires hosted observations")
        panels.append(ForecastPanelSeries(
            key=key,
            market_series_id=market_series_id,
            market_series_identity_hash=_digest(
                raw_spec.get("identityHash"), "forecastDataset.series[].identityHash",
            ),
            set_id=_uuid(raw_spec.get("setId"), "forecastDataset.series[].setId"),
            game=normalize_market_identity(_text(
                raw_spec.get("game"), "forecastDataset.series[].game",
            )),
            observations=parse_hosted_observation_rows(
                grouped[market_series_id], key, market_series_id=market_series_id,
            ),
        ))

    raw_origins = _array(
        source.get("origins"), "forecastDataset.origins", maximum=MAX_ORIGINS,
    )
    raw_horizons = _array(
        source.get("horizons", [30, 90]), "forecastDataset.horizons", maximum=2,
    )
    if len(panels) * len(raw_origins) * len(raw_horizons) > MAX_COMPILED_CELLS:
        raise ValueError("forecast dataset exceeds the compiled-cell safety limit")
    config = ForecastDatasetConfig(
        generated_at=generated_at,
        origins=tuple(
            _datetime(value, f"forecastDataset.origins[{index}]")
            for index, value in enumerate(raw_origins)
        ),
        horizons=tuple(raw_horizons),
        mapping_version=mapping_version,
        code_version=_text(source.get("codeVersion"), "forecastDataset.codeVersion"),
        expected_interval_days=source.get("expectedIntervalDays", 1),
        max_reference_lag_days=source.get("maxReferenceLagDays", 3),
        engine_policy=engine_policy,
        evaluation_policy=evaluation_policy,
        code_artifact_hash=_code_artifact_hash(),
    )
    return compile_forecast_dataset(panels, terms, config)


def _read_json(path: str, name: str) -> object:
    try:
        body = sys.stdin.read() if path == "-" else Path(path).read_text(encoding="utf-8")
        return json.loads(body)
    except json.JSONDecodeError as exc:
        raise ValueError(f"{name} must contain valid JSON") from exc


def _write_private_json(path: str, value: Mapping[str, object], *, pretty: bool) -> None:
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as output:
        json.dump(value, output, indent=2 if pretty else None, sort_keys=True)
        output.write("\n")


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Compile exact hosted observations into private Forecast v2 input.",
    )
    parser.add_argument("manifest", help="research panel manifest JSON path")
    parser.add_argument(
        "hosted_export", help="bounded joined hosted observation export, or - for stdin",
    )
    parser.add_argument("output", help="new mode-0600 manifest path; existing files are refused")
    parser.add_argument("--generated-at", help="honest ISO-8601 generation timestamp")
    parser.add_argument("--pretty", action="store_true", help="indent output JSON")
    args = parser.parse_args(argv)
    if args.manifest == "-" and args.hosted_export == "-":
        raise ValueError("only one input may read from stdin")
    generated = (
        datetime.now(timezone.utc)
        if args.generated_at is None
        else _datetime(args.generated_at, "--generated-at")
    )
    manifest = _mapping(_read_json(args.manifest, "manifest"), "manifest")
    hosted = _read_json(args.hosted_export, "hosted export")
    if not isinstance(hosted, (Mapping, list)):
        raise ValueError("hosted export must be an object or array")
    compiled = build_manifest_from_exports(
        manifest, hosted, generated_at=generated,
    )
    _write_private_json(args.output, compiled, pretty=args.pretty)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
