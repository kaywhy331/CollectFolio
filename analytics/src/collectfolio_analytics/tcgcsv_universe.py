"""Private full-market TCGCSV normalization and shadow feature compilation.

The module is provider-native by design.  It does not create canonical card
mappings, publish prices, or make research estimates browser-readable.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_EVEN
import csv
from hashlib import sha256
import json
from math import exp, isfinite, log, sqrt, tanh
from pathlib import Path
from statistics import NormalDist
from typing import Iterable, Iterator, Mapping, Sequence


UNIVERSE_CONTRACT_VERSION = "tcgcsv-market-universe-v1"
CATALOG_SNAPSHOT_CONTRACT_VERSION = "tcgcsv-catalog-snapshot-v1"
UNIVERSE_PARSER_VERSION = "tcgcsv-universe-parser-v1"
SHADOW_FORECAST_MODEL = "tcgcsv-damped-momentum-shadow-v1"
FORECAST_HORIZONS = (30, 90, 180, 365)
MAX_ARCHIVE_MEMBER_BYTES = 32 * 1024 * 1024
PRICE_QUANTUM = Decimal("0.0001")
AUDIT_CYCLE_DAYS = 7
CARD_CATEGORY_EXCEPTIONS = frozenset({59, 60, 72, 73})

PRICE_COLUMNS = (
    "archive_date", "source_available_at", "category_id", "group_id",
    "product_id", "subtype_name", "series_sha256", "low_price",
    "mid_price", "high_price", "market_price", "direct_low_price",
    "price_tuple_sha256",
)

FEATURE_COLUMNS = (
    "category_id", "group_id", "product_id", "subtype_name",
    "series_sha256", "current_price", "return_7d", "return_30d",
    "return_90d", "return_180d", "return_365d",
    "daily_log_slope_30d", "volatility_30d", "max_drawdown_365d",
    "history_density_365d", "trend_status", "trend_confidence",
    "opportunity_score", "opportunity_status", "forecast_estimates",
    "forecast_model_key", "estimate_status", "feature_sha256",
)

SET_FEATURE_COLUMNS = (
    "category_id", "group_id", "series_count", "priced_series_count",
    "median_return_30d", "breadth_30d", "median_volatility_30d",
    "hotness_score", "feature_status", "feature_sha256",
)


class TCGCSVUniverseError(ValueError):
    """Raised when provider-wide input cannot satisfy the private contract."""


def canonical_json(value: object) -> str:
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":"),
        allow_nan=False,
    )


def content_hash(value: object) -> str:
    return sha256(canonical_json(value).encode("utf-8")).hexdigest()


def file_sha256(path: Path) -> str:
    digest = sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _utc(value: object, name: str) -> datetime:
    if isinstance(value, str):
        normalized = value.strip()
        normalized = normalized[:-1] + "+00:00" if normalized.endswith("Z") else normalized
        try:
            value = datetime.fromisoformat(normalized)
        except ValueError as exc:
            raise TCGCSVUniverseError(f"{name} must be a timezone-aware datetime") from exc
    if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() is None:
        raise TCGCSVUniverseError(f"{name} must be a timezone-aware datetime")
    return value.astimezone(timezone.utc)


def _text(value: object, name: str, maximum: int, *, required: bool = False) -> str:
    result = str(value or "").strip()
    if required and not result:
        raise TCGCSVUniverseError(f"{name} is required")
    if len(result) > maximum:
        raise TCGCSVUniverseError(f"{name} exceeds {maximum} characters")
    return result


def _positive_int(value: object, name: str) -> int:
    if isinstance(value, bool):
        raise TCGCSVUniverseError(f"{name} must be a positive integer")
    try:
        result = int(value)
    except (TypeError, ValueError) as exc:
        raise TCGCSVUniverseError(f"{name} must be a positive integer") from exc
    if result <= 0:
        raise TCGCSVUniverseError(f"{name} must be a positive integer")
    return result


def _price(value: object, name: str) -> Decimal | None:
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        raise TCGCSVUniverseError(f"{name} must be numeric or null")
    try:
        result = Decimal(str(value))
    except (InvalidOperation, ValueError) as exc:
        raise TCGCSVUniverseError(f"{name} must be numeric or null") from exc
    if not result.is_finite() or result < 0:
        raise TCGCSVUniverseError(f"{name} must be finite and non-negative")
    return result.quantize(PRICE_QUANTUM, rounding=ROUND_HALF_EVEN)


def _decimal_text(value: Decimal | None) -> str:
    return "" if value is None else format(value, "f")


def _result_array(payload: object, label: str) -> tuple[Mapping[str, object], ...]:
    if not isinstance(payload, Mapping) or payload.get("success") is not True:
        raise TCGCSVUniverseError(f"{label} response was not successful")
    results = payload.get("results")
    if not isinstance(results, list) or any(not isinstance(item, Mapping) for item in results):
        raise TCGCSVUniverseError(f"{label} results must be an array of objects")
    return tuple(results)


def _extended_value(product: Mapping[str, object], *names: str) -> str:
    extended = product.get("extendedData", [])
    if not isinstance(extended, list):
        raise TCGCSVUniverseError("product extendedData must be an array")
    wanted = {name.casefold() for name in names}
    for item in extended:
        if isinstance(item, Mapping) and str(item.get("name", "")).casefold() in wanted:
            return str(item.get("value", "")).strip()
    return ""


def is_card_category(category: Mapping[str, object]) -> bool:
    """Conservatively identify TCG/card categories without name-only guessing."""

    category_id = _positive_int(category.get("categoryId"), "categoryId")
    non_sealed = str(category.get("nonSealedLabel") or "").casefold()
    name = str(category.get("name") or "").casefold()
    return (
        "card" in non_sealed
        or "single" in non_sealed
        or " tcg" in f" {name}"
        or " ccg" in f" {name}"
        or category_id in CARD_CATEGORY_EXCEPTIONS
    )


def normalize_category(category: Mapping[str, object]) -> dict[str, object]:
    category_id = _positive_int(category.get("categoryId"), "categoryId")
    record = {
        "category_id": category_id,
        "name": _text(category.get("name"), "category name", 300, required=True),
        "display_name": _text(category.get("displayName"), "category displayName", 300),
        "is_card_category": is_card_category(category),
        "metadata": {
            "sealedLabel": _text(category.get("sealedLabel"), "sealedLabel", 300),
            "nonSealedLabel": _text(category.get("nonSealedLabel"), "nonSealedLabel", 300),
        },
    }
    record["category_sha256"] = content_hash(record)
    return record


def _optional_date(value: object) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    try:
        return date.fromisoformat(text[:10]).isoformat()
    except ValueError as exc:
        raise TCGCSVUniverseError("group publishedOn must begin with an ISO date") from exc


def normalize_group(category_id: int, group: Mapping[str, object]) -> dict[str, object]:
    category = _positive_int(category_id, "category_id")
    group_id = _positive_int(group.get("groupId"), "groupId")
    semantic = {
        "categoryId": category,
        "groupId": group_id,
        "name": _text(group.get("name"), "group name", 500, required=True),
        "abbreviation": _text(group.get("abbreviation"), "group abbreviation", 120),
        "publishedOn": _optional_date(group.get("publishedOn")),
        "isSupplemental": bool(group.get("isSupplemental", False)),
    }
    return {
        "category_id": category,
        "group_id": group_id,
        "name": semantic["name"],
        "abbreviation": semantic["abbreviation"],
        "published_on": semantic["publishedOn"],
        "modified_on": _text(group.get("modifiedOn"), "group modifiedOn", 160),
        "group_sha256": content_hash(semantic),
        "metadata": {"isSupplemental": semantic["isSupplemental"]},
    }


def _safe_extended_data(product: Mapping[str, object]) -> list[dict[str, str]]:
    raw = product.get("extendedData", [])
    if not isinstance(raw, list):
        raise TCGCSVUniverseError("product extendedData must be an array")
    if len(raw) > 200:
        raise TCGCSVUniverseError("product extendedData is unexpectedly large")
    values = []
    for item in raw:
        if not isinstance(item, Mapping):
            raise TCGCSVUniverseError("product extendedData entries must be objects")
        values.append({
            "name": _text(item.get("name"), "extendedData name", 160),
            "displayName": _text(item.get("displayName"), "extendedData displayName", 160),
            "value": _text(item.get("value"), "extendedData value", 4000),
        })
    return values


def normalize_product(
    category_id: int,
    group_id: int,
    product: Mapping[str, object],
) -> dict[str, object]:
    category = _positive_int(category_id, "category_id")
    group = _positive_int(group_id, "group_id")
    product_id = _positive_int(product.get("productId"), "productId")
    extended = _safe_extended_data(product)
    semantic = {
        "categoryId": category,
        "groupId": group,
        "productId": product_id,
        "name": _text(product.get("name"), "product name", 700, required=True),
        "cleanName": _text(product.get("cleanName"), "product cleanName", 700),
        "modifiedOn": _text(product.get("modifiedOn"), "product modifiedOn", 160),
        "extendedData": extended,
    }
    return {
        "category_id": category,
        "group_id": group,
        "product_id": product_id,
        "name": semantic["name"],
        "clean_name": semantic["cleanName"],
        "card_number": _text(_extended_value(product, "Number"), "card number", 160),
        "rarity": _text(_extended_value(product, "Rarity"), "rarity", 300),
        "card_type": _text(
            _extended_value(product, "Card Type", "Type"), "card type", 300
        ),
        "modified_on": semantic["modifiedOn"],
        "product_sha256": content_hash(semantic),
        # Deliberately omit provider image and commerce URLs from the private
        # catalog packet; current rights do not allow image display/caching.
        "metadata": {"extendedData": extended},
    }


def plan_catalog_refresh(
    groups: Iterable[Mapping[str, object]],
    *,
    current_groups: Mapping[tuple[int, int], Mapping[str, object]] | None = None,
    unresolved_groups: Iterable[tuple[int, int]] = (),
    audit_date: date,
    audit_cycle_days: int = AUDIT_CYCLE_DAYS,
) -> dict[tuple[int, int], tuple[str, ...]]:
    """Choose new/changed/unresolved groups plus one deterministic audit shard."""

    if isinstance(audit_cycle_days, bool) or audit_cycle_days <= 0:
        raise ValueError("audit_cycle_days must be positive")
    current = current_groups or {}
    unresolved = set(unresolved_groups)
    target_bucket = audit_date.toordinal() % audit_cycle_days
    plan: dict[tuple[int, int], tuple[str, ...]] = {}
    for group in groups:
        category_id = _positive_int(group.get("category_id"), "category_id")
        group_id = _positive_int(group.get("group_id"), "group_id")
        identity = (category_id, group_id)
        previous = current.get(identity)
        reasons: list[str] = []
        if previous is None:
            reasons.append("new_group")
        else:
            if str(previous.get("group_sha256") or "") != str(group.get("group_sha256") or ""):
                reasons.append("semantic_group_change")
            if str(previous.get("modified_on") or "") != str(group.get("modified_on") or ""):
                reasons.append("provider_modified_change")
        if identity in unresolved:
            reasons.append("unknown_product")
        bucket = int(content_hash({"categoryId": category_id, "groupId": group_id})[:8], 16)
        if bucket % audit_cycle_days == target_bucket:
            reasons.append("rotating_audit")
        if reasons:
            plan[identity] = tuple(dict.fromkeys(reasons))
    return plan


@dataclass(frozen=True, slots=True)
class PriceFact:
    archive_date: date
    source_available_at: datetime
    category_id: int
    group_id: int
    product_id: int
    subtype_name: str
    low_price: Decimal | None
    mid_price: Decimal | None
    high_price: Decimal | None
    market_price: Decimal | None
    direct_low_price: Decimal | None
    series_sha256: str
    price_tuple_sha256: str

    @classmethod
    def from_provider(
        cls,
        archive_date: date,
        category_id: int,
        group_id: int,
        value: Mapping[str, object],
        *,
        source_available_at: datetime,
    ) -> "PriceFact":
        available = _utc(source_available_at, "source_available_at")
        if available.date() < archive_date:
            raise TCGCSVUniverseError("source_available_at cannot precede archive_date")
        category = _positive_int(category_id, "category_id")
        group = _positive_int(group_id, "group_id")
        product = _positive_int(value.get("productId"), "productId")
        subtype = _text(value.get("subTypeName"), "subTypeName", 200, required=True)
        prices = {
            "lowPrice": _price(value.get("lowPrice"), "lowPrice"),
            "midPrice": _price(value.get("midPrice"), "midPrice"),
            "highPrice": _price(value.get("highPrice"), "highPrice"),
            "marketPrice": _price(value.get("marketPrice"), "marketPrice"),
            "directLowPrice": _price(value.get("directLowPrice"), "directLowPrice"),
        }
        series_hash = sha256(
            f"{category}|{group}|{product}|{subtype}".encode("utf-8")
        ).hexdigest()
        tuple_hash = content_hash({
            key: None if item is None else format(item, "f")
            for key, item in prices.items()
        })
        return cls(
            archive_date=archive_date,
            source_available_at=available,
            category_id=category,
            group_id=group,
            product_id=product,
            subtype_name=subtype,
            low_price=prices["lowPrice"],
            mid_price=prices["midPrice"],
            high_price=prices["highPrice"],
            market_price=prices["marketPrice"],
            direct_low_price=prices["directLowPrice"],
            series_sha256=series_hash,
            price_tuple_sha256=tuple_hash,
        )

    def csv_row(self) -> tuple[object, ...]:
        return (
            self.archive_date.isoformat(), self.source_available_at.isoformat(), self.category_id,
            self.group_id, self.product_id, self.subtype_name,
            self.series_sha256, _decimal_text(self.low_price),
            _decimal_text(self.mid_price), _decimal_text(self.high_price),
            _decimal_text(self.market_price), _decimal_text(self.direct_low_price),
            self.price_tuple_sha256,
        )


@dataclass(frozen=True, slots=True)
class GroupReceipt:
    category_id: int
    group_id: int
    member_path: str
    member_sha256: str
    row_count: int
    member_bytes: int

    def as_dict(self) -> dict[str, object]:
        return {
            "categoryId": self.category_id,
            "groupId": self.group_id,
            "memberPath": self.member_path,
            "memberSha256": self.member_sha256,
            "rowCount": self.row_count,
            "memberBytes": self.member_bytes,
        }


@dataclass(frozen=True, slots=True)
class ArchiveNormalization:
    archive_date: date
    source_available_at: datetime
    category_ids: tuple[int, ...]
    group_receipts: tuple[GroupReceipt, ...]
    price_count: int
    expanded_bytes: int
    csv_sha256: str

    @property
    def scope_sha256(self) -> str:
        return content_hash({
            "contractVersion": UNIVERSE_CONTRACT_VERSION,
            "categoryIds": list(self.category_ids),
        })

    def as_dict(self) -> dict[str, object]:
        return {
            "archiveDate": self.archive_date.isoformat(),
            "sourceAvailableAt": self.source_available_at.isoformat(),
            "categoryIds": list(self.category_ids),
            "groupReceipts": [item.as_dict() for item in self.group_receipts],
            "priceCount": self.price_count,
            "expandedBytes": self.expanded_bytes,
            "csvSha256": self.csv_sha256,
            "scopeSha256": self.scope_sha256,
        }


def normalize_extracted_archive(
    extracted_root: Path,
    archive_date: date,
    category_ids: Iterable[int],
    csv_path: Path,
    *,
    source_available_at: datetime,
) -> ArchiveNormalization:
    """Stream every scoped provider price row to one deterministic CSV."""

    available = _utc(source_available_at, "source_available_at")
    if available.date() < archive_date:
        raise TCGCSVUniverseError("source_available_at cannot precede archive_date")
    requested = {_positive_int(value, "category_id") for value in category_ids}
    if not requested:
        raise ValueError("at least one card category is required")
    root = Path(extracted_root).resolve()
    base = root / archive_date.isoformat()
    if not base.is_dir():
        if root.name == archive_date.isoformat() and root.is_dir():
            base = root
        else:
            raise TCGCSVUniverseError("archive extraction lacks its dated root directory")
    base = base.resolve()
    csv_path = Path(csv_path)
    csv_path.parent.mkdir(parents=True, exist_ok=True)
    if csv_path.exists():
        raise FileExistsError(f"refusing to overwrite {csv_path}")

    receipts: list[GroupReceipt] = []
    discovered_categories: set[int] = set()
    price_count = 0
    expanded_bytes = 0
    with csv_path.open("x", newline="", encoding="utf-8") as output:
        writer = csv.writer(output, lineterminator="\n")
        writer.writerow(PRICE_COLUMNS)
        for member in sorted(base.glob("*/*/prices"), key=lambda item: item.as_posix()):
            resolved = member.resolve()
            if not resolved.is_relative_to(base) or member.is_symlink() or not member.is_file():
                raise TCGCSVUniverseError("archive member escaped the extraction root")
            category_id = _positive_int(member.parent.parent.name, "archive category")
            if category_id not in requested:
                continue
            group_id = _positive_int(member.parent.name, "archive group")
            payload = member.read_bytes()
            if not payload or len(payload) > MAX_ARCHIVE_MEMBER_BYTES:
                raise TCGCSVUniverseError("archive price member has an invalid size")
            try:
                parsed = json.loads(payload.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise TCGCSVUniverseError("archive price member is not valid UTF-8 JSON") from exc
            rows = _result_array(parsed, member.relative_to(root).as_posix())
            identities: set[tuple[int, str]] = set()
            for raw in rows:
                fact = PriceFact.from_provider(
                    archive_date, category_id, group_id, raw,
                    source_available_at=available,
                )
                identity = (fact.product_id, fact.subtype_name)
                if identity in identities:
                    raise TCGCSVUniverseError("archive price member contains duplicate series")
                identities.add(identity)
                writer.writerow(fact.csv_row())
                price_count += 1
            relative = member.relative_to(root).as_posix()
            receipts.append(GroupReceipt(
                category_id=category_id,
                group_id=group_id,
                member_path=relative,
                member_sha256=sha256(payload).hexdigest(),
                row_count=len(rows),
                member_bytes=len(payload),
            ))
            discovered_categories.add(category_id)
            expanded_bytes += len(payload)
    missing_categories = sorted(requested - discovered_categories)
    if missing_categories:
        csv_path.unlink(missing_ok=True)
        raise TCGCSVUniverseError(
            "archive is missing requested card categories: "
            f"{missing_categories}"
        )
    if not receipts or not price_count:
        raise TCGCSVUniverseError("archive contains no scoped price rows")
    return ArchiveNormalization(
        archive_date=archive_date,
        source_available_at=available,
        category_ids=tuple(sorted(discovered_categories)),
        group_receipts=tuple(receipts),
        price_count=price_count,
        expanded_bytes=expanded_bytes,
        csv_sha256=file_sha256(csv_path),
    )


def _finite_or_none(value: object) -> float | None:
    if value is None:
        return None
    number = float(value)
    if not isfinite(number):
        raise TCGCSVUniverseError("market metric must be finite")
    return number


def _clamp(value: float, lower: float, upper: float) -> float:
    return max(lower, min(upper, value))


def build_shadow_feature(
    metric: Mapping[str, object],
    forecast_origin: datetime,
) -> dict[str, object]:
    """Build a transparent research estimate; never a publication payload."""

    origin = _utc(forecast_origin, "forecast_origin")
    source_available = _utc(metric.get("source_available_at"), "source_available_at")
    if origin < source_available:
        raise TCGCSVUniverseError("forecast origin precedes source availability")
    current = _finite_or_none(metric.get("current_price"))
    observation_count = int(metric.get("observation_count") or 0)
    density = _finite_or_none(metric.get("history_density_365d"))
    slope = _finite_or_none(metric.get("daily_log_slope_30d"))
    volatility = _finite_or_none(metric.get("volatility_30d"))
    drawdown = _finite_or_none(metric.get("max_drawdown_365d"))
    returns = {
        horizon: _finite_or_none(metric.get(f"return_{horizon}d"))
        for horizon in (7, 30, 90, 180, 365)
    }
    sufficient = (
        current is not None and current > 0 and observation_count >= 14
        and density is not None and slope is not None and volatility is not None
    )
    if not sufficient:
        trend_status = "insufficient"
        trend_confidence = None
        opportunity_score = None
        opportunity_status = "insufficient"
        estimates: dict[str, object] = {}
        estimate_status = "insufficient"
    else:
        slope_z = slope / max(volatility, 0.01)
        if slope_z >= 0.35:
            trend_status = "strong_rise"
        elif slope_z >= 0.12:
            trend_status = "rise"
        elif slope_z <= -0.35:
            trend_status = "strong_fall"
        elif slope_z <= -0.12:
            trend_status = "fall"
        else:
            trend_status = "stable"
        trend_confidence = round(_clamp(density * 70 + min(observation_count / 90, 1) * 30, 0, 100), 4)
        momentum = _clamp((returns[30] or 0) * 100, -25, 25)
        stability = 12 * (1 - _clamp(volatility / 0.15, 0, 1))
        drawdown_penalty = 15 * _clamp(drawdown or 0, 0, 1)
        opportunity_score = round(_clamp(
            45 + momentum + 18 * tanh(slope_z) + stability
            + 10 * density - drawdown_penalty,
            0, 100,
        ), 4)
        opportunity_status = (
            "candidate" if opportunity_score >= 70
            else "risk" if opportunity_score <= 30 else "neutral"
        )
        estimates = {}
        normal = NormalDist()
        base_confidence = _clamp(density * 75 + min(observation_count / 365, 1) * 25, 0, 100)
        for horizon in FORECAST_HORIZONS:
            predicted_log_return = _clamp(slope * horizon * 0.25, -0.70, 0.70)
            sigma = _clamp(volatility * sqrt(horizon) * 0.75, 0.05, 1.20)
            quantiles = {
                "q10": current * exp(predicted_log_return - 1.281551565545 * sigma),
                "q25": current * exp(predicted_log_return - 0.674489750196 * sigma),
                "q50": current * exp(predicted_log_return),
                "q75": current * exp(predicted_log_return + 0.674489750196 * sigma),
                "q90": current * exp(predicted_log_return + 1.281551565545 * sigma),
            }
            confidence = base_confidence * sqrt(30 / horizon)
            estimates[str(horizon)] = {
                **{key: round(value, 4) for key, value in quantiles.items()},
                "probabilityUp": round(normal.cdf(predicted_log_return / sigma), 6),
                "confidence": round(_clamp(confidence, 0, 100), 4),
                "forecastStatus": "limited",
                "origin": origin.isoformat(),
                "maturesAt": (origin + timedelta(days=horizon)).isoformat(),
                "modelVersion": SHADOW_FORECAST_MODEL,
                "researchOnly": True,
            }
        estimate_status = "research_only"

    feature = {
        "category_id": _positive_int(metric.get("category_id"), "category_id"),
        "group_id": _positive_int(metric.get("group_id"), "group_id"),
        "product_id": _positive_int(metric.get("product_id"), "product_id"),
        "subtype_name": _text(metric.get("subtype_name"), "subtype_name", 200, required=True),
        "series_sha256": _text(metric.get("series_sha256"), "series_sha256", 64, required=True),
        "current_price": current,
        **{f"return_{horizon}d": returns[horizon] for horizon in (7, 30, 90, 180, 365)},
        "daily_log_slope_30d": slope,
        "volatility_30d": volatility,
        "max_drawdown_365d": drawdown,
        "history_density_365d": density,
        "trend_status": trend_status,
        "trend_confidence": trend_confidence,
        "opportunity_score": opportunity_score,
        "opportunity_status": opportunity_status,
        "forecast_estimates": estimates,
        "forecast_model_key": SHADOW_FORECAST_MODEL,
        "estimate_status": estimate_status,
    }
    feature["feature_sha256"] = content_hash(feature)
    return feature


def feature_csv_row(feature: Mapping[str, object]) -> tuple[object, ...]:
    values = []
    for name in FEATURE_COLUMNS:
        value = feature.get(name)
        if name == "forecast_estimates":
            value = canonical_json(value or {})
        elif value is None:
            value = ""
        values.append(value)
    return tuple(values)


def set_feature_record(metric: Mapping[str, object]) -> dict[str, object]:
    series_count = int(metric.get("series_count") or 0)
    priced_count = int(metric.get("priced_series_count") or 0)
    median_return = _finite_or_none(metric.get("median_return_30d"))
    breadth = _finite_or_none(metric.get("breadth_30d"))
    volatility = _finite_or_none(metric.get("median_volatility_30d"))
    available = priced_count >= 5 and median_return is not None and breadth is not None
    hotness = None
    if available:
        hotness = round(_clamp(
            50 + _clamp(median_return * 100, -25, 25)
            + (breadth - 0.5) * 30
            - 10 * _clamp((volatility or 0) / 0.20, 0, 1),
            0, 100,
        ), 4)
    record = {
        "category_id": _positive_int(metric.get("category_id"), "category_id"),
        "group_id": _positive_int(metric.get("group_id"), "group_id"),
        "series_count": series_count,
        "priced_series_count": priced_count,
        "median_return_30d": median_return,
        "breadth_30d": breadth,
        "median_volatility_30d": volatility,
        "hotness_score": hotness,
        "feature_status": "available" if available else "insufficient",
    }
    record["feature_sha256"] = content_hash(record)
    return record


def set_feature_csv_row(feature: Mapping[str, object]) -> tuple[object, ...]:
    return tuple("" if feature.get(name) is None else feature.get(name) for name in SET_FEATURE_COLUMNS)
