"""Rights-gated bulk catalog seed from pokemon-tcg-data-shaped exports.

Parses an operator-downloaded set/card export (the layout published by the
``PokemonTCG/pokemon-tcg-data`` repository: one sets array, one cards array
per set) into deterministic canonical identity rows using the same
``CanonicalSet``/``CanonicalCard``/``CanonicalVariant`` primitives the
mapping pipeline uses, so a later source mapping resolves to identical UUIDs.

This module is deliberately parked behind the PRD Sec 36.4 rights gate:

- It refuses to run without an explicit rights acknowledgment whose review
  decision is ``research_only`` or ``approved`` AND whose
  ``catalog_metadata_allowed`` flag is true. Catalog identity tables are
  private operational data (migration 0002); public display remains
  separately gated by the publication boundary regardless of this seed.
- It never fetches anything. The operator downloads the export, records the
  review, and runs the CLI locally; the packet is reviewed before any SQL
  is generated or applied.
- Card imagery is intentionally NOT ingested — image rights are reviewed
  separately (PRD Sec 16.3), and the packet carries no image URLs.
- Every card receives exactly one ``unspecified``-finish variant as an
  identity placeholder. Exact finishes attach later through the
  operator-reviewed external-mapping flow; the packet says so explicitly.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timezone
from hashlib import sha256
import json
from typing import Mapping, Sequence

from .catalog_mapping import CanonicalCard, CanonicalSet, CanonicalVariant, validate_catalog

MAX_SETS_PER_PACKET = 50
MAX_CARDS_PER_SET = 1_000
ALLOWED_DECISIONS = ("research_only", "approved")


@dataclass(frozen=True, slots=True)
class CatalogSeedRights:
    """Explicit acknowledgment of the source review this seed relies on."""

    source_code: str
    terms_url: str
    review_decision: str
    catalog_metadata_allowed: bool
    reviewed_at: str
    document_hash: str

    def __post_init__(self) -> None:
        for name in ("source_code", "terms_url", "reviewed_at", "document_hash"):
            if not str(getattr(self, name) or "").strip():
                raise ValueError(f"{name} is required")
        if self.review_decision not in ALLOWED_DECISIONS:
            raise ValueError(
                "review_decision must be research_only or approved; a pending or "
                "rejected review cannot seed the catalog"
            )
        if self.catalog_metadata_allowed is not True:
            raise ValueError("catalog_metadata_allowed must be explicitly true to seed catalog identity")

    def audit_row(self) -> dict[str, object]:
        return {
            "source_code": self.source_code,
            "terms_url": self.terms_url,
            "review_decision": self.review_decision,
            "catalog_metadata_allowed": True,
            "reviewed_at": self.reviewed_at,
            "document_hash": self.document_hash,
        }


def _text(payload: Mapping[str, object], key: str, *, required: bool = False) -> str:
    value = str(payload.get(key) or "").strip()
    if required and not value:
        raise ValueError(f"catalog payload entry is missing required field {key!r}")
    return value


def _release_date(payload: Mapping[str, object]) -> date | None:
    raw = _text(payload, "releaseDate")
    if not raw:
        return None
    try:
        return date.fromisoformat(raw.replace("/", "-"))
    except ValueError as exc:
        raise ValueError(f"releaseDate {raw!r} is not a valid date") from exc


def parse_set(payload: Mapping[str, object]) -> CanonicalSet:
    if not isinstance(payload, Mapping):
        raise ValueError("set payload must be an object")
    return CanonicalSet.build(
        game="pokemon",
        language="en",
        set_code=_text(payload, "id", required=True),
        name=_text(payload, "name", required=True),
        series=_text(payload, "series"),
        release_date=_release_date(payload),
    )


def parse_cards(canonical_set: CanonicalSet, payloads: Sequence[Mapping[str, object]]) -> tuple[CanonicalCard, ...]:
    if len(payloads) > MAX_CARDS_PER_SET:
        raise ValueError(f"a set may contribute at most {MAX_CARDS_PER_SET} cards per packet")
    cards = []
    seen: set[str] = set()
    for payload in payloads:
        if not isinstance(payload, Mapping):
            raise ValueError("card payload must be an object")
        card = CanonicalCard.build(
            canonical_set,
            name=_text(payload, "name", required=True),
            number=_text(payload, "number", required=True),
            rarity=_text(payload, "rarity"),
            artist=_text(payload, "artist"),
        )
        if card.canonical_key in seen:
            raise ValueError(f"duplicate card identity {card.canonical_key!r} in set payload")
        seen.add(card.canonical_key)
        cards.append(card)
    return tuple(cards)


def placeholder_variants(cards: Sequence[CanonicalCard]) -> tuple[CanonicalVariant, ...]:
    """One unspecified-finish identity placeholder per card (see module doc)."""

    return validate_catalog(
        CanonicalVariant.build(card, finish="unspecified") for card in cards
    )


def _packet_hash(value: object) -> str:
    return sha256(
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def build_catalog_seed_packet(
    rights: CatalogSeedRights,
    sets_payload: Sequence[Mapping[str, object]],
    cards_by_set_code: Mapping[str, Sequence[Mapping[str, object]]],
    *,
    generated_at: datetime,
) -> dict[str, object]:
    """Deterministic, reviewable seed packet. Emits rows; writes nothing."""

    if not isinstance(rights, CatalogSeedRights):
        raise ValueError("rights must be a CatalogSeedRights acknowledgment")
    if not isinstance(generated_at, datetime) or generated_at.tzinfo is None:
        raise ValueError("generated_at must be timezone-aware")
    if not sets_payload:
        raise ValueError("at least one set payload is required")
    if len(sets_payload) > MAX_SETS_PER_PACKET:
        raise ValueError(f"a packet may seed at most {MAX_SETS_PER_PACKET} sets")

    sets: list[CanonicalSet] = []
    cards: list[CanonicalCard] = []
    variants: list[CanonicalVariant] = []
    seen_sets: set[str] = set()
    for payload in sets_payload:
        canonical_set = parse_set(payload)
        if canonical_set.canonical_key in seen_sets:
            raise ValueError(f"duplicate set identity {canonical_set.canonical_key!r}")
        seen_sets.add(canonical_set.canonical_key)
        raw_code = _text(payload, "id", required=True)
        set_cards = cards_by_set_code.get(raw_code)
        if set_cards is None:
            raise ValueError(f"cards payload for set {raw_code!r} is missing")
        parsed_cards = parse_cards(canonical_set, set_cards)
        if not parsed_cards:
            raise ValueError(f"set {raw_code!r} contributed no cards; remove it from the manifest")
        sets.append(canonical_set)
        cards.extend(parsed_cards)
        variants.extend(placeholder_variants(parsed_cards))

    rows = {
        "catalog_sets": [entry.database_row() for entry in sets],
        "catalog_cards": [entry.database_row() for entry in cards],
        "catalog_variants": [entry.database_row() for entry in variants],
    }
    packet = {
        "mode": "research_only_catalog_seed",
        "rights": rights.audit_row(),
        "generated_at": generated_at.astimezone(timezone.utc).isoformat(),
        "counts": {
            "sets": len(sets),
            "cards": len(cards),
            "variants": len(variants),
        },
        "rows": rows,
        "notes": [
            "Variants are unspecified-finish identity placeholders; exact finishes "
            "attach through the operator-reviewed external-mapping flow.",
            "No imagery is ingested; image rights are reviewed separately.",
            "Applying this packet to a hosted project requires a separate "
            "operator-reviewed SQL step; this packet writes nothing.",
        ],
        "public_display_candidates": [],
        "review_required": True,
    }
    packet["packet_hash"] = _packet_hash(rows)
    return packet
