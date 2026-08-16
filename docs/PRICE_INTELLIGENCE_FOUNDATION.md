# Price Intelligence Foundation

## Current release boundary

This increment ships the local product foundation plus a private research baseline, not an approved public prediction model:

- exact-variant Watchlist in IndexedDB;
- Holdings/Watchlist/Forecasts segmentation inside Portfolio;
- watch/unwatch from Search, holdings, and selected scan matches;
- optional cloud watchlist synchronization after migration 0002;
- canonical identity bridge for existing holdings;
- rights-aware public publication boundary;
- cached hydration and a strict support-tier display contract for approved publications;
- dependency-free point-in-time analytics primitives and synthetic regression tests;
- deterministic canonical ingestion, mapping quarantine, observation preparation, and descriptive publication-review packets;
- explicit identity-only, unsupported, restricted, and research-gated states;
- a bounded TCGCSV weekly-history adapter and reviewed exact mapping for one research cohort; and
- a separate fixed-origin JustTCG paid-source adapter with one-year history, honest backfill availability, and fail-closed subscription/rights gates (not activated); and
- a separate fixed-origin Cardbase MTG private-research adapter with exact vendor/finish/type/currency series, a replay-safe first-seen ledger, one-key quota enforcement, and no public output (not activated); and
- append-only private model, prediction, evaluation, scorecard, and promotion-review ledgers from migration 0005; and
- pending migration 0006 hardening for the database kill switch, immutable source reviews and mapping versions, explicit Unscorable evidence, versioned scorecard membership/policy, authenticated model review, and per-card disable receipts.

No fair-value record, public candidate, public forecast, or public publication is created by this increment. Five original baseline predictions and 210 explicitly retrospective walk-forward predictions exist only in the service-role ledger; 200 retrospective rows remain `research_only` and 10 are quarantined. The legacy matured scorecards do not support promotion, no human promotion review exists, and the server feature flag `public_price_intelligence` remains `false`. Migration 0006 is checked in but not claimed as hosted; it must pass backup, rollback rehearsal, and post-apply verification first.

The paid-source decision is now concrete but still external-state gated. [PRICE_SOURCE_DECISION.md](PRICE_SOURCE_DECISION.md) recommends JustTCG Starter, while [source-reviews/JUSTTCG_PRODUCTION_CANDIDATE.md](source-reviews/JUSTTCG_PRODUCTION_CANDIDATE.md) remains `pending` until CollectFolio holds an active paid subscription and records the accepted contract in an immutable live review. Pokémon catalog lookup is metadata-only; embedded TCGplayer/Cardmarket prices and legacy stored Pokémon provider values are excluded from valuation/display, including old finish selectors and unversioned historical portfolio snapshots. User-entered manual values remain available as the first-party fallback.

## Research analytics boundary

`analytics/` implements auditable calculations and deterministic service-role packets. The operator CLI can read a narrowly bounded live TCGCSV research surface, but it has no database credential and never publishes:

- observed and available timestamps are both required; observations unavailable at a historical feature cutoff are excluded;
- exact variant, source, currency, finish, raw/graded class, and price semantics cannot be mixed;
- endpoint log returns, Theil–Sen slope, MAD volatility, drawdown, history density, freshness, and provisional trend bands are deterministic;
- no-change and capped damped-momentum forecasts are baselines, not user-facing predictions;
- walk-forward audits reject future features, immature training labels, early evaluation, mixed horizons, and missing dataset/code/feature/mapping/model lineage;
- realized outcomes use the trailing seven-day median ending at maturity, while preserving the exact-date price separately;
- every newly processed matured target emits an immutable Scored or Unscorable row; scorecards report Unscorable counts outside metric denominators;
- evaluation reports log-return MAE, MdAPE, sMAPE, direction, Brier/calibration, pinball loss, interval coverage/width, and baseline-relative lift without automatic promotion;
- promotion policy requires no-change, damped momentum, market index, lifecycle cohort, and structural convergence comparisons; missing evidence remains `insufficient`;
- q10/q25/q50/q75/q90 must be present and noncrossing before publication;
- pull scarcity requires an explicit equal-distribution assumption and distinguishes expected packs from hit-probability pack counts;
- `video_model_v0` reproduces the forensic coefficients with `research_only=true` and is never treated as the production forecaster;
- new exact mappings remain review-required, and conflicting IDs, names, finishes, or incomplete identities are quarantined;
- source terms must permit research ingestion before a record is prepared and must independently permit commercial catalog/raw/derived publication before a candidate is built; and
- descriptive candidates are capped at Tier 2 and cannot contain `fairValue` or `forecasts`;
- historical qualification is capped at 53 exact-weekly archives, records a next-day availability assumption, and uses the matching seven-day endpoint-reference tolerance; and
- retrospective origins are selected at preregistered 30-day spacing from accepted observations' actual `available_at` values, while model/run/evaluation creation timestamps remain the honest generation instant and every simulated prediction is labeled `retrospective_walk_forward` plus `not_prospectively_generated`; and
- private evidence SQL is fail-closed, defaults to rollback, rechecks rights at generation and execution time, validates per-origin/code/config/evaluation/policy/membership/packet lineage, and cannot contain a publication candidate or model-promotion review.

The defaults for trend z-bands and freshness are configurable research defaults. A production model card must replace them with walk-forward calibrated values. The dedicated analytics workflow uses Python 3.12 and the standard library only.

## Identity contract

An approved canonical catalog UUID is preferred. Before one exists, the client creates an exact, versioned watch key from provider, external product ID, language, edition, finish, and raw/graded condition class. A metadata-only fallback includes game, set, number, and normalized name.

Existing holding UUIDs and provider snapshots remain unchanged. `catalogKey` is the bridge key; `canonicalVariantId` is populated only after mapping approval.

## Publication boundary

Anonymous and authenticated clients cannot read raw sources, terms reviews, ingestion runs, canonical catalog tables, mappings, or publication lineage. They can read a `card_intelligence_publications` row only when:

1. the row is marked published and public;
2. it is inside its publication window;
3. it has at least one lineage source;
4. every source is active and references the exact current terms review;
5. every review is approved, commercially permitted, and unexpired; and
6. each usage kind has the corresponding catalog/raw/derived/image permission;
7. required source attribution exactly matches the immutable review; and
8. the database `public_price_intelligence` flag is enabled.

Migration 0003 adds private observation, mapping-review, analytics, candidate-review, and promotion ledgers. A service-role-only publication function atomically publishes a reviewed Tier 0–2 payload and exact lineage after rechecking current rights. Restricted research data never belongs in the payload, and the function does not enable the public feature flag. Migration 0004 explicitly hardens hosted function ACLs. Migration 0005 adds service-role-only, append-only model versions, forecast predictions, matured evaluations, scorecards, and review evidence; predictions are limited to `research_only` or `quarantined`. Migration 0006 makes descriptive publication RPC-only, requires model review through an authenticated operator JWT, freezes scorecard membership after review, and provides append-only mapping/publication correction paths.

## Operator rollout

1. Confirm hosted migrations 0002 through 0005, review pending migration 0006, and take a restorable hosted database backup.
2. Rehearse 0006 through the normal Supabase migration process; do not paste partial sections or apply it without the backup.
3. Apply 0006 only after rehearsal, then confirm all 36 public tables have RLS and raw governance/catalog tables have no browser grants.
4. Sign in with two isolated clients.
5. Watch, update, unwatch, rewatch, and sync the same exact finish from both clients.
6. Confirm deletion tombstones prevent resurrection.
7. Confirm a second user cannot read or write the first user's watchlist.
8. Leave `public_price_intelligence=false` until the source and model gates have independent approval.
9. When a paid JustTCG account exists, archive/hash the accepted contract, create a short-lived approved review, store the API key server-side, and onboard only an exact-mapped Near Mint pilot cohort.

## Research cohort qualification — August 5, 2026

The first private cohort is Pokémon TCGplayer product `590027`, Pikachu ex `238/191`, Holofoil, mapped exactly to canonical variant `80b4934a-96db-5f4c-8641-f7c74e0eb949`. Fifty-three weekly archives from 2025-08-02 through 2026-08-01 were hash-checked and processed. Forty-one observations were accepted; twelve anomalous levels remain visible as outliers and data-quality events. The current `$310.79` observation was accepted.

At cutoff `2026-08-05T22:30:00Z`, the private snapshot reported `stable`, 90-day density `1.0`, evidence quality `0.75`, and 13 accepted 90-day observations. A research-only damped-momentum baseline produced immutable 7/30/90/180/365-day quantiles.

At the honest generation instant `2026-08-05T23:23:08.840897Z`, legacy packet `72df5fb8417786a83fcd480cff314c2565fa130f8976391e264ea4e6b9d89cf3` evaluated a separate static retrospective model across 42 accepted origins. It persisted 42 point-in-time snapshots, 210 simulated predictions, 109 evaluations, and four scorecards. The 7-day slice has 36 eligible cases and a `reject` recommendation: MAE log return `0.02330`, baseline-relative lift `-0.01239`, Brier `0.24808`, and 80% interval coverage `0.55556`. The 30/90/180-day slices have 27/21/16 eligible cases and remain `insufficient`; every scored horizon has negative baseline lift and under-covered intervals. Ten early predictions remain quarantined, 19 other matured targets lacked an accepted observation in the declared maturity window, and the 365-day horizon has no eligible scorecard. Because this receipt predates 30-day origin spacing and immutable Unscorable/membership/policy evidence, preserve it but never promote or retroactively relabel it.

This evidence is a negative research result, not a promotion. There are zero model-promotion reviews, public candidates, promotion receipts, or public rows. TCGCSV is still `research_only` with every commercial/catalog/raw/derived public permission false; the target rights predicate and public feature flag are both false.

The exact hosted procedure, source review, mapping flow, descriptive promotion gate, verification queries, and rollback are in [PRICE_INTELLIGENCE_RUNBOOK.md](PRICE_INTELLIGENCE_RUNBOOK.md).

If migration 0002 is absent, local Watchlist remains fully usable. Existing holdings still synchronize, and Watchlist sync reports a migration-required warning.

## Rollback

- Build with `ENABLE_PRICE_INTELLIGENCE=false` to keep public intelligence and forecasts fail-closed without deleting IndexedDB records. Local Watchlist availability is controlled independently by `ENABLE_WATCHLISTS`.
- Set the server `watchlists` product flag to false after migration to disable the surface for configured clients.
- Set `public_price_intelligence=false` to prevent the client from presenting publication availability.
- After migration 0006, the same database flag also blocks the RLS read predicate; use `disable_public_intelligence(...)` for a per-card disable so an immutable control event is recorded.
- Revoking or expiring a source terms review automatically makes dependent publication rows fail public RLS.
