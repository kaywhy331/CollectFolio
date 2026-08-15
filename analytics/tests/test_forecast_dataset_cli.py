from datetime import datetime, timedelta
from hashlib import sha256
import json
from pathlib import Path
import stat
import tempfile
import unittest
from uuid import UUID

from collectfolio_analytics.forecast_dataset_cli import build_manifest_from_exports, main
from collectfolio_analytics.forecast_engine import MAX_BOOTSTRAP_SAMPLES
from collectfolio_analytics.forecast_lab_cli import build_forecast_lab_packet

from analytics.tests.test_forecast_dataset import (
    GENERATED,
    KEY,
    GAME,
    MARKET_SERIES_ID,
    MARKET_SERIES_IDENTITY_HASH,
    SET_ID,
    SOURCE_ID,
    TERMS_ID,
    VARIANT_ID,
    config,
    observations,
)


def operator_manifest():
    dataset_config = config()
    return {
        "mode": "research_only",
        "source": {
            "id": SOURCE_ID,
            "termsReviewId": TERMS_ID,
            "currentTermsReviewId": TERMS_ID,
            "code": "research-market",
            "name": "Research market",
            "decision": "research_only",
            "active": True,
            "commercialUseAllowed": False,
            "catalogMetadataAllowed": False,
            "publicRawDisplayAllowed": False,
            "publicDerivedDisplayAllowed": False,
            "attributionRequired": False,
            "attributionText": "",
            "documentHash": "a" * 64,
            "reviewedAt": "2024-12-31T00:00:00+00:00",
            "expiresAt": "2026-02-01T00:00:00+00:00",
        },
        "forecastDataset": {
            "mappingVersion": "mapping-v1",
            "codeVersion": "git:test",
            "origins": [value.isoformat() for value in dataset_config.origins],
            "horizons": [30],
            "expectedIntervalDays": 1,
            "maxReferenceLagDays": 3,
            "enginePolicy": dict(dataset_config.engine_policy),
            "evaluationPolicy": {},
            "series": [{
                "variantId": VARIANT_ID,
                "marketSeriesId": MARKET_SERIES_ID,
                "identityHash": MARKET_SERIES_IDENTITY_HASH,
                "setId": SET_ID,
                "game": GAME,
                "series": {
                    "sourceId": SOURCE_ID,
                    "currency": "USD",
                    "language": "en",
                    "finish": "holofoil",
                    "conditionClass": "raw",
                    "marketCondition": "near-mint",
                    "priceSemantics": "tcgplayer-market",
                },
            }],
        },
    }


def hosted_rows():
    return [{
        "id": item.id,
        "variant_id": VARIANT_ID,
        "source_id": SOURCE_ID,
        "market_series_id": MARKET_SERIES_ID,
        "identity_hash": MARKET_SERIES_IDENTITY_HASH,
        "mapping_version": "mapping-v1",
        "set_id": SET_ID,
        "game": GAME,
        "currency": KEY.currency,
        "language": KEY.language,
        "finish": KEY.finish,
        "condition_class": KEY.condition_class,
        "market_condition": KEY.market_condition,
        "price_semantics": KEY.price_semantics,
        "observation_status": item.observation_status,
        "observed_at": item.observed_at.isoformat(),
        "available_at": item.available_at.isoformat(),
        "market_price": item.market_price,
        "quality_score": item.quality_score,
        "external_record_id": item.external_record_id,
        "reason_codes": list(item.reason_codes),
    } for item in observations()]


def canonical_hash(value):
    body = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return sha256(body.encode("utf-8")).hexdigest()


def rehash_compiler_audit(compiled):
    audit = compiled["compilerAudit"]
    audit.pop("auditSha256", None)
    audit["auditSha256"] = canonical_hash(audit)


def rehash_compiled_output_row(compiled, row, cell):
    compiled["featureDatasetSha256"] = canonical_hash({
        "examples": compiled["examples"], "targets": compiled["targets"],
    })
    audit = compiled["compilerAudit"]
    audit["featureDatasetSha256"] = compiled["featureDatasetSha256"]
    cell["compiledRowSha256"] = canonical_hash(row)
    audit["cellLedgerSha256"] = canonical_hash(audit["cells"])
    rehash_compiler_audit(compiled)


class ForecastDatasetCLITests(unittest.TestCase):
    def test_joined_export_runs_end_to_end_but_one_card_stays_insufficient(self):
        compiled = build_manifest_from_exports(
            operator_manifest(), {"rows": hosted_rows()}, generated_at=GENERATED,
        )
        packet = build_forecast_lab_packet(compiled, generated_at=GENERATED)
        self.assertEqual(compiled["mode"], "research_only")
        self.assertEqual(compiled["lineage"]["modelVersion"], "forecast-ensemble-v2")
        self.assertEqual(
            compiled["lineage"]["featureVersion"],
            "forecast-features-v2-observation-compiled-v1",
        )
        self.assertEqual(
            len(compiled["compilerAudit"]["compilerCodeArtifactSha256"]), 64,
        )
        self.assertEqual(packet["compilerAudit"], compiled["compilerAudit"])
        self.assertEqual(packet["publicCandidateRows"], [])
        self.assertFalse(packet["publicPublicationAllowed"])
        self.assertEqual(packet["reports"][0]["recommendation"], "insufficient")
        self.assertIn(
            "insufficient_variant_breadth", packet["reports"][0]["reasonCodes"],
        )
        self.assertIn(
            "missing_independently_sealed_input_universe",
            packet["reports"][0]["reasonCodes"],
        )
        self.assertTrue(all(
            "candidateUniverseId" not in row
            for row in (*compiled["examples"], *compiled["targets"])
        ))
        self.assertTrue(all(
            compiled["examples"][0]["features"][name] is None
            for name in (
                "marketDailyLogSlope", "lifecycleLogReturn30d",
                "structuralMedianPrice", "demandAcceleration", "reprintRisk",
            )
        ))

    def test_every_joined_identity_field_is_fail_closed(self):
        mutations = {
            "variant_id": str(UUID(int=99)),
            "source_id": str(UUID(int=98)),
            "currency": "EUR",
            "language": "fr",
            "finish": "reverse-holofoil",
            "condition_class": "graded",
            "market_condition": "lightly-played",
            "price_semantics": "listing-ask",
        }
        for field, changed in mutations.items():
            with self.subTest(field=field):
                rows = hosted_rows()
                rows[0][field] = changed
                with self.assertRaisesRegex(ValueError, "exact market-series identity"):
                    build_manifest_from_exports(
                        operator_manifest(), rows, generated_at=GENERATED,
                    )

    def test_joined_catalog_set_and_game_metadata_are_fail_closed(self):
        for field, changed in (
            ("set_id", str(UUID(int=97))),
            ("game", "magic"),
        ):
            with self.subTest(field=field):
                rows = hosted_rows()
                rows[0][field] = changed
                with self.assertRaisesRegex(ValueError, "canonical catalog"):
                    build_manifest_from_exports(
                        operator_manifest(), rows, generated_at=GENERATED,
                    )

    def test_all_unscorable_panel_emits_a_coverage_only_insufficient_report(self):
        value = operator_manifest()
        origin = datetime.fromisoformat(value["forecastDataset"]["origins"][0])
        value["forecastDataset"]["origins"] = [origin.isoformat()]
        maturity = origin + timedelta(days=30)
        rows = [
            row for row in hosted_rows()
            if not maturity - timedelta(days=6)
            <= datetime.fromisoformat(row["observed_at"])
            <= maturity
        ]
        compiled = build_manifest_from_exports(value, rows, generated_at=GENERATED)
        self.assertEqual(compiled["examples"], [])
        self.assertEqual(compiled["targets"], [])
        packet = build_forecast_lab_packet(compiled, generated_at=GENERATED)
        self.assertEqual(len(packet["reports"]), 1)
        report = packet["reports"][0]
        self.assertEqual(report["recommendation"], "insufficient")
        self.assertEqual(report["declaredPanelCoverage"]["plannedCount"], 1)
        self.assertEqual(report["declaredPanelCoverage"]["unscorableCount"], 1)
        self.assertEqual(report["declaredPanelCoverage"]["scoredCount"], 0)
        self.assertEqual(len(report["reportHash"]), 64)

    def test_all_open_panel_emits_a_coverage_report_and_quarantined_shadow(self):
        value = operator_manifest()
        value["forecastDataset"]["origins"] = [GENERATED.isoformat()]
        compiled = build_manifest_from_exports(
            value, hosted_rows(), generated_at=GENERATED,
        )
        self.assertEqual(compiled["examples"], [])
        self.assertEqual(len(compiled["targets"]), 1)
        packet = build_forecast_lab_packet(compiled, generated_at=GENERATED)
        report = packet["reports"][0]
        self.assertEqual(report["recommendation"], "insufficient")
        self.assertEqual(report["declaredPanelCoverage"]["openCount"], 1)
        self.assertEqual(report["declaredPanelCoverage"]["scoredCount"], 0)
        self.assertEqual(len(packet["shadowForecasts"]), 1)
        self.assertIn(
            "insufficient_training_examples",
            packet["shadowForecasts"][0]["reasonCodes"],
        )

    def test_compiled_packet_cannot_be_backdated_or_postdated(self):
        compiled = build_manifest_from_exports(
            operator_manifest(), hosted_rows(), generated_at=GENERATED,
        )
        for changed in (
            GENERATED - timedelta(days=1),
            GENERATED + timedelta(days=1),
        ):
            with self.subTest(generated_at=changed):
                with self.assertRaisesRegex(ValueError, "exact honest compiler generation"):
                    build_forecast_lab_packet(compiled, generated_at=changed)

    def test_compiler_audit_tampering_is_rejected_by_forecast_lab(self):
        compiled = build_manifest_from_exports(
            operator_manifest(), hosted_rows(), generated_at=GENERATED,
        )
        compiled["compilerAudit"]["abstentions"].append({"invented": True})
        with self.assertRaisesRegex(ValueError, "hash is inconsistent"):
            build_forecast_lab_packet(compiled, generated_at=GENERATED)

    def test_compiler_config_binds_manifest_policies_and_lineage_versions(self):
        mutations = {
            "enginePolicy": lambda value: value["enginePolicy"].update({
                "minimumTrainingExamples": 5,
            }),
            "enginePolicyEquivalentNumber": lambda value: value["enginePolicy"].update({
                "minimumTrainingExamples": 4.0,
            }),
            "evaluationPolicy": lambda value: value["evaluationPolicy"].update({
                "minimumCases": 2,
            }),
            "codeVersion": lambda value: value["lineage"].update({
                "codeVersion": "git:changed",
            }),
            "mappingVersion": lambda value: value["lineage"].update({
                "mappingVersion": "mapping-v2",
            }),
        }
        for name, mutate in mutations.items():
            with self.subTest(field=name):
                compiled = build_manifest_from_exports(
                    operator_manifest(), hosted_rows(), generated_at=GENERATED,
                )
                mutate(compiled)
                with self.assertRaisesRegex(
                    ValueError, "differs from compilerAudit.compilerConfig|differs from lineage",
                ):
                    build_forecast_lab_packet(compiled, generated_at=GENERATED)

    def test_compiler_config_requires_its_hash_and_exact_field_contract(self):
        compiled = build_manifest_from_exports(
            operator_manifest(), hosted_rows(), generated_at=GENERATED,
        )
        compiled["compilerAudit"]["compilerConfig"]["codeVersion"] = "git:changed"
        rehash_compiler_audit(compiled)
        with self.assertRaisesRegex(ValueError, "compilerConfig hash is inconsistent"):
            build_forecast_lab_packet(compiled, generated_at=GENERATED)

        compiled = build_manifest_from_exports(
            operator_manifest(), hosted_rows(), generated_at=GENERATED,
        )
        audit = compiled["compilerAudit"]
        audit["compilerConfig"]["inventedAuthority"] = True
        audit["compilerConfigSha256"] = canonical_hash(audit["compilerConfig"])
        rehash_compiler_audit(compiled)
        with self.assertRaisesRegex(ValueError, "invalid field contract"):
            build_forecast_lab_packet(compiled, generated_at=GENERATED)

    def test_operator_policies_reject_coercion_unknown_fields_and_unbounded_bootstrap(self):
        mutations = {
            "engineBoolean": lambda value: value["forecastDataset"][
                "enginePolicy"
            ].update({"minimumTrainingExamples": True}),
            "evaluationBoolean": lambda value: value["forecastDataset"][
                "evaluationPolicy"
            ].update({"minimumCases": True}),
            "unboundedBootstrap": lambda value: value["forecastDataset"][
                "evaluationPolicy"
            ].update({"bootstrapSamples": MAX_BOOTSTRAP_SAMPLES + 1}),
            "unknownEngineField": lambda value: value["forecastDataset"][
                "enginePolicy"
            ].update({"inventedGate": 1}),
        }
        for name, mutate in mutations.items():
            with self.subTest(mutation=name):
                value = operator_manifest()
                mutate(value)
                with self.assertRaises(ValueError):
                    build_manifest_from_exports(
                        value, {"rows": hosted_rows()}, generated_at=GENERATED,
                    )

    def test_rehashed_compiled_rows_reject_coercive_types_and_noncanonical_ids(self):
        mutations = {
            "horizonFloat": lambda row: row.update({"horizonDays": 30.0}),
            "currentPriceBoolean": lambda row: row.update({"currentPrice": True}),
            "historyDaysBoolean": lambda row: row["features"].update({
                "historyDays": True,
            }),
            "evidenceQualityBoolean": lambda row: row["features"].update({
                "evidenceQuality": True,
            }),
            "volatilityBoolean": lambda row: row["features"].update({
                "volatilityDaily": False,
            }),
            "targetPriceBoolean": lambda row: row["targetObservations"][0].update({
                "price": True,
            }),
            "targetQualityBoolean": lambda row: row["targetObservations"][0].update({
                "quality": True,
            }),
            "variantIdNoncanonical": lambda row: row.update({
                "variantId": row["variantId"].upper(),
            }),
            "marketSeriesIdNoncanonical": lambda row: row.update({
                "marketSeriesId": "{" + row["marketSeriesId"] + "}",
            }),
        }
        for name, mutate in mutations.items():
            with self.subTest(mutation=name):
                compiled = build_manifest_from_exports(
                    operator_manifest(), hosted_rows(), generated_at=GENERATED,
                )
                row = compiled["examples"][0]
                cell = next(
                    item for item in compiled["compilerAudit"]["cells"]
                    if item.get("state") == "scored"
                    and item["origin"] == row["origin"]
                    and item["marketSeriesId"] == row["marketSeriesId"]
                )
                mutate(row)
                rehash_compiled_output_row(compiled, row, cell)
                with self.assertRaises(ValueError):
                    build_forecast_lab_packet(compiled, generated_at=GENERATED)

    def test_rehashed_compiler_audit_rejects_numeric_type_equivalence(self):
        def float_state_count(value):
            counts = value["compilerAudit"]["cellStateCounts"]
            name = next(key for key, count in counts.items() if count > 0)
            counts[name] = float(counts[name])

        def float_cell_window(value):
            cell = next(
                item for item in value["compilerAudit"]["cells"]
                if item.get("targetWindow") is not None
            )
            cell["targetWindow"]["windowDays"] = 7.0
            value["compilerAudit"]["cellLedgerSha256"] = canonical_hash(
                value["compilerAudit"]["cells"],
            )

        mutations = {
            "expectedCellCount": lambda value: value["compilerAudit"].update({
                "expectedCellCount": float(
                    value["compilerAudit"]["expectedCellCount"]
                ),
            }),
            "declaredSeriesCount": lambda value: value["compilerAudit"].update({
                "declaredSeriesCount": True,
            }),
            "declaredOriginCount": lambda value: value["compilerAudit"].update({
                "declaredOriginCount": float(
                    value["compilerAudit"]["declaredOriginCount"]
                ),
            }),
            "cellStateCounts": float_state_count,
            "minimumCoverage": lambda value: value["compilerAudit"][
                "targetWindowPolicy"
            ].update({"minimumCoverage": True}),
            "windowDays": lambda value: value["compilerAudit"][
                "targetWindowPolicy"
            ].update({"windowDays": 7.0}),
            "cellWindowDays": float_cell_window,
        }
        for name, mutate in mutations.items():
            with self.subTest(mutation=name):
                compiled = build_manifest_from_exports(
                    operator_manifest(), hosted_rows(), generated_at=GENERATED,
                )
                mutate(compiled)
                rehash_compiler_audit(compiled)
                with self.assertRaises(ValueError):
                    build_forecast_lab_packet(compiled, generated_at=GENERATED)

    def test_compiled_rows_cannot_be_rehashed_without_the_bound_audit(self):
        compiled = build_manifest_from_exports(
            operator_manifest(), hosted_rows(), generated_at=GENERATED,
        )
        compiled["examples"][0]["currentPrice"] *= 10
        compiled["featureDatasetSha256"] = canonical_hash({
            "examples": compiled["examples"], "targets": compiled["targets"],
        })
        with self.assertRaisesRegex(ValueError, "compilerAudit feature hash"):
            build_forecast_lab_packet(compiled, generated_at=GENERATED)

        compiled = build_manifest_from_exports(
            operator_manifest(), hosted_rows(), generated_at=GENERATED,
        )
        compiled.pop("compilerAudit")
        with self.assertRaisesRegex(ValueError, "requires compilerAudit"):
            build_forecast_lab_packet(compiled, generated_at=GENERATED)

    def test_rehashed_audit_cannot_omit_grid_cells_or_issue_universe_ids(self):
        compiled = build_manifest_from_exports(
            operator_manifest(), hosted_rows(), generated_at=GENERATED,
        )
        removed = compiled["compilerAudit"]["cells"].pop()
        compiled["compilerAudit"]["expectedCellCount"] -= 1
        compiled["compilerAudit"]["cellStateCounts"][removed["state"]] -= 1
        compiled["compilerAudit"]["cellLedgerSha256"] = canonical_hash(
            compiled["compilerAudit"]["cells"],
        )
        rehash_compiler_audit(compiled)
        with self.assertRaisesRegex(ValueError, "expected cell count"):
            build_forecast_lab_packet(compiled, generated_at=GENERATED)

        compiled = build_manifest_from_exports(
            operator_manifest(), hosted_rows(), generated_at=GENERATED,
        )
        row = compiled["examples"][0]
        row["candidateUniverseId"] = str(UUID(int=96))
        compiled["featureDatasetSha256"] = canonical_hash({
            "examples": compiled["examples"], "targets": compiled["targets"],
        })
        audit = compiled["compilerAudit"]
        audit["featureDatasetSha256"] = compiled["featureDatasetSha256"]
        matching_cell = next(
            cell for cell in audit["cells"]
            if cell["variantId"] == row["variantId"]
            and cell["origin"] == row["origin"]
            and cell["horizonDays"] == row["horizonDays"]
        )
        matching_cell["compiledRowSha256"] = canonical_hash(row)
        audit["cellLedgerSha256"] = canonical_hash(audit["cells"])
        rehash_compiler_audit(compiled)
        with self.assertRaisesRegex(ValueError, "cannot issue candidateUniverseId"):
            build_forecast_lab_packet(compiled, generated_at=GENERATED)

    def test_rehashed_partial_label_cannot_claim_complete_cadence(self):
        compiled = build_manifest_from_exports(
            operator_manifest(), hosted_rows(), generated_at=GENERATED,
        )
        row = compiled["examples"][0]
        row["targetObservations"] = row["targetObservations"][:1]
        compiled["featureDatasetSha256"] = canonical_hash({
            "examples": compiled["examples"], "targets": compiled["targets"],
        })
        audit = compiled["compilerAudit"]
        audit["featureDatasetSha256"] = compiled["featureDatasetSha256"]
        matching_cell = next(
            cell for cell in audit["cells"]
            if cell["variantId"] == row["variantId"]
            and cell["origin"] == row["origin"]
            and cell["horizonDays"] == row["horizonDays"]
        )
        matching_cell["compiledRowSha256"] = canonical_hash(row)
        audit["cellLedgerSha256"] = canonical_hash(audit["cells"])
        rehash_compiler_audit(compiled)
        with self.assertRaisesRegex(ValueError, "differ from cadence audit"):
            build_forecast_lab_packet(compiled, generated_at=GENERATED)

    def test_rehashed_audit_rejects_unknown_provenance_and_noncanonical_order(self):
        mutations = (
            ("compilerVersion", "invented-compiler-v999"),
            ("compilerCodeArtifactSha256", "not-a-digest"),
            ("sourcePolicySha256", "also-not-a-digest"),
        )
        for field, changed in mutations:
            with self.subTest(field=field):
                compiled = build_manifest_from_exports(
                    operator_manifest(), hosted_rows(), generated_at=GENERATED,
                )
                compiled["compilerAudit"][field] = changed
                rehash_compiler_audit(compiled)
                with self.assertRaises(ValueError):
                    build_forecast_lab_packet(compiled, generated_at=GENERATED)

        compiled = build_manifest_from_exports(
            operator_manifest(), hosted_rows(), generated_at=GENERATED,
        )
        compiled["compilerAudit"]["independentlySealedInputUniverse"] = True
        rehash_compiler_audit(compiled)
        with self.assertRaisesRegex(ValueError, "top-level field contract"):
            build_forecast_lab_packet(compiled, generated_at=GENERATED)

        compiled = build_manifest_from_exports(
            operator_manifest(), hosted_rows(), generated_at=GENERATED,
        )
        compiled["compilerAudit"]["cells"].reverse()
        compiled["compilerAudit"]["cellLedgerSha256"] = canonical_hash(
            compiled["compilerAudit"]["cells"],
        )
        rehash_compiler_audit(compiled)
        with self.assertRaisesRegex(ValueError, "not canonically ordered"):
            build_forecast_lab_packet(compiled, generated_at=GENERATED)

    def test_cli_writes_mode_0600_and_refuses_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            manifest_path = Path(directory) / "panel.json"
            export_path = Path(directory) / "hosted.json"
            output_path = Path(directory) / "compiled.json"
            manifest_path.write_text(json.dumps(operator_manifest()), encoding="utf-8")
            export_path.write_text(json.dumps({"rows": hosted_rows()}), encoding="utf-8")
            self.assertEqual(main([
                str(manifest_path),
                str(export_path),
                str(output_path),
                "--generated-at",
                GENERATED.isoformat(),
                "--pretty",
            ]), 0)
            self.assertEqual(stat.S_IMODE(output_path.stat().st_mode), 0o600)
            with self.assertRaises(FileExistsError):
                main([
                    str(manifest_path), str(export_path), str(output_path),
                    "--generated-at", GENERATED.isoformat(),
                ])

    def test_cli_rejects_naive_generation_time(self):
        with self.assertRaisesRegex(ValueError, "timezone"):
            main([
                "/unused/manifest.json",
                "/unused/hosted.json",
                "/unused/output.json",
                "--generated-at",
                datetime(2026, 1, 1).isoformat(),
            ])


if __name__ == "__main__":
    unittest.main()
