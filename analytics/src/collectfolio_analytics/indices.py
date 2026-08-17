"""Market / game / set trimmed-mean log-return indices for trajectory-v1 (T2).

Builds three nested levels of weekly log-index, each expressed *relative to*
the level above it, from the TCGCSV weekly panel written by
``tcgcsv_panel.py`` (``analytics/data/panel/category-<id>/<date>.jsonl.gz``):

- ``market``   -- trimmed-mean weekly log-return across every priced variant
                  in every scoped category, cumulated from the first panel
                  date (repeat-sales logic on the full panel).
- ``category`` -- trimmed-mean weekly log-return within one TCGCSV category,
                  cumulated as its *excess* over the same week's market
                  return (roadmap PRD §4: "g_t -- game/category index
                  relative to market").
- ``group``    -- trimmed-mean weekly log-return within one group (set),
                  cumulated as its excess over the same week's category
                  return ("s_t -- set/cohort index relative to game").

A single streaming pass over every requested category's date files builds
all three levels together: the only state carried between dates is one
float (last known price) and one int (last known date index) per variant,
plus the small per-category/per-group cumulative index arrays -- never a
dict of Python-float lists for the full panel. Weeks where a series has no
computable return simply carry its cumulative index forward unchanged.

Because a variant's two consecutive known prices can straddle a data gap
(a week where that variant printed no price), returns are normalized by the
number of elapsed weekly steps, matching ``trends.py``'s day-normalized
adjacent log return in spirit.
"""

from __future__ import annotations

from array import array
from dataclasses import dataclass
from datetime import date
from math import isfinite, log
from pathlib import Path
from statistics import median
from typing import Iterator, Sequence

import gzip
import json

TRIM_FRACTION = 0.1


def trimmed_mean(values: Sequence[float], trim_fraction: float = TRIM_FRACTION) -> float:
    """Symmetric trimmed mean; falls back to the median for tiny samples."""

    if not values:
        raise ValueError("trimmed_mean requires at least one value")
    if isinstance(trim_fraction, bool) or not isfinite(trim_fraction) or not 0 <= trim_fraction < 0.5:
        raise ValueError("trim_fraction must be within [0, 0.5)")
    ordered = sorted(values)
    n = len(ordered)
    cut = int(n * trim_fraction)
    if n - 2 * cut < 1:
        return float(median(ordered))
    kept = ordered[cut: n - cut] if cut else ordered
    return float(sum(kept) / len(kept))


def discover_panel_dates(panel_dir: Path, category_id: int) -> tuple[date, ...]:
    """Every ``<date>.jsonl.gz`` file present for one category, sorted."""

    category_dir = Path(panel_dir) / f"category-{int(category_id)}"
    if not category_dir.is_dir():
        return ()
    found: list[date] = []
    for entry in category_dir.glob("*.jsonl.gz"):
        stem = entry.name[: -len(".jsonl.gz")]
        try:
            found.append(date.fromisoformat(stem))
        except ValueError:
            continue
    return tuple(sorted(found))


def _iter_category_date_rows(path: Path) -> Iterator[tuple[int, int, str, float]]:
    """Yield ``(groupId, productId, subTypeName, price)`` for one panel file."""

    with gzip.open(path, "rt", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            price = row.get("price")
            if not isinstance(price, (int, float)) or isinstance(price, bool) or not isfinite(price) or price <= 0:
                continue
            yield (
                int(row["groupId"]),
                int(row["productId"]),
                str(row["subTypeName"]),
                float(price),
            )


@dataclass(frozen=True, slots=True)
class IndexSet:
    """Weekly market/category/group log-return indices over a shared date grid.

    Every array is a cumulative log index aligned 1:1 with ``dates`` and
    starts at ``0.0`` on ``dates[0]``. Category and group arrays are the
    *relative* index to the level above (see module docstring).
    """

    dates: tuple[date, ...]
    category_ids: tuple[int, ...]
    market: array
    category: dict[int, array]
    group: dict[tuple[int, int], array]
    group_first_index: dict[tuple[int, int], int]
    row_counts: dict[int, int]
    variant_counts: dict[int, int]

    def date_index(self, day: date) -> int | None:
        try:
            return self.dates.index(day)
        except ValueError:
            return None

    def market_step_return(self, t: int) -> float:
        return 0.0 if t <= 0 else self.market[t] - self.market[t - 1]

    def category_step_return(self, category_id: int, t: int) -> float:
        arr = self.category[category_id]
        return 0.0 if t <= 0 else arr[t] - arr[t - 1]

    def group_step_return(self, category_id: int, group_id: int, t: int) -> float:
        arr = self.group.get((category_id, group_id))
        if arr is None or t <= 0:
            return 0.0
        return arr[t] - arr[t - 1]

    def combined_level(self, category_id: int, group_id: int, t: int) -> float:
        """``m_t + g_{c,t} + s_{c,g,t}`` -- the expected cumulative log index."""

        group_arr = self.group.get((category_id, group_id))
        group_value = group_arr[t] if group_arr is not None else 0.0
        return self.market[t] + self.category[category_id][t] + group_value

    def as_receipt_dict(self) -> dict[str, object]:
        return {
            "dates": [d.isoformat() for d in self.dates],
            "categoryIds": list(self.category_ids),
            "groupCount": len(self.group),
            "rowCounts": dict(self.row_counts),
            "variantCounts": dict(self.variant_counts),
            "marketIndexFinal": self.market[-1] if self.market else 0.0,
            "categoryIndexFinal": {
                str(c): arr[-1] for c, arr in self.category.items()
            },
        }


def build_indices(
    panel_dir: Path,
    category_ids: Sequence[int],
    *,
    trim_fraction: float = TRIM_FRACTION,
) -> IndexSet:
    """One streaming pass over every scoped category's panel files.

    Peak resident state: one ``(price, date_index)`` pair per variant seen
    so far (a few floats/ints per variant, never the full 80-week series),
    plus the market/category/group cumulative index arrays themselves.
    """

    panel_dir = Path(panel_dir)
    categories = tuple(sorted({int(c) for c in category_ids}))
    if not categories:
        raise ValueError("build_indices requires at least one category_id")

    dates_per_category = {c: discover_panel_dates(panel_dir, c) for c in categories}
    all_dates = sorted({d for dates in dates_per_category.values() for d in dates})
    if not all_dates:
        raise ValueError("no panel dates found for the requested categories")
    n = len(all_dates)

    prev_price: dict[tuple[int, int, int, str], float] = {}
    prev_index: dict[tuple[int, int, int, str], int] = {}
    variant_seen: dict[int, set[tuple[int, int, str]]] = {c: set() for c in categories}
    row_counts = {c: 0 for c in categories}

    market = array("d", [0.0]) * n
    category_idx: dict[int, array] = {c: array("d", [0.0]) * n for c in categories}
    group_idx: dict[tuple[int, int], array] = {}
    group_first_index: dict[tuple[int, int], int] = {}

    for t, day in enumerate(all_dates):
        if t > 0:
            market[t] = market[t - 1]
            for c in categories:
                category_idx[c][t] = category_idx[c][t - 1]
            for arr in group_idx.values():
                arr[t] = arr[t - 1]

        market_returns: list[float] = []
        cat_returns: dict[int, list[float]] = {c: [] for c in categories}
        group_returns: dict[tuple[int, int], list[float]] = {}

        for c in categories:
            path = panel_dir / f"category-{c}" / f"{day.isoformat()}.jsonl.gz"
            if not path.is_file():
                continue
            for group_id, product_id, subtype, price in _iter_category_date_rows(path):
                row_counts[c] += 1
                variant_seen[c].add((group_id, product_id, subtype))
                key = (c, group_id, product_id, subtype)
                gk = (c, group_id)
                if gk not in group_idx:
                    group_idx[gk] = array("d", [0.0]) * n
                    group_first_index[gk] = t

                pi = prev_index.get(key)
                pp = prev_price.get(key)
                if pi is not None and pp is not None:
                    gap = t - pi
                    if gap > 0:
                        r = log(price / pp) / gap
                        market_returns.append(r)
                        cat_returns[c].append(r)
                        group_returns.setdefault(gk, []).append(r)
                prev_price[key] = price
                prev_index[key] = t

        m_ret = trimmed_mean(market_returns, trim_fraction) if market_returns else 0.0
        if t > 0 and market_returns:
            market[t] = market[t - 1] + m_ret

        cat_ret_this_week: dict[int, float] = {}
        for c in categories:
            if cat_returns[c]:
                c_ret = trimmed_mean(cat_returns[c], trim_fraction)
                cat_ret_this_week[c] = c_ret
                if t > 0:
                    category_idx[c][t] = category_idx[c][t - 1] + (c_ret - m_ret)

        for gk, rlist in group_returns.items():
            c = gk[0]
            g_ret = trimmed_mean(rlist, trim_fraction)
            c_ret = cat_ret_this_week.get(c, 0.0)
            arr = group_idx[gk]
            if t > 0:
                arr[t] = arr[t - 1] + (g_ret - c_ret)
            # t == 0 (or a group's very first sighting): base stays 0.0.

    variant_counts = {c: len(variant_seen[c]) for c in categories}
    return IndexSet(
        dates=tuple(all_dates),
        category_ids=categories,
        market=market,
        category=category_idx,
        group=group_idx,
        group_first_index=group_first_index,
        row_counts=row_counts,
        variant_counts=variant_counts,
    )
