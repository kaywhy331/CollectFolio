"""Blind pairwise artwork scoring (PRD Sec 19.6, 23.5).

Artwork preference comes from blind pairwise votes, never from price. The
v0 scorer is a transparent win-rate with a Wilson score interval: the
snapshot carries the center estimate plus explicit lower/upper bounds and
the vote count, so downstream features always see the uncertainty (PRD:
"Blind pairwise artwork score. Vote count and uncertainty."). Variants
below the minimum appearance threshold produce no snapshot at all instead
of a noisy score.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from math import sqrt
from typing import Sequence

ARTWORK_MODEL_VERSION = "artwork_winrate_wilson_v0"
DEFAULT_MINIMUM_VOTES = 10
_Z_95 = 1.959963984540054


@dataclass(frozen=True, slots=True)
class PairwiseVote:
    variant_a_id: str
    variant_b_id: str
    winner_variant_id: str

    def __post_init__(self) -> None:
        for name in ("variant_a_id", "variant_b_id", "winner_variant_id"):
            if not str(getattr(self, name) or "").strip():
                raise ValueError(f"{name} is required")
        if self.variant_a_id == self.variant_b_id:
            raise ValueError("a vote must compare two different variants")
        if self.winner_variant_id not in (self.variant_a_id, self.variant_b_id):
            raise ValueError("winner_variant_id must be one of the two compared variants")


def wilson_interval(wins: int, total: int, *, z: float = _Z_95) -> tuple[float, float, float]:
    """(lower, center, upper) Wilson score interval for a win proportion."""

    if isinstance(wins, bool) or isinstance(total, bool) or not isinstance(wins, int) or not isinstance(total, int):
        raise ValueError("wins and total must be integers")
    if total < 1 or wins < 0 or wins > total:
        raise ValueError("wins must be between 0 and a positive total")
    proportion = wins / total
    denominator = 1 + z * z / total
    center = (proportion + z * z / (2 * total)) / denominator
    margin = (z / denominator) * sqrt(proportion * (1 - proportion) / total + z * z / (4 * total * total))
    return (max(0.0, center - margin), center, min(1.0, center + margin))


def artwork_scores(
    votes: Sequence[PairwiseVote],
    *,
    calculated_at: datetime,
    minimum_votes: int = DEFAULT_MINIMUM_VOTES,
    model_version: str = ARTWORK_MODEL_VERSION,
) -> tuple[dict[str, object], ...]:
    """Deterministic score-snapshot rows for sufficiently voted variants."""

    if any(not isinstance(vote, PairwiseVote) for vote in votes):
        raise ValueError("votes must contain PairwiseVote values")
    if not isinstance(calculated_at, datetime) or calculated_at.tzinfo is None:
        raise ValueError("calculated_at must be timezone-aware")
    if isinstance(minimum_votes, bool) or not isinstance(minimum_votes, int) or minimum_votes < 1:
        raise ValueError("minimum_votes must be a positive integer")

    appearances: dict[str, int] = {}
    wins: dict[str, int] = {}
    for vote in votes:
        for variant_id in (vote.variant_a_id, vote.variant_b_id):
            appearances[variant_id] = appearances.get(variant_id, 0) + 1
        wins[vote.winner_variant_id] = wins.get(vote.winner_variant_id, 0) + 1

    timestamp = calculated_at.astimezone(timezone.utc).isoformat()
    rows = []
    for variant_id in sorted(appearances):
        total = appearances[variant_id]
        if total < minimum_votes:
            continue
        lower, center, upper = wilson_interval(wins.get(variant_id, 0), total)
        rows.append({
            "variant_id": variant_id,
            "model_version": model_version,
            "score": round(center, 5),
            "lower_bound": round(lower, 5),
            "upper_bound": round(upper, 5),
            "vote_count": total,
            "calculated_at": timestamp,
        })
    return tuple(rows)
