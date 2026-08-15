# CollectFolio

CollectFolio is a dependency-free, local-first progressive web app for collectible cards, comics, graded slabs, sports cards, and related items. Its central workflow turns a multi-item photo into editable crops, optional OCR suggestions, catalog candidates, and an explicit approval queue. Nothing enters the portfolio until the collector approves it.

## MVP features

- Five-view mobile-first shell with dark, light, and system themes
- Persistent three-step local-first onboarding with saved currency and first-Add progress
- IndexedDB portfolio with editable ownership metadata, tombstoned deletion, daily snapshots, and append-only local unit-value checks
- Offline exact-variant Watchlist beside Holdings, with evidence-gated forecasts kept under the separate Insights destination
- Cached, rights-filtered publication reader with a strict observed/trend/fair-value/forecast display contract
- Dedicated Insights workspace with always-available local scenario outlooks, recorded performance, independently gated published forecasts, local alert history, immutable public-forecast receipts, and Tier 5 scorecards
- Separate market value and cost-basis trend lines, gain/loss, allocation, and top holdings
- Concurrent failure-isolated Pokémon TCG API, Scryfall, and YGOPRODeck search with a 30-minute, 250-entry local cache and a free TCGdex Pokémon discovery fallback; Pokémon search is metadata-only until licensed prices are published
- Manual entries for sports, comics, slabs, unsupported items, and variants
- In-browser four-corner detection and perspective rectification with add, move, corner editing, delete, retry, and 1–12 row/column grid tools
- Automatic browser-native OCR with quality-gated multi-pass Tesseract.js fallback when enabled
- Per-crop selection, shared/per-item acquisition details, approved-only idempotent batch add, resumable local scan drafts, and image-free completed receipts retained for 30 days (up to 20)
- Selection-only holding move, tag, duplicate, export, and confirmed-delete tools
- Settings for account/sync status, collection defaults, privacy, storage, synchronization history, and typed data removal
- Atomically validated JSON interchange v2 backup/merge restore, backward-compatible v1 import, and CSV export
- Optional Supabase password or magic-link authentication and paginated, batched, tombstone-first last-write-wins holding/watchlist synchronization
- Installable offline shell with dedicated provider-image caching
- Dependency-free Python research core for canonical mapping quarantine, rights-aware observations, point-in-time trends, honest retrospective evaluation/scorecards, reviewable descriptive packets, baselines, pull scarcity, quantiles, a one-key Cardbase MTG history collector, and the legacy-model audit

Full source photos are never uploaded. Scan drafts store compressed crops locally. Cloud synchronization is optional, and crops larger than 180 KB stay on the device.

## Local development

Node.js 22 or newer is required. Python 3.11 or newer is also required for the complete analytics check. The browser and Python analytics core have no runtime dependencies; the private Netlify collector uses the pinned `@netlify/blobs` server package for durable cursor and page storage.

```sh
npm run dev
```

Open `http://localhost:4173`. To run the complete validation, unit-test, and production-build sequence:

```sh
npm run check
```

Other scripts are `npm test` for browser and analytics unit tests, `npm run test:analytics` for the isolated Python suite, and `npm run build` for a static `dist/` build. The build writes `dist/runtime-config.js` from `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `APP_VERSION`, `ENABLE_TESSERACT`, `ENABLE_WATCHLISTS`, `ENABLE_PRICE_INTELLIGENCE`, and `ENABLE_CLOUD_DATA_REMOVAL`.

With no Supabase public key, every local feature—including Watchlist and local scenario outlooks—remains available. A scenario begins from one saved catalog value or the collector's explicitly labeled estimate; it never claims to be an appraisal, observed market history, or measured forecast accuracy. Cloud watchlist sync requires the reviewed `0002_price_intelligence_foundation.sql` migration. Tesseract.js is fetched from jsDelivr only after the user explicitly requests OCR and only when `ENABLE_TESSERACT` is enabled. `ENABLE_WATCHLISTS` controls the independent local Watchlist surface and defaults on. Published public price intelligence is a separate fail-closed capability: `ENABLE_PRICE_INTELLIGENCE` defaults off and must also pass the hosted publication flag before approved intelligence can render. `ENABLE_CLOUD_DATA_REMOVAL` also defaults off and must remain off until migration 0015 has independent recovery, rollback, and two-user isolation proof.

The analytics package includes a bounded research-only TCGCSV current/archive adapter, a separate fixed-origin JustTCG paid-source adapter, and a fixed-origin Cardbase MTG adapter that keeps every vendor/finish/type/currency series separate and preserves first-seen availability across rolling responses. Cardbase is the preferred continuous MTG research source; its scheduled workflow is gated and currently inactive because no key or reviewed cohort is configured. It accepts one server-side key only, honors `Retry-After`, and never rotates keys to pool free quota. TCGCSV workflows are manual/static. See [docs/CARDBASE_MTG_RESEARCH.md](docs/CARDBASE_MTG_RESEARCH.md). Deterministic private-ledger packets, preregistered 30-day retrospective origins, and explicit Scored/Unscorable outcomes remain non-publishing. A separate Netlify function can privately stage a Free-plan JustTCG catalog bootstrap in Netlify Blobs: one 20-card page every five minutes, at most 100 outbound attempts per UTC day and 1,000 per collection, with one-year history requested on every card. This staging collector has no browser/read endpoint and does not write Supabase, approve mappings, publish prices, or satisfy commercial rights. A second, user-triggered Netlify function (`justtcg-refresh`) lets a signed-in collector ask that their own held/watched cards be prioritized in that same private collection instead of only its blind price-rank crawl order — it stays inside the same private Blobs store and boundary, self-limits to a small independent daily/per-minute budget, and reads (never writes) the scheduled crawl's own quota state so it yields headroom rather than risk driving the crawl into its own permanently-terminal exhausted state. See [docs/JUSTTCG_ONDEMAND_REFRESH.md](docs/JUSTTCG_ONDEMAND_REFRESH.md). Production observations still require a paid-plan attestation plus a current approved catalog/raw/derived review and honest retrieval availability. Promotion policy requires all five PRD baselines and exact immutable scorecard membership; the currently available packet has only the no-change comparison and therefore remains insufficient. The first hosted 109-evaluation receipt is also a pre-hardening research artifact, not prospective or promotion-eligible evidence.

Migration `0006_price_intelligence_governance_hardening.sql` is implemented but intentionally not applied by this repository change. After backup and rollback rehearsal it makes `public_price_intelligence` a database read kill switch, makes source reviews and scorecard evidence append-only, versions mapping corrections, and routes model approval through an authenticated operator RPC. Until that migration is reviewed/applied—and independent public/commercial source rights, adequate multi-card held-out evidence, calibration, and human publication review all pass—both the database flag and `ENABLE_PRICE_INTELLIGENCE` must remain false. Hosted rollout and rollback are documented in [docs/PRICE_INTELLIGENCE_RUNBOOK.md](docs/PRICE_INTELLIGENCE_RUNBOOK.md).

The current provider decision recommends a $19/month JustTCG Starter license for Pokémon and the free Cardbase API for continuous, private MTG research. Both remain gated: JustTCG awaits a paid accepted contract, while Cardbase awaits one API key, a reviewed MTG cohort, and private archive configuration. Capabilities, alternatives, cost, and activation steps are documented in [docs/PRICE_SOURCE_DECISION.md](docs/PRICE_SOURCE_DECISION.md). Free-plan JustTCG staging is documented in [docs/JUSTTCG_CATALOG_COLLECTOR.md](docs/JUSTTCG_CATALOG_COLLECTOR.md); Cardbase configuration is in [docs/CARDBASE_MTG_RESEARCH.md](docs/CARDBASE_MTG_RESEARCH.md).

## Deployment

Netlify builds with `npm run build` and publishes `dist/`. The base PWA remains static; the optional JustTCG bootstrap uses one scheduled Function plus one user-triggered Function, both writing only to the same private Netlify Blobs storage. Supabase schema setup, environment variables, Auth redirect configuration, collector checks, and the two-browser deletion-sync qualification are documented in [docs/NETLIFY_DEPLOY.md](docs/NETLIFY_DEPLOY.md).

The current application patch is `0.8.2` with service-worker shell `collectfolio-shell-v0.8.2`; it adds automatic four-corner detection, perspective rectification, automatic quality-gated OCR/catalog recovery, and a pinned Pokémon visual-candidate index while retaining the `0.8.0` local-scenario foundation. IndexedDB v5 is additive and preserves the version-4 migration fixture. Migration `0015_remove_my_cloud_data.sql` is checked in but intentionally not applied; its separate rollout, qualification, and rollback boundary is documented in [docs/REDESIGN_ACCOUNT_SYNC_RELEASE.md](docs/REDESIGN_ACCOUNT_SYNC_RELEASE.md).

The consolidated PRD sections 18–20 evidence matrix, final product-decision
dispositions, and remaining production-promotion blockers are documented in
[docs/REDESIGN_FINAL_ACCEPTANCE.md](docs/REDESIGN_FINAL_ACCEPTANCE.md).

Product requirements, technical architecture, and final UI references live in [`docs/`](docs/).
