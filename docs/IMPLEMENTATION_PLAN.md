# CollectFolio Implementation Plan and Status

**Baseline date:** July 31, 2026

## Delivery strategy

The product is being delivered in a free-first sequence that protects the core ingestion loop before expanding provider coverage.

## Milestone 0 — repository and architecture

- [x] Establish product requirements and acceptance criteria.
- [x] Select static local-first PWA architecture.
- [x] Remove required paid services and server-side image compute.
- [x] Define provider-independent catalog and holding models.
- [x] Add CI, validation, build, and Netlify configuration.

## Milestone 1 — mobile product shell

- [x] Home, Search, Add, Portfolio, and Profile navigation.
- [x] Mobile-first layout with desktop adaptation.
- [x] Installable manifest and service worker.
- [x] Dark, light, and system appearance settings.
- [x] Accessible labels, focus states, and reduced-motion handling.

## Milestone 2 — local portfolio

- [x] IndexedDB data layer.
- [x] Holding create, update, delete, filter, and sort.
- [x] Cost basis, market value, gain/loss, and return formulas.
- [x] Daily portfolio snapshots and SVG trend visualization.
- [x] Category allocation and highest-value holdings.
- [x] Full JSON backup and CSV export.
- [x] Demo collection for visual validation.

## Milestone 3 — free catalog search

- [x] Pokémon TCG API adapter.
- [x] Scryfall adapter.
- [x] YGOPRODeck adapter with printing expansion.
- [x] Concurrent failure-isolated search.
- [x] Local query cache.
- [x] Variant/finish price selection.
- [x] Explicit price source and update disclosure.
- [x] Keep Pokémon catalog lookup metadata-only and exclude legacy TCGplayer/Cardmarket-derived values, finish selectors, and unversioned historical snapshots from display or valuation until a licensed publication exists.
- [x] Manual universal entry for sports, comics, and other collectibles.

## Milestone 4 — image ingestion

- [x] Single and multi-image capture/upload.
- [x] Client-side rectangle detection.
- [x] Editable boundary overlay.
- [x] Add, move, resize, delete, and retry controls.
- [x] Configurable binder grid split.
- [x] Compressed crop generation.
- [x] Lazy OCR and query extraction.
- [x] Candidate visual-hash reranking where CORS permits.
- [x] Per-crop alternate selection, retry, delete, custom fallback, and approval.
- [x] Batch add limited to approved crops.
- [x] Draft scan persistence and review-state resume.

## Milestone 5 — optional cloud sync

- [x] Supabase URL preconfigured from the supplied project.
- [x] Runtime public-key configuration.
- [x] Password sign-up/sign-in, magic-link callback consumption, refresh, and sign-out.
- [x] Holdings pull, merge, upsert, and deletion-tombstone propagation.
- [x] Initial database migration and Row Level Security.
- [x] Apply the migration to the hosted Supabase project.
- [x] Copy the Supabase publishable key into the explicit Netlify staging environment.
- [x] Configure the staging Site URL plus staging, deploy-preview, branch-preview, and local redirect URLs.
- [x] Run a two-account, three-browser-context sync and Row Level Security qualification test.

## Milestone 6 — Netlify release

- [x] `netlify.toml` build and SPA routing.
- [x] Security and cache headers.
- [x] Production build validation.
- [x] Create and use the explicit `collectfolio-staging` Netlify project.
- [x] Configure staging environment variables.
- [x] Confirm a production-context staging deploy, hosted PWA shell, service-worker offline reload, and deep links.
- [x] Add staging and preview URL patterns to Supabase Auth redirects.
- [x] After merge, publish `main` to the explicit `collectfolio-staging` production-context site and repeat hosted regression checks.
- [ ] Select the final public domain and repeat physical PWA installation checks on Android/Chrome and iOS/Safari.

## Hosted staging qualification — August 4, 2026

- Supabase project `agmjgyyvhfcivbwdlvzk` has migration `0001_initial.sql` recorded remotely.
- All five public tables exist with Row Level Security enabled, four own-user policies each, and authenticated CRUD grants.
- Supabase Auth uses `https://collectfolio-staging.netlify.app` as its Site URL and permits staging, Netlify preview, and local development callbacks.
- Netlify site `05b0e479-ad35-4466-a5c0-fa40d93d1a77` was explicitly deployed in the production context; deploy `6a71fe711d951a3a08af86bf` contains the browser-safe publishable key.
- Hosted guest persistence, JSON/CSV export, deletion/reload, service-worker offline reload, and all three free catalog providers were qualified.
- Hosted cloud qualification passed with user A on two isolated browser contexts and user B on a third: create/pull sync passed, user B's row was invisible to user A, a cross-user write was rejected with HTTP 403, and a deletion tombstone removed the stale second-client copy without resurrection.
- All temporary qualification users and rows were removed; the final residue audit returned zero QA users, QA holdings, orphaned deletion rows, and orphaned profiles.

## Catalog and OCR regression qualification — August 4, 2026

- Provider-defined Scryfall 404 and YGOPRODeck 400 no-match responses return empty result sets instead of false outage warnings; genuine upstream failures remain visible.
- Pokémon search requests only the fields CollectFolio uses, follows pages of up to 250 cards with bounded transient retries, and falls back to the free TCGdex catalog when the primary provider exhausts those retries. Qualification returned the complete primary Pikachu set (177 cards) rather than the former 24-card cap; the fallback independently returned 204 image-backed Pikachu records during outage testing.
- Visible catalog images load eagerly, retry their alternate provider URL, and fall back to a labeled placeholder only after both URLs fail. The CSP permits all provider image hosts for both browser images and service-worker fetches.
- OCR permits WebAssembly compilation without enabling broad `unsafe-eval`, bounds image/script/recognition/worker operations, disables duplicate identification, and recovers interrupted persisted scans into a retryable error state.
- `npm run check` passed validation, all 34 tests, and the production build. Immutable Netlify draft `6a721904ce193f1d29302c26` passed the hosted Playwright qualification twice (6/6): all-provider Pikachu coverage without false warnings, forced-outage TCGdex fallback, Pokémon/Scrydex/TCGdex/Scryfall/YGOPRODeck image loading, and a real two-card Tesseract run that left `Identifying` successfully.

## Main release qualification — August 4, 2026

- PR #1 merged the eleven logical implementation commits into `main` as merge commit `ac6b6bc6f4adff670eb501e1e056e69b926aee25`; the merge-triggered GitHub Actions run passed.
- A clean checkout of merged `main` passed validation, all 34 tests, and the production build.
- Explicit-site production-context Netlify deploy `6a7227a3d9d91b32f07ac6a0` published the merged application tree to `https://collectfolio-staging.netlify.app`.
- Post-merge hosted qualification passed all three gates: live multi-provider Pikachu discovery and images, forced PokéTCG outage with TCGdex fallback, and real two-card Tesseract OCR leaving `Identifying`.

## Set-aware Pokémon search qualification — August 4, 2026

- Natural-language Pokémon queries now resolve the longest exact set-name phrase before parsing the remaining card name and number. `Pitch Black` becomes a set-only query, while `Gengar Pitch Black` becomes the intersection of that name and set; `Base Set 2` is not misread as card number 2.
- Set metadata is browser-cached for 24 hours. Primary set-ID resolution is bounded to one second with a five-minute failure backoff, and recognized sets can fall through to complete TCGdex set detail without presenting an authoritative empty intersection as an outage.
- Live provider qualification returned all 120 image-backed `Pitch Black` cards and four `Mega Darkrai ex Pitch Black` printings. `Gengar Pitch Black` correctly returned zero because the current 120-card provider set contains no Gengar printing.
- `npm run check` passed static validation, all 38 tests, and the production build. Catalog response cache v5 and service-worker shell v0.1.5 ensure older cached search behavior is replaced on the next deployment.

## Pilot qualification checklist

Before inviting testers:

1. Apply `supabase/migrations/0001_initial.sql`.
2. Set `SUPABASE_URL` and `SUPABASE_ANON_KEY` in Netlify.
3. Connect GitHub and deploy from `main` with `dist` as the generated publish directory.
4. Test guest mode in a fresh browser profile.
5. Add one Pokémon, Magic, and Yu-Gi-Oh! result.
6. Add one custom sports card and one custom comic.
7. Run a clean 3×3 binder-grid scan.
8. Verify detection editing on touch and mouse.
9. Verify first-use OCR on Wi-Fi and a throttled mobile connection.
10. Export a backup, clear local data, and restore it.
11. Sign in on two browsers and verify create, update, and deletion synchronization.
12. Install the PWA on Android/Chrome and iOS/Safari.
13. Confirm service worker update after incrementing its cache version.

## Milestone 7 — price-intelligence foundation

- [x] Preserve the five-action shell and add Holdings, Watchlist, and Forecasts inside Portfolio.
- [x] Add offline exact-variant watch/unwatch from Search, holdings, and scan review.
- [x] Upgrade IndexedDB to version 3 with tombstone-safe watchlists and version 2 backup export.
- [x] Add provider-to-canonical identity bridge without rewriting existing holding IDs.
- [x] Add cloud watchlist LWW synchronization with corrected composite-owner foreign keys and RLS.
- [x] Add versioned source-rights governance and a narrow public publication boundary.
- [x] Add cached rights-filtered publication hydration and reject malformed or over-tier payload layers in the browser.
- [x] Add a dependency-free point-in-time analytics core with robust trends, required baselines, walk-forward leakage/evaluation gates, scarcity math, quantile gates, and `video_model_v0` audit reproduction.
- [x] Add synthetic analytics regression tests and an isolated Python 3.12 CI workflow.
- [x] Add runtime/server rollback flags and explicit unsupported/research-gated states.
- [x] Review and apply migrations 0002 through 0004 to the hosted project.
- [x] Add and apply migration 0005 for append-only private model, prediction, evaluation, scorecard, and promotion-review evidence.
- [x] Implement migration 0006 governance hardening: server read kill switch, immutable reviews, versioned mapping correction, Scored/Unscorable evidence, exact scorecard membership/policy, authenticated model review, and rollback receipts.
- [x] Rehearse and apply migration 0006, verify its hosted RLS/ACL inventory, and exercise the guarded one-to-one mapping supersession path without rewriting historical lineage.
- [ ] Retain independent proof of a restorable Auth/storage-aware hosted backup before any future destructive migration; WAL-G without PITR and logical dumps are not substitutes.
- [x] Qualify two-account/two-client Watchlist RLS and tombstone behavior after migration.
- [x] Qualify one exact-mapped TCGCSV cohort across 53 bounded weekly archives and retain accepted/outlier evidence privately.
- [x] Build and persist a point-in-time private trend snapshot plus research-only baseline forecasts at all five horizons.
- [x] Run 42 honest retrospective walk-forward origins, persist matured evaluations/scorecards after rollback rehearsal, and retain the model's negative result without promotion.
- [ ] Approve a production market-history source before enabling public price intelligence.
- [x] Select JustTCG paid API as the preferred production path and implement its bounded, credential-free test adapter.
- [x] Add a private, user-triggered companion path (`justtcg-refresh`) that prioritizes a signed-in collector's own held/watched cards inside the same private Blobs boundary, self-limited and read-only against the scheduled crawl's own quota so it cannot drive it into a terminal exhausted state; unmapped cards fall through to zero-extra-cost candidate generation, never a fetch. See docs/JUSTTCG_ONDEMAND_REFRESH.md.
- [ ] Purchase the paid plan, archive the accepted terms, activate an immutable approved review, and provision the server-side API secret.

## Recommended next build increment

The private research and descriptive-trend implementation is code-complete and connected to one explicitly research-only source cohort. This does not make the source rights-cleared for public or commercial use:

- [x] Deterministic canonical Pokémon set/card/finish identities and database packets.
- [x] Exact source-to-variant mapping candidates with review and quarantine evidence.
- [x] Private append-oriented observations, data-quality events, analytics runs, trend snapshots, and review ledgers in migration 0003.
- [x] Explicit missing, late-arriving, invalid, stale, and MAD-outlier handling.
- [x] 7/30/90/180/365-day descriptive trend metrics.
- [x] Rights-gated Tier 0–2 publication candidates with no fair-value or forecast keys.
- [x] End-to-end synthetic qualification and an operator runbook.
- [x] Apply migrations 0002 through 0004 to the hosted project after backup and rollback rehearsal.
- [x] Complete two-account/two-client Watchlist RLS and tombstone qualification.
- [x] Add bounded live/current and 53-week archive adapters with artifact/snapshot hashes and point-in-time availability.
- [x] Review the first exact product/finish identity and ingest its historical observation ledger with outlier evidence.
- [x] Add private model/prediction/evaluation/scorecard tables and persist one uncalibrated baseline forecast origin.
- [x] Add a separate `retrospective_walk_forward` model and persist point-in-time forecasts, matured targets, and scorecards without backdating or automatic review.
- [x] Preregister future retrospective origins at 30-day spacing, require all five PRD baselines, persist exact evaluation membership/policy hashes, and emit immutable Unscorable rows.
- [x] Identify JustTCG paid API as the preferred production market-history source and document its current display/derived/storage contract.
- [ ] Independently activate the paid subscription and exact live permissions; the checked-in candidate review remains `pending`.
- [x] Run the first real-source mapping/observation packet and review every initial mapping in the selected one-card cohort.
- [x] Curate and host the 19-study Scarlet & Violet / Mega Evolution pull-rate registry, represent unavailable/unknown rates explicitly, and continuously verify every immutable primary article snapshot without database credentials.
- [x] Supersede the duplicate Surging Sparks `sv08` research mapping with canonical `sv8` for future current snapshots while preserving all historical observations, snapshots, and predictions.
- [ ] Qualify a real descriptive payload before separately enabling `public_price_intelligence`.

Do not treat the private baseline as production forecasting. Scheduled no-secret research execution, monitoring, and local approved-publication alert evaluation are implemented, but licensed service-role data persistence is intentionally absent. The JustTCG adapter is ready for a paid/current approved source but has no key or scheduled write. Fair value remains unimplemented. The first real walk-forward evidence rejects or finds insufficient the current baseline and predates the new 30-day/five-baseline evidence contract. Forecast promotion now requires new prospective or properly held-out multi-card evidence, all five baseline comparisons, positive lift over no-change and the strongest challenger, adequate cases, calibrated intervals/probabilities, an authenticated operator model-card review, and independent source-rights approval.

## Hosted price-intelligence qualification — August 5, 2026

- Supabase project `agmjgyyvhfcivbwdlvzk` records migrations 0001 through 0005. Migrations 0002 through 0005 were rehearsed against the hosted PostgreSQL instance inside rollback transactions before application.
- A read-only 0006 preflight found zero invalid terms-document hashes, zero missing required attributions, zero rights-bearing non-approved reviews, one legacy static model requiring the migration's digest-to-definition backfill, and one mapping row. `db push --dry-run` reports only 0006 pending; neither check executes or applies the migration.
- The project reported WAL-G enabled but no physical backup and no PITR. Two permission-restricted logical backups were retained; they do not replace an Auth/storage-aware physical project backup.
- All 34 public tables present before migration 0006 have Row Level Security enabled. Restricted browser grants remain zero, private forecast tables are service-role SELECT/INSERT only, and the forecast trigger helper is unavailable to every API role. This is historical hosted evidence, not proof of the pending 36-table post-0006 inventory.
- Disposable Watchlist accounts passed the two-user/two-client isolation and tombstone qualification, then were removed with zero QA residue.
- TCGCSV is active only under review `3bc792cf-ad71-54d1-a2f6-d5d5d521fba5`, decision `research_only`, expiry `2026-11-03T20:30:00Z`, with commercial/catalog/raw/derived public permissions all false. The exact reviewed cohort is product `590027` / Holofoil mapped to variant `80b4934a-96db-5f4c-8641-f7c74e0eb949`.
- The initial guarded SQL transaction was executed with `ROLLBACK`, proved to leave zero target rows, then committed unchanged. The observation ledger contains 53 weekly rows (41 accepted, 12 outlier), the accepted current `$310.79` row, 12 quality events, one stable current snapshot, and five original research-only horizon predictions.
- A second packet followed the same rollback/zero-residue/commit gate. Legacy packet `72df5fb8417786a83fcd480cff314c2565fa130f8976391e264ea4e6b9d89cf3` added separate model `0f5c8ed2-089e-5f76-844f-d89f77d040aa`, 43 analytics runs, 42 historical-origin snapshots, 210 explicitly retrospective predictions (200 research-only, 10 quarantined), 109 evaluations, and four scorecards. Timestamp and required-label violations are zero. It predates the 30-day origin, five-baseline, and immutable Unscorable/membership policy and is not promotion-eligible.
- The 7-day scorecard has 36 eligible cases and recommends `reject`; its baseline-relative lift is `-1.24%` and 80% interval coverage is `55.56%`. The 30/90/180-day scorecards have 27/21/16 cases and are `insufficient`; all have negative lift and under-coverage. No scorecard is eligible for operator promotion review, and no `model_promotion_reviews` row was created.
- No public row exists for the variant, `intelligence_publication_is_permitted(...)` is false, `watchlists=true`, and `public_price_intelligence=false`. No descriptive, fair-value, or predictive payload has been published.

## On-demand JustTCG refresh — August 6, 2026

- Added a second, user-triggered path onto the existing private JustTCG
  collection: `netlify/functions/justtcg-refresh.mjs`, orchestrated by
  `netlify/lib/justtcg-ondemand-collector.mjs`, storing only under a new
  `ondemand/` prefix in the same `collectfolio-justtcg-private` Blobs store
  the scheduled crawl already uses. No Supabase write path, no service-role
  credential, and no change to `public_price_intelligence` anywhere in this
  path — see docs/JUSTTCG_ONDEMAND_REFRESH.md for the full boundary.
- Cards are identified by `(provider, externalId, language, finish,
  conditionClass)` — the same tuple `catalog-identity.js` already uses for
  its watch key — hashed before it ever reaches a Blobs key, since
  `canonicalVariantId` is not populated anywhere yet and the raw identity
  fields originate in client-controlled `jsonb` columns.
- A card is only fetched directly against a private, operator-seeded
  identifier ledger (never the real `external_card_mappings`/
  `catalog_mapping_candidates` tables, which have no anon/authenticated
  grants and whose insert paths require rows — an active JustTCG terms
  review, a populated `catalog_variants` — that don't exist yet). Unmapped
  cards only ever produce an explicitly-labeled, unreviewed candidate from a
  zero-extra-API-cost scan of already-crawled pages; nothing is ever
  auto-promoted or auto-fetched from a candidate.
- Quota, per-minute, and per-user limits are reserved and released
  atomically through one `control.json` object, and the feature reads (but
  never writes) the scheduled crawl's own durable state as a reserve-floor
  guard, because that crawl's `quota_exhausted`/`blocked` states are
  permanently terminal — this path must yield headroom, not just track a
  separate budget alongside it.
- `npm run check` passes locally: validation (71 required files), the full
  106-test Node suite (22 new tests covering the lookup adapter and
  orchestrator — concurrent-claim exclusivity, quota/reserve-floor/per-user
  limits, failure backoff without refund, candidate generation, and a
  price-free response-shape guarantee — plus the pre-existing 84 unchanged),
  the 106-test Python analytics suite, and the production build. This is
  implementation and local qualification only — no deploy, no live JustTCG
  request, and no hosted Blobs verification have been performed yet; the
  same post-deploy checks documented for the scheduled collector in
  docs/NETLIFY_DEPLOY.md still apply before this is considered
  hosted-qualified.

Recognition benchmarking remains valuable in parallel. Its controlled dataset should include:

- single clean card;
- multiple cards on contrasting and difficult backgrounds;
- binder pages;
- sleeved/top-loaded cards with glare;
- rotated and partially overlapping items;
- comics;
- graded slabs.

Measure boundary recall, false boxes, OCR query usefulness, top-1/top-3 candidate accuracy, manual corrections, and completion time. Use those results to determine whether the heuristic detector should be extended with perspective correction or replaced by a small browser-run object model.
