import unittest

from collectfolio_analytics.storage_budget import DEFAULT_BUDGETS_MB, evaluate_storage_budget

FULL_MEASUREMENT = {area: budget * 0.5 for area, budget in DEFAULT_BUDGETS_MB.items()}


class StorageBudgetTests(unittest.TestCase):
    def test_healthy_measurement_is_ok_and_complete(self):
        report = evaluate_storage_budget(FULL_MEASUREMENT)
        self.assertTrue(report["complete"])
        self.assertEqual(report["total"]["status"], "ok")
        self.assertTrue(all(area["status"] == "ok" for area in report["areas"]))

    def test_warning_and_exceeded_thresholds(self):
        measured = dict(FULL_MEASUREMENT)
        measured["latest_prices"] = 25 * 0.9   # inside warning band
        measured["model_outputs_and_metrics"] = 60  # over its 50 MB budget
        report = evaluate_storage_budget(measured)
        by_area = {entry["area"]: entry["status"] for entry in report["areas"]}
        self.assertEqual(by_area["latest_prices"], "warning")
        self.assertEqual(by_area["model_outputs_and_metrics"], "exceeded")

    def test_unmeasured_and_unknown_areas_break_completeness(self):
        measured = dict(FULL_MEASUREMENT)
        del measured["headroom_and_index_growth"]
        measured["mystery_table_dump"] = 10
        report = evaluate_storage_budget(measured)
        self.assertFalse(report["complete"])
        self.assertIn("mystery_table_dump", report["unknown_areas"])
        statuses = {entry["area"]: entry["status"] for entry in report["areas"]}
        self.assertEqual(statuses["headroom_and_index_growth"], "unmeasured")
        # Unknown usage still counts toward the total budget.
        self.assertGreater(report["total"]["measured_mb"], sum(FULL_MEASUREMENT.values()) - 25)

    def test_total_breach_is_flagged_even_when_areas_pass(self):
        measured = {area: budget * 0.99 for area, budget in DEFAULT_BUDGETS_MB.items()}
        measured["unbudgeted_archive"] = 100
        report = evaluate_storage_budget(measured)
        self.assertEqual(report["total"]["status"], "exceeded")

    def test_negative_measurements_are_refused(self):
        with self.assertRaisesRegex(ValueError, "cannot be negative"):
            evaluate_storage_budget({**FULL_MEASUREMENT, "latest_prices": -1})


if __name__ == "__main__":
    unittest.main()
