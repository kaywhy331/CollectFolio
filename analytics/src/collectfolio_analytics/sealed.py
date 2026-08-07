"""Sealed-product identity and price-snapshot validation (PRD Sec 15.6).

Sealed prices are kept separate from pull probability so scarcity features
can use both as independent variables instead of deriving one from the
other. Unit pack price is always recomputed here from the product's
packs-per-product; a curated row that disagrees with its own arithmetic is
refused rather than trusted.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from hashlib import sha256
import json
from typing import Sequence
from uuid import uuid5

from .catalog_mapping import CATALOG_NAMESPACE

PRODUCT_TYPES = (
    "loose_pack", "booster_box", "booster_bundle", "elite_trainer_box",
    "collection_box", "tin", "other",
)


@dataclass(frozen=True, slots=True)
class SealedProduct:
    set_id: str
    product_type: str
    name: str
    packs_per_product: int

    def __post_init__(self) -> None:
        if not str(self.set_id or "").strip():
            raise ValueError("set_id is required")
        if self.product_type not in PRODUCT_TYPES:
            raise ValueError(f"product_type must be one of {PRODUCT_TYPES}")
        if not str(self.name or "").strip():
            raise ValueError("name is required")
        if isinstance(self.packs_per_product, bool) or not isinstance(self.packs_per_product, int) or self.packs_per_product < 1:
            raise ValueError("packs_per_product must be a positive integer")

    @property
    def id(self) -> str:
        return str(uuid5(CATALOG_NAMESPACE, f"sealed|{self.set_id}|{self.product_type}|{self.name}"))

    def database_row(self) -> dict[str, object]:
        return {
            "id": self.id,
            "set_id": self.set_id,
            "product_type": self.product_type,
            "name": self.name,
            "packs_per_product": self.packs_per_product,
        }


def _positive(value: object, name: str) -> float:
    if isinstance(value, bool):
        raise ValueError(f"{name} must be a positive number")
    try:
        parsed = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} must be a positive number") from exc
    if not parsed > 0:
        raise ValueError(f"{name} must be a positive number")
    return parsed


@dataclass(frozen=True, slots=True)
class SealedPriceObservation:
    product: SealedProduct
    source_id: str
    market_price: float
    observed_at: datetime
    available_at: datetime
    currency: str = "USD"
    msrp: float | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.product, SealedProduct):
            raise ValueError("product must be a SealedProduct")
        if not str(self.source_id or "").strip():
            raise ValueError("source_id is required")
        _positive(self.market_price, "market_price")
        if self.msrp is not None and float(self.msrp) < 0:
            raise ValueError("msrp cannot be negative")
        for name in ("observed_at", "available_at"):
            value = getattr(self, name)
            if not isinstance(value, datetime) or value.tzinfo is None:
                raise ValueError(f"{name} must be timezone-aware")
        if self.available_at < self.observed_at:
            raise ValueError("available_at cannot precede observed_at")
        if not isinstance(self.currency, str) or len(self.currency) != 3 or not self.currency.isupper():
            raise ValueError("currency must be a three-letter uppercase code")

    @property
    def unit_pack_price(self) -> float:
        """Always derived, never trusted from input (PRD Sec 15.6)."""

        return float(self.market_price) / self.product.packs_per_product

    def database_row(self) -> dict[str, object]:
        observed = self.observed_at.astimezone(timezone.utc)
        identity = f"sealed-snapshot|{self.product.id}|{self.source_id}|{observed.isoformat()}"
        return {
            "id": str(uuid5(CATALOG_NAMESPACE, identity)),
            "product_id": self.product.id,
            "source_id": self.source_id,
            "currency": self.currency,
            "msrp": None if self.msrp is None else float(self.msrp),
            "market_price": float(self.market_price),
            "unit_pack_price": self.unit_pack_price,
            "observed_at": observed.isoformat(),
            "available_at": self.available_at.astimezone(timezone.utc).isoformat(),
        }


def build_sealed_packet(
    observations: Sequence[SealedPriceObservation],
    *,
    generated_at: datetime,
) -> dict[str, object]:
    if not observations:
        raise ValueError("at least one sealed price observation is required")
    if any(not isinstance(entry, SealedPriceObservation) for entry in observations):
        raise ValueError("observations must contain SealedPriceObservation values")
    if not isinstance(generated_at, datetime) or generated_at.tzinfo is None:
        raise ValueError("generated_at must be timezone-aware")
    products = {entry.product.id: entry.product.database_row() for entry in observations}
    snapshot_rows = [entry.database_row() for entry in observations]
    if len({row["id"] for row in snapshot_rows}) != len(snapshot_rows):
        raise ValueError("observations must not repeat a product/source/observed_at identity")
    rows = {
        "sealed_products": sorted(products.values(), key=lambda row: row["id"]),
        "sealed_price_snapshots": snapshot_rows,
    }
    return {
        "mode": "research_only_sealed_registry",
        "generated_at": generated_at.astimezone(timezone.utc).isoformat(),
        "counts": {"products": len(products), "snapshots": len(snapshot_rows)},
        "rows": rows,
        "review_required": True,
        "public_display_candidates": [],
        "packet_hash": sha256(
            json.dumps(rows, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
        ).hexdigest(),
    }
