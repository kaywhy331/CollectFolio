"""Forecast-quantile validation without silently repairing publications."""

from __future__ import annotations

from math import isfinite
from typing import Mapping

REQUIRED_QUANTILES = (0.10, 0.25, 0.50, 0.75, 0.90)


class QuantileOrderError(ValueError):
    """Raised when forecast quantiles cross."""


def _normalized(values: Mapping[float, float]) -> tuple[tuple[float, float], ...]:
    if not isinstance(values, Mapping):
        raise ValueError("quantiles must be a mapping")
    result: list[tuple[float, float]] = []
    for probability, value in values.items():
        if isinstance(probability, bool) or not isfinite(probability) or not 0 < probability < 1:
            raise ValueError("quantile probabilities must be finite and inside (0, 1)")
        if isinstance(value, bool) or not isfinite(value):
            raise ValueError("quantile values must be finite")
        result.append((float(probability), float(value)))
    if not result:
        raise ValueError("at least one quantile is required")
    result.sort()
    if len({probability for probability, _ in result}) != len(result):
        raise ValueError("quantile probabilities must be unique")
    return tuple(result)


def validate_quantiles(
    values: Mapping[float, float],
    *,
    required: tuple[float, ...] | None = REQUIRED_QUANTILES,
) -> tuple[tuple[float, float], ...]:
    """Validate presence and monotonic order, returning sorted pairs."""

    items = _normalized(values)
    available = {probability for probability, _ in items}
    if required is not None:
        missing = [probability for probability in required if probability not in available]
        if missing:
            raise ValueError(f"missing required quantiles: {missing}")
    if any(left[1] > right[1] for left, right in zip(items, items[1:])):
        raise QuantileOrderError("forecast quantiles must be nondecreasing")
    return items


def rearrange_quantiles(values: Mapping[float, float]) -> dict[float, float]:
    """Explicitly apply monotone rearrangement for research diagnostics.

    Publication code should validate and reject crossed quantiles rather than
    calling this function implicitly.
    """

    items = _normalized(values)
    ordered_values = sorted(value for _, value in items)
    return {
        probability: ordered_values[index]
        for index, (probability, _) in enumerate(items)
    }

