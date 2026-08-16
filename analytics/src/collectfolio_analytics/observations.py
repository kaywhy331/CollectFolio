"""Strict point-in-time price observation types and selection."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from math import isfinite
import re
from typing import Iterable
import unicodedata
from uuid import UUID


def _utc(value: datetime, field_name: str) -> datetime:
    if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() is None:
        raise ValueError(f"{field_name} must be a timezone-aware datetime")
    return value.astimezone(timezone.utc)


def _required_text(value: str, field_name: str, *, lower: bool = False) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field_name} must be non-empty")
    normalized = value.strip()
    return normalized.lower() if lower else normalized


def normalize_market_identity(value: str) -> str:
    """Canonicalize market-series fields without changing catalog UUID rules."""

    normalized = unicodedata.normalize("NFKC", str(value or "")).casefold().strip()
    return re.sub(r"[\W_]+", "-", normalized, flags=re.UNICODE).strip("-")


@dataclass(frozen=True, slots=True)
class PriceSeriesKey:
    """Exact market series identity; series with different semantics never mix."""

    canonical_variant_id: str
    source_id: str
    currency: str
    finish: str
    condition_class: str
    price_semantics: str
    language: str = "en"
    market_condition: str = "unspecified"

    def __post_init__(self) -> None:
        try:
            canonical_id = str(UUID(str(self.canonical_variant_id)))
        except (TypeError, ValueError, AttributeError) as exc:
            raise ValueError("canonical_variant_id must be a UUID") from exc
        object.__setattr__(self, "canonical_variant_id", canonical_id)
        object.__setattr__(self, "source_id", _required_text(self.source_id, "source_id"))
        currency = _required_text(self.currency, "currency").upper()
        if len(currency) != 3 or not currency.isalpha():
            raise ValueError("currency must be a three-letter code")
        object.__setattr__(self, "currency", currency)
        object.__setattr__(self, "finish", normalize_market_identity(_required_text(self.finish, "finish")))
        object.__setattr__(self, "condition_class", normalize_market_identity(_required_text(self.condition_class, "condition_class")))
        object.__setattr__(self, "price_semantics", normalize_market_identity(_required_text(self.price_semantics, "price_semantics")))
        object.__setattr__(self, "language", normalize_market_identity(_required_text(self.language, "language")))
        object.__setattr__(
            self,
            "market_condition",
            normalize_market_identity(_required_text(self.market_condition, "market_condition")),
        )

    @property
    def exact_identity(self) -> tuple[str, str, str, str, str, str, str, str]:
        """Stable identity used by storage, training, evaluation, and publication."""

        return (
            self.canonical_variant_id,
            self.source_id,
            self.currency,
            self.language,
            self.finish,
            self.condition_class,
            self.market_condition,
            self.price_semantics,
        )


@dataclass(frozen=True, slots=True)
class PriceObservation:
    """A price and the instant at which that value became knowable."""

    key: PriceSeriesKey
    observed_at: datetime
    available_at: datetime
    price: float
    quality: float = 1.0
    source_observation_id: str | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.key, PriceSeriesKey):
            raise ValueError("key must be a PriceSeriesKey")
        observed_at = _utc(self.observed_at, "observed_at")
        available_at = _utc(self.available_at, "available_at")
        if available_at < observed_at:
            raise ValueError("available_at cannot precede observed_at")
        if isinstance(self.price, bool) or not isfinite(self.price) or self.price <= 0:
            raise ValueError("price must be finite and positive")
        if isinstance(self.quality, bool) or not isfinite(self.quality) or not 0 <= self.quality <= 1:
            raise ValueError("quality must be between zero and one")
        if self.source_observation_id is not None and (
            not isinstance(self.source_observation_id, str) or not self.source_observation_id.strip()
        ):
            raise ValueError("source_observation_id must be a non-blank string or None")
        object.__setattr__(self, "observed_at", observed_at)
        object.__setattr__(self, "available_at", available_at)
        object.__setattr__(self, "price", float(self.price))
        object.__setattr__(self, "quality", float(self.quality))


def point_in_time_series(
    observations: Iterable[PriceObservation],
    feature_cutoff: datetime,
    *,
    key: PriceSeriesKey | None = None,
) -> tuple[PriceObservation, ...]:
    """Return the latest known revision per timestamp as of ``feature_cutoff``.

    When ``key`` is omitted, mixed exact identities are rejected. When supplied,
    observations for other keys are ignored so callers can safely select one
    series from a larger collection.
    """

    cutoff = _utc(feature_cutoff, "feature_cutoff")
    values = tuple(observations)
    if any(not isinstance(item, PriceObservation) for item in values):
        raise ValueError("observations must contain PriceObservation values")

    if key is None and values:
        key = values[0].key
        if any(item.key != key for item in values):
            raise ValueError("mixed price-series identities require an explicit key")

    eligible = (
        item for item in values
        if (key is None or item.key == key)
        and item.observed_at <= cutoff
        and item.available_at <= cutoff
    )
    revisions: dict[datetime, PriceObservation] = {}
    for item in eligible:
        current = revisions.get(item.observed_at)
        if current is None or (item.available_at, item.source_observation_id or "") > (
            current.available_at,
            current.source_observation_id or "",
        ):
            revisions[item.observed_at] = item
    return tuple(revisions[timestamp] for timestamp in sorted(revisions))
