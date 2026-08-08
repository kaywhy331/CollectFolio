import unittest
from datetime import datetime, timezone

from collectfolio_analytics.catalog_seed import CatalogSeedRights, build_catalog_seed_packet
from collectfolio_analytics.catalog_seed_sql import build_catalog_seed_sql

RIGHTS = dict(
    source_code="pokemon_tcg_data",
    terms_url="https://example.test/terms",
    review_decision="research_only",
    catalog_metadata_allowed=True,
    reviewed_at="2026-08-07T00:00:00Z",
    document_hash="abc123",
)
SET_PAYLOAD = {"id": "sv8", "name": "Surging Sparks", "series": "Scarlet & Violet", "releaseDate": "2024/11/08"}
CARDS = [
    {"name": "Farfetch'd", "number": "16", "rarity": "Common"},
    {"name": "Pikachu ex", "number": "238", "rarity": "Special Illustration Rare"},
]


def packet():
    return build_catalog_seed_packet(
        CatalogSeedRights(**RIGHTS), [SET_PAYLOAD], {"sv8": CARDS},
        generated_at=datetime(2026, 8, 7, tzinfo=timezone.utc),
    )


class CatalogSeedSqlTests(unittest.TestCase):
    def test_defaults_to_rollback_and_commits_only_on_request(self):
        sql = build_catalog_seed_sql(packet())
        self.assertTrue(sql.strip().endswith("rollback; -- rehearsal by default; regenerate with commit for the real run"))
        self.assertIn("commit;", build_catalog_seed_sql(packet(), commit=True))

    def test_reverifies_the_source_review_at_execution_time(self):
        sql = build_catalog_seed_sql(packet())
        self.assertIn("source.code = 'pokemon_tcg_data'", sql)
        self.assertIn("review.decision in ('research_only', 'approved')", sql)
        self.assertIn("lacks a current usable terms review", sql)

    def test_inserts_are_idempotent_and_quotes_are_escaped(self):
        sql = build_catalog_seed_sql(packet())
        self.assertEqual(sql.count("on conflict (canonical_key) do nothing;"), 3)
        self.assertIn("Farfetch''d", sql)
        self.assertNotIn("Farfetch'd", sql.replace("Farfetch''d", ""))

    def test_refuses_non_seed_or_unreviewed_packets(self):
        with self.assertRaisesRegex(ValueError, "research_only_catalog_seed"):
            build_catalog_seed_sql({"mode": "something_else"})
        bad = packet()
        bad["public_display_candidates"] = [{"x": 1}]
        with self.assertRaisesRegex(ValueError, "no public display candidates"):
            build_catalog_seed_sql(bad)

    def test_row_counts_match_the_packet(self):
        result = packet()
        sql = build_catalog_seed_sql(result)
        # Common Farfetch'd yields two finishes; SIR Pikachu one.
        self.assertEqual(result["counts"], {"sets": 1, "cards": 2, "variants": 3})
        self.assertEqual(sql.count("card|"), 2 + 3)  # card keys appear in card rows and variant keys


if __name__ == "__main__":
    unittest.main()
