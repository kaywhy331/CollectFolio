# JustTCG on-demand refresh

## Purpose and boundary

`netlify/functions/justtcg-refresh.mjs` is a second, user-triggered path onto
the same private JustTCG research collection described in
[JUSTTCG_CATALOG_COLLECTOR.md](JUSTTCG_CATALOG_COLLECTOR.md). Where that
function crawls the whole catalog blindly, in price-descending order, on a
five-minute timer, this function lets a signed-in collector ask that *their
own* held and watched cards be prioritized in the next private research pass
— so a scarce, shared Free-tier budget is spent on cards someone actually
asked about instead of only on whatever the price-rank crawl happens to reach
that day.

This is exactly as private as the scheduled crawl, and for the same reasons:

- It has no HTTP read route beyond the trigger itself. Nothing it stores is
  ever returned to a browser as a price.
- It never writes to `public.price_observations`, `public.external_card_mappings`,
  `public.catalog_mapping_candidates`, or any other governed Supabase table,
  and it holds no elevated Supabase credential — see "Why Blobs, not
  Postgres" below.
- It never changes `public.product_feature_flags.public_price_intelligence`.
- Its only effect is on the private Netlify Blobs store
  `collectfolio-justtcg-private`, under a separate `ondemand/` prefix from
  the crawl's own `catalog/` prefix.

Do not describe this function's output as production ingestion or expose it
to browser users, for the same reasons documented in
[PRICE_INTELLIGENCE_RUNBOOK.md](PRICE_INTELLIGENCE_RUNBOOK.md). The intended
progression is: private targeted collection now (this function) → operator
mapping and source-review workflow later → governed ledger ingestion once
mappings and rights are approved → public UI only after the paid-plan,
archived-terms, and publication-review gates in that runbook are complete.

## Why Blobs, not Postgres, for mappings and candidates

`external_card_mappings` and `catalog_mapping_candidates` both have RLS
enabled with zero policies and zero grants to `anon`/`authenticated` — only
`service_role` (or the narrow SECURITY DEFINER RPCs, neither of which exposes
mapping reads or candidate inserts) can touch them today. This isn't just
inconvenient, it's the schema deliberately refusing the shortcut:

- Inserting a candidate requires a `source_ingestion_runs` row and a matching
  `source_terms_reviews` row via composite foreign key. JustTCG's own source
  review is intentionally not active yet (see
  [PRICE_SOURCE_DECISION.md](PRICE_SOURCE_DECISION.md) and
  [source-reviews/JUSTTCG_PRODUCTION_CANDIDATE.md](source-reviews/JUSTTCG_PRODUCTION_CANDIDATE.md)).
- `external_card_mappings.variant_id` and `catalog_mapping_candidates.proposed_variant_id`
  both reference `catalog_variants(id)`, which is essentially unpopulated for
  the games this app covers today.

So this function never attempts to reach either table, with or without
elevated credentials. Everything — the private "which cards are trusted
enough to fetch directly" ledger and the "here's a plausible but unreviewed
match" candidate ledger — lives entirely in Blobs, namespaced so it can never
be confused with a real, reviewed `external_card_mappings` row:

- Every private-ledger mapping entry carries `privateLedgerStatus:
  'operator_seeded'` and `notAnApprovedCanonicalMapping: true`. The word
  "approved" is never reused here — it means something specific and different
  elsewhere in this system (a real, reviewed `external_card_mappings` row),
  and conflating the two is exactly the failure this boundary exists to
  prevent.
- Every candidate carries `privateLedgerStatus: 'unreviewed_candidate'` and
  the same `notAnApprovedCanonicalMapping: true` marker, plus a
  `mappingConfidence` that is always held below the real mapping-approval
  threshold (0.98) used elsewhere in this codebase.
- Each mapping/candidate field is named to match the real
  `external_card_mappings` columns (`externalProductId`, `externalVariantKey`,
  `mappingConfidence`, `mappingMethod`, `mappingVersion`) so a future operator
  workflow that promotes a private-ledger entry into a real, reviewed mapping
  is a translation, not a redesign.

## Identity, not canonical variant ID

Holdings and watchlist items carry a `canonicalVariantId` field, but nothing
in this codebase populates it today (it requires an operator-seeded
`catalog_variants` row). Keying this feature on it would silently match zero
cards. Instead, every card is identified the same way
`catalog-identity.js`'s `catalogReferenceForItem()` already does for its
`source:v1:...` watch key: `(provider, externalId, language, finish,
conditionClass)`.

That tuple is never used directly — it is hashed
(`identityHash = sha256({provider, externalId, language, finish,
conditionClass})`) before it ever reaches a Blobs key, because `externalId`
comes from unconstrained `jsonb` columns (`holdings.data`,
`watchlist_items.catalog_snapshot`) that a client fully controls. A crafted
`externalId` could otherwise be shaped to land inside the crawl's own
`catalog/` prefix in the same Blobs store; hashing makes that impossible —
`computeIdentityHash()` always returns either `null` (no `externalId` at all)
or a clean 64-character hex digest, never the original string.

## Eligibility

For each distinct identity found in the requesting user's own holdings and
watchlist (read through their own Supabase session — see "Auth" below):

- A private-ledger mapping exists **and** the card is stale (never fetched,
  or older than `JUSTTCG_ONDEMAND_STALENESS_HOURS`) **and** it isn't in
  per-identity backoff from a recent failure → eligible for a **price
  fetch**.
- No private-ledger mapping exists → eligible for **candidate generation**
  only: a bounded, zero-extra-API-cost scan of catalog pages the scheduled
  crawl already stored, matching name + set + game. A candidate is only ever
  proposed when exactly one already-crawled card matches — an ambiguous or
  absent match produces nothing rather than a guess (mapping safety: a price
  may never attach on name alone).

Up to 20 stalest fetch-eligible cards (JustTCG's Free-tier `POST /cards`
batch cap) are claimed and sent in one request. One trigger from the browser
is exactly one HTTP round trip and at most one JustTCG call.

## Quota: yielding to the scheduled crawl, not just coexisting with it

The scheduled crawl's `quota_exhausted` and `blocked` states are **permanently
terminal** — once its observed `apiRequestsRemaining` hits zero, the crawl
halts for good until an operator intervenes (see
[JUSTTCG_CATALOG_COLLECTOR.md](JUSTTCG_CATALOG_COLLECTOR.md)). This feature
must never be the one to drive that counter to zero. So, on every trigger:

1. It self-caps at its own small, independent daily and per-minute budgets
   (`JUSTTCG_ONDEMAND_DAILY_REQUEST_LIMIT`, `JUSTTCG_ONDEMAND_MINUTE_LIMIT`) —
   the crawl's own hardcoded 100/day limit is never edited.
2. Before spending an attempt, it does a **read-only** check of the crawl's
   own durable state: if the crawl's last-observed `apiRequestsRemaining` is
   at or below `JUSTTCG_ONDEMAND_RESERVE_FLOOR`, this feature defers rather
   than compete for what's left.
3. Per-user limits (`JUSTTCG_ONDEMAND_USER_DAILY_LIMIT`,
   `JUSTTCG_ONDEMAND_USER_MIN_INTERVAL_MS`) exist because account signup is
   open — without them, one account could exhaust the shared budget or
   trigger `EXCESSIVE_FREE_TIER_USAGE` (also terminal for the crawl) outright.
   This is a reliability requirement for the *existing* scheduled feature,
   not only abuse-prevention for this one.

All of the above is reserved and released atomically through one small
`control.json` object (day/minute rollover, global budget, per-user budget,
and the in-flight claim on each card being fetched this round), so a second
concurrent trigger — from the same user or a different one — can never claim
a card another trigger is actively fetching. A card's longer-lived staleness
record (when it was last fetched) is tracked separately, at lower rigor: an
occasional redundant re-fetch after a card was *just* refreshed a moment
earlier by someone else is an accepted, bounded cost, not a correctness
failure — the same trade-off this repository already makes for the crawl's
own Bloom-filter approximate counting.

## Auth

The browser sends the user's own Supabase `access_token` as a bearer token.
This function never decodes that token itself — no JWT-verification library
is added (see `scripts/validate.mjs`'s pinned dependency set), and no
unverified claim is ever trusted for a rate-limit key. Instead it calls
Supabase's own `GET /auth/v1/user`, which verifies the token signature
server-side; only a token Supabase itself accepts ever reaches the
per-user rate-limit bucket or the holdings/watchlist reads that follow, and
both of those reads use that same forwarded token — Supabase's own Row Level
Security does the scoping, exactly like the frontend's existing
`services/supabase.js` requests.

## Response contract

The HTTP response is a status/progress summary only, built as an explicit
field whitelist — never a spread of internal state — and it never carries a
price, a currency, or a card name:

```json
{ "requestId": "...", "outcome": "ok", "checked": 42, "eligible": 8,
  "fetched": 8, "alreadyFresh": 30, "needsMapping": 4, "deferred": 0 }
```

`outcome` is one of `ok`, `no_eligible_cards`, `busy`, `quota_deferred`,
`provider_error`, `unauthorized`, `not_configured`, or `method_not_allowed`.
The Profile screen's "Prioritize my cards" button shows this as a plain-text
status line, never a new price — clicking it does not change anything a
collector sees elsewhere in the app. The browser aborts the request if the
connection or response body does not finish within 20 seconds and restores the
button for a safe retry.

Accepted, documented residual: an `alreadyFresh` count lets a user infer that
*someone* recently refreshed a card they also hold. No price or specific
identity is disclosed by this, so it is accepted rather than engineered
around.

## Environment

Reuses the scheduled crawl's existing variables (`JUSTTCG_API_KEY`,
`JUSTTCG_COLLECTION_ID`, `JUSTTCG_GAME`, `JUSTTCG_EXPECTED_PLAN`) plus
`SUPABASE_URL`/`SUPABASE_ANON_KEY` (already configured for the browser
bundle; this function reuses the same public values, never a service-role
key). Optional, on-demand-specific controls, all with conservative defaults:

```text
JUSTTCG_ONDEMAND_DAILY_REQUEST_LIMIT=15
JUSTTCG_ONDEMAND_MINUTE_LIMIT=8
JUSTTCG_ONDEMAND_RESERVE_FLOOR=50
JUSTTCG_ONDEMAND_USER_DAILY_LIMIT=3
JUSTTCG_ONDEMAND_USER_MIN_INTERVAL_MS=60000
JUSTTCG_ONDEMAND_STALENESS_HOURS=24
```

## Seeding the private mapping ledger

There is intentionally no automated way to populate
`ondemand/<collectionId>/mappings/<shard>.json` — an operator reviews a
candidate (from `ondemand/<collectionId>/candidates/<shard>.json`, or
external knowledge of a card's JustTCG identifier) by hand before it can ever
be fetched against, the same discipline the real mapping-review workflow
uses. Until that manual step exists as tooling, add an entry directly via a
short local script using `@netlify/blobs`'s manual-configuration client
(site ID and a Netlify auth token, not the runtime `JUSTTCG_API_KEY`) to call
`saveMappingShard` on `netlify/lib/justtcg-ondemand-repository.mjs`. Until a
card has a private-ledger entry, its holdings/watchlist appearances only ever
produce candidates — never a fetch.

## Primary documentation

- [JUSTTCG_CATALOG_COLLECTOR.md](JUSTTCG_CATALOG_COLLECTOR.md)
- [PRICE_INTELLIGENCE_RUNBOOK.md](PRICE_INTELLIGENCE_RUNBOOK.md)
- <https://justtcg.com/docs/api/cards>
- <https://docs.netlify.com/build/functions/get-started/>
- <https://docs.netlify.com/build/data-and-storage/netlify-blobs/>
