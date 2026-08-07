"""Curated pull-rate registry validation (PRD Sec 15.5, 19.4).

Pull-rate observations come from published pack-opening studies, not
scraping. This module validates operator-curated entries against the PRD's
own scarcity math (``scarcity.py``) before they can become database rows:
the published one-in-packs figure must agree with the published probability,
confidence intervals must bracket the point estimate, and card-specific
probabilities exist only when an eligible-card count and the explicit
equal-distribution acknowledgment travel with them.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timezone
from hashlib import sha256
import json
from typing import Mapping, Sequence
from uuid import uuid5

from .catalog_mapping import CATALOG_NAMESPACE
from .scarcity import pull_metrics

ONE_IN_PACKS_RELATIVE_TOLERANCE = 0.15
CONFIDENCE_GRADES = ("high", "medium", "low")


@dataclass(frozen=True, slots=True)
class PullRateSource:
    publisher: str
    title: str
    url: str
    retrieved_at: datetime
    sample_size: int
    confidence_grade: str
    published_at: date | None = None
    methodology: str = ""
    region: str = "us"
    language: str = "en"

    def __post_init__(self) -> None:
        for name in ("publisher", "title"):
            if not str(getattr(self, name) or "").strip():
                raise ValueError(f"{name} is required")
        if not str(self.url or "").startswith("https://"):
            raise ValueError("url must be an https URL")
        if not isinstance(self.retrieved_at, datetime) or self.retrieved_at.tzinfo is None:
            raise ValueError("retrieved_at must be timezone-aware")
        if isinstance(self.sample_size, bool) or not isinstance(self.sample_size, int) or self.sample_size <= 0:
            raise ValueError("sample_size must be a positive integer")
        if self.confidence_grade not in CONFIDENCE_GRADES:
            raise ValueError(f"confidence_grade must be one of {CONFIDENCE_GRADES}")

    @property
    def id(self) -> str:
        return str(uuid5(CATALOG_NAMESPACE, f"pull-source|{self.url}|{self.retrieved_at.astimezone(timezone.utc).isoformat()}"))

    def database_row(self) -> dict[str, object]:
        return {
            "id": self.id,
            "publisher": self.publisher,
            "title": self.title,
            "url": self.url,
            "published_at": self.published_at.isoformat() if self.published_at else None,
            "retrieved_at": self.retrieved_at.astimezone(timezone.utc).isoformat(),
            "sample_size": self.sample_size,
            "methodology": self.methodology,
            "region": self.region,
            "language": self.language,
            "confidence_grade": self.confidence_grade,
        }


def _probability(value: object, name: str) -> float:
    if isinstance(value, bool):
        raise ValueError(f"{name} must be a number inside (0, 1]")
    try:
        parsed = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} must be a number inside (0, 1]") from exc
    if not 0 < parsed <= 1:
        raise ValueError(f"{name} must be a number inside (0, 1]")
    return parsed


@dataclass(frozen=True, slots=True)
class SetPullRateEntry:
    set_id: str
    rarity_slot: str
    probability: float
    one_in_packs: float
    effective_from: date
    version: int = 1
    ci_lower: float | None = None
    ci_upper: float | None = None
    eligible_count: int | None = None
    equal_distribution_assumed: bool = False
    collation_notes: str = ""
    effective_to: date | None = None

    def __post_init__(self) -> None:
        if not str(self.set_id or "").strip():
            raise ValueError("set_id is required")
        if not str(self.rarity_slot or "").strip():
            raise ValueError("rarity_slot is required")
        probability = _probability(self.probability, "probability")
        if self.ci_lower is not None and not 0 < float(self.ci_lower) <= probability:
            raise ValueError("ci_lower must bracket the probability from below")
        if self.ci_upper is not None and not probability <= float(self.ci_upper) <= 1:
            raise ValueError("ci_upper must bracket the probability from above")
        if (self.ci_lower is None) != (self.ci_upper is None):
            raise ValueError("confidence-interval bounds must be provided together")
        expected = 1 / probability
        if abs(float(self.one_in_packs) - expected) > expected * ONE_IN_PACKS_RELATIVE_TOLERANCE:
            raise ValueError(
                "one_in_packs disagrees with probability beyond the "
                f"{int(ONE_IN_PACKS_RELATIVE_TOLERANCE * 100)}% rounding tolerance"
            )
        if not isinstance(self.effective_from, date):
            raise ValueError("effective_from must be a date")
        if self.effective_to is not None and self.effective_to <= self.effective_from:
            raise ValueError("effective_to must be after effective_from")
        if isinstance(self.version, bool) or not isinstance(self.version, int) or self.version < 1:
            raise ValueError("version must be a positive integer")
        if self.eligible_count is not None and self.equal_distribution_assumed is not True:
            raise ValueError(
                "card-specific probabilities require the explicit equal-distribution acknowledgment"
            )

    def scarcity(self):
        """Card-specific scarcity via the PRD formulas, when derivable."""

        if self.eligible_count is None:
            return None
        return pull_metrics(
            float(self.probability), self.eligible_count,
            equal_distribution_assumed=True,
        )

    def database_row(self, source: PullRateSource) -> dict[str, object]:
        metrics = self.scarcity()
        identity = f"pull-rate|{self.set_id}|{self.rarity_slot}|{source.id}|{self.version}"
        return {
            "id": str(uuid5(CATALOG_NAMESPACE, identity)),
            "set_id": self.set_id,
            "source_id": source.id,
            "rarity_slot": self.rarity_slot,
            "probability": float(self.probability),
            "ci_lower": None if self.ci_lower is None else float(self.ci_lower),
            "ci_upper": None if self.ci_upper is None else float(self.ci_upper),
            "one_in_packs": float(self.one_in_packs),
            "eligible_count": self.eligible_count,
            "specific_probability": None if metrics is None else metrics.specific_card_probability,
            "specific_one_in_packs": None if metrics is None else metrics.expected_packs,
            "equal_distribution_assumed": bool(self.equal_distribution_assumed),
            "collation_notes": self.collation_notes,
            "effective_from": self.effective_from.isoformat(),
            "effective_to": self.effective_to.isoformat() if self.effective_to else None,
            "version": self.version,
        }


def build_pull_rate_packet(
    source: PullRateSource,
    entries: Sequence[SetPullRateEntry],
    *,
    generated_at: datetime,
) -> dict[str, object]:
    """Deterministic, reviewable registry packet. Emits rows; writes nothing."""

    if not isinstance(source, PullRateSource):
        raise ValueError("source must be a PullRateSource")
    if not entries:
        raise ValueError("at least one pull-rate entry is required")
    if any(not isinstance(entry, SetPullRateEntry) for entry in entries):
        raise ValueError("entries must contain SetPullRateEntry values")
    if not isinstance(generated_at, datetime) or generated_at.tzinfo is None:
        raise ValueError("generated_at must be timezone-aware")
    identities = [(entry.set_id, entry.rarity_slot, entry.version) for entry in entries]
    if len(set(identities)) != len(identities):
        raise ValueError("entries must not repeat a set/rarity-slot/version identity")

    rows = {
        "pull_rate_sources": [source.database_row()],
        "set_pull_rates": [entry.database_row(source) for entry in entries],
    }
    return {
        "mode": "research_only_pull_rate_registry",
        "generated_at": generated_at.astimezone(timezone.utc).isoformat(),
        "counts": {"sources": 1, "entries": len(entries)},
        "rows": rows,
        "review_required": True,
        "public_display_candidates": [],
        "packet_hash": sha256(
            json.dumps(rows, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
        ).hexdigest(),
    }


def entry_from_mapping(payload: Mapping[str, object]) -> SetPullRateEntry:
    """Builds a validated entry from a curated JSON object."""

    if not isinstance(payload, Mapping):
        raise ValueError("pull-rate entry must be an object")
    return SetPullRateEntry(
        set_id=str(payload.get("set_id") or ""),
        rarity_slot=str(payload.get("rarity_slot") or ""),
        probability=payload.get("probability"),
        one_in_packs=payload.get("one_in_packs"),
        effective_from=date.fromisoformat(str(payload.get("effective_from") or "")),
        version=payload.get("version", 1),
        ci_lower=payload.get("ci_lower"),
        ci_upper=payload.get("ci_upper"),
        eligible_count=payload.get("eligible_count"),
        equal_distribution_assumed=bool(payload.get("equal_distribution_assumed", False)),
        collation_notes=str(payload.get("collation_notes") or ""),
        effective_to=date.fromisoformat(str(payload["effective_to"])) if payload.get("effective_to") else None,
    )
