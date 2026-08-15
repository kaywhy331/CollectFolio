"""CLI for building private retrospective evidence from a hosted-row export."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
from hashlib import sha256
import json
import os
from pathlib import Path
import sys
from typing import Mapping, Sequence

from .observations import PriceSeriesKey
from .operator_cli import _source_terms
from .forecasting import PromotionPolicy, REQUIRED_PROMOTION_BASELINES
from .walk_forward import (
    RetrospectiveWalkForwardConfig,
    build_retrospective_walk_forward,
    parse_hosted_observation_rows,
)


MAX_HOSTED_ROWS = 1_000


def _code_artifact_hash() -> str:
    digest = sha256()
    source_root = Path(__file__).resolve().parent
    for path in sorted(source_root.glob("*.py"), key=lambda value: value.name):
        digest.update(path.name.encode("utf-8"))
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def _mapping(value: object, name: str) -> Mapping[str, object]:
    if not isinstance(value, Mapping):
        raise ValueError(f"{name} must be an object")
    return value


def _rows(value: object, name: str) -> list[Mapping[str, object]]:
    if not isinstance(value, list) or any(not isinstance(item, Mapping) for item in value):
        raise ValueError(f"{name} must be an array of objects")
    if not value or len(value) > MAX_HOSTED_ROWS:
        raise ValueError(f"{name} must contain between 1 and {MAX_HOSTED_ROWS} rows")
    return value


def _text(value: object, name: str) -> str:
    text = str(value or "").strip()
    if not text:
        raise ValueError(f"{name} must be non-empty")
    return text


def _datetime(value: str | None) -> datetime:
    if value is None:
        return datetime.now(timezone.utc)
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError("--generated-at must be an ISO-8601 datetime") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError("--generated-at must include a timezone")
    return parsed.astimezone(timezone.utc)


def build_packet_from_exports(
    manifest: Mapping[str, object],
    hosted_export: Mapping[str, object] | list[Mapping[str, object]],
    *,
    generated_at: datetime,
) -> Mapping[str, object]:
    """Validate operator inputs and return a serializable evidence packet."""

    if manifest.get("mode") != "research_only":
        raise PermissionError("operator manifest must remain research_only")
    terms = _source_terms(manifest.get("source"))
    mappings = manifest.get("approvedMappings")
    if not isinstance(mappings, list) or len(mappings) != 1:
        raise ValueError("walk-forward evaluation requires one exact approved mapping")
    mapping = _mapping(mappings[0], "approvedMappings[0]")
    source_id = _text(mapping.get("sourceId", terms.source_id), "mapping source ID")
    if source_id != terms.source_id:
        raise ValueError("approved mapping source does not match source terms")
    key = PriceSeriesKey(
        canonical_variant_id=_text(mapping.get("variantId"), "approvedMappings[0].variantId"),
        source_id=source_id,
        currency=_text(mapping.get("currency", "USD"), "approvedMappings[0].currency"),
        finish=_text(mapping.get("finish"), "approvedMappings[0].finish"),
        condition_class=_text(
            mapping.get("conditionClass"), "approvedMappings[0].conditionClass"
        ),
        price_semantics=_text(
            mapping.get("priceSemantics", "tcgplayer_market"),
            "approvedMappings[0].priceSemantics",
        ),
        language=_text(mapping.get("language", "en"), "approvedMappings[0].language"),
        market_condition=_text(
            mapping.get("marketCondition"),
            "approvedMappings[0].marketCondition",
        ),
    )
    market_series_id = _text(
        mapping.get("marketSeriesId"), "approvedMappings[0].marketSeriesId"
    )
    research = _mapping(manifest.get("retrospectiveResearch"), "retrospectiveResearch")
    model = _mapping(research.get("model"), "retrospectiveResearch.model")
    policy = _mapping(
        research.get("promotionPolicy", {}), "retrospectiveResearch.promotionPolicy"
    )
    horizons = model.get("allowedHorizons")
    if not isinstance(horizons, list):
        raise ValueError("retrospectiveResearch.model.allowedHorizons must be an array")
    config = RetrospectiveWalkForwardConfig(
        model_key=_text(model.get("key"), "retrospectiveResearch.model.key"),
        model_version=_text(model.get("version"), "retrospectiveResearch.model.version"),
        model_family=_text(model.get("family"), "retrospectiveResearch.model.family"),
        allowed_horizons=tuple(int(value) for value in horizons),
        mapping_version=_text(manifest.get("mappingVersion"), "mappingVersion"),
        feature_version=_text(
            research.get("featureVersion"), "retrospectiveResearch.featureVersion"
        ),
        code_version=_text(
            research.get("codeVersion"), "retrospectiveResearch.codeVersion"
        ),
        generated_at=generated_at,
        model_config=_mapping(model.get("config", {}), "retrospectiveResearch.model.config"),
        cohort_key=_text(
            research.get(
                "cohortKey", "tcgcsv_30d_origins_accepted_research_only_v2"
            ),
            "retrospectiveResearch.cohortKey",
        ),
        expected_interval_days=int(research.get("expectedIntervalDays", 7)),
        max_reference_lag_days=float(research.get("maxReferenceLagDays", 7)),
        origin_spacing_days=int(research.get("originSpacingDays", 30)),
        promotion_policy=PromotionPolicy(
            version=_text(
                policy.get("version", "research-promotion-v1"),
                "retrospectiveResearch.promotionPolicy.version",
            ),
            minimum_cases=int(policy.get("minimumCases", 30)),
            minimum_baseline_lift=float(policy.get("minimumBaselineLift", 0.02)),
            interval_80_coverage_min=float(policy.get("interval80CoverageMin", 0.72)),
            interval_80_coverage_max=float(policy.get("interval80CoverageMax", 0.88)),
            maximum_brier_score=float(policy.get("maximumBrierScore", 0.25)),
            required_baselines=tuple(
                str(value) for value in policy.get(
                    "requiredBaselines", REQUIRED_PROMOTION_BASELINES
                )
            ),
        ),
        code_artifact_hash=_code_artifact_hash(),
    )
    if isinstance(hosted_export, Mapping):
        hosted_rows = _rows(hosted_export.get("rows"), "hosted export rows")
    else:
        hosted_rows = _rows(hosted_export, "hosted export rows")
    ledger = parse_hosted_observation_rows(
        hosted_rows, key, market_series_id=market_series_id,
    )
    return build_retrospective_walk_forward(ledger, terms, config).as_dict()


def _read_json(path: str, name: str) -> object:
    try:
        text = sys.stdin.read() if path == "-" else Path(path).read_text(encoding="utf-8")
        return json.loads(text)
    except json.JSONDecodeError as exc:
        raise ValueError(f"{name} must contain valid JSON") from exc


def _write_private_json(path: str, value: Mapping[str, object], *, pretty: bool) -> None:
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as output:
        json.dump(value, output, indent=2 if pretty else None, sort_keys=True)
        output.write("\n")


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Build explicitly retrospective, private-only walk-forward evidence.",
    )
    parser.add_argument("manifest", help="research manifest JSON path")
    parser.add_argument(
        "hosted_export",
        help="bounded hosted observation export JSON path, or - for stdin",
    )
    parser.add_argument("output", help="new mode-0600 packet path; existing files are refused")
    parser.add_argument(
        "--generated-at",
        help="honest generation timestamp; defaults to the current UTC instant",
    )
    parser.add_argument("--pretty", action="store_true", help="indent packet JSON")
    args = parser.parse_args(argv)
    manifest = _mapping(_read_json(args.manifest, "manifest"), "manifest")
    hosted = _read_json(args.hosted_export, "hosted export")
    if not isinstance(hosted, (Mapping, list)):
        raise ValueError("hosted export must be an object or array")
    packet = build_packet_from_exports(
        manifest,
        hosted,
        generated_at=_datetime(args.generated_at),
    )
    _write_private_json(args.output, packet, pretty=args.pretty)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
