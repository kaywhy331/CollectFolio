import gzip
import json
import tempfile
import unittest
from datetime import date
from pathlib import Path

from collectfolio_analytics.indices import (
    build_indices,
    discover_panel_dates,
    trimmed_mean,
)


def _write_panel_file(panel_dir: Path, category_id: int, day: date, rows: list[dict]) -> None:
    category_dir = panel_dir / f"category-{category_id}"
    category_dir.mkdir(parents=True, exist_ok=True)
    with gzip.open(category_dir / f"{day.isoformat()}.jsonl.gz", "wt", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row) + "\n")


class TrimmedMeanTests(unittest.TestCase):
    def test_no_trim_averages_everything(self):
        self.assertAlmostEqual(trimmed_mean([1.0, 2.0, 3.0]), 2.0)

    def test_trim_drops_extreme_values_symmetrically(self):
        # n=10, trim_fraction=0.2 -> cut=2, kept = sorted[2:8]
        values = [100.0, -100.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0]
        self.assertAlmostEqual(trimmed_mean(values, trim_fraction=0.2), (2 + 3 + 4 + 5 + 6 + 7) / 6)

    def test_rejects_empty_input(self):
        with self.assertRaises(ValueError):
            trimmed_mean([])

    def test_rejects_bad_trim_fraction(self):
        with self.assertRaises(ValueError):
            trimmed_mean([1.0, 2.0], trim_fraction=0.5)


class DiscoverPanelDatesTests(unittest.TestCase):
    def test_discovers_and_sorts_available_dates(self):
        with tempfile.TemporaryDirectory() as tmp:
            panel_dir = Path(tmp)
            _write_panel_file(panel_dir, 1, date(2025, 2, 1), [])
            _write_panel_file(panel_dir, 1, date(2025, 1, 1), [])
            found = discover_panel_dates(panel_dir, 1)
            self.assertEqual(found, (date(2025, 1, 1), date(2025, 2, 1)))

    def test_missing_category_directory_returns_empty(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(discover_panel_dates(Path(tmp), 999), ())


class IndexRecoveryTests(unittest.TestCase):
    """Constructed two-category, two-group panel with hand-computable returns.

    Date 0: every variant priced at 100.0.
    Date 1: category A's two variants both return +20% log; category B's two
    variants are unchanged (0% log return). Within each category the two
    variants belong to the same single group, so the group has zero excess
    over its category by construction -- only market vs. category should
    move.
    """

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        panel_dir = Path(self.tmp.name)
        self.panel_dir = panel_dir
        self.category_a = 1000
        self.category_b = 2000
        d0, d1 = date(2025, 1, 5), date(2025, 1, 12)
        self.d0, self.d1 = d0, d1

        rows_a0 = [
            {"groupId": 100, "productId": 1, "subTypeName": "Normal", "price": 100.0},
            {"groupId": 100, "productId": 2, "subTypeName": "Normal", "price": 100.0},
        ]
        rows_b0 = [
            {"groupId": 200, "productId": 3, "subTypeName": "Normal", "price": 100.0},
            {"groupId": 200, "productId": 4, "subTypeName": "Normal", "price": 100.0},
        ]
        growth_a = 100.0 * (2.718281828459045 ** 0.20)  # +20% log return
        rows_a1 = [
            {"groupId": 100, "productId": 1, "subTypeName": "Normal", "price": growth_a},
            {"groupId": 100, "productId": 2, "subTypeName": "Normal", "price": growth_a},
        ]
        rows_b1 = [
            {"groupId": 200, "productId": 3, "subTypeName": "Normal", "price": 100.0},
            {"groupId": 200, "productId": 4, "subTypeName": "Normal", "price": 100.0},
        ]

        _write_panel_file(panel_dir, self.category_a, d0, rows_a0)
        _write_panel_file(panel_dir, self.category_b, d0, rows_b0)
        _write_panel_file(panel_dir, self.category_a, d1, rows_a1)
        _write_panel_file(panel_dir, self.category_b, d1, rows_b1)

        self.index_set = build_indices(panel_dir, [self.category_a, self.category_b])

    def test_dates_and_variant_counts(self):
        self.assertEqual(self.index_set.dates, (self.d0, self.d1))
        self.assertEqual(self.index_set.variant_counts[self.category_a], 2)
        self.assertEqual(self.index_set.variant_counts[self.category_b], 2)

    def test_market_index_is_the_pooled_trimmed_mean_return(self):
        # market_returns this week = [0.20, 0.20, 0.00, 0.00] -> mean 0.10
        self.assertAlmostEqual(self.index_set.market[1], 0.10, places=9)

    def test_category_indices_hold_the_excess_over_market(self):
        # category A: own return 0.20, excess over market (0.10) = +0.10
        self.assertAlmostEqual(self.index_set.category[self.category_a][1], 0.10, places=9)
        # category B: own return 0.00, excess over market (0.10) = -0.10
        self.assertAlmostEqual(self.index_set.category[self.category_b][1], -0.10, places=9)

    def test_group_indices_have_zero_excess_when_group_equals_category(self):
        group_a = self.index_set.group[(self.category_a, 100)]
        group_b = self.index_set.group[(self.category_b, 200)]
        self.assertAlmostEqual(group_a[1], 0.0, places=9)
        self.assertAlmostEqual(group_b[1], 0.0, places=9)

    def test_combined_level_recovers_each_variant_actual_return(self):
        # m + g + s should reconstruct the per-variant observed log return.
        combined_a = self.index_set.combined_level(self.category_a, 100, 1)
        combined_b = self.index_set.combined_level(self.category_b, 200, 1)
        self.assertAlmostEqual(combined_a, 0.20, places=9)
        self.assertAlmostEqual(combined_b, 0.00, places=9)

    def test_row_counts_match_rows_written(self):
        self.assertEqual(self.index_set.row_counts[self.category_a], 4)
        self.assertEqual(self.index_set.row_counts[self.category_b], 4)


if __name__ == "__main__":
    unittest.main()
