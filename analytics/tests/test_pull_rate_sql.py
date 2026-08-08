import copy
import unittest

from collectfolio_analytics.pull_rate_curation import build_curated_pull_rate_packet
from collectfolio_analytics.pull_rate_sql import build_pull_rate_sql
from analytics.tests.test_pull_rate_curation import manifest


def packet():
    return build_curated_pull_rate_packet(manifest())


class PullRateSqlTests(unittest.TestCase):
    def test_defaults_to_rollback_and_commits_only_on_request(self):
        sql = build_pull_rate_sql(packet())
        self.assertTrue(
            sql.strip().endswith(
                "rollback; -- rehearsal by default; regenerate with commit for the real run"
            )
        )
        self.assertIn("commit;", build_pull_rate_sql(packet(), commit=True))

    def test_uses_temporary_expected_rows_and_exact_post_insert_guards(self):
        sql = build_pull_rate_sql(packet())
        self.assertIn("_collectfolio_expected_catalog_sets", sql)
        self.assertIn("catalog identity does not match", sql)
        self.assertIn("on conflict (id) do nothing;", sql)
        self.assertIn("Hosted pull-rate source identity conflicts", sql)
        self.assertIn("Hosted pull-rate row identity conflicts", sql)
        self.assertIn("Hosted pull-rate unavailability identity conflicts", sql)
        self.assertIn("insert into public.pull_rate_unavailability", sql)
        self.assertIn(packet()["packet_hash"], sql)

    def test_tampering_or_public_candidates_are_refused(self):
        value = packet()
        value["rows"]["set_pull_rates"][0]["probability"] = 0.5
        with self.assertRaisesRegex(ValueError, "packet_hash"):
            build_pull_rate_sql(value)
        value = packet()
        value["public_display_candidates"] = [{"forbidden": True}]
        with self.assertRaisesRegex(ValueError, "no public display candidates"):
            build_pull_rate_sql(value)

    def test_quotes_are_escaped_and_unavailable_records_are_inserted(self):
        value = packet()
        value["rows"]["pull_rate_sources"][0]["publisher"] = "Publisher's Lab"
        # Re-hash the deliberately changed, still-valid packet.
        from collectfolio_analytics.pull_rate_curation import pull_rate_packet_hash
        value["packet_hash"] = pull_rate_packet_hash(
            value["rows"], value["evidence"], value["coverage"]
        )
        sql = build_pull_rate_sql(value)
        self.assertIn("Publisher''s Lab", sql)
        self.assertIn("No primary study found.", sql)


if __name__ == "__main__":
    unittest.main()
