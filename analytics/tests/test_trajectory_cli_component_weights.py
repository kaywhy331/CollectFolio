import argparse
import json
import tempfile
import unittest
from pathlib import Path

from collectfolio_analytics.trajectory_cli import _load_component_weights, _parser
from collectfolio_analytics.trajectory_eval import DEFAULT_MAX_VARIANTS_PER_CATEGORY


class LoadComponentWeightsTests(unittest.TestCase):
    """T4 remediation: trajectory_cli._load_component_weights, the loader
    behind run-category's --component-weights-path flag."""

    def test_missing_file_returns_none(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertIsNone(_load_component_weights(Path(tmp) / "nope.json", 85))

    def test_missing_category_entry_returns_none(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "component-weights.json"
            path.write_text(json.dumps({"1": {"30": {"weightA": 0.5, "weightB": 1.0}}}))
            self.assertIsNone(_load_component_weights(path, 85))

    def test_loads_and_keys_by_horizon_steps(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "component-weights.json"
            path.write_text(json.dumps({
                "85": {
                    "30": {"weightA": 0.25, "weightC": 0.1, "weightB": 0.5},
                    "60": {"weightA": 0.0, "weightC": 0.25, "weightB": -0.25},
                    "90": {"weightA": 1.0, "weightB": 0.0},
                },
            }))
            weights = _load_component_weights(path, 85)
        # horizon_steps_for(30) == 4, horizon_steps_for(90) == 13 (pinned
        # in test_trajectory.py's HorizonStepsForTests too).
        self.assertEqual(weights, {
            4: (0.25, 0.1, 0.5),
            9: (0.0, 0.25, -0.25),
            13: (1.0, 0.0, 0.0),
        })

    def test_empty_category_entry_returns_none(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "component-weights.json"
            path.write_text(json.dumps({"85": {}}))
            self.assertIsNone(_load_component_weights(path, 85))



class EvalComponentWeightsMaxVariantsFlagTests(unittest.TestCase):
    """eval-component-weights exposes --max-variants-per-category, defaulting
    to trajectory_eval's DEFAULT_MAX_VARIANTS_PER_CATEGORY, threaded through
    to run_component_weight_remediation by _eval_component_weights_command."""

    def test_default_matches_trajectory_eval_default(self):
        args = _parser().parse_args(["eval-component-weights", "--category-ids", "85"])
        self.assertEqual(args.max_variants_per_category, DEFAULT_MAX_VARIANTS_PER_CATEGORY)

    def test_can_be_overridden(self):
        args = _parser().parse_args([
            "eval-component-weights", "--category-ids", "85",
            "--max-variants-per-category", "500",
        ])
        self.assertEqual(args.max_variants_per_category, 500)


def _make_component_weights_receipt(
    category_id: int, *, horizon30_passes: bool, horizon90_passes: bool,
    total_variants: int = 10, sampled_variants: int | None = None, sampling_rule: str | None = None,
) -> dict:
    """Minimal-but-structurally-valid evaluation-category-<id>.json receipt,
    matching what _eval_component_weights_command writes -- used to test the
    summary merge/render logic without running the (expensive) real eval
    pipeline."""

    sampled_variants = total_variants if sampled_variants is None else sampled_variants
    sampling_applied = sampled_variants < total_variants

    def result(horizon_days, passes):
        return {
            "categoryId": category_id,
            "cohort": "standard",
            "horizonDays": horizon_days,
            "nCases": 100,
            "maeEngine": 0.1,
            "maeNoChange": 0.1,
            "maeLiftOverNoChange": 0.01 if passes else 0.0,
            "nMovers": 10,
            "directionAccuracyMovers": 0.7,
            "coverage80": 0.8,
            "pinballQ50Engine": 0.1,
            "pinballQ50NoChange": 0.11,
            "pinballBeatsNoChange": True,
            "baselineMae": 0.1,
            "passes": passes,
            "failReasons": [] if passes else ["mae_lift<=0"],
            "servingEligible": passes,
        }

    def selection(h_steps, horizon_days):
        return {
            "weightA": 1.0, "weightC": 0.0, "weightB": 1.0, "horizonDays": horizon_days,
            "trainMaeLiftOverNoChange": 0.01, "trainNCases": 50,
            "trainOrigins": [1, 2, 3], "holdoutOrigins": [4, 5, 6],
        }

    return {
        "modelVersion": "test",
        "generatedAt": "2026-01-01T00:00:00+00:00",
        "categoryId": category_id,
        "wallClockSeconds": 0.1,
        "peakRssBytes": 1000,
        "selection": {"4": selection(4, 30), "13": selection(13, 90)},
        "gridScores": {"4": [], "13": []},
        "gate": {
            "categoryId": category_id,
            "componentWeights": {"4": [1.0, 1.0], "13": [1.0, 1.0]},
            "results": [result(30, horizon30_passes), result(90, horizon90_passes)],
            "servingEligibleByCohort": {"standard": horizon30_passes or horizon90_passes},
            "coldStart": {"status": "unevaluable"},
            "anyCohortServingEligible": horizon30_passes or horizon90_passes,
        },
        "totalVariants": total_variants,
        "sampledVariants": sampled_variants,
        "samplingApplied": sampling_applied,
        "samplingRule": sampling_rule if sampling_applied else None,
    }


class MergedEvaluationSummaryTests(unittest.TestCase):
    """evaluation-summary.md/json must MERGE from every
    evaluation-category-*.json present in the receipts dir, not just
    whatever the current invocation evaluated -- regression test for the
    bug where per-category runs clobbered each other's summary
    contribution."""

    def test_merged_category_rows_reads_every_receipt_sorted(self):
        from collectfolio_analytics.trajectory_cli import _merged_category_rows

        with tempfile.TemporaryDirectory() as tmp:
            receipts_dir = Path(tmp)
            for cat_id in (2, 1):
                receipt = _make_component_weights_receipt(cat_id, horizon30_passes=True, horizon90_passes=True)
                (receipts_dir / f"evaluation-category-{cat_id}.json").write_text(json.dumps(receipt))

            rows = _merged_category_rows(receipts_dir)
        self.assertEqual([row["categoryId"] for row in rows], [1, 2])
        # selection/gate/sampling fields survive the JSON round-trip.
        self.assertIn(30, rows[0]["selection"])
        self.assertIn(90, rows[0]["selection"])
        self.assertEqual(rows[0]["totalVariants"], 10)

    def test_render_eval_summary_command_merges_across_separate_writes(self):
        from collectfolio_analytics.trajectory_cli import _render_eval_summary_command

        with tempfile.TemporaryDirectory() as tmp:
            receipts_dir = Path(tmp)
            args = argparse.Namespace(receipts_dir=str(receipts_dir))

            # Simulate a per-category-1 invocation, then a separate
            # per-category-2 invocation (as the harness's sequential runs
            # do) -- each only writes its own evaluation-category-<id>.json.
            receipt1 = _make_component_weights_receipt(1, horizon30_passes=False, horizon90_passes=True)
            (receipts_dir / "evaluation-category-1.json").write_text(json.dumps(receipt1))
            rc = _render_eval_summary_command(args)
            self.assertEqual(rc, 0)
            summary_after_cat1 = json.loads((receipts_dir / "evaluation-summary.json").read_text())
            self.assertEqual([c["categoryId"] for c in summary_after_cat1["categories"]], [1])

            receipt2 = _make_component_weights_receipt(2, horizon30_passes=True, horizon90_passes=True)
            (receipts_dir / "evaluation-category-2.json").write_text(json.dumps(receipt2))
            rc = _render_eval_summary_command(args)
            self.assertEqual(rc, 0)

            summary_after_cat2 = json.loads((receipts_dir / "evaluation-summary.json").read_text())
            # The bug: this used to show only category 2 (overwritten),
            # dropping category 1's earlier receipt. Fixed: both present.
            self.assertEqual([c["categoryId"] for c in summary_after_cat2["categories"]], [1, 2])

            md = (receipts_dir / "evaluation-summary.md").read_text()
            self.assertIn("| 1 |", md)
            self.assertIn("| 2 |", md)

    def test_render_eval_summary_command_missing_receipts_dir(self):
        from collectfolio_analytics.trajectory_cli import _render_eval_summary_command

        args = argparse.Namespace(receipts_dir="/nonexistent/does-not-exist")
        self.assertEqual(_render_eval_summary_command(args), 2)

    def test_render_eval_summary_command_no_receipts_present(self):
        from collectfolio_analytics.trajectory_cli import _render_eval_summary_command

        with tempfile.TemporaryDirectory() as tmp:
            args = argparse.Namespace(receipts_dir=tmp)
            self.assertEqual(_render_eval_summary_command(args), 2)

    def test_summary_carries_serving_eligibility_and_sampling_disclosure_for_all_categories(self):
        from collectfolio_analytics.trajectory_cli import (
            _merged_category_rows,
            _render_component_weights_summary_markdown,
        )

        with tempfile.TemporaryDirectory() as tmp:
            receipts_dir = Path(tmp)
            (receipts_dir / "evaluation-category-3.json").write_text(json.dumps(
                _make_component_weights_receipt(3, horizon30_passes=True, horizon90_passes=True)
            ))
            (receipts_dir / "evaluation-category-85.json").write_text(json.dumps(
                _make_component_weights_receipt(
                    85, horizon30_passes=False, horizon90_passes=False,
                    total_variants=32365, sampled_variants=20000, sampling_rule="deterministic sha256 rank",
                )
            ))
            rows = _merged_category_rows(receipts_dir)
            md = _render_component_weights_summary_markdown(rows)

        self.assertIn("## Serving-eligibility conclusions", md)
        self.assertIn("| 3 | standard |", md)
        self.assertIn("| 85 | standard |", md)
        self.assertIn("## Variant sampling (no silent caps)", md)
        self.assertIn("Category 3: no sampling applied", md)
        self.assertIn("Category 85: metrics are computed on a deterministic 20000-of-32365 variant sample", md)

    def test_near_miss_note_flags_later_horizon_pass_when_earlier_fails(self):
        from collectfolio_analytics.trajectory_cli import (
            _category_row_from_receipt,
            _render_component_weights_summary_markdown,
        )

        receipt = _make_component_weights_receipt(4, horizon30_passes=False, horizon90_passes=True)
        rows = [_category_row_from_receipt(receipt)]
        md = _render_component_weights_summary_markdown(rows)
        self.assertIn(
            "## Near-miss notes (informational; failed horizons remain range-only)",
            md,
        )
        self.assertIn(
            "Category 4, standard cohort: passes 90d only (30d fails). Failed horizons remain "
            "range-only; no override upgrades them.",
            md,
        )

    def test_near_miss_never_upgrades_a_failed_horizon(self):
        from collectfolio_analytics.trajectory_cli import (
            _category_row_from_receipt,
            _render_component_weights_summary_markdown,
        )

        receipt = _make_component_weights_receipt(1, horizon30_passes=False, horizon90_passes=True)
        rows = [_category_row_from_receipt(receipt)]
        md = _render_component_weights_summary_markdown(rows)
        self.assertIn(
            "Category 1, standard cohort: passes 90d only (30d fails). Failed horizons remain "
            "range-only; no override upgrades them.",
            md,
        )
        self.assertNotIn("ENABLED", md)

    def test_no_near_miss_note_when_all_horizons_agree(self):
        from collectfolio_analytics.trajectory_cli import (
            _category_row_from_receipt,
            _render_component_weights_summary_markdown,
        )

        receipt = _make_component_weights_receipt(3, horizon30_passes=True, horizon90_passes=True)
        rows = [_category_row_from_receipt(receipt)]
        md = _render_component_weights_summary_markdown(rows)
        self.assertIn("- none", md)

    def test_render_eval_summary_subcommand_registered_on_parser(self):
        args = _parser().parse_args(["render-eval-summary", "--receipts-dir", "/tmp/x"])
        self.assertEqual(args.receipts_dir, "/tmp/x")
        self.assertIs(args.handler, __import__(
            "collectfolio_analytics.trajectory_cli", fromlist=["_render_eval_summary_command"]
        )._render_eval_summary_command)
