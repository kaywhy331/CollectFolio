"""Free-tier storage budget evaluation (PRD Sec 28).

The operator measures per-area database usage (however they choose to map
tables to areas) and feeds the megabyte numbers here. The evaluator only
compares against the PRD's published allocation targets and flags breaches;
it never guesses a mapping, and unknown or unmeasured areas are surfaced
explicitly instead of silently ignored — a monitoring gap must look like a
gap, not like headroom.
"""

from __future__ import annotations

from typing import Mapping

# PRD Sec 28 pilot allocation targets (megabytes).
DEFAULT_BUDGETS_MB: Mapping[str, float] = {
    "existing_user_data": 75,
    "catalog_and_mappings": 75,
    "latest_prices": 25,
    "active_card_history": 75,
    "watchlists_alerts_events": 25,
    "model_outputs_and_metrics": 50,
    "headroom_and_index_growth": 25,
}
TOTAL_BUDGET_MB = 350
WARNING_RATIO = 0.8


def evaluate_storage_budget(
    measured_mb: Mapping[str, float],
    *,
    budgets_mb: Mapping[str, float] = DEFAULT_BUDGETS_MB,
    total_budget_mb: float = TOTAL_BUDGET_MB,
    warning_ratio: float = WARNING_RATIO,
) -> dict[str, object]:
    if not isinstance(measured_mb, Mapping):
        raise ValueError("measured_mb must be a mapping of area name to megabytes")
    if not 0 < warning_ratio < 1:
        raise ValueError("warning_ratio must be between zero and one")
    if total_budget_mb <= 0 or any(budget <= 0 for budget in budgets_mb.values()):
        raise ValueError("budgets must be positive")

    areas = []
    measured_total = 0.0
    for area in sorted(budgets_mb):
        budget = float(budgets_mb[area])
        raw = measured_mb.get(area)
        if raw is None:
            areas.append({"area": area, "measured_mb": None, "budget_mb": budget, "ratio": None, "status": "unmeasured"})
            continue
        value = float(raw)
        if value < 0:
            raise ValueError(f"measured megabytes for {area!r} cannot be negative")
        measured_total += value
        ratio = value / budget
        status = "exceeded" if ratio > 1 else "warning" if ratio >= warning_ratio else "ok"
        areas.append({"area": area, "measured_mb": value, "budget_mb": budget, "ratio": round(ratio, 4), "status": status})

    unknown_areas = sorted(set(measured_mb) - set(budgets_mb))
    for area in unknown_areas:
        value = float(measured_mb[area])
        if value < 0:
            raise ValueError(f"measured megabytes for {area!r} cannot be negative")
        measured_total += value

    total_ratio = measured_total / total_budget_mb
    unmeasured = [entry["area"] for entry in areas if entry["status"] == "unmeasured"]
    return {
        "areas": areas,
        "unknown_areas": unknown_areas,
        "total": {
            "measured_mb": round(measured_total, 3),
            "budget_mb": float(total_budget_mb),
            "ratio": round(total_ratio, 4),
            "status": "exceeded" if total_ratio > 1 else "warning" if total_ratio >= warning_ratio else "ok",
        },
        # A report with unmeasured or unknown areas is not a clean bill of
        # health, whatever the totals say.
        "complete": not unmeasured and not unknown_areas,
    }
