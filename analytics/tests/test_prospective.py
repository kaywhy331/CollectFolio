from copy import deepcopy
from datetime import datetime, timedelta, timezone
import unittest
from uuid import UUID

from collectfolio_analytics.prospective import (
    CANONICAL_PROMOTION_POLICY,
    build_execution_challenge_request,
    build_scorecard_plan_request,
    build_scorecard_request,
    canonical_candidate_output_hash,
    canonical_cost_quote_hash,
    prepare_prospective_candidate,
    sign_execution_receipt,
)


UTC = timezone.utc
NOW = datetime(2026, 8, 13, 12, tzinfo=UTC)


def uid(value: int) -> str:
    return str(UUID(int=value))


def candidate(value: int = 1):
    core = {
        "trendSnapshotId": uid(value),
        "q10": 80,
        "q25": 90,
        "q50": 110,
        "q75": 125,
        "q90": 140,
        "probabilityUp": 0.7,
        "confidence": 61.5,
        "predictionStatus": "research_only",
        "reasonCodes": ["private_shadow"],
        "costQuote": {
            "status": "complete",
            "semantics": "provider_listing",
            "quoteMarketSeriesId": uid(100 + value),
            "termsReviewId": uid(200 + value),
            "externalQuoteId": f"listing-{value}",
            "observedAt": NOW.isoformat(),
            "evidenceHash": "a" * 64,
            "offerPrice": 75,
            "taxRate": 0.08,
            "buyShipping": 4,
            "sellFeeRate": 0.13,
            "sellFeeFixed": 0.3,
            "sellShipping": 5,
            "liquidityStatus": "source_backed",
            "liquidityHaircutRate": 0.1,
            "liquidityEvidenceHash": "b" * 64,
        },
    }
    return prepare_prospective_candidate(
        core,
        market_series_identity_hash=f"{value:064x}",
        baseline_prices={
            "no_change": 100,
            "damped_momentum": 105,
            "market_index": 103,
            "lifecycle_cohort": 107,
            "structural_convergence": 108,
        },
        probability_net_positive=0.74,
        structural_lower_price=95,
    )


class ProspectiveExecutionContractTests(unittest.TestCase):
    def test_candidate_normalizes_decimal_strings_and_commits_cost_quote(self):
        value = candidate()
        self.assertEqual(value["q50"], "110")
        self.assertEqual(value["costQuote"]["taxRate"], "0.08")
        self.assertEqual(value["costQuote"]["observedAt"], "2026-08-13T12:00:00.000000Z")
        self.assertTrue({
            "operator_model_review_required",
            "private_prospective_shadow",
            "public_forecast_disabled",
        }.issubset(value["reasonCodes"]))
        self.assertEqual(
            value["costQuoteHash"], canonical_cost_quote_hash(value["costQuote"]),
        )
        self.assertEqual(set(value["baselinePrices"]), {
            "no_change", "damped_momentum", "market_index",
            "lifecycle_cohort", "structural_convergence",
        })

    def test_output_hash_is_independent_of_array_order(self):
        first, second = candidate(1), candidate(2)
        self.assertEqual(
            canonical_candidate_output_hash([first, second]),
            canonical_candidate_output_hash([second, first]),
        )

    def test_any_forecast_or_cost_change_breaks_hash(self):
        original = candidate()
        changed_forecast = deepcopy(original)
        changed_forecast["q50"] = "111"
        self.assertNotEqual(
            canonical_candidate_output_hash([original]),
            canonical_candidate_output_hash([changed_forecast]),
        )
        changed_cost = deepcopy(original)
        changed_cost["costQuote"]["offerPrice"] = "76"
        with self.assertRaisesRegex(ValueError, "costQuoteHash"):
            canonical_candidate_output_hash([changed_cost])

    def test_hashes_canonicalize_zero_and_database_numeric_scale(self):
        numeric_zero = candidate()["costQuote"]
        string_zero = deepcopy(numeric_zero)
        for field in ("buyShipping", "sellFeeFixed", "sellShipping"):
            numeric_zero[field] = 0
            string_zero[field] = "0"
        self.assertEqual(
            canonical_cost_quote_hash(numeric_zero),
            canonical_cost_quote_hash(string_zero),
        )
        negative_zero = deepcopy(numeric_zero)
        for field in ("buyShipping", "sellFeeFixed", "sellShipping"):
            negative_zero[field] = "-0.0000"
        self.assertEqual(
            canonical_cost_quote_hash(numeric_zero),
            canonical_cost_quote_hash(negative_zero),
        )
        compact = candidate()
        padded = deepcopy(compact)
        padded["q50"] = "110.0000"
        self.assertEqual(
            canonical_candidate_output_hash([compact]),
            canonical_candidate_output_hash([padded]),
        )
        self.assertEqual(
            canonical_cost_quote_hash({
                "status": "unavailable", "semantics": "unavailable",
                "unavailableReason": "  no provider quote  ",
            }),
            canonical_cost_quote_hash({
                "status": "unavailable", "semantics": "unavailable",
                "liquidityStatus": "unavailable",
                "unavailableReason": "no provider quote",
            }),
        )

    def test_candidate_rejects_precision_the_database_would_round(self):
        value = candidate()
        core = {key: deepcopy(item) for key, item in value.items() if key not in {
            "marketSeriesIdentityHash", "baselinePrices", "probabilityNetPositive",
            "structuralLowerPrice", "costQuoteHash",
        }}
        core["q50"] = "110.00001"
        with self.assertRaisesRegex(ValueError, "more than 4 decimal places"):
            prepare_prospective_candidate(
                core,
                market_series_identity_hash="1" * 64,
                baseline_prices={name: 100 for name in (
                    "no_change", "damped_momentum", "market_index",
                    "lifecycle_cohort", "structural_convergence",
                )},
                probability_net_positive=0.7,
                structural_lower_price=90,
            )

    def test_duplicate_snapshots_and_missing_baselines_fail(self):
        value = candidate()
        with self.assertRaisesRegex(ValueError, "unique"):
            canonical_candidate_output_hash([value, value])
        core = {key: deepcopy(item) for key, item in value.items() if key not in {
            "marketSeriesIdentityHash", "baselinePrices", "probabilityNetPositive",
            "structuralLowerPrice", "costQuoteHash",
        }}
        with self.assertRaisesRegex(ValueError, "five required"):
            prepare_prospective_candidate(
                core,
                market_series_identity_hash="1" * 64,
                baseline_prices={"no_change": 100},
                probability_net_positive=None,
                structural_lower_price=None,
            )

    def test_hmac_receipt_binds_challenge_output_and_raw_times(self):
        value = candidate()
        challenge = {
            "challengeId": uid(50),
            "challengeHash": "1" * 64,
            "nonce": "2" * 64,
            "expectedInputHash": "3" * 64,
            "expectedInputCount": 1,
            "modelArtifactHash": "4" * 64,
            "executorBuildHash": "5" * 64,
            "runtimeHash": "6" * 64,
        }
        receipt, output_hash = sign_execution_receipt(
            b"secret" * 8,
            challenge,
            [value],
            execution_started_at=NOW,
            execution_completed_at=NOW + timedelta(seconds=5),
        )
        self.assertEqual(len(receipt["signature"]), 64)
        self.assertEqual(receipt["executionStartedAt"], "2026-08-13T12:00:00.000000Z")
        self.assertEqual(receipt["executionCompletedAt"], "2026-08-13T12:00:05.000000Z")
        self.assertEqual(output_hash, canonical_candidate_output_hash([value]))
        changed = deepcopy(value)
        changed["probabilityNetPositive"] = "0.75"
        changed_receipt, changed_hash = sign_execution_receipt(
            b"secret" * 8,
            challenge,
            [changed],
            execution_started_at=NOW,
            execution_completed_at=NOW + timedelta(seconds=5),
        )
        self.assertNotEqual(output_hash, changed_hash)
        self.assertNotEqual(receipt["signature"], changed_receipt["signature"])

    def test_rpc_requests_expose_only_guarded_identifiers(self):
        challenge = build_execution_challenge_request(uid(1), uid(2), uid(3))
        scorecard = build_scorecard_request(uid(1), uid(4))
        self.assertEqual(set(challenge), {
            "scorecardPlanId", "forecastAnalyticsRunId", "trendAnalyticsRunId",
        })
        self.assertEqual(set(scorecard), {
            "scorecardPlanId", "evaluationAnalyticsRunId",
        })

    def test_plan_request_uses_canonical_policy_and_future_scope(self):
        selection = {
            "version": "pokemon-nm-v1",
            "cohortKey": "pokemon-en-raw-nm",
            "game": "pokemon",
            "sourceId": uid(9),
            "currency": "USD",
            "language": "en",
            "conditionClass": "raw",
            "marketCondition": "near-mint",
            "priceSemantics": "market",
            "finishes": ["normal", "holofoil"],
            "minimumEvidenceQuality": 0.55,
            "purpose": "forecast_validation",
            "maximumFeatureAgeHours": 24,
            "maximumQuoteAgeHours": 24,
        }
        plan = build_scorecard_plan_request(
            model_version_id=uid(7),
            executor_key_id=uid(8),
            horizon_days=30,
            source_id=uid(9),
            universe_purpose="forecast_validation",
            origin_schedule=[
                NOW + timedelta(days=1 + 22 * index) for index in range(6)
            ],
            selection_policy=selection,
        )
        self.assertEqual(plan["promotionPolicy"], dict(CANONICAL_PROMOTION_POLICY))
        self.assertEqual(plan["originStart"], "2026-08-14T12:00:00.000000Z")
        self.assertEqual(plan["originEnd"], "2026-12-03T12:00:00.000000Z")
        self.assertEqual(len(plan["originSchedule"]), 6)

    def test_plan_request_rejects_cherry_pickable_origin_schedule(self):
        selection = {
            "version": "pokemon-nm-v1", "cohortKey": "pokemon-en-raw-nm",
            "game": "pokemon", "sourceId": uid(9), "currency": "USD",
            "language": "en", "conditionClass": "raw",
            "marketCondition": "near-mint", "priceSemantics": "market",
            "finishes": ["normal"], "minimumEvidenceQuality": 0.55,
            "purpose": "forecast_validation", "maximumFeatureAgeHours": 24,
            "maximumQuoteAgeHours": 24,
        }
        with self.assertRaisesRegex(ValueError, "21 full days"):
            build_scorecard_plan_request(
                model_version_id=uid(7), executor_key_id=uid(8), horizon_days=30,
                source_id=uid(9), universe_purpose="forecast_validation",
                origin_schedule=[NOW + timedelta(days=index) for index in range(6)],
                selection_policy=selection,
            )


if __name__ == "__main__":
    unittest.main()
