"""Robust, regularized structural fair-value research model.

This layer explains the current cross-sectional log price from point-in-time
scarcity, lifecycle, demand, artwork, character, and cohort inputs.  It is not
a future-return forecast.  Later return models may test whether a fraction of
its price gap tends to close.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timezone
from hashlib import sha256
import json
from math import exp, isfinite, log
from statistics import median
from typing import Iterable, Mapping, Sequence

from .quantiles import REQUIRED_QUANTILES, validate_quantiles


def _utc(value: datetime, name: str) -> datetime:
    if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() is None:
        raise ValueError(f"{name} must be a timezone-aware datetime")
    return value.astimezone(timezone.utc)


def _number(value: float, name: str) -> float:
    if isinstance(value, bool):
        raise ValueError(f"{name} must be finite")
    try:
        numeric = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} must be finite") from exc
    if not isfinite(numeric):
        raise ValueError(f"{name} must be finite")
    return numeric


def _canonical_hash(value: object) -> str:
    body = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return sha256(body.encode("utf-8")).hexdigest()


def _quantile(values: Sequence[float], probability: float) -> float:
    if not values:
        raise ValueError("quantile requires evidence")
    ordered = sorted(float(value) for value in values)
    position = (len(ordered) - 1) * probability
    left = int(position)
    right = min(left + 1, len(ordered) - 1)
    fraction = position - left
    return ordered[left] * (1 - fraction) + ordered[right] * fraction


@dataclass(frozen=True, slots=True)
class StructuralFeatureRow:
    """One exact-variant structural row with explicit availability lineage."""

    variant_id: str
    cohort_key: str
    observed_at: datetime
    price_available_at: datetime
    current_price: float
    evidence_quality: float
    numeric_features: Mapping[str, float | None]
    categorical_features: Mapping[str, str | None]
    feature_timestamps: tuple[datetime, ...] = ()
    aggregate_source_variant_ids: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        for name in ("variant_id", "cohort_key"):
            value = str(getattr(self, name) or "").strip()
            if not value:
                raise ValueError(f"{name} must be non-empty")
            object.__setattr__(self, name, value)
        observed = _utc(self.observed_at, "observed_at")
        available = _utc(self.price_available_at, "price_available_at")
        if available < observed:
            raise ValueError("price_available_at cannot precede observed_at")
        object.__setattr__(self, "observed_at", observed)
        object.__setattr__(self, "price_available_at", available)
        price = _number(self.current_price, "current_price")
        if price <= 0:
            raise ValueError("current_price must be positive")
        object.__setattr__(self, "current_price", price)
        quality = _number(self.evidence_quality, "evidence_quality")
        if not 0 <= quality <= 1:
            raise ValueError("evidence_quality must be between zero and one")
        object.__setattr__(self, "evidence_quality", quality)
        if not isinstance(self.numeric_features, Mapping) or not isinstance(self.categorical_features, Mapping):
            raise ValueError("feature bundles must be mappings")
        numeric: dict[str, float | None] = {}
        for raw_name, raw_value in self.numeric_features.items():
            name = str(raw_name or "").strip()
            if not name:
                raise ValueError("numeric feature names must be non-empty")
            numeric[name] = None if raw_value is None else _number(raw_value, name)
        categories: dict[str, str | None] = {}
        for raw_name, raw_value in self.categorical_features.items():
            name = str(raw_name or "").strip()
            if not name:
                raise ValueError("categorical feature names must be non-empty")
            value = None if raw_value is None else str(raw_value).strip()
            categories[name] = value or None
        object.__setattr__(self, "numeric_features", numeric)
        object.__setattr__(self, "categorical_features", categories)
        timestamps = tuple(_utc(value, "feature_timestamp") for value in self.feature_timestamps)
        if any(value > observed for value in timestamps):
            raise ValueError("feature timestamp exceeds structural observation time")
        object.__setattr__(self, "feature_timestamps", timestamps)
        sources = tuple(str(value).strip() for value in self.aggregate_source_variant_ids if str(value).strip())
        if self.variant_id in sources:
            raise ValueError("target variant cannot contribute to its own aggregate feature")
        object.__setattr__(self, "aggregate_source_variant_ids", sources)


@dataclass(frozen=True, slots=True)
class StructuralModelPolicy:
    minimum_training_rows: int = 40
    minimum_calibration_rows: int = 12
    calibration_fraction: float = 0.25
    ridge_penalty: float = 2.0
    minimum_category_rows: int = 3
    huber_delta: float = 1.5
    robust_iterations: int = 3
    maximum_features: int = 240

    def __post_init__(self) -> None:
        for name in (
            "minimum_training_rows", "minimum_calibration_rows", "minimum_category_rows",
            "robust_iterations", "maximum_features",
        ):
            value = getattr(self, name)
            if isinstance(value, bool) or not isinstance(value, int) or value < 1:
                raise ValueError(f"{name} must be a positive integer")
        fraction = _number(self.calibration_fraction, "calibration_fraction")
        if not 0 < fraction < 0.5:
            raise ValueError("calibration_fraction must be between zero and 0.5")
        for name in ("ridge_penalty", "huber_delta"):
            if _number(getattr(self, name), name) <= 0:
                raise ValueError(f"{name} must be positive")

    def as_dict(self) -> dict[str, object]:
        return {
            "minimumTrainingRows": self.minimum_training_rows,
            "minimumCalibrationRows": self.minimum_calibration_rows,
            "calibrationFraction": self.calibration_fraction,
            "ridgePenalty": self.ridge_penalty,
            "minimumCategoryRows": self.minimum_category_rows,
            "huberDelta": self.huber_delta,
            "robustIterations": self.robust_iterations,
            "maximumFeatures": self.maximum_features,
        }


def _solve(matrix: list[list[float]], target: list[float]) -> list[float]:
    size = len(target)
    augmented = [row[:] + [target[index]] for index, row in enumerate(matrix)]
    for column in range(size):
        pivot = max(range(column, size), key=lambda row: abs(augmented[row][column]))
        if abs(augmented[pivot][column]) < 1e-12:
            raise ValueError("structural design matrix is singular")
        augmented[column], augmented[pivot] = augmented[pivot], augmented[column]
        divisor = augmented[column][column]
        augmented[column] = [value / divisor for value in augmented[column]]
        for row in range(size):
            if row == column:
                continue
            multiplier = augmented[row][column]
            if multiplier:
                augmented[row] = [
                    value - multiplier * pivot_value
                    for value, pivot_value in zip(augmented[row], augmented[column])
                ]
    return [augmented[index][-1] for index in range(size)]


def _ridge_fit(
    design: Sequence[Sequence[float]],
    targets: Sequence[float],
    policy: StructuralModelPolicy,
) -> tuple[float, ...]:
    width = len(design[0])
    weights = [1.0] * len(design)
    coefficients = [0.0] * width
    for _ in range(policy.robust_iterations):
        matrix = [[0.0] * width for _ in range(width)]
        vector = [0.0] * width
        for row, target, weight in zip(design, targets, weights):
            for left in range(width):
                vector[left] += weight * row[left] * target
                for right in range(left, width):
                    value = weight * row[left] * row[right]
                    matrix[left][right] += value
                    if right != left:
                        matrix[right][left] += value
        for index in range(1, width):
            matrix[index][index] += policy.ridge_penalty
        coefficients = _solve(matrix, vector)
        residuals = [
            target - sum(value * coefficient for value, coefficient in zip(row, coefficients))
            for row, target in zip(design, targets)
        ]
        center = median(residuals)
        scale = max(1e-6, 1.4826 * median(abs(value - center) for value in residuals))
        limit = policy.huber_delta * scale
        weights = [1.0 if abs(value - center) <= limit else limit / abs(value - center) for value in residuals]
    return tuple(coefficients)


@dataclass(frozen=True, slots=True)
class StructuralFairValueModel:
    model_version: str
    training_cutoff: datetime
    numeric_names: tuple[str, ...]
    numeric_centers: Mapping[str, float]
    numeric_scales: Mapping[str, float]
    categorical_levels: tuple[tuple[str, str], ...]
    coefficients: tuple[float, ...]
    residual_quantiles: Mapping[float, float]
    training_count: int
    calibration_count: int
    status: str
    reason_codes: tuple[str, ...]
    policy: StructuralModelPolicy
    artifact_hash: str
    public_publication_allowed: bool = False

    def vector(self, row: StructuralFeatureRow) -> tuple[float, ...]:
        values = [1.0]
        for name in self.numeric_names:
            value = row.numeric_features.get(name)
            values.append(0.0 if value is None else (value - self.numeric_centers[name]) / self.numeric_scales[name])
            values.append(float(value is None))
        values.extend(float(row.categorical_features.get(name) == level) for name, level in self.categorical_levels)
        return tuple(values)

    def predict_log_price(self, row: StructuralFeatureRow) -> float:
        return sum(value * coefficient for value, coefficient in zip(self.vector(row), self.coefficients))


def fit_structural_fair_value(
    rows: Iterable[StructuralFeatureRow],
    training_cutoff: datetime,
    *,
    policy: StructuralModelPolicy = StructuralModelPolicy(),
    model_version: str = "structural-ridge-huber-v1",
) -> StructuralFairValueModel:
    """Fit on an early block and calibrate price ranges on a disjoint later block."""

    cutoff = _utc(training_cutoff, "training_cutoff")
    values = tuple(
        row for row in rows
        if isinstance(row, StructuralFeatureRow)
        and row.observed_at < cutoff
        and row.price_available_at <= cutoff
    )
    if len(values) < 2:
        raise ValueError("at least two eligible structural rows are required")
    ordered = tuple(sorted(values, key=lambda row: (row.observed_at, row.variant_id)))
    calibration_count = max(1, int(len(ordered) * policy.calibration_fraction))
    calibration_count = min(calibration_count, len(ordered) - 1)
    training = ordered[:-calibration_count]
    calibration = ordered[-calibration_count:]

    numeric_names = tuple(sorted({name for row in training for name in row.numeric_features}))
    centers: dict[str, float] = {}
    scales: dict[str, float] = {}
    for name in numeric_names:
        observed = [row.numeric_features[name] for row in training if row.numeric_features.get(name) is not None]
        centers[name] = float(median(observed)) if observed else 0.0
        if len(observed) >= 2:
            scale = (_quantile(observed, 0.75) - _quantile(observed, 0.25)) / 1.349
            scales[name] = max(abs(scale), 1e-6)
        else:
            scales[name] = 1.0
    category_counts = Counter(
        (name, value)
        for row in training
        for name, value in row.categorical_features.items()
        if value is not None
    )
    category_levels = tuple(sorted(
        key for key, count in category_counts.items()
        if count >= policy.minimum_category_rows
    ))
    maximum_category_features = max(0, policy.maximum_features - 1 - 2 * len(numeric_names))
    category_levels = category_levels[:maximum_category_features]

    def vector(row: StructuralFeatureRow) -> tuple[float, ...]:
        result = [1.0]
        for name in numeric_names:
            value = row.numeric_features.get(name)
            result.append(0.0 if value is None else (value - centers[name]) / scales[name])
            result.append(float(value is None))
        result.extend(float(row.categorical_features.get(name) == level) for name, level in category_levels)
        return tuple(result)

    design = tuple(vector(row) for row in training)
    targets = tuple(log(row.current_price) for row in training)
    coefficients = _ridge_fit(design, targets, policy)
    calibration_residuals = [
        log(row.current_price) - sum(value * coefficient for value, coefficient in zip(vector(row), coefficients))
        for row in calibration
    ]
    residual_quantiles = {
        probability: _quantile(calibration_residuals, probability)
        for probability in REQUIRED_QUANTILES
    }
    reasons = ["structural_model_only", "operator_model_review_required"]
    if len(training) < policy.minimum_training_rows:
        reasons.append("insufficient_training_rows")
    if len(calibration) < policy.minimum_calibration_rows:
        reasons.append("insufficient_calibration_rows")
    status = "quarantined" if any(value.startswith("insufficient_") for value in reasons) else "research_only"
    artifact = {
        "modelVersion": model_version,
        "trainingCutoff": cutoff.isoformat(),
        "numericNames": numeric_names,
        "centers": centers,
        "scales": scales,
        "categoricalLevels": category_levels,
        "coefficients": coefficients,
        "residualQuantiles": residual_quantiles,
        "trainingRows": [(row.variant_id, row.observed_at.isoformat()) for row in training],
        "calibrationRows": [(row.variant_id, row.observed_at.isoformat()) for row in calibration],
        "policy": policy.as_dict(),
    }
    return StructuralFairValueModel(
        model_version,
        cutoff,
        numeric_names,
        centers,
        scales,
        category_levels,
        coefficients,
        residual_quantiles,
        len(training),
        len(calibration),
        status,
        tuple(reasons),
        policy,
        _canonical_hash(artifact),
    )


@dataclass(frozen=True, slots=True)
class StructuralFairValueEstimate:
    variant_id: str
    observed_price: float
    quantiles: Mapping[float, float]
    position: str
    confidence: float
    status: str
    reason_codes: tuple[str, ...]
    model_version: str
    artifact_hash: str
    public_publication_allowed: bool = False

    def __post_init__(self) -> None:
        validated = dict(validate_quantiles(self.quantiles, required=REQUIRED_QUANTILES))
        if any(value <= 0 for value in validated.values()):
            raise ValueError("structural price quantiles must be positive")
        object.__setattr__(self, "quantiles", validated)


def estimate_structural_fair_value(
    model: StructuralFairValueModel,
    row: StructuralFeatureRow,
    forecast_origin: datetime,
) -> StructuralFairValueEstimate:
    """Estimate a structural range only from features available at origin."""

    if not isinstance(model, StructuralFairValueModel) or not isinstance(row, StructuralFeatureRow):
        raise ValueError("model and row must use structural-value contracts")
    origin = _utc(forecast_origin, "forecast_origin")
    if model.training_cutoff > origin:
        raise ValueError("model training cutoff exceeds forecast origin")
    if row.observed_at > origin or row.price_available_at > origin or any(
        timestamp > origin for timestamp in row.feature_timestamps
    ):
        raise ValueError("structural row was not fully available at forecast origin")
    center = model.predict_log_price(row)
    quantiles = {
        probability: exp(center + model.residual_quantiles[probability])
        for probability in REQUIRED_QUANTILES
    }
    ordered = sorted(quantiles.values())
    quantiles = {
        probability: ordered[index]
        for index, probability in enumerate(REQUIRED_QUANTILES)
    }
    if row.current_price < quantiles[0.25]:
        position = "below_range"
    elif row.current_price > quantiles[0.75]:
        position = "above_range"
    else:
        position = "within_range"
    support = min(
        1.0,
        model.training_count / max(1, model.policy.minimum_training_rows * 2),
        model.calibration_count / max(1, model.policy.minimum_calibration_rows * 2),
    )
    confidence = 0.0 if model.status == "quarantined" else min(79.0, 100 * row.evidence_quality * support)
    return StructuralFairValueEstimate(
        row.variant_id,
        row.current_price,
        quantiles,
        position,
        confidence,
        model.status,
        model.reason_codes,
        model.model_version,
        model.artifact_hash,
    )
