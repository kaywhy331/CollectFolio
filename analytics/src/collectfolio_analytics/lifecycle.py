"""Release-age lifecycle curve library for the trajectory-v1 engine (T2).

Roadmap §4 step 2: "Forecast `s` by blending the set's own damped trend with
the release-age lifecycle curve of matched historical cohorts (existing
`lifecycle_cohort` logic, now fitted on the full panel instead of one
research cohort)." This module:

1. Fetches (and locally caches) group release dates (``publishedOn``) from
   the same ``tcgplayer/<categoryId>/groups`` endpoint pattern already used
   by ``tcgcsv_universe_cli.py``, reusing ``tcgcsv_universe.normalize_group``
   for the actual field parsing so that logic is not silently re-forked.
2. Builds one pooled, release-age-indexed curve of expected weekly
   group-vs-category excess log return from ``indices.py``'s group-level
   step returns across every set with a known release date -- "one
   lifecycle curve library" per the roadmap's own wording (pooled globally
   across the scoped categories, not refit per category, so thin categories
   still borrow strength from the whole panel).
3. Blends a group's own damped-trend forecast with the cohort curve's
   expected return over the forecast horizon, shrinking toward the cohort
   by the same ``n/(n+n0)`` empirical-Bayes form used for card drift, via
   ``baselines.lifecycle_cohort`` for the actual bounded-return application
   (never reimplementing that clamp).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from math import isfinite
from pathlib import Path
from typing import Callable, Mapping, Sequence
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin
from urllib.request import Request, urlopen

import gzip
import json

from .baselines import lifecycle_cohort
from .indices import IndexSet, trimmed_mean
from .tcgcsv_universe import normalize_group

DEFAULT_BASE_URL = "https://tcgcsv.com/"
DEFAULT_USER_AGENT = "CollectFolio/0.1 trajectory-v1 lifecycle library (community-free-access)"
MAX_GROUPS_JSON_BYTES = 8 * 1024 * 1024
GROUPS_CACHE_FILENAME = "groups_metadata.json.gz"

#: Empirical-Bayes pseudo-count for the own-trend vs. cohort-curve blend.
N0_LIFECYCLE = 12.0

#: A group's excess return regime is treated as "mature" past this many
#: weeks since release; older sightings do not extend the curve further.
MAX_CURVE_AGE_WEEKS = 260


class LifecycleError(RuntimeError):
    """Raised when group metadata cannot be fetched or parsed."""


def _url(base_url: str, path: str) -> str:
    base = base_url.rstrip("/") + "/"
    result = urljoin(base, path.lstrip("/"))
    if not result.startswith(base):
        raise LifecycleError("groups path escaped the configured origin")
    return result


def _default_fetch_groups_json(
    base_url: str,
    category_id: int,
    *,
    user_agent: str,
    timeout_seconds: float,
) -> object:
    request = Request(
        _url(base_url, f"tcgplayer/{category_id}/groups"),
        headers={"User-Agent": user_agent, "Accept": "application/json"},
    )
    try:
        with urlopen(request, timeout=timeout_seconds) as response:  # noqa: S310
            payload = response.read(MAX_GROUPS_JSON_BYTES + 1)
    except HTTPError as exc:
        if exc.code == 404:
            return {"success": True, "results": []}
        raise LifecycleError(f"groups fetch failed for category {category_id}: HTTP {exc.code}") from exc
    except URLError as exc:
        raise LifecycleError(f"groups fetch failed for category {category_id}: {exc.reason}") from exc
    if len(payload) > MAX_GROUPS_JSON_BYTES:
        raise LifecycleError("groups response exceeds its size limit")
    try:
        return json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise LifecycleError(f"groups response for category {category_id} is not valid JSON") from exc


FetchGroupsJson = Callable[[str, int], object]


def fetch_groups_metadata(
    category_ids: Sequence[int],
    *,
    base_url: str = DEFAULT_BASE_URL,
    user_agent: str = DEFAULT_USER_AGENT,
    timeout_seconds: float = 30.0,
    fetch_json: FetchGroupsJson | None = None,
) -> dict[tuple[int, int], dict[str, object]]:
    """Fetch and normalize ``{groupId, publishedOn, name}`` for every group.

    ``fetch_json(base_url, category_id)`` is an injectable seam for tests;
    the default implementation makes one bounded HTTPS request per category.
    """

    fetcher = fetch_json or (
        lambda base, category: _default_fetch_groups_json(
            base, category, user_agent=user_agent, timeout_seconds=timeout_seconds
        )
    )
    metadata: dict[tuple[int, int], dict[str, object]] = {}
    for category_id in sorted({int(c) for c in category_ids}):
        payload = fetcher(base_url, category_id)
        if not isinstance(payload, Mapping) or payload.get("success") is not True:
            raise LifecycleError(f"groups response for category {category_id} was not successful")
        rows = payload.get("results")
        if not isinstance(rows, list):
            raise LifecycleError(f"groups response for category {category_id} lacks a results array")
        for row in rows:
            if not isinstance(row, Mapping):
                continue
            normalized = normalize_group(category_id, row)
            key = (int(normalized["category_id"]), int(normalized["group_id"]))
            metadata[key] = normalized
    return metadata


def _canonical_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _content_sha256(value: object) -> str:
    from hashlib import sha256

    return sha256(_canonical_json(value).encode("utf-8")).hexdigest()


def load_or_fetch_groups_metadata(
    cache_path: Path,
    category_ids: Sequence[int],
    *,
    force_refresh: bool = False,
    **fetch_kwargs: object,
) -> tuple[dict[tuple[int, int], dict[str, object]], str]:
    """Reuse a cached groups-metadata file when it covers every requested
    category; else fetch (only) the missing categories and merge them in.

    Correctness note: an earlier version of this function treated "the
    cache file exists" as sufficient to skip fetching entirely, regardless
    of which categories ``category_ids`` actually asked for. That let a
    cache first written for a narrow scope (e.g. one category, from a
    smoke test) silently starve a later broader-scope caller (e.g. all
    four trajectory-v1 categories) of every other category's groups
    metadata -- discovered during T3 when categories 1/2/3's release-age
    features were unexpectedly always the fallback value. This version
    tracks which categories are actually present in the cached payload's
    ``categoryIds`` and only reuses the cache as-is when that set already
    covers every requested id; otherwise it fetches just the missing
    categories (or, under ``force_refresh``, every requested category) and
    merges the result with whatever was already cached for OTHER
    categories, so scope only ever grows and previously-fetched categories
    are never silently dropped.

    Returns ``(metadata, sha256_of_cached_json)`` for receipts.
    """

    cache_path = Path(cache_path)
    requested = {int(c) for c in category_ids}
    cached_metadata: dict[tuple[int, int], dict[str, object]] = {}
    cached_category_ids: set[int] = set()
    if cache_path.is_file():
        with gzip.open(cache_path, "rt", encoding="utf-8") as handle:
            raw = json.load(handle)
        cached_category_ids = {int(c) for c in raw.get("categoryIds", [])}
        cached_metadata = {
            (int(row["category_id"]), int(row["group_id"])): row
            for row in raw.get("groups", [])
        }

    missing = requested - cached_category_ids
    if not force_refresh and not missing:
        payload = {
            "categoryIds": sorted(cached_category_ids),
            "groups": [cached_metadata[key] for key in sorted(cached_metadata)],
        }
        return cached_metadata, _content_sha256(payload)

    to_fetch = sorted(requested) if force_refresh else sorted(missing)
    fetched = fetch_groups_metadata(to_fetch, **fetch_kwargs)  # type: ignore[arg-type]
    if force_refresh:
        merged = dict(fetched)
        for key, row in cached_metadata.items():
            if key[0] not in requested:  # keep categories outside this call's scope
                merged.setdefault(key, row)
    else:
        merged = dict(cached_metadata)
        merged.update(fetched)

    all_category_ids = sorted({key[0] for key in merged} | requested)
    payload = {
        "categoryIds": all_category_ids,
        "groups": [merged[key] for key in sorted(merged)],
    }
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = cache_path.with_suffix(cache_path.suffix + ".part")
    with gzip.open(tmp_path, "wt", encoding="utf-8") as handle:
        handle.write(_canonical_json(payload))
    tmp_path.replace(cache_path)
    return merged, _content_sha256(payload)


def release_age_weeks(published_on: str | None, archive_date: date) -> int | None:
    """Whole weeks since a group's ``publishedOn`` date, or ``None`` if unknown."""

    if not published_on:
        return None
    try:
        released = date.fromisoformat(str(published_on)[:10])
    except ValueError:
        return None
    delta_days = (archive_date - released).days
    if delta_days < 0:
        return None
    return delta_days // 7


@dataclass(frozen=True, slots=True)
class LifecycleCurve:
    """Pooled release-age -> expected weekly excess log-return lookup."""

    curve: dict[int, float]
    sample_counts: dict[int, int]

    def expected_step_return(self, age_week: int) -> float:
        return self.curve.get(age_week, 0.0)


def build_lifecycle_curve(
    index_set: IndexSet,
    groups_metadata: Mapping[tuple[int, int], Mapping[str, object]],
    *,
    trim_fraction: float = 0.1,
    up_to_index: int | None = None,
) -> LifecycleCurve:
    """Pool group-relative weekly returns by release age.

    ``up_to_index`` is an inclusive information cutoff.  It exists for the
    walk-forward validator: a curve used at historical origin ``o`` must not
    contain returns from ``o + 1`` onward.  Live packet generation leaves it
    unset and therefore uses every observation available at publication
    time.
    """

    last_index = len(index_set.dates) - 1 if up_to_index is None else up_to_index
    if isinstance(last_index, bool) or not isinstance(last_index, int):
        raise ValueError("up_to_index must be an integer or None")
    if not 0 <= last_index < len(index_set.dates):
        raise ValueError("up_to_index is outside the index date range")

    buckets: dict[int, list[float]] = {}
    for (category_id, group_id), arr in index_set.group.items():
        meta = groups_metadata.get((category_id, group_id))
        published_on = meta.get("published_on") if meta else None
        if not published_on:
            continue
        for t in range(1, last_index + 1):
            age_week = release_age_weeks(str(published_on), index_set.dates[t])
            if age_week is None or age_week > MAX_CURVE_AGE_WEEKS:
                continue
            step_return = arr[t] - arr[t - 1]
            if step_return == 0.0 and t <= index_set.group_first_index.get((category_id, group_id), 0):
                continue  # pre-existence padding, not a real observation
            buckets.setdefault(age_week, []).append(step_return)

    curve = {
        age_week: trimmed_mean(values, trim_fraction)
        for age_week, values in buckets.items()
    }
    counts = {age_week: len(values) for age_week, values in buckets.items()}
    return LifecycleCurve(curve=curve, sample_counts=counts)


def cohort_return_over_horizon(curve: LifecycleCurve, current_age_week: int, horizon_steps: int) -> float:
    """Expected cohort log-return summed over the next ``horizon_steps`` weeks."""

    if isinstance(horizon_steps, bool) or not isinstance(horizon_steps, int) or horizon_steps <= 0:
        raise ValueError("horizon_steps must be a positive integer")
    return sum(
        curve.expected_step_return(current_age_week + offset)
        for offset in range(1, horizon_steps + 1)
    )


def blend_group_forecast_delta(
    own_delta: float,
    cohort_return: float,
    *,
    n_group: int,
    horizon_days: int,
    n0: float = N0_LIFECYCLE,
    max_abs_log_return: float | None = 2.0,
) -> tuple[float, float]:
    """Blend a group's own damped-trend delta with the cohort curve.

    Returns ``(blended_delta, own_weight)``. ``lifecycle_cohort`` (from
    ``baselines.py``) supplies the bounded cohort contribution so its clamp
    is reused rather than reimplemented; ``current_price``/``median_price``
    on that call are placeholders in unit-return space (multiplying the
    returned log-return back onto a real price happens later in
    ``trajectory.py``).
    """

    if not isfinite(own_delta):
        raise ValueError("own_delta must be finite")
    if isinstance(n_group, bool) or not isinstance(n_group, int) or n_group < 0:
        raise ValueError("n_group must be a non-negative integer")
    clamped_cohort = lifecycle_cohort(
        1.0, horizon_days, cohort_return, max_abs_log_return=max_abs_log_return
    ).predicted_log_return
    weight_own = n_group / (n_group + n0) if (n_group + n0) > 0 else 0.0
    blended = weight_own * own_delta + (1 - weight_own) * clamped_cohort
    return blended, weight_own
