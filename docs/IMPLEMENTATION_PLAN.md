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
- [ ] After merge, publish `main` to the chosen final production site/domain and repeat device-install checks.

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

## Recommended next build increment

The highest-leverage next increment is **recognition benchmarking**, not more features. Create a controlled dataset of at least 100 images across:

- single clean card;
- multiple cards on contrasting and difficult backgrounds;
- binder pages;
- sleeved/top-loaded cards with glare;
- rotated and partially overlapping items;
- comics;
- graded slabs.

Measure boundary recall, false boxes, OCR query usefulness, top-1/top-3 candidate accuracy, manual corrections, and completion time. Use those results to determine whether the heuristic detector should be extended with perspective correction or replaced by a small browser-run object model.
