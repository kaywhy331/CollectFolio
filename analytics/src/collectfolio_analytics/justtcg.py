"""Licensed-provider adapter for bounded JustTCG price observations.

The adapter does not approve a source or publish data.  It keeps the API key in
an HTTP header, accepts only the fixed JustTCG HTTPS origin, and stamps an
initial history backfill with the honest retrieval time so it cannot masquerade
as information that was available at an earlier walk-forward origin.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from hashlib import sha256
import json
from math import isfinite
from typing import Callable, Iterable, Mapping
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import HTTPRedirectHandler, Request, build_opener
from uuid import UUID

from .catalog_mapping import ExternalProduct, normalize_identity
from .market_pipeline import (
    ObservationBatch,
    ObservationMapping,
    ObservationQualityPolicy,
    RawPriceRecord,
    SourceTerms,
    prepare_observation_batch,
)
from .observations import PriceObservation


DEFAULT_BASE_URL = "https://api.justtcg.com/v1/cards"
DEFAULT_USER_AGENT = "CollectFolio/0.1 licensed price ingestion"
MAX_RESPONSE_BYTES = 8 * 1024 * 1024
PRICE_SEMANTICS = "justtcg-volume-weighted-market"
TERMS_MINIMUM_REVIEW_DATE = date(2026, 7, 27)
HISTORY_DURATIONS = {"7d": 7, "30d": 30, "90d": 90, "180d": 180, "1y": 365}
HISTORY_WINDOW_TOLERANCE_DAYS = 2

FetchJSON = Callable[[str, Mapping[str, str]], object]


class JustTCGPayloadError(ValueError):
    """Raised when a JustTCG response cannot satisfy the source contract."""


class _RejectRedirects(HTTPRedirectHandler):
    """Keep the API credential on the configured origin by refusing redirects."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        return None


def _canonical_json(value: object) -> str:
    try:
        return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    except (TypeError, ValueError) as exc:
        raise JustTCGPayloadError("JustTCG response is not valid JSON data") from exc


def _hash(value: object) -> str:
    return sha256(_canonical_json(value).encode("utf-8")).hexdigest()


def _required(value: object, name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise JustTCGPayloadError(f"{name} must be non-empty")
    return value.strip()


def _uuid(value: object, name: str) -> str:
    try:
        return str(UUID(_required(value, name)))
    except (TypeError, ValueError, AttributeError) as exc:
        raise JustTCGPayloadError(f"{name} must be a UUID") from exc


def _utc(value: datetime, name: str) -> datetime:
    if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() is None:
        raise ValueError(f"{name} must be timezone-aware")
    return value.astimezone(timezone.utc)


def _epoch(value: object, name: str) -> datetime:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not isfinite(value):
        raise JustTCGPayloadError(f"{name} must be a Unix timestamp")
    try:
        return datetime.fromtimestamp(float(value), tz=timezone.utc)
    except (OverflowError, OSError, ValueError) as exc:
        raise JustTCGPayloadError(f"{name} must be a valid Unix timestamp") from exc


def _price(value: object, name: str, *, nullable: bool = False) -> float | None:
    if value is None and nullable:
        return None
    if isinstance(value, bool):
        raise JustTCGPayloadError(f"{name} must be a positive number")
    try:
        parsed = float(value)
    except (TypeError, ValueError) as exc:
        raise JustTCGPayloadError(f"{name} must be a positive number") from exc
    if not isfinite(parsed) or parsed <= 0:
        raise JustTCGPayloadError(f"{name} must be a positive number")
    return parsed


def _condition_key(value: object) -> str:
    key = normalize_identity(str(value or ""))
    return {
        "nm": "near-mint",
        "lp": "lightly-played",
        "mp": "moderately-played",
        "hp": "heavily-played",
        "dmg": "damaged",
    }.get(key, key)


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
                raise JustTCGPayloadError("JustTCG response has an invalid size") from exc
            if declared_size is not None and (
                declared_size < 0 or declared_size > MAX_RESPONSE_BYTES
            ):
                raise JustTCGPayloadError("JustTCG response exceeds the configured size limit")
            payload = response.read(MAX_RESPONSE_BYTES + 1)
    except HTTPError as exc:
        raise JustTCGPayloadError(f"JustTCG request failed ({exc.code})") from exc
    except (URLError, TimeoutError) as exc:
        raise JustTCGPayloadError("JustTCG request failed") from exc
    if len(payload) > MAX_RESPONSE_BYTES:
        raise JustTCGPayloadError("JustTCG response exceeds the configured size limit")
    try:
        return json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise JustTCGPayloadError("JustTCG response is not valid UTF-8 JSON") from exc


@dataclass(frozen=True, slots=True)
class JustTCGVariantSnapshot:
    variant_uuid: str
    variant_slug: str
    condition: str
    printing: str
    language: str
    tcgplayer_sku_id: str
    current_price: float | None
    last_updated: datetime | None
    price_history: tuple[tuple[datetime, float], ...]

    def __post_init__(self) -> None:
        object.__setattr__(self, "variant_uuid", _uuid(self.variant_uuid, "variant.uuid"))
        object.__setattr__(self, "variant_slug", _required(self.variant_slug, "variant.id"))
        object.__setattr__(self, "condition", _required(self.condition, "variant.condition"))
        object.__setattr__(self, "printing", _required(self.printing, "variant.printing"))
        object.__setattr__(self, "language", _required(self.language, "variant.language"))
        object.__setattr__(self, "tcgplayer_sku_id", str(self.tcgplayer_sku_id or "").strip())
        current_price = _price(self.current_price, "variant.price", nullable=True)
        last_updated = (
            _utc(self.last_updated, "variant.lastUpdated")
            if self.last_updated is not None
            else None
        )
        if current_price is not None and last_updated is None:
            raise JustTCGPayloadError("priced variant is missing lastUpdated")
        try:
            raw_history = tuple(self.price_history)
        except TypeError as exc:
            raise JustTCGPayloadError("variant.priceHistory must contain timestamp/price pairs") from exc
        history: list[tuple[datetime, float]] = []
        timestamps: set[datetime] = set()
        for index, point in enumerate(raw_history):
            if not isinstance(point, (list, tuple)) or len(point) != 2:
                raise JustTCGPayloadError(
                    "variant.priceHistory must contain timestamp/price pairs"
                )
            observed_at = _utc(point[0], f"priceHistory[{index}].t")
            if observed_at in timestamps:
                raise JustTCGPayloadError(
                    "variant.priceHistory contains a duplicate timestamp"
                )
            timestamps.add(observed_at)
            history.append((observed_at, _price(point[1], f"priceHistory[{index}].p")))
        object.__setattr__(self, "current_price", current_price)
        object.__setattr__(self, "last_updated", last_updated)
        object.__setattr__(self, "price_history", tuple(sorted(history)))


@dataclass(frozen=True, slots=True)
class JustTCGSnapshot:
    card_uuid: str
    card_slug: str
    name: str
    game: str
    set_id: str
    set_name: str
    number: str
    rarity: str
    tcgplayer_id: str
    variants: tuple[JustTCGVariantSnapshot, ...]
    retrieved_at: datetime
    history_duration: str
    payload_hash: str

    def __post_init__(self) -> None:
        retrieved_at = _utc(self.retrieved_at, "retrieved_at")
        object.__setattr__(self, "card_uuid", _uuid(self.card_uuid, "card.uuid"))
        object.__setattr__(self, "card_slug", _required(self.card_slug, "card.id"))
        object.__setattr__(self, "name", _required(self.name, "card.name"))
        object.__setattr__(self, "game", _required(self.game, "card.game"))
        object.__setattr__(self, "set_id", _required(self.set_id, "card.set"))
        object.__setattr__(self, "set_name", _required(self.set_name, "card.set_name"))
        object.__setattr__(self, "number", _required(self.number, "card.number"))
        object.__setattr__(self, "rarity", str(self.rarity or "").strip())
        object.__setattr__(self, "tcgplayer_id", str(self.tcgplayer_id or "").strip())
        try:
            variants = tuple(self.variants)
        except TypeError as exc:
            raise JustTCGPayloadError(
                "card.variants must contain at least one valid variant"
            ) from exc
        if not variants or any(not isinstance(value, JustTCGVariantSnapshot) for value in variants):
            raise JustTCGPayloadError("card.variants must contain at least one valid variant")
        if len({value.variant_uuid for value in variants}) != len(variants):
            raise JustTCGPayloadError("card.variants contains duplicate stable UUIDs")
        object.__setattr__(self, "variants", variants)
        if (
            not isinstance(self.history_duration, str)
            or self.history_duration not in HISTORY_DURATIONS
        ):
            raise JustTCGPayloadError("history_duration is unsupported")
        history_days = HISTORY_DURATIONS[self.history_duration]
        oldest_allowed = retrieved_at - timedelta(
            days=history_days + HISTORY_WINDOW_TOLERANCE_DAYS
        )
        for variant in variants:
            if variant.last_updated is not None and variant.last_updated > retrieved_at:
                raise JustTCGPayloadError("variant.lastUpdated cannot be in the future")
            if len(variant.price_history) > history_days + HISTORY_WINDOW_TOLERANCE_DAYS:
                raise JustTCGPayloadError("variant.priceHistory exceeds the requested duration")
            for observed_at, _price_value in variant.price_history:
                if observed_at > retrieved_at:
                    raise JustTCGPayloadError("priceHistory.t cannot be in the future")
                if observed_at < oldest_allowed:
                    raise JustTCGPayloadError(
                        "variant.priceHistory falls outside the requested duration"
                    )
        object.__setattr__(self, "retrieved_at", retrieved_at)
        digest = str(self.payload_hash or "").lower()
        if len(digest) != 64 or any(character not in "0123456789abcdef" for character in digest):
            raise JustTCGPayloadError("payload_hash must be a SHA-256 digest")
        object.__setattr__(self, "payload_hash", digest)

    def external_products(
        self,
        source_id: str,
        *,
        canonical_set_key: str,
    ) -> tuple[ExternalProduct, ...]:
        """Build review-required identities without guessing provider printing aliases."""

        return tuple(ExternalProduct(
            source_id=source_id,
            external_product_id=self.card_uuid,
            external_variant_key=variant.variant_uuid,
            game=self.game,
            language=variant.language,
            canonical_set_key=canonical_set_key,
            name=self.name,
            number=self.number,
            edition="standard",
            finish=variant.printing,
            condition_class="raw",
            market_condition=_condition_key(variant.condition),
        ) for variant in self.variants)

    def raw_price_records(self, *, quality_score: float = 0.90) -> tuple[RawPriceRecord, ...]:
        records: list[RawPriceRecord] = []
        for variant in self.variants:
            points = {observed_at: price for observed_at, price in variant.price_history}
            if variant.last_updated is not None:
                points[variant.last_updated] = variant.current_price
            elif variant.current_price is not None:
                raise JustTCGPayloadError("priced variant is missing lastUpdated")
            for observed_at, price in sorted(points.items()):
                records.append(RawPriceRecord(
                    external_record_id=(
                        f"justtcg:{variant.variant_uuid}:{int(observed_at.timestamp())}"
                    ),
                    external_product_id=self.card_uuid,
                    external_variant_key=variant.variant_uuid,
                    price_semantics=PRICE_SEMANTICS,
                    currency="USD",
                    market_price=price,
                    observed_at=observed_at,
                    # Backfilled points were first knowable to CollectFolio at retrieval.
                    available_at=self.retrieved_at,
                    quality_score=quality_score,
                ))
        return tuple(sorted(records, key=lambda value: (
            value.observed_at, value.external_product_id, value.external_variant_key
        )))


def parse_justtcg_snapshot(
    payload: object,
    *,
    retrieved_at: datetime,
    history_duration: str,
    expected_condition: str = "NM",
    expected_printing: str = "",
) -> JustTCGSnapshot:
    retrieved = _utc(retrieved_at, "retrieved_at")
    if not isinstance(history_duration, str) or history_duration not in HISTORY_DURATIONS:
        raise ValueError(f"history_duration must be one of {sorted(HISTORY_DURATIONS)}")
    encoded = _canonical_json(payload).encode("utf-8")
    if len(encoded) > MAX_RESPONSE_BYTES:
        raise JustTCGPayloadError("JustTCG response exceeds the configured size limit")
    if not isinstance(payload, Mapping):
        raise JustTCGPayloadError("JustTCG response must be an object")
    data = payload.get("data")
    if not isinstance(data, list) or len(data) != 1 or not isinstance(data[0], Mapping):
        raise JustTCGPayloadError("direct JustTCG lookup must return exactly one card")
    card = data[0]
    raw_variants = card.get("variants")
    if not isinstance(raw_variants, list) or any(not isinstance(value, Mapping) for value in raw_variants):
        raise JustTCGPayloadError("card.variants must be an array of objects")
    condition_key = _condition_key(expected_condition)
    printing_key = normalize_identity(expected_printing)
    variants: list[JustTCGVariantSnapshot] = []
    for raw in raw_variants:
        if condition_key and _condition_key(raw.get("condition")) != condition_key:
            continue
        if printing_key and normalize_identity(str(raw.get("printing") or "")) != printing_key:
            continue
        current_price = _price(raw.get("price"), "variant.price", nullable=True)
        last_updated = None
        if raw.get("lastUpdated") is not None:
            last_updated = _epoch(raw.get("lastUpdated"), "variant.lastUpdated")
            if last_updated > retrieved:
                raise JustTCGPayloadError("variant.lastUpdated cannot be in the future")
        history = raw.get("priceHistory")
        if history is None:
            history = []
        if not isinstance(history, list) or any(not isinstance(point, Mapping) for point in history):
            raise JustTCGPayloadError("variant.priceHistory must be an array of objects")
        if len(history) > (
            HISTORY_DURATIONS[history_duration] + HISTORY_WINDOW_TOLERANCE_DAYS
        ):
            raise JustTCGPayloadError("variant.priceHistory exceeds the requested duration")
        points: list[tuple[datetime, float]] = []
        timestamps: set[datetime] = set()
        for point in history:
            observed_at = _epoch(point.get("t"), "priceHistory.t")
            if observed_at > retrieved:
                raise JustTCGPayloadError("priceHistory.t cannot be in the future")
            if observed_at in timestamps:
                raise JustTCGPayloadError("variant.priceHistory contains a duplicate timestamp")
            timestamps.add(observed_at)
            points.append((observed_at, _price(point.get("p"), "priceHistory.p")))
        variants.append(JustTCGVariantSnapshot(
            variant_uuid=_uuid(raw.get("uuid"), "variant.uuid"),
            variant_slug=_required(raw.get("id"), "variant.id"),
            condition=_required(raw.get("condition"), "variant.condition"),
            printing=_required(raw.get("printing"), "variant.printing"),
            language=_required(raw.get("language"), "variant.language"),
            tcgplayer_sku_id=str(raw.get("tcgplayerSkuId") or "").strip(),
            current_price=current_price,
            last_updated=last_updated,
            price_history=tuple(sorted(points)),
        ))
    if not variants:
        raise JustTCGPayloadError("JustTCG returned no variant matching the requested condition/printing")
    return JustTCGSnapshot(
        card_uuid=_uuid(card.get("uuid"), "card.uuid"),
        card_slug=_required(card.get("id"), "card.id"),
        name=_required(card.get("name"), "card.name"),
        game=_required(card.get("game"), "card.game"),
        set_id=_required(card.get("set"), "card.set"),
        set_name=_required(card.get("set_name"), "card.set_name"),
        number=_required(card.get("number"), "card.number"),
        rarity=str(card.get("rarity") or "").strip(),
        tcgplayer_id=str(card.get("tcgplayerId") or "").strip(),
        variants=tuple(variants),
        retrieved_at=retrieved,
        history_duration=history_duration,
        payload_hash=_hash(payload),
    )


class JustTCGClient:
    """Small fixed-origin client; callers must inject a server-side API key."""

    def __init__(
        self,
        api_key: str,
        *,
        fetch_json: FetchJSON | None = None,
        timeout_seconds: float = 20,
        user_agent: str = DEFAULT_USER_AGENT,
    ) -> None:
        self._api_key = _required(api_key, "api_key")
        if (
            isinstance(timeout_seconds, bool)
            or not isinstance(timeout_seconds, (int, float))
            or not isfinite(timeout_seconds)
            or timeout_seconds <= 0
            or timeout_seconds > 60
        ):
            raise ValueError("timeout_seconds must be greater than zero and at most 60")
        self._timeout_seconds = float(timeout_seconds)
        self._user_agent = _required(user_agent, "user_agent")
        self._fetch_json = fetch_json

    def card(
        self,
        *,
        card_id: str = "",
        variant_id: str = "",
        tcgplayer_id: str = "",
        condition: str = "NM",
        printing: str = "",
        history_duration: str = "1y",
        retrieved_at: datetime | None = None,
    ) -> JustTCGSnapshot:
        identifiers = {
            "cardId": str(card_id or "").strip(),
            "variantId": str(variant_id or "").strip(),
            "tcgplayerId": str(tcgplayer_id or "").strip(),
        }
        selected = [(key, value) for key, value in identifiers.items() if value]
        if len(selected) != 1:
            raise ValueError("exactly one card_id, variant_id, or tcgplayer_id is required")
        if not isinstance(history_duration, str) or history_duration not in HISTORY_DURATIONS:
            raise ValueError(f"history_duration must be one of {sorted(HISTORY_DURATIONS)}")
        condition_value = _required(condition, "condition")
        printing_value = str(printing or "").strip()
        params = [selected[0], ("condition", condition_value)]
        if printing_value:
            params.append(("printing", printing_value))
        params.append(("priceHistoryDuration", history_duration))
        url = f"{DEFAULT_BASE_URL}?{urlencode(params)}"
        headers = {
            "Accept": "application/json",
            "User-Agent": self._user_agent,
            "X-API-Key": self._api_key,
        }
        payload = (
            self._fetch_json(url, headers)
            if self._fetch_json
            else _default_fetch_json(url, headers, timeout_seconds=self._timeout_seconds)
        )
        return parse_justtcg_snapshot(
            payload,
            retrieved_at=retrieved_at or datetime.now(timezone.utc),
            history_duration=history_duration,
            expected_condition=condition_value,
            expected_printing=printing_value,
        )


def assert_justtcg_production_terms(
    terms: SourceTerms,
    *,
    at: datetime,
    paid_subscription_active: bool,
) -> None:
    """Require the paid-tier license and every public capability used by CollectFolio."""

    if not isinstance(terms, SourceTerms):
        raise ValueError("terms must be SourceTerms")
    instant = _utc(at, "at")
    if paid_subscription_active is not True:
        raise PermissionError("JustTCG production use requires an active paid subscription")
    if normalize_identity(terms.source_code) != "justtcg":
        raise PermissionError("source terms are not for JustTCG")
    if terms.reviewed_at > instant:
        raise PermissionError("JustTCG terms review is not yet effective")
    if terms.reviewed_at.date() < TERMS_MINIMUM_REVIEW_DATE:
        raise PermissionError("JustTCG terms review predates the current paid-tier license")
    if terms.expires_at is None:
        raise PermissionError("JustTCG production approval requires an explicit expiry")
    for usage_kind in ("catalog", "raw_price", "derived_feature"):
        if not terms.permits_public_usage(usage_kind, instant):
            raise PermissionError(f"JustTCG terms do not permit {usage_kind} usage")


def prepare_justtcg_observation_batch(
    snapshot: JustTCGSnapshot,
    mappings: Iterable[ObservationMapping],
    terms: SourceTerms,
    history_by_variant: Mapping[str, Iterable[PriceObservation]],
    *,
    ingestion_run_id: str,
    ingested_at: datetime,
    paid_subscription_active: bool,
    actor_label: str = "justtcg-licensed-ingestion",
    quality_score: float = 0.90,
    policy: ObservationQualityPolicy = ObservationQualityPolicy(),
) -> ObservationBatch:
    if not isinstance(snapshot, JustTCGSnapshot):
        raise ValueError("snapshot must be a JustTCGSnapshot")
    instant = _utc(ingested_at, "ingested_at")
    assert_justtcg_production_terms(
        terms,
        at=instant,
        paid_subscription_active=paid_subscription_active,
    )
    return prepare_observation_batch(
        snapshot.raw_price_records(quality_score=quality_score),
        mappings,
        terms,
        history_by_variant,
        ingestion_run_id=ingestion_run_id,
        ingested_at=instant,
        actor_label=actor_label,
        policy=policy,
    )
