import unittest
from datetime import date

from collectfolio_analytics.catalog_bridge import (
    ProductMatch,
    ProductUnmatched,
    SetMatch,
    SetUnmatched,
    build_bridge_table,
    match_products,
    match_sets,
    normalize_collector_number,
    normalize_name,
    summarize_match_rates,
)


def group(group_id, name, abbreviation="", published_on=None):
    return {"category_id": 3, "group_id": group_id, "name": name, "abbreviation": abbreviation, "published_on": published_on}


def pset(id_, name, code="", released_at=None):
    return {"id": id_, "name": name, "code": code, "released_at": released_at}


def product(product_id, card_number="", name="", clean_name=""):
    return {"category_id": 3, "group_id": 1102, "product_id": product_id, "card_number": card_number, "name": name, "clean_name": clean_name}


def card(id_, number="", name=""):
    return {"id": id_, "number": number, "name": name}


class NormalizeNameTests(unittest.TestCase):
    def test_casefolds_and_collapses_punctuation(self):
        self.assertEqual(normalize_name("Silver Tempest!"), "silver tempest")
        self.assertEqual(normalize_name("Silver  Tempest"), "silver tempest")

    def test_diacritics_normalize_consistently(self):
        self.assertEqual(normalize_name("Pokémon Card"), normalize_name("Pokémon Card"))
        self.assertEqual(normalize_name("Café  Set!"), "café set")

    def test_empty_is_empty_string(self):
        self.assertEqual(normalize_name(None), "")
        self.assertEqual(normalize_name(""), "")


class NormalizeCollectorNumberTests(unittest.TestCase):
    def test_strips_leading_zeros_in_each_digit_run(self):
        self.assertEqual(normalize_collector_number("007"), "7")

    def test_preserves_alpha_suffix(self):
        self.assertEqual(normalize_collector_number("SWSH001"), "SWSH1")
        self.assertEqual(normalize_collector_number("12a"), "12A")

    def test_whitespace_and_case_insensitive(self):
        self.assertEqual(normalize_collector_number(" 07 "), "7")
        self.assertEqual(normalize_collector_number("SM12"), "SM12")

    def test_equal_after_normalization(self):
        self.assertEqual(normalize_collector_number("007"), normalize_collector_number("7"))

    def test_drops_set_total_suffix_entirely(self):
        # TCGCSV's "NNN/<set size>" form vs a provider's bare number -- the
        # denominator encodes set size, not card identity.
        self.assertEqual(normalize_collector_number("001/102"), "1")
        self.assertEqual(normalize_collector_number("025/198"), "25")

    def test_set_total_suffix_and_bare_number_are_equal_pair(self):
        self.assertEqual(normalize_collector_number("001/102"), normalize_collector_number("1"))

    def test_drops_region_infix_in_code_number_form(self):
        # ygoprodeck's "SETCODE-<REGION><NNN>" vs TCGCSV's "SETCODE-NNN".
        self.assertEqual(normalize_collector_number("PSV-088"), normalize_collector_number("PSV-EN088"))
        self.assertEqual(normalize_collector_number("2017-001"), normalize_collector_number("2017-EN001"))

    def test_zero_stripping_never_merges_distinct_numbers(self):
        # Only *leading* zeros are stripped, so "10" and "100" -- neither of
        # which has a leading zero -- must stay distinct after normalizing
        # even once their TCGCSV "/<total>" suffix is dropped.
        self.assertNotEqual(normalize_collector_number("10/102"), normalize_collector_number("100/102"))
        self.assertEqual(normalize_collector_number("10/102"), "10")
        self.assertEqual(normalize_collector_number("100/102"), "100")


class MatchSetsTests(unittest.TestCase):
    def test_exact_name_match(self):
        groups = [group(1102, "Silver Tempest", "SIT", date(2022, 11, 11))]
        sets = [pset("swsh12", "Silver Tempest", "SIT", date(2022, 11, 11))]
        matched, unmatched = match_sets(3, "pokemon", groups, sets)
        self.assertEqual(unmatched, [])
        self.assertEqual(matched, [SetMatch(3, 1102, "pokemon", "swsh12", "name-exact", 1.0)])

    def test_abbreviation_match_when_names_differ(self):
        groups = [group(1102, "SWSH12: Silver Tempest", "SIT", date(2022, 11, 11))]
        sets = [pset("swsh12", "Pokemon Silver Tempest Set", "SIT", date(2022, 11, 11))]
        matched, unmatched = match_sets(3, "pokemon", groups, sets)
        self.assertEqual(unmatched, [])
        self.assertEqual(matched[0].match_method, "abbreviation-exact")

    def test_name_similarity_within_date_tolerance(self):
        groups = [group(9001, "Silver Tempst", "", date(2022, 11, 11))]  # typo, no clean abbreviation match
        sets = [pset("swsh12", "Silver Tempest", "ZZZ", date(2022, 11, 20))]
        matched, unmatched = match_sets(3, "pokemon", groups, sets)
        self.assertEqual(unmatched, [])
        self.assertEqual(matched[0].match_method, "name-similarity")
        self.assertGreaterEqual(matched[0].score, 0.88)

    def test_similarity_rejected_outside_date_tolerance(self):
        groups = [group(9001, "Silver Tempst", "", date(2022, 11, 11))]
        sets = [pset("swsh12", "Silver Tempest", "ZZZ", date(2023, 6, 1))]
        matched, unmatched = match_sets(3, "pokemon", groups, sets)
        self.assertEqual(matched, [])
        self.assertEqual(unmatched, [SetUnmatched(3, 9001, "pokemon", "no-candidate")])

    def test_two_exact_name_candidates_is_ambiguous(self):
        groups = [group(1, "Base Set")]
        sets = [pset("a", "Base Set"), pset("b", "Base Set")]
        matched, unmatched = match_sets(3, "pokemon", groups, sets)
        self.assertEqual(matched, [])
        self.assertEqual(unmatched, [SetUnmatched(3, 1, "pokemon", "ambiguous")])

    def test_two_similarity_candidates_within_epsilon_is_ambiguous(self):
        groups = [group(1, "Crown Zenit")]
        sets = [pset("a", "Crown Zenith"), pset("b", "Crown Zenite")]
        matched, unmatched = match_sets(3, "pokemon", groups, sets)
        self.assertEqual(matched, [])
        self.assertEqual(unmatched, [SetUnmatched(3, 1, "pokemon", "ambiguous")])

    def test_no_candidate_is_unmatched(self):
        groups = [group(1, "Some Made Up Set Nobody Has")]
        sets = [pset("a", "Totally Different")]
        matched, unmatched = match_sets(3, "pokemon", groups, sets)
        self.assertEqual(matched, [])
        self.assertEqual(unmatched, [SetUnmatched(3, 1, "pokemon", "no-candidate")])


class MatchProductsTests(unittest.TestCase):
    def test_collector_number_match_ignores_leading_zeros(self):
        products = [product(5001, card_number="007", clean_name="Pikachu")]
        cards = [card("poke-1", number="7", name="Pikachu VMAX")]
        matched, unmatched = match_products(3, 1102, "pokemon", "swsh12", products, cards)
        self.assertEqual(unmatched, [])
        self.assertEqual(matched, [ProductMatch(3, 1102, 5001, "pokemon", "swsh12", "poke-1", "collector-number")])

    def test_falls_back_to_exact_name_when_no_number(self):
        products = [product(5002, card_number="", clean_name="Charizard")]
        cards = [card("poke-2", number="", name="Charizard")]
        matched, unmatched = match_products(3, 1102, "pokemon", "swsh12", products, cards)
        self.assertEqual(matched, [ProductMatch(3, 1102, 5002, "pokemon", "swsh12", "poke-2", "name-exact")])

    def test_ambiguous_number_is_unmatched(self):
        products = [product(5003, card_number="12", clean_name="Reprint")]
        cards = [card("a", number="12", name="Reprint A"), card("b", number="012", name="Reprint B")]
        matched, unmatched = match_products(3, 1102, "pokemon", "swsh12", products, cards)
        self.assertEqual(matched, [])
        self.assertEqual(unmatched, [ProductUnmatched(3, 1102, 5003, "pokemon", "ambiguous")])

    def test_no_candidate_is_unmatched(self):
        products = [product(5004, card_number="99", clean_name="Nobody Has This")]
        cards = [card("a", number="1", name="Something Else")]
        matched, unmatched = match_products(3, 1102, "pokemon", "swsh12", products, cards)
        self.assertEqual(matched, [])
        self.assertEqual(unmatched, [ProductUnmatched(3, 1102, 5004, "pokemon", "no-candidate")])

    def test_pokemon_slash_total_number_matches_bare_provider_number(self):
        # cat3 TCGCSV card_number '001/102' vs pokemontcg.io number '1'
        # (bridge coverage report real-world pair).
        products = [product(5005, card_number="001/102", clean_name="Bulbasaur")]
        cards = [card("poke-1", number="1", name="Bulbasaur")]
        matched, unmatched = match_products(3, 1102, "pokemon", "swsh12", products, cards)
        self.assertEqual(unmatched, [])
        self.assertEqual(matched, [ProductMatch(3, 1102, 5005, "pokemon", "swsh12", "poke-1", "collector-number")])

    def test_yugioh_region_infix_number_matches_tcgcsv_number(self):
        # cat2 TCGCSV 'PSV-088' vs ygoprodeck 'PSV-EN088' (region infix).
        products = [product(5006, card_number="PSV-088", clean_name="Pot of Greed")]
        cards = [card("ygo-1:PSV-EN088", number="PSV-EN088", name="Pot of Greed")]
        matched, unmatched = match_products(3, 1102, "ygoprodeck", "psv", products, cards)
        self.assertEqual(unmatched, [])
        self.assertEqual(matched, [ProductMatch(3, 1102, 5006, "ygoprodeck", "psv", "ygo-1:PSV-EN088", "collector-number")])

    def test_yugioh_region_infix_number_matches_across_years(self):
        # cat2 TCGCSV '2017-001' vs ygoprodeck '2017-EN001' (region infix,
        # year-style set code).
        products = [product(5007, card_number="2017-001", clean_name="Ash Blossom")]
        cards = [card("ygo-2:2017-EN001", number="2017-EN001", name="Ash Blossom & Joyous Spring")]
        matched, unmatched = match_products(3, 1102, "ygoprodeck", "2017", products, cards)
        self.assertEqual(unmatched, [])
        self.assertEqual(matched, [ProductMatch(3, 1102, 5007, "ygoprodeck", "2017", "ygo-2:2017-EN001", "collector-number")])

    def test_region_infix_normalization_collision_is_ambiguous(self):
        # Two distinct provider printings whose region infix differs
        # (EN/FR) but otherwise normalize onto the same canonical number
        # must NOT be guessed at -- fail closed as ambiguous, same rule as
        # any other collector-number collision.
        products = [product(5008, card_number="PSV-088", clean_name="Pot of Greed")]
        cards = [
            card("ygo-en:PSV-EN088", number="PSV-EN088", name="Pot of Greed"),
            card("ygo-fr:PSV-FR088", number="PSV-FR088", name="Pot of Greed"),
        ]
        matched, unmatched = match_products(3, 1102, "ygoprodeck", "psv", products, cards)
        self.assertEqual(matched, [])
        self.assertEqual(unmatched, [ProductUnmatched(3, 1102, 5008, "ygoprodeck", "ambiguous")])

    def test_dedupes_rarity_variant_rows_of_the_same_underlying_card(self):
        # ygoprodeck emits one row per card_sets rarity-variant printing --
        # N rows sharing the SAME underlying card id (identical
        # "<cardId>:<setCode>") must collapse to exactly one match
        # candidate, not be flagged ambiguous just because there are
        # multiple rows (bridge coverage report: 13,623/13,632 YGO
        # "ambiguous" products were this, not real collisions).
        products = [product(5009, card_number="LOB-001", clean_name="Blue-Eyes White Dragon")]
        cards = [
            card("89631139:LOB-001", number="LOB-001", name="Blue-Eyes White Dragon"),
            card("89631139:LOB-001", number="LOB-001", name="Blue-Eyes White Dragon"),
        ]
        matched, unmatched = match_products(3, 1102, "ygoprodeck", "lob", products, cards)
        self.assertEqual(unmatched, [])
        self.assertEqual(matched, [ProductMatch(3, 1102, 5009, "ygoprodeck", "lob", "89631139:LOB-001", "collector-number")])

    def test_distinct_underlying_cards_colliding_on_a_number_stay_ambiguous(self):
        # Two genuinely DIFFERENT cards (different cardId prefix) that
        # collide on the same canonical number must still fail closed --
        # dedupe only collapses rows of the SAME card, never merges
        # distinct ones.
        products = [product(5010, card_number="LOB-001", clean_name="Reprint Collision")]
        cards = [
            card("11111111:LOB-001", number="LOB-001", name="Reprint Collision"),
            card("22222222:LOB-001", number="LOB-001", name="Reprint Collision"),
        ]
        matched, unmatched = match_products(3, 1102, "ygoprodeck", "lob", products, cards)
        self.assertEqual(matched, [])
        self.assertEqual(unmatched, [ProductUnmatched(3, 1102, 5010, "ygoprodeck", "ambiguous")])

    def test_dedupe_is_a_harmless_no_op_for_pokemon_ids_without_colon(self):
        # pokemon/scryfall ids don't contain ":" -- the split-on-":" identity
        # key is just the id itself, so an accidental literal duplicate row
        # still dedupes (harmless no-op in the normal, non-duplicated case).
        products = [product(5011, card_number="7", clean_name="Pikachu")]
        cards = [card("poke-7", number="7", name="Pikachu"), card("poke-7", number="7", name="Pikachu")]
        matched, unmatched = match_products(3, 1102, "pokemon", "swsh12", products, cards)
        self.assertEqual(unmatched, [])
        self.assertEqual(matched, [ProductMatch(3, 1102, 5011, "pokemon", "swsh12", "poke-7", "collector-number")])


class SummarizeAndSerializeTests(unittest.TestCase):
    def test_summarize_match_rates_tallies_methods_and_reasons(self):
        set_matched = [SetMatch(3, 1, "pokemon", "a", "name-exact", 1.0), SetMatch(3, 2, "pokemon", "b", "name-similarity", 0.9)]
        set_unmatched = [SetUnmatched(3, 3, "pokemon", "ambiguous")]
        product_matched = [ProductMatch(3, 1, 10, "pokemon", "a", "x", "collector-number")]
        product_unmatched = [ProductUnmatched(3, 1, 11, "pokemon", "no-candidate")]
        rates = summarize_match_rates(set_matched, set_unmatched, product_matched, product_unmatched)
        self.assertEqual(rates.set_total, 3)
        self.assertEqual(rates.set_matched, 2)
        self.assertEqual(rates.set_by_method, {"name-exact": 1, "name-similarity": 1})
        self.assertEqual(rates.set_unmatched_by_reason, {"ambiguous": 1})
        self.assertEqual(rates.product_total, 2)
        self.assertEqual(rates.product_matched, 1)
        self.assertEqual(rates.product_by_method, {"collector-number": 1})
        self.assertEqual(rates.product_unmatched_by_reason, {"no-candidate": 1})

    def test_build_bridge_table_only_includes_matched_pairs_and_is_deterministic(self):
        set_matches = [SetMatch(3, 1102, "pokemon", "swsh12", "name-exact", 1.0)]
        product_matches = [
            ProductMatch(3, 1102, 5002, "pokemon", "swsh12", "poke-2", "name-exact"),
            ProductMatch(3, 1102, 5001, "pokemon", "swsh12", "poke-1", "collector-number"),
        ]
        payload = build_bridge_table(3, "pokemon", "2026-08-17", set_matches, product_matches)
        self.assertEqual(payload["categoryId"], 3)
        self.assertEqual(payload["provider"], "pokemon")
        self.assertEqual(payload["sets"], [{"groupId": 1102, "providerSetId": "swsh12", "matchMethod": "name-exact"}])
        # Deterministic ordering by (groupId, productId), not insertion order.
        self.assertEqual([row["productId"] for row in payload["products"]], [5001, 5002])
        self.assertIn("contentHash", payload)
        replay = build_bridge_table(3, "pokemon", "2026-08-17", set_matches, product_matches)
        self.assertEqual(payload["contentHash"], replay["contentHash"])


if __name__ == "__main__":
    unittest.main()
