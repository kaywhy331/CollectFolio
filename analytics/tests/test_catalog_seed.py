import unittest
from datetime import datetime, timezone

from collectfolio_analytics.catalog_seed import (
    CatalogSeedRights,
    build_catalog_seed_packet,
    parse_cards,
    parse_set,
)

RIGHTS = dict(
    source_code="pokemon_tcg_data",
    terms_url="https://example.test/terms",
    review_decision="research_only",
    catalog_metadata_allowed=True,
    reviewed_at="2026-08-07T00:00:00Z",
    document_hash="abc123",
)
GENERATED_AT = datetime(2026, 8, 7, 12, 0, tzinfo=timezone.utc)
SET_PAYLOAD = {"id": "sv3", "name": "Obsidian Flames", "series": "Scarlet & Violet", "releaseDate": "2023/08/11"}
CARDS = [
    {"name": "Charizard ex", "number": "223", "rarity": "Special Illustration Rare", "artist": "5ban Graphics"},
    {"name": "Pidgey", "number": "16", "rarity": "Common"},
]


class RightsGateTests(unittest.TestCase):
    def test_pending_review_is_refused(self):
        with self.assertRaisesRegex(ValueError, "pending or\\s+rejected"):
            CatalogSeedRights(**{**RIGHTS, "review_decision": "pending"})

    def test_catalog_metadata_permission_must_be_explicitly_true(self):
        with self.assertRaisesRegex(ValueError, "explicitly true"):
            CatalogSeedRights(**{**RIGHTS, "catalog_metadata_allowed": False})

    def test_document_hash_is_required(self):
        with self.assertRaisesRegex(ValueError, "document_hash"):
            CatalogSeedRights(**{**RIGHTS, "document_hash": ""})


class ParseTests(unittest.TestCase):
    def test_set_and_cards_produce_deterministic_canonical_ids(self):
        first = parse_set(SET_PAYLOAD)
        second = parse_set(dict(SET_PAYLOAD))
        self.assertEqual(first.id, second.id)
        cards = parse_cards(first, CARDS)
        self.assertEqual(cards[0].id, parse_cards(second, CARDS)[0].id)
        self.assertEqual(first.release_date.isoformat(), "2023-08-11")

    def test_duplicate_cards_are_rejected(self):
        canonical_set = parse_set(SET_PAYLOAD)
        with self.assertRaisesRegex(ValueError, "duplicate card identity"):
            parse_cards(canonical_set, [CARDS[0], dict(CARDS[0])])

    def test_missing_required_fields_fail_closed(self):
        canonical_set = parse_set(SET_PAYLOAD)
        with self.assertRaisesRegex(ValueError, "missing required field 'number'"):
            parse_cards(canonical_set, [{"name": "Nameless"}])


class PacketTests(unittest.TestCase):
    def build(self):
        return build_catalog_seed_packet(
            CatalogSeedRights(**RIGHTS), [SET_PAYLOAD], {"sv3": CARDS}, generated_at=GENERATED_AT
        )

    def test_packet_is_deterministic_and_review_gated(self):
        first = self.build()
        second = self.build()
        self.assertEqual(first["packet_hash"], second["packet_hash"])
        self.assertEqual(first["mode"], "research_only_catalog_seed")
        self.assertTrue(first["review_required"])
        self.assertEqual(first["public_display_candidates"], [])
        self.assertEqual(first["counts"], {"sets": 1, "cards": 2, "variants": 2})

    def test_every_card_gets_exactly_one_unspecified_placeholder_variant(self):
        packet = self.build()
        variants = packet["rows"]["catalog_variants"]
        self.assertEqual(len(variants), 2)
        self.assertTrue(all(row["finish"] == "unspecified" for row in variants))
        card_ids = {row["id"] for row in packet["rows"]["catalog_cards"]}
        self.assertEqual({row["card_id"] for row in variants}, card_ids)

    def test_packet_carries_no_image_references(self):
        import json
        text = json.dumps(self.build())
        self.assertNotIn("images", text)
        self.assertNotIn("image_url", text)

    def test_missing_cards_payload_for_declared_set_is_refused(self):
        with self.assertRaisesRegex(ValueError, "cards payload for set 'sv3' is missing"):
            build_catalog_seed_packet(
                CatalogSeedRights(**RIGHTS), [SET_PAYLOAD], {}, generated_at=GENERATED_AT
            )

    def test_naive_generation_time_is_refused(self):
        with self.assertRaisesRegex(ValueError, "timezone-aware"):
            build_catalog_seed_packet(
                CatalogSeedRights(**RIGHTS), [SET_PAYLOAD], {"sv3": CARDS},
                generated_at=datetime(2026, 8, 7, 12, 0),
            )


if __name__ == "__main__":
    unittest.main()
