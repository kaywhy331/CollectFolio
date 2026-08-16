from contextlib import redirect_stderr, redirect_stdout
import csv
from datetime import datetime, timedelta, timezone
from hashlib import sha256
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest

from collectfolio_analytics.structural_gap import (
    COEFFICIENT_DECIMAL_PLACES,
    PeerAggregate,
    ProviderSeries,
    STRUCTURAL_GAP_SOLVER_VERSION,
    StructuralGapPolicy,
    _ridge_huber,
    compile_structural_gap_lab,
)
from collectfolio_analytics.structural_gap_cli import main as structural_gap_main
from collectfolio_analytics.tcgcsv_universe import (
    CATALOG_SNAPSHOT_CONTRACT_VERSION,
    FEATURE_COLUMNS,
    UNIVERSE_CONTRACT_VERSION,
    TCGCSVUniverseError,
    content_hash,
    file_sha256,
)


UTC = timezone.utc
SOURCE_ID = "00000000-0000-0000-0000-000000000201"
NUMPY_AVAILABLE = importlib.util.find_spec("numpy") is not None


def _series_hash(category_id, group_id, product_id, subtype_name):
    return sha256(
        f"{category_id}|{group_id}|{product_id}|{subtype_name}".encode("utf-8")
    ).hexdigest()


def _write_features(
    root: Path,
    *,
    group_count=5,
    rows_per_group=25,
    categories=(3,),
) -> tuple[Path, list[dict[str, object]]]:
    root.mkdir(parents=True, exist_ok=True)
    feature_path = root / "market-features.csv"
    products = []
    with feature_path.open("x", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=FEATURE_COLUMNS, lineterminator="\n")
        writer.writeheader()
        for category_offset, category_id in enumerate(categories):
            for group_offset in range(group_count):
                group_id = 1000 + category_offset * 1000 + group_offset
                for row_offset in range(rows_per_group):
                    product_id = group_id * 100 + row_offset
                    subtype = "Holofoil" if row_offset % 2 else "Normal"
                    rarity = "rare" if row_offset % 3 else "uncommon"
                    card_type = "creature" if row_offset % 4 else "trainer"
                    price = 12 + group_offset * 2 + row_offset * 0.17
                    if group_offset == 0 and row_offset == 0:
                        price = 0.25
                    series_sha = _series_hash(category_id, group_id, product_id, subtype)
                    row = {name: "" for name in FEATURE_COLUMNS}
                    row.update({
                        "category_id": category_id,
                        "group_id": group_id,
                        "product_id": product_id,
                        "subtype_name": subtype,
                        "series_sha256": series_sha,
                        "current_price": price,
                        "trend_status": "stable",
                        "opportunity_status": "neutral",
                        "forecast_estimates": "{}",
                        "forecast_model_key": "fixture",
                        "estimate_status": "research_only",
                        "feature_sha256": sha256(f"feature-{series_sha}".encode()).hexdigest(),
                    })
                    writer.writerow(row)
                    products.append({
                        "categoryId": category_id,
                        "groupId": group_id,
                        "productId": product_id,
                        "name": f"Fixture card {product_id}",
                        "rarity": rarity,
                        "cardType": card_type,
                        "changedByRunId": f"catalog-run-{group_offset}",
                    })
    return feature_path, products


def _inputs(
    feature_path: Path,
    products: list[dict[str, object]],
    origin: datetime,
    *,
    reconciliation_status="eligible",
    source_id=SOURCE_ID,
) -> tuple[dict[str, object], dict[str, object]]:
    source_updated = origin - timedelta(hours=2)
    source_available = origin - timedelta(hours=1)
    with feature_path.open(newline="", encoding="utf-8") as handle:
        feature_rows = list(csv.DictReader(handle))
    series_manifest = [
        {
            "categoryId": int(row["category_id"]),
            "groupId": int(row["group_id"]),
            "productId": int(row["product_id"]),
            "subtypeName": row["subtype_name"],
            "seriesSha256": row["series_sha256"],
        }
        for row in feature_rows
    ]
    group_keys = sorted({
        (int(product["categoryId"]), int(product["groupId"])) for product in products
    })
    groups = [
        {
            "categoryId": category_id,
            "groupId": group_id,
            "name": f"Fixture set {group_id}",
            "publishedOn": "2024-01-01",
            "changedByRunId": f"catalog-run-{group_id}",
        }
        for category_id, group_id in group_keys
    ]
    archive = {
        "contractVersion": UNIVERSE_CONTRACT_VERSION,
        "sourceId": source_id,
        "archiveDate": source_updated.date().isoformat(),
        "sourceUpdatedAt": source_updated.isoformat(),
        "sourceAvailableAt": source_available.isoformat(),
        "features": {
            "featureCsvSha256": file_sha256(feature_path),
            "featureCount": len(products),
            "featureObjectUri": "s3://private/features/market-features.csv",
            "setFeatureObjectUri": "s3://private/features/set-features.csv",
        },
    }
    snapshot_content = {
        "contractVersion": CATALOG_SNAPSHOT_CONTRACT_VERSION,
        "sourceId": source_id,
        "catalogAvailableAt": origin.isoformat(),
        "latestArchive": {
            "runId": "archive-run",
            "archiveDate": source_updated.date().isoformat(),
            "sourceUpdatedAt": source_updated.isoformat(),
            "sourceAvailableAt": source_available.isoformat(),
            "featureCsvSha256": file_sha256(feature_path),
            "featureCount": len(products),
            "seriesManifestSha256": content_hash(series_manifest),
            "status": "sealed",
            "currentStateApplied": True,
        },
        "latestCatalog": {"runId": "catalog-run", "status": "sealed"},
        "rowCounts": {
            "categories": 1,
            "groups": len(groups),
            "products": len(products),
            "currentSeries": len(products),
            "positivelyPricedSeries": len(products),
            "pricedProducts": len(products),
        },
        "reconciliation": {
            "status": reconciliation_status,
            "reasonCodes": [] if reconciliation_status == "eligible" else ["fixture_partial"],
            "unmatchedPricedSeries": 0,
            "unresolvedProducts": 0,
        },
        "categories": [
            {"categoryId": category_id, "name": f"Fixture category {category_id}"}
            for category_id in sorted({key[0] for key in group_keys})
        ],
        "groups": groups,
        "products": products,
        "privateResearchOnly": True,
        "publicPublicationAllowed": False,
    }
    snapshot = {
        **snapshot_content,
        "catalogSnapshotContentSha256": content_hash(snapshot_content),
    }
    return archive, snapshot


def _output(packet, *, group_id, product_id, subtype="Normal"):
    return next(
        row for row in packet["outputs"]
        if row["providerIdentity"] == {
            "categoryId": 3,
            "groupId": group_id,
            "productId": product_id,
            "subtypeName": subtype,
        }
    )


@unittest.skipUnless(
    NUMPY_AVAILABLE,
    "Structural Gap Lab requires the optional market-universe NumPy dependency",
)
class StructuralGapLabTests(unittest.TestCase):
    def test_peer_aggregate_rejects_target_membership(self):
        target = ProviderSeries(3, 1, 2, "Normal", "a" * 64, 10, "rare", "card", 10)
        with self.assertRaisesRegex(TCGCSVUniverseError, "own peer aggregate"):
            PeerAggregate.build(target.identity, [target])

    def test_numpy_solver_rounds_coefficients_before_use(self):
        coefficients = _ridge_huber(
            ((1.0, 0.1), (1.0, 0.7), (1.0, 1.4), (1.0, 2.9)),
            (0.3, 1.1, 1.8, 4.2),
            StructuralGapPolicy(),
        )
        self.assertTrue(coefficients)
        self.assertTrue(all(
            value == round(value, COEFFICIENT_DECIMAL_PLACES)
            for value in coefficients
        ))

    def test_group_crossfit_emits_held_out_provider_native_bands(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            features, products = _write_features(root)
            archive, snapshot = _inputs(features, products, datetime(2026, 8, 15, tzinfo=UTC))
            packet = compile_structural_gap_lab(features, archive, snapshot)
            repeated = compile_structural_gap_lab(features, archive, snapshot)

        self.assertEqual(packet, repeated)
        self.assertEqual(packet["labStatus"], "eligible")
        self.assertEqual(packet["originMode"], "current_origin_only")
        self.assertEqual(packet["identityScope"], "provider_native")
        self.assertFalse(packet["canonicalIdentityClaimed"])
        self.assertFalse(packet["futureValueClaimed"])
        self.assertFalse(packet["publicPublicationAllowed"])
        lineage = packet["solverLineage"]
        import numpy as np
        self.assertEqual(lineage["solverVersion"], STRUCTURAL_GAP_SOLVER_VERSION)
        self.assertEqual(lineage["numpyRuntimeVersion"], np.__version__)
        self.assertEqual(
            lineage["coefficientDecimalPlaces"], COEFFICIENT_DECIMAL_PLACES,
        )
        self.assertEqual(len(lineage["implementationSourceSha256"]), 64)
        self.assertEqual(len(lineage["codeArtifactSha256"]), 64)
        self.assertEqual(len(packet["outputs"]), 125)
        self.assertEqual(len(packet["folds"]), 5)
        for fold in packet["folds"]:
            training = {(row["categoryId"], row["groupId"]) for row in fold["trainingGroups"]}
            calibration = {(row["categoryId"], row["groupId"]) for row in fold["calibrationGroups"]}
            held_out = {(row["categoryId"], row["groupId"]) for row in fold["testGroups"]}
            self.assertFalse(training & calibration)
            self.assertFalse(training & held_out)
            self.assertFalse(calibration & held_out)
            self.assertGreaterEqual(fold["trainingCount"], 40)
            self.assertGreaterEqual(fold["calibrationCount"], 12)
            self.assertEqual(len(fold["foldHash"]), 64)
            self.assertEqual(len(fold["artifactHash"]), 64)
            self.assertEqual(
                fold["solverLineageSha256"], content_hash(lineage),
            )
        low = _output(packet, group_id=1000, product_id=100000)
        self.assertEqual(low["position"], "below_band")
        self.assertEqual(low["telemetryLabel"], "structural_gap")
        self.assertTrue(low["heldOutOnly"])
        self.assertEqual(low["peerAggregate"]["peerCount"], 24)
        self.assertEqual(len(low["peerAggregate"]["membershipSha256"]), 64)
        self.assertEqual(len(low["inputHash"]), 64)
        values = [low["quantiles"][key] for key in ("q10", "q25", "q50", "q75", "q90")]
        self.assertEqual(values, sorted(values))
        self.assertNotIn("canonicalVariantId", json.dumps(packet))

    def test_model_is_category_scoped_while_full_archive_membership_stays_bound(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            features, products = _write_features(root, categories=(3, 4))
            archive, snapshot = _inputs(features, products, datetime(2026, 8, 15, tzinfo=UTC))
            packet = compile_structural_gap_lab(features, archive, snapshot)

        self.assertEqual(packet["labStatus"], "eligible")
        self.assertEqual(packet["modelCategoryId"], 3)
        self.assertEqual(packet["universeEvidence"]["fullSeriesCount"], 250)
        self.assertEqual(
            packet["universeEvidence"]["exclusionCountsByReason"]["outside_model_category"],
            125,
        )
        self.assertEqual(len(packet["outputs"]), 125)
        self.assertEqual(
            {row["providerIdentity"]["categoryId"] for row in packet["outputs"]},
            {3},
        )
        for fold in packet["folds"]:
            all_groups = (
                fold["trainingGroups"] + fold["calibrationGroups"] + fold["testGroups"]
            )
            self.assertEqual({row["categoryId"] for row in all_groups}, {3})

    def test_caller_cannot_truncate_the_database_sealed_feature_universe(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            features, products = _write_features(root)
            archive, snapshot = _inputs(features, products, datetime(2026, 8, 15, tzinfo=UTC))
            with features.open(newline="", encoding="utf-8") as handle:
                rows = list(csv.DictReader(handle))
            truncated = root / "truncated-features.csv"
            with truncated.open("x", newline="", encoding="utf-8") as handle:
                writer = csv.DictWriter(handle, fieldnames=FEATURE_COLUMNS, lineterminator="\n")
                writer.writeheader()
                writer.writerows(rows[:75])
            forged_archive = json.loads(json.dumps(archive))
            forged_archive["features"]["featureCount"] = 75
            forged_archive["features"]["featureCsvSha256"] = file_sha256(truncated)

            packet = compile_structural_gap_lab(truncated, forged_archive, snapshot)

        self.assertEqual(packet["labStatus"], "abstain")
        self.assertIn("sealed_feature_hash_mismatch", packet["reasonCodes"])
        self.assertIn("sealed_feature_count_mismatch", packet["reasonCodes"])
        self.assertIn("sealed_series_manifest_mismatch", packet["reasonCodes"])
        self.assertEqual(packet["outputs"], [])

    def test_rejects_unknown_archive_and_catalog_contract_versions(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            features, products = _write_features(root)
            archive, snapshot = _inputs(
                features, products, datetime(2026, 8, 15, tzinfo=UTC),
            )
            unsupported_archive = json.loads(json.dumps(archive))
            unsupported_archive["contractVersion"] = "tcgcsv-market-universe-v999"
            with self.assertRaisesRegex(TCGCSVUniverseError, "archive packet.*contract"):
                compile_structural_gap_lab(features, unsupported_archive, snapshot)

            unsupported_snapshot = json.loads(json.dumps(snapshot))
            unsupported_snapshot.pop("catalogSnapshotContentSha256")
            unsupported_snapshot["contractVersion"] = "tcgcsv-catalog-snapshot-v999"
            unsupported_snapshot["catalogSnapshotContentSha256"] = content_hash(
                unsupported_snapshot
            )
            with self.assertRaisesRegex(TCGCSVUniverseError, "catalog snapshot.*contract"):
                compile_structural_gap_lab(features, archive, unsupported_snapshot)

    def test_ineligible_catalog_and_small_universe_abstain(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            features, products = _write_features(root)
            archive, partial = _inputs(
                features, products, datetime(2026, 8, 15, tzinfo=UTC),
                reconciliation_status="abstain",
            )
            partial_result = compile_structural_gap_lab(features, archive, partial)
            self.assertEqual(partial_result["labStatus"], "abstain")
            self.assertIn("catalog_snapshot_ineligible", partial_result["reasonCodes"])
            self.assertEqual(partial_result["outputs"], [])

            small_features, small_products = _write_features(root / "small", group_count=4, rows_per_group=10)
            small_archive, small_snapshot = _inputs(
                small_features, small_products, datetime(2026, 8, 15, tzinfo=UTC),
            )
            small_result = compile_structural_gap_lab(small_features, small_archive, small_snapshot)
            self.assertEqual(small_result["labStatus"], "abstain")
            self.assertIn("priced_series_below_minimum", small_result["reasonCodes"])
            self.assertIn("complete_groups_below_minimum", small_result["reasonCodes"])

    def test_persistence_requires_three_gap_free_weekly_origins(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            features, products = _write_features(root)
            origins = [datetime(2026, 8, day, tzinfo=UTC) for day in (1, 8, 15)]
            packets = []
            for index, origin in enumerate(origins):
                archive, snapshot = _inputs(features, products, origin)
                packet = compile_structural_gap_lab(
                    features, archive, snapshot, prior_packets=packets,
                )
                packets.append(packet)
                low = _output(packet, group_id=1000, product_id=100000)
                expected = "persistent_below_band" if index == 2 else "structural_gap"
                self.assertEqual(low["telemetryLabel"], expected)
            late_archive, late_snapshot = _inputs(
                features, products, datetime(2026, 8, 29, tzinfo=UTC),
            )
            late = compile_structural_gap_lab(
                features, late_archive, late_snapshot, prior_packets=packets,
            )
            self.assertEqual(
                _output(late, group_id=1000, product_id=100000)["telemetryLabel"],
                "structural_gap",
            )

    def test_persistence_rejects_prior_packets_from_another_source(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            features, products = _write_features(root)
            first_archive, first_snapshot = _inputs(
                features, products, datetime(2026, 8, 1, tzinfo=UTC),
            )
            first = compile_structural_gap_lab(features, first_archive, first_snapshot)
            other_source = "00000000-0000-0000-0000-000000000299"
            current_archive, current_snapshot = _inputs(
                features, products, datetime(2026, 8, 8, tzinfo=UTC),
                source_id=other_source,
            )
            with self.assertRaisesRegex(TCGCSVUniverseError, "source differs"):
                compile_structural_gap_lab(
                    features, current_archive, current_snapshot, prior_packets=[first],
                )

    def test_persistence_rejects_prior_packets_from_another_solver_lineage(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            features, products = _write_features(root)
            first_archive, first_snapshot = _inputs(
                features, products, datetime(2026, 8, 1, tzinfo=UTC),
            )
            first = compile_structural_gap_lab(features, first_archive, first_snapshot)
            forged = json.loads(json.dumps(first))
            forged["solverLineage"]["numpyRuntimeVersion"] = "forged-runtime"
            forged.pop("packetContentSha256")
            forged["packetContentSha256"] = content_hash(forged)
            current_archive, current_snapshot = _inputs(
                features, products, datetime(2026, 8, 8, tzinfo=UTC),
            )
            with self.assertRaisesRegex(TCGCSVUniverseError, "solver lineage"):
                compile_structural_gap_lab(
                    features, current_archive, current_snapshot,
                    prior_packets=[forged],
                )

    def test_cli_writes_mode_0600_and_refuses_overwrite(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            features, products = _write_features(root)
            archive, snapshot = _inputs(features, products, datetime(2026, 8, 15, tzinfo=UTC))
            archive_path = root / "archive.json"
            snapshot_path = root / "snapshot.json"
            archive_path.write_text(json.dumps(archive), encoding="utf-8")
            snapshot_path.write_text(json.dumps(snapshot), encoding="utf-8")
            output = root / "structural-gap.json"
            arguments = [
                "--features", str(features),
                "--archive-packet", str(archive_path),
                "--catalog-snapshot", str(snapshot_path),
                "--output", str(output),
            ]
            with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                self.assertEqual(structural_gap_main(arguments), 0)
                self.assertEqual(structural_gap_main(arguments), 2)
            self.assertEqual(os.stat(output).st_mode & 0o777, 0o600)


if __name__ == "__main__":
    unittest.main()
