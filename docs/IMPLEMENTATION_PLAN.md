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
- [ ] Apply migration in the Supabase SQL Editor.
- [ ] Copy Supabase publishable/anon key into Netlify environment variables.
- [ ] Confirm email authentication settings and redirect URL after Netlify creates the production domain.
- [ ] Run a two-browser sync qualification test.

## Milestone 6 — Netlify release

- [x] `netlify.toml` build and SPA routing.
- [x] Security and cache headers.
- [x] Production build validation.
- [ ] Create the Netlify project from `kaywhy331/CollectFolio` after the GitHub branch is merged.
- [ ] Configure environment variables.
- [ ] Confirm deploy preview and production PWA installation.
- [ ] Add the final Netlify URL to Supabase Auth redirect URLs.

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
