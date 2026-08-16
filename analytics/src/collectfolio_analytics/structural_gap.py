"""Provider-native, current-origin structural-gap research lab.

This module estimates a cross-sectional current-price band.  It is deliberately
not a future-return model, a canonical-card mapper, or a publication surface.
Every prediction is held out by whole provider group and every peer aggregate
is compiled here with the target series mechanically excluded.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timezone
import csv
from hashlib import sha256
import inspect
from math import exp, isfinite, log
from pathlib import Path
from statistics import median
from typing import Iterable, Mapping, Sequence

from .tcgcsv_universe import (
    CATALOG_SNAPSHOT_CONTRACT_VERSION,
    UNIVERSE_CONTRACT_VERSION,
    TCGCSVUniverseError,
    canonical_json,
    content_hash,
    file_sha256,
)


STRUCTURAL_GAP_CONTRACT_VERSION = "tcgcsv-structural-gap-lab-v2"
STRUCTURAL_GAP_MODEL_VERSION = "provider-native-group-crossfit-ridge-huber-v2"
STRUCTURAL_GAP_SOLVER_VERSION = "numpy-float64-ridge-huber-irls-v1"
COEFFICIENT_DECIMAL_PLACES = 12
REQUIRED_QUANTILES = (0.10, 0.25, 0.50, 0.75, 0.90)
ALLOWED_TELEMETRY_LABELS = frozenset({"structural_gap", "persistent_below_band"})


def _utc(value: object, name: str) -> datetime:
    if not isinstance(value, str):
        raise TCGCSVUniverseError(f"{name} must be an ISO timestamp")
    normalized = value.strip()
    normalized = normalized[:-1] + "+00:00" if normalized.endswith("Z") else normalized
    try:
        result = datetime.fromisoformat(normalized)
    except ValueError as exc:
        raise TCGCSVUniverseError(f"{name} must be an ISO timestamp") from exc
    if result.tzinfo is None or result.utcoffset() is None:
        raise TCGCSVUniverseError(f"{name} must include a timezone")
    return result.astimezone(timezone.utc)


def _positive_price(value: object, name: str) -> float | None:
    if value in (None, ""):
        return None
    if isinstance(value, bool):
        raise TCGCSVUniverseError(f"{name} must be a finite positive price or null")
    try:
        result = float(value)
    except (TypeError, ValueError) as exc:
        raise TCGCSVUniverseError(f"{name} must be a finite positive price or null") from exc
    if not isfinite(result) or result < 0:
        raise TCGCSVUniverseError(f"{name} must be a finite non-negative price or null")
    if result == 0:
        return None
    return result


def _positive_int(value: object, name: str) -> int:
    if isinstance(value, bool):
        raise TCGCSVUniverseError(f"{name} must be a positive integer")
    try:
        result = int(value)
    except (TypeError, ValueError) as exc:
        raise TCGCSVUniverseError(f"{name} must be a positive integer") from exc
    if result <= 0:
        raise TCGCSVUniverseError(f"{name} must be a positive integer")
    return result


def _text(value: object, name: str, *, maximum: int = 700) -> str:
    result = str(value or "").strip()
    if not result or len(result) > maximum:
        raise TCGCSVUniverseError(f"{name} must be between 1 and {maximum} characters")
    return result


def _normalized_category(value: object) -> str:
    return str(value or "").strip().casefold() or "__missing__"


def _quantile(values: Sequence[float], probability: float) -> float:
    if not values:
        raise TCGCSVUniverseError("quantile requires evidence")
    ordered = sorted(float(value) for value in values)
    position = (len(ordered) - 1) * probability
    left = int(position)
    right = min(left + 1, len(ordered) - 1)
    fraction = position - left
    return ordered[left] * (1.0 - fraction) + ordered[right] * fraction


@dataclass(frozen=True, slots=True)
class StructuralGapPolicy:
    category_id: int = 3
    minimum_priced_series: int = 50
    minimum_complete_groups: int = 5
    fold_count: int = 5
    minimum_training_rows: int = 40
    minimum_calibration_rows: int = 12
    minimum_category_rows: int = 3
    category_smoothing: float = 10.0
    ridge_penalty: float = 2.0
    huber_delta: float = 1.5
    robust_iterations: int = 3
    minimum_peer_count: int = 1
    weekly_minimum_days: float = 6.0
    weekly_maximum_days: float = 8.0
    persistence_origins: int = 3
    persistence_minimum_span_days: float = 14.0

    def __post_init__(self) -> None:
        for name in (
            "category_id", "minimum_priced_series", "minimum_complete_groups", "fold_count",
            "minimum_training_rows", "minimum_calibration_rows", "minimum_category_rows",
            "robust_iterations", "minimum_peer_count",
            "persistence_origins",
        ):
            value = getattr(self, name)
            if isinstance(value, bool) or not isinstance(value, int) or value < 1:
                raise ValueError(f"{name} must be a positive integer")
        if self.fold_count < 3:
            raise ValueError("fold_count must be at least three")
        for name in (
            "ridge_penalty", "huber_delta", "category_smoothing", "weekly_minimum_days",
            "weekly_maximum_days", "persistence_minimum_span_days",
        ):
            value = float(getattr(self, name))
            if not isfinite(value) or value <= 0:
                raise ValueError(f"{name} must be finite and positive")
        if self.weekly_minimum_days >= self.weekly_maximum_days:
            raise ValueError("weekly cadence bounds are invalid")

    def as_dict(self) -> dict[str, object]:
        return {
            "categoryId": self.category_id,
            "minimumPricedSeries": self.minimum_priced_series,
            "minimumCompleteGroups": self.minimum_complete_groups,
            "foldCount": self.fold_count,
            "minimumTrainingRows": self.minimum_training_rows,
            "minimumCalibrationRows": self.minimum_calibration_rows,
            "minimumCategoryRows": self.minimum_category_rows,
            "categorySmoothing": self.category_smoothing,
            "ridgePenalty": self.ridge_penalty,
            "huberDelta": self.huber_delta,
            "robustIterations": self.robust_iterations,
            "minimumPeerCount": self.minimum_peer_count,
            "weeklyMinimumDays": self.weekly_minimum_days,
            "weeklyMaximumDays": self.weekly_maximum_days,
            "persistenceOrigins": self.persistence_origins,
            "persistenceMinimumSpanDays": self.persistence_minimum_span_days,
        }


@dataclass(frozen=True, slots=True)
class ProviderSeries:
    category_id: int
    group_id: int
    product_id: int
    subtype_name: str
    series_sha256: str
    current_price: float
    rarity: str
    card_type: str
    set_age_days: int

    @property
    def identity(self) -> tuple[int, int, int, str]:
        return (self.category_id, self.group_id, self.product_id, self.subtype_name)

    @property
    def group_key(self) -> tuple[int, int]:
        return (self.category_id, self.group_id)

    @property
    def identity_dict(self) -> dict[str, object]:
        return {
            "categoryId": self.category_id,
            "groupId": self.group_id,
            "productId": self.product_id,
            "subtypeName": self.subtype_name,
        }


@dataclass(frozen=True, slots=True)
class PeerAggregate:
    peer_count: int
    membership_sha256: str
    membership_contract: str
    median_price: float
    q25_price: float
    q75_price: float

    @classmethod
    def build(
        cls,
        target_identity: tuple[int, int, int, str],
        members: Sequence[ProviderSeries],
    ) -> "PeerAggregate":
        identities = [member.identity for member in members]
        if target_identity in identities:
            raise TCGCSVUniverseError("target series cannot belong to its own peer aggregate")
        if len(identities) != len(set(identities)):
            raise TCGCSVUniverseError("peer aggregate membership contains duplicate series")
        if not members:
            raise TCGCSVUniverseError("peer aggregate requires at least one non-target series")
        ordered_identities = [
            {
                "categoryId": identity[0], "groupId": identity[1],
                "productId": identity[2], "subtypeName": identity[3],
            }
            for identity in sorted(identities)
        ]
        prices = [member.current_price for member in members]
        return cls(
            peer_count=len(members),
            membership_sha256=content_hash(ordered_identities),
            membership_contract="explicit_peer_members_v1",
            median_price=_quantile(prices, 0.50),
            q25_price=_quantile(prices, 0.25),
            q75_price=_quantile(prices, 0.75),
        )

    def as_dict(self) -> dict[str, object]:
        return {
            "peerCount": self.peer_count,
            "membershipSha256": self.membership_sha256,
            "membershipContract": self.membership_contract,
            "medianPrice": round(self.median_price, 6),
            "q25Price": round(self.q25_price, 6),
            "q75Price": round(self.q75_price, 6),
        }


def _compile_group_peer_aggregates(
    rows: Sequence[ProviderSeries],
) -> dict[tuple[int, int, int, str], PeerAggregate]:
    """Compile all leave-one-out peers in O(n log n), binding the exclusion."""

    if len(rows) < 2:
        raise TCGCSVUniverseError("complete group requires at least two priced series")
    identities = [row.identity for row in rows]
    if len(identities) != len(set(identities)):
        raise TCGCSVUniverseError("complete group contains duplicate provider series")
    complete_membership_sha256 = content_hash([
        row.identity_dict for row in sorted(rows, key=lambda item: item.identity)
    ])
    ordered = sorted(rows, key=lambda item: (item.current_price, item.identity))
    removed_indexes = {row.identity: index for index, row in enumerate(ordered)}
    reduced_count = len(ordered) - 1

    def removed_quantile(removed_index: int, probability: float) -> float:
        position = (reduced_count - 1) * probability
        left = int(position)
        right = min(left + 1, reduced_count - 1)
        fraction = position - left

        def price_at(reduced_index: int) -> float:
            original_index = reduced_index if reduced_index < removed_index else reduced_index + 1
            return ordered[original_index].current_price

        return price_at(left) * (1.0 - fraction) + price_at(right) * fraction

    result: dict[tuple[int, int, int, str], PeerAggregate] = {}
    for target in rows:
        removed_index = removed_indexes[target.identity]
        membership_contract = {
            "contractVersion": "complete-group-minus-target-v1",
            "completeGroupMembershipSha256": complete_membership_sha256,
            "excludedTarget": target.identity_dict,
            "peerCount": reduced_count,
        }
        result[target.identity] = PeerAggregate(
            peer_count=reduced_count,
            membership_sha256=content_hash(membership_contract),
            membership_contract="complete_group_minus_target_v1",
            median_price=removed_quantile(removed_index, 0.50),
            q25_price=removed_quantile(removed_index, 0.25),
            q75_price=removed_quantile(removed_index, 0.75),
        )
    return result


@dataclass(frozen=True, slots=True)
class _EncodedModel:
    numeric_names: tuple[str, ...]
    numeric_centers: Mapping[str, float]
    numeric_scales: Mapping[str, float]
    categorical_effects: Mapping[str, Mapping[str, float]]
    coefficients: tuple[float, ...]
    residual_quantiles: Mapping[float, float]
    artifact_hash: str


def _numpy_runtime():
    try:
        import numpy as np  # type: ignore[import-not-found]
    except ImportError as exc:
        raise TCGCSVUniverseError(
            "Structural Gap Lab requires NumPy; install analytics[market-universe]"
        ) from exc
    return np


def _ridge_huber(
    design: Sequence[Sequence[float]],
    targets: Sequence[float],
    policy: StructuralGapPolicy,
) -> tuple[float, ...]:
    np = _numpy_runtime()
    matrix = np.asarray(design, dtype=np.float64)
    target_vector = np.asarray(targets, dtype=np.float64)
    weights = np.ones(len(design), dtype=np.float64)
    coefficients = np.zeros(matrix.shape[1], dtype=np.float64)
    penalty = np.eye(matrix.shape[1], dtype=np.float64) * policy.ridge_penalty
    penalty[0, 0] = 0.0
    for _ in range(policy.robust_iterations):
        weighted = matrix * weights[:, None]
        coefficients = np.linalg.solve(
            matrix.T @ weighted + penalty,
            matrix.T @ (weights * target_vector),
        )
        residuals = target_vector - matrix @ coefficients
        center = float(np.median(residuals))
        scale = max(1e-6, 1.4826 * float(np.median(np.abs(residuals - center))))
        limit = policy.huber_delta * scale
        absolute = np.abs(residuals - center)
        weights = np.where(absolute <= limit, 1.0, limit / np.maximum(absolute, 1e-12))
    rounded = tuple(
        round(float(value), COEFFICIENT_DECIMAL_PLACES) for value in coefficients
    )
    if not all(isfinite(value) for value in rounded):
        raise TCGCSVUniverseError("structural-gap solver produced non-finite coefficients")
    return rounded


def _solver_lineage() -> dict[str, object]:
    np = _numpy_runtime()
    try:
        source = inspect.getsource(_ridge_huber)
    except (OSError, TypeError) as exc:
        raise TCGCSVUniverseError(
            "Structural Gap Lab cannot seal its solver implementation source"
        ) from exc
    normalized_source = source.replace("\r\n", "\n").replace("\r", "\n")
    code_artifact = sha256()
    source_root = Path(__file__).resolve().parent
    for path in sorted(source_root.glob("*.py"), key=lambda item: item.name):
        code_artifact.update(path.name.encode("utf-8"))
        code_artifact.update(b"\0")
        code_artifact.update(path.read_bytes())
        code_artifact.update(b"\0")
    return {
        "solverVersion": STRUCTURAL_GAP_SOLVER_VERSION,
        "numpyRuntimeVersion": str(np.__version__),
        "implementationSourceSha256": sha256(
            normalized_source.encode("utf-8")
        ).hexdigest(),
        "codeArtifactSha256": code_artifact.hexdigest(),
        "floatingPointDtype": "float64",
        "coefficientDecimalPlaces": COEFFICIENT_DECIMAL_PLACES,
    }


def _numeric_features(
    row: ProviderSeries,
    peer: PeerAggregate,
    categorical_effects: Mapping[str, Mapping[str, float]],
) -> dict[str, float]:
    values = {
        "set_age_years": row.set_age_days / 365.25,
        "log_peer_median_price": log(peer.median_price),
        "log_peer_q25_price": log(peer.q25_price),
        "log_peer_q75_price": log(peer.q75_price),
        "log_peer_count": log(1.0 + peer.peer_count),
    }
    for name, level in _categorical_features(row).items():
        values[f"{name}_effect"] = categorical_effects.get(name, {}).get(level, 0.0)
    return values


def _categorical_features(row: ProviderSeries) -> dict[str, str]:
    return {
        "subtype": _normalized_category(row.subtype_name),
        "rarity": _normalized_category(row.rarity),
        "card_type": _normalized_category(row.card_type),
    }


def _vector(
    row: ProviderSeries,
    peer: PeerAggregate,
    numeric_names: Sequence[str],
    centers: Mapping[str, float],
    scales: Mapping[str, float],
    categorical_effects: Mapping[str, Mapping[str, float]],
) -> tuple[float, ...]:
    numeric = _numeric_features(row, peer, categorical_effects)
    result = [1.0]
    result.extend((numeric[name] - centers[name]) / scales[name] for name in numeric_names)
    return tuple(result)


def _fit_fold(
    training: Sequence[ProviderSeries],
    calibration: Sequence[ProviderSeries],
    peers: Mapping[tuple[int, int, int, str], PeerAggregate],
    policy: StructuralGapPolicy,
    fold_hash: str,
    input_hashes: Mapping[tuple[int, int, int, str], str],
    solver_lineage: Mapping[str, object],
) -> _EncodedModel:
    global_log_price = median(log(row.current_price) for row in training)
    category_values: dict[str, dict[str, list[float]]] = {
        "subtype": {}, "rarity": {}, "card_type": {},
    }
    for row in training:
        target = log(row.current_price)
        for name, level in _categorical_features(row).items():
            category_values[name].setdefault(level, []).append(target)
    categorical_effects: dict[str, dict[str, float]] = {}
    for name, levels in category_values.items():
        categorical_effects[name] = {}
        for level, values in levels.items():
            if len(values) < policy.minimum_category_rows:
                continue
            smoothed = (
                sum(values) + policy.category_smoothing * global_log_price
            ) / (len(values) + policy.category_smoothing)
            categorical_effects[name][level] = smoothed - global_log_price
    numeric_names = tuple(sorted(_numeric_features(
        training[0], peers[training[0].identity], categorical_effects,
    )))
    centers: dict[str, float] = {}
    scales: dict[str, float] = {}
    for name in numeric_names:
        values = [
            _numeric_features(row, peers[row.identity], categorical_effects)[name]
            for row in training
        ]
        centers[name] = median(values)
        robust_scale = (_quantile(values, 0.75) - _quantile(values, 0.25)) / 1.349
        scales[name] = robust_scale if robust_scale > 1e-8 else 1.0
    training_design = [
        _vector(
            row, peers[row.identity], numeric_names, centers, scales,
            categorical_effects,
        )
        for row in training
    ]
    coefficients = _ridge_huber(
        training_design, [log(row.current_price) for row in training], policy,
    )
    calibration_residuals = []
    for row in calibration:
        vector = _vector(
            row, peers[row.identity], numeric_names, centers, scales,
            categorical_effects,
        )
        predicted = sum(value * coefficient for value, coefficient in zip(vector, coefficients))
        calibration_residuals.append(log(row.current_price) - predicted)
    residual_quantiles = {
        probability: _quantile(calibration_residuals, probability)
        for probability in REQUIRED_QUANTILES
    }
    artifact = {
        "contractVersion": STRUCTURAL_GAP_CONTRACT_VERSION,
        "modelVersion": STRUCTURAL_GAP_MODEL_VERSION,
        "foldHash": fold_hash,
        "solverLineage": dict(solver_lineage),
        "numericNames": numeric_names,
        "numericCenters": centers,
        "numericScales": scales,
        "categoricalEffects": categorical_effects,
        "coefficients": coefficients,
        "residualQuantiles": residual_quantiles,
        "trainingInputHashes": sorted(input_hashes[row.identity] for row in training),
        "calibrationInputHashes": sorted(input_hashes[row.identity] for row in calibration),
        "policy": policy.as_dict(),
    }
    return _EncodedModel(
        numeric_names=numeric_names,
        numeric_centers=centers,
        numeric_scales=scales,
        categorical_effects=categorical_effects,
        coefficients=coefficients,
        residual_quantiles=residual_quantiles,
        artifact_hash=content_hash(artifact),
    )


def _verify_embedded_hash(value: Mapping[str, object], field: str) -> None:
    expected = str(value.get(field, "")).lower()
    if len(expected) != 64:
        raise TCGCSVUniverseError(f"{field} is missing or malformed")
    content = dict(value)
    del content[field]
    if content_hash(content) != expected:
        raise TCGCSVUniverseError(f"{field} does not match the supplied content")


def _load_series(
    feature_csv_path: Path,
    archive_packet: Mapping[str, object],
    catalog_snapshot: Mapping[str, object],
    origin: datetime,
    model_category_id: int,
) -> tuple[tuple[ProviderSeries, ...], tuple[str, ...], Mapping[str, object]]:
    features = archive_packet.get("features")
    if not isinstance(features, Mapping):
        raise TCGCSVUniverseError("archive packet features must be an object")
    expected_hash = str(features.get("featureCsvSha256", "")).lower()
    if file_sha256(feature_csv_path) != expected_hash:
        raise TCGCSVUniverseError("market-feature CSV does not match its archive packet")
    expected_count = _positive_int(features.get("featureCount"), "featureCount")

    products_raw = catalog_snapshot.get("products")
    groups_raw = catalog_snapshot.get("groups")
    if not isinstance(products_raw, list) or not isinstance(groups_raw, list):
        raise TCGCSVUniverseError("catalog snapshot row bundles must be arrays")
    products: dict[tuple[int, int, int], Mapping[str, object]] = {}
    for raw in products_raw:
        if not isinstance(raw, Mapping):
            raise TCGCSVUniverseError("catalog product rows must be objects")
        key = (
            _positive_int(raw.get("categoryId"), "categoryId"),
            _positive_int(raw.get("groupId"), "groupId"),
            _positive_int(raw.get("productId"), "productId"),
        )
        if key in products:
            raise TCGCSVUniverseError("catalog snapshot contains duplicate products")
        products[key] = raw
    groups: dict[tuple[int, int], Mapping[str, object]] = {}
    for raw in groups_raw:
        if not isinstance(raw, Mapping):
            raise TCGCSVUniverseError("catalog group rows must be objects")
        key = (
            _positive_int(raw.get("categoryId"), "categoryId"),
            _positive_int(raw.get("groupId"), "groupId"),
        )
        if key in groups:
            raise TCGCSVUniverseError("catalog snapshot contains duplicate groups")
        groups[key] = raw

    rows: list[ProviderSeries] = []
    incomplete_groups: set[tuple[int, int]] = set()
    seen: set[tuple[int, int, int, str]] = set()
    full_manifest: list[dict[str, object]] = []
    exclusions: list[dict[str, object]] = []
    selected_series_count = 0
    row_count = 0
    with feature_csv_path.open(newline="", encoding="utf-8") as handle:
        for raw in csv.DictReader(handle):
            row_count += 1
            category_id = _positive_int(raw.get("category_id"), "category_id")
            group_id = _positive_int(raw.get("group_id"), "group_id")
            product_id = _positive_int(raw.get("product_id"), "product_id")
            subtype_name = _text(raw.get("subtype_name"), "subtype_name", maximum=200)
            identity = (category_id, group_id, product_id, subtype_name)
            if identity in seen:
                raise TCGCSVUniverseError("market-feature CSV contains duplicate provider series")
            seen.add(identity)
            series_sha = str(raw.get("series_sha256", "")).lower()
            if len(series_sha) != 64 or any(character not in "0123456789abcdef" for character in series_sha):
                raise TCGCSVUniverseError("series_sha256 is malformed")
            identity_payload = {
                "categoryId": category_id,
                "groupId": group_id,
                "productId": product_id,
                "subtypeName": subtype_name,
            }
            full_manifest.append({**identity_payload, "seriesSha256": series_sha})
            if category_id != model_category_id:
                exclusions.append({
                    "providerIdentity": identity_payload,
                    "reasonCode": "outside_model_category",
                })
                continue
            selected_series_count += 1
            price = _positive_price(raw.get("current_price"), "current_price")
            if price is None:
                exclusions.append({
                    "providerIdentity": identity_payload,
                    "reasonCode": "current_price_unavailable",
                })
                continue
            product = products.get((category_id, group_id, product_id))
            group = groups.get((category_id, group_id))
            published_on = group.get("publishedOn") if group else None
            if product is None or group is None or not published_on:
                incomplete_groups.add((category_id, group_id))
                exclusions.append({
                    "providerIdentity": identity_payload,
                    "reasonCode": "catalog_metadata_incomplete",
                })
                continue
            try:
                published = datetime.fromisoformat(str(published_on)).date()
            except ValueError:
                incomplete_groups.add((category_id, group_id))
                exclusions.append({
                    "providerIdentity": identity_payload,
                    "reasonCode": "catalog_publication_date_invalid",
                })
                continue
            set_age_days = (origin.date() - published).days
            if set_age_days < 0:
                incomplete_groups.add((category_id, group_id))
                exclusions.append({
                    "providerIdentity": identity_payload,
                    "reasonCode": "set_not_published_at_origin",
                })
                continue
            rows.append(ProviderSeries(
                category_id=category_id,
                group_id=group_id,
                product_id=product_id,
                subtype_name=subtype_name,
                series_sha256=series_sha,
                current_price=price,
                rarity=str(product.get("rarity") or ""),
                card_type=str(product.get("cardType") or ""),
                set_age_days=set_age_days,
            ))
    if row_count != expected_count:
        raise TCGCSVUniverseError("market-feature row count does not match its archive packet")
    eligible_rows: list[ProviderSeries] = []
    for row in rows:
        if row.group_key in incomplete_groups:
            exclusions.append({
                "providerIdentity": row.identity_dict,
                "reasonCode": "group_catalog_incomplete",
            })
        else:
            eligible_rows.append(row)
    exclusions.sort(key=canonical_json)
    exclusion_counts = Counter(str(item["reasonCode"]) for item in exclusions)
    evidence = {
        "fullSeriesCount": row_count,
        "fullSeriesManifestSha256": content_hash(full_manifest),
        "modelCategoryId": model_category_id,
        "selectedCategorySeriesCount": selected_series_count,
        "eligiblePositiveSeriesBeforePeerGate": len(eligible_rows),
        "exclusionCount": len(exclusions),
        "exclusionCountsByReason": dict(sorted(exclusion_counts.items())),
        "exclusionManifestSha256": content_hash(exclusions),
    }
    return tuple(eligible_rows), tuple(
        f"{category_id}:{group_id}" for category_id, group_id in sorted(incomplete_groups)
    ), evidence


def _group_dict(group: tuple[int, int]) -> dict[str, int]:
    return {"categoryId": group[0], "groupId": group[1]}


def _abstention_packet(
    *,
    source_id: str,
    origin: datetime,
    archive_packet: Mapping[str, object],
    catalog_snapshot: Mapping[str, object],
    policy: StructuralGapPolicy,
    solver_lineage: Mapping[str, object],
    reasons: Iterable[str],
    priced_series_count: int = 0,
    complete_group_count: int = 0,
    incomplete_groups: Sequence[str] = (),
    universe_evidence: Mapping[str, object] | None = None,
) -> dict[str, object]:
    content: dict[str, object] = {
        "contractVersion": STRUCTURAL_GAP_CONTRACT_VERSION,
        "modelVersion": STRUCTURAL_GAP_MODEL_VERSION,
        "sourceId": source_id,
        "originAt": origin.isoformat(),
        "originMode": "current_origin_only",
        "modelCategoryId": policy.category_id,
        "labStatus": "abstain",
        "reasonCodes": sorted(set(reasons)),
        "pricedSeriesCount": priced_series_count,
        "completeGroupCount": complete_group_count,
        "incompleteGroups": list(incomplete_groups),
        "universeEvidence": dict(universe_evidence or {}),
        "archiveFeatureCsvSha256": archive_packet.get("features", {}).get("featureCsvSha256"),
        "catalogSnapshotContentSha256": catalog_snapshot.get("catalogSnapshotContentSha256"),
        "policy": policy.as_dict(),
        "solverLineage": dict(solver_lineage),
        "folds": [],
        "outputs": [],
        "identityScope": "provider_native",
        "canonicalIdentityClaimed": False,
        "futureValueClaimed": False,
        "privateResearchOnly": True,
        "publicPublicationAllowed": False,
    }
    return {**content, "packetContentSha256": content_hash(content)}


def _prior_output_map(
    packet: Mapping[str, object],
    model_category_id: int,
) -> dict[tuple[int, int, int, str], str | None]:
    outputs = packet.get("outputs")
    if not isinstance(outputs, list):
        raise TCGCSVUniverseError("prior structural-gap outputs must be an array")
    result: dict[tuple[int, int, int, str], str | None] = {}
    for output in outputs:
        if not isinstance(output, Mapping):
            raise TCGCSVUniverseError("prior structural-gap output must be an object")
        identity = output.get("providerIdentity")
        if not isinstance(identity, Mapping):
            raise TCGCSVUniverseError("prior output provider identity is missing")
        key = (
            _positive_int(identity.get("categoryId"), "categoryId"),
            _positive_int(identity.get("groupId"), "groupId"),
            _positive_int(identity.get("productId"), "productId"),
            _text(identity.get("subtypeName"), "subtypeName", maximum=200),
        )
        if key[0] != model_category_id:
            raise TCGCSVUniverseError("prior output crosses the model category boundary")
        if key in result:
            raise TCGCSVUniverseError("prior packet contains duplicate provider series")
        label = output.get("telemetryLabel")
        if label is not None and label not in ALLOWED_TELEMETRY_LABELS:
            raise TCGCSVUniverseError("prior packet contains an unsupported telemetry label")
        result[key] = label
    return result


def _apply_persistence(
    outputs: Sequence[Mapping[str, object]],
    origin: datetime,
    prior_packets: Sequence[Mapping[str, object]],
    policy: StructuralGapPolicy,
    source_id: str,
    solver_lineage: Mapping[str, object],
) -> list[dict[str, object]]:
    eligible_prior: list[tuple[datetime, dict[tuple[int, int, int, str], str | None]]] = []
    for packet in prior_packets:
        _verify_embedded_hash(packet, "packetContentSha256")
        if packet.get("contractVersion") != STRUCTURAL_GAP_CONTRACT_VERSION:
            raise TCGCSVUniverseError("prior packet uses a different structural-gap contract")
        if packet.get("modelVersion") != STRUCTURAL_GAP_MODEL_VERSION:
            raise TCGCSVUniverseError("prior packet uses a different structural-gap model")
        if packet.get("sourceId") != source_id:
            raise TCGCSVUniverseError("prior packet source differs from the current source")
        if packet.get("modelCategoryId") != policy.category_id:
            raise TCGCSVUniverseError("prior packet uses a different model category")
        if packet.get("policy") != policy.as_dict():
            raise TCGCSVUniverseError("prior packet uses a different structural-gap policy")
        if packet.get("solverLineage") != solver_lineage:
            raise TCGCSVUniverseError("prior packet uses a different solver lineage")
        if packet.get("originMode") != "current_origin_only":
            raise TCGCSVUniverseError("prior packet is not a current-origin artifact")
        if packet.get("labStatus") != "eligible":
            continue
        prior_origin = _utc(packet.get("originAt"), "prior originAt")
        if prior_origin >= origin:
            raise TCGCSVUniverseError("prior structural-gap origins must precede the current origin")
        eligible_prior.append((prior_origin, _prior_output_map(packet, policy.category_id)))
    eligible_prior.sort(key=lambda item: item[0])

    chain: list[tuple[datetime, dict[tuple[int, int, int, str], str | None]]] = []
    cursor = origin
    for prior_origin, prior_outputs in reversed(eligible_prior):
        gap_days = (cursor - prior_origin).total_seconds() / 86400.0
        if policy.weekly_minimum_days <= gap_days <= policy.weekly_maximum_days:
            chain.append((prior_origin, prior_outputs))
            cursor = prior_origin
            if len(chain) >= policy.persistence_origins - 1:
                break
        elif prior_origin < cursor:
            break

    result: list[dict[str, object]] = []
    for raw in outputs:
        output = dict(raw)
        identity = output["providerIdentity"]
        if not isinstance(identity, Mapping):
            raise TCGCSVUniverseError("current provider identity is malformed")
        key = (
            int(identity["categoryId"]), int(identity["groupId"]),
            int(identity["productId"]), str(identity["subtypeName"]),
        )
        if output.get("telemetryLabel") != "structural_gap" or len(chain) < policy.persistence_origins - 1:
            result.append(output)
            continue
        oldest_origin = chain[policy.persistence_origins - 2][0]
        span_days = (origin - oldest_origin).total_seconds() / 86400.0
        persistent = span_days >= policy.persistence_minimum_span_days and all(
            prior_outputs.get(key) in ALLOWED_TELEMETRY_LABELS
            for _, prior_outputs in chain[:policy.persistence_origins - 1]
        )
        if persistent:
            output["telemetryLabel"] = "persistent_below_band"
            output["persistence"] = {
                "eligibleOriginCount": policy.persistence_origins,
                "spanDays": round(span_days, 6),
                "gapsResetPersistence": True,
            }
        result.append(output)
    return result


def compile_structural_gap_lab(
    feature_csv_path: str | Path,
    archive_packet: Mapping[str, object],
    catalog_snapshot: Mapping[str, object],
    *,
    prior_packets: Sequence[Mapping[str, object]] = (),
    policy: StructuralGapPolicy = StructuralGapPolicy(),
) -> Mapping[str, object]:
    """Compile held-out current-price bands or an explicit fail-closed abstention."""

    if not isinstance(archive_packet, Mapping) or not isinstance(catalog_snapshot, Mapping):
        raise TCGCSVUniverseError("structural-gap inputs must be objects")
    if archive_packet.get("contractVersion") != UNIVERSE_CONTRACT_VERSION:
        raise TCGCSVUniverseError("archive packet uses an unsupported contract version")
    if catalog_snapshot.get("contractVersion") != CATALOG_SNAPSHOT_CONTRACT_VERSION:
        raise TCGCSVUniverseError("catalog snapshot uses an unsupported contract version")
    _verify_embedded_hash(catalog_snapshot, "catalogSnapshotContentSha256")
    solver_lineage = _solver_lineage()
    source_id = _text(archive_packet.get("sourceId"), "sourceId", maximum=80)
    if catalog_snapshot.get("sourceId") != source_id:
        raise TCGCSVUniverseError("archive and catalog snapshot sources differ")
    source_available = _utc(archive_packet.get("sourceAvailableAt"), "sourceAvailableAt")
    catalog_available = _utc(catalog_snapshot.get("catalogAvailableAt"), "catalogAvailableAt")
    if catalog_available < source_available:
        raise TCGCSVUniverseError("catalog snapshot cannot predate source availability")
    origin = catalog_available
    latest_archive = catalog_snapshot.get("latestArchive")
    if not isinstance(latest_archive, Mapping):
        raise TCGCSVUniverseError("catalog snapshot latestArchive pointer is missing")
    if latest_archive.get("sourceUpdatedAt") != archive_packet.get("sourceUpdatedAt"):
        return _abstention_packet(
            source_id=source_id, origin=origin, archive_packet=archive_packet,
            catalog_snapshot=catalog_snapshot, policy=policy,
            solver_lineage=solver_lineage,
            reasons=("archive_catalog_pointer_mismatch",),
        )
    reconciliation = catalog_snapshot.get("reconciliation")
    if not isinstance(reconciliation, Mapping):
        raise TCGCSVUniverseError("catalog reconciliation receipt is missing")
    if reconciliation.get("status") != "eligible":
        reason_codes = reconciliation.get("reasonCodes")
        reasons = ["catalog_snapshot_ineligible"]
        if isinstance(reason_codes, list):
            reasons.extend(f"catalog:{str(reason)}" for reason in reason_codes)
        return _abstention_packet(
            source_id=source_id, origin=origin, archive_packet=archive_packet,
            catalog_snapshot=catalog_snapshot, policy=policy,
            solver_lineage=solver_lineage, reasons=reasons,
        )

    series, incomplete_groups, universe_evidence = _load_series(
        Path(feature_csv_path), archive_packet, catalog_snapshot, origin,
        policy.category_id,
    )
    features = archive_packet.get("features")
    row_counts = catalog_snapshot.get("rowCounts")
    if not isinstance(features, Mapping) or not isinstance(row_counts, Mapping):
        raise TCGCSVUniverseError("archive feature or catalog row-count receipt is missing")
    binding_reasons: list[str] = []
    if latest_archive.get("status") != "sealed" or latest_archive.get("currentStateApplied") is not True:
        binding_reasons.append("latest_archive_not_sealed_current")
    if _utc(latest_archive.get("sourceAvailableAt"), "latest archive sourceAvailableAt") != source_available:
        binding_reasons.append("archive_availability_mismatch")
    if latest_archive.get("featureCsvSha256") != features.get("featureCsvSha256"):
        binding_reasons.append("sealed_feature_hash_mismatch")
    if latest_archive.get("featureCount") != universe_evidence["fullSeriesCount"]:
        binding_reasons.append("sealed_feature_count_mismatch")
    if latest_archive.get("seriesManifestSha256") != universe_evidence["fullSeriesManifestSha256"]:
        binding_reasons.append("sealed_series_manifest_mismatch")
    if row_counts.get("currentSeries") != universe_evidence["fullSeriesCount"]:
        binding_reasons.append("snapshot_current_series_count_mismatch")
    if binding_reasons:
        return _abstention_packet(
            source_id=source_id, origin=origin, archive_packet=archive_packet,
            catalog_snapshot=catalog_snapshot, policy=policy,
            solver_lineage=solver_lineage, reasons=binding_reasons,
            incomplete_groups=incomplete_groups, universe_evidence=universe_evidence,
        )
    groups: dict[tuple[int, int], list[ProviderSeries]] = {}
    for row in series:
        groups.setdefault(row.group_key, []).append(row)
    complete_groups = {
        key: tuple(sorted(rows, key=lambda row: row.identity))
        for key, rows in groups.items()
        if len(rows) > policy.minimum_peer_count
    }
    peer_gate_exclusions = [
        {"providerIdentity": row.identity_dict, "reasonCode": "insufficient_group_peers"}
        for key, rows in groups.items() if key not in complete_groups for row in rows
    ]
    peer_gate_exclusions.sort(key=canonical_json)
    universe_evidence = {
        **universe_evidence,
        "peerGateExclusionCount": len(peer_gate_exclusions),
        "peerGateExclusionManifestSha256": content_hash(peer_gate_exclusions),
    }
    priced_series_count = sum(len(rows) for rows in complete_groups.values())
    universe_reasons: list[str] = []
    if priced_series_count < policy.minimum_priced_series:
        universe_reasons.append("priced_series_below_minimum")
    if len(complete_groups) < max(policy.minimum_complete_groups, policy.fold_count):
        universe_reasons.append("complete_groups_below_minimum")
    if universe_reasons:
        return _abstention_packet(
            source_id=source_id, origin=origin, archive_packet=archive_packet,
            catalog_snapshot=catalog_snapshot, policy=policy,
            solver_lineage=solver_lineage, reasons=universe_reasons,
            priced_series_count=priced_series_count,
            complete_group_count=len(complete_groups), incomplete_groups=incomplete_groups,
            universe_evidence=universe_evidence,
        )

    ordered_groups = sorted(
        complete_groups,
        key=lambda key: (content_hash(_group_dict(key)), key),
    )
    buckets: list[list[tuple[int, int]]] = [[] for _ in range(policy.fold_count)]
    for index, group in enumerate(ordered_groups):
        buckets[index % policy.fold_count].append(group)

    fold_partitions: list[dict[str, object]] = []
    fold_reasons: list[str] = []
    all_groups = set(complete_groups)
    for fold_index in range(policy.fold_count):
        test_groups = set(buckets[fold_index])
        calibration_groups = set(buckets[(fold_index + 1) % policy.fold_count])
        training_groups = all_groups - test_groups - calibration_groups
        if training_groups & calibration_groups or training_groups & test_groups or calibration_groups & test_groups:
            raise TCGCSVUniverseError("whole-group cross-fit partitions overlap")
        training_count = sum(len(complete_groups[key]) for key in training_groups)
        calibration_count = sum(len(complete_groups[key]) for key in calibration_groups)
        test_count = sum(len(complete_groups[key]) for key in test_groups)
        partition = {
            "foldIndex": fold_index,
            "trainingGroups": [_group_dict(key) for key in sorted(training_groups)],
            "calibrationGroups": [_group_dict(key) for key in sorted(calibration_groups)],
            "testGroups": [_group_dict(key) for key in sorted(test_groups)],
            "trainingCount": training_count,
            "calibrationCount": calibration_count,
            "testCount": test_count,
        }
        fold_partitions.append(partition)
        if training_count < policy.minimum_training_rows:
            fold_reasons.append(f"fold_{fold_index}_training_rows_below_minimum")
        if calibration_count < policy.minimum_calibration_rows:
            fold_reasons.append(f"fold_{fold_index}_calibration_rows_below_minimum")
        if test_count < 1:
            fold_reasons.append(f"fold_{fold_index}_test_rows_absent")
    if fold_reasons:
        packet = _abstention_packet(
            source_id=source_id, origin=origin, archive_packet=archive_packet,
            catalog_snapshot=catalog_snapshot, policy=policy,
            solver_lineage=solver_lineage, reasons=fold_reasons,
            priced_series_count=priced_series_count,
            complete_group_count=len(complete_groups), incomplete_groups=incomplete_groups,
            universe_evidence=universe_evidence,
        )
        content = dict(packet)
        content.pop("packetContentSha256")
        content["folds"] = fold_partitions
        return {**content, "packetContentSha256": content_hash(content)}

    peers: dict[tuple[int, int, int, str], PeerAggregate] = {}
    input_hashes: dict[tuple[int, int, int, str], str] = {}
    archive_feature_hash = str(archive_packet["features"]["featureCsvSha256"])
    snapshot_hash = str(catalog_snapshot["catalogSnapshotContentSha256"])
    for group_rows in complete_groups.values():
        group_peers = _compile_group_peer_aggregates(group_rows)
        for target in group_rows:
            peer = group_peers[target.identity]
            if peer.peer_count < policy.minimum_peer_count:
                raise TCGCSVUniverseError("complete group does not satisfy minimum peer count")
            peers[target.identity] = peer
            input_hashes[target.identity] = content_hash({
                "originAt": origin.isoformat(),
                "archiveFeatureCsvSha256": archive_feature_hash,
                "catalogSnapshotContentSha256": snapshot_hash,
                "providerIdentity": target.identity_dict,
                "seriesSha256": target.series_sha256,
                "currentPrice": target.current_price,
                "setAgeDays": target.set_age_days,
                "rarity": target.rarity,
                "cardType": target.card_type,
                "peerAggregate": peer.as_dict(),
            })

    fold_receipts: list[dict[str, object]] = []
    outputs: list[dict[str, object]] = []
    for partition in fold_partitions:
        training_keys = {
            (int(item["categoryId"]), int(item["groupId"]))
            for item in partition["trainingGroups"]
        }
        calibration_keys = {
            (int(item["categoryId"]), int(item["groupId"]))
            for item in partition["calibrationGroups"]
        }
        test_keys = {
            (int(item["categoryId"]), int(item["groupId"]))
            for item in partition["testGroups"]
        }
        training = tuple(row for key in sorted(training_keys) for row in complete_groups[key])
        calibration = tuple(row for key in sorted(calibration_keys) for row in complete_groups[key])
        test = tuple(row for key in sorted(test_keys) for row in complete_groups[key])
        fold_hash = content_hash({
            **partition,
            "originAt": origin.isoformat(),
            "archiveFeatureCsvSha256": archive_feature_hash,
            "catalogSnapshotContentSha256": snapshot_hash,
            "policy": policy.as_dict(),
            "solverLineage": solver_lineage,
        })
        model = _fit_fold(
            training, calibration, peers, policy, fold_hash, input_hashes,
            solver_lineage,
        )
        fold_receipts.append({
            **partition,
            "foldHash": fold_hash,
            "artifactHash": model.artifact_hash,
            "solverLineageSha256": content_hash(solver_lineage),
        })
        for row in test:
            vector = _vector(
                row, peers[row.identity], model.numeric_names, model.numeric_centers,
                model.numeric_scales, model.categorical_effects,
            )
            center = sum(value * coefficient for value, coefficient in zip(vector, model.coefficients))
            quantile_values = {
                probability: max(0.0001, exp(center + model.residual_quantiles[probability]))
                for probability in REQUIRED_QUANTILES
            }
            ordered_values = sorted(quantile_values.values())
            quantiles = {
                "q10": round(ordered_values[0], 4),
                "q25": round(ordered_values[1], 4),
                "q50": round(ordered_values[2], 4),
                "q75": round(ordered_values[3], 4),
                "q90": round(ordered_values[4], 4),
            }
            if row.current_price < quantiles["q25"]:
                position = "below_band"
                telemetry_label: str | None = "structural_gap"
            elif row.current_price > quantiles["q75"]:
                position = "above_band"
                telemetry_label = None
            else:
                position = "inside_band"
                telemetry_label = None
            outputs.append({
                "providerIdentity": row.identity_dict,
                "seriesSha256": row.series_sha256,
                "currentPrice": round(row.current_price, 4),
                "quantiles": quantiles,
                "position": position,
                "structuralGapRatio": round(quantiles["q50"] / row.current_price - 1.0, 8),
                "telemetryLabel": telemetry_label,
                "peerAggregate": peers[row.identity].as_dict(),
                "foldIndex": partition["foldIndex"],
                "foldHash": fold_hash,
                "artifactHash": model.artifact_hash,
                "inputHash": input_hashes[row.identity],
                "heldOutOnly": True,
            })

    if len(outputs) != priced_series_count or len({
        canonical_json(output["providerIdentity"]) for output in outputs
    }) != priced_series_count:
        raise TCGCSVUniverseError("held-out cross-fit did not cover every eligible provider series exactly once")
    outputs = _apply_persistence(
        outputs, origin, prior_packets, policy, source_id, solver_lineage,
    )
    outputs.sort(key=lambda output: (
        int(output["providerIdentity"]["categoryId"]),
        int(output["providerIdentity"]["groupId"]),
        int(output["providerIdentity"]["productId"]),
        str(output["providerIdentity"]["subtypeName"]),
    ))
    input_manifest_hash = content_hash(sorted(input_hashes.values()))
    content = {
        "contractVersion": STRUCTURAL_GAP_CONTRACT_VERSION,
        "modelVersion": STRUCTURAL_GAP_MODEL_VERSION,
        "sourceId": source_id,
        "originAt": origin.isoformat(),
        "originMode": "current_origin_only",
        "modelCategoryId": policy.category_id,
        "labStatus": "eligible",
        "reasonCodes": [],
        "pricedSeriesCount": priced_series_count,
        "completeGroupCount": len(complete_groups),
        "incompleteGroups": list(incomplete_groups),
        "universeEvidence": dict(universe_evidence),
        "archiveFeatureCsvSha256": archive_feature_hash,
        "catalogSnapshotContentSha256": snapshot_hash,
        "inputManifestHash": input_manifest_hash,
        "policy": policy.as_dict(),
        "solverLineage": solver_lineage,
        "folds": fold_receipts,
        "outputs": outputs,
        "identityScope": "provider_native",
        "canonicalIdentityClaimed": False,
        "futureValueClaimed": False,
        "privateResearchOnly": True,
        "publicPublicationAllowed": False,
    }
    return {**content, "packetContentSha256": content_hash(content)}
