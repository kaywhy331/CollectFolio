from dataclasses import replace
from datetime import datetime, timedelta, timezone
import unittest
from uuid import UUID

from collectfolio_analytics.forecast_dataset import (
    ForecastDatasetConfig,
    ForecastPanelSeries,
    compile_forecast_dataset,
)
from collectfolio_analytics.market_pipeline import SourceTerms
from collectfolio_analytics.observations import PriceSeriesKey
from collectfolio_analytics.trends import build_trend_snapshot
from collectfolio_analytics.walk_forward import HostedObservation


UTC = timezone.utc
START = datetime(2025, 1, 1, tzinfo=UTC)
GENERATED = START + timedelta(days=365)
SOURCE_ID = "f24c78f8-d4b9-55a3-a8f7-b05d484c052e"
TERMS_ID = "3bc792cf-ad71-54d1-a2f6-d5d5d521fba5"
VARIANT_ID = "80b4934a-96db-5f4c-8641-f7c74e0eb949"
MARKET_SERIES_ID = "22222222-2222-4222-8222-222222222222"
MARKET_SERIES_IDENTITY_HASH = "b" * 64
SET_ID = "33333333-3333-4333-8333-333333333333"
GAME = "pokemon"
KEY = PriceSeriesKey(
    VARIANT_ID,
    SOURCE_ID,
    "USD",
    "holofoil",
    "raw",
    "tcgplayer-market",
    "en",
    "near-mint",
)


def terms(**overrides):
    values = {
        "source_id": SOURCE_ID,
        "terms_review_id": TERMS_ID,
        "current_terms_review_id": TERMS_ID,
        "source_code": "research-market",
        "source_name": "Research market",
        "decision": "research_only",
        "active": True,
        "commercial_use_allowed": False,
        "catalog_metadata_allowed": False,
        "public_raw_display_allowed": False,
        "public_derived_display_allowed": False,
        "attribution_required": False,
        "attribution_text": "",
        "document_hash": "a" * 64,
        "reviewed_at": START - timedelta(days=1),
        "expires_at": GENERATED + timedelta(days=30),
    }
    values.update(overrides)
    return SourceTerms(**values)


def observations(*, missing_days=(), extra=()):
    rows = []
    missing = set(missing_days)
    for index in range(366):
        if index in missing:
            continue
        observed = START + timedelta(days=index)
        rows.append(HostedObservation(
            id=str(UUID(int=index + 1)),
            key=KEY,
            observation_status="accepted",
            observed_at=observed,
            available_at=observed,
            market_price=100 + index * 0.05 + (index % 7) * 0.1,
            quality_score=0.9,
            external_record_id=f"daily:{index}",
            market_series_id=MARKET_SERIES_ID,
        ))
    rows.extend(extra)
    return tuple(rows)


def panel(*, rows=None, key=KEY):
    return ForecastPanelSeries(
        key=key,
        market_series_id=MARKET_SERIES_ID,
        market_series_identity_hash=MARKET_SERIES_IDENTITY_HASH,
        set_id=SET_ID,
        game=GAME,
        observations=observations() if rows is None else tuple(rows),
    )


def config(**overrides):
    values = {
        "generated_at": GENERATED,
        "origins": tuple(
            START + timedelta(days=120 + index * 30) for index in range(9)
        ) + (GENERATED,),
        "mapping_version": "mapping-v1",
        "code_version": "git:test",
        "horizons": (30,),
        "expected_interval_days": 1,
        "max_reference_lag_days": 3,
        "engine_policy": {
            "minimumTrainingExamples": 4,
            "minimumCalibrationExamples": 2,
        },
    }
    values.update(overrides)
    return ForecastDatasetConfig(**values)


class ForecastDatasetTests(unittest.TestCase):
    def test_features_match_the_point_in_time_trend_and_invent_nothing(self):
        source = panel()
        manifest = compile_forecast_dataset([source], terms(), config())
        row = manifest["examples"][0]
        origin = datetime.fromisoformat(row["origin"])
        direct = build_trend_snapshot(
            source.accepted_observations,
            origin,
            key=KEY,
            expected_interval_days=1,
            max_reference_lag_days=3,
        )
        feature = row["features"]
        self.assertEqual(row["currentPrice"], direct.current_price)
        self.assertEqual(feature["robustDailyLogSlope"], direct.robust_slope_90d)
        self.assertEqual(feature["volatilityDaily"], direct.volatility_90d)
        self.assertEqual(feature["evidenceQuality"], direct.evidence_quality)
        self.assertEqual(feature["historyDays"], 120)
        self.assertEqual(row["setId"], SET_ID)
        self.assertTrue(row["cohortKey"].startswith("forecast-cohort-v1:"))
        self.assertTrue(all(
            feature[name] is None for name in (
                "marketDailyLogSlope", "lifecycleLogReturn30d",
                "lifecycleLogReturn90d", "structuralMedianPrice",
                "structuralLowerPrice", "demandAcceleration",
                "demandNormalizationVersion", "reprintRisk",
            )
        ))
        self.assertLessEqual(
            datetime.fromisoformat(feature["featureTimestamps"][0]), origin,
        )
        self.assertEqual(manifest["publicCandidateRows"], [])
        self.assertFalse(manifest["publicPublicationAllowed"])
        self.assertFalse(manifest["compilerAudit"]["candidateUniverseIdsIssued"])
        self.assertEqual(
            manifest["compilerAudit"]["candidateUniverseVerification"],
            "unverified_expected_input_manifest_missing",
        )
        self.assertTrue(all(
            "candidateUniverseId" not in item
            for item in (*manifest["examples"], *manifest["targets"])
        ))

    def test_future_revision_and_outlier_change_lineage_but_cannot_leak(self):
        origin = START + timedelta(days=210)
        base_config = config(origins=(origin,), horizons=(30,))
        baseline = compile_forecast_dataset([panel()], terms(), base_config)
        revised_at = START + timedelta(days=205)
        additions = (
            HostedObservation(
                id=str(UUID(int=50_000)),
                key=KEY,
                observation_status="accepted",
                observed_at=revised_at,
                available_at=origin + timedelta(days=1),
                market_price=10_000,
                quality_score=0.9,
                external_record_id="late-revision",
                market_series_id=MARKET_SERIES_ID,
            ),
            HostedObservation(
                id=str(UUID(int=50_001)),
                key=KEY,
                observation_status="outlier",
                observed_at=START + timedelta(days=200, hours=1),
                available_at=START + timedelta(days=200, hours=1),
                market_price=1_000_000,
                quality_score=0.9,
                external_record_id="outlier",
                reason_codes=("robust_price_outlier",),
                market_series_id=MARKET_SERIES_ID,
            ),
        )
        changed = compile_forecast_dataset(
            [panel(rows=observations(extra=additions))], terms(), base_config,
        )
        self.assertEqual(baseline["examples"], changed["examples"])
        self.assertEqual(
            baseline["featureDatasetSha256"], changed["featureDatasetSha256"],
        )
        self.assertNotEqual(
            baseline["lineage"]["datasetSha256"],
            changed["lineage"]["datasetSha256"],
        )
        self.assertEqual(
            changed["compilerAudit"]["observationStatusCounts"]["outlier"], 1,
        )

    def test_labels_require_complete_expected_cadence_and_preserve_the_declared_cell(self):
        first_origin = START + timedelta(days=120)
        second_origin = START + timedelta(days=180)
        gap = (147,)
        manifest = compile_forecast_dataset(
            [panel(rows=observations(missing_days=gap))],
            terms(),
            config(origins=(first_origin, second_origin), horizons=(30,)),
        )
        abstention = manifest["compilerAudit"]["abstentions"][0]
        self.assertEqual(abstention["origin"], first_origin.isoformat())
        self.assertEqual(
            abstention["reasonCodes"], [
                "incomplete_maturity_window_coverage",
                "maturity_window_gap_exceeds_policy",
            ],
        )
        self.assertEqual(len(manifest["examples"]), 1)
        row = manifest["examples"][0]
        maturity = datetime.fromisoformat(row["origin"]) + timedelta(days=30)
        self.assertTrue(all(
            maturity - timedelta(days=6)
            <= datetime.fromisoformat(item["observedAt"])
            <= maturity
            and datetime.fromisoformat(item["availableAt"]) <= maturity
            for item in row["targetObservations"]
        ))
        self.assertNotIn("candidateUniverseId", row)
        first_cell = manifest["compilerAudit"]["cells"][0]
        self.assertEqual(first_cell["state"], "unscorable")
        self.assertEqual(
            first_cell["targetWindow"]["observedDateCount"],
            6,
        )

    def test_missing_required_trend_fields_abstain_instead_of_becoming_zero(self):
        early = START
        later = START + timedelta(days=120)
        manifest = compile_forecast_dataset(
            [panel()],
            terms(),
            config(origins=(early, later), horizons=(30,)),
        )
        abstention = manifest["compilerAudit"]["abstentions"][0]
        self.assertEqual(abstention["origin"], early.isoformat())
        self.assertEqual(abstention["reasonCodes"], [
            "missing_required_robust_slope_90d",
            "missing_required_volatility_90d",
        ])
        self.assertEqual(len(manifest["examples"]), 1)

    def test_conflicting_accepted_duplicates_at_one_instant_fail_closed(self):
        baseline = observations()
        conflicting = replace(
            baseline[0], id=str(UUID(int=90_000)), market_price=999,
        )
        with self.assertRaisesRegex(ValueError, "conflicting accepted observations"):
            panel(rows=(*baseline, conflicting))

    def test_input_order_is_deterministic_and_exact_series_mixing_fails(self):
        source = panel()
        reversed_source = panel(rows=reversed(source.observations))
        self.assertEqual(
            compile_forecast_dataset([source], terms(), config()),
            compile_forecast_dataset([reversed_source], terms(), config()),
        )
        other_key = replace(KEY, market_condition="lightly-played")
        mixed = replace(source.observations[0], key=other_key)
        with self.assertRaisesRegex(ValueError, "cannot mix exact series"):
            panel(rows=(mixed, *source.observations[1:]))

    def test_late_available_backfill_cannot_fabricate_historical_examples(self):
        backfill = tuple(
            replace(item, available_at=GENERATED)
            for item in observations()
        )
        manifest = compile_forecast_dataset(
            [panel(rows=backfill)],
            terms(),
            config(origins=(START + timedelta(days=180),), horizons=(30,)),
        )
        self.assertEqual(manifest["examples"], [])
        self.assertEqual(manifest["targets"], [])
        self.assertEqual(
            manifest["compilerAudit"]["cellStateCounts"]["feature_abstained"], 1,
        )

    def test_any_hosted_row_unavailable_at_generation_fails_closed(self):
        baseline = observations()
        future_revision = replace(
            baseline[-1],
            id=str(UUID(int=90_001)),
            available_at=GENERATED + timedelta(seconds=1),
        )
        with self.assertRaisesRegex(ValueError, "unavailable at generation time"):
            compile_forecast_dataset(
                [panel(rows=(*baseline, future_revision))], terms(), config(),
            )

    def test_rights_and_configuration_are_part_of_fail_closed_lineage(self):
        source = panel()
        first = compile_forecast_dataset([source], terms(), config())
        changed = compile_forecast_dataset(
            [source], terms(), replace(config(), mapping_version="mapping-v2"),
        )
        self.assertNotEqual(
            first["lineage"]["datasetSha256"], changed["lineage"]["datasetSha256"],
        )
        with self.assertRaisesRegex(PermissionError, "generation time"):
            compile_forecast_dataset(
                [source],
                terms(expires_at=GENERATED - timedelta(seconds=1)),
                config(),
            )


if __name__ == "__main__":
    unittest.main()
