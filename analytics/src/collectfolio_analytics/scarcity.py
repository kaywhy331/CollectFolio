"""Auditable pull-scarcity calculations from the PRD."""

from __future__ import annotations

from dataclasses import dataclass
from math import ceil, expm1, inf, isfinite, log, log1p, nextafter


@dataclass(frozen=True, slots=True)
class PullMetrics:
    rarity_probability: float
    eligible_card_count: int
    equal_distribution_assumed: bool
    specific_card_probability: float
    negative_log_specific_probability: float
    expected_packs: float
    packs_for_50_percent_hit: int
    packs_for_90_percent_hit: int
    packs_for_95_percent_hit: int


def _probability(value: float, name: str, *, allow_one: bool = True) -> float:
    if isinstance(value, bool):
        numeric = float("nan")
    else:
        try:
            numeric = float(value)
        except (TypeError, ValueError):
            numeric = float("nan")
    upper_ok = numeric <= 1 if allow_one else numeric < 1
    if not isfinite(numeric) or numeric <= 0 or not upper_ok:
        boundary = "(0, 1]" if allow_one else "(0, 1)"
        raise ValueError(f"{name} must be inside {boundary}")
    return numeric


def specific_card_probability(rarity_probability: float, eligible_card_count: int) -> float:
    rarity = _probability(rarity_probability, "rarity_probability")
    if isinstance(eligible_card_count, bool) or not isinstance(eligible_card_count, int) or eligible_card_count <= 0:
        raise ValueError("eligible_card_count must be a positive integer")
    return rarity / eligible_card_count


def hit_probability(specific_probability: float, packs: int) -> float:
    probability = _probability(specific_probability, "specific_probability")
    if isinstance(packs, bool) or not isinstance(packs, int) or packs < 0:
        raise ValueError("packs must be a non-negative integer")
    if packs == 0:
        return 0.0
    if probability == 1:
        return 1.0
    return float(-expm1(packs * log1p(-probability)))


def packs_for_hit_probability(specific_probability: float, target_probability: float) -> int:
    probability = _probability(specific_probability, "specific_probability")
    target = _probability(target_probability, "target_probability", allow_one=False)
    if probability == 1:
        return 1
    raw_count = log1p(-target) / log1p(-probability)
    return max(1, ceil(nextafter(raw_count, -inf)))


def pull_metrics(
    rarity_probability: float,
    eligible_card_count: int,
    *,
    equal_distribution_assumed: bool,
) -> PullMetrics:
    """Calculate scarcity only after explicitly acknowledging distribution."""

    if equal_distribution_assumed is not True:
        raise ValueError("the equal-distribution assumption must be explicit for this formula")
    specific = specific_card_probability(rarity_probability, eligible_card_count)
    return PullMetrics(
        rarity_probability=float(rarity_probability),
        eligible_card_count=eligible_card_count,
        equal_distribution_assumed=True,
        specific_card_probability=specific,
        negative_log_specific_probability=-log(specific),
        expected_packs=1 / specific,
        packs_for_50_percent_hit=packs_for_hit_probability(specific, 0.50),
        packs_for_90_percent_hit=packs_for_hit_probability(specific, 0.90),
        packs_for_95_percent_hit=packs_for_hit_probability(specific, 0.95),
    )
