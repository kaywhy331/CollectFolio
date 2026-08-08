import copy
import json
from pathlib import Path
import unittest

from collectfolio_analytics.mapping_supersession_sql import (
    build_mapping_supersession_sql,
    mapping_supersession_manifest_hash,
)

ROOT = Path(__file__).resolve().parents[2]
MANIFEST_PATH = ROOT / "analytics/manifests/tcgcsv-surging-sparks-mapping-supersession-v2.json"
CURRENT_PATH = ROOT / "analytics/manifests/tcgcsv-surging-sparks-current-v2.json"


def manifest():
    return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))


class MappingSupersessionSqlTests(unittest.TestCase):
    def test_defaults_to_rollback_and_commit_changes_only_the_terminator(self):
        rehearsal = build_mapping_supersession_sql(manifest())
        committed = build_mapping_supersession_sql(manifest(), commit=True)
        terminator = "rollback; -- rehearsal by default; regenerate with commit for the real run"
        self.assertIn(terminator, rehearsal)
        self.assertEqual(rehearsal.replace(terminator, "commit;"), committed)

    def test_guards_exact_identity_rights_and_historical_lineage(self):
        sql = build_mapping_supersession_sql(manifest())
        for contract in (
            "supersede_external_card_mapping",
            "TCGCSV source rights no longer match",
            "Public price intelligence must remain disabled",
            "Old mapping no longer matches",
            "Replacement variant does not match",
            "Historical v1 lineage counts changed",
            "Mapping RPC changed immutable historical",
            "Successor mapping unexpectedly claimed historical observations",
            "54::bigint",
            "43::bigint",
            "215::bigint",
        ):
            self.assertIn(contract, sql)

    def test_embeds_review_hash_and_escapes_operator_text(self):
        value = manifest()
        value["correction_reason"] += " Operator's confirmation."
        value["manifest_sha256"] = mapping_supersession_manifest_hash(value)
        sql = build_mapping_supersession_sql(value)
        self.assertIn("Operator''s confirmation", sql)
        self.assertIn(value["review"]["document_sha256"], sql)

    def test_rejects_tampering_or_relaxed_public_safety(self):
        value = manifest()
        value["old_mapping"]["expected_lineage"]["price_observations"] = 53
        with self.assertRaisesRegex(ValueError, "manifest_sha256"):
            build_mapping_supersession_sql(value)

        value = copy.deepcopy(manifest())
        value["source"]["public_raw_display_allowed"] = True
        value["manifest_sha256"] = mapping_supersession_manifest_hash(value)
        with self.assertRaisesRegex(ValueError, "rights must remain false"):
            build_mapping_supersession_sql(value)

        value = copy.deepcopy(manifest())
        value["safety"]["require_no_public_candidates"] = False
        value["manifest_sha256"] = mapping_supersession_manifest_hash(value)
        with self.assertRaisesRegex(ValueError, "must be true"):
            build_mapping_supersession_sql(value)

    def test_current_manifest_routes_future_only_to_the_hosted_successor(self):
        current = json.loads(CURRENT_PATH.read_text(encoding="utf-8"))
        self.assertNotIn("historicalResearch", current)
        self.assertNotIn("retrospectiveResearch", current)
        self.assertNotIn("ingestedAt", current)
        self.assertEqual(current["canonicalVariants"][0]["setCode"], "sv8")
        self.assertEqual(current["canonicalVariants"][0]["number"], "238")
        self.assertEqual(
            current["approvedMappings"][0]["mappingId"],
            "649be0ee-0893-459a-bad6-331a218e069b",
        )
        self.assertEqual(
            current["approvedMappings"][0]["variantId"],
            "af796afb-d8d3-5b4b-a95a-417e39e77b0a",
        )
        review_path = ROOT / current["mappingReview"]["document"]
        from hashlib import sha256
        self.assertEqual(
            sha256(review_path.read_bytes()).hexdigest(),
            current["mappingReview"]["documentHash"],
        )


if __name__ == "__main__":
    unittest.main()
