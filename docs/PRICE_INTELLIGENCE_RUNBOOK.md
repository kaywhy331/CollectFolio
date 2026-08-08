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
