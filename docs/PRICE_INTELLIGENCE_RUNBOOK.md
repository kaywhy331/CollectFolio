# Price Intelligence Operator Runbook

## Safety boundary

Migrations 0002 through 0005 add the Watchlist and private research data plane, harden function execution privileges, and add forecast-research ledgers. Migration 0006 hardens those ledgers with a database publication kill switch, immutable terms reviews, versioned mapping correction, Scored/Unscorable outcomes, exact scorecard membership/policy evidence, authenticated model review, and append-only rollback receipts. None of these migrations approves a source, publishes a card, promotes a model, or enables `public_price_intelligence`.

Keep these invariants throughout rollout:

- only the service role can access governance, mappings, observations, analytics runs, candidates, or publication lineage; model approval itself requires an authenticated operator JWT;
- unresolved mappings never produce price observations;
- missing and outlier records remain auditable rather than being silently deleted;
- only an operator-reviewed Tier 0–2 descriptive candidate can use `publish_descriptive_intelligence`;
- current source terms, required attribution, and the database feature flag are rechecked during promotion and every public read; and
- the public feature flag remains false until an independent go-live decision.

## 1. Preflight and backup

Run from the repository root:

```sh
npx --yes supabase@latest migration list --linked
npx --yes supabase@latest db push --linked --dry-run
```

Confirm the linked project is the intended CollectFolio project and that only the expected migrations are pending. Before the real push, create a restorable hosted backup through the Supabase dashboard or the team's established database-backup process. Do not use a schema dump as a substitute for an Auth/storage-aware project backup.

Migration 0002 is additive but changes the holdings schema and creates authenticated Watchlist RPC/RLS contracts. Migration 0003 is additive and creates private research ledgers plus restricted functions. Migration 0004 explicitly removes Supabase default function-execution grants from browser roles and leaves descriptive promotion service-role-only. Migration 0005 adds private forecast evidence. Migration 0006 alters existing constraints, triggers, and ACLs, so review the linked source rows and take a restorable backup before applying it. In particular, confirm existing terms-review document hashes/attribution satisfy the new validated constraints and that the expected external-mapping identity constraint exists.

## 2. Apply and inventory

After the backup is confirmed:

```sh
npx --yes supabase@latest db push --linked --dry-run
npx --yes supabase@latest db push --linked
npx --yes supabase@latest migration list --linked
```

The final list must show local and remote versions for 0001 through 0006. As of this code handoff, 0006 is intentionally pending and must not be represented as hosted until the push and verification below actually succeed.

Use the Supabase SQL editor to verify the security inventory:

```sql
select tablename, rowsecurity
from pg_tables
where schemaname = 'public'
order by tablename;

select grantee, table_name, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and grantee in ('anon','authenticated')
  and table_name in (
    'data_sources','source_terms_reviews','source_ingestion_runs',
    'catalog_sets','catalog_cards','catalog_variants','external_card_mappings',
    'intelligence_publication_sources','catalog_mapping_candidates',
    'catalog_mapping_review_events','price_observations','data_quality_events',
    'analytics_runs','analytics_run_sources','trend_feature_snapshots',
    'intelligence_publication_candidates','intelligence_candidate_sources',
    'intelligence_candidate_reviews','intelligence_publication_promotions',
    'model_versions','card_forecast_predictions','forecast_evaluations',
    'model_scorecards','model_promotion_reviews','model_scorecard_evaluations',
    'intelligence_publication_control_events'
  );

select key, enabled, public_read
from public.product_feature_flags
where key in ('watchlists','public_price_intelligence');

with functions(signature) as (
  values
    ('public.get_or_create_default_watchlist()'),
    ('public.intelligence_publication_is_permitted(uuid)'),
    ('public.publish_descriptive_intelligence(uuid)'),
    ('public.disable_public_intelligence(uuid,text,text)'),
    ('public.review_model_promotion(uuid,uuid,text,boolean,boolean,boolean,boolean,boolean,text,text,text)'),
    ('public.supersede_external_card_mapping(uuid,uuid,numeric,text,text,text,text)'),
    ('public.validate_price_observation_lineage()'),
    ('public.reject_append_only_mutation()'),
    ('public.protect_terminal_analytics_run()')
)
select signature,
       has_function_privilege('anon', signature, 'EXECUTE') as anon,
       has_function_privilege('authenticated', signature, 'EXECUTE') as authenticated,
       has_function_privilege('service_role', signature, 'EXECUTE') as service_role
from functions
order by signature;
```

Expected results after 0006: all 36 public tables have RLS; the restricted-grant query returns zero rows; `watchlists=true`; and `public_price_intelligence=false`. The Watchlist RPC is executable by authenticated and service roles only; the rights predicate is executable by all three API roles; descriptive publication, mapping supersession, and per-card disable are service-role-only. `review_model_promotion` is authenticated-only and additionally requires server-managed `app_metadata.price_intelligence_operator=true`. Trigger helpers are not API-executable. Private evidence tables grant service-role SELECT/INSERT but not UPDATE/DELETE, except `model_promotion_reviews`, whose direct service-role INSERT is revoked so review must use the authenticated RPC.

## 3. Watchlist qualification

Use two test accounts and two isolated clients for account A, plus one client for account B:

1. Account A watches an exact finish in client A1 and syncs.
2. Client A2 syncs and receives the item.
3. A1 changes target/alert preferences; A2 syncs and receives the newest ISO update.
4. A2 unwatches and syncs; A1 syncs and confirms the tombstone prevents resurrection.
5. Rewatch from A1 and confirm the newer item clears the older tombstone.
6. Verify account B cannot read or mutate account A's watchlist rows.
7. Remove all qualification users and rows, then confirm no QA residue remains.

If Watchlist qualification fails, set the `watchlists` product flag false. Local Watchlist data remains intact.

## 4. Source onboarding

Source approval is a legal/operator decision, not a code default. Capture the reviewed terms document, its SHA-256, review date, expiry/review cadence, attribution, and separate permissions for:

- catalog metadata;
- public raw price display;
- public derived features;
- images; and
- commercial use.

Start the source inactive with a `pending` or `research_only` review. Activate it and point `current_terms_review_id` at an `approved` review only after the evidence supports every selected permission. Never copy a TCGplayer-derived research source into production merely because the pipeline accepts its shape.

Revoking the source or changing its current terms-review pointer immediately blocks dependent public rows at RLS.

### JustTCG paid production candidate

The preferred production route is documented in [PRICE_SOURCE_DECISION.md](PRICE_SOURCE_DECISION.md), with the non-activating review in [source-reviews/JUSTTCG_PRODUCTION_CANDIDATE.md](source-reviews/JUSTTCG_PRODUCTION_CANDIDATE.md). The reviewed July 27, 2026 terms support paid-tier end-user price/history display, derived analytics, and app-bound server storage. They do not permit the free tier to power a commercial app, raw-data resale/export, a proxied feed, or a substitute pricing API.

Before changing the source from `pending` to `approved`:

1. Subscribe the operating entity to a paid plan and retain account/invoice evidence.
2. Archive the exact accepted terms and commercial-use guidance in the controlled compliance store; SHA-256 that immutable artifact.
3. Independently confirm the paid plan is active and create a new append-only review with catalog, raw-price, derived-feature, commercial, attribution, and expiry fields matching the actual contract.
4. Keep the source inactive until migration 0006 has been backed up, rehearsed, applied, and verified.
5. Store `JUSTTCG_API_KEY` only in the scheduled server environment. Never put it in `runtime-config.js`, a browser request, logs, fixtures, packets, or the repository.
6. Use the stable provider card/variant UUIDs and review every initial Near Mint/printing mapping. Do not auto-translate provider printing aliases into canonical editions/finishes.

`analytics/src/collectfolio_analytics/justtcg.py` accepts only the fixed JustTCG HTTPS cards endpoint, refuses redirects before they can carry the API key elsewhere, authenticates in `X-API-Key`, bounds response size and history age, filters exact condition/printing, and requires all paid/effective/expiring public capabilities before preparing observations. An initial `1y` response is historical source data but newly available CollectFolio evidence: every point receives the real retrieval instant as `available_at`. Never rewrite those values to their market dates to manufacture earlier walk-forward availability.

Start with a small daily production cohort. The published Starter plan permits 10,000 monthly requests, 1,000 daily requests, 50 per minute, and 100 cards per batch. Apply retry/backoff, `Retry-After`, payload-size, freshness, mapping, and source-expiry monitoring before widening coverage.

The checked-in Netlify collector is a different, deliberately isolated path: it can use a Free key to create a private, non-commercial catalog bootstrap in Netlify Blobs under the Free limits of 20 cards/request, 100 requests/day, 1,000 requests/month, and 10 requests/minute. It has no read endpoint, Supabase writer, mapping approval, observation preparation, or publication path. Do not describe its raw pages as production ingestion or expose them to browser users. Its exact quota and recovery procedure is in [JUSTTCG_CATALOG_COLLECTOR.md](JUSTTCG_CATALOG_COLLECTOR.md).

A third, user-triggered function (`justtcg-refresh`) shares that same private boundary and the same Blobs store under a separate `ondemand/` prefix, so it can never collide with the crawl's own `catalog/` keys. It has no Supabase writer either — a card is only ever fetched against a private, operator-seeded identifier ledger (never the real `external_card_mappings`/`catalog_mapping_candidates`, which have no anon/authenticated grants and whose insert paths this source's current `pending` review status blocks anyway), and unmapped cards only ever produce an explicitly-labeled, unreviewed candidate that is never auto-fetched or auto-promoted. It self-limits and reads (never writes) the scheduled crawl's own quota state so it yields headroom instead of risking the crawl's permanently-terminal exhausted state. Full detail is in [JUSTTCG_ONDEMAND_REFRESH.md](JUSTTCG_ONDEMAND_REFRESH.md).

## 5. Catalog and mapping flow

The standard-library module `catalog_mapping.py` produces deterministic rows and hashes:

1. Supply an operator-owned canonical set code.
2. Build set, card, and exact language/edition/finish/variant/condition rows.
3. Insert the canonical rows with service-role credentials.
4. Insert mapping candidates from the packet.
5. Review candidates in `catalog_mapping_candidates`.
6. Record the decision in `catalog_mapping_review_events`.
7. Create the initial `external_card_mappings` row only after approval. Never rewrite an identity/version in place.

Correct an existing mapping only through the guarded service-role RPC; it marks the old row superseded, creates exactly one active successor with a new mapping version, and appends a correction review event:

```sql
select public.supersede_external_card_mapping(
  '<old-mapping-uuid>'::uuid,
  '<replacement-variant-uuid>'::uuid,
  1.0,
  'operator_exact_review',
  'mapping-v2',
  'operator-name',
  'documented correction reason'
);
```

A new all-field exact match receives confidence 0.99 but still carries `initial_mapping_review_required`. Confidence 1.00 is reserved for a manually approved or previously approved immutable external identity. Name-only attachment is never allowed.

For a reviewed one-time correction, bind the exact old identity, replacement identity, review hash, hosted lineage counts, and closed public gates in a supersession manifest. Generate and execute the rollback form first, confirm the final read still shows the old mapping current and no successor, then generate the commit form from the unchanged manifest and verify a terminator-only diff:

```sh
PYTHONPATH=analytics/src python3 -m collectfolio_analytics.mapping_supersession_sql_cli \
  analytics/manifests/tcgcsv-surging-sparks-mapping-supersession-v2.json \
  /secure/mapping-rehearsal.sql --repo-root .
npx --yes supabase@latest db query --linked --file /secure/mapping-rehearsal.sql

PYTHONPATH=analytics/src python3 -m collectfolio_analytics.mapping_supersession_sql_cli \
  analytics/manifests/tcgcsv-surging-sparks-mapping-supersession-v2.json \
  /secure/mapping-commit.sql --repo-root . --commit
diff -u /secure/mapping-rehearsal.sql /secure/mapping-commit.sql
npx --yes supabase@latest db query --linked --file /secure/mapping-commit.sql
```

This specific operation completed on August 8, 2026 and is not rerunnable: the v1 mapping is now superseded by approved mapping `649be0ee-0893-459a-bad6-331a218e069b`. Its immutable operator receipt is [TCGCSV_SURGING_SPARKS_MAPPING_V2.md](receipts/TCGCSV_SURGING_SPARKS_MAPPING_V2.md). Preserve the v1 manifest and review for historical queries; route only new current-snapshot research through `tcgcsv-surging-sparks-current-v2.json`.

## 6. Observation and trend flow

For each approved source refresh:

1. Create a `source_ingestion_runs` row with the exact source and terms-review IDs.
2. Normalize source records without storing raw payloads in public tables.
3. Run `prepare_observation_batch` with approved mappings.
4. Insert accepted/missing/outlier observation rows and their data-quality events.
5. Finish the ingestion run with counts and payload hash.
6. Build one `analytics_runs` record and exact point-in-time trend snapshots.
7. Insert a Tier 0–2 candidate and its candidate-source rows only when the reviewed source has the required public/commercial permissions. A research-only run must emit no candidate.

Only `accepted` observations enter trend features. Late-arriving records are filtered by `available_at`, while missing/outlier/quarantined evidence remains in the private ledger.

For JustTCG, hash the complete bounded response for the ingestion run, retain only normalized private observations, and label the semantics `justtcg_volume_weighted_market`. The provider value is an aggregated market observation, not an itemized completed sale or a seller's executable offer. Voluntary display attribution should read “Market data provided by JustTCG.”

### Centralized bulk-history import

CollectFolio operates the canonical database of normalized historical prices. The coverage
target is every supported catalog variant as an exact provider/currency/language/finish/
condition/price-semantics series. It is acceptable to populate this history later in bulk;
do not weaken exact mapping or provenance merely to claim complete coverage. Card
authenticity is unrelated to this workflow—the stored rows are market-price observations,
not assertions that a physical item is genuine.

Prepare an operator-owned manifest with `mode=operator_centralized_history`, one current
source/terms review, the declared mapping/parser/code versions, one of the four availability
semantics below, approved exact mappings, and bounded series data. A packet supports at
most 2,000 exact series and 100,000 observations. Then run:

```sh
npm run history:import -- /secure/history-manifest.json \
  --output /secure/history-packet.json --pretty
npm run history:import -- /secure/history-manifest.json --sql \
  --output /secure/history-rehearsal.sql
npx --yes supabase@latest db query --linked --file /secure/history-rehearsal.sql

npm run history:import -- /secure/history-manifest.json --sql --commit \
  --output /secure/history-commit.sql
diff -u /secure/history-rehearsal.sql /secure/history-commit.sql
npx --yes supabase@latest db query --linked --file /secure/history-commit.sql
```

All outputs are new mode-0600 files; the writer refuses existing paths. The first SQL file
ends in `ROLLBACK`. Confirm the exact import, ingestion-run, membership, and observation
IDs leave zero new rows after rehearsal. Generate the commit file from the unchanged
manifest, inspect that only the transaction terminator differs, and execute it once.
Replaying the identical committed import is a no-op, including a concurrent identical
execution; deterministic inserts are conflict-safe and the final sealed-content check still
rejects a non-identical collision. Final manifest metadata (including the quality policy)
must be strict finite JSON with string object keys and fit the PostgreSQL-rendered 16 KiB
JSONB limit. A later rolling archive may overlap:
an exact immutable observation is reused through another import-membership row, while any
same-ID or same-record conflict aborts the transaction.

Availability meanings are part of the sealed manifest:

- `source_supplied`: the provider supplies when each value became available.
- `archive_release`: the archive's release time is used conservatively.
- `operator_first_seen`: every source availability equals this import's ingestion instant.
- `observed_at_proxy`: observation time is only a proxy; rows are retained but the entire
  import is permanently ineligible for point-in-time evaluation.

For every newly inserted centralized observation, PostgreSQL preserves the caller value in
`source_available_at`, authors `collectfolio_first_seen_at` with database time, and sets the
effective legacy `available_at` to the later of the two. Consequently any licensed backfill
can support current features only after CollectFolio actually receives it; it cannot be
used at an earlier simulated origin. The sealed import manifest and exact observation
membership are append-only and private. Importing history neither creates a forecast or
publication candidate nor changes `public_price_intelligence`.

A descriptive publication may optionally include at most 180 ascending price points. Feed
the builder only rows exported from the database-owned, service-role-only
`centralized_history_publication_evidence` view. It selects the earliest sealed eligible
import per observation, so a later overlapping archive cannot rewrite eligibility at an
older retrospective cutoff. It excludes `observed_at_proxy`-only membership and exposes
provider availability, CollectFolio first sight, effective availability, and import seal
time. Bound the query to one exact `market_series_id` and the intended cutoff; do not
convert a pre-seal packet into a hosted row.

The candidate builder recomputes the complete trend snapshot from those rows and requires
an exact match before it can emit a trend or observed value. Optional chart history also
requires current raw-price display rights, ranks all revisions/statuses before filtering to
the final accepted revision, and excludes anything unavailable or unsealed at the cutoff,
so a later quarantine cannot resurrect an older accepted value. No public output should be
emitted when those conditions fail.

## 7. Historical research and private forecast flow

The checked-in historical TCGCSV v1 manifest is a single-card research cohort, not a provider-wide production approval. Its archive contract permits exactly 53 weekly samples at most, caps compressed artifacts at 8 MiB and selected members at 2 MiB, stamps each archive-day value as available the following UTC day, and uses a seven-day endpoint-reference tolerance. It intentionally retains the superseded `sv08` mapping so every historical export below continues to resolve against the immutable v1 ledger.

Generate a permission-restricted operator packet and rollback SQL:

```sh
PYTHONPATH=analytics/src python3 -m collectfolio_analytics.operator_cli \
  analytics/manifests/tcgcsv-surging-sparks-research.json \
  --output /secure/new-operator-packet.json
PYTHONPATH=analytics/src python3 -m collectfolio_analytics.private_sql_cli \
  /secure/new-operator-packet.json /secure/new-rehearsal.sql
npx --yes supabase@latest db query --linked --file /secure/new-rehearsal.sql
```

Both writers require a new path and use mode 0600. The generated SQL defaults to `ROLLBACK` and guards the exact research-only review, disabled public flag, denied rights predicate, absent publication row, unused deterministic IDs, private model/prediction statuses, inserted counts, and absence of publication candidates. Query every target ID after rehearsal and require zero rows. Only then generate `--commit`, inspect that the files differ solely at the transaction terminator, and execute the commit file.

Persist only:

- the historical ingestion run, accepted/outlier observation rows, and quality events;
- one point-in-time trend run/snapshot and exact source lineage;
- one forecast run, immutable research model version, and `research_only`/`quarantined` predictions.

Do not create an evaluation before its horizon matures. Every matured target must become either `scored` or `unscorable`; Unscorable rows retain the exact trailing-seven-day target window and reason but never enter metric denominators. Do not create a scorecard without multiple comparable walk-forward origins. Each scorecard persists its matured/scored/unscorable/excluded partition, exact evaluation membership, membership hash, promotion policy, and policy hash. Missing any of the five required baselines forces `insufficient`. Do not create a promotion review without the authenticated operator RPC, and never create a public candidate from the research-only packet.

### Retrospective evaluation gate

Export the exact hosted ledger as bounded JSON and pipe it into the retrospective builder. The builder retains every ledger status in its input hash, uses only `accepted` rows as features/targets, and selects preregistered origins at least 30 days apart from accepted rows' `available_at` values. It checks the current terms review at the actual generation instant; it never pretends that the review or simulation existed at a historical origin.

```sh
npx --yes supabase@latest db query --linked --output-format json \
  "select id, observation_status, observed_at, available_at, market_price::float8 as market_price, quality_score::float8 as quality_score, external_record_id, reason_codes, currency, price_semantics from public.price_observations where variant_id='80b4934a-96db-5f4c-8641-f7c74e0eb949'::uuid and source_id='f24c78f8-d4b9-55a3-a8f7-b05d484c052e'::uuid order by observed_at, available_at, id" \
  | PYTHONPATH=analytics/src python3 -m collectfolio_analytics.walk_forward_cli \
      analytics/manifests/tcgcsv-surging-sparks-research.json - \
      /secure/walk-forward-packet.json --pretty

PYTHONPATH=analytics/src python3 -m collectfolio_analytics.walk_forward_sql_cli \
  /secure/walk-forward-packet.json /secure/walk-forward-rehearsal.sql
npx --yes supabase@latest db query --linked --file /secure/walk-forward-rehearsal.sql
```

The packet and SQL files are new mode-0600 files. The SQL generator rejects historical `created_at` values, unlabeled predictions, cross-run snapshot references, non-30-day cohorts, code/config/evaluation/policy/membership/packet hash changes, per-origin dataset mismatches, public candidates, and promotion reviews. Its transaction rechecks the current strict research-only review at both packet generation and SQL execution, requires every historical origin to predate generation, verifies all inserted counts and labels, and defaults to `ROLLBACK`. Query the deterministic model/run/snapshot/prediction/evaluation/scorecard IDs and require zero rows after rehearsal. Then generate a new `--commit` SQL file from the unchanged packet and execute it.

The August 5 gates produced two private receipts:

- Initial qualification: 53 weekly observations (41 accepted and 12 outlier), the accepted current observation, 12 quality events, one stable snapshot, one damped-momentum baseline model, and five research-only predictions.
- Legacy retrospective packet `72df5fb8417786a83fcd480cff314c2565fa130f8976391e264ea4e6b9d89cf3`: 42 origin snapshots, 210 simulated predictions, 109 stored evaluations, and four scorecards. The 7-day result is `reject`; 30/90/180-day results are `insufficient`; 365 days has no eligible scorecard. It created zero model-promotion reviews, candidates, promotion receipts, or public rows. It predates the 30-day-origin, five-baseline-membership, and immutable-Unscorable contracts; preserve it as historical evidence and never relabel it as promotion-eligible.

Persist an unfavorable scorecard unchanged. Never tune after inspecting the same cohort and then relabel it as held-out evidence. A replacement model needs a new version and independent walk-forward evidence.

Scheduled current-snapshot monitoring is separate from those historical exports. It uses `analytics/manifests/tcgcsv-surging-sparks-current-v2.json` with `--skip-history`, successor mapping `649be0ee-0893-459a-bad6-331a218e069b`, and canonical variant `af796afb-d8d3-5b4b-a95a-417e39e77b0a`. It produces a non-publishing review packet only and never rewrites v1 observations, snapshots, predictions, or scorecards.

### Forecast Lab quality and demand contract

`npm run forecast:lab -- INPUT.json OUTPUT.json --pretty` consumes bounded point-in-time
feature rows and writes a new mode-0600 private packet. It does not fetch provider data,
write Supabase, create a publication candidate, or authorize a model. The 30/90-day engine
uses disjoint origin blocks for selection and residual calibration. Target evidence quality
changes the estimate itself: support is scaled from zero at the admissibility floor to one
at quality one, so the center reaches no change at the floor and the log interval widens
monotonically under a multiplier restricted to `[1, 2]`. `maximumSigma` is the
pre-adjustment cap and does not erase evidence widening. Degenerate empirical calibration
quarantines with an explicit normal fallback; crossed, nonfinite, overflowed, or nonpositive
quantiles fail closed. Below-threshold quality also quarantines the row.

For real observation evidence, never type the feature rows by hand. Export a bounded
service-private panel by joining each declared `market_series` to its immutable ledger:

```sql
select
  observation.id,
  observation.variant_id,
  observation.source_id,
  observation.market_series_id,
  series.identity_hash,
  series.mapping_version,
  series.currency,
  series.language,
  series.finish,
  series.condition_class,
  series.market_condition,
  series.price_semantics,
  card.set_id,
  catalog_set.game,
  observation.observation_status,
  observation.observed_at,
  observation.available_at,
  observation.market_price,
  observation.quality_score,
  observation.external_record_id,
  observation.reason_codes
from public.price_observations observation
join public.market_series series on series.id = observation.market_series_id
join public.catalog_variants variant on variant.id = series.catalog_variant_id
join public.catalog_cards card on card.id = variant.card_id
join public.catalog_sets catalog_set on catalog_set.id = card.set_id
where observation.market_series_id = any(:reviewed_market_series_ids)
  and observation.observed_at <= :bounded_end
  and observation.available_at <= :generated_at
order by observation.market_series_id, observation.observed_at,
         observation.available_at, observation.id
limit 100000;
```

The operator manifest remains `mode=research_only`, includes the current immutable
`source` review, and declares `forecastDataset.mappingVersion`, `codeVersion`, explicit
30/90-day `origins`, policies, and one exact `series` entry per market-series ID. Each
entry includes `variantId`, `marketSeriesId`, `identityHash`, canonical `setId`, `game`,
plus source, currency, language, finish, condition class, market condition, and price
semantics. The compiler derives the cohort key from canonical game and exact-series
fields. Every joined row's `mapping_version`, `identity_hash`, `set_id`, and `game` must
match that declaration.

Compile and run with the same honest generation instant:

```sh
npm run forecast:compile -- \
  /secure/forecast-panel.json /secure/hosted-observations.json \
  /secure/compiled-forecast-manifest.json \
  --generated-at 2026-08-14T12:00:00Z --pretty
npm run forecast:lab -- \
  /secure/compiled-forecast-manifest.json /secure/forecast-lab-packet.json \
  --generated-at 2026-08-14T12:00:00Z --pretty
```

Both outputs are new mode-0600 files and refuse overwrite. The compiler derives only
current price, 90-day robust daily slope, daily volatility, evidence quality, true
elapsed history, and source availability timestamps. It never invents market,
lifecycle, structural, reprint, demand, or acquisition-cost inputs. Future-available
revisions cannot enter earlier origins. Excluded observations remain in the dataset
hash; a hosted row unavailable at generation fails the compile; missing trend fields and
incomplete expected-cadence maturity windows become hashed abstentions. The compiler
records every declared member × origin × horizon once as `feature_abstained`, `open`,
`scored`, or `unscorable`. Forecast Lab validates the exact Cartesian reconciliation and
can emit coverage-only insufficient reports even when no example is scorable.

This local retrospective export does not prove that the caller declared an exhaustive,
outcome-blind inventory. Its audit therefore says `universeCompleteness=declared_only`,
`evidenceTiming=retrospective`, `prospectiveEvidenceEligible=false`, and
`catalogMetadataAuthority=caller_declared_export`. It never emits a
`candidateUniverseId`; the missing independent input seal and retrospective timing are
permanent promotion blockers bound inside every report hash. The current one-series
TCGCSV evidence must report
`insufficient_variant_breadth`; widening the private operator-reviewed research cohort
is the next measurement step, not permission to publish TCGCSV derivatives.
The compiler emits feature lineage
`forecast-features-v2-observation-compiled-v1` and binds the canonical feature-dataset
hash inside its audit. Forecast Lab rejects that lineage if the audit is removed and
rejects a row whose feature hash no longer matches the bound audit.

Forecast Ensemble v2 hard-rejects `useDemandAcceleration=true`; a caller-authored version
string cannot opt demand in. The interim diagnostic uses signed watch flow plus portfolio
adds and divides exact, gap-free periods by
`sum(period_distinct_variant_users * period_days)`. This is an event-intensity proxy per
period-distinct engaged user per calendar day—not observed active-user-days or platform
prevalence. Search and card views remain recommendation-contaminated diagnostics. Current
mutable rows lack immutable availability/input hashes, daily population denominators, and
exposure IDs; they cannot support causal demand claims. Insights and unknown-origin view
events are suppressed, while immutable daily aggregates, a private exposure ledger, fitted
channel weights, and independent holdout/propensity evaluation remain prerequisites for a
future model version.

### Prospective execution and scorecard receipts

Migrations 0017 and 0018 are checked in but not applied by this repository. Rehearse
both against a restored PostgreSQL/Supabase backup and run real role/RLS/transaction
tests before collecting evidence. Migration 0018 intentionally has no executor-key
bootstrap RPC: a database owner must provision `forecast_executor_keys` from a secret
manager in a controlled session. Never put the HMAC secret in source control, a shell
argument, an operator packet, a `service_role` session, or a migration. The normal
service role has no read privilege on that table.

Before any restored-backup rehearsal, run the narrow PostgreSQL contract test in a fresh
database on an isolated local PostgreSQL 15-or-newer cluster. Never point this harness at
a shared, hosted, or otherwise valuable cluster: it creates Supabase role/auth stubs and
applies migrations. The database must have zero public tables, and the explicit opt-in is
required:

```sh
createdb collectfolio_forecast_runtime
COLLECTFOLIO_FORECAST_DB_TEST=collectfolio_forecast_runtime \
  PGDATABASE=collectfolio_forecast_runtime \
  npm run test:forecast-db
```

Set `PGHOST`, `PGPORT`, `PGUSER`, and `COLLECTFOLIO_PSQL` when the disposable cluster is
not on the local defaults. A portable PostgreSQL build whose extension control files are
unavailable may also set `COLLECTFOLIO_PGCRYPTO_LIBRARY` to the absolute `pgcrypto`
library path. The runner deliberately excludes migration 0008 because that migration is
only the unrelated `pg_cron` demand-aggregation schedule; every other checked-in
migration is applied in filename order.

`COLLECTFOLIO_FORECAST_DB_TEST` must exactly equal `PGDATABASE`; a reusable boolean opt-in
is intentionally rejected. Existing login-capable browser roles or a `service_role` that
would need alteration are also rejected rather than mutated.

This local test proves executable migration compatibility for its PostgreSQL version,
browser and forecast-key ACL denials, terminal trend-run and challenged-run row-lock
guards, malformed candidate and HMAC tamper/replay rejection, late-failure rollback,
expired-challenge rejection, complete provider-cost reconstruction, stored receipt-hash
reconstruction, and the database-derived six-origin scorecard lifecycle. It also proves
that receipt tampering aborts scorecard creation and that a late evaluation waits for a
concurrent scorecard transaction before the frozen-run guard rejects it.

The six origins in `tests/postgres/forecast-scorecard-fixture.sql` are explicitly synthetic
historical rows. They exist only to make months-long maturity and origin-spacing branches
executable in a fresh disposable database. They prove scorecard membership, metric, hash,
gate, recommendation, replay, rollback, and locking behavior; they do **not** prove that
prospective timing occurred, that the external executor or model artifact actually ran,
or that the model predicts card prices accurately. The test also does not replace a
restored Supabase backup rehearsal, real hosted roles/RLS checks, `pg_cron` validation,
independent executor isolation, secret provisioning, provider-rights approval, or human
review. Public forecasts therefore remain disabled.

The governed sequence is fixed:

1. Record the provider rights and exact mappings, then create a future-dated
   `prospective_scorecard_plan` through `create_prospective_scorecard_plan`. The first
   origin must still be in the future. Preregister 6–18 exact origin slots with anchors
   at least 22 days apart; each slot has one 24-hour execution window, leaving 21 full
   days between possible origins, and the full schedule must fit
   inside 105–365 days. Missing or replacing a slot invalidates that plan's scorecard;
   the same model version cannot register a replacement plan for that horizon and purpose.
2. Start a `trend_build`, call `seal_trend_expected_input_manifest` before writing any
   trend snapshot, finish the exact manifest-complete run, and create a still-running,
   output-free `forecast_build` with the same immutable policy/model/code lineage.
3. During the next unused scheduled slot, call `begin_prospective_forecast_execution`.
   Deliver its nonce and hashes to the
   isolated executor holding the matching key. Do not compute forecasts before this
   challenge; it expires after five minutes and cannot be replayed or replaced for the
   same forecast run.
4. Use `prepare_prospective_candidate`, `canonical_candidate_output_hash`, and
   `sign_execution_receipt` from `collectfolio_analytics.prospective`. Submit the signed
   result to `record_challenged_prospective_forecast_run`. That one transaction verifies
   the HMAC, independently rehashes exact-series outputs and costs, changes the run to
   `succeeded`, uses challenge issuance as origin, and records the universe, costs,
   predictions, five baselines, pocket inputs, and immutable receipt. It then rebuilds
   the signed canonical hash from the stored typed rows; any numeric, reason-code, cost,
   or timestamp mismatch rolls the transaction back. A prediction-insert guard takes the
   forecast analytics-run row lock before checking for a challenge, so an outside writer
   cannot race receipt finalization or add a prediction that is absent from the signed
   prospective run. The recorder also requires zero pre-existing predictions immediately
   before finalizing the run; only its challenge-scoped transaction setting admits the
   predictions reconstructed from the signed packet.
5. After the plan's final origin plus the horizon has matured, create one dedicated
   succeeded `forecast_evaluation` run whose immutable config contains
   `prospectiveScorecardPlanId`. It must contain exactly one scored or Unscorable outcome
   for every planned prediction and no unrelated evaluation.
6. Call `create_prospective_model_scorecard` with only the plan and evaluation-run IDs.
   The database refuses missing/failed challenges and derives complete membership,
   five-baseline and origin-clustered lift, error/direction/probability/quantile metrics,
   interval coverage, after-cost calibration, selected-pocket outcomes, hashes, reasons,
   and recommendation atomically.

The receipt level is `hmac_executor_principal_v1`: it proves that the independently
provisioned key holder signed the challenged packet and binds configured model,
executor-build, and runtime hashes. It deliberately stores
`artifact_execution_verified=false`; operational isolation and independent runner audit
remain mandatory. Neither RPC publishes forecasts, mutates the public feature flag, or
bypasses the unconditional Forecast Engine v1 promotion block.

## 8. Candidate review and promotion

Before promotion, independently verify:

- mapping UUID, finish, language, condition class, and mapping version;
- dataset, configuration, source-policy, feature, and code hashes;
- current approved commercial/catalog/raw/derived permissions;
- reason codes, staleness, history density, trend state, and attribution;
- payload contains only `observed`, `trend`, and `drivers`; and
- `public_price_intelligence` is still false during qualification.

Model review is separate from descriptive publication. An administrator must place `price_intelligence_operator=true` in the reviewer's server-managed Auth `app_metadata`; user-editable metadata is not sufficient. From a controlled tool using that reviewer's authenticated JWT, call `review_model_promotion(...)`. The RPC refuses cross-model scorecards, incomplete/tampered membership, legacy hashes, missing or below-threshold five-baseline evidence, inadequate case count/calibration, and a reviewer who is not the current operator. The service-role key cannot insert a review directly. This repository intentionally creates no such review.

Record an approval in `intelligence_candidate_reviews` with both attestation booleans true. Then, using a service-role/server-side operator session only:

```sql
select public.publish_descriptive_intelligence('<candidate-uuid>'::uuid);
```

The function refuses unreviewed, rights-denied, non-published, above-Tier-2, fair-value, or forecast payloads. It atomically replaces the public payload and exact lineage and writes an immutable promotion receipt.

Direct browser access should still return no publication while the feature flag is false. Enabling that flag is a separate go-live decision after hosted payload and attribution qualification.

## 9. Rollback and revocation

Prefer logical rollback over dropping governed evidence. For a global incident, disable the database flag first from a privileged operator session:

```sql
update public.product_feature_flags
set enabled = false
where key = 'public_price_intelligence';

```

For a per-card incident, use the service-role-only RPC so the disable is atomic and an append-only control receipt is written:

```sql
select public.disable_public_intelligence(
  '<variant-uuid>'::uuid,
  'incident_reason_code',
  'operator-name'
);
```

Do not directly re-enable that publication row. Recovery requires a new descriptive candidate, current rights/mapping review, and a fresh `publish_descriptive_intelligence` receipt. Re-enable the global flag only after the incident review and read-path verification pass.

For a source-wide incident, set the source inactive or insert a new non-approved terms review and point the source at it. Terms-review rows are append-only after 0006; never edit the old evidence. RLS will deny every dependent publication without deleting provenance.

Use `ENABLE_PRICE_INTELLIGENCE=false` for the browser-surface rollback. Do not delete observation, review, analytics-run, candidate, or promotion ledgers; append corrective events instead.

## 10. Private all-series TCGCSV collection

Migration `0020_tcgcsv_market_universe.sql` and the gated
`tcgcsv-market-universe.yml` workflow implement daily provider-wide raw archive
retention, normalized Parquet history, relational current catalog/prices, full
market card/set features, immutable daily feature evidence, database-timestamped
catalog snapshots, and limited private 30/90/180/365-day estimates.
Portfolio ownership never restricts collection coverage.

The daily lane binds the archive date to the exact upstream `last-updated.txt`
timestamp and fails if any requested card category disappears. Archive and
catalog replays are content-bound, staged duplicates fail closed, and PostgreSQL
recomputes price-tuple hashes before changing current state. These are ingestion
integrity checks; they do not attempt to authenticate a physical card.
Provider-wide `sourceAvailableAt` is the real post-acquisition UTC timestamp,
not archive date plus one day. The older single-card v1 cohort's documented
next-day proxy remains historical lineage and cannot establish provider-wide
point-in-time catalog availability.

The same gated workflow exports a repeatable-read current catalog snapshot with
database-authored availability and price/product reconciliation. A second
repository variable, `TCGCSV_STRUCTURAL_GAP_LAB_ENABLED`, remains false by
default. If separately approved, it produces Sunday-only, private,
provider-native held-out structural-band telemetry. Partial snapshots,
unresolved priced products, insufficient group breadth, or undersized
train/calibration folds produce an immutable abstention. Nothing is wired to the
browser or public publication path. V1 fits Pokémon category 3 only; other game
categories remain exclusion-hashed and require their own future models. The
compiler also reproduces the complete database-sealed feature count/hash and
series-membership hash, so a locally truncated universe abstains. Because this
repository is public, full packets and snapshots stay only in private object
storage; Actions artifacts contain sanitized receipts only.

Do not enable the workflow from the existing bounded review. First record a new
immutable full-corpus private-retention/ML scope review, apply the migration
through the backed-up hosted process, provision the NOLOGIN-derived limited
database credential and immutable private object prefix, and complete a manual
observed run. The complete activation, replay, backfill, and failure runbook is
[TCGCSV_MARKET_UNIVERSE.md](TCGCSV_MARKET_UNIVERSE.md).
