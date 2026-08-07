"""Forensic reproduction of the legacy video formula; never a forecast."""

from __future__ import annotations

from dataclasses import dataclass
from math import exp, isfinite

MODEL_KEY = "video_model_v0"
INTERCEPT = 2.418749626
PULL_SCORE_COEFFICIENT = 0.177451739
DESIRABILITY_COEFFICIENT = 0.341586702
LEGACY_PULL_COST_SCALE = 18_446.0


@dataclass(frozen=True, slots=True)
class VideoModelV0Audit:
    model_key: str
    pull_cost: float
    pull_score: float
    desirability: float
    log_price: float
    reconstructed_price: float
    research_only: bool = True


def evaluate_video_model_v0(pull_cost: float, desirability: float) -> VideoModelV0Audit:
    """Evaluate the exact PRD coefficients for reproduction and ablation only."""

    if isinstance(pull_cost, bool) or not isfinite(pull_cost) or pull_cost < 0:
        raise ValueError("pull_cost must be finite and non-negative")
    if isinstance(desirability, bool) or not isfinite(desirability):
        raise ValueError("desirability must be finite")
    pull_score = 10 * float(pull_cost) / LEGACY_PULL_COST_SCALE
    log_price = (
        INTERCEPT
        + PULL_SCORE_COEFFICIENT * pull_score
        + DESIRABILITY_COEFFICIENT * float(desirability)
    )
    return VideoModelV0Audit(
        model_key=MODEL_KEY,
        pull_cost=float(pull_cost),
        pull_score=pull_score,
        desirability=float(desirability),
        log_price=log_price,
        reconstructed_price=exp(log_price),
    )

