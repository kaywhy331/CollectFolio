# Cardbase MTG source review — private research candidate

**Review date:** August 15, 2026

**Decision:** `research_only`

**Public raw display:** no

**Public derived display / predictive use:** no

**Continuous acquisition:** eligible only after the gated operator configuration is complete

## Evidence reviewed

- Getting started: <https://www.cardbase.dev/docs/getting-started>
- Rate limits and caching: <https://www.cardbase.dev/docs/rate-limits>
- OpenAPI 3.1 document: <https://www.cardbase.dev/openapi.yaml>
- Terms of Service, shown as last updated August 2026: <https://www.cardbase.dev/terms>
- Live `status`, printing lookup, printing detail, and anonymous price-history responses on August 15, 2026
- Independent Scryfall printing detail for the UUIDs used during the review

This is an engineering classification, not legal advice or a sublicense from any
upstream marketplace.

## Rights classification

Cardbase's Terms permit personal projects, research, and commercial applications.
They prohibit deliberate rate-limit or access-control circumvention, redistribution
of raw prices as a competing data product, service-degrading use, and scraping beyond
the documented API. Those terms are materially clearer for private research than the
reviewed TCGCSV/TCGplayer path.

The reviewed text does not expressly grant long-term retention after access ends,
public redistribution of each marketplace's raw values, model training, predictive
derivatives, or public display of those derivatives. It also identifies TCGPlayer,
Card Kingdom, and Cardmarket as third-party sources without supplying an upstream
license record to CollectFolio. Therefore this review allows bounded private research
ingestion only. It does not authorize a browser price API, raw export, public trend,
fair-value output, or forecast.

The source record must remain fail-closed:

| Capability | Reviewed value |
|---|---:|
| `decision` | `research_only` |
| `commercialUseAllowed` | `true` (the Terms expressly allow commercial applications) |
| `catalogMetadataAllowed` | `true` for private identity reconciliation |
| `publicRawDisplayAllowed` | `false` |
| `publicDerivedDisplayAllowed` | `false` |
| Public forecast eligibility | `false` |

## Technical fit

The API uses a Scryfall printing UUID as its stable printing key. Price responses keep
vendor, finish, price type, and currency separate and provide ascending daily
`[date, amount]` pairs. Reviewed dimensions were:

- vendors: TCGPlayer, Cardmarket, Card Kingdom, Cardsphere, and Cardhoarder;
- finishes: normal, foil, and etched;
- price types: retail and buylist; and
- currencies observed or documented: USD, EUR, and Cardhoarder TIX.

These dimensions must never be averaged into one label. Every combination is a
separate CollectFolio market series. Cardbase does not provide condition-specific
labels, so the exact condition scope is `provider-aggregate`, never Near Mint or a
guessed grade. TIX must not be converted to USD without a separately reviewed,
point-in-time foreign-exchange or ticket-value source.

Anonymous access is capped at 30 history days and 10 price requests per minute. One
free API key unlocks up to 365 days and 60 price requests per minute. The account UI
advertises up to five keys, but the Terms prohibit deliberate quota circumvention.
CollectFolio therefore accepts exactly one server-side key per environment, paces
requests to at most about 57 per minute, honors `Retry-After`, and never switches keys
after a 429. Cardbase edge-cache hits do not consume provider quota, but the collector
does not depend on that optimization for safety.

The bulk endpoint offers authenticated daily `jsonl.gz` snapshots for the trailing
365 days. Its OpenAPI description does not define the JSON-line record schema, so the
bulk file is not parsed or ingested by this review. It may be evaluated later with a
captured sample, size bounds, schema contract, and private-storage rehearsal.

## Data-quality findings

The entitlement is “up to” 365 days, not a guarantee that 365 days currently exist.
On August 15 the reviewed responses reported `meta.history_begins = 2026-05-01`.
Collectors must record and test `history_begins`; they may not infer missing earlier
points or claim a full-year sample.

The getting-started Black Lotus example associated UUID
`bd8fa327-dd41-4737-8f19-2cf5eb1f7cdd` with Limited Edition Alpha set `lea`, number
`232`. On August 15, Cardbase printing detail and Scryfall both identified that UUID as
Vintage Masters set `vma`, number `4`; Cardbase's `lea`/`232` lookup instead returned
`b0faa7f2-b547-42c4-a810-839da50dadfe`. This is a documentation-example defect, not
evidence that UUID-keyed live responses are crossed, but it proves that example text
cannot approve a mapping. Every cohort mapping must compare the live printing detail
with independent Scryfall identity and receive an explicit private-research review.

The reviewed Alpha Black Lotus response also showed large vendor-level differences
(for example, Card Kingdom retail, TCGPlayer retail, Cardmarket retail, and Card
Kingdom buylist). Those are different market semantics, not interchangeable estimates.
Model features must preserve the source series and may compare them only through a
separately declared method with currency and liquidity controls.

The same Alpha printing also exposed a filter-dependent currency defect: on August 15,
an anonymous `days=7` response labeled the Cardhoarder series `TIX`, while `days=30`
labeled the otherwise matching Cardhoarder series `USD`. Cardhoarder is an MTGO market,
and the Alpha paper printing should not be approved as its product identity in any case.
The collector's exact series key includes currency, so this drift cannot merge silently;
an expected mapping simply fails when its reviewed currency is absent. Before approving
any cohort mapping, compare overlapping 7-, 30-, and authenticated 365-day responses,
verify overlapping amounts and currency are stable, and exclude Cardhoarder from paper
printings. Treat any future dimension drift as a provider-quality incident, not a new
automatic mapping.

## Availability and revision semantics

Cardbase supplies price dates and a response-level `as_of` date, not the original
instant at which each historical point became available. Initial backfills are
therefore labeled `operator_first_seen` at the real CollectFolio retrieval time. A
private first-seen ledger preserves that timestamp across later rolling responses.
If Cardbase revises a historical amount, the value digest creates a new source-record
identity first seen at the correction retrieval time; it never rewrites the earlier
observation.

This prevents a 365-day response fetched today from masquerading as information that
CollectFolio possessed 365 days ago. Retrospective experiments may use the series for
descriptive research, but only prospectively captured availability can count toward a
future model-promotion threshold.

## Activation requirements

1. Create one Cardbase API key for the controlled research environment and retain the
   accepted Terms/account evidence. No Cardbase key is configured as of this review.
2. Build a bounded cohort manifest from Magic holdings/watchlist candidates. Every
   Scryfall printing and vendor/finish/type/currency mapping needs an independent
   private-research review and canonical variant UUID.
3. Store the cohort manifest, first-seen ledger, packets, and receipts in a private,
   versioned object store, and pre-seed the canonical empty ledger documented in
   `docs/CARDBASE_MTG_RESEARCH.md`. Do not upload raw price packets as public CI
   artifacts.
4. Configure the gated workflow variables and secrets documented in
   `docs/CARDBASE_MTG_RESEARCH.md`, then enable
   `CARDBASE_MTG_RESEARCH_ENABLED=true`.
5. Keep TCGCSV collection manual/static and keep `public_price_intelligence` disabled.
6. Before database import, complete the independent backup/recovery rehearsal and
   operator authorization for migrations 0015–0019. The workflow itself writes no
   database and cannot enable a feature flag.
7. Obtain written clarification before enabling public raw values, retained predictive
   labels, model training, or public derived forecasts.
