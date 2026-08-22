import gzip
import json
import tempfile
import unittest
from array import array
from datetime import date, timedelta
from pathlib import Path

from collectfolio_analytics.indices import IndexSet
from collectfolio_analytics.lifecycle import (
    LifecycleCurve,
    LifecycleError,
    N0_LIFECYCLE,
    blend_group_forecast_delta,
    build_lifecycle_curve,
    cohort_return_over_horizon,
    fetch_groups_metadata,
    load_or_fetch_groups_metadata,
    release_age_weeks,
)


class ReleaseAgeWeeksTests(unittest.TestCase):
    def test_whole_weeks_since_release(self):
        self.assertEqual(release_age_weeks("2025-01-01", date(2025, 1, 15)), 2)

    def test_partial_week_floors_down(self):
        self.assertEqual(release_age_weeks("2025-01-01", date(2025, 1, 20)), 2)

    def test_unknown_published_on_is_none(self):
        self.assertIsNone(release_age_weeks(None, date(2025, 1, 1)))
        self.assertIsNone(release_age_weeks("", date(2025, 1, 1)))

    def test_archive_date_before_release_is_none(self):
        self.assertIsNone(release_age_weeks("2025-06-01", date(2025, 1, 1)))

    def test_malformed_date_is_none(self):
        self.assertIsNone(release_age_weeks("not-a-date", date(2025, 1, 1)))


class FetchGroupsMetadataTests(unittest.TestCase):
    def test_injected_fetcher_is_normalized_and_keyed_by_category_and_group(self):
        def fake_fetch(base_url, category_id):
            return {
                "success": True,
                "results": [
                    {"groupId": 10, "name": "Set A", "publishedOn": "2024-01-01T00:00:00Z"},
                    {"groupId": 11, "name": "Set B", "publishedOn": None},
                ],
            }

        metadata = fetch_groups_metadata([5], fetch_json=fake_fetch)
        self.assertEqual(set(metadata), {(5, 10), (5, 11)})
        self.assertEqual(metadata[(5, 10)]["published_on"], "2024-01-01")
        self.assertEqual(metadata[(5, 11)]["published_on"], "")

    def test_unsuccessful_response_raises(self):
        def fake_fetch(base_url, category_id):
            return {"success": False, "results": []}

        with self.assertRaises(LifecycleError):
            fetch_groups_metadata([5], fetch_json=fake_fetch)

    def test_missing_results_array_raises(self):
        def fake_fetch(base_url, category_id):
            return {"success": True}

        with self.assertRaises(LifecycleError):
            fetch_groups_metadata([5], fetch_json=fake_fetch)


class LoadOrFetchGroupsMetadataTests(unittest.TestCase):
    def test_fetches_once_then_reuses_cache(self):
        calls = []

        def fake_fetch(base_url, category_id):
            calls.append(category_id)
            return {
                "success": True,
                "results": [{"groupId": 1, "name": "Set", "publishedOn": "2024-01-01"}],
            }

        with tempfile.TemporaryDirectory() as tmp:
            cache_path = Path(tmp) / "groups_metadata.json.gz"
            metadata1, hash1 = load_or_fetch_groups_metadata(cache_path, [5], fetch_json=fake_fetch)
            metadata2, hash2 = load_or_fetch_groups_metadata(cache_path, [5], fetch_json=fake_fetch)
            self.assertEqual(calls, [5])  # second call served from cache, no refetch
            self.assertEqual(hash1, hash2)
            self.assertEqual(metadata1, metadata2)
            self.assertTrue(cache_path.is_file())

    def test_force_refresh_refetches(self):
        calls = []

        def fake_fetch(base_url, category_id):
            calls.append(category_id)
            return {"success": True, "results": []}

        with tempfile.TemporaryDirectory() as tmp:
            cache_path = Path(tmp) / "groups_metadata.json.gz"
            load_or_fetch_groups_metadata(cache_path, [5], fetch_json=fake_fetch)
            load_or_fetch_groups_metadata(cache_path, [5], fetch_json=fake_fetch, force_refresh=True)
            self.assertEqual(calls, [5, 5])

    def test_broader_scope_does_not_starve_categories_missing_from_a_narrow_cache(self):
        """Regression test (found during T3): a cache first written for one
        category must not cause a later, broader request to silently skip
        fetching the other categories just because *some* cache file
        exists on disk.
        """

        calls = []

        def fake_fetch(base_url, category_id):
            calls.append(category_id)
            return {
                "success": True,
                "results": [{"groupId": 100 + category_id, "name": f"Set {category_id}", "publishedOn": "2024-01-01"}],
            }

        with tempfile.TemporaryDirectory() as tmp:
            cache_path = Path(tmp) / "groups_metadata.json.gz"
            # Narrow-scope smoke test writes the cache for category 85 only.
            narrow, _hash = load_or_fetch_groups_metadata(cache_path, [85], fetch_json=fake_fetch)
            self.assertEqual(calls, [85])
            self.assertEqual(set(narrow), {(85, 185)})

            # A later, broader request for [1, 2, 3, 85] must fetch the
            # three missing categories (not re-fetch 85) and must return
            # every requested category's groups, not just 85's.
            broad, _hash2 = load_or_fetch_groups_metadata(cache_path, [1, 2, 3, 85], fetch_json=fake_fetch)
            self.assertEqual(calls, [85, 1, 2, 3])
            self.assertEqual(set(broad), {(1, 101), (2, 102), (3, 103), (85, 185)})

            # And the cache file on disk now durably covers all four, so a
            # third call for the same broad scope makes no new requests.
            broad_again, _hash3 = load_or_fetch_groups_metadata(cache_path, [1, 2, 3, 85], fetch_json=fake_fetch)
            self.assertEqual(calls, [85, 1, 2, 3])
            self.assertEqual(broad, broad_again)

    def test_force_refresh_preserves_categories_outside_current_scope(self):
        calls = []

        def fake_fetch(base_url, category_id):
            calls.append(category_id)
            return {
                "success": True,
                "results": [{"groupId": 100 + category_id, "name": f"Set {category_id}", "publishedOn": "2024-01-01"}],
            }

        with tempfile.TemporaryDirectory() as tmp:
            cache_path = Path(tmp) / "groups_metadata.json.gz"
            load_or_fetch_groups_metadata(cache_path, [1, 85], fetch_json=fake_fetch)
            refreshed, _hash = load_or_fetch_groups_metadata(cache_path, [85], fetch_json=fake_fetch, force_refresh=True)
            # category 1 was outside this call's scope -- still present afterward.
            self.assertEqual(set(refreshed), {(1, 101), (85, 185)})


def _index_set_with_group_returns(
    category_id: int, group_id: int, dates: list[date], step_returns: list[float], first_index: int = 0
) -> IndexSet:
    n = len(dates)
    market = array("d", [0.0]) * n
    category = {category_id: array("d", [0.0]) * n}
    group_arr = array("d", [0.0]) * n
    level = 0.0
    for t in range(1, n):
        level += step_returns[t]
        group_arr[t] = level
    return IndexSet(
        dates=tuple(dates),
        category_ids=(category_id,),
        market=market,
        category=category,
        group={(category_id, group_id): group_arr},
        group_first_index={(category_id, group_id): first_index},
        row_counts={category_id: 0},
        variant_counts={category_id: 0},
    )


class BuildLifecycleCurveTests(unittest.TestCase):
    def test_pools_group_step_returns_by_release_age_week(self):
        category_id, group_id = 1, 100
        dates = [date(2025, 1, 1) + timedelta(weeks=i) for i in range(4)]
        # step returns at t=1,2,3 (t=0 has no step); group released exactly at dates[0].
        step_returns = [0.0, 0.10, 0.20, 0.30]
        index_set = _index_set_with_group_returns(category_id, group_id, dates, step_returns)
        groups_metadata = {
            (category_id, group_id): {"published_on": dates[0].isoformat()},
        }
        curve = build_lifecycle_curve(index_set, groups_metadata)
        # age_week at t=1 is (dates[1]-dates[0]).days//7 = 1, at t=2 -> 2, t=3 -> 3
        self.assertAlmostEqual(curve.expected_step_return(1), 0.10, places=9)
        self.assertAlmostEqual(curve.expected_step_return(2), 0.20, places=9)
        self.assertAlmostEqual(curve.expected_step_return(3), 0.30, places=9)
        self.assertEqual(curve.expected_step_return(999), 0.0)  # unseen age -> neutral default

    def test_groups_without_published_on_are_excluded(self):
        category_id, group_id = 1, 100
        dates = [date(2025, 1, 1) + timedelta(weeks=i) for i in range(3)]
        step_returns = [0.0, 0.5, 0.5]
        index_set = _index_set_with_group_returns(category_id, group_id, dates, step_returns)
        curve = build_lifecycle_curve(index_set, {})
        self.assertEqual(curve.curve, {})

    def test_point_in_time_cutoff_excludes_future_returns(self):
        category_id, group_id = 1, 100
        dates = [date(2025, 1, 1) + timedelta(weeks=i) for i in range(5)]
        index_set = _index_set_with_group_returns(
            category_id, group_id, dates, [0.0, 0.10, 0.20, 9.0, 10.0]
        )
        metadata = {(category_id, group_id): {"published_on": dates[0].isoformat()}}

        causal = build_lifecycle_curve(index_set, metadata, up_to_index=2)

        self.assertAlmostEqual(causal.expected_step_return(1), 0.10, places=9)
        self.assertAlmostEqual(causal.expected_step_return(2), 0.20, places=9)
        self.assertEqual(causal.expected_step_return(3), 0.0)
        self.assertEqual(causal.expected_step_return(4), 0.0)

    def test_point_in_time_cutoff_must_be_inside_date_grid(self):
        category_id, group_id = 1, 100
        dates = [date(2025, 1, 1) + timedelta(weeks=i) for i in range(3)]
        index_set = _index_set_with_group_returns(
            category_id, group_id, dates, [0.0, 0.10, 0.20]
        )
        metadata = {(category_id, group_id): {"published_on": dates[0].isoformat()}}
        for cutoff in (-1, len(dates), True):
            with self.subTest(cutoff=cutoff), self.assertRaises(ValueError):
                build_lifecycle_curve(index_set, metadata, up_to_index=cutoff)


class CohortReturnOverHorizonTests(unittest.TestCase):
    def test_sums_the_next_horizon_steps(self):
        curve = LifecycleCurve(curve={1: 0.01, 2: 0.02, 3: 0.03}, sample_counts={1: 5, 2: 5, 3: 5})
        total = cohort_return_over_horizon(curve, current_age_week=0, horizon_steps=3)
        self.assertAlmostEqual(total, 0.06, places=9)

    def test_rejects_non_positive_horizon(self):
        curve = LifecycleCurve(curve={}, sample_counts={})
        with self.assertRaises(ValueError):
            cohort_return_over_horizon(curve, 0, 0)


class BlendGroupForecastDeltaTests(unittest.TestCase):
    def test_zero_history_defers_entirely_to_cohort_curve(self):
        blended, weight = blend_group_forecast_delta(
            own_delta=1.0, cohort_return=0.05, n_group=0, horizon_days=30,
        )
        self.assertEqual(weight, 0.0)
        self.assertAlmostEqual(blended, 0.05, places=9)

    def test_large_history_favors_own_trend(self):
        blended, weight = blend_group_forecast_delta(
            own_delta=0.08, cohort_return=0.0, n_group=100_000, horizon_days=30,
        )
        self.assertGreater(weight, 0.999)
        self.assertAlmostEqual(blended, 0.08, places=3)

    def test_weight_matches_empirical_bayes_formula(self):
        n_group = 20
        _, weight = blend_group_forecast_delta(
            own_delta=0.0, cohort_return=0.0, n_group=n_group, horizon_days=30,
        )
        self.assertAlmostEqual(weight, n_group / (n_group + N0_LIFECYCLE), places=9)


if __name__ == "__main__":
    unittest.main()
