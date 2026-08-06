# JustTCG source review — production candidate

**Decision date:** August 5, 2026  
**Registry decision:** `pending`  
**Engineering recommendation:** approve only after a paid subscription and independent activation review  
**Next review:** September 4, 2026, or immediately upon a terms/plan change

## Scope

The reviewed paid-tier contract appears suitable for condition-specific current prices, one-year daily history, public end-user display, and derived analytics inside CollectFolio. This document does **not** activate the source or assert that CollectFolio currently holds the license. Free-tier use is personal and non-commercial and is not permitted for the production product.

## Evidence reviewed

- Terms of Service, shown as last updated July 27, 2026: <https://justtcg.com/terms>
- Commercial use guidelines: <https://justtcg.com/docs/commercial-use>
- Published plans and request limits: <https://justtcg.com/pricing> and <https://justtcg.com/docs/rate-limits>
- Card and variant API contracts: <https://justtcg.com/docs/api/cards>, <https://justtcg.com/docs/schema/card>, and <https://justtcg.com/docs/schema/variant>
- Identifier stability guidance: <https://justtcg.com/docs/identifiers>
- April 15, 2026 one-year history entry: <https://justtcg.com/docs/changelog>

For reproducibility, the substantive visible text retrieved on August 5, 2026 produced these SHA-256 fingerprints after scripts/styles/tags and blank lines were removed:

| Page | Review fingerprint |
|---|---|
| Terms | `68412f94e93b478b93f0ca70510b927d20f70dba18636bfa49c2bf42286cdd94` |
| Commercial guidance | `3153ab659137f056a2870e8e2eb8dc139c24bd5e7fefc0919539b5102c11f0a2` |
| Pricing | `cf77d2044a57a479f69b7923440bc3537868b6b932ef96f43600aa8c8cdb0ae8` |
| Cards API | `47709fe63a7886e4e04b6f59a9e24649c477efba7152d0252ee0f2efb9c25dc0` |
| Variant schema | `2491119efb43daec61f55ba134dabc340f284882cff258b17f5394702a548118` |

These are review aids, not the future database `document_hash`. Activation must archive the exact contract accepted by the operating entity and hash that immutable artifact.

## Capability decision

| Capability | Contract supports on paid tier | Activated now |
|---|---:|---:|
| Server-side catalog lookup/mapping | Yes | No |
| Current price ingestion | Yes | No |
| One-year historical-price ingestion | Yes | No |
| Public raw-price display inside CollectFolio | Yes | No |
| Public trends/derived metrics/aggregate valuations | Yes | No |
| App-bound server storage while subscribed | Yes | No |
| Raw feed, bulk dataset export, sublicensing, or proxy API | No | No |
| Pricing API/substitute product | No | No |
| Attribution | Appreciated, not required | Use voluntarily if activated |

## Interpretation for forecasts

The paid terms permit derived metrics and market observations, while the provider's product guidance describes analysis, prediction tooling, and ML use. The prohibition is on redistributing raw data or building a substitute pricing API/feed. CollectFolio may use licensed observations as inputs to its own portfolio analytics only while it remains an application, not a data-distribution substitute. A material change—such as bulk downloads, customer API access, resale of data, or a standalone pricing feed—requires a fresh written provider decision.

## Mandatory activation controls

- Maintain an active paid subscription. The adapter requires an explicit `paid_subscription_active=true` attestation; the free key cannot satisfy production gating.
- Create a new immutable source review only after subscription evidence and the accepted contract are archived.
- Use source code `justtcg`, set a short expiry/review cadence, and enable only the capabilities independently verified at that time.
- Keep the API key in a controlled server/scheduled-job secret. It must never enter browser JavaScript, runtime config, logs, fixtures, packets, or repository files.
- Use stable provider card/variant UUIDs. Every initial condition/printing mapping remains operator-reviewed.
- Restrict the first cohort to explicit language, raw condition, and printing semantics; do not silently translate provider aliases.
- Store raw observations only in private service-role ledgers. Public clients receive the narrow publication contract, never provider payloads.
- Do not offer bulk export or a proxied query surface.
- On cancellation, expiry, revocation, or material terms change, deactivate the source and disable dependent reads. Accumulated provider data cannot continue powering a third-party service after the paid license ends.
- Preserve `public_price_intelligence=false` until database, mapping, data-quality, model, and independent human gates all pass.

The candidate is intentionally `pending`: code readiness and favorable public terms are not substitutes for an active paid license or an operator's immutable approval record.
