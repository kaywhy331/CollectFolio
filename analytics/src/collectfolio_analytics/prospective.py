"""Canonical payload contracts for private prospective forecast execution."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from hashlib import sha256
import hmac
import re
from typing import Mapping, Sequence
from uuid import UUID


SHA256 = re.compile(r"^[0-9a-f]{64}$")
REQUIRED_BASELINES = (
    "no_change",
    "damped_momentum",
    "market_index",
    "lifecycle_cohort",
    "structural_convergence",
)
MANDATORY_REASON_CODES = (
    "operator_model_review_required",
    "private_prospective_shadow",
    "public_forecast_disabled",
)
PREDICTION_NUMBERS = (
    "q10", "q25", "q50", "q75", "q90", "probabilityUp", "confidence",
)
PREDICTION_NUMBER_SPECS = {
    "q10": (16, 4, False),
    "q25": (16, 4, False),
    "q50": (16, 4, False),
    "q75": (16, 4, False),
    "q90": (16, 4, False),
    "probabilityUp": (7, 6, True),
    "confidence": (7, 4, True),
}
COST_NUMBERS = (
    "offerPrice", "taxRate", "buyShipping", "sellFeeRate",
    "sellFeeFixed", "sellShipping",
)
COST_NUMBER_SPECS = {
    "offerPrice": (16, 4, False),
    "taxRate": (9, 8, True),
    "buyShipping": (16, 4, True),
    "sellFeeRate": (9, 8, True),
    "sellFeeFixed": (16, 4, True),
    "sellShipping": (16, 4, True),
    "liquidityHaircutRate": (9, 8, True),
}

CANONICAL_PROMOTION_POLICY: Mapping[str, object] = {
    "version": "forecast-ensemble-promotion-v1",
    "minimumCases": 200,
    "minimumBaselineLift": 0.02,
    "interval80CoverageMin": 0.72,
    "interval80CoverageMax": 0.88,
    "maximumBrierScore": 0.25,
    "requiredBaselines": list(REQUIRED_BASELINES),
}


def _text(value: object, name: str) -> str:
    text = str(value or "").strip()
    if not text:
        raise ValueError(f"{name} must be non-empty")
    return text


def _uuid(value: object, name: str) -> str:
    try:
        return str(UUID(_text(value, name)))
    except (ValueError, AttributeError) as exc:
        raise ValueError(f"{name} must be a UUID") from exc


def _digest(value: str) -> str:
    return sha256(value.encode("utf-8")).hexdigest()


def canonical_decimal(
    value: object,
    name: str,
    *,
    allow_zero: bool = True,
    precision: int | None = None,
    scale: int | None = None,
) -> str:
    """Return a plain finite decimal string accepted verbatim by migration 0018."""

    if isinstance(value, bool):
        raise ValueError(f"{name} must be a finite decimal")
    try:
        decimal = Decimal(str(value))
    except (InvalidOperation, ValueError) as exc:
        raise ValueError(f"{name} must be a finite decimal") from exc
    if not decimal.is_finite() or decimal < 0 or (not allow_zero and decimal == 0):
        qualifier = "positive" if not allow_zero else "non-negative"
        raise ValueError(f"{name} must be finite and {qualifier}")
    if (precision is None) is not (scale is None):
        raise ValueError("precision and scale must be declared together")
    if precision is not None and scale is not None:
        quantum = Decimal(1).scaleb(-scale)
        try:
            stored = decimal.quantize(quantum)
        except InvalidOperation as exc:
            raise ValueError(f"{name} exceeds numeric({precision},{scale})") from exc
        if stored != decimal:
            raise ValueError(f"{name} has more than {scale} decimal places")
        if decimal >= Decimal(10) ** (precision - scale):
            raise ValueError(f"{name} exceeds numeric({precision},{scale})")
    if decimal == 0:
        return "0"
    rendered = format(decimal, "f")
    if "." in rendered:
        rendered = rendered.rstrip("0").rstrip(".")
    return rendered or "0"


def _canonical_timestamp_value(value: object, name: str) -> str:
    if isinstance(value, datetime):
        parsed = value
    else:
        raw = str(value if value is not None else "").strip()
        if not raw:
            raise ValueError(f"{name} must be a timezone-aware timestamp")
        try:
            parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        except ValueError as exc:
            raise ValueError(f"{name} must be a timezone-aware timestamp") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError(f"{name} must be timezone-aware")
    return parsed.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def _optional_uuid(value: object, name: str) -> str:
    return "" if value is None or str(value).strip() == "" else _uuid(value, name)


def _optional_timestamp(value: object, name: str) -> str:
    return "" if value is None or str(value).strip() == "" else _canonical_timestamp_value(value, name)


def _optional_number(
    value: object,
    name: str,
    spec: tuple[int, int, bool],
) -> str:
    if value is None or str(value).strip() == "":
        return ""
    precision, scale, allow_zero = spec
    return canonical_decimal(
        value, name, allow_zero=allow_zero, precision=precision, scale=scale,
    )


def _raw(value: object) -> str:
    return "" if value is None else str(value)


def canonical_cost_quote_hash(quote: Mapping[str, object]) -> str:
    """Mirror ``canonical_prospective_cost_quote_hash`` exactly."""

    if not isinstance(quote, Mapping):
        raise ValueError("costQuote must be an object")
    values = (
        _raw(quote.get("status")),
        _raw(quote.get("semantics")),
        _optional_uuid(quote.get("quoteMarketSeriesId"), "quoteMarketSeriesId"),
        _optional_uuid(quote.get("termsReviewId"), "termsReviewId"),
        _digest(_raw(quote.get("externalQuoteId"))),
        _optional_timestamp(quote.get("observedAt"), "observedAt"),
        _raw(quote.get("evidenceHash")),
        _optional_number(quote.get("offerPrice"), "offerPrice", COST_NUMBER_SPECS["offerPrice"]),
        _optional_number(quote.get("taxRate"), "taxRate", COST_NUMBER_SPECS["taxRate"]),
        _optional_number(quote.get("buyShipping"), "buyShipping", COST_NUMBER_SPECS["buyShipping"]),
        _optional_number(quote.get("sellFeeRate"), "sellFeeRate", COST_NUMBER_SPECS["sellFeeRate"]),
        _optional_number(quote.get("sellFeeFixed"), "sellFeeFixed", COST_NUMBER_SPECS["sellFeeFixed"]),
        _optional_number(quote.get("sellShipping"), "sellShipping", COST_NUMBER_SPECS["sellShipping"]),
        (
            "unavailable"
            if quote.get("status") == "unavailable"
            else _raw(quote.get("liquidityStatus"))
        ),
        _optional_number(
            quote.get("liquidityHaircutRate"),
            "liquidityHaircutRate",
            COST_NUMBER_SPECS["liquidityHaircutRate"],
        ),
        _raw(quote.get("liquidityEvidenceHash")),
        _digest(_raw(quote.get("unavailableReason")).strip()),
    )
    return _digest("\x1f".join(values))


def prepare_prospective_candidate(
    core: Mapping[str, object],
    *,
    market_series_identity_hash: str,
    baseline_prices: Mapping[str, object],
    probability_net_positive: object | None,
    structural_lower_price: object | None,
) -> dict[str, object]:
    """Normalize one executor output into the strict challenged-RPC payload."""

    if not isinstance(core, Mapping):
        raise ValueError("core candidate must be an object")
    identity_hash = _text(market_series_identity_hash, "market_series_identity_hash").lower()
    if not SHA256.fullmatch(identity_hash):
        raise ValueError("market_series_identity_hash must be a SHA-256 digest")
    if set(baseline_prices) != set(REQUIRED_BASELINES):
        raise ValueError("baseline_prices must contain exactly the five required baselines")
    candidate = dict(core)
    _uuid(candidate.get("trendSnapshotId"), "trendSnapshotId")
    for field in PREDICTION_NUMBERS:
        precision, scale, allow_zero = PREDICTION_NUMBER_SPECS[field]
        candidate[field] = canonical_decimal(
            candidate.get(field), field, allow_zero=allow_zero,
            precision=precision, scale=scale,
        )
    reasons = candidate.get("reasonCodes")
    if not isinstance(reasons, Sequence) or isinstance(reasons, (str, bytes)):
        raise ValueError("reasonCodes must be an array")
    supplied_reasons = tuple(_text(reason, "reasonCode") for reason in reasons)
    if len(set(supplied_reasons)) != len(supplied_reasons):
        raise ValueError("reasonCodes must be unique")
    normalized_reasons = tuple(sorted(set(supplied_reasons) | set(MANDATORY_REASON_CODES)))
    candidate["reasonCodes"] = list(normalized_reasons)
    quote = candidate.get("costQuote")
    if not isinstance(quote, Mapping):
        raise ValueError("costQuote must be an object")
    normalized_quote = dict(quote)
    if normalized_quote.get("status") == "complete":
        normalized_quote["observedAt"] = _canonical_timestamp_value(
            normalized_quote.get("observedAt"), "costQuote.observedAt",
        )
        for field in ("quoteMarketSeriesId", "termsReviewId"):
            if normalized_quote.get(field) is not None:
                normalized_quote[field] = _uuid(
                    normalized_quote[field], f"costQuote.{field}",
                )
        for field in COST_NUMBERS:
            precision, scale, allow_zero = COST_NUMBER_SPECS[field]
            normalized_quote[field] = canonical_decimal(
                normalized_quote.get(field), f"costQuote.{field}",
                allow_zero=allow_zero, precision=precision, scale=scale,
            )
        if normalized_quote.get("liquidityHaircutRate") is not None:
            precision, scale, allow_zero = COST_NUMBER_SPECS["liquidityHaircutRate"]
            normalized_quote["liquidityHaircutRate"] = canonical_decimal(
                normalized_quote["liquidityHaircutRate"],
                "costQuote.liquidityHaircutRate", allow_zero=allow_zero,
                precision=precision, scale=scale,
            )
    elif normalized_quote.get("status") == "unavailable":
        normalized_quote["unavailableReason"] = _text(
            normalized_quote.get("unavailableReason"),
            "costQuote.unavailableReason",
        )
    candidate["costQuote"] = normalized_quote
    candidate["costQuoteHash"] = canonical_cost_quote_hash(normalized_quote)
    candidate["marketSeriesIdentityHash"] = identity_hash
    candidate["baselinePrices"] = {
        name: canonical_decimal(
            baseline_prices[name], f"baselinePrices.{name}", allow_zero=False,
            precision=16, scale=4,
        )
        for name in REQUIRED_BASELINES
    }
    candidate["probabilityNetPositive"] = None if probability_net_positive is None else canonical_decimal(
        probability_net_positive, "probabilityNetPositive",
        precision=7, scale=6,
    )
    candidate["structuralLowerPrice"] = None if structural_lower_price is None else canonical_decimal(
        structural_lower_price, "structuralLowerPrice", allow_zero=False,
        precision=16, scale=4,
    )
    return candidate


def canonical_candidate_output_hash(candidates: Sequence[Mapping[str, object]]) -> str:
    """Mirror the database's order-independent canonical executor-output hash."""

    if not candidates:
        raise ValueError("at least one candidate is required")
    encoded: list[tuple[str, int, str]] = []
    seen: set[str] = set()
    for index, candidate in enumerate(candidates):
        if not isinstance(candidate, Mapping):
            raise ValueError(f"candidates[{index}] must be an object")
        identity_hash = _text(
            candidate.get("marketSeriesIdentityHash"),
            f"candidates[{index}].marketSeriesIdentityHash",
        ).lower()
        if not SHA256.fullmatch(identity_hash):
            raise ValueError("marketSeriesIdentityHash must be a SHA-256 digest")
        snapshot = _uuid(candidate.get("trendSnapshotId"), "trendSnapshotId")
        if snapshot in seen:
            raise ValueError("candidate trend snapshots must be unique")
        seen.add(snapshot)
        baselines = candidate.get("baselinePrices")
        if not isinstance(baselines, Mapping) or set(baselines) != set(REQUIRED_BASELINES):
            raise ValueError("candidate baselinePrices are incomplete")
        quote = candidate.get("costQuote")
        declared_quote_hash = _text(candidate.get("costQuoteHash"), "costQuoteHash").lower()
        if not SHA256.fullmatch(declared_quote_hash) or declared_quote_hash != canonical_cost_quote_hash(quote):
            raise ValueError("costQuoteHash differs from the canonical cost quote")
        reasons = candidate.get("reasonCodes")
        if not isinstance(reasons, Sequence) or isinstance(reasons, (str, bytes)):
            raise ValueError("reasonCodes must be an array")
        reason_values = [_text(reason, "reasonCode") for reason in reasons]
        if len(set(reason_values)) != len(reason_values):
            raise ValueError("reasonCodes must be unique")
        reason_hash = _digest("\x1e".join(sorted(reason_values)))
        fields = (
            identity_hash,
            snapshot,
            *(
                canonical_decimal(
                    candidate.get(field), field,
                    allow_zero=PREDICTION_NUMBER_SPECS[field][2],
                    precision=PREDICTION_NUMBER_SPECS[field][0],
                    scale=PREDICTION_NUMBER_SPECS[field][1],
                )
                for field in PREDICTION_NUMBERS
            ),
            _text(candidate.get("predictionStatus"), "predictionStatus"),
            reason_hash,
            declared_quote_hash,
            *(
                canonical_decimal(
                    baselines.get(name), f"baselinePrices.{name}",
                    allow_zero=False, precision=16, scale=4,
                )
                for name in REQUIRED_BASELINES
            ),
            "null" if candidate.get("probabilityNetPositive") is None
            else canonical_decimal(
                candidate.get("probabilityNetPositive"), "probabilityNetPositive",
                precision=7, scale=6,
            ),
            "null" if candidate.get("structuralLowerPrice") is None
            else canonical_decimal(
                candidate.get("structuralLowerPrice"), "structuralLowerPrice",
                allow_zero=False, precision=16, scale=4,
            ),
        )
        encoded.append((identity_hash, UUID(snapshot).int, "\x1f".join(fields)))
    encoded.sort(key=lambda item: (item[0], item[1]))
    return _digest("\x1d".join(item[2] for item in encoded))


def _timestamp(value: datetime, name: str) -> str:
    if not isinstance(value, datetime):
        raise ValueError(f"{name} must be a datetime")
    return _canonical_timestamp_value(value, name)


def build_execution_challenge_request(
    scorecard_plan_id: object,
    forecast_analytics_run_id: object,
    trend_analytics_run_id: object,
) -> dict[str, str]:
    return {
        "scorecardPlanId": _uuid(scorecard_plan_id, "scorecard_plan_id"),
        "forecastAnalyticsRunId": _uuid(forecast_analytics_run_id, "forecast_analytics_run_id"),
        "trendAnalyticsRunId": _uuid(trend_analytics_run_id, "trend_analytics_run_id"),
    }


def build_scorecard_request(
    scorecard_plan_id: object,
    evaluation_analytics_run_id: object,
) -> dict[str, str]:
    return {
        "scorecardPlanId": _uuid(scorecard_plan_id, "scorecard_plan_id"),
        "evaluationAnalyticsRunId": _uuid(
            evaluation_analytics_run_id, "evaluation_analytics_run_id",
        ),
    }


def sign_execution_receipt(
    secret: bytes,
    challenge: Mapping[str, object],
    candidates: Sequence[Mapping[str, object]],
    *,
    execution_started_at: datetime,
    execution_completed_at: datetime,
) -> tuple[dict[str, str], str]:
    """Build the exact HMAC request consumed by the challenged recording RPC."""

    if not isinstance(secret, bytes) or len(secret) < 32:
        raise ValueError("executor HMAC secret must contain at least 32 bytes")
    required_hashes = (
        "challengeHash", "expectedInputHash", "modelArtifactHash",
        "executorBuildHash", "runtimeHash",
    )
    values: dict[str, str] = {}
    for field in required_hashes:
        value = _text(challenge.get(field), field).lower()
        if not SHA256.fullmatch(value):
            raise ValueError(f"{field} must be a SHA-256 digest")
        values[field] = value
    nonce = _text(challenge.get("nonce"), "nonce").lower()
    if not re.fullmatch(r"[0-9a-f]{64}", nonce):
        raise ValueError("nonce must be a 32-byte hexadecimal value")
    try:
        input_count = int(challenge.get("expectedInputCount"))
    except (TypeError, ValueError) as exc:
        raise ValueError("expectedInputCount must be positive") from exc
    if input_count < 1 or input_count != len(candidates):
        raise ValueError("expectedInputCount differs from candidate count")
    started = _timestamp(execution_started_at, "execution_started_at")
    completed = _timestamp(execution_completed_at, "execution_completed_at")
    if execution_completed_at < execution_started_at:
        raise ValueError("execution completion cannot predate its start")
    output_hash = canonical_candidate_output_hash(candidates)
    message = "|".join((
        values["challengeHash"], nonce, values["expectedInputHash"],
        output_hash, str(input_count), values["modelArtifactHash"],
        values["executorBuildHash"], values["runtimeHash"], started, completed,
    ))
    signature = hmac.new(secret, message.encode("utf-8"), sha256).hexdigest()
    return ({
        "challengeId": _uuid(challenge.get("challengeId"), "challengeId"),
        "executionStartedAt": started,
        "executionCompletedAt": completed,
        "signature": signature,
    }, output_hash)


def build_scorecard_plan_request(
    *,
    model_version_id: object,
    executor_key_id: object,
    horizon_days: int,
    source_id: object,
    universe_purpose: str,
    origin_schedule: Sequence[datetime],
    selection_policy: Mapping[str, object],
    cohort_key: str = "pokemon-en-raw-nm",
) -> dict[str, object]:
    if horizon_days not in (30, 90):
        raise ValueError("horizon_days must be 30 or 90")
    if universe_purpose not in {"forecast_validation", "after_cost_opportunity"}:
        raise ValueError("universe_purpose is unsupported")
    if not isinstance(selection_policy, Mapping):
        raise ValueError("selection_policy must be an object")
    if isinstance(origin_schedule, (str, bytes)) or len(origin_schedule) < 6:
        raise ValueError("origin_schedule must contain at least six dates")
    if len(origin_schedule) > 18:
        raise ValueError("origin_schedule cannot contain more than eighteen dates")
    schedule_values = tuple(origin_schedule)
    for index, value in enumerate(schedule_values):
        _timestamp(value, f"origin_schedule[{index}]")
    for previous, current in zip(schedule_values, schedule_values[1:]):
        if current <= previous or current - previous < timedelta(days=22):
            raise ValueError(
                "origin_schedule must leave 21 full days between 24-hour windows"
            )
    origin_start = schedule_values[0]
    origin_end = schedule_values[-1] + timedelta(hours=24)
    if origin_end > origin_start + timedelta(days=365):
        raise ValueError("origin_schedule must fit inside a 365-day evidence window")
    return {
        "modelVersionId": _uuid(model_version_id, "model_version_id"),
        "executorKeyId": _uuid(executor_key_id, "executor_key_id"),
        "horizonDays": horizon_days,
        "cohortKey": _text(cohort_key, "cohort_key"),
        "sourceId": _uuid(source_id, "source_id"),
        "universePurpose": universe_purpose,
        "originStart": _timestamp(origin_start, "origin_start"),
        "originEnd": _timestamp(origin_end, "origin_end"),
        "originSchedule": [
            _timestamp(value, f"origin_schedule[{index}]")
            for index, value in enumerate(schedule_values)
        ],
        "selectionPolicy": dict(selection_policy),
        "promotionPolicy": dict(CANONICAL_PROMOTION_POLICY),
    }
