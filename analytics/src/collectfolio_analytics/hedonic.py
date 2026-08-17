"""Per-category hedonic log-price regression for trajectory-v1 cold start (T3).

``y_i = log(last known price)`` for variant ``i``. The design matrix is
built from finish/subTypeName, group release age at ``asOf``, set family,
sealed-vs-single kind, group-level price statistics, and (when available)
rarity -- see ``hedonic_features.py`` for how those raw ingredients are
assembled from the panel + groups metadata + an optional products-metadata
fetch. This module is intentionally self-contained (no import of
``trajectory.py`` or ``hedonic_features.py``) so it has no part in any
import cycle; callers pass in already-assembled ``FeatureRow`` objects.

Pure-Python stdlib OLS: normal equations
``(X^T X + ridge * I) * beta = X^T y``, solved by Gauss-Jordan elimination
with partial pivoting. Singular/near-collinear design matrices (a
categorical level seen once, two perfectly collinear columns, a
degenerate one-group category, ...) are handled by a *tested* fallback:
retry with a geometrically larger ridge a few times, and if the matrix is
still (numerically) singular after that, fall back to an intercept-only
model (``beta = [mean(y), 0, ..., 0]``), which always succeeds.

Held-out-SETS cross-validation assigns each GROUP (not row) to one of
``n_folds`` folds deterministically via
``sha256(str(group_id)) % n_folds`` -- hash-based, not
RNG/iteration-order-dependent, so a given category always produces the
same folds and the same reported RMSE/R^2. Out-of-fold predictions are
pooled across all folds before computing one RMSE/R^2 pair per category
(matching PRD §4/T3's "out-of-sample (held-out sets) hedonic RMSE/R^2
... per category").
"""

from __future__ import annotations

from dataclasses import dataclass
from hashlib import sha256
from math import isfinite, isnan, log
from statistics import median
from typing import Mapping, Sequence

#: Ridge jitter applied to the normal equations' diagonal before the first
#: solve attempt. Small enough not to distort well-conditioned categories,
#: large enough to break exact ties in synthetic/degenerate test fixtures.
RIDGE_BASE = 1e-6

#: Singular-fallback retry schedule: each failed solve multiplies the
#: ridge by this factor and tries again.
RIDGE_RETRY_MULTIPLIER = 100.0
RIDGE_MAX_RETRIES = 6

#: Below this pivot magnitude (after ridge) a column is treated as
#: numerically singular.
PIVOT_EPSILON = 1e-10

#: Categorical levels beyond the most frequent ``DEFAULT_TOP_K`` collapse
#: into an implicit "other" bucket (an all-zero one-hot row for that
#: field) rather than growing the design matrix unboundedly.
DEFAULT_TOP_K = 20

DEFAULT_N_FOLDS = 5

#: Empirical-Bayes pseudo-count for the hedonic/own-history LOG-LEVEL
#: blend weight ``n/(n+n0)`` used by trajectory.py. Deliberately matches
#: trajectory.N0_DRIFT's own-history trust calibration (both express "how
#: many of a card's own weekly observations are worth as much as the
#: prior"), applied here to the price *level* instead of the drift.
N0_HEDONIC = 8.0

#: n=0 ("no usable history") cold-start packets widen the category's
#: widest calibrated (bucket, horizon) conformal pool by this factor,
#: since a pure-prior forecast is honestly less certain than even the
#: category's most volatile *observed* variants.
COLD_START_BAND_WIDEN_FACTOR = 1.75


class HedonicError(ValueError):
    """Raised on malformed hedonic fit inputs."""


@dataclass(frozen=True, slots=True)
class FeatureRow:
    """One variant's raw hedonic feature ingredients (pre design-matrix)."""

    group_id: int
    categorical: Mapping[str, str]
    continuous: Mapping[str, float]


@dataclass(frozen=True, slots=True)
class DesignMatrixSpec:
    categorical_fields: tuple[str, ...]
    categorical_vocab: Mapping[str, tuple[str, ...]]
    continuous_fields: tuple[str, ...]
    column_names: tuple[str, ...]


def fold_for_group(group_id: int, n_folds: int) -> int:
    """Deterministic held-out-SETS fold assignment, hash-based (not RNG)."""

    if n_folds < 2:
        raise HedonicError("n_folds must be >= 2")
    digest = sha256(str(int(group_id)).encode("utf-8")).hexdigest()
    return int(digest, 16) % n_folds


def hedonic_level_weight(n: int, n0: float = N0_HEDONIC) -> float:
    """``n/(n+n0)``: 0 at n=0 (pure hedonic prior); -> 1 as n grows (own
    price history dominates). Same empirical-Bayes shrinkage form as
    ``trajectory.shrunk_drift_at``'s drift weight, applied to the price
    *level* in the hedonic/own-history blend instead of the drift term.
    """

    if n <= 0:
        return 0.0
    denom = n + n0
    if denom <= 0:
        return 0.0
    weight = n / denom
    return min(1.0, max(0.0, weight))


def structural_scarcity_proxy(group_variant_count: int) -> float:
    """``-log(group_variant_count)``: larger for scarcer (smaller) groups.

    A purely panel-derived stand-in used both as a hedonic continuous
    feature and as the ablation's pull-cost proxy (see
    ``fit_video_model_v0_ablation``). Monotonic in the same direction as
    video_model_v0's original dollar pull-cost (larger for scarcer cards)
    but is not on the same scale -- a proxy, not a reconstruction.
    """

    count = max(1, int(group_variant_count))
    return -log(float(count))


# ---------------------------------------------------------------------------
# Design matrix
# ---------------------------------------------------------------------------


def fit_design_matrix_spec(
    rows: Sequence[FeatureRow],
    *,
    categorical_fields: Sequence[str] | None = None,
    continuous_fields: Sequence[str] | None = None,
    top_k: int = DEFAULT_TOP_K,
) -> DesignMatrixSpec:
    if not rows:
        raise HedonicError("fit_design_matrix_spec requires at least one row")
    cat_fields = tuple(categorical_fields) if categorical_fields is not None else tuple(
        sorted({name for row in rows for name in row.categorical})
    )
    cont_fields = tuple(continuous_fields) if continuous_fields is not None else tuple(
        sorted({name for row in rows for name in row.continuous})
    )
    vocab: dict[str, tuple[str, ...]] = {}
    for field in cat_fields:
        counts: dict[str, int] = {}
        for row in rows:
            value = row.categorical.get(field) or "unknown"
            counts[value] = counts.get(value, 0) + 1
        ordered = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
        vocab[field] = tuple(value for value, _count in ordered[:top_k])
    column_names = ["intercept"]
    for field in cat_fields:
        column_names.extend(f"{field}={level}" for level in vocab[field])
    column_names.extend(cont_fields)
    return DesignMatrixSpec(
        categorical_fields=cat_fields,
        categorical_vocab=vocab,
        continuous_fields=cont_fields,
        column_names=tuple(column_names),
    )


def build_design_matrix(rows: Sequence[FeatureRow], spec: DesignMatrixSpec) -> list[list[float]]:
    matrix: list[list[float]] = []
    for row in rows:
        vec = [1.0]
        for field in spec.categorical_fields:
            value = row.categorical.get(field) or "unknown"
            vec.extend(1.0 if value == level else 0.0 for level in spec.categorical_vocab[field])
        for field in spec.continuous_fields:
            raw = row.continuous.get(field, 0.0)
            vec.append(float(raw) if isfinite(raw) else 0.0)
        matrix.append(vec)
    return matrix


# ---------------------------------------------------------------------------
# Pure-Python OLS solver: normal equations + Gauss-Jordan elimination,
# ridge-jittered, with a tested singular-matrix fallback.
# ---------------------------------------------------------------------------


def _dot(a: Sequence[float], b: Sequence[float]) -> float:
    return sum(ai * bi for ai, bi in zip(a, b))


def _gram_matrix(X: Sequence[Sequence[float]]) -> list[list[float]]:
    if not X:
        raise HedonicError("design matrix has no rows")
    p = len(X[0])
    gram = [[0.0] * p for _ in range(p)]
    for row in X:
        for i in range(p):
            xi = row[i]
            if xi == 0.0:
                continue
            gram_i = gram[i]
            for j in range(p):
                gram_i[j] += xi * row[j]
    return gram


def _xty(X: Sequence[Sequence[float]], y: Sequence[float]) -> list[float]:
    p = len(X[0])
    out = [0.0] * p
    for row, yi in zip(X, y):
        for i in range(p):
            out[i] += row[i] * yi
    return out


def _gauss_jordan_solve(A: Sequence[Sequence[float]], b: Sequence[float]) -> list[float] | None:
    """Solve ``Ax = b`` via Gauss-Jordan elimination with partial pivoting.

    Returns ``None`` (rather than raising) when a pivot is numerically
    zero even after the caller's ridge jitter -- the design matrix is
    singular/collinear and the caller should retry with more ridge or
    fall back to an intercept-only model.
    """

    n = len(A)
    if n == 0 or any(len(row) != n for row in A) or len(b) != n:
        raise HedonicError("Gauss-Jordan solve requires a square, consistent system")
    M = [list(A[i]) + [b[i]] for i in range(n)]
    for col in range(n):
        pivot_row = max(range(col, n), key=lambda r: abs(M[r][col]))
        if abs(M[pivot_row][col]) < PIVOT_EPSILON:
            return None
        M[col], M[pivot_row] = M[pivot_row], M[col]
        pivot_val = M[col][col]
        M[col] = [v / pivot_val for v in M[col]]
        for r in range(n):
            if r == col:
                continue
            factor = M[r][col]
            if factor == 0.0:
                continue
            M[r] = [mr - factor * mc for mr, mc in zip(M[r], M[col])]
    solution = [M[i][n] for i in range(n)]
    if not all(isfinite(v) for v in solution):
        return None
    return solution


def solve_ols_ridge(
    X: Sequence[Sequence[float]],
    y: Sequence[float],
    *,
    ridge: float = RIDGE_BASE,
    max_retries: int = RIDGE_MAX_RETRIES,
    retry_multiplier: float = RIDGE_RETRY_MULTIPLIER,
) -> tuple[list[float], bool]:
    """Ridge-regularized OLS via normal equations. Returns ``(beta, used_fallback)``.

    ``used_fallback`` is ``True`` iff the design matrix was still singular
    after escalating the ridge ``max_retries`` times, in which case
    ``beta`` is the always-solvable intercept-only model
    ``[mean(y), 0, ..., 0]``.
    """

    if not X or not y or len(X) != len(y):
        raise HedonicError("solve_ols_ridge requires non-empty, aligned X and y")
    p = len(X[0])
    gram = _gram_matrix(X)
    xty = _xty(X, y)
    current_ridge = max(ridge, 0.0)
    for _attempt in range(max_retries):
        A = [row[:] for row in gram]
        for i in range(p):
            A[i][i] += current_ridge
        beta = _gauss_jordan_solve(A, xty)
        if beta is not None:
            return beta, False
        current_ridge = current_ridge * retry_multiplier if current_ridge > 0 else retry_multiplier
    mean_y = sum(y) / len(y)
    beta = [mean_y] + [0.0] * (p - 1)
    return beta, True


# ---------------------------------------------------------------------------
# Held-out-SETS cross-validation + full-data fit
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class HedonicFitMetrics:
    n_folds: int
    n_observations: int
    n_groups: int
    n_features: int
    holdout_covered: int
    holdout_rmse: float
    holdout_r2: float
    folds_used_fallback: tuple[int, ...]

    def as_receipt_dict(self) -> dict[str, object]:
        return {
            "nFolds": self.n_folds,
            "nObservations": self.n_observations,
            "nGroups": self.n_groups,
            "nFeatures": self.n_features,
            "holdoutCovered": self.holdout_covered,
            "holdoutRmse": None if isnan(self.holdout_rmse) else round(self.holdout_rmse, 6),
            "holdoutR2": None if isnan(self.holdout_r2) else round(self.holdout_r2, 6),
            "foldsUsedFallback": list(self.folds_used_fallback),
        }


def _rmse_r2(pairs: Sequence[tuple[float, float]]) -> tuple[float, float]:
    if not pairs:
        return float("nan"), float("nan")
    n = len(pairs)
    mse = sum((yt - yp) ** 2 for yt, yp in pairs) / n
    rmse = mse ** 0.5
    mean_y = sum(yt for yt, _yp in pairs) / n
    ss_tot = sum((yt - mean_y) ** 2 for yt, _yp in pairs)
    ss_res = sum((yt - yp) ** 2 for yt, yp in pairs)
    r2 = float("nan") if ss_tot <= 0 else 1.0 - (ss_res / ss_tot)
    return rmse, r2


def cross_validate_holdout_sets(
    rows: Sequence[FeatureRow],
    y: Sequence[float],
    *,
    n_folds: int = DEFAULT_N_FOLDS,
    ridge: float = RIDGE_BASE,
    top_k: int = DEFAULT_TOP_K,
    categorical_fields: Sequence[str] | None = None,
    continuous_fields: Sequence[str] | None = None,
) -> HedonicFitMetrics:
    if len(rows) != len(y):
        raise HedonicError("rows and y must be aligned")
    if not rows:
        raise HedonicError("cross_validate_holdout_sets requires at least one row")
    effective_folds = max(2, min(n_folds, len({row.group_id for row in rows})))
    fold_ids = [fold_for_group(row.group_id, effective_folds) for row in rows]

    y_pred_oof: list[float] = [float("nan")] * len(rows)
    fallback_folds: list[int] = []
    for fold in range(effective_folds):
        train_idx = [i for i, f in enumerate(fold_ids) if f != fold]
        test_idx = [i for i, f in enumerate(fold_ids) if f == fold]
        if not train_idx or not test_idx:
            continue
        train_rows = [rows[i] for i in train_idx]
        train_y = [y[i] for i in train_idx]
        spec = fit_design_matrix_spec(
            train_rows, categorical_fields=categorical_fields,
            continuous_fields=continuous_fields, top_k=top_k,
        )
        X_train = build_design_matrix(train_rows, spec)
        beta, used_fallback = solve_ols_ridge(X_train, train_y, ridge=ridge)
        if used_fallback:
            fallback_folds.append(fold)
        test_rows = [rows[i] for i in test_idx]
        X_test = build_design_matrix(test_rows, spec)
        for local_i, global_i in enumerate(test_idx):
            y_pred_oof[global_i] = _dot(X_test[local_i], beta)

    pairs = [(y[i], y_pred_oof[i]) for i in range(len(rows)) if not isnan(y_pred_oof[i])]
    rmse, r2 = _rmse_r2(pairs)
    return HedonicFitMetrics(
        n_folds=effective_folds,
        n_observations=len(rows),
        n_groups=len({row.group_id for row in rows}),
        n_features=len(fit_design_matrix_spec(rows, categorical_fields=categorical_fields, continuous_fields=continuous_fields, top_k=top_k).column_names),
        holdout_covered=len(pairs),
        holdout_rmse=rmse,
        holdout_r2=r2,
        folds_used_fallback=tuple(fallback_folds),
    )


@dataclass(frozen=True, slots=True)
class HedonicModel:
    category_id: int
    spec: DesignMatrixSpec
    beta: tuple[float, ...]
    used_intercept_only_fallback: bool
    metrics: HedonicFitMetrics

    def predict_log_price(self, row: FeatureRow) -> float:
        vec = build_design_matrix([row], self.spec)[0]
        return _dot(vec, self.beta)


def fit_hedonic_category(
    category_id: int,
    rows: Sequence[FeatureRow],
    y: Sequence[float],
    *,
    n_folds: int = DEFAULT_N_FOLDS,
    ridge: float = RIDGE_BASE,
    top_k: int = DEFAULT_TOP_K,
    categorical_fields: Sequence[str] | None = None,
    continuous_fields: Sequence[str] | None = None,
) -> HedonicModel:
    """Fit one category's hedonic model on ALL rows with usable history.

    The reported ``metrics`` come from held-out-SETS cross-validation
    (out-of-sample by construction); the returned model's ``beta`` is then
    refit on the *full* row set (standard practice -- CV measures
    generalization, the deployed model should use every available
    observation) via the same OLS machinery.
    """

    if len(rows) != len(y):
        raise HedonicError("rows and y must be aligned")
    if not rows:
        raise HedonicError("fit_hedonic_category requires at least one row")
    metrics = cross_validate_holdout_sets(
        rows, y, n_folds=n_folds, ridge=ridge, top_k=top_k,
        categorical_fields=categorical_fields, continuous_fields=continuous_fields,
    )
    spec = fit_design_matrix_spec(
        rows, categorical_fields=categorical_fields, continuous_fields=continuous_fields, top_k=top_k,
    )
    X = build_design_matrix(rows, spec)
    beta, used_fallback = solve_ols_ridge(X, y, ridge=ridge)
    return HedonicModel(
        category_id=category_id, spec=spec, beta=tuple(beta),
        used_intercept_only_fallback=used_fallback, metrics=metrics,
    )


# ---------------------------------------------------------------------------
# video_model_v0 ablation (research-only scorecard row; see
# PRD/CollectFolio-Price-Intelligence-PRD.md, "Executive decision" section)
# ---------------------------------------------------------------------------

ABLATION_MODEL_KEY = "video_model_v0_ablation_form"

#: PRD/CollectFolio-Price-Intelligence-PRD.md's "Executive decision" section
#: states plainly that video_model_v0's surviving workbook has "only 22
#: observations, mixed price dates, hidden/manual desirability inputs,
#: inconsistent coefficient versions, and no demonstrated out-of-sample
#: validation" -- i.e. desirability specifically was a hidden/manual input,
#: not just pull_cost, as the T3 brief singled out. Both of video_model_v0's
#: two features are therefore reproduced here as honestly-labeled proxies,
#: not reconstructions, and fresh coefficients are fit via the same OLS
#: machinery (never video_model_v0's literal legacy coefficients, which were
#: fit on that same 22-observation forensic sample, unrelated to this panel
#: -- see video_model_v0.py).
ABLATION_PROXY_NOTES = (
    "video_model_v0's original two features (pull_cost, desirability) cannot be "
    "reconstructed from available data (PRD/CollectFolio-Price-Intelligence-PRD.md, "
    "Executive decision section: video_model_v0's surviving workbook has hidden/manual "
    "desirability inputs and only 22 observations with no out-of-sample validation, so "
    "desirability specifically is not recoverable, and this pipeline separately has no "
    "per-product pack-odds/EV data for a genuine pull_cost). Substituted here, both proxies research-only: "
    "pull-cost proxy = structural_scarcity_proxy(group_variant_count) = "
    "-log(group_variant_count), monotonic in the same scarcer-is-costlier direction "
    "as the original dollar pull_cost but not on the same scale; desirability proxy "
    "= release_age_weeks at asOf, an approximate, non-genuine substitute. Coefficients "
    "are freshly fit on this panel via the same ridge-OLS machinery as the main "
    "hedonic model, not video_model_v0's literal legacy coefficients."
)


def fit_video_model_v0_ablation(
    category_id: int,
    rows: Sequence[FeatureRow],
    y: Sequence[float],
    *,
    n_folds: int = DEFAULT_N_FOLDS,
    ridge: float = RIDGE_BASE,
) -> dict[str, object]:
    """One receipt row reproducing video_model_v0's two-feature functional
    form (pull-cost proxy, desirability proxy) purely for the scorecard
    comparison. Clearly research-only -- see ``ABLATION_PROXY_NOTES``.
    """

    if len(rows) != len(y):
        raise HedonicError("rows and y must be aligned")
    if not rows:
        raise HedonicError("fit_video_model_v0_ablation requires at least one row")
    metrics = cross_validate_holdout_sets(
        rows, y, n_folds=n_folds, ridge=ridge,
        categorical_fields=(), continuous_fields=("scarcityProxy", "desirabilityProxy"),
    )
    spec = fit_design_matrix_spec(
        rows, categorical_fields=(), continuous_fields=("scarcityProxy", "desirabilityProxy"),
    )
    X = build_design_matrix(rows, spec)
    beta, used_fallback = solve_ols_ridge(X, y, ridge=ridge)
    return {
        "modelKey": ABLATION_MODEL_KEY,
        "categoryId": category_id,
        "researchOnly": True,
        "proxyNotes": ABLATION_PROXY_NOTES,
        "coefficients": {name: round(value, 6) for name, value in zip(spec.column_names, beta)},
        "usedInterceptOnlyFallback": used_fallback,
        "metrics": metrics.as_receipt_dict(),
    }
