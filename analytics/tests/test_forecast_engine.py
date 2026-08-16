from dataclasses import replace
from datetime import datetime, timedelta, timezone
from math import exp, log
import unittest
from uuid import UUID

from collectfolio_analytics.demand import DEMAND_NORMALIZATION_VERSION
from collectfolio_analytics.forecast_engine import (
    AcquisitionQuoteKey,
    AcquisitionCosts,
    DEFAULT_FORECAST_MODEL_VERSION,
    DeclaredPanelCoverage,
    ForecastEnginePolicy,
    ForecastFeatures,
    MaturedTrainingExample,
    ShadowForecastLedgerItem,
    ShadowEvaluationPolicy,
    build_shadow_forecast_packet,
    build_watch_candidate,
    evaluate_selected_pockets,
    run_shadow_walk_forward,
    train_shadow_forecast,
)
from collectfolio_analytics.evaluation import ResearchLineage
from collectfolio_analytics.forecasting import ResearchModelCard
from collectfolio_analytics.forecasting import PromotionPolicy
from collectfolio_analytics.market_pipeline import SourceTerms
from collectfolio_analytics.observations import PriceSeriesKey
from collectfolio_analytics.trends import TrendSnapshot


UTC = timezone.utc
ORIGIN = datetime(2026, 8, 1, tzinfo=UTC)
SOURCE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
TERMS_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
RUN_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
MODEL_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
SNAPSHOT_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
VARIANT_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff"


def features(
    index=0, *, origin=None, price=100, quality=0.9,
    demand=0.015, demand_version=DEMAND_NORMALIZATION_VERSION,
):
    when = origin or ORIGIN + timedelta(days=index * 31)
    return ForecastFeatures(
        variant_id=f"variant-{index}",
        cohort_key="pokemon-en-raw-nm",
        origin=when,
        current_price=price,
        robust_daily_log_slope=0.001,
        volatility_daily=0.015,
        evidence_quality=quality,
        history_days=180,
        market_daily_log_slope=0.0005,
        lifecycle_log_return_30d=0.025,
        lifecycle_log_return_90d=0.06,
        structural_median_price=120,
        structural_lower_price=108,
        demand_acceleration=demand,
        demand_normalization_version=demand_version,
        reprint_risk=0.1,
        feature_timestamps=(when,),
    )


def examples(count=48, horizon=30):
    values = []
    start = ORIGIN - timedelta(days=(count + 5) * 31)
    for index in range(count):
        row = features(index, origin=start + timedelta(days=index * 31), price=80 + index)
        realized_return = 0.03 + (index % 5 - 2) * 0.01
        values.append(MaturedTrainingExample(
            row,
            horizon,
            row.current_price * exp(realized_return),
            row.origin + timedelta(days=horizon, hours=1),
        ))
    return values


class ForecastEngineTests(unittest.TestCase):
    def test_model_version_is_fixed_to_the_implemented_v2_math(self):
        for invalid_version in (
            "forecast-ensemble-v1",
            "caller-defined-v99",
            "",
            None,
        ):
            with self.subTest(model_version=invalid_version):
                with self.assertRaisesRegex(
                    ValueError, "model_version must equal forecast-ensemble-v2",
                ):
                    train_shadow_forecast(
                        features(origin=ORIGIN), (), 30, ORIGIN,
                        model_version=invalid_version,
                    )

        forecast = train_shadow_forecast(
            features(origin=ORIGIN), (), 30, ORIGIN,
            model_version=f"  {DEFAULT_FORECAST_MODEL_VERSION}  ",
        )
        self.assertEqual(forecast.model_version, DEFAULT_FORECAST_MODEL_VERSION)
        with self.assertRaisesRegex(
            ValueError, "model_version must equal forecast-ensemble-v2",
        ):
            replace(forecast, model_version="forecast-ensemble-v1")

    def test_point_in_time_features_reject_future_inputs(self):
        with self.assertRaisesRegex(ValueError, "exceeds"):
            ForecastFeatures(
                "v", "c", ORIGIN, 100, 0, 0.01, 0.8, 100,
                feature_timestamps=(ORIGIN + timedelta(seconds=1),),
            )

    def test_declared_coverage_blockers_are_bound_inside_the_report_hash(self):
        lineage = ResearchLineage(
            "1" * 64,
            "git:test",
            "forecast-features-v2-observation-compiled-v1",
            "mapping-v1",
            DEFAULT_FORECAST_MODEL_VERSION,
        )
        coverage = DeclaredPanelCoverage(
            planned_count=1,
            feature_abstained_count=1,
            open_count=0,
            scored_count=0,
            unscorable_count=0,
            cell_ledger_sha256="2" * 64,
            promotion_block_reason_codes=("first_blocker",),
        )
        first = run_shadow_walk_forward(
            (), 30, "declared-cohort", {}, lineage,
            declared_panel_coverage=coverage,
        )
        second = run_shadow_walk_forward(
            (), 30, "declared-cohort", {}, lineage,
            declared_panel_coverage=replace(
                coverage, promotion_block_reason_codes=("second_blocker",),
            ),
        )
        changed_lineage = run_shadow_walk_forward(
            (), 30, "declared-cohort", {},
            replace(lineage, dataset_sha256="3" * 64),
            declared_panel_coverage=coverage,
        )
        self.assertEqual(first.recommendation, "insufficient")
        self.assertIn("first_blocker", first.reason_codes)
        self.assertNotEqual(first.report_hash, second.report_hash)
        self.assertNotEqual(first.report_hash, changed_lineage.report_hash)
        self.assertEqual(first.as_dict()["declaredPanelCoverage"]["plannedCount"], 1)
        self.assertEqual(first.as_dict()["lineage"]["datasetSha256"], "1" * 64)

    def test_shadow_forecast_uses_all_available_challengers_and_is_immutable(self):
        forecast = train_shadow_forecast(
            features(origin=ORIGIN),
            examples(),
            30,
            ORIGIN,
            policy=ForecastEnginePolicy(minimum_training_examples=30, minimum_calibration_examples=10),
        )
        self.assertEqual(forecast.status, "research_only")
        self.assertEqual(set(forecast.model_weights), {
            "no_change", "damped_momentum", "market_index", "lifecycle_cohort",
            "structural_convergence", "event_risk",
        })
        self.assertIn("demand_signal_withheld", forecast.reason_codes)
        self.assertLessEqual(forecast.quantiles[0.10], forecast.quantiles[0.25])
        self.assertLessEqual(forecast.quantiles[0.25], forecast.quantiles[0.50])
        self.assertLessEqual(forecast.quantiles[0.50], forecast.quantiles[0.75])
        self.assertLessEqual(forecast.quantiles[0.75], forecast.quantiles[0.90])
        self.assertGreaterEqual(forecast.probability_up, 0)
        self.assertLessEqual(forecast.probability_up, 1)
        self.assertFalse(forecast.public_publication_allowed)
        self.assertEqual(len(forecast.artifact_hash), 64)

    def test_evidence_quality_shrinks_center_and_widens_log_interval(self):
        policy = ForecastEnginePolicy(
            minimum_training_examples=30,
            minimum_calibration_examples=10,
            maximum_evidence_interval_multiplier=2.0,
        )
        strongest = train_shadow_forecast(
            features(origin=ORIGIN, quality=1.0), examples(), 30, ORIGIN,
            policy=policy,
        )
        weaker = train_shadow_forecast(
            features(origin=ORIGIN, quality=0.6), examples(), 30, ORIGIN,
            policy=policy,
        )
        floor = train_shadow_forecast(
            features(origin=ORIGIN, quality=policy.minimum_evidence_quality),
            examples(), 30, ORIGIN, policy=policy,
        )
        below = train_shadow_forecast(
            features(
                origin=ORIGIN,
                quality=policy.minimum_evidence_quality - 1e-6,
            ),
            examples(), 30, ORIGIN, policy=policy,
        )
        self.assertEqual(weaker.status, "research_only")
        self.assertLess(
            abs(log(weaker.quantiles[0.50] / weaker.current_price)),
            abs(log(strongest.quantiles[0.50] / strongest.current_price)),
        )
        self.assertGreater(
            log(weaker.quantiles[0.90] / weaker.quantiles[0.10]),
            log(strongest.quantiles[0.90] / strongest.quantiles[0.10]),
        )
        self.assertGreaterEqual(
            log(floor.quantiles[0.90] / floor.quantiles[0.10]),
            log(weaker.quantiles[0.90] / weaker.quantiles[0.10]),
        )
        self.assertAlmostEqual(floor.quantiles[0.50], floor.current_price)
        self.assertAlmostEqual(below.quantiles[0.50], below.current_price)
        self.assertEqual(floor.status, "research_only")
        self.assertEqual(below.status, "quarantined")
        self.assertIn("evidence_quality_adjusted", weaker.reason_codes)
        self.assertNotIn("evidence_quality_adjusted", strongest.reason_codes)
        self.assertAlmostEqual(
            weaker.probability_up,
            sum(value > 0 for value in weaker.calibration_distribution)
            / len(weaker.calibration_distribution),
        )

    def test_evidence_widens_even_when_pre_adjustment_sigma_is_saturated(self):
        policy = ForecastEnginePolicy(
            minimum_training_examples=30,
            minimum_calibration_examples=10,
            minimum_sigma=0.03,
            maximum_sigma=0.04,
            maximum_evidence_interval_multiplier=2.0,
        )
        strongest = train_shadow_forecast(
            features(origin=ORIGIN, quality=1.0), examples(), 30, ORIGIN,
            policy=policy,
        )
        floor = train_shadow_forecast(
            features(origin=ORIGIN, quality=policy.minimum_evidence_quality),
            examples(), 30, ORIGIN, policy=policy,
        )
        self.assertGreater(
            log(floor.quantiles[0.90] / floor.quantiles[0.10]),
            log(strongest.quantiles[0.90] / strongest.quantiles[0.10]),
        )

    def test_evidence_floor_one_handles_epsilon_below_without_division_by_zero(self):
        policy = ForecastEnginePolicy(
            minimum_training_examples=30,
            minimum_calibration_examples=10,
            minimum_evidence_quality=1.0,
        )
        exact = train_shadow_forecast(
            features(origin=ORIGIN, quality=1.0), examples(), 30, ORIGIN,
            policy=policy,
        )
        below = train_shadow_forecast(
            features(origin=ORIGIN, quality=1.0 - 1e-6), examples(), 30, ORIGIN,
            policy=policy,
        )
        self.assertEqual(exact.status, "research_only")
        self.assertEqual(below.status, "quarantined")
        self.assertAlmostEqual(below.quantiles[0.50], below.current_price)

    def test_positive_and_negative_centers_both_anchor_to_no_change_at_floor(self):
        policy = ForecastEnginePolicy(
            minimum_training_examples=30,
            minimum_calibration_examples=10,
        )
        positive = train_shadow_forecast(
            features(origin=ORIGIN, quality=1.0), examples(), 30, ORIGIN,
            policy=policy,
        )
        negative_target = replace(
            features(origin=ORIGIN, quality=1.0),
            robust_daily_log_slope=-0.10,
            market_daily_log_slope=-0.10,
            lifecycle_log_return_30d=-0.70,
            lifecycle_log_return_90d=-0.70,
            structural_median_price=40,
            structural_lower_price=30,
            reprint_risk=1.0,
        )
        negative = train_shadow_forecast(
            negative_target, examples(), 30, ORIGIN,
            policy=policy,
        )
        negative_floor = train_shadow_forecast(
            replace(negative_target, evidence_quality=policy.minimum_evidence_quality),
            examples(), 30, ORIGIN, policy=policy,
        )
        self.assertGreater(positive.quantiles[0.50], positive.current_price)
        self.assertLess(negative.quantiles[0.50], negative.current_price)
        self.assertAlmostEqual(negative_floor.quantiles[0.50], negative_floor.current_price)

    def test_evidence_policy_bounds_and_hashes_are_explicit(self):
        for multiplier in (0.999, 2.001):
            with self.assertRaisesRegex(ValueError, "between one and two"):
                ForecastEnginePolicy(maximum_evidence_interval_multiplier=multiplier)
        narrow = train_shadow_forecast(
            features(origin=ORIGIN, quality=0.6), examples(), 30, ORIGIN,
            policy=ForecastEnginePolicy(
                minimum_training_examples=30,
                minimum_calibration_examples=10,
                maximum_evidence_interval_multiplier=1.0,
            ),
        )
        wide = train_shadow_forecast(
            features(origin=ORIGIN, quality=0.6), examples(), 30, ORIGIN,
            policy=ForecastEnginePolicy(
                minimum_training_examples=30,
                minimum_calibration_examples=10,
                maximum_evidence_interval_multiplier=2.0,
            ),
        )
        self.assertEqual(wide.model_version, DEFAULT_FORECAST_MODEL_VERSION)
        self.assertNotEqual(narrow.model_definition_hash, wide.model_definition_hash)
        self.assertNotEqual(narrow.artifact_hash, wide.artifact_hash)

    def test_degenerate_empirical_distribution_falls_back_and_quarantines(self):
        rows = []
        start = ORIGIN - timedelta(days=53 * 31)
        for index in range(48):
            when = start + timedelta(days=index * 31)
            row = ForecastFeatures(
                variant_id=f"flat-{index}",
                cohort_key="flat-cohort",
                origin=when,
                current_price=100,
                robust_daily_log_slope=0,
                volatility_daily=0.01,
                evidence_quality=1,
                history_days=180,
                feature_timestamps=(when,),
            )
            rows.append(MaturedTrainingExample(
                row, 30, row.current_price, when + timedelta(days=30, hours=1),
            ))
        target = ForecastFeatures(
            variant_id="flat-target",
            cohort_key="flat-cohort",
            origin=ORIGIN,
            current_price=100,
            robust_daily_log_slope=0,
            volatility_daily=0.01,
            evidence_quality=1,
            history_days=180,
            feature_timestamps=(ORIGIN,),
        )
        forecast = train_shadow_forecast(
            target, rows, 30, ORIGIN,
            policy=ForecastEnginePolicy(
                minimum_training_examples=30,
                minimum_calibration_examples=10,
            ),
        )
        self.assertEqual(forecast.status, "quarantined")
        self.assertIn("degenerate_calibration_distribution", forecast.reason_codes)
        self.assertEqual(forecast.calibration_distribution, ())
        self.assertAlmostEqual(forecast.probability_up, 0.5)
        self.assertTrue(all(value > 0 for value in forecast.quantiles.values()))
        self.assertEqual(
            list(forecast.quantiles.values()),
            sorted(forecast.quantiles.values()),
        )

    def test_extreme_price_output_fails_closed_instead_of_emitting_infinity(self):
        target = ForecastFeatures(
            variant_id="extreme-target",
            cohort_key="pokemon-en-raw-nm",
            origin=ORIGIN,
            current_price=1.7e308,
            robust_daily_log_slope=0.1,
            volatility_daily=0.015,
            evidence_quality=1,
            history_days=180,
            market_daily_log_slope=0.1,
            lifecycle_log_return_30d=0.7,
            lifecycle_log_return_90d=0.7,
            structural_median_price=1.79e308,
            structural_lower_price=1.75e308,
            reprint_risk=0,
            feature_timestamps=(ORIGIN,),
        )
        with self.assertRaisesRegex(ValueError, "finite and positive|overflowed"):
            train_shadow_forecast(
                target, examples(), 30, ORIGIN,
                policy=ForecastEnginePolicy(
                    minimum_training_examples=30,
                    minimum_calibration_examples=10,
                ),
            )

    def test_demand_is_hard_disabled_and_cannot_change_v2_forecasts(self):
        with self.assertRaisesRegex(ValueError, "demand acceleration is unavailable"):
            ForecastEnginePolicy(use_demand_acceleration=True)
        positive = train_shadow_forecast(
            features(origin=ORIGIN, demand=0.08), examples(), 30, ORIGIN,
        )
        negative = train_shadow_forecast(
            features(
                origin=ORIGIN, demand=-0.08,
                demand_version="caller-asserted-magic-version",
            ),
            examples(), 30, ORIGIN,
        )
        self.assertEqual(positive.quantiles, negative.quantiles)
        self.assertNotIn("demand_acceleration", positive.model_weights)
        self.assertIn("demand_signal_withheld", negative.reason_codes)

    def test_selection_and_calibration_keep_whole_origins_disjoint(self):
        shared = []
        start = ORIGIN - timedelta(days=20 * 31)
        for origin_index in range(18):
            when = start + timedelta(days=origin_index * 31)
            for variant_index in range(2):
                row = features(variant_index, origin=when, price=80 + origin_index + variant_index)
                shared.append(MaturedTrainingExample(
                    row, 30, row.current_price * 1.03, when + timedelta(days=30)
                ))
        forecast = train_shadow_forecast(
            features(origin=ORIGIN), shared, 30, ORIGIN,
            policy=ForecastEnginePolicy(minimum_training_examples=20, minimum_calibration_examples=6),
        )
        self.assertEqual(forecast.status, "research_only")
        # Whole-origin splitting yields an even calibration count for two variants/origin.
        self.assertEqual(forecast.calibration_count % 2, 0)

    def test_exact_series_lineage_rejects_condition_mixing_within_variant(self):
        near_mint = PriceSeriesKey(VARIANT_ID, SOURCE_ID, "USD", "holofoil", "raw", "market", "en", "near-mint")
        lightly_played = PriceSeriesKey(VARIANT_ID, SOURCE_ID, "USD", "holofoil", "raw", "market", "en", "lightly-played")
        rows = []
        for index, base in enumerate(examples(48)):
            object.__setattr__(base.features, "variant_id", VARIANT_ID)
            rows.append(MaturedTrainingExample(
                base.features, base.horizon_days, base.realized_price,
                base.label_available_at, near_mint if index % 2 == 0 else lightly_played,
                (f"observation-{index}",),
            ))
        target = features(origin=ORIGIN)
        object.__setattr__(target, "variant_id", VARIANT_ID)
        with self.assertRaisesRegex(ValueError, "cannot mix"):
            train_shadow_forecast(
                target, rows, 30, ORIGIN, series_key=near_mint,
                policy=ForecastEnginePolicy(minimum_training_examples=30, minimum_calibration_examples=10),
            )

    def test_immature_labels_are_excluded_and_sparse_forecast_is_quarantined(self):
        rows = examples(12)
        future = rows[-1]
        object.__setattr__(future, "label_available_at", ORIGIN + timedelta(days=1))
        forecast = train_shadow_forecast(
            features(origin=ORIGIN), rows, 30, ORIGIN,
            policy=ForecastEnginePolicy(minimum_training_examples=20, minimum_calibration_examples=5),
        )
        self.assertEqual(forecast.status, "quarantined")
        self.assertLess(forecast.training_count, 20)
        self.assertIn("insufficient_training_examples", forecast.reason_codes)
        candidate = build_watch_candidate(
            forecast,
            AcquisitionCosts(1, sell_fee_rate=0, liquidity_haircut_rate=0),
            evidence_quality=0.9,
            structural_lower_price=108,
            minimum_probability_net_positive=0,
        )
        self.assertEqual(candidate.status, "not_selected")
        self.assertIn("forecast_not_research_eligible", candidate.reason_codes)

    def test_after_cost_candidate_requires_conservative_return_and_liquidity(self):
        forecast = train_shadow_forecast(
            features(origin=ORIGIN), examples(), 30, ORIGIN,
            policy=ForecastEnginePolicy(minimum_training_examples=30, minimum_calibration_examples=10),
        )
        costs = AcquisitionCosts(70, tax_rate=0.05, sell_fee_rate=0.10, liquidity_haircut_rate=0.02)
        candidate = build_watch_candidate(
            forecast, costs, evidence_quality=0.9, structural_lower_price=108,
            minimum_probability_net_positive=0.5,
        )
        self.assertEqual(candidate.status, "watch_candidate")
        self.assertGreater(candidate.conservative_net_roi, 0)
        break_even_log_return = log(
            costs.liquidity_adjusted_break_even_reference / forecast.current_price
        )
        self.assertAlmostEqual(
            candidate.probability_net_positive,
            sum(
                value > break_even_log_return
                for value in forecast.calibration_distribution
            ) / len(forecast.calibration_distribution),
        )
        unknown_liquidity = build_watch_candidate(
            forecast, AcquisitionCosts(70), evidence_quality=0.9,
            structural_lower_price=108, minimum_probability_net_positive=0.5,
        )
        self.assertEqual(unknown_liquidity.status, "not_selected")
        self.assertIn("liquidity_unknown", unknown_liquidity.reason_codes)

    def test_after_cost_contract_includes_every_acquisition_and_exit_cost(self):
        costs = AcquisitionCosts(
            100,
            tax_rate=0.10,
            buy_shipping=5,
            sell_fee_rate=0.10,
            sell_fee_fixed=2,
            sell_shipping=8,
            liquidity_haircut_rate=0.20,
        )
        self.assertAlmostEqual(costs.all_in_cost, 115)
        self.assertAlmostEqual(costs.break_even_resale_price, 125 / 0.90)
        self.assertAlmostEqual(
            costs.liquidity_adjusted_break_even_reference,
            125 / (0.90 * 0.80),
        )
        self.assertAlmostEqual(
            costs.net_exit(costs.liquidity_adjusted_break_even_reference),
            costs.all_in_cost,
        )
        with self.assertRaisesRegex(ValueError, "sell_fee_rate"):
            AcquisitionCosts(100, sell_fee_rate=1)
        with self.assertRaisesRegex(ValueError, "liquidity_haircut_rate"):
            AcquisitionCosts(100, liquidity_haircut_rate=1)

    def test_selected_pocket_metrics_label_provider_reference_outcomes(self):
        forecast = train_shadow_forecast(
            features(origin=ORIGIN), examples(), 30, ORIGIN,
            policy=ForecastEnginePolicy(minimum_training_examples=30, minimum_calibration_examples=10),
        )
        candidate = build_watch_candidate(
            forecast, AcquisitionCosts(70, liquidity_haircut_rate=0.02),
            evidence_quality=0.9, structural_lower_price=108,
            minimum_probability_net_positive=0.5,
        )
        result = evaluate_selected_pockets([(candidate, 0.12), (candidate, -0.05)])
        self.assertEqual(result.candidate_count, 2)
        self.assertEqual(result.reference_positive_rate, 0.5)
        self.assertEqual(result.reference_false_discovery_rate, 0.5)
        self.assertEqual(result.outcome_semantics, "provider_reference_implied_net_roi")

    def test_shadow_forecast_enters_existing_immutable_private_ledger(self):
        target = features(origin=ORIGIN)
        object.__setattr__(target, "variant_id", VARIANT_ID)
        forecast = train_shadow_forecast(
            target, examples(), 30, ORIGIN,
            policy=ForecastEnginePolicy(minimum_training_examples=30, minimum_calibration_examples=10),
        )
        key = PriceSeriesKey(
            VARIANT_ID, SOURCE_ID, "USD", "holofoil", "raw", "market", "en", "near-mint"
        )
        snapshot = TrendSnapshot(
            key, ORIGIN, ORIGIN, 100, 0.01, 0.04, 0.09, None, None,
            0.001, 0.001, 0.0, 0.015, 0.015, 0.1, 0.95, 0.0, 0.9,
            0.9, 0.1, "stable", 90,
        )
        lineage = ResearchLineage("1" * 64, "git:test", "forecast-features-v2", "mapping-v1", forecast.model_version)
        model = ResearchModelCard(
            MODEL_ID, "forecast-ensemble", forecast.model_version,
            "quantile_return_forecast", lineage, (30,), ORIGIN,
            {"researchOnly": True},
            model_definition_hash=forecast.model_definition_hash,
            model_artifact_hash=forecast.artifact_hash,
        )
        terms = SourceTerms(
            SOURCE_ID, TERMS_ID, TERMS_ID, "research", "Research", "research_only",
            True, False, False, False, False, False, "", "2" * 64,
            ORIGIN - timedelta(days=1), ORIGIN + timedelta(days=10),
        )
        item = ShadowForecastLedgerItem(forecast, snapshot, SNAPSHOT_ID)
        packet = build_shadow_forecast_packet(
            model,
            [item],
            terms,
            analytics_run_id=RUN_ID,
        )
        self.assertEqual(packet.model_row["model_family"], "quantile_return_forecast")
        self.assertEqual(packet.prediction_rows[0]["horizon_days"], 30)
        self.assertEqual(packet.prediction_rows[0]["prediction_status"], "research_only")
        self.assertFalse(packet.public_publication_allowed)
        self.assertEqual(len(packet.packet_hash), 64)

        object.__setattr__(forecast, "model_version", "forecast-ensemble-v1")
        legacy_lineage = replace(lineage, model_version="forecast-ensemble-v1")
        legacy_model = replace(
            model, version="forecast-ensemble-v1", lineage=legacy_lineage,
        )
        with self.assertRaisesRegex(
            ValueError, "model_version must equal forecast-ensemble-v2",
        ):
            build_shadow_forecast_packet(
                legacy_model, [item], terms, analytics_run_id=RUN_ID,
            )

    def test_multi_card_walk_forward_scores_breadth_baselines_and_selected_pockets(self):
        cohort = "pokemon-en-raw-nm"
        rows = []
        keys = {}
        costs = {}
        start = ORIGIN - timedelta(days=12 * 31)
        for variant_index in range(6):
            variant_id = str(UUID(int=variant_index + 1))
            market_series_id = str(UUID(int=variant_index + 101))
            keys[variant_id] = PriceSeriesKey(
                variant_id, "market", "USD", "holofoil", "raw", "market", "en", "near-mint",
            )
            for origin_index in range(12):
                when = start + timedelta(days=origin_index * 31)
                current = 90 + variant_index * 3 + origin_index
                feature = ForecastFeatures(
                    variant_id=variant_id,
                    cohort_key=cohort,
                    origin=when,
                    current_price=current,
                    robust_daily_log_slope=0.001,
                    volatility_daily=0.012,
                    evidence_quality=0.95,
                    history_days=180,
                    set_id=f"set-{variant_index}",
                    market_daily_log_slope=0.0007,
                    lifecycle_log_return_30d=0.04,
                    lifecycle_log_return_90d=0.10,
                    structural_median_price=current * exp(0.16),
                    structural_lower_price=current * exp(0.10),
                    demand_acceleration=0.03,
                    reprint_risk=0.0,
                    feature_timestamps=(when,),
                )
                realized_return = 0.04 + (variant_index % 3 - 1) * 0.003
                rows.append(MaturedTrainingExample(
                    feature,
                    30,
                    current * exp(realized_return),
                    when + timedelta(days=30),
                    keys[variant_id],
                    (str(UUID(int=10_000 + variant_index * 100 + origin_index)),),
                    market_series_id,
                    str(UUID(int=20_000 + origin_index)),
                ))
                costs[AcquisitionQuoteKey(
                    market_series_id,
                    when,
                    30,
                    "USD",
                    when,
                )] = AcquisitionCosts(
                    current * 0.55,
                    sell_fee_rate=0.10,
                    liquidity_haircut_rate=0.02,
                )
        lineage = ResearchLineage(
            "9" * 64, "git:test", "forecast-features-v2", "mapping-v1", "forecast-ensemble-v2",
        )
        evaluation_policy = ShadowEvaluationPolicy(
            minimum_cases=30,
            minimum_variants=6,
            minimum_sets=5,
            minimum_spaced_origins=5,
            bootstrap_samples=100,
            minimum_lift_lower_bound=-1.0,
            minimum_probability_calibration_cases=30,
            minimum_after_cost_calibration_cases=1,
            maximum_after_cost_brier_score=1.0,
            maximum_after_cost_calibration_error=1.0,
            minimum_selected_pocket_cases=1,
            minimum_selected_positive_rate=0.0,
            minimum_selected_median_net_roi=-1.0,
            maximum_selected_false_discovery_rate=1.0,
            promotion_policy=PromotionPolicy(
                version="test",
                minimum_cases=30,
                minimum_baseline_lift=-1.0,
                interval_80_coverage_min=0.0,
                interval_80_coverage_max=1.0,
                maximum_brier_score=1.0,
            ),
        )
        engine_policy = ForecastEnginePolicy(
            minimum_training_examples=12,
            minimum_calibration_examples=4,
            minimum_history_days=90,
        )
        report = run_shadow_walk_forward(
            rows,
            30,
            cohort,
            keys,
            lineage,
            engine_policy=engine_policy,
            evaluation_policy=evaluation_policy,
            costs=costs,
        )
        self.assertGreaterEqual(report.scored_cases, 30)
        self.assertGreater(report.quarantined_cases, 0)
        self.assertEqual(report.variant_count, 6)
        self.assertEqual(report.set_count, 6)
        self.assertGreaterEqual(report.spaced_origin_count, 5)
        self.assertEqual(set(report.baseline_lifts), {
            "no_change", "damped_momentum", "market_index", "lifecycle_cohort",
            "structural_convergence",
        })
        self.assertTrue(all(value is not None for value in report.baseline_lift_intervals.values()))
        self.assertGreater(report.selected_pockets.candidate_count, 0)
        self.assertEqual(report.cost_evidence_case_count, report.scored_cases)
        self.assertEqual(report.candidate_universe_member_count, report.scored_cases)
        self.assertEqual(report.after_cost_probability.case_count, report.scored_cases)
        self.assertEqual(
            report.after_cost_probability.outcome_semantics,
            "provider_reference_net_proceeds_exceed_cost",
        )
        self.assertFalse(report.public_publication_allowed)
        self.assertEqual(len(report.report_hash), 64)

        without_costs = run_shadow_walk_forward(
            rows,
            30,
            cohort,
            keys,
            lineage,
            engine_policy=engine_policy,
            evaluation_policy=evaluation_policy,
        )
        self.assertNotEqual(without_costs.recommendation, "eligible_for_operator_review")
        self.assertIn("missing_after_cost_evidence", without_costs.reason_codes)
        self.assertIn(
            "insufficient_after_cost_probability_calibration_cases",
            without_costs.reason_codes,
        )


if __name__ == "__main__":
    unittest.main()
