import copy
import unittest

from collectfolio_analytics.pull_rate_source_verify import verify_manifest_source_snapshots
from analytics.tests.test_pull_rate_curation import manifest


class PullRateSourceVerifyTests(unittest.TestCase):
    def test_exact_article_snapshot_passes(self):
        value = manifest()
        source = value["studies"][0]["source"]
        body = "fixture body"
        from hashlib import sha256
        source["article_body_sha256"] = sha256(body.encode()).hexdigest()

        def fetcher(article_id):
            return {
                "uuid": article_id,
                "title": source["title"],
                "dateTime": source["published_at"] + "T12:00:00Z",
                "updatedTime": source["article_updated_at"],
                "body": body,
            }

        self.assertEqual(
            verify_manifest_source_snapshots(value, fetcher=fetcher),
            (source["article_id"],),
        )

    def test_changed_body_or_identity_fails_closed(self):
        value = manifest()
        source = value["studies"][0]["source"]

        def fetcher(article_id):
            return {
                "uuid": article_id,
                "title": source["title"],
                "dateTime": source["published_at"] + "T12:00:00Z",
                "updatedTime": source["article_updated_at"],
                "body": "changed",
            }

        with self.assertRaisesRegex(ValueError, "body hash mismatch"):
            verify_manifest_source_snapshots(value, fetcher=fetcher)
        changed = copy.deepcopy(value)
        changed["studies"][0]["source"]["title"] = "Wrong title"
        with self.assertRaisesRegex(ValueError, "title mismatch"):
            verify_manifest_source_snapshots(changed, fetcher=fetcher)


if __name__ == "__main__":
    unittest.main()
