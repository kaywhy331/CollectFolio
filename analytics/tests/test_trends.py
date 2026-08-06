from datetime import datetime, timedelta, timezone
from math import exp, log
import unittest

from collectfolio_analytics.observations import PriceObservation, PriceSeriesKey
from collectfolio_analytics.trends import (
    build_trend_snapshot,
    classify_trend,
    endpoint_log_return,
    mad_log_return_volatility,
    max_drawdown,
    theil_sen_log_slope,
)


UTC = timezone.utc
START = datetime(2025, 1, 1, tzinfo=UTC)
KEY = PriceSeriesKey(
    "33333333-3333-4333-8333-333333333333",
    "market-a",
    "USD",
    "normal",
    "raw",
    "daily-median",
)


def series(prices, *, quality=1.0):
    return [
        PriceObservation(KEY, START + timedelta(days=index), START + timedelta(days=index), price, quality)
        for index, price in enumerate(prices)
    ]


class TrendTests(unittest.TestCase):
    def test_theil_sen_resists_one_extreme_outlier(self):
        prices = [100 * exp(0.01 * day) for day in range(21)]
        prices[10] *= 50
        self.assertAlmostEqual(theil_sen_log_slope(series(prices)), 0.01, places=10)

    def test_mad_volatility_is_zero_for_constant_log_returns(self):
        prices = [100 * exp(0.02 * day) for day in range(10)]
        self.assertAlmostEqual(mad_log_return_volatility(series(prices)), 0.0, places=12)

    def test_drawdown_reports_peak_to_trough_magnitude(self):
        self.assertAlmostEqual(max_drawdown(series([100, 120, 90, 110])), 0.25)

    def test_endpoint_return_never_uses_a_post_target_reference(self):
        values = series([100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110])
        self.assertAlmostEqual(endpoint_log_return(values, 7), log(110 / 103), places=12)
        sparse = [values[0], values[8], values[10]]
        self.assertIsNone(endpoint_log_return(sparse, 7, max_reference_lag_days=2))

    def test_classification_is_quality_gated(self):
        state, slope_z = classify_trend(0.01, 0.005, data_quality=0.2, observation_count=90)
        self.assertEqual(state, "insufficient_data")
        self.assertEqual(slope_z, 2)
        state, _ = classify_trend(0.01, 0.005, data_quality=1, observation_count=90)
        self.assertEqual(state, "strong_rise")

    def test_snapshot_is_point_in_time_and_computes_declared_horizons(self):
        values = series([100 * exp(0.01 * day) for day in range(370)])
        cutoff = START + timedelta(days=369, hours=12)
        values.append(PriceObservation(
            KEY,
            START + timedelta(days=369),
            cutoff + timedelta(hours=1),
            1_000_000,
            source_observation_id="late-backfill",
        ))
        snapshot = build_trend_snapshot(values, cutoff)
        self.assertAlmostEqual(snapshot.current_price, 100 * exp(3.69))
        self.assertAlmostEqual(snapshot.return_7d, 0.07, places=12)
        self.assertAlmostEqual(snapshot.return_30d, 0.30, places=12)
        self.assertAlmostEqual(snapshot.return_90d, 0.90, places=12)
        self.assertAlmostEqual(snapshot.return_180d, 1.80, places=12)
        self.assertAlmostEqual(snapshot.return_365d, 3.65, places=12)
        self.assertAlmostEqual(snapshot.robust_slope_90d, 0.01, places=12)
        self.assertAlmostEqual(snapshot.history_density_90d, 1.0)
        self.assertAlmostEqual(snapshot.staleness_hours, 12.0)
        self.assertEqual(snapshot.trend_state, "strong_rise")
        self.assertEqual(snapshot.observation_count_90d, 91)


if __name__ == "__main__":
    unittest.main()
