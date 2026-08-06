# Production price-source decision

**Decision date:** August 5, 2026  
**Outcome:** adopt JustTCG's paid API as the preferred production path, subject to subscription and source-review activation gates  
**Public status:** disabled

## Decision

There is a viable way to supply CollectFolio with current Pokémon prices and enough history for trend and forecast research: license a paid JustTCG tier and ingest it server-side. JustTCG's current terms expressly permit paid subscribers to display current prices, historical trends, and percentage changes to end users; calculate and display derived metrics and aggregate valuations; cache responses server-side; and retain app-bound price points while the subscription remains active. Its April 15, 2026 changelog adds a trailing one-year daily `priceHistory` window.

The recommended starting tier is **Starter at $19/month plus tax**. The published limit is 10,000 requests per month, 1,000 per day, 50 per minute, and up to 100 cards per batch. A daily refresh of 10,000 active variants is about 3,000 batch requests per month before retries and onboarding work, so Starter leaves material headroom for the initial cohort. Professional is $49/month for 50,000 monthly requests; Enterprise is advertised at $149/month for 500,000 requests.

This is a licensing route, not an immediate go-live approval. CollectFolio has not created a paid account, accepted provider terms for the operating entity, stored an API secret, or activated an approved immutable source review. Until those actions occur, the source stays pending and `public_price_intelligence` stays false.

## Capability fit

| Requirement | JustTCG paid API | CollectFolio treatment |
|---|---|---|
| Current observed price | Condition- and printing-specific USD market price | Tier 1 observed market value |
| Historical series | Daily points for 7/30/90/180 days and 1 year | Backfill once, then retain daily snapshots while subscribed |
| Market semantics | Provider describes volume-weighted observed online activity plus verified store sales | Label as aggregated market observation, never a guaranteed executable quote |
| Completed-sale comps | No itemized transaction/comparable-sale feed in the reviewed API contract | Do not claim individual sold comps or marketplace-level provenance |
| Public display | Explicitly permitted on paid tiers | Rights flag may be true only under an active paid plan and current approved review |
| Derived trends/valuation | Explicitly permitted on paid tiers | Eligible for trends and derived analytics after the independent publication gates |
| Predictive use | Provider markets the data for analysis/ML and permits derived analytics, while prohibiting a substitute pricing API/data feed | Forecasts may support CollectFolio's portfolio product; never expose raw bulk data or an API substitute, and re-review if product scope changes |
| Storage | No maximum retention while subscribed, but purpose-bound to the app; service use ends with the license | Store only private observations and app publications; no user bulk export of provider data |
| Attribution | Appreciated, not required on paid tiers | Use “Market data provided by JustTCG” anyway for transparency |
| Secret handling | `X-API-Key` header | GitHub Actions/Supabase server-side secret only; never browser runtime config |

## Alternatives reviewed

| Source | Price/history capability | Rights/access finding | Decision |
|---|---|---|---|
| CollectFolio user records | Purchase price, manual value, and locally accumulated portfolio history | First-party and private by default; not an external market observation | Keep as the free fallback and user override |
| Pokémon TCG API | Catalog plus embedded TCGplayer/Cardmarket price fields; no owned market-history license identified | Documentation says the fields are provided by those downstream marketplaces; no direct commercial redistribution/derivative grant was identified | Metadata only; embedded market fields are excluded |
| TCGCSV | Strong current and historical TCGplayer-derived archive | TCGplayer terms prohibit third-party acquisition, combination, rebranding, commercial distribution, and derivatives absent approval | Research only under the existing bounded review |
| TCGplayer direct | Current marketplace pricing and exact product IDs | Access is discretionary and approved-purpose-specific; competitive, combined, derivative, and commercial distribution uses require prior written consent | Pursue only as a separately negotiated alternative |
| PriceCharting | Paid current-price API and daily bulk CSV; Pokémon coverage | Terms allow internal use with subscription, but third-party software/public sharing needs express written permission | Viable only after a separate written redistribution/model agreement |
| Cardmarket | European marketplace/price-guide data | Cardmarket states it is not accepting new API applications; current credentials may not be shared with third-party software | Not currently obtainable for CollectFolio |
| eBay | Browse API exposes active listings; Marketplace Insights is the relevant sold-data surface | Active asks are not realized prices; sold-data access and API use require separate eBay eligibility/compliance review | Secondary validation source only after written approval; not the primary price |

## Integration architecture

```text
JustTCG paid API
        |
        | X-API-Key (server secret)
        v
scheduled bounded ingest --> private source/mapping/observation ledgers
                                   |
                                   v
                           trend / model evidence
                                   |
                         operator + rights gates
                                   v
                    narrow public publication table
                                   |
                                   v
                              PWA browser
```

The checked-in `justtcg.py` adapter already enforces the technical half of this contract:

- fixed `https://api.justtcg.com/v1/cards` origin;
- header-only API key and bounded response size;
- exact stable card and variant UUIDs;
- explicit Near Mint/printing filtering;
- supported history windows capped at one year;
- future/duplicate timestamp rejection;
- paid-subscription attestation plus current approved catalog/raw/derived rights; and
- conservative `available_at=retrieved_at` for an initial backfill, preventing retrospective leakage.

## Activation checklist

1. Subscribe the operating entity to a paid JustTCG plan and retain the invoice/account evidence.
2. Archive the exact accepted terms and commercial-use guidance; hash the archived artifact, not a live page.
3. Independently record a new immutable `approved` source review with a short expiry and the exact capabilities used.
4. Keep the source inactive until migration 0006 has a restorable backup, rehearsal, application, and post-apply ACL/RLS verification.
5. Store `JUSTTCG_API_KEY` only in the controlled scheduled-ingest environment.
6. Onboard a small English, raw, Near Mint Pokémon cohort; review every stable card/variant mapping.
7. Rehearse the one-year backfill transaction. Treat all imported history as first available at the real retrieval instant.
8. Begin daily prospective snapshots and source-health monitoring.
9. Qualify Tier 1 observed values and Tier 2 trends before any public publication.
10. Require fresh multi-card walk-forward/prospective evidence, all five baselines, calibration, and independent human review before fair value or forecasts.

## Primary evidence

- JustTCG Terms of Service, last updated July 27, 2026: <https://justtcg.com/terms>
- JustTCG commercial-use guidance: <https://justtcg.com/docs/commercial-use>
- JustTCG pricing and limits: <https://justtcg.com/pricing> and <https://justtcg.com/docs/rate-limits>
- JustTCG cards/variant schemas: <https://justtcg.com/docs/api/cards> and <https://justtcg.com/docs/schema/variant>
- JustTCG one-year history changelog: <https://justtcg.com/docs/changelog>
- TCGplayer API Terms: <https://help.tcgplayer.com/hc/en-us/articles/360061115874-TCGplayer-API-Terms-Conditions>
- Pokémon TCG API card object: <https://docs.pokemontcg.io/api-reference/cards/card-object/>
- PriceCharting API and terms: <https://www.pricecharting.com/api-documentation> and <https://www.pricecharting.com/page/terms-of-service>
- Cardmarket API access notice: <https://help.cardmarket.com/en/cardmarket-api>
- eBay Browse and Marketplace Insights documentation: <https://developer.ebay.com/api-docs/buy/browse/overview.html> and <https://developer.ebay.com/api-docs/buy/marketplace-insights/overview.html>

This engineering review is not legal advice. The database approval must reflect the operating entity's actual subscription and accepted contract at activation time.
