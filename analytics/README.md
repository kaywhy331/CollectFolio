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
- bounded PPMd history extraction: at most 53 exact-weekly archives, 8 MiB per archive, 2 MiB per selected member, next-day conservative availability, and a seven-day endpoint-reference tolerance;
- rolling 90-day MAD quality checks that preserve anomalies without allowing obsolete price regimes to lock out all later observations;
- DB-ready private trend/model/prediction evidence with immutable lineage and structurally empty public-candidate output; and
- honest retrospective walk-forward origins with deterministic private evaluations, exact scorecard membership/policy hashes, and operator-gated scorecards; and
- guarded SQL export that defaults to a rollback rehearsal and refuses rights-open, backdated, unlabeled, lineage/hash-tampered, public-candidate, automatically promoted, or already-published packets.
- first-party demand-velocity and acceleration features (watchlist, search, portfolio-add, view) built only from privacy-threshold-met `aggregate_demand_snapshots` periods ending at or before the feature cutoff, so a below-threshold or future period can never enter a windowed rate.
- a rights-gated catalog seed (`catalog_seed.py` + `catalog_seed_cli.py`) that parses operator-downloaded pokemon-tcg-data-shaped exports into deterministic canonical set/card rows plus unspecified-finish placeholder variants, refuses to run without an explicit research-only/approved review acknowledgment with catalog-metadata permission, ingests no imagery, and emits a reviewable no-write packet. Its `catalog-sync.yml` workflow is deliberately `workflow_dispatch`-only until the PRD Sec 36.4 rights review completes.
- bounded Wikimedia per-article daily pageview ingestion (`wikimedia.py`) with a mandatory identifying User-Agent/Api-User-Agent, operator-curated character-to-article mappings, redirect refusal, response-size and window bounds, and `available_at` stamped with the retrieval instant so a backfill can never claim historical availability.
- a curated pull-rate registry validator (`pull_rates.py`) that checks published one-in-packs figures against the PRD scarcity formulas within a rounding tolerance, requires confidence intervals to bracket the point estimate, derives card-specific probabilities only under the explicit equal-distribution acknowledgment, and emits versioned, review-gated rows for the append-only migration-0009 tables.
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

The manifest must declare `mode=research_only`, a current research-only terms review with every public/commercial permission false, an exact canonical cohort, and the selected TCGCSV product IDs. The first packet emits mapping candidates but no observation rows. An operator must review the exact product/finish identity and add the approved mapping IDs before a later run can prepare private observation rows.

The JustTCG module is intentionally not wired to a checked-in credential or scheduled write. Initial one-year history is stamped `available_at` with the actual retrieval time—not each historical market date—so a newly licensed backfill cannot be used as fake historical availability in a walk-forward scorecard. Future daily refreshes accumulate honest point-in-time evidence. The source remains inactive until the paid plan, immutable terms review, secret, mapping, and database rollout steps in the operator runbook are complete.

The checked-in Surging Sparks/Pikachu qualification can be run with `npm run qualify:research`. It samples 53 weekly archives from 2025-08-02 through 2026-08-01 and then reads the current snapshot. The scheduled research workflow deliberately passes `--skip-history`: it reads only the small current snapshot, requires the live permission/ingestion/health clock to be current and identical, fails inside the 14-day terms-expiry safety window, and retains its review artifact for 30 days. This avoids repeatedly downloading a completed historical backfill. The workflow has no Supabase secret and performs no database write. Once the review expires or enters the warning window, an operator must record a new immutable review rather than rewriting or silently extending the old decision.

Evaluation includes log-return MAE, MdAPE, sMAPE, dollar error, direction, Brier/calibration, quantile pinball loss, and 50%/80% interval coverage. It reports evidence; it never promotes a model automatically. All five PRD baselines—no-change, damped momentum, market index, lifecycle cohort, and structural convergence—are mandatory; absent comparisons force `insufficient`. The first hosted retrospective receipt contains 42 origins, 210 predictions, 109 stored evaluations, and four scorecards. Seven days is `reject`; 30/90/180 days are `insufficient`; every scored horizon has negative no-change-relative lift. That receipt predates the 30-day-origin and immutable-Unscorable contracts and remains historical research evidence only.

All public display still passes through the rights-aware Supabase publication boundary, the database `public_price_intelligence` kill switch, and the browser intelligence contract. Descriptive publication uses a service-role-only RPC; model promotion review uses the separate authenticated, app-metadata-gated operator RPC introduced by migration 0006. Nothing in this package enables `public_price_intelligence`.
