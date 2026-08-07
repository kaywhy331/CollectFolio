"""Curated market-event registry and point-in-time event-age features
(PRD Sec 15.7, 23.6).

Events (reprints, restocks, anniversaries, media releases, tournament
relevance, rotation) are curated facts with a source URL, never scraped
guesses. The feature helper is strictly point-in-time: an event that had not
occurred by the feature cutoff does not exist for that origin, even if the
registry already contains it.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timezone
from hashlib import sha256
import json
from typing import Sequence
from uuid import uuid5

from .catalog_mapping import CATALOG_NAMESPACE

EVENT_TYPES = (
    "reprint", "restock", "anniversary", "media_release", "tournament",
    "rotation", "other",
)
SCOPES = ("set", "variant")


@dataclass(frozen=True, slots=True)
class MarketEvent:
    scope: str
    target_id: str
    event_type: str
    occurred_on: date
    title: str
    source_url: str
    announced_on: date | None = None
    notes: str = ""
    version: int = 1

    def __post_init__(self) -> None:
        if self.scope not in SCOPES:
            raise ValueError(f"scope must be one of {SCOPES}")
        if not str(self.target_id or "").strip():
            raise ValueError("target_id is required")
        if self.event_type not in EVENT_TYPES:
            raise ValueError(f"event_type must be one of {EVENT_TYPES}")
        if not isinstance(self.occurred_on, date):
            raise ValueError("occurred_on must be a date")
        if self.announced_on is not None and self.announced_on > self.occurred_on:
            raise ValueError("announced_on cannot be after occurred_on")
        if not str(self.title or "").strip():
            raise ValueError("title is required")
        if not str(self.source_url or "").startswith("https://"):
            raise ValueError("source_url must be an https URL")
        if isinstance(self.version, bool) or not isinstance(self.version, int) or self.version < 1:
            raise ValueError("version must be a positive integer")

    def database_row(self) -> dict[str, object]:
        identity = f"event|{self.scope}|{self.target_id}|{self.event_type}|{self.occurred_on.isoformat()}|{self.version}"
        return {
            "id": str(uuid5(CATALOG_NAMESPACE, identity)),
            "scope": self.scope,
            "set_id": self.target_id if self.scope == "set" else None,
            "variant_id": self.target_id if self.scope == "variant" else None,
            "event_type": self.event_type,
            "occurred_on": self.occurred_on.isoformat(),
            "announced_on": self.announced_on.isoformat() if self.announced_on else None,
            "title": self.title,
            "source_url": self.source_url,
            "notes": self.notes,
            "version": self.version,
        }


def event_age_days(
    events: Sequence[MarketEvent],
    event_type: str,
    as_of: date,
) -> int | None:
    """Days since the most recent matching event at or before ``as_of``.

    Returns None when no matching event had occurred yet — the PRD's
    lifecycle features represent absent events explicitly rather than as
    zero (Sec 23.6), and future-dated registry rows never leak backward
    into an earlier origin (Sec 25.4).
    """

    if event_type not in EVENT_TYPES:
        raise ValueError(f"event_type must be one of {EVENT_TYPES}")
    if not isinstance(as_of, date):
        raise ValueError("as_of must be a date")
    if any(not isinstance(event, MarketEvent) for event in events):
        raise ValueError("events must contain MarketEvent values")
    eligible = [
        event.occurred_on for event in events
        if event.event_type == event_type and event.occurred_on <= as_of
    ]
    if not eligible:
        return None
    return (as_of - max(eligible)).days


def build_event_packet(
    events: Sequence[MarketEvent],
    *,
    generated_at: datetime,
) -> dict[str, object]:
    if not events:
        raise ValueError("at least one market event is required")
    if any(not isinstance(entry, MarketEvent) for entry in events):
        raise ValueError("events must contain MarketEvent values")
    if not isinstance(generated_at, datetime) or generated_at.tzinfo is None:
        raise ValueError("generated_at must be timezone-aware")
    rows = [entry.database_row() for entry in events]
    if len({row["id"] for row in rows}) != len(rows):
        raise ValueError("events must not repeat a scope/target/type/date/version identity")
    payload = {"card_market_events": rows}
    return {
        "mode": "research_only_market_events",
        "generated_at": generated_at.astimezone(timezone.utc).isoformat(),
        "counts": {"events": len(rows)},
        "rows": payload,
        "review_required": True,
        "public_display_candidates": [],
        "packet_hash": sha256(
            json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
        ).hexdigest(),
    }
