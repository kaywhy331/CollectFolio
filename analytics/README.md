# CollectFolio analytics core

This package contains dependency-free research primitives for price intelligence. It prepares deterministic database packets without database credentials, a production trainer, or an automatic publication path. Its bounded TCGCSV adapter is deliberately research-only: public/commercial source permissions cause it to fail closed, and initial mappings remain operator-reviewed. A separate JustTCG adapter is available for a future licensed production source; it requires a server-supplied key, an active paid subscription attestation, a current approved review with catalog/raw/derived rights, and an operator-approved exact mapping before it can prepare observations.

The point-in-time observation contract records both when a price applies and when it became available. Feature snapshots discard observations that arrived after their cutoff, preventing a backfill from leaking into historical evaluation.

Included primitives:

- endpoint log returns and Theil–Sen log-price slope;
- deterministic canonical set/card/finish identity and conservative mapping quarantine;
- rights-aware market-record preparation with explicit missing/outlier/rejected states;
- median-absolute-deviation volatility, drawdown, density, and provisional trend classification;
- no-change and damped-momentum baselines;
- 30-day rolling-origin maturity/leakage checks, per-origin dataset and code-artifact lineage, explicit Scored/Unscorable targets, and baseline-relative evaluation metrics;
- ordered forecast-quantile validation and explicit rearrangement;
- pull-probability, expected-pack, and hit-probability pack calculations;
- exact reproduction of `video_model_v0` as a research-only audit result;
- reviewable Tier 0–2 observed/trend payloads that cannot contain fair value or forecasts.
- bounded, snapshot-consistent TCGCSV research fetches with deterministic hashes, exact-variant mapping packets, and no public publication path.
- fixed-origin, redirect-refusing JustTCG fetches with header-only authentication, stable card/variant UUIDs, bounded one-year daily history, response limits, and paid/effective/expiring-rights enforcement;
- a fixed-origin Cardbase MTG history adapter with one-key authentication, bounded `Retry-After`, exact vendor/finish/type/currency series, honest first-seen backfill availability, an integrity-checked rolling state ledger, and incremental centralized-history packets that never contain publications or forecasts;
- bounded PPMd history extraction: at most 53 exact-weekly archives, 8 MiB per archive, 2 MiB per selected member, next-day conservative availability, and a seven-day endpoint-reference tolerance;
- bounded centralized historical-price imports for as many as 2,000 exact series and 100,000 observations per packet, with deterministic IDs, immutable import membership, explicit availability semantics, and rollback-first SQL;
- rolling 90-day MAD quality checks that preserve anomalies without allowing obsolete price regimes to lock out all later observations;
- DB-ready private trend/model/prediction evidence with immutable lineage and structurally empty public-candidate output; and
- honest retrospective walk-forward origins with deterministic private evaluations, exact scorecard membership/policy hashes, and operator-gated scorecards; and
- guarded SQL export that defaults to a rollback rehearsal and refuses rights-open, backdated, unlabeled, lineage/hash-tampered, public-candidate, automatically promoted, or already-published packets.
- first-party demand diagnostics built only from exact, gap-free, privacy-threshold-met `aggregate_demand_snapshots` periods ending at or before the feature cutoff. Interim rates are explicitly labeled as events per period-distinct engaged variant user per calendar day—a proxy, not observed active-user-days. Search/card views stay outside the explicit-intent diagnostic, and Forecast Ensemble v2 hard-disables all demand inputs until immutable population and exposure provenance exists.
- a rights-gated catalog seed (`catalog_seed.py` + `catalog_seed_cli.py`) that parses operator-downloaded pokemon-tcg-data-shaped exports into deterministic canonical set/card rows plus era print-run finish variants by rarity (normal/reverse for commons and uncommons, holofoil/reverse for single-star rares, holofoil for chase rarities, an explicit unspecified fallback for unknown rarities), refuses to run without an explicit research-only/approved review acknowledgment with catalog-metadata permission, ingests no imagery, and emits a reviewable no-write packet. `catalog_seed_sql.py`/`catalog_seed_sql_cli.py` turn a packet into guarded, idempotent SQL that re-verifies the registered source review at execution time and defaults to a rollback rehearsal. Its `catalog-sync.yml` workflow is deliberately `workflow_dispatch`-only until the PRD Sec 36.4 rights review completes.
- bounded Wikimedia per-article daily pageview ingestion (`wikimedia.py`) with a mandatory identifying User-Agent/Api-User-Agent, operator-curated character-to-article mappings, redirect refusal, response-size and window bounds, and `available_at` stamped with the retrieval instant so a backfill can never claim historical availability.
- a curated pull-rate registry (`pull_rates.py`, `pull_rate_curation.py`) that checks published one-in-packs figures against the PRD scarcity formulas within a rounding tolerance, requires confidence intervals to bracket the point estimate, derives card-specific probabilities only under the explicit equal-distribution acknowledgment, and emits versioned, review-gated rows for the append-only migration-0009 tables. The checked-in TCGplayer manifest covers 20/22 SV/ME sets with 19 immutable article snapshots and 112 rates; `pull_rate_source_verify.py` fails on changed live bodies, `pull_rate_sql.py` defaults to a guarded rollback, and migration 0014 persists missing/unknown rates without treating them as zero.
- sealed-product identity and price snapshots (`sealed.py`, migration 0010) with unit pack price always recomputed from packs-per-product, timezone-aware observed/available stamps, and review-gated packets, keeping pack cost separate from pull probability.
- a curated market-event registry (`market_events.py`, migration 0011) for reprints/restocks/anniversaries/media/tournament/rotation facts with source URLs, plus a strictly point-in-time `event_age_days` feature helper where a not-yet-occurred event is explicitly absent rather than zero.
- blind pairwise artwork scoring (`artwork.py`, migration 0012): a transparent win-rate scorer with Wilson score intervals, a minimum-vote threshold below which no snapshot exists at all, and vote counts carried on every row so uncertainty is never hidden.
- free-tier storage budget evaluation (`storage_budget.py`) against the PRD Sec 28 allocation table, where unmeasured or unknown areas break the report's completeness flag instead of masquerading as headroom.

Run the suite from the repository root:

```sh
PYTHONPATH=analytics/src python3 -m unittest discover -s analytics/tests -p 'test_*.py'
```

Build a live research packet from an operator-reviewed JSON manifest with:

```sh
PYTHONPATH=analytics/src python3 -m collectfolio_analytics.operator_cli manifest.json --pretty
```

For the one-year archive cohort, prefer a permission-restricted file because the packet contains private source evidence:

```sh
PYTHONPATH=analytics/src python3 -m collectfolio_analytics.operator_cli manifest.json --output /secure/new-packet.json
PYTHONPATH=analytics/src python3 -m collectfolio_analytics.private_sql_cli /secure/new-packet.json /secure/rehearsal.sql
```

The packet writer creates a new mode-0600 file and refuses to overwrite an existing path. The SQL generator also creates a new mode-0600 file and ends with `ROLLBACK` unless `--commit` is explicitly supplied. Run the rollback file against the intended hosted project, verify it left zero target rows, and only then generate and execute the commit form. Both forms recheck the research-only source review, disabled public flag, absent public publication, unused deterministic IDs, inserted counts, private prediction statuses, and absence of publication candidates.

CollectFolio's operated database is the canonical normalized history store for every
supported exact variant. Provider archives can be loaded later in bounded batches from an
operator manifest without changing the client contract:

```sh
npm run history:import -- /secure/history-manifest.json \
  --output /secure/history-packet.json --pretty
npm run history:import -- /secure/history-manifest.json --sql \
  --output /secure/history-rehearsal.sql
npm run history:import -- /secure/history-manifest.json --sql --commit \
  --output /secure/history-commit.sql
```

The packet and both SQL files are created mode 0600 and existing paths are refused. Apply
the rehearsal first and prove it leaves no rows, then generate the commit form from the
unchanged manifest. Exact overlaps reuse the existing immutable observation through a new
import-membership row; conflicting overlaps fail. The database preserves the provider's
claim as `source_available_at`, authors `collectfolio_first_seen_at`, and makes effective
`available_at` no earlier than that database first sight. Thus a newly loaded backfill may
support an estimate made now, but it cannot pretend CollectFolio knew the point at an older
walk-forward origin. `observed_at_proxy` remains storable and permanently marked
point-in-time-ineligible. Import packets contain empty forecast and publication arrays and
do not enable public intelligence.

For a reviewed Magic cohort, the Cardbase collector uses a private first-seen ledger so
daily rolling responses add only new or revised points:

```sh
npm run cardbase:history -- /secure/cardbase-cohort.json \
  --state /secure/prior-first-seen.json \
  --output /secure/cardbase-import.json \
  --state-output /secure/next-first-seen.json
```

The authenticated 365-day path requires exactly one server-side
`CARDBASE_API_KEY`. The CLI rejects key-rotation fields, paces requests below the
published 60/minute free-key limit, and honors `Retry-After`. An initial backfill is
first-known at retrieval time; an exact replay produces a no-op; a corrected historical
amount becomes a new value-digested record first seen at the correction time. Full
configuration and rights boundaries are in
[`CARDBASE_MTG_RESEARCH.md`](../docs/CARDBASE_MTG_RESEARCH.md).

Raw history is optional in a descriptive publication. Both the trend snapshot and any
observed value must first reproduce exactly from the service-private
`centralized_history_publication_evidence` view. That database-owned view selects the
earliest sealed, point-in-time-eligible import per immutable observation, so later overlap
cannot rewrite retrospective eligibility. It carries source availability, database first
sight, and import seal time; proxy-only imports never appear.
When history is included, it additionally requires current raw-price display rights,
contains only the snapshot's exact series, ranks all hosted revisions before accepting the
final status, excludes anything unavailable or unsealed at the cutoff, and emits at most
the latest 180 points in ascending order. These controls concern data provenance and
forecast evaluation—not whether a physical card is authentic.

Build the curated pull-rate registry packet, verify all live primary-source snapshots, and generate rollback-first SQL with:

```sh
PYTHONPATH=analytics/src python3 -m collectfolio_analytics.pull_rate_curation_cli analytics/manifests/tcgplayer-sv-me-pull-rates.json /secure/new-pull-rate-packet.json --verify-sources
PYTHONPATH=analytics/src python3 -m collectfolio_analytics.pull_rate_sql_cli /secure/new-pull-rate-packet.json /secure/new-pull-rate-rehearsal.sql
```

The full coverage map, source anomalies, migration-0014 missing-data extension, and commit procedure are documented in `docs/PULL_RATE_REGISTRY.md`.

To evaluate already-hosted private observations, export only the exact series columns listed in the runbook and pipe the bounded Supabase JSON result into the dedicated builder:

```sh
npx --yes supabase@latest db query --linked --output-format json "<bounded exact-series SELECT>" \
  | PYTHONPATH=analytics/src python3 -m collectfolio_analytics.walk_forward_cli \
      analytics/manifests/tcgcsv-surging-sparks-research.json - \
      /secure/walk-forward-packet.json --pretty
PYTHONPATH=analytics/src python3 -m collectfolio_analytics.walk_forward_sql_cli \
  /secure/walk-forward-packet.json /secure/walk-forward-rehearsal.sql
```

Historical `origin`/`feature_cutoff` values never become execution or creation timestamps. The builder spaces origins by the manifest's preregistered 30 days, uses the actual generation instant for the model, analytics runs, and evaluations, and checks the current strict research-only terms at that instant. Every simulation is labeled `retrospective_walk_forward` and `not_prospectively_generated`. Outliers remain in the ledger hash but not features/targets; every matured target receives either a Scored row or an immutable Unscorable row; quarantined predictions are counted separately from Unscorable outcomes. The SQL transaction rechecks current rights at execution time and recomputes code/config/evaluation/policy/membership/packet hashes plus per-origin dataset lineage.

Forecast Lab accepts a bounded point-in-time feature manifest and writes a new private mode-0600 packet:

```sh
npm run forecast:lab -- /secure/forecast-manifest.json /secure/forecast-lab-packet.json --pretty
```

Do not hand-author those features for real-data evaluation. Compile a joined, bounded
`price_observations` + `market_series` export first, using a research manifest that
declares every exact series and every origin:

```sh
npm run forecast:compile -- \
  /secure/forecast-panel.json /secure/hosted-observations.json \
  /secure/compiled-forecast-manifest.json \
  --generated-at 2026-08-14T12:00:00Z --pretty
npm run forecast:lab -- \
  /secure/compiled-forecast-manifest.json /secure/forecast-lab-packet.json \
  --generated-at 2026-08-14T12:00:00Z --pretty
```

The compiler checks UUID, canonical set/game, source, currency, language, finish,
condition class, market condition, price semantics, mapping version, and the immutable
market-series identity hash on every joined row. It derives the cohort key from the
canonical game plus exact-series fields instead of accepting an operator-authored cohort. It
uses only accepted revisions whose `observed_at` and `available_at` are at or before the
origin, derives the narrow v2 trend feature set through `build_trend_snapshot`, and uses
only accepted observations with complete expected-cadence coverage in the exact
trailing-seven-day maturity window as labels. Any hosted row unavailable at the honest
generation instant fails the entire compile.
Outliers and other excluded states remain in the input hash but never enter features or
targets. Missing slope/volatility, feature, or label evidence becomes a hashed abstention.
The audit contains every caller-declared member × origin × horizon exactly once as
`feature_abstained`, `open`, `scored`, or `unscorable`; all-open and all-unscorable runs
still produce coverage-only insufficient reports.
Compiled rows use the distinct
`forecast-features-v2-observation-compiled-v1` lineage; Forecast Lab requires the audit
for that lineage and validates the declared Cartesian grid, cell/output reconciliation,
cadence evidence, and bound feature-dataset hash. Because the local export has no
independently sealed pre-output inventory, it is explicitly `declared_only`, retrospective,
never prospectively eligible, and emits no `candidateUniverseId` at all. Those permanent
blockers are included inside each report hash, not appended afterward.

Market, lifecycle, structural, reprint, and demand fields remain null until separate
point-in-time inputs exist. Consequently the current one-card TCGCSV research series is
useful for leakage and determinism checks but must remain breadth-insufficient. The next
evidence step is an operator-reviewed private research cohort of at least 50 exact
variants across five sets; it still cannot authorize public use of TCGCSV-derived data.

Forecast Ensemble v2 supports 30/90-day exact-series research only. It compares transparent challengers, selects weights on a later origin block, and calibrates quantiles on a separate embargoed block. Evidence strength is anchored to the admissibility floor: the center reaches no change at that floor and the log interval widens monotonically up to a policy multiplier capped at 2, even when pre-adjustment sigma is saturated. Degenerate empirical calibration quarantines and falls back to a finite normal interval; crossed, nonfinite, overflowed, or nonpositive quantiles fail closed. Demand acceleration is unconditionally withheld in v2, and `useDemandAcceleration=true` is rejected. Existing aggregates contain period-distinct interactors—not daily active-user-days—and lack immutable availability, complete-window hashes, and recommendation-exposure lineage. Insights and unknown-origin view events are suppressed now, but immutable daily denominators, a private exposure ledger, and randomized/propensity-aware evaluation are required before a later model version can test demand.

The manifest must declare `mode=research_only`, a current research-only terms review with every public/commercial permission false, an exact canonical cohort, and the selected TCGCSV product IDs. The first packet emits mapping candidates but no observation rows. An operator must review the exact product/finish identity and add the approved mapping IDs before a later run can prepare private observation rows.

The JustTCG module is intentionally not wired to a checked-in credential or scheduled write. Initial one-year history is stamped `available_at` with the actual retrieval time—not each historical market date—so a newly licensed backfill cannot be used as fake historical availability in a walk-forward scorecard. Future daily refreshes accumulate honest point-in-time evidence. The source remains inactive until the paid plan, immutable terms review, secret, mapping, and database rollout steps in the operator runbook are complete.

The historical Surging Sparks/Pikachu v1 qualification can be run with `npm run qualify:research`. It preserves the original `sv08` mapping evidence, samples 53 weekly archives from 2025-08-02 through 2026-08-01, and then reads the current snapshot; do not use it as the scheduled current mapping. After the guarded August 8 supersession, `npm run qualify:research:current` and the scheduled workflow use the current-only v2 manifest, canonical `sv8` variant, and approved successor mapping. The workflow deliberately passes `--skip-history`: it reads only the small current snapshot, requires the live permission/ingestion/health clock to be current and identical, fails inside the 14-day terms-expiry safety window, and retains its review artifact for 30 days. It has no Supabase secret and performs no database write. The v1 manifest/runbook exports remain immutable historical lineage, and a future review must be appended rather than rewriting either mapping decision.

Evaluation includes log-return MAE, MdAPE, sMAPE, dollar error, direction, Brier/calibration, quantile pinball loss, and 50%/80% interval coverage. It reports evidence; it never promotes a model automatically. All five PRD baselines—no-change, damped momentum, market index, lifecycle cohort, and structural convergence—are mandatory; absent comparisons force `insufficient`. The first hosted retrospective receipt contains 42 origins, 210 predictions, 109 stored evaluations, and four scorecards. Seven days is `reject`; 30/90/180 days are `insufficient`; every scored horizon has negative no-change-relative lift. That receipt predates the 30-day-origin and immutable-Unscorable contracts and remains historical research evidence only.

All public display still passes through the rights-aware Supabase publication boundary, the database `public_price_intelligence` kill switch, and the browser intelligence contract. Descriptive publication uses a service-role-only RPC; model promotion review uses the separate authenticated, app-metadata-gated operator RPC introduced by migration 0006. Nothing in this package enables `public_price_intelligence`.

## Provider-wide TCGCSV market universe

`tcgcsv_universe.py`, `tcgcsv_universe_io.py`, and `tcgcsv_universe_cli.py`
implement the private all-series path: safe full-archive normalization, one
typed Parquet object per day, DuckDB trailing-market features, limited
30/90/180/365-day shadow estimates, set hotness, catalog refresh planning, and
least-privilege PostgreSQL staging/finalization. Provider-wide availability is
the actual post-acquisition timestamp; it is never synthesized from archive
date. Daily card/set feature CSVs and run receipts are immutable objects, and a
repeatable-read export captures database-authored catalog availability, latest
pointers, row provenance, and price/product reconciliation.

`structural_gap.py` and `structural_gap_cli.py` add a separately disabled,
private, current-origin cross-sectional lab. It uses only provider identity,
whole-group train/calibration/test partitions, compiler-owned target-excluding
peer aggregates, and held-out calibrated bands. It emits explicit abstentions
for partial or unreconciled catalogs and cannot claim historical catalog state,
future value, canonical identity, or public eligibility. Install the optional
`market-universe` dependencies before running `npm run tcgcsv:universe`. The
Structural Gap solver is NumPy-only and pins NumPy 2.4.2; packets seal the exact
runtime, solver-source, and full analytics code-artifact lineage, and
coefficients are rounded before use so an environment change cannot masquerade
as the same immutable model artifact.
The path fails closed on missing requested categories, binds normalized archive
and catalog content hashes into replay identities, converts sparse NaN
aggregates into explicit insufficient-history rows, and includes a disposable
PostgreSQL integration harness exposed as `npm run test:tcgcsv-db`.

This path is gated, private, and provider-native. It neither auto-approves a
canonical mapping nor exposes its estimates in the browser. Operational setup,
storage layout, rights prerequisites, commands, and recovery procedures are in
[TCGCSV_MARKET_UNIVERSE.md](../docs/TCGCSV_MARKET_UNIVERSE.md).
