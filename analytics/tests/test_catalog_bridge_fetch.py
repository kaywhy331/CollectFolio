import json
import tempfile
import unittest
from pathlib import Path

from collectfolio_analytics.catalog_bridge_fetch import (
    BridgeFetchError,
    fetch_provider_cards,
    fetch_provider_sets,
    pokemontcg_api_key_from_env,
)


def pokemon_sets_payload():
    return {"data": [
        {"id": "swsh12", "name": "Silver Tempest", "ptcgoCode": "SIT", "releaseDate": "2022/11/11"},
        {"id": "swsh11", "name": "Lost Origin", "ptcgoCode": "LOR", "releaseDate": "2022/09/09"},
    ]}


def pokemon_cards_page(set_id, page):
    if page > 1:
        return {"data": []}
    return {"data": [
        {"id": f"{set_id}-7", "name": "Pikachu VMAX", "number": "7", "rarity": "Rare Holo VMAX"},
        {"id": f"{set_id}-8", "name": "Pikachu V", "number": "8", "rarity": "Rare Holo V"},
    ]}


def scryfall_sets_payload():
    return {"data": [{"code": "neo", "name": "Neon Dynasty", "released_at": "2022-02-18"}]}


def scryfall_cards_page():
    return {"data": [{"id": "abc-123", "name": "Kaito Shizuki", "collector_number": "204", "rarity": "rare"}], "has_more": False}


def ygo_sets_payload():
    return [{"set_name": "Legend of Blue Eyes White Dragon", "set_code": "LOB", "tcg_date": "2002-03-08"}]


def ygo_cards_payload():
    return {"data": [
        {"id": 89631139, "name": "Blue-Eyes White Dragon", "card_sets": [
            {"set_code": "LOB-001", "set_name": "Legend of Blue Eyes White Dragon", "set_rarity": "Ultra Rare"}
        ]},
        {"id": 55144522, "name": "Pot of Greed", "card_sets": []},
    ]}


class FetchProviderSetsTests(unittest.TestCase):
    def test_pokemon_sets_are_normalized_and_cached(self):
        calls = []

        def fake_fetch(url, headers, max_bytes=None):
            calls.append(url)
            self.assertIn("Accept", headers)
            return pokemon_sets_payload()

        with tempfile.TemporaryDirectory() as tmp:
            cache_dir = Path(tmp)
            sets, result = fetch_provider_sets("pokemon", cache_dir, fetch_json=fake_fetch)
            self.assertEqual(len(sets), 2)
            self.assertEqual(result.record_count, 2)
            self.assertFalse(result.truncated)
            self.assertEqual(len(calls), 1)

            # A second call is a cache hit: no further network access.
            sets2, result2 = fetch_provider_sets("pokemon", cache_dir, fetch_json=fake_fetch)
            self.assertEqual(sets2, sets)
            self.assertEqual(result2.requests_made_this_call, 0)
            self.assertEqual(len(calls), 1)

    def test_pokemon_api_key_only_sent_when_configured(self):
        seen_headers = []

        def fake_fetch(url, headers, max_bytes=None):
            seen_headers.append(dict(headers))
            return pokemon_sets_payload()

        with tempfile.TemporaryDirectory() as tmp:
            fetch_provider_sets("pokemon", Path(tmp) / "no-key", fetch_json=fake_fetch)
            self.assertNotIn("X-Api-Key", seen_headers[-1])

            fetch_provider_sets("pokemon", Path(tmp) / "with-key", api_key="secret", fetch_json=fake_fetch)
            self.assertEqual(seen_headers[-1]["X-Api-Key"], "secret")

    def test_scryfall_sets_are_normalized(self):
        def fake_fetch(url, headers, max_bytes=None):
            return scryfall_sets_payload()

        with tempfile.TemporaryDirectory() as tmp:
            sets, result = fetch_provider_sets("scryfall", Path(tmp), fetch_json=fake_fetch)
            self.assertEqual(sets, [{"id": "neo", "name": "Neon Dynasty", "abbreviation": "neo", "releaseDate": "2022-02-18"}])
            self.assertEqual(result.record_count, 1)

    def test_ygoprodeck_sets_are_normalized(self):
        def fake_fetch(url, headers, max_bytes=None):
            return ygo_sets_payload()

        with tempfile.TemporaryDirectory() as tmp:
            sets, result = fetch_provider_sets("ygoprodeck", Path(tmp), fetch_json=fake_fetch)
            self.assertEqual(sets[0]["id"], "LOB")
            self.assertEqual(sets[0]["abbreviation"], "LOB")

    def test_fetch_failure_is_reported_not_raised(self):
        def failing_fetch(url, headers, max_bytes=None):
            raise BridgeFetchError("boom")

        with tempfile.TemporaryDirectory() as tmp:
            sets, result = fetch_provider_sets("pokemon", Path(tmp), fetch_json=failing_fetch)
            self.assertEqual(sets, [])
            self.assertTrue(result.truncated)
            self.assertEqual(result.units_failed_this_call, 1)

    def test_unsupported_provider_raises(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(BridgeFetchError):
                fetch_provider_sets("not-a-provider", Path(tmp))


class FetchProviderCardsTests(unittest.TestCase):
    def test_pokemon_cards_fetched_per_set_and_cached(self):
        calls = []

        def fake_fetch(url, headers, max_bytes=None):
            calls.append(url)
            set_id = "swsh12" if "swsh12" in url else "swsh11"
            page = 1
            return pokemon_cards_page(set_id, page)

        with tempfile.TemporaryDirectory() as tmp:
            cache_dir = Path(tmp)
            cards, result = fetch_provider_cards(
                "pokemon", cache_dir, ["swsh12", "swsh11"], fetch_json=fake_fetch, sleep=lambda _s: None,
            )
            self.assertEqual(result.units_fetched_this_call, 2)
            self.assertFalse(result.truncated)
            self.assertEqual(len(cards), 4)
            self.assertEqual({row["setId"] for row in cards}, {"swsh12", "swsh11"})
            # externalId shape matches services/providers/pokemon.js (card.id verbatim).
            self.assertIn("swsh12-7", {row["id"] for row in cards})

    def test_second_call_skips_already_completed_sets(self):
        calls = []

        def fake_fetch(url, headers, max_bytes=None):
            calls.append(url)
            return pokemon_cards_page("swsh12", 1)

        with tempfile.TemporaryDirectory() as tmp:
            cache_dir = Path(tmp)
            fetch_provider_cards("pokemon", cache_dir, ["swsh12"], fetch_json=fake_fetch, sleep=lambda _s: None)
            fetch_provider_cards("pokemon", cache_dir, ["swsh12"], fetch_json=fake_fetch, sleep=lambda _s: None)
            self.assertEqual(len(calls), 1)

    def test_max_requests_truncates_and_resumes(self):
        calls = []

        def fake_fetch(url, headers, max_bytes=None):
            calls.append(url)
            return {"data": []}

        with tempfile.TemporaryDirectory() as tmp:
            cache_dir = Path(tmp)
            _cards, result1 = fetch_provider_cards(
                "pokemon", cache_dir, ["a", "b", "c"], max_requests=1, fetch_json=fake_fetch, sleep=lambda _s: None,
            )
            self.assertTrue(result1.truncated)
            self.assertEqual(result1.units_fetched_this_call, 1)

            _cards2, result2 = fetch_provider_cards(
                "pokemon", cache_dir, ["a", "b", "c"], max_requests=10, fetch_json=fake_fetch, sleep=lambda _s: None,
            )
            self.assertFalse(result2.truncated)
            self.assertEqual(result2.units_already_cached, 1)
            self.assertEqual(len(calls), 3)  # 1 + 2, none repeated

    def test_scryfall_cards_paginate_via_has_more(self):
        def fake_fetch(url, headers, max_bytes=None):
            return scryfall_cards_page()

        with tempfile.TemporaryDirectory() as tmp:
            cards, result = fetch_provider_cards(
                "scryfall", Path(tmp), ["neo"], fetch_json=fake_fetch, sleep=lambda _s: None,
            )
            self.assertEqual(len(cards), 1)
            self.assertEqual(cards[0]["id"], "abc-123")
            self.assertFalse(result.truncated)

    def test_ygoprodeck_is_one_bulk_request_regardless_of_requested_set_ids(self):
        calls = []

        def fake_fetch(url, headers, max_bytes=None):
            calls.append(url)
            return ygo_cards_payload()

        with tempfile.TemporaryDirectory() as tmp:
            cards, result = fetch_provider_cards(
                "ygoprodeck", Path(tmp), ["LOB", "some-other-set"], fetch_json=fake_fetch, sleep=lambda _s: None,
            )
            self.assertEqual(len(calls), 1)
            # externalId shape matches services/providers/ygoprodeck.js:
            # `${cardId}:${setCode}`.
            self.assertIn("89631139:LOB-001", {row["id"] for row in cards})
            self.assertEqual(result.units_requested, 1)

            # A second call for the same cache dir is a pure cache hit.
            fetch_provider_cards("ygoprodeck", Path(tmp), ["LOB"], fetch_json=fake_fetch, sleep=lambda _s: None)
            self.assertEqual(len(calls), 1)

    def test_failed_unit_is_recorded_and_not_silently_retried_forever(self):
        def failing_fetch(url, headers, max_bytes=None):
            raise BridgeFetchError("upstream 500")

        with tempfile.TemporaryDirectory() as tmp:
            cache_dir = Path(tmp)
            _cards, result = fetch_provider_cards(
                "pokemon", cache_dir, ["swsh12"], fetch_json=failing_fetch, sleep=lambda _s: None,
            )
            self.assertEqual(result.units_failed_this_call, 1)
            state = json.loads((cache_dir / "pokemon" / "state.json").read_text(encoding="utf-8"))
            self.assertEqual(state["cardUnits"]["swsh12"]["status"], "failed")


    def test_ygoprodeck_set_id_matches_set_list_id_space_not_the_full_printing_code(self):
        # Regression: a card's own card_sets[].set_code ("LOB-001") is a
        # DIFFERENT id space from the provider set list's own id ("LOB",
        # sourced from cardsets.php's own set_code field) -- setId must be
        # the base code so it actually joins to a matched provider set.
        def fake_fetch(url, headers, max_bytes=None):
            return ygo_cards_payload()

        with tempfile.TemporaryDirectory() as tmp:
            cards, _result = fetch_provider_cards(
                "ygoprodeck", Path(tmp), ["LOB"], fetch_json=fake_fetch, sleep=lambda _s: None,
            )
            self.assertEqual({row["setId"] for row in cards}, {"LOB"})
            # The full per-printing code is preserved separately as `number`.
            self.assertEqual(cards[0]["number"], "LOB-001")

    def test_ygoprodeck_card_with_no_card_sets_contributes_no_rows(self):
        # "Pot of Greed" in ygo_cards_payload() has card_sets: [] -- it must
        # not surface as a phantom row with an empty/unjoinable setId.
        def fake_fetch(url, headers, max_bytes=None):
            return ygo_cards_payload()

        with tempfile.TemporaryDirectory() as tmp:
            cards, _result = fetch_provider_cards(
                "ygoprodeck", Path(tmp), ["LOB"], fetch_json=fake_fetch, sleep=lambda _s: None,
            )
            self.assertNotIn("", {row["setId"] for row in cards})
            self.assertFalse(any(str(row["id"]).startswith("55144522") for row in cards))

    def test_ygoprodeck_region_infix_variants_join_to_the_same_set(self):
        def fake_fetch(url, headers, max_bytes=None):
            return {"data": [
                {"id": 1, "name": "Pot of Greed", "card_sets": [
                    {"set_code": "PSV-EN088", "set_name": "Pharaoh's Servant", "set_rarity": "Common"},
                ]},
                {"id": 2, "name": "Ash Blossom", "card_sets": [
                    {"set_code": "2017-EN001", "set_name": "2017 Mega-Tin Mega Pack", "set_rarity": "Common"},
                ]},
            ]}

        with tempfile.TemporaryDirectory() as tmp:
            cards, _result = fetch_provider_cards(
                "ygoprodeck", Path(tmp), [], fetch_json=fake_fetch, sleep=lambda _s: None,
            )
            by_id = {row["id"]: row for row in cards}
            self.assertEqual(by_id["1:PSV-EN088"]["setId"], "PSV")
            self.assertEqual(by_id["2:2017-EN001"]["setId"], "2017")

    def test_pokemon_response_missing_data_envelope_is_recorded_failed_not_completed(self):
        # pokemontcg.io error/rate-limit responses are frequently still
        # HTTP 200 with an {"error": {...}} body and no "data" key --
        # regression for the ~106 matched-but-empty-cards pokemon sets.
        def fake_fetch(url, headers, max_bytes=None):
            return {"error": {"message": "rate limit exceeded"}}

        with tempfile.TemporaryDirectory() as tmp:
            cache_dir = Path(tmp)
            cards, result = fetch_provider_cards(
                "pokemon", cache_dir, ["swsh12"], fetch_json=fake_fetch, sleep=lambda _s: None,
            )
            self.assertEqual(cards, [])
            self.assertEqual(result.units_failed_this_call, 1)
            self.assertEqual(result.units_fetched_this_call, 0)
            state = json.loads((cache_dir / "pokemon" / "state.json").read_text(encoding="utf-8"))
            self.assertEqual(state["cardUnits"]["swsh12"]["status"], "failed")

    def test_pokemon_total_count_mismatch_is_recorded_failed_not_completed_with_zero(self):
        # The API reports totalCount=102 but page 1's data is empty --
        # must not be silently accepted as "set legitimately has 0 cards".
        def fake_fetch(url, headers, max_bytes=None):
            return {"data": [], "totalCount": 102}

        with tempfile.TemporaryDirectory() as tmp:
            cache_dir = Path(tmp)
            cards, result = fetch_provider_cards(
                "pokemon", cache_dir, ["base1"], fetch_json=fake_fetch, sleep=lambda _s: None,
            )
            self.assertEqual(cards, [])
            self.assertEqual(result.units_failed_this_call, 1)
            self.assertEqual(result.zero_card_units, 0)
            state = json.loads((cache_dir / "pokemon" / "state.json").read_text(encoding="utf-8"))
            self.assertEqual(state["cardUnits"]["base1"]["status"], "failed")

    def test_pokemon_genuine_zero_card_set_is_completed_and_counted_visibly(self):
        # totalCount==0 and zero rows agree -- a real (rare) empty set, not
        # a masked error. Completed, but surfaced via zero_card_units so an
        # operator can see it in receipts rather than it hiding silently.
        def fake_fetch(url, headers, max_bytes=None):
            return {"data": [], "totalCount": 0}

        with tempfile.TemporaryDirectory() as tmp:
            cache_dir = Path(tmp)
            cards, result = fetch_provider_cards(
                "pokemon", cache_dir, ["empty-promo"], fetch_json=fake_fetch, sleep=lambda _s: None,
            )
            self.assertEqual(cards, [])
            self.assertEqual(result.units_fetched_this_call, 1)
            self.assertEqual(result.units_failed_this_call, 0)
            self.assertEqual(result.zero_card_units, 1)
            state = json.loads((cache_dir / "pokemon" / "state.json").read_text(encoding="utf-8"))
            self.assertEqual(state["cardUnits"]["empty-promo"]["status"], "completed")

    def test_pokemon_pagination_fetches_all_pages_past_250(self):
        # A 300-card set must not be truncated at page 1's 250-row page size.
        page1 = {
            "data": [{"id": f"big-{i}", "name": f"Card {i}", "number": str(i), "rarity": "Common"} for i in range(1, 251)],
            "totalCount": 300,
        }
        page2 = {
            "data": [{"id": f"big-{i}", "name": f"Card {i}", "number": str(i), "rarity": "Common"} for i in range(251, 301)],
            "totalCount": 300,
        }
        calls = []

        def fake_fetch(url, headers, max_bytes=None):
            calls.append(url)
            return page1 if "page=1" in url else page2

        with tempfile.TemporaryDirectory() as tmp:
            cards, result = fetch_provider_cards(
                "pokemon", Path(tmp), ["big-set"], fetch_json=fake_fetch, sleep=lambda _s: None,
            )
            self.assertEqual(len(cards), 300)
            self.assertEqual(len(calls), 2)
            self.assertFalse(result.truncated)
            self.assertEqual(result.units_failed_this_call, 0)


class PokemonApiKeyFromEnvTests(unittest.TestCase):
    def test_returns_none_when_unset(self):
        import os
        original = os.environ.pop("POKEMONTCG_API_KEY", None)
        try:
            self.assertIsNone(pokemontcg_api_key_from_env())
        finally:
            if original is not None:
                os.environ["POKEMONTCG_API_KEY"] = original

    def test_returns_value_when_set(self):
        import os
        original = os.environ.get("POKEMONTCG_API_KEY")
        os.environ["POKEMONTCG_API_KEY"] = "abc123"
        try:
            self.assertEqual(pokemontcg_api_key_from_env(), "abc123")
        finally:
            if original is None:
                os.environ.pop("POKEMONTCG_API_KEY", None)
            else:
                os.environ["POKEMONTCG_API_KEY"] = original


if __name__ == "__main__":
    unittest.main()
