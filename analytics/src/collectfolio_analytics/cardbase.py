"""Strict Cardbase MTG history acquisition for private research imports.

Cardbase keys every printing by its Scryfall UUID and returns independent
daily series for each vendor, finish, price type, and currency.  This module
keeps those identities separate, never rotates API keys, and labels every
historical point as first available to CollectFolio at the real retrieval
instant.  It fetches and normalizes data only; publication and database writes
remain behind the existing source-review and centralized-import gates.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, time, timezone
from email.utils import parsedate_to_datetime
from hashlib import sha256
from http.client import HTTPMessage
import json
from math import isfinite
import re
import time as time_module
from typing import Callable, Iterable, Mapping
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import HTTPRedirectHandler, Request, build_opener
from uuid import UUID

from .historical_import import HistoricalImportSeries
from .market_pipeline import ObservationMapping, RawPriceRecord, SourceTerms
from .observations import normalize_market_identity


DEFAULT_BASE_URL = "https://api.cardbase.dev/v1"
DEFAULT_USER_AGENT = "CollectFolio-PrivateResearch/0.8.3"
ANONYMOUS_HISTORY_DAYS = 30
AUTHENTICATED_HISTORY_DAYS = 365
MAX_RESPONSE_BYTES = 4_000_000
MAX_PRICE_SERIES = 100
MAX_POINTS_PER_SERIES = AUTHENTICATED_HISTORY_DAYS
MAX_RETRY_AFTER_SECONDS = 60
TERMS_MINIMUM_REVIEW_DATE = date(2026, 8, 1)
VENDORS = frozenset({
    "tcgplayer", "cardmarket", "cardkingdom", "cardsphere", "cardhoarder"
})
FINISHES = frozenset({"normal", "foil", "etched"})
PRICE_TYPES = frozenset({"retail", "buylist"})


class CardbaseError(RuntimeError):
    """Base error for a Cardbase request or payload contract failure."""


class CardbasePayloadError(CardbaseError):
    """The provider response did not match the reviewed API contract."""


class CardbaseRateLimitError(CardbaseError):
    """The provider returned 429 with a bounded Retry-After duration."""

    def __init__(self, retry_after_seconds: float) -> None:
        self.retry_after_seconds = min(
            MAX_RETRY_AFTER_SECONDS, max(0.0, float(retry_after_seconds))
        )
        super().__init__(
            f"Cardbase rate limit requires a {self.retry_after_seconds:g}-second wait"
        )


FetchJSON = Callable[[str, Mapping[str, str]], object]
Sleep = Callable[[float], None]


class _RejectRedirects(HTTPRedirectHandler):
    """Keep bearer credentials on the reviewed Cardbase origin only."""

    def redirect_request(self, *_args, **_kwargs):  # noqa: ANN002, ANN003
        return None


def _required(value: object, name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise CardbasePayloadError(f"{name} must be non-empty")
    return value.strip()


def _uuid(value: object, name: str) -> str:
    try:
        return str(UUID(str(value)))
    except (TypeError, ValueError, AttributeError) as exc:
        raise CardbasePayloadError(f"{name} must be a UUID") from exc


def _utc(value: datetime, name: str) -> datetime:
    if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() is None:
        raise ValueError(f"{name} must be a timezone-aware datetime")
    return value.astimezone(timezone.utc)


def _date(value: object, name: str) -> date:
    try:
        return date.fromisoformat(_required(value, name))
    except ValueError as exc:
        raise CardbasePayloadError(f"{name} must be an ISO date") from exc


def _price(value: object, name: str) -> float:
    if isinstance(value, bool):
        raise CardbasePayloadError(f"{name} must be a finite positive number")
    try:
        result = float(value)
    except (TypeError, ValueError) as exc:
        raise CardbasePayloadError(f"{name} must be a finite positive number") from exc
    if not isfinite(result) or result <= 0:
        raise CardbasePayloadError(f"{name} must be a finite positive number")
    return result


def _canonical_json(value: object) -> str:
    try:
        return json.dumps(
            value, ensure_ascii=False, sort_keys=True, separators=(",", ":"),
            allow_nan=False,
        )
    except (TypeError, ValueError) as exc:
        raise CardbasePayloadError("Cardbase response must be strict JSON") from exc


def _retry_after(headers: HTTPMessage | Mapping[str, str] | None) -> float:
    raw = headers.get("Retry-After") if headers is not None else None
    if raw is None:
        return MAX_RETRY_AFTER_SECONDS
    try:
        return min(MAX_RETRY_AFTER_SECONDS, max(0.0, float(raw)))
    except (TypeError, ValueError):
        try:
            retry_at = parsedate_to_datetime(str(raw))
            if retry_at.tzinfo is None:
                retry_at = retry_at.replace(tzinfo=timezone.utc)
            return min(
                MAX_RETRY_AFTER_SECONDS,
                max(0.0, (retry_at - datetime.now(timezone.utc)).total_seconds()),
            )
        except (TypeError, ValueError, OverflowError):
            return MAX_RETRY_AFTER_SECONDS


def _default_fetch_json(
    url: str,
    headers: Mapping[str, str],
    *,
    timeout_seconds: float,
) -> object:
    request = Request(url, headers=dict(headers))
    opener = build_opener(_RejectRedirects())
    try:
        with opener.open(request, timeout=timeout_seconds) as response:  # noqa: S310 - fixed HTTPS origin
            declared = response.headers.get("Content-Length")
            try:
                declared_size = int(declared) if declared else None
            except ValueError as exc:
                raise CardbasePayloadError("Cardbase response has an invalid size") from exc
            if declared_size is not None and (
                declared_size < 0 or declared_size > MAX_RESPONSE_BYTES
            ):
                raise CardbasePayloadError(
                    "Cardbase response exceeds the configured size limit"
                )
            payload = response.read(MAX_RESPONSE_BYTES + 1)
    except HTTPError as exc:
        if exc.code == 429:
            raise CardbaseRateLimitError(_retry_after(exc.headers)) from exc
        raise CardbaseError(f"Cardbase request failed ({exc.code})") from exc
    except (URLError, TimeoutError) as exc:
        raise CardbaseError("Cardbase request failed") from exc
    if len(payload) > MAX_RESPONSE_BYTES:
        raise CardbasePayloadError("Cardbase response exceeds the configured size limit")
    try:
        return json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise CardbasePayloadError("Cardbase response is not valid UTF-8 JSON") from exc


def cardbase_series_key(
    vendor: object,
    finish: object,
    price_type: object,
    currency: object,
) -> str:
    """Return the exact provider-series identity used by reviewed mappings."""

    vendor_value = normalize_market_identity(_required(vendor, "series.vendor"))
    finish_value = normalize_market_identity(_required(finish, "series.finish"))
    price_type_value = normalize_market_identity(
        _required(price_type, "series.price_type")
    )
    currency_value = _required(currency, "series.currency").upper()
    if vendor_value not in VENDORS:
        raise CardbasePayloadError("series.vendor is unsupported")
    if finish_value not in FINISHES:
        raise CardbasePayloadError("series.finish is unsupported")
    if price_type_value not in PRICE_TYPES:
        raise CardbasePayloadError("series.price_type is unsupported")
    if not re.fullmatch(r"[A-Z]{3}", currency_value):
        raise CardbasePayloadError("series.currency must be a three-letter code")
    return "|".join((vendor_value, finish_value, price_type_value, currency_value))


@dataclass(frozen=True, slots=True)
class CardbasePriceSeries:
    vendor: str
    finish: str
    price_type: str
    currency: str
    points: tuple[tuple[date, float], ...]

    def __post_init__(self) -> None:
        key = cardbase_series_key(
            self.vendor, self.finish, self.price_type, self.currency
        )
        vendor, finish, price_type, currency = key.split("|")
        object.__setattr__(self, "vendor", vendor)
        object.__setattr__(self, "finish", finish)
        object.__setattr__(self, "price_type", price_type)
        object.__setattr__(self, "currency", currency)
        try:
            raw_points = tuple(self.points)
        except TypeError as exc:
            raise CardbasePayloadError("series.points must be an array") from exc
        if not raw_points or len(raw_points) > MAX_POINTS_PER_SERIES:
            raise CardbasePayloadError(
                f"series.points must contain 1 to {MAX_POINTS_PER_SERIES} entries"
            )
        points: list[tuple[date, float]] = []
        seen: set[date] = set()
        for index, point in enumerate(raw_points):
            if not isinstance(point, (list, tuple)) or len(point) != 2:
                raise CardbasePayloadError(
                    "series.points must contain [date, amount] pairs"
                )
            observed_on = point[0] if isinstance(point[0], date) else _date(
                point[0], f"series.points[{index}][0]"
            )
            if isinstance(observed_on, datetime):
                raise CardbasePayloadError("series point dates cannot be datetimes")
            if observed_on in seen:
                raise CardbasePayloadError("series.points contains a duplicate date")
            seen.add(observed_on)
            points.append((observed_on, _price(
                point[1], f"series.points[{index}][1]"
            )))
        if points != sorted(points):
            raise CardbasePayloadError("series.points must be sorted ascending")
        object.__setattr__(self, "points", tuple(points))

    @property
    def external_variant_key(self) -> str:
        return cardbase_series_key(
            self.vendor, self.finish, self.price_type, self.currency
        )

    @property
    def price_semantics(self) -> str:
        return normalize_market_identity(
            f"cardbase-{self.vendor}-{self.price_type}"
        )


@dataclass(frozen=True, slots=True)
class CardbaseSnapshot:
    scryfall_id: str
    series: tuple[CardbasePriceSeries, ...]
    as_of: date
    sources: tuple[str, ...]
    history_begins: date
    retrieved_at: datetime

    def __post_init__(self) -> None:
        object.__setattr__(self, "scryfall_id", _uuid(
            self.scryfall_id, "data.scryfall_id"
        ))
        retrieved = _utc(self.retrieved_at, "retrieved_at")
        object.__setattr__(self, "retrieved_at", retrieved)
        if not isinstance(self.as_of, date) or isinstance(self.as_of, datetime):
            raise CardbasePayloadError("meta.as_of must be a date")
        if not isinstance(self.history_begins, date) or isinstance(
            self.history_begins, datetime
        ):
            raise CardbasePayloadError("meta.history_begins must be a date")
        if self.history_begins > self.as_of:
            raise CardbasePayloadError("meta.history_begins cannot follow meta.as_of")
        if self.as_of > retrieved.date():
            raise CardbasePayloadError("meta.as_of cannot be in the future")
        try:
            series = tuple(self.series)
        except TypeError as exc:
            raise CardbasePayloadError("data.series must be an array") from exc
        if len(series) > MAX_PRICE_SERIES or any(
            not isinstance(item, CardbasePriceSeries) for item in series
        ):
            raise CardbasePayloadError("data.series contains invalid entries")
        keys = [item.external_variant_key for item in series]
        if len(keys) != len(set(keys)):
            raise CardbasePayloadError("data.series contains duplicate identities")
        for item in series:
            for observed_on, _amount in item.points:
                if observed_on > self.as_of:
                    raise CardbasePayloadError(
                        "series point cannot follow the response as_of date"
                    )
        object.__setattr__(self, "series", tuple(sorted(
            series, key=lambda item: item.external_variant_key
        )))
        try:
            sources = tuple(_required(item, "meta.sources[]") for item in self.sources)
        except TypeError as exc:
            raise CardbasePayloadError("meta.sources must be an array") from exc
        if not sources or len(sources) != len(set(sources)):
            raise CardbasePayloadError("meta.sources must contain unique source names")
        object.__setattr__(self, "sources", sources)

    def series_for_key(self, external_variant_key: str) -> CardbasePriceSeries:
        key = _required(external_variant_key, "external_variant_key")
        matches = [item for item in self.series if item.external_variant_key == key]
        if len(matches) != 1:
            raise CardbasePayloadError(
                f"Cardbase response is missing exact series {key!r}"
            )
        return matches[0]

    def raw_price_records(
        self,
        external_variant_key: str,
        *,
        available_at: datetime | None = None,
        quality_score: float = 0.85,
    ) -> tuple[RawPriceRecord, ...]:
        series = self.series_for_key(external_variant_key)
        available = _utc(available_at or self.retrieved_at, "available_at")
        records: list[RawPriceRecord] = []
        for observed_on, amount in series.points:
            observed_at = datetime.combine(observed_on, time.min, tzinfo=timezone.utc)
            if observed_at > available:
                raise CardbasePayloadError(
                    "Cardbase point was not observable by the declared retrieval time"
                )
            records.append(RawPriceRecord(
                external_record_id=(
                    f"cardbase:{self.scryfall_id}:{external_variant_key}:"
                    f"{observed_on.isoformat()}:"
                    f"{sha256(format(amount, '.17g').encode('ascii')).hexdigest()[:16]}"
                ),
                external_product_id=self.scryfall_id,
                external_variant_key=external_variant_key,
                price_semantics=series.price_semantics,
                currency=series.currency,
                market_price=amount,
                observed_at=observed_at,
                # The API exposes a date but not the original release instant.
                # A backfill is therefore first knowable to CollectFolio now.
                available_at=available,
                quality_score=quality_score,
            ))
        return tuple(records)


def parse_cardbase_snapshot(
    payload: object,
    *,
    retrieved_at: datetime,
    expected_scryfall_id: str,
) -> CardbaseSnapshot:
    """Validate the documented price-history response envelope."""

    retrieved = _utc(retrieved_at, "retrieved_at")
    encoded = _canonical_json(payload).encode("utf-8")
    if len(encoded) > MAX_RESPONSE_BYTES:
        raise CardbasePayloadError("Cardbase response exceeds the configured size limit")
    if not isinstance(payload, Mapping):
        raise CardbasePayloadError("Cardbase response must be an object")
    data = payload.get("data")
    meta = payload.get("meta")
    if not isinstance(data, Mapping) or not isinstance(meta, Mapping):
        raise CardbasePayloadError("Cardbase response requires data and meta objects")
    scryfall_id = _uuid(data.get("scryfall_id"), "data.scryfall_id")
    expected = _uuid(expected_scryfall_id, "expected_scryfall_id")
    if scryfall_id != expected:
        raise CardbasePayloadError("Cardbase response printing does not match the request")
    raw_series = data.get("series")
    if not isinstance(raw_series, list) or len(raw_series) > MAX_PRICE_SERIES:
        raise CardbasePayloadError("data.series must be a bounded array")
    parsed_series: list[CardbasePriceSeries] = []
    for index, raw in enumerate(raw_series):
        if not isinstance(raw, Mapping):
            raise CardbasePayloadError(f"data.series[{index}] must be an object")
        points = raw.get("points")
        if not isinstance(points, list):
            raise CardbasePayloadError(f"data.series[{index}].points must be an array")
        parsed_series.append(CardbasePriceSeries(
            vendor=_required(raw.get("vendor"), f"data.series[{index}].vendor"),
            finish=_required(raw.get("finish"), f"data.series[{index}].finish"),
            price_type=_required(
                raw.get("price_type"), f"data.series[{index}].price_type"
            ),
            currency=_required(raw.get("currency"), f"data.series[{index}].currency"),
            points=tuple(points),
        ))
    raw_sources = meta.get("sources")
    if not isinstance(raw_sources, list):
        raise CardbasePayloadError("meta.sources must be an array")
    return CardbaseSnapshot(
        scryfall_id=scryfall_id,
        series=tuple(parsed_series),
        as_of=_date(meta.get("as_of"), "meta.as_of"),
        sources=tuple(raw_sources),
        history_begins=_date(meta.get("history_begins"), "meta.history_begins"),
        retrieved_at=retrieved,
    )


class CardbaseClient:
    """Fixed-origin, single-key client with bounded Retry-After handling."""

    def __init__(
        self,
        api_key: str = "",
        *,
        fetch_json: FetchJSON | None = None,
        timeout_seconds: float = 20,
        user_agent: str = DEFAULT_USER_AGENT,
        max_retries: int = 2,
        sleep: Sleep = time_module.sleep,
    ) -> None:
        key = str(api_key or "").strip()
        if key and (
            not key.startswith("cbdev_")
            or len(key) == len("cbdev_")
            or any(char.isspace() for char in key)
        ):
            raise ValueError("api_key must use the Cardbase cbdev_ prefix")
        self._api_key = key
        if (
            isinstance(timeout_seconds, bool)
            or not isinstance(timeout_seconds, (int, float))
            or not isfinite(timeout_seconds)
            or timeout_seconds <= 0
            or timeout_seconds > 60
        ):
            raise ValueError("timeout_seconds must be greater than zero and at most 60")
        if isinstance(max_retries, bool) or not isinstance(max_retries, int) or not 0 <= max_retries <= 3:
            raise ValueError("max_retries must be an integer between zero and three")
        self._timeout_seconds = float(timeout_seconds)
        self._user_agent = str(user_agent or "").strip()
        if not self._user_agent:
            raise ValueError("user_agent must be non-empty")
        self._max_retries = max_retries
        self._sleep = sleep
        self._fetch_json = fetch_json

    @property
    def authenticated(self) -> bool:
        return bool(self._api_key)

    def prices(
        self,
        scryfall_id: str,
        *,
        days: int = ANONYMOUS_HISTORY_DAYS,
        vendor: str = "",
        finish: str = "",
        price_type: str = "",
        retrieved_at: datetime | None = None,
    ) -> CardbaseSnapshot:
        printing_id = _uuid(scryfall_id, "scryfall_id")
        maximum_days = (
            AUTHENTICATED_HISTORY_DAYS
            if self.authenticated else ANONYMOUS_HISTORY_DAYS
        )
        if isinstance(days, bool) or not isinstance(days, int) or not 1 <= days <= maximum_days:
            tier = "authenticated" if self.authenticated else "anonymous"
            raise ValueError(
                f"days must be between 1 and {maximum_days} for {tier} access"
            )
        params: list[tuple[str, str]] = [("days", str(days))]
        if vendor:
            vendor_value = normalize_market_identity(vendor)
            if vendor_value not in VENDORS:
                raise ValueError("vendor is unsupported")
            params.append(("vendor", vendor_value))
        if finish:
            finish_value = normalize_market_identity(finish)
            if finish_value not in FINISHES:
                raise ValueError("finish is unsupported")
            params.append(("finish", finish_value))
        if price_type:
            price_type_value = normalize_market_identity(price_type)
            if price_type_value not in PRICE_TYPES:
                raise ValueError("price_type is unsupported")
            params.append(("price_type", price_type_value))
        url = (
            f"{DEFAULT_BASE_URL}/printings/{printing_id}/prices?{urlencode(params)}"
        )
        headers = {
            "Accept": "application/json",
            "User-Agent": self._user_agent,
        }
        if self._api_key:
            headers["Authorization"] = f"Bearer {self._api_key}"
        payload: object
        for attempt in range(self._max_retries + 1):
            try:
                payload = (
                    self._fetch_json(url, headers)
                    if self._fetch_json
                    else _default_fetch_json(
                        url, headers, timeout_seconds=self._timeout_seconds
                    )
                )
                break
            except CardbaseRateLimitError as exc:
                if attempt >= self._max_retries:
                    raise
                self._sleep(exc.retry_after_seconds)
        else:  # pragma: no cover - loop always breaks or raises
            raise CardbaseError("Cardbase retry loop terminated unexpectedly")
        return parse_cardbase_snapshot(
            payload,
            retrieved_at=retrieved_at or datetime.now(timezone.utc),
            expected_scryfall_id=printing_id,
        )


def assert_cardbase_research_terms(terms: SourceTerms, *, at: datetime) -> None:
    """Require a current review that permits private Cardbase research."""

    if not isinstance(terms, SourceTerms):
        raise ValueError("terms must be SourceTerms")
    instant = _utc(at, "at")
    if normalize_market_identity(terms.source_code) != "cardbase":
        raise PermissionError("source terms are not for Cardbase")
    if terms.decision != "research_only":
        raise PermissionError("Cardbase acquisition must remain research-only")
    if terms.public_raw_display_allowed or terms.public_derived_display_allowed:
        raise PermissionError("Cardbase public capabilities must remain disabled")
    if terms.reviewed_at.date() < TERMS_MINIMUM_REVIEW_DATE:
        raise PermissionError("Cardbase terms review predates the current API terms")
    if not terms.permits_research_ingestion(instant):
        raise PermissionError("current Cardbase terms do not permit private research")


def build_cardbase_history_series(
    snapshot: CardbaseSnapshot,
    mappings: Iterable[ObservationMapping],
    *,
    available_at: datetime,
    quality_score: float = 0.85,
) -> tuple[HistoricalImportSeries, ...]:
    """Bridge reviewed Cardbase identities into centralized history series."""

    if not isinstance(snapshot, CardbaseSnapshot):
        raise ValueError("snapshot must be a CardbaseSnapshot")
    available = _utc(available_at, "available_at")
    values = tuple(mappings)
    if not values:
        raise ValueError("at least one reviewed Cardbase mapping is required")
    if any(not isinstance(item, ObservationMapping) for item in values):
        raise ValueError("mappings must contain ObservationMapping values")
    keys = [item.external_variant_key for item in values]
    if len(keys) != len(set(keys)):
        raise ValueError("Cardbase mappings contain duplicate exact series")
    output: list[HistoricalImportSeries] = []
    for mapping in values:
        if not mapping.approved:
            raise PermissionError("Cardbase history requires approved exact mappings")
        if mapping.external_product_id != snapshot.scryfall_id:
            raise ValueError("Cardbase mapping uses a different Scryfall printing")
        series = snapshot.series_for_key(mapping.external_variant_key)
        if mapping.finish != series.finish:
            raise ValueError("Cardbase mapping finish differs from its provider series")
        if mapping.condition_class != "raw" or mapping.market_condition != "provider-aggregate":
            raise ValueError(
                "Cardbase series must retain its explicit provider-aggregate condition scope"
            )
        output.append(HistoricalImportSeries(
            mapping=mapping,
            currency=series.currency,
            price_semantics=series.price_semantics,
            records=snapshot.raw_price_records(
                mapping.external_variant_key,
                available_at=available,
                quality_score=quality_score,
            ),
        ))
    return tuple(output)
