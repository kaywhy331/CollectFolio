import unittest
from datetime import datetime, timezone

from collectfolio_analytics.sealed import SealedPriceObservation, SealedProduct, build_sealed_packet

SET_ID = "123e4567-e89b-42d3-a456-426614174000"
NOW = datetime(2026, 8, 7, 12, 0, tzinfo=timezone.utc)


def product(**overrides):
    values = dict(set_id=SET_ID, product_type="booster_box", name="Booster Box", packs_per_product=36)
    values.update(overrides)
    return SealedProduct(**values)


def observation(**overrides):
    values = dict(product=product(), source_id="src-1", market_price=144.0, observed_at=NOW, available_at=NOW, msrp=161.64)
    values.update(overrides)
    return SealedPriceObservation(**values)


class SealedTests(unittest.TestCase):
    def test_unit_pack_price_is_always_derived(self):
        self.assertAlmostEqual(observation().unit_pack_price, 4.0)
        row = observation().database_row()
        self.assertAlmostEqual(row["unit_pack_price"], 4.0)

    def test_product_identity_is_deterministic(self):
        self.assertEqual(product().id, product().id)
        self.assertNotEqual(product().id, product(product_type="elite_trainer_box").id)

    def test_invalid_product_type_and_pack_count_are_refused(self):
        with self.assertRaisesRegex(ValueError, "product_type"):
            product(product_type="mystery_crate")
        with self.assertRaisesRegex(ValueError, "packs_per_product"):
            product(packs_per_product=0)

    def test_availability_cannot_precede_observation(self):
        with self.assertRaisesRegex(ValueError, "available_at cannot precede"):
            observation(available_at=datetime(2026, 8, 6, tzinfo=timezone.utc))

    def test_packet_is_deterministic_review_gated_and_duplicate_safe(self):
        first = build_sealed_packet([observation()], generated_at=NOW)
        second = build_sealed_packet([observation()], generated_at=NOW)
        self.assertEqual(first["packet_hash"], second["packet_hash"])
        self.assertTrue(first["review_required"])
        self.assertEqual(first["public_display_candidates"], [])
        self.assertEqual(first["counts"], {"products": 1, "snapshots": 1})
        with self.assertRaisesRegex(ValueError, "must not repeat"):
            build_sealed_packet([observation(), observation()], generated_at=NOW)


if __name__ == "__main__":
    unittest.main()
