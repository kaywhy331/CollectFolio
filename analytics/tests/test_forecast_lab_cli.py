from datetime import datetime, timedelta, timezone
from hashlib import sha256
import json
from pathlib import Path
import stat
import tempfile
import unittest
from uuid import UUID

from collectfolio_analytics.demand import DEMAND_NORMALIZATION_VERSION
from collectfolio_analytics.forecast_lab_cli import build_forecast_lab_packet, main


UTC = timezone.utc
GENERATED = datetime(2026, 8, 1, tzinfo=UTC)


def manifest():
    rows = []
    start = GENERATED - timedelta(days=14 * 31)
    for variant_index in range(6):
        variant_id = str(UUID(int=variant_index + 1))
        market_series_id = str(UUID(int=variant_index + 101))
        for origin_index in range(12):
            origin = start + timedelta(days=origin_index * 31)
            current = 80 + variant_index + origin_index
            rows.append({
                "variantId": variant_id,
                "setId": f"set-{variant_index}",
                "cohortKey": "pokemon-en-raw-nm",
                "origin": origin.isoformat(),
                "horizonDays": 30,
                "currentPrice": current,
                "marketSeriesId": market_series_id,
                "candidateUniverseId": str(UUID(int=5_000 + origin_index)),
                "targetObservations": [{
                    "id": str(UUID(int=1_000 + variant_index * 100 + origin_index)),
                    "observedAt": (origin + timedelta(days=30)).isoformat(),
                    "availableAt": (origin + timedelta(days=30)).isoformat(),
                    "price": current * (
                        1.02 + ((origin_index + variant_index) % 5) * 0.01
                    ),
                    "quality": 0.95,
                }],
                "series": {
                    "sourceId": "licensed-market",
                    "currency": "USD",
                    "finish": "holofoil",
                    "conditionClass": "raw",
                    "marketCondition": "near-mint",
                    "language": "en",
                    "priceSemantics": "market",
                },
                "features": {
                    "robustDailyLogSlope": 0.001,
                    "volatilityDaily": 0.012,
                    "evidenceQuality": 0.95,
                    "historyDays": 180,
                    "marketDailyLogSlope": 0.0007,
                    "lifecycleLogReturn30d": 0.04,
                    "structuralMedianPrice": current * 1.15,
                    "structuralLowerPrice": current * 1.08,
                    "demandAcceleration": 0.03,
                    "demandNormalizationVersion": DEMAND_NORMALIZATION_VERSION,
                    "reprintRisk": 0,
                    "featureTimestamps": [origin.isoformat()],
                },
                "costs": {
                    "currency": "USD",
                    "quotedAt": origin.isoformat(),
                    "offerPrice": current * 0.55,
                    "taxRate": 0.02,
                    "buyShipping": 1,
                    "sellFeeRate": 0.10,
                    "sellFeeFixed": 1.50,
                    "sellShipping": 2,
                    "liquidityHaircutRate": 0.02,
                },
            })
    target_origin = GENERATED
    target = dict(rows[-1])
    target.update({
        "origin": target_origin.isoformat(),
        "currentPrice": 100,
        "candidateUniverseId": str(UUID(int=9_999)),
        "costs": {
            "currency": "USD",
            "quotedAt": target_origin.isoformat(),
            "offerPrice": 55,
            "taxRate": 0.05,
            "buyShipping": 2,
            "sellFeeRate": 0.10,
            "sellFeeFixed": 1.50,
            "sellShipping": 3,
            "liquidityHaircutRate": 0.02,
        },
    })
    target.pop("targetObservations")
    target["features"] = dict(target["features"], featureTimestamps=[target_origin.isoformat()])
    return {
        "mode": "research_only",
        "lineage": {
            "datasetSha256": sha256(b"licensed-point-in-time-input").hexdigest(),
            "codeVersion": "git:test",
            "featureVersion": "forecast-features-v2",
            "mappingVersion": "mapping-v1",
            "modelVersion": "forecast-ensemble-v2",
        },
        "enginePolicy": {
            "minimumTrainingExamples": 12,
            "minimumCalibrationExamples": 4,
        },
        "evaluationPolicy": {
            "minimumCases": 30,
            "minimumVariants": 6,
            "minimumSets": 5,
            "minimumSpacedOrigins": 5,
            "bootstrapSamples": 100,
            "minimumLiftLowerBound": -1,
            "minimumProbabilityCalibrationCases": 30,
            "minimumAfterCostCalibrationCases": 1,
            "maximumAfterCostBrierScore": 1,
            "maximumAfterCostCalibrationError": 1,
            "minimumSelectedPocketCases": 1,
            "minimumSelectedPositiveRate": 0,
            "minimumSelectedMedianNetRoi": -1,
            "maximumSelectedFalseDiscoveryRate": 1,
            "promotionPolicy": {
                "version": "test-policy",
                "minimumCases": 30,
                "minimumBaselineLift": -1,
                "interval80CoverageMin": 0,
                "interval80CoverageMax": 1,
                "maximumBrierScore": 1,
            },
        },
        "examples": rows,
        "targets": [target],
    }


class ForecastLabCLITests(unittest.TestCase):
    def test_manifest_rejects_legacy_or_caller_defined_model_lineage(self):
        for invalid_version in (
            "forecast-ensemble-v1",
            "caller-defined-v99",
            2,
            True,
            ["forecast-ensemble-v2"],
        ):
            with self.subTest(model_version=invalid_version):
                value = manifest()
                value["lineage"]["modelVersion"] = invalid_version
                with self.assertRaisesRegex(
                    ValueError, "model_version must equal forecast-ensemble-v2",
                ):
                    build_forecast_lab_packet(value, generated_at=GENERATED)

        normalized = manifest()
        normalized["lineage"]["modelVersion"] = "  forecast-ensemble-v2  "
        packet = build_forecast_lab_packet(normalized, generated_at=GENERATED)
        self.assertEqual(packet["lineage"]["modelVersion"], "forecast-ensemble-v2")
        self.assertTrue(packet["shadowForecasts"])
        self.assertTrue(all(
            row["modelVersion"] == "forecast-ensemble-v2"
            for row in packet["shadowForecasts"]
        ))

    def test_manifest_builds_private_walk_forward_and_current_shadow_packet(self):
        packet = build_forecast_lab_packet(manifest(), generated_at=GENERATED)
        self.assertEqual(packet["mode"], "research_only")
        self.assertEqual(packet["simulationMode"], "rolling_origin_shadow")
        self.assertEqual(len(packet["reports"]), 1)
        self.assertGreaterEqual(packet["reports"][0]["scoredCases"], 30)
        self.assertEqual(len(packet["shadowForecasts"]), 1)
        self.assertEqual(len(packet["marketSeriesIds"]), 6)
        self.assertIsNotNone(packet["shadowForecasts"][0]["afterCost"])
        self.assertGreater(
            packet["shadowForecasts"][0]["afterCost"]["breakEvenResalePrice"], 0,
        )
        after_cost = packet["shadowForecasts"][0]["afterCost"]
        all_in = 55 * 1.05 + 2
        self.assertAlmostEqual(after_cost["allInAcquisitionCost"], all_in)
        self.assertAlmostEqual(
            after_cost["breakEvenResalePrice"],
            (all_in + 1.50 + 3) / (1 - 0.10),
        )
        self.assertAlmostEqual(
            after_cost["liquidityAdjustedBreakEvenReference"],
            (all_in + 1.50 + 3) / ((1 - 0.10) * (1 - 0.02)),
        )
        self.assertEqual(
            packet["shadowForecasts"][0]["afterCost"]["candidateUniverseId"],
            str(UUID(int=9_999)),
        )
        self.assertEqual(
            packet["reports"][0]["afterCostProbability"]["outcomeSemantics"],
            "provider_reference_net_proceeds_exceed_cost",
        )
        self.assertEqual(
            packet["reports"][0]["selectedPockets"]["outcomeSemantics"],
            "provider_reference_implied_net_roi",
        )
        self.assertFalse(packet["publicPublicationAllowed"])
        self.assertEqual(packet["publicCandidateRows"], [])
        self.assertEqual(len(packet["packetHash"]), 64)

    def test_late_label_and_feature_hash_mismatch_fail_closed(self):
        value = manifest()
        value["examples"][0]["targetObservations"][0]["availableAt"] = (
            GENERATED + timedelta(days=1)
        ).isoformat()
        with self.assertRaisesRegex(ValueError, "unavailable"):
            build_forecast_lab_packet(value, generated_at=GENERATED)
        value = manifest()
        value["featureDatasetSha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "differs"):
            build_forecast_lab_packet(value, generated_at=GENERATED)

    def test_direct_builder_rejects_naive_generation_time(self):
        with self.assertRaisesRegex(ValueError, "timezone-aware"):
            build_forecast_lab_packet(
                manifest(), generated_at=datetime(2026, 8, 1),
            )

    def test_current_target_must_still_be_unmatured(self):
        value = manifest()
        stale_origin = GENERATED - timedelta(days=31)
        value["targets"][0]["origin"] = stale_origin.isoformat()
        value["targets"][0]["features"]["featureTimestamps"] = [
            stale_origin.isoformat(),
        ]
        with self.assertRaisesRegex(ValueError, "maturity must exceed"):
            build_forecast_lab_packet(value, generated_at=GENERATED)

    def test_opportunity_qualification_requires_universe_and_complete_cost_quotes(self):
        missing_universe = manifest()
        for row in missing_universe["examples"]:
            row.pop("candidateUniverseId")
        missing_universe["targets"][0].pop("candidateUniverseId")
        packet = build_forecast_lab_packet(missing_universe, generated_at=GENERATED)
        self.assertIn(
            "missing_candidate_universe_lineage",
            packet["reports"][0]["reasonCodes"],
        )
        self.assertEqual(
            packet["shadowForecasts"][0]["afterCost"]["selectionStatus"],
            "not_selected",
        )
        self.assertIn(
            "candidate_universe_lineage_missing",
            packet["shadowForecasts"][0]["afterCost"]["reasonCodes"],
        )

        incomplete_costs = manifest()
        incomplete_costs["examples"][-1].pop("costs")
        report = build_forecast_lab_packet(
            incomplete_costs, generated_at=GENERATED,
        )["reports"][0]
        self.assertIn(
            "incomplete_after_cost_candidate_universe",
            report["reasonCodes"],
        )
        self.assertNotEqual(report["recommendation"], "eligible_for_operator_review")

    def test_demand_opt_in_is_rejected_even_with_caller_asserted_version(self):
        value = manifest()
        value["enginePolicy"]["useDemandAcceleration"] = True
        with self.assertRaisesRegex(ValueError, "demand acceleration is unavailable"):
            build_forecast_lab_packet(value, generated_at=GENERATED)

    def test_cli_writes_mode_0600_and_refuses_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "manifest.json"
            output = Path(directory) / "packet.json"
            source.write_text(json.dumps(manifest()), encoding="utf-8")
            self.assertEqual(main([
                str(source), str(output), "--generated-at", GENERATED.isoformat(),
            ]), 0)
            self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o600)
            with self.assertRaises(FileExistsError):
                main([str(source), str(output), "--generated-at", GENERATED.isoformat()])


if __name__ == "__main__":
    unittest.main()
