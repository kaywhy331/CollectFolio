import unittest
from datetime import date

from collectfolio_analytics.demand import DemandPeriod, demand_velocity


def week(start, watch_adds=0, watch_removes=0, searches=0, portfolio_adds=0, views=0,
         unique_users=25, privacy_threshold_met=True):
    return DemandPeriod(
        period_start=start,
        period_end=date.fromordinal(start.toordinal() + 6),
        watch_adds=watch_adds,
        watch_removes=watch_removes,
        searches=searches,
        portfolio_adds=portfolio_adds,
        views=views,
        unique_users=unique_users,
        privacy_threshold_met=privacy_threshold_met,
    )


class DemandPeriodTests(unittest.TestCase):
    def test_rejects_inverted_bounds(self):
        with self.assertRaisesRegex(ValueError, "precede"):
            DemandPeriod(date(2026, 1, 8), date(2026, 1, 1), 0, 0, 0, 0, 0, 0, True)

    def test_rejects_negative_counts(self):
        with self.assertRaisesRegex(ValueError, "non-negative"):
            DemandPeriod(date(2026, 1, 1), date(2026, 1, 7), -1, 0, 0, 0, 0, 0, True)

    def test_days_and_total_engagement(self):
        period = week(date(2026, 1, 1), watch_adds=3, watch_removes=1, searches=5, portfolio_adds=2, views=10)
        self.assertEqual(period.days, 7)
        self.assertEqual(period.total_engagement, 21)


class DemandVelocityTests(unittest.TestCase):
    def test_watchlist_and_search_velocity_over_trailing_week(self):
        cutoff = date(2026, 1, 7)
        periods = [week(date(2026, 1, 1), watch_adds=7, watch_removes=7, searches=14)]
        result = demand_velocity(periods, cutoff)
        self.assertAlmostEqual(result.watchlist_velocity_7d, 2.0)
        self.assertAlmostEqual(result.search_velocity_7d, 2.0)
        self.assertEqual(result.evidence_periods, 1)
        self.assertTrue(result.privacy_supported)

    def test_future_periods_are_excluded_from_the_feature_cutoff(self):
        cutoff = date(2026, 1, 7)
        periods = [
            week(date(2026, 1, 1), searches=7),
            week(date(2026, 1, 8), searches=700),  # ends after cutoff, must not leak in
        ]
        result = demand_velocity(periods, cutoff)
        self.assertEqual(result.evidence_periods, 1)
        self.assertAlmostEqual(result.search_velocity_7d, 1.0)

    def test_below_threshold_period_withholds_the_whole_window_rate(self):
        cutoff = date(2026, 1, 7)
        periods = [week(date(2026, 1, 1), searches=14, privacy_threshold_met=False)]
        result = demand_velocity(periods, cutoff)
        self.assertIsNone(result.search_velocity_7d)
        self.assertFalse(result.privacy_supported)

    def test_mixed_threshold_periods_in_one_window_withhold_the_rate(self):
        cutoff = date(2026, 1, 14)
        periods = [
            week(date(2026, 1, 1), searches=7, privacy_threshold_met=True),
            week(date(2026, 1, 8), searches=7, privacy_threshold_met=False),
        ]
        result = demand_velocity(periods, cutoff)
        self.assertIsNone(result.watchlist_velocity_30d)
        self.assertTrue(result.privacy_supported)  # at least one period met it

    def test_no_evidence_before_cutoff_returns_none_rates(self):
        cutoff = date(2025, 1, 1)
        periods = [week(date(2026, 1, 1), searches=7)]
        result = demand_velocity(periods, cutoff)
        self.assertEqual(result.evidence_periods, 0)
        self.assertIsNone(result.search_velocity_7d)
        self.assertIsNone(result.demand_acceleration)
        self.assertFalse(result.privacy_supported)

    def test_demand_acceleration_compares_trailing_week_to_prior_week(self):
        cutoff = date(2026, 1, 14)
        periods = [
            week(date(2026, 1, 1), watch_adds=7),   # prior week: 1/day total engagement
            week(date(2026, 1, 8), watch_adds=21),  # current week: 3/day total engagement
        ]
        result = demand_velocity(periods, cutoff)
        self.assertAlmostEqual(result.demand_acceleration, 2.0)

    def test_demand_acceleration_is_none_without_both_windows(self):
        cutoff = date(2026, 1, 7)
        periods = [week(date(2026, 1, 1), watch_adds=7)]
        result = demand_velocity(periods, cutoff)
        self.assertIsNone(result.demand_acceleration)

    def test_overlapping_periods_are_rejected(self):
        periods = [week(date(2026, 1, 1)), week(date(2026, 1, 4))]
        with self.assertRaisesRegex(ValueError, "non-overlapping"):
            demand_velocity(periods, date(2026, 1, 10))

    def test_portfolio_add_and_view_velocity_use_30d_and_7d_windows_respectively(self):
        cutoff = date(2026, 1, 28)
        periods = [
            week(date(2026, 1, 1), portfolio_adds=7, views=7),
            week(date(2026, 1, 8), portfolio_adds=7, views=7),
            week(date(2026, 1, 15), portfolio_adds=7, views=7),
            week(date(2026, 1, 22), portfolio_adds=7, views=70),
        ]
        result = demand_velocity(periods, cutoff)
        self.assertAlmostEqual(result.portfolio_add_velocity_30d, 1.0)
        self.assertAlmostEqual(result.view_velocity_7d, 10.0)


if __name__ == "__main__":
    unittest.main()
