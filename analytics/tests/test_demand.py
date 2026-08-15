import unittest
from datetime import date

from collectfolio_analytics.demand import (
    DEMAND_MODEL_COMPONENTS,
    DEMAND_NORMALIZATION_UNIT,
    DEMAND_NORMALIZATION_VERSION,
    DemandPeriod,
    demand_velocity,
)


def week(start, watch_adds=0, watch_removes=0, searches=0, portfolio_adds=0, views=0,
         unique_users=25, privacy_threshold_met=True, days=7):
    return DemandPeriod(
        period_start=start,
        period_end=date.fromordinal(start.toordinal() + days - 1),
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
        self.assertEqual(period.total_engagement, 19)


class DemandVelocityTests(unittest.TestCase):
    def test_watchlist_and_search_velocity_over_trailing_week(self):
        cutoff = date(2026, 1, 7)
        periods = [week(date(2026, 1, 1), watch_adds=7, watch_removes=7, searches=14)]
        result = demand_velocity(periods, cutoff)
        self.assertAlmostEqual(result.watchlist_velocity_7d, 0.0)
        self.assertAlmostEqual(result.search_velocity_7d, 14 / (25 * 7))
        self.assertEqual(result.evidence_periods, 1)
        self.assertTrue(result.privacy_supported)
        self.assertEqual(result.normalization_version, DEMAND_NORMALIZATION_VERSION)
        self.assertEqual(result.normalization_unit, DEMAND_NORMALIZATION_UNIT)
        self.assertEqual(result.model_signal_components, DEMAND_MODEL_COMPONENTS)
        self.assertFalse(result.population_normalized)
        self.assertFalse(result.recommendation_exposure_adjusted)

    def test_watch_removals_are_negative_rather_than_positive_demand(self):
        cutoff = date(2026, 1, 14)
        periods = [
            week(date(2026, 1, 1), watch_adds=14, watch_removes=0),
            week(date(2026, 1, 8), watch_adds=7, watch_removes=14),
        ]
        result = demand_velocity(periods, cutoff)
        self.assertAlmostEqual(result.watchlist_velocity_7d, -7 / (25 * 7))
        self.assertAlmostEqual(result.demand_acceleration, -21 / (25 * 7))

    def test_interim_rates_use_period_distinct_engaged_user_intensity(self):
        cutoff = date(2026, 1, 7)
        fewer_users = demand_velocity([
            week(date(2026, 1, 1), searches=14, unique_users=10),
        ], cutoff)
        more_users = demand_velocity([
            week(date(2026, 1, 1), searches=14, unique_users=20),
        ], cutoff)
        self.assertAlmostEqual(
            fewer_users.search_velocity_7d,
            2 * more_users.search_velocity_7d,
        )

    def test_scaling_events_and_period_distinct_users_together_preserves_intensity(self):
        cutoff = date(2026, 1, 7)
        smaller = demand_velocity([
            week(date(2026, 1, 1), searches=10, unique_users=10),
        ], cutoff)
        larger = demand_velocity([
            week(date(2026, 1, 1), searches=20, unique_users=20),
        ], cutoff)
        self.assertAlmostEqual(smaller.search_velocity_7d, larger.search_velocity_7d)

    def test_population_growth_alone_does_not_create_acceleration(self):
        result = demand_velocity([
            week(date(2026, 1, 1), watch_adds=10, unique_users=10),
            week(date(2026, 1, 8), watch_adds=20, unique_users=20),
        ], date(2026, 1, 14))
        self.assertAlmostEqual(result.demand_acceleration, 0.0)

    def test_supported_zero_user_period_abstains_instead_of_dividing_by_zero(self):
        result = demand_velocity([
            week(date(2026, 1, 1), searches=14, unique_users=0),
        ], date(2026, 1, 7))
        self.assertIsNone(result.search_velocity_7d)
        self.assertIsNone(result.demand_acceleration)

    def test_future_periods_are_excluded_from_the_feature_cutoff(self):
        cutoff = date(2026, 1, 7)
        periods = [
            week(date(2026, 1, 1), searches=7),
            week(date(2026, 1, 8), searches=700),  # ends after cutoff, must not leak in
        ]
        result = demand_velocity(periods, cutoff)
        self.assertEqual(result.evidence_periods, 1)
        self.assertAlmostEqual(result.search_velocity_7d, 7 / (25 * 7))

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
        self.assertFalse(result.privacy_supported)

    def test_gapped_window_abstains_instead_of_using_partial_coverage(self):
        result = demand_velocity([
            week(date(2026, 1, 1), watch_adds=7),
            week(date(2026, 1, 9), watch_adds=6, days=6),
        ], date(2026, 1, 14))
        self.assertIsNone(result.watchlist_velocity_7d)
        self.assertIsNone(result.demand_acceleration)

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
        self.assertAlmostEqual(result.demand_acceleration, 14 / (25 * 7))

    def test_passive_view_and_search_spikes_do_not_raise_model_acceleration(self):
        cutoff = date(2026, 1, 14)
        periods = [
            week(date(2026, 1, 1), watch_adds=7, searches=7, views=7),
            week(date(2026, 1, 8), watch_adds=7, searches=700, views=700),
        ]
        result = demand_velocity(periods, cutoff)
        self.assertAlmostEqual(result.demand_acceleration, 0.0)
        self.assertGreater(result.search_velocity_7d, 1.0)
        self.assertGreater(result.view_velocity_7d, 1.0)

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
        cutoff = date(2026, 1, 30)
        portfolio = demand_velocity([
            week(date(2026, 1, 1), portfolio_adds=30, days=30),
        ], cutoff)
        views = demand_velocity([
            week(date(2026, 1, 24), views=70),
        ], cutoff)
        self.assertAlmostEqual(portfolio.portfolio_add_velocity_30d, 30 / (25 * 30))
        self.assertAlmostEqual(views.view_velocity_7d, 70 / (25 * 7))


if __name__ == "__main__":
    unittest.main()
