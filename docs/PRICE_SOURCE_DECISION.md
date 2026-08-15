# Production price-source decision

**Decision date:** August 5, 2026

**Challenger review:** August 13, 2026

**MTG addendum:** August 15, 2026

**Outcome:** retain daily TCGCSV as the complete private broad-market history backbone, adopt JustTCG's paid API as the preferred Pokémon production path, and use Cardbase as a targeted continuous MTG overlay, each subject to its own activation gates

**Public status:** disabled

## Decision

There is a viable way to supply CollectFolio with current Pokémon prices and enough history for trend and forecast research: license a paid JustTCG tier and ingest it server-side. JustTCG's current terms expressly permit paid subscribers to display current prices, historical trends, and percentage changes to end users; calculate and display derived metrics and aggregate valuations; cache responses server-side; and retain app-bound price points while the subscription remains active. Its April 15, 2026 changelog adds a trailing one-year daily `priceHistory` window.

The recommended starting tier is **Starter at $19/month plus tax**. The published limit is 10,000 requests per month, 1,000 per day, 50 per minute, and up to 100 cards per batch. A daily refresh of 10,000 active variants is about 3,000 batch requests per month before retries and onboarding work, so Starter leaves material headroom for the initial cohort. Professional is $49/month for 50,000 monthly requests; Enterprise is advertised at $149/month for 500,000 requests.

This is a licensing route, not an immediate go-live approval. CollectFolio has not created a paid account, accepted provider terms for the operating entity, stored an API secret, or activated an approved immutable source review. Until those actions occur, the source stays pending and `public_price_intelligence` stays false.

### Magic addendum: Cardbase

For the complete cross-game baseline, run the gated TCGCSV market-universe workflow
daily. It appends every reviewed price series to immutable private history and refreshes
the complete private current catalog independently of holdings and search activity. For
Magic: The Gathering, use Cardbase as a targeted continuous free private-research
overlay. Its API is keyed by exact Scryfall printing UUID, exposes separate daily
vendor/finish/price-type/currency series, grants up to 365 history days with one free
key, and permits research and commercial applications under its August 2026 Terms.
Cardbase updates selected exact series; it is not the mechanism for crawling or
rebuilding the full price catalog each day.

This is not a public-data or prediction approval. TCGCSV remains private because its
reviewed TCGplayer-derived rights do not permit public catalog, raw-price, or derived
publication. Cardbase prohibits rate-limit
circumvention and raw-data redistribution as a competing product, and its reviewed
Terms do not expressly grant retained model training or public predictive derivatives.
CollectFolio uses one server-side key, never rotates keys to pool quota, preserves every
provider series separately, and treats backfill as known only when retrieved. The gated
workflow has no database credential and is inactive until a key, private archive,
bounded cohort, source-review hash, and exact mapping review exist. See
[CARDBASE_MTG_RESEARCH.md](CARDBASE_MTG_RESEARCH.md) and
[the source review](source-reviews/CARDBASE_MTG_RESEARCH_CANDIDATE.md).

## Capability fit

| Requirement | JustTCG paid API | CollectFolio treatment |
|---|---|---|
| Current observed price | Condition- and printing-specific USD market price | Tier 1 observed market value |
| Historical series | Daily points for 7/30/90/180 days and 1 year | Backfill once, then retain daily snapshots while subscribed |
| Market semantics | Provider describes volume-weighted observed online activity plus verified store sales | Label as aggregated market observation, never a guaranteed executable quote |
| Completed-sale comps | No itemized transaction/comparable-sale feed in the reviewed API contract | Do not claim individual sold comps or marketplace-level provenance |
| Public display | Explicitly permitted on paid tiers | Rights flag may be true only under an active paid plan and current approved review |
| Derived trends/valuation | Explicitly permitted on paid tiers | Eligible for trends and derived analytics after the independent publication gates |
| Predictive use | Provider markets the data for analysis/ML and permits derived analytics, while prohibiting a substitute pricing API/data feed | Treat that language as promising but insufficient for activation. Require an archived accepted contract or written clarification explicitly allowing predictive derivatives; never expose raw bulk data or an API substitute |
| Storage | Published guidance describes app-bound retention while subscribed; service use ends with the license | Keep the database retention-through-maturity flag false until the operating entity's archived terms explicitly cover label retention through each 30/90-day maturity; no user bulk export of provider data |
| Attribution | Appreciated, not required on paid tiers | Use “Market data provided by JustTCG” anyway for transparency |
| Secret handling | `X-API-Key` header | GitHub Actions/Supabase server-side secret only; never browser runtime config |

## Alternatives reviewed

| Source | Price/history capability | Rights/access finding | Decision |
|---|---|---|---|
| CollectFolio user records | Purchase price, manual value, and locally accumulated portfolio history | First-party and private by default; not an external market observation | Keep as the free fallback and user override |
| Pokémon TCG API | Catalog plus embedded TCGplayer/Cardmarket price fields; no owned market-history license identified | Documentation says the fields are provided by those downstream marketplaces; no direct commercial redistribution/derivative grant was identified | Metadata only; embedded market fields are excluded |
| TCGCSV | Strong current and historical TCGplayer-derived archive | TCGplayer terms prohibit third-party acquisition, combination, rebranding, commercial distribution, and derivatives absent approval | Research only under the existing bounded review |
| Cardbase | MTG-only daily history by Scryfall printing and vendor, up to 365 days with a free key | Terms permit research/commercial apps but prohibit quota circumvention and competing raw redistribution; retained training/public predictive rights are not explicit | Targeted continuous MTG overlay; public raw/derived use remains blocked |
| TCGplayer direct | Current marketplace pricing and exact product IDs | Access is discretionary and approved-purpose-specific; competitive, combined, derivative, and commercial distribution uses require prior written consent | Pursue only as a separately negotiated alternative |
| PriceCharting | Paid current-price API and daily bulk CSV; Pokémon coverage | Terms allow internal use with subscription, but third-party software/public sharing needs express written permission | Viable only after a separate written redistribution/model agreement |
| Cardmarket | European marketplace/price-guide data | Cardmarket states it is not accepting new API applications; current credentials may not be shared with third-party software | Not currently obtainable for CollectFolio |
| eBay | Browse API exposes active listings; Marketplace Insights is the relevant sold-data surface | Active asks are not realized prices; sold-data access and API use require separate eBay eligibility/compliance review | Secondary validation source only after written approval; not the primary price |

## Forecast-source challenger review

The August 13 review does not replace the decision above. A source that exposes a
number called `price`, `market`, or `history` is not automatically a lawful or
statistically valid label source. Production labels must identify the exact provider,
currency, language, finish, raw condition or grade, price semantics, observation time,
and the time CollectFolio actually obtained the value. The provider must also grant the
operating entity the required commercial display, storage, and derived-model rights.

| Source | Defensible role now | Decision and unresolved evidence |
|---|---|---|
| **JustTCG paid** | Exact-condition Pokémon current observations and one-year history for a prospective English/raw/Near Mint pilot | Remains the preferred label-source candidate. Activation still requires a paid contract, immutable approval, exact mapping, and prospective validation. Its aggregate market value is not an executable offer or guaranteed sale. |
| **Cardbase free** | Exact-printing MTG vendor/finish/type/currency histories and prospective daily capture | Targeted continuous MTG overlay. Keep series and currencies separate; condition is provider-aggregate. One-key collector only. Public/raw/predictive use remains blocked pending written rights clarification and prospective qualification. |
| **Pokémon TCG API / TCGdex / Scrydex** | Catalog identity, language, finish, rarity, artist, release/lifecycle, and image reconciliation | Catalog/lifecycle enrichment only. Exclude embedded TCGplayer/Cardmarket prices from labels and public derived outputs because the reviewed catalog surfaces do not establish CollectFolio's upstream marketplace rights. |
| **`tcgapi.dev`** | Current per-condition listings/listing counts/shipping plus printing-level sales-price and sales-volume history | Strongest technical challenger, but exact-condition historical labels were not established. Active listings are asks, not completed sales. The reviewed terms describe publicly sourced TCGplayer/marketplace data and contain plan-language inconsistencies. Require prospective exact-condition snapshots and a signed contract establishing upstream provenance, retention, public display, and predictive-derivative rights before production or training. |
| **PokéWallet** | Supplemental Pokémon/One Piece mapping and price-semantics research | Its terms permit personal or commercial API access, but the responses identify TCGplayer/Cardmarket as upstream sources and do not establish CollectFolio's upstream redistribution, retention, or model-derivative rights. Do not use as a production label source without written clarification. |
| **Card Hedge AI** | Potential comparable-sale, liquidity, graded-card, and vision research | Blocked for training and derived forecasts. The marketing page calls the data “ML & AI Ready,” while the Terms prohibit derivative works without express written permission; the page reviewed on August 13 also displayed an August 14 update date, so that capture is not reliable contract evidence. Require an archived, signed API contract covering provenance, ML training, retention, and public derived display. |
| **TCGIndex** | Product and interaction inspiration | Unverified. Automated review reached only a Cloudflare block and no stable API, schema, price semantics, or terms contract was established. Do not ingest. |
| **MTGJSON** | Later Magic-only catalog and limited-history research cohort | Keep separate from the Pokémon model. The project is openly licensed, but third-party price/content notices and each upstream feed still require review before labels or public derivatives. |
| **Lorcana API** | Lorcana catalog metadata for a later game-specific cohort | Metadata only; it is not a market-history label source. Review underlying Disney/Ravensburger IP and image use separately. |
| **GoAgain** | Flesh and Blood catalog, set, legality, keyword, and lifecycle metadata | Metadata only. Its MIT OpenAPI describes build-time data from `the-fab-cube/flesh-and-blood-cards`; no price/history endpoints were found. |

The first model must stay single-game and single-series-semantic. Adding a broad
multi-game source does not justify pooling Pokémon, Magic, Lorcana, or Flesh and Blood
returns into one cohort.

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

These adapter checks are necessary but do not set the migration 0017 rights flags.
Exact-condition labels, retention through maturity, liquidity derivation, and predictive
derivatives each remain false until supported by the operating entity's immutable review.

## Activation checklist

1. Subscribe the operating entity to a paid JustTCG plan and retain the invoice/account evidence.
2. Archive the exact accepted terms and commercial-use guidance; hash the archived artifact, not a live page.
3. Independently record a new immutable `approved` source review with a short expiry and explicit grants for the exact capabilities used: private modeling, prospective capture, exact-condition labels, retention through maturity, predictive derivatives, and—only when applicable—liquidity derivation. Every new flag defaults false.
4. Keep the source inactive until migration 0016, including its restored 0006 promotion validation, has a real PostgreSQL/Supabase backup, rehearsal, application, and post-apply ACL/RLS verification.
5. Store `JUSTTCG_API_KEY` only in the controlled scheduled-ingest environment.
6. Onboard a small English, raw, Near Mint Pokémon cohort; review every stable card/variant mapping.
7. Rehearse the one-year backfill transaction. Treat all imported history as first available at the real retrieval instant.
8. Begin daily prospective snapshots and source-health monitoring.
9. Qualify Tier 1 observed values and Tier 2 trends before any public publication.
10. Apply migrations 0017 and 0018 only after a real PostgreSQL backup/rehearsal. Before trend execution, the guarded manifest RPC must independently seal the expected exact-series count/hash; the completed trend run must reproduce it exactly. Provision an independent executor HMAC key as the database owner—never through or readable by `service_role`—then preregister 6–18 exact future origin slots with anchors at least 22 days apart, leaving 21 full days between their 24-hour windows. Each slot permits exactly one challenge, every slot is mandatory, and a model version gets no replacement plan for the same horizon/source/purpose. The challenge RPC must see a still-running, output-free forecast run; only the signed receipt transaction may finalize its canonical dataset hash and atomically seal the database-origin run, exact-series universe, prediction, origin-time cost state, baseline outputs, and pocket-selection inputs. Regex tests are not migration proof.
11. Run 30- and 90-day forecasts privately; qualify the 30-day horizon first. Require at least 200 prospectively generated and scored forecasts, 50 exact variants, five sets, six origins spaced by at least 21 days, positive 95% origin-clustered lift over all five baselines, calibrated intervals, separate threshold-specific after-cost calibration, complete candidate-universe cost coverage, positive provider-reference-implied selected-pocket performance, and independent human review before any forecast publication.
12. Before counting a shadow run toward promotion, seal an independent pre-execution input inventory and verify its expected exact-series count/hash against the succeeded trend run. A count derived only from snapshots the run wrote cannot prove that the run omitted nothing.
13. Rehearse migration 0018's scorecard RPC against adversarial fixtures. It must consume only the preregistered plan and its dedicated succeeded evaluation run, fail if any origin slot or planned challenge/receipt/prediction/cost/output/evaluation is absent or extra, independently reconstruct every executor-signed output hash from stored typed rows, and derive membership, hashes, point/calibration/quantile/five-baseline/clustered-lift/after-cost/pocket metrics and recommendation inside one transaction.
14. Operate the HMAC key only inside an isolated trusted executor and independently review its build/runtime controls. Migration 0018 proves possession of that principal's key and binds the exact packet, but deliberately records `artifact_execution_verified=false`; an artifact hash or signed assertion alone is not cryptographic workload proof.

Six minimally spaced 24-hour origin slots plus 30-day maturity require at least 141 days; normal
ingestion and review make five to six months more realistic. The 90-day mathematical
minimum is 201 days. Retrospective held-out evidence may justify private shadow mode,
but it does not count toward the prospective publication threshold.

Public forecasts remain impossible: migration 0018 is checked in but unapplied, no
executor key/provider rights have been provisioned, no prospective window has matured,
the receipt does not claim cryptographic workload proof, and there is still no forecast
publisher or enabled public flag. This is an intentional fail-closed state, not a
forecast-readiness claim.

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
- TCGdex market integration: <https://tcgdex.dev/markets-prices>
- TCG API product, documentation, and terms: <https://tcgapi.dev/>, <https://tcgapi.dev/docs>, and <https://tcgapi.dev/legal/terms>
- PokéWallet API documentation and terms: <https://www.pokewallet.io/api-docs> and <https://www.pokewallet.io/terms-conditions>
- Card Hedge API services and terms: <https://ai.cardhedger.com/api-services> and <https://ai.cardhedger.com/terms>
- MTGJSON project and license: <https://mtgjson.com/> and <https://mtgjson.com/license/>
- Cardbase getting started, limits, OpenAPI, and Terms: <https://www.cardbase.dev/docs/getting-started>, <https://www.cardbase.dev/docs/rate-limits>, <https://www.cardbase.dev/openapi.yaml>, and <https://www.cardbase.dev/terms>
- Lorcana API: <https://lorcana-api.com/>
- GoAgain OpenAPI: <https://api.goagain.dev/openapi.yaml>
- TCGIndex review target: <https://tcgindex.io/>

This engineering review is not legal advice. The database approval must reflect the operating entity's actual subscription and accepted contract at activation time.
