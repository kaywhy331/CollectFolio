import unittest
from datetime import date, datetime, timezone

from collectfolio_analytics.wikimedia import (
    CharacterPageMapping,
    WikimediaPayloadError,
    fetch_daily_pageviews,
    pageview_url,
    validate_user_agent,
)

UA = "CollectFolioAnalytics/0.1 (hello@collectfolio.test)"
RETRIEVED = datetime(2026, 8, 7, 12, 0, tzinfo=timezone.utc)
MAPPING = CharacterPageMapping(character_key="charizard", article="Charizard")
WINDOW = (date(2026, 8, 1), date(2026, 8, 3))


def payload(article="Charizard", timestamps=("2026080100", "2026080200"), views=(100, 120)):
    return {"items": [
        {"project": "en.wikipedia", "article": article, "granularity": "daily",
         "timestamp": timestamp, "access": "all-access", "agent": "user", "views": count}
        for timestamp, count in zip(timestamps, views)
    ]}


def fake_fetch(response):
    calls = []

    def fetch(url, headers, *, timeout_seconds):
        calls.append({"url": url, "headers": dict(headers)})
        return response

    fetch.calls = calls
    return fetch


class UserAgentTests(unittest.TestCase):
    def test_contactless_user_agent_is_refused(self):
        with self.assertRaisesRegex(ValueError, "contact route"):
            validate_user_agent("Mozilla/5.0")

    def test_identifying_user_agent_passes(self):
        self.assertEqual(validate_user_agent(UA), UA)


class UrlTests(unittest.TestCase):
    def test_url_encodes_spaces_as_underscores_and_bounds_the_window(self):
        url = pageview_url(CharacterPageMapping(character_key="mr-mime", article="Mr. Mime"), *WINDOW)
        self.assertIn("/per-article/en.wikipedia.org/all-access/user/Mr.%20Mime".replace("%20", "_"), url)
        self.assertTrue(url.endswith("/daily/20260801/20260803"))


class FetchTests(unittest.TestCase):
    def test_observations_are_stamped_with_retrieval_time_not_view_dates(self):
        fetch = fake_fetch(payload())
        result = fetch_daily_pageviews([MAPPING], *WINDOW, user_agent=UA, retrieved_at=RETRIEVED, fetch_json=fetch)
        self.assertEqual(result["counts"], {"articles": 1, "observations": 2})
        for row in result["observations"]:
            self.assertEqual(row["available_at"], RETRIEVED.isoformat())
        self.assertEqual(fetch.calls[0]["headers"]["Api-User-Agent"], UA)

    def test_result_hash_is_deterministic(self):
        first = fetch_daily_pageviews([MAPPING], *WINDOW, user_agent=UA, retrieved_at=RETRIEVED, fetch_json=fake_fetch(payload()))
        second = fetch_daily_pageviews([MAPPING], *WINDOW, user_agent=UA, retrieved_at=RETRIEVED, fetch_json=fake_fetch(payload()))
        self.assertEqual(first["packet_hash"], second["packet_hash"])

    def test_article_mismatch_fails_closed(self):
        fetch = fake_fetch(payload(article="Pikachu"))
        with self.assertRaisesRegex(WikimediaPayloadError, "does not match"):
            fetch_daily_pageviews([MAPPING], *WINDOW, user_agent=UA, retrieved_at=RETRIEVED, fetch_json=fetch)

    def test_out_of_window_item_fails_closed(self):
        fetch = fake_fetch(payload(timestamps=("2026070100",), views=(5,)))
        with self.assertRaisesRegex(WikimediaPayloadError, "outside the requested window"):
            fetch_daily_pageviews([MAPPING], *WINDOW, user_agent=UA, retrieved_at=RETRIEVED, fetch_json=fetch)

    def test_negative_or_boolean_views_fail_closed(self):
        fetch = fake_fetch(payload(views=(-1, 3)))
        with self.assertRaisesRegex(WikimediaPayloadError, "non-negative integer"):
            fetch_daily_pageviews([MAPPING], *WINDOW, user_agent=UA, retrieved_at=RETRIEVED, fetch_json=fetch)

    def test_repeated_view_dates_fail_closed(self):
        fetch = fake_fetch(payload(timestamps=("2026080100", "2026080100"), views=(1, 2)))
        with self.assertRaisesRegex(WikimediaPayloadError, "repeat a view date"):
            fetch_daily_pageviews([MAPPING], *WINDOW, user_agent=UA, retrieved_at=RETRIEVED, fetch_json=fetch)

    def test_run_bounds_are_enforced(self):
        mappings = [CharacterPageMapping(character_key=f"c{i}", article=f"A{i}") for i in range(51)]
        with self.assertRaisesRegex(ValueError, "at most 50 articles"):
            fetch_daily_pageviews(mappings, *WINDOW, user_agent=UA, retrieved_at=RETRIEVED, fetch_json=fake_fetch(payload()))
        with self.assertRaisesRegex(ValueError, "at most 400 days"):
            fetch_daily_pageviews([MAPPING], date(2020, 1, 1), date(2026, 1, 1), user_agent=UA, retrieved_at=RETRIEVED, fetch_json=fake_fetch(payload()))

    def test_naive_retrieval_time_is_refused(self):
        with self.assertRaisesRegex(ValueError, "timezone-aware"):
            fetch_daily_pageviews([MAPPING], *WINDOW, user_agent=UA, retrieved_at=datetime(2026, 8, 7), fetch_json=fake_fetch(payload()))


if __name__ == "__main__":
    unittest.main()
