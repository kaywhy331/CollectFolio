from datetime import date
import unittest

from collectfolio_analytics.catalog_mapping import (
    ApprovedMapping,
    CanonicalCard,
    CanonicalSet,
    CanonicalVariant,
    ExternalProduct,
    build_catalog_ingestion_packet,
    build_mapping_batch,
    map_external_product,
)


SOURCE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"


def catalog():
    canonical_set = CanonicalSet.build(
        game="Pokemon",
        language="EN",
        set_code="sv08",
        name="Surging Sparks",
        series="Scarlet & Violet",
        release_date=date(2024, 11, 8),
    )
    card = CanonicalCard.build(canonical_set, name="Pikachu ex", number="238/191", rarity="SIR")
    normal = CanonicalVariant.build(card, finish="holofoil")
    reverse = CanonicalVariant.build(card, finish="reverse-holofoil")
    return canonical_set, card, (normal, reverse)


def product(canonical_set, **overrides):
    values = {
        "source_id": SOURCE_ID,
        "external_product_id": "product-238",
        "external_variant_key": "holofoil",
        "game": "pokemon",
        "language": "en",
        "canonical_set_key": canonical_set.canonical_key,
        "name": "Pikachu ex",
        "number": "238/191",
        "edition": "standard",
        "finish": "holofoil",
        "variant_name": "",
        "condition_class": "raw",
        "market_condition": "near-mint",
    }
    values.update(overrides)
    return ExternalProduct(**values)


class CatalogMappingTests(unittest.TestCase):
    def test_canonical_ids_are_deterministic_and_finish_specific(self):
        canonical_set, card, variants = catalog()
        repeated_set, repeated_card, repeated_variants = catalog()
        self.assertEqual(canonical_set.id, repeated_set.id)
        self.assertEqual(card.id, repeated_card.id)
        self.assertEqual(variants[0].id, repeated_variants[0].id)
        self.assertNotEqual(variants[0].id, variants[1].id)
        self.assertEqual(variants[0].database_row()["raw_condition_class"], "raw")

    def test_new_exact_identity_is_candidate_not_automatic_approval(self):
        canonical_set, _, variants = catalog()
        candidate = map_external_product(
            product(canonical_set), variants, mapping_version="mapping-v1"
        )[0]
        self.assertEqual(candidate.proposed_variant_id, variants[0].id)
        self.assertEqual(candidate.confidence, 0.99)
        self.assertEqual(candidate.disposition, "exact")
        self.assertIn("initial_mapping_review_required", candidate.reason_codes)
        self.assertEqual(candidate.evidence["marketCondition"], "near-mint")

    def test_previously_approved_external_identity_is_reused_at_one(self):
        canonical_set, _, variants = catalog()
        external = product(canonical_set)
        approved = ApprovedMapping(
            SOURCE_ID,
            external.external_product_id,
            external.external_variant_key,
            variants[0].id,
            "approved-v3",
        )
        candidate = map_external_product(
            external, variants, approved_mappings=[approved], mapping_version="mapping-v4"
        )[0]
        self.assertEqual(candidate.confidence, 1)
        self.assertEqual(candidate.method, "approved_external_id")
        self.assertEqual(candidate.mapping_version, "approved-v3")

    def test_name_mismatch_is_quarantined_even_when_set_and_number_match(self):
        canonical_set, _, variants = catalog()
        candidates = map_external_product(
            product(canonical_set, name="Not Pikachu"), variants, mapping_version="mapping-v1"
        )
        self.assertTrue(candidates)
        self.assertTrue(all(candidate.disposition == "quarantined" for candidate in candidates))
        self.assertTrue(all("name_mismatch" in candidate.reason_codes for candidate in candidates))

    def test_missing_finish_never_attaches(self):
        canonical_set, _, variants = catalog()
        candidate = map_external_product(
            product(canonical_set, finish=""), variants, mapping_version="mapping-v1"
        )[0]
        self.assertIsNone(candidate.proposed_variant_id)
        self.assertEqual(candidate.disposition, "unmapped")
        self.assertIn("missing_finish", candidate.reason_codes)

    def test_finish_mismatch_is_quarantined_with_review_evidence(self):
        canonical_set, _, variants = catalog()
        candidates = map_external_product(
            product(canonical_set, finish="etched"), variants, mapping_version="mapping-v1"
        )
        self.assertEqual(len(candidates), 2)
        self.assertTrue(all(candidate.disposition == "quarantined" for candidate in candidates))
        self.assertTrue(all(candidate.confidence == 0.80 for candidate in candidates))

    def test_conflicting_duplicate_external_id_is_quarantined(self):
        canonical_set, _, variants = catalog()
        batch = build_mapping_batch(
            [product(canonical_set), product(canonical_set, name="Conflicting name")],
            variants,
            mapping_version="mapping-v1",
        )
        self.assertEqual(batch.product_count, 2)
        self.assertEqual(batch.duplicate_product_count, 1)
        self.assertEqual(batch.disposition_counts["quarantined"], 2)
        self.assertTrue(all(candidate.proposed_variant_id is None for candidate in batch.candidates))

    def test_candidate_hash_and_database_packet_are_reproducible(self):
        canonical_set, _, variants = catalog()
        first = map_external_product(product(canonical_set), variants, mapping_version="mapping-v1")[0]
        second = map_external_product(product(canonical_set), variants, mapping_version="mapping-v1")[0]
        self.assertEqual(first.candidate_hash, second.candidate_hash)
        row = first.database_row(
            "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        )
        self.assertEqual(row["candidate_hash"], first.candidate_hash)
        self.assertEqual(row["mapping_confidence"], 0.99)

    def test_catalog_ingestion_packet_deduplicates_parents_and_hashes_content(self):
        canonical_set, _, variants = catalog()
        first = build_catalog_ingestion_packet(
            variants,
            [product(canonical_set)],
            ingestion_run_id="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            terms_review_id="cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            mapping_version="mapping-v1",
        )
        second = build_catalog_ingestion_packet(
            variants,
            [product(canonical_set)],
            ingestion_run_id="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            terms_review_id="cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            mapping_version="mapping-v1",
        )
        self.assertEqual(len(first.catalog_sets), 1)
        self.assertEqual(len(first.catalog_cards), 1)
        self.assertEqual(len(first.catalog_variants), 2)
        self.assertEqual(len(first.mapping_candidates), 1)
        self.assertEqual(first.dataset_hash, second.dataset_hash)

    def test_ingestion_packet_rejects_mixed_sources(self):
        canonical_set, _, variants = catalog()
        with self.assertRaisesRegex(ValueError, "mix source"):
            build_catalog_ingestion_packet(
                variants,
                [
                    product(canonical_set),
                    product(
                        canonical_set,
                        source_id="dddddddd-dddd-4ddd-8ddd-dddddddddddd",
                        external_product_id="different",
                    ),
                ],
                ingestion_run_id="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                terms_review_id="cccccccc-cccc-4ccc-8ccc-cccccccccccc",
                mapping_version="mapping-v1",
            )


if __name__ == "__main__":
    unittest.main()
