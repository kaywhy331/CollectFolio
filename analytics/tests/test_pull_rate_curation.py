import copy
import unittest

from collectfolio_analytics.pull_rate_curation import build_curated_pull_rate_packet


def manifest():
    return {
        "mode": "research_only_pull_rate_curation",
        "generated_at": "2026-08-08T16:00:00Z",
        "source_review": {
            "decision": "research_only",
            "document_path": "docs/source-reviews/FIXTURE.md",
            "document_sha256": "b" * 64,
        },
        "target_sets": [
            {
                "set_code": "demo1",
                "name": "Demo Set",
                "series": "Demo",
                "release_date": "2026-01-01",
            },
            {
                "set_code": "demo2",
                "name": "Unavailable Set",
                "series": "Demo",
                "release_date": "2026-02-01",
            },
        ],
        "studies": [
            {
                "source": {
                    "publisher": "TCGplayer",
                    "title": "Demo Pull Rates",
                    "url": "https://example.test/article/123e4567-e89b-42d3-a456-426614174000/",
                    "article_id": "123e4567-e89b-42d3-a456-426614174000",
                    "published_at": "2026-01-01",
                    "retrieved_at": "2026-08-08T15:56:23Z",
                    "article_updated_at": "2026-01-02T00:00:00Z",
                    "article_body_sha256": "a" * 64,
                    "sample_size": 4000,
                    "sample_size_kind": "reported_lower_bound",
                    "confidence_grade": "medium",
                    "methodology": "Pack-opening study with a 95% normal interval.",
                },
                "entries": [
                    {
                        "set_code": "demo1",
                        "rarity_slot": "special-illustration-rare",
                        "published_probability_percent": 1.25,
                        "published_ci_margin_percentage_points": 0.31,
                        "one_in_packs": 80,
                        "eligible_count": 5,
                        "equal_distribution_assumed": True,
                        "collation_notes": "Source explicitly assumes equal populations.",
                    }
                ],
            }
        ],
        "unavailable": [
            {
                "set_code": "demo2",
                "scope": "set",
                "reason": "No primary study found.",
                "checked_at": "2026-08-08T15:56:23Z",
            }
        ],
    }


class PullRateCurationTests(unittest.TestCase):
    def test_builds_deterministic_private_packet_and_canonical_set_ids(self):
        first = build_curated_pull_rate_packet(manifest())
        second = build_curated_pull_rate_packet(manifest())
        self.assertEqual(first["packet_hash"], second["packet_hash"])
        self.assertEqual(
            first["counts"],
            {
                "sources": 1,
                "entries": 1,
                "target_sets": 2,
                "covered_sets": 1,
                "unavailable_sets": 1,
                "unavailable_records": 1,
            },
        )
        self.assertTrue(first["review_required"])
        self.assertEqual(first["public_display_candidates"], [])
        row = first["rows"]["set_pull_rates"][0]
        self.assertEqual(row["probability"], 0.0125)
        self.assertEqual(row["ci_lower"], 0.0094)
        self.assertEqual(row["ci_upper"], 0.0156)
        self.assertAlmostEqual(row["specific_probability"], 0.0025)
        self.assertEqual(
            row["set_id"], first["evidence"]["catalog_sets"][0]["set_id"]
        )
        self.assertIn(
            "Article body SHA-256: " + "a" * 64,
            first["rows"]["pull_rate_sources"][0]["methodology"],
        )
        self.assertEqual(len(first["rows"]["pull_rate_unavailability"]), 1)
        self.assertIsNone(first["rows"]["pull_rate_unavailability"][0]["source_id"])

    def test_nonpositive_published_interval_requires_explicit_omission(self):
        value = manifest()
        entry = value["studies"][0]["entries"][0]
        entry["published_probability_percent"] = 0.08
        entry["published_ci_margin_percentage_points"] = 0.08
        entry["one_in_packs"] = 1260
        with self.assertRaisesRegex(ValueError, "requires ci_omission_reason"):
            build_curated_pull_rate_packet(value)
        entry["ci_omission_reason"] = "Published lower bound is zero."
        packet = build_curated_pull_rate_packet(value)
        row = packet["rows"]["set_pull_rates"][0]
        self.assertIsNone(row["ci_lower"])
        self.assertIsNone(row["ci_upper"])

    def test_all_target_sets_must_be_covered_or_explicitly_unavailable(self):
        value = manifest()
        value["unavailable"] = []
        with self.assertRaisesRegex(ValueError, "lack rates or an unavailable record"):
            build_curated_pull_rate_packet(value)

    def test_duplicate_sources_and_tampered_evidence_are_refused(self):
        value = manifest()
        value["studies"].append(copy.deepcopy(value["studies"][0]))
        with self.assertRaisesRegex(ValueError, "duplicate source identity"):
            build_curated_pull_rate_packet(value)
        value = manifest()
        value["studies"][0]["source"]["article_body_sha256"] = "not-a-hash"
        with self.assertRaisesRegex(ValueError, "SHA-256"):
            build_curated_pull_rate_packet(value)

    def test_pooled_study_can_omit_specific_derivations(self):
        value = manifest()
        entry = value["studies"][0]["entries"][0]
        entry["eligible_count"] = None
        entry["equal_distribution_assumed"] = False
        packet = build_curated_pull_rate_packet(value)
        row = packet["rows"]["set_pull_rates"][0]
        self.assertIsNone(row["specific_probability"])
        self.assertFalse(row["equal_distribution_assumed"])


if __name__ == "__main__":
    unittest.main()
