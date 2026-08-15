# Private TCGCSV market universe

## Status

The engineering path is implemented but activation is intentionally gated.

- The daily job runs only when the repository variable
  `TCGCSV_FULL_UNIVERSE_RESEARCH_ENABLED` equals `true`.
- The weekly Structural Gap Lab is independently disabled unless
  `TCGCSV_STRUCTURAL_GAP_LAB_ENABLED` equals `true`. Keep it false until the
  private object lane, complete catalog snapshots, and source review are ready.
- The current TCGCSV decision permits bounded private research. Before enabling
  full-corpus retention, record a new immutable source review that explicitly
  covers the intended scope, retention, machine-learning use, and object store.
- TCGCSV data, catalog metadata, shadow estimates, and rankings remain private.
- This workflow installs no public publisher and does not change
  `public_price_intelligence`.
- Physical-card authenticity is unrelated. The stored facts are provider price
  observations and catalog identities, not authentication claims.

## Product contract

Within CollectFolio's private research plane, TCGCSV is the authoritative
broad-market history baseline. Its daily archive—not holdings-triggered refreshes
or full-catalog overlay API crawls—supplies the across-the-board daily price
append. Cardbase and other APIs may supplement selected series with targeted
live/history overlays, but they do not replace that daily archive.

Portfolio and search activity never determine ingestion coverage. Every daily
run processes every price series in the reviewed card-category scope. Customer
holdings, watchlists, and searches later personalize which approved results are
shown and how they are ranked.

For each provider product/finish series, the private system retains:

- the daily archive date and conservative source-availability time;
- category, group/set, product, and subtype/finish identity;
- low, mid, high, market, and direct-low price values;
- immutable archive, member, tuple, scope, parser, and Parquet hashes;
- current 7/30/90/180/365-day returns where endpoints exist;
- 30-day slope and volatility, 365-day drawdown and history density;
- private momentum telemetry (`opportunity_score`) and group/set hotness; the
  legacy field name is not a value-pocket detector;
- limited research estimates for 30, 90, 180, and 365 days.

The separate Structural Gap Lab estimates a held-out current-price band. Its
provider-native `structural_gap` telemetry is a research candidate for later
prospective testing, not a future-return claim or an appraisal.

The browser never reads these provider-native tables. Search-result forecasts
continue to come only from an exact-series, rights-approved
`card_intelligence_publications` payload.

## Storage architecture

```text
one daily TCGCSV PPMd archive
              |
              +-- immutable private object: raw/archive_date=YYYY-MM-DD/...
              |
              +-- one normalized Zstandard Parquet object per date
              |        history/archive_date=YYYY-MM-DD/prices.parquet
              |                         |
              |                         +-- DuckDB full-market feature pass
              |                                +-- immutable card/set feature CSVs
              |
              +-- PostgreSQL sealed receipt and current-state merge
                       +-- current catalog and prices for every series
                       +-- current card and set features
                       +-- unresolved-product retry queue
                       +-- repeatable-read catalog snapshot + reconciliation receipt
                                      |
                                      +-- disabled weekly Structural Gap Lab
```

PostgreSQL is deliberately not the provider-wide daily fact store. At the
measured August 14, 2026 scale, daily relational snapshots would add about 193
million rows per year, and five-price change segments would still add about 87
million rows per year. The compressed archives were approximately 1.5 GB per
year. Parquet is the queryable historical layer; PostgreSQL is the application
and current-state layer.

## Database migration

Migration `0020_tcgcsv_market_universe.sql` adds:

- `tcgcsv_archive_runs`, archive categories, and group receipts;
- archive price, market-feature, and set-feature staging;
- `tcgcsv_price_current`, `tcgcsv_market_features_current`, and
  `tcgcsv_set_features_current`;
- independent catalog runs and category/group/product staging/current tables;
- `tcgcsv_unresolved_products` and `tcgcsv_sync_state`;
- guarded begin/finalize functions and advisory locks;
- a restricted `collectfolio_tcgcsv_ingest` NOLOGIN role.

Staging is invisible to the application. Finalization rechecks the current
unexpired research-only review, expected counts, group coverage, series hashes,
price-tuple hashes, and finite metrics. Raw and Parquet object URIs plus the
immutable card-feature and set-feature object URIs, and their normalized CSV,
feature CSV, scope, and catalog-content hashes, are bound into immutable run
identities. The current snapshot changes in one transaction. Identical
sealed replay is a no-op; different content for an existing archive date or
catalog source timestamp fails for operator review. Feature hashes are
caller-authored content checksums, not card-authenticity claims; concrete values
also participate in every current-state update so a stale checksum cannot hide
a changed estimate. Each sealed run records and returns `currentStateApplied`.
An out-of-order historical archive or catalog run is retained as immutable
evidence with `currentStateApplied=false`, while application-facing current
tables, the unresolved-product queue, and latest sync pointers remain on the
newer source watermark.

The archive run and catalog run are separate. A partial product refresh does
not discard the day's complete price archive.

## Daily workflow

The private workflow runs at `06:41 UTC` and uses one concurrency lane.

1. Read and validate one exact `last-updated.txt` timestamp with the configured
   identifiable User-Agent; bind both the archive date and source timestamp to it.
2. Restore existing private Parquet history.
3. Download the target price archive once.
   Record `sourceAvailableAt` only after CollectFolio finishes acquiring that
   exact object. The archive date and provider timestamp are not substituted for
   the real acquisition time, including during backfill.
4. Extract into an isolated temporary directory with file-count, path, expanded
   size, response-size, and timeout limits.
5. Classify the reviewed card-category scope from provider labels plus four
   reviewed label-less card-game exceptions. Fail closed if any requested card
   category is absent from the archive instead of silently shrinking coverage.
6. Stream all scoped price rows into deterministic CSV.
7. Write one sorted Zstandard Parquet file for the date.
8. Query the trailing 368 days with DuckDB and produce one current feature row
   per current price series, including explicit insufficient rows.
9. Produce one current set-feature row per archive group, including empty or
   insufficient groups.
10. Upload and byte-verify the raw, Parquet, market-feature CSV, and set-feature
    CSV objects before committing database pointers.
11. Stage and atomically finalize the archive/current-state merge.
12. Fetch categories and card-category group lists.
13. Fetch products for new groups, semantically changed groups, changed
    `modifiedOn` values, unresolved product groups, and a deterministic
    one-seventh rotating audit.
14. Recheck `last-updated.txt`; never seal across an upstream rebuild.
15. Finalize the catalog as `sealed` or `partial` and retain a retry receipt.
16. Under `REPEATABLE READ` and the restricted ingest role, export the complete
    current catalog with database-authored `catalogAvailableAt`, latest run
    pointers, the sealed feature hash/count, an exact current-series membership
    hash, row counts, per-row run provenance, and a content hash. Record an
    explicit abstention if the refresh is partial or any current priced product
    is unresolved/missing.
17. Retain content-bound packets, ingest receipts, and the catalog snapshot in
    the private object store. On Sundays only, and only behind the separate
    disabled flag, compile one immutable Structural Gap Lab origin. Key that
    weekly object by the database-authored catalog-origin date, never by the
    upstream archive date.

The client enforces at least 110 ms between loop requests and stops below 9,000
requests. When the full-universe workflow is enabled, the older one-card daily
qualification workflow is skipped so CollectFolio does not operate two daily
TCGCSV pull loops.

## Forecast-estimate semantics

The first provider-wide estimator is intentionally transparent:

- it requires a current positive market price, at least 14 observations,
  history density, a 30-day log slope, and 30-day volatility;
- it applies 25% damped momentum with a symmetric 0.70 log-return cap;
- uncertainty expands with square-root time and produces q10/q25/q50/q75/q90;
- confidence falls with longer horizons and increases with observation coverage;
- every estimate is stored with `researchOnly=true`, model
  `tcgcsv-damped-momentum-shadow-v1`, and status `limited`;
- insufficient series receive no invented forecast.

These estimates establish a complete daily prediction/evaluation dataset. They
are a baseline, not the final differentiating model and not a claim of future
accuracy. The existing prospective ledger and scorecards must establish which
cohorts and horizons beat no-change, momentum, and market baselines before any
licensed publication path is added.

## Structural Gap Lab semantics

`structural_gap.py` consumes only the current market-feature CSV bound to the
archive receipt and the database-authored catalog snapshot created after that
archive. It refuses historical structural origins: older catalog rows cannot be
reconstructed until their own prospective snapshots actually exist.

The v2 lab is explicitly scoped to TCGCSV category 3 (Pokémon). The full
provider archive remains hash-bound and every non-category-3 identity is counted
inside an immutable exclusion manifest, but no model or fold can mix games.
Later games require separate category-specific policies, minimum-evidence gates,
artifacts, and evaluation; they must never be pooled into the Pokémon fit.

An eligible origin requires at least 50 positively priced provider series in at
least five complete groups. The compiler creates subtype, rarity, card-type,
set-age, and leave-one-series-out group-peer features. Each peer aggregate
contains its member count and membership hash, and the compiler rejects the
target identity if it appears in that membership. Five deterministic folds keep
whole groups disjoint: one group bucket is held out, a different bucket
calibrates q10/q25/q50/q75/q90, and the remaining groups train the robust ridge
model. Every fold requires at least 40 training and 12 calibration rows; a
shortfall abstains the whole origin.

The solver has one execution path: pinned NumPy 2.4.2 with float64 linear
algebra. Coefficients are rounded to 12 decimal places before calibration,
prediction, or artifact hashing. Every eligible or abstention packet seals the
solver version, actual NumPy runtime version, coefficient precision, SHA-256 of
the solver implementation source, and the full analytics code-artifact hash.
That lineage is also bound into every fold and model-artifact hash. Persistence
rejects a prior packet from any different solver lineage instead of silently
mixing numerical implementations.

Before any fit, the compiler independently reproduces the full feature-file
identity manifest and requires exact equality with the database snapshot's
sealed archive run ID, availability, feature object hash, feature count, current
row count, and series-membership hash. Missing-price, out-of-category,
catalog-incomplete, and peer-gate exclusions receive reason counts and an exact
exclusion-manifest hash. A caller cannot truncate the universe merely by
rewriting a local packet.

Outputs exist only for held-out rows and carry provider identity, price-band
position, structural gap ratio, fold/artifact/input hashes, and either no label
or `structural_gap`. `persistent_below_band` requires the same series to remain
below-band at three consecutive eligible Sunday origins spanning at least 14
days; a missing/ineligible week or cadence gap resets persistence. Prior origins
must use the same source, model version, category, policy, solver lineage, and
current-origin contract. These labels
are private telemetry. They do not claim canonical card identity, future value,
physical authenticity, or permission to publish. The next evaluation layer must
add a historical market-index challenger and collect matured outcomes before
this signal may enter a forecast model.

Search results now support approved values for:

```text
name | type | set | current price | rolling 30D trend
1 month estimate | 3 month estimate | 6 month estimate | 1 year estimate
```

Missing or private-only estimates remain visibly unavailable; the browser does
not reconstruct or substitute them.

## Required infrastructure

Before applying or enabling anything hosted:

1. Back up the hosted database and apply migration `0020` through the normal
   reviewed migration process.
2. Create a dedicated secret-bearing PostgreSQL login outside the repository,
   then grant it only `collectfolio_tcgcsv_ingest`. The adapter executes
   `SET LOCAL ROLE collectfolio_tcgcsv_ingest`; do not supply a Supabase
   service-role credential.
3. Create a private S3-compatible prefix with public access blocked. Enable
   versioning or object lock and deny overwrites/deletes for the ingest identity.
4. Give that identity read/write access only to the TCGCSV prefix.
5. Record the expanded full-corpus source review and update the source's current
   immutable review row.
6. Configure the repository values below only after the preceding controls pass,
   then enable the lane. The checked-in `06:41 UTC` daily schedule safely skips
   while `TCGCSV_FULL_UNIVERSE_RESEARCH_ENABLED` is not `true`; manual dispatch
   uses the same gate and contract. Cardbase remains a targeted exact-series MTG
   overlay, not the full-catalog daily acquisition path.

Repository variables:

```text
TCGCSV_FULL_UNIVERSE_RESEARCH_ENABLED=false
TCGCSV_STRUCTURAL_GAP_LAB_ENABLED=false
TCGCSV_SOURCE_ID=<tcgcsv-research source UUID>
TCGCSV_TERMS_REVIEW_ID=<current immutable review UUID>
TCGCSV_USER_AGENT=CollectFolio/<version> <identifiable contact>
TCGCSV_ARCHIVE_S3_URI=s3://<private-bucket>/<private-prefix>
TCGCSV_ARCHIVE_S3_ENDPOINT=<optional S3-compatible endpoint>
TCGCSV_ARCHIVE_REGION=<region, default us-east-1>
```

Repository secrets:

```text
TCGCSV_INGEST_DATABASE_URL=<dedicated limited login URL>
TCGCSV_ARCHIVE_ACCESS_KEY_ID=<prefix-scoped object identity>
TCGCSV_ARCHIVE_SECRET_ACCESS_KEY=<prefix-scoped object secret>
```

Do not put credentials in an archive packet, workflow artifact, database
metadata, object URI, or repository file. Migration 0020 accepts only path-based
`s3://bucket/key` object references and rejects user-info, query, and fragment
delimiters.

The repository is public. Full archive packets, catalog packets/snapshots, and
Structural Gap Lab outputs must remain only in the private object prefix. The
GitHub Actions artifact contains sanitized count/hash/status receipts; never add
the sensitive packets back to `actions/upload-artifact`.

The analytics CI lane provisions a disposable PostgreSQL 16 service, applies
the full migration chain through the forecast runtime harness, and then runs the
restricted-role TCGCSV archive/catalog harness against that same fresh schema.
This keeps migration, ACL, staging cleanup, replay, monotonic-current-state, and
catalog-snapshot behavior under continuous runtime coverage.

## Local preparation

Install the optional backend dependencies and ensure `7z` is available:

```sh
python3 -m venv /secure/path/collectfolio-universe-venv
/secure/path/collectfolio-universe-venv/bin/pip install -e 'analytics[market-universe]'
```

Prepare without a database write:

```sh
PYTHONPATH=analytics/src python3 -m collectfolio_analytics.tcgcsv_universe_cli \
  prepare-archive \
  --source-id "$TCGCSV_SOURCE_ID" \
  --terms-review-id "$TCGCSV_TERMS_REVIEW_ID" \
  --output-dir /secure/new-tcgcsv-run \
  --archive-object-uri s3://private/path/raw/archive_date=YYYY-MM-DD/prices-YYYY-MM-DD.ppmd.7z \
  --parquet-object-uri s3://private/path/history/archive_date=YYYY-MM-DD/prices.parquet \
  --feature-object-uri s3://private/path/features/archive_date=YYYY-MM-DD/market-features.csv \
  --set-feature-object-uri s3://private/path/features/archive_date=YYYY-MM-DD/set-features.csv \
  --history-parquet '/secure/history/archive_date=*/prices.parquet'
```

Upload and independently verify all four immutable objects before running:

```sh
PYTHONPATH=analytics/src python3 -m collectfolio_analytics.tcgcsv_universe_cli \
  ingest-archive /secure/new-tcgcsv-run/archive-packet.json
```

Catalog refresh and ingestion:

```sh
PYTHONPATH=analytics/src python3 -m collectfolio_analytics.tcgcsv_universe_cli \
  sync-catalog \
  --source-id "$TCGCSV_SOURCE_ID" \
  --terms-review-id "$TCGCSV_TERMS_REVIEW_ID" \
  --output /secure/new-catalog-packet.json \
  --use-database-state --ingest
```

Export the database-timestamped catalog snapshot after successful catalog
ingestion:

```sh
PYTHONPATH=analytics/src python3 -m collectfolio_analytics.tcgcsv_universe_cli \
  export-catalog-snapshot \
  --source-id "$TCGCSV_SOURCE_ID" \
  --output /secure/new-catalog-snapshot.json
```

Compile a private current-origin structural packet. Supply prior immutable
weekly packets only to evaluate persistence:

```sh
PYTHONPATH=analytics/src python3 -m collectfolio_analytics.structural_gap_cli \
  --features /secure/new-tcgcsv-run/market-features.csv \
  --archive-packet /secure/new-tcgcsv-run/archive-packet.json \
  --catalog-snapshot /secure/new-catalog-snapshot.json \
  --prior-packet /secure/prior-week-1.json \
  --prior-packet /secure/prior-week-2.json \
  --output /secure/new-structural-gap.json
```

All packet writers refuse existing paths. Historical backfill uses the same
`prepare-archive` contract with an explicit archive date/file and a matching
explicit `--source-updated-at`; mismatched dates are rejected. Backfill is run
in bounded, checkpointed batches. A backfill older than the current watermark
seals with `currentStateApplied=false`; its Parquet history remains available to
time-series feature compilation without rolling current PostgreSQL state
backward. Its availability remains the actual acquisition timestamp, and it
cannot create a historical Structural Gap Lab origin because no matching
point-in-time catalog snapshot existed then. Never
parallelize backfill against the daily lane or exceed the provider's documented
request guidance.

## Recovery

- Object uploaded, database failed: reuse the exact object and replay the packet.
- Official adapter interruption: the transaction rolls back; replay the exact
  packet. A persisted partially staged run can only come from a nonstandard or
  manually committed path; strict duplicate inserts reject it, so stop for
  operator inspection instead of mixing two packets.
- Same date and same identity already sealed: finalization returns the receipt.
- Older archive or catalog run: confirm `currentStateApplied=false`; retain its
  immutable history and do not manually repoint current tables.
- Same date with different archive content: stop for operator review.
- Same catalog source timestamp with different normalized content: stop for
  operator review; do not overwrite the earlier sealed or partial receipt.
- Catalog endpoint failed: preserve the sealed price run, finalize catalog
  `partial`, and retry the affected group in a later run.
- Unknown product in a price archive: keep its provider price series current,
  enqueue its category/group/product identity, and prioritize the group catalog.
- Source timestamp changed mid-run: discard no source object automatically;
  leave the unsealed local packet for inspection and retry from a fresh run.
