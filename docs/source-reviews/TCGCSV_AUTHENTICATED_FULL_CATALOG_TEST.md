# TCGCSV authenticated full-catalog integration test

**Review ID:** `386a917b-85b5-4028-8fef-d873c2d39988`
**Decision date:** August 16, 2026
**Decision:** `authenticated_private_integration_test`
**Next review:** September 14, 2026

## Test boundary

This review adds a narrow personal-integration test entitlement to the existing
private rolling-cohort decision. It permits the complete current TCGCSV cohort
to be transformed deterministically into bounded, range-readable R2 objects
and served to a signed-in CollectFolio user. It does not enable an anonymous
object endpoint, a bulk source download, commercial use, sublicensing, or
redistribution.

The user represented the source as open source and asked to test the complete
catalog before seeking any additional license needed for broader use. The
upstream repository did not expose a formal `LICENSE` file during the prior
review. That mismatch remains unresolved and is why this entitlement is
limited to authenticated personal testing. It is an engineering control, not
legal advice or a conclusion about TCGplayer rights.

## Complete cohort contract

The test publication must retain all valid rows from one sealed source build:

- all categories and groups, including groups with no products;
- all products, including products with no current price;
- every finish-specific price series;
- `lowPrice`, `midPrice`, `highPrice`, `marketPrice`, and `directLowPrice`;
- product/group/category hashes and extended product metadata.

The current display value is selected without inference in this order:
`marketPrice`, `midPrice`, `lowPrice`, `directLowPrice`, then `highPrice`.
Every finish remains separately selectable, and a missing price remains
unavailable rather than becoming zero or borrowing another finish's value.

## Access and publication controls

1. The R2 bucket remains private. Source packets and Parquet files have no
   browser route.
2. Publication uploads use the coordinator secret and a conditional lease.
3. `manifest.json` is SHA-256 addressed. All listed object byte counts, hashes,
   ranges, source timestamp, and run identity are verified before promotion.
4. One conditional pointer promotes a complete publication atomically and
   retains current plus previous. The hourly cron removes older publications.
5. Catalog APIs validate a Supabase bearer session and a configured private-test
   entitlement. Anonymous requests fail closed.
6. Browser responses are paginated. Product groups and search pages are read
   from exact R2 byte ranges; the 452 MB source packet is never sent to the app.
7. The app marks these values with
   `pricingEntitlement=authenticated-private-test`. The normal rights-aware
   pricing policy rejects the same source without that explicit entitlement.

## Automation and determinism

The hourly workflow still keys idempotency to TCGCSV's exact source-build
timestamp, not a calendar date. If the sealed cohort is current but its web
publication is absent, the workflow rebuilds from the already sealed catalog
packet and Parquet artifact without recollecting TCGCSV. If both are current,
it exits without a download or import.

No LLM, generative model, embedding model, fuzzy mapping, or AI inference is
used. Acquisition, mapping, price selection, sharding, hashing, promotion, and
cleanup are deterministic. Network timing and retry count may vary; accepted
publication bytes do not.

## Promotion blockers

Public or commercial availability remains blocked until source rights are
independently verified in writing and a new review explicitly removes the
authenticated personal-test boundary. Removing authentication, enabling a
public R2 domain, or republishing raw artifacts requires a separate decision.
