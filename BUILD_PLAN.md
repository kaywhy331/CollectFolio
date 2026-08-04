# CollectFolio MVP — Build Plan for the implementation agent

You are building the CollectFolio MVP from scratch in this repository. The product
definition is complete and frozen — do not redesign it. Read these before writing code:

- `PRD/PRD.md` — product requirements, workflows, and the 17 MVP acceptance criteria (§12)
- `PRD/TECHNICAL_SPEC.md` — architecture, repository layout, data model, algorithms
- `PRD/IMPLEMENTATION_PLAN.md` — milestone order
- `PRD/NETLIFY_DEPLOY.md` — deployment contract
- `PRD/collectfolio-*.png` — final UI mockups (dark theme, green accent, five-tab
  bottom nav with elevated center Add button)

## Ground rules

1. **Git**: work on branch `agent/collectfolio-mvp` (already checked out). Commit in
   logical milestone-sized commits with imperative subjects. Do NOT push — the
   supervisor pushes after QA.
2. **Zero third-party npm packages.** `package.json` has no `dependencies` and no
   `devDependencies`. Build/dev/test scripts use Node 22 built-ins only
   (`node:fs`, `node:http`, `node:test`). The browser app is framework-free ES
   modules. The only external runtime code permitted is Tesseract.js lazy-loaded
   from jsDelivr **after explicit user action** (spec §7.4), guarded by
   `ENABLE_TESSERACT`.
3. **Repository layout** exactly as spec §2 (`app/`, `scripts/`,
   `supabase/migrations/`, `tests/`, `docs/`). First commit: move `PRD/` contents
   into `docs/` (keep the PNGs), so the docs ship with the code.
4. **npm scripts**: `dev` (static server via `scripts/dev.mjs`), `build`
   (`scripts/build.mjs` copies `app/` → `dist/` and writes `dist/runtime-config.js`
   from env: `SUPABASE_URL` default `https://agmjgyyvhfcivbwdlvzk.supabase.co`,
   `SUPABASE_ANON_KEY` default empty → local-only mode, `APP_VERSION`,
   `ENABLE_TESSERACT`), `test` (`node --test tests/`), `check`
   (`scripts/validate.mjs` + tests + build, per spec §13).
5. **Definition of done** = all 17 acceptance criteria in PRD §12 pass, and
   `npm run check` exits 0.

## Build order (milestones from IMPLEMENTATION_PLAN.md)

### M1 — shell
`app/index.html`, `manifest.webmanifest`, `sw.js` (CACHE name
`collectfolio-shell-v0.1.0`, shell precache, network-first navigation with cached
index fallback, cache-first same-origin assets, dedicated cache-first store for the
three provider image hosts, never intercept catalog API calls), `assets/css/app.css`
(dark default matching mockups, light + system themes, 320px→desktop, visible focus
states, reduced-motion support), five views with bottom nav (Home, Search, Add
elevated, Portfolio, Profile), `core/store.js` (getState/setState/subscribe),
`core/ui.js` (modal, toast, SVG chart helpers), `core/utils.js` (formatting,
fetch helpers, text similarity, HTML escaping — ALL user strings escaped before
insertion).

### M2 — local portfolio
`core/db.js` (IndexedDB `collectfolio` v2: holdings, snapshots, settings, scans,
catalogCache, deletions; holdings indexes catalogId/updatedAt),
`core/calculations.js` (valuation rules spec §5 exactly), holding CRUD +
filter/sort, Home dashboard (market value, cost basis, unrealized gain, allocation,
90-day SVG trend with separate market and cost lines, top holdings), daily
snapshots (`portfolio:YYYY-MM-DD`, same-day replace), JSON backup export/merge-import
(interchange v1), CSV export, demo collection loader, Profile view with
local/cloud status, settings, destructive-confirm clear-data.

### M3 — catalog search
`services/providers/pokemon.js|scryfall.js|ygoprodeck.js` normalizing to the
internal item shape (spec §6: endpoints, price options per finish, printings
distinct, YGO set-code candidates), `services/catalog.js` (Promise.allSettled
fan-out, partial-failure warning, 30-min IndexedDB cache keyed by
category+provider+normalized query, ranked merge), Search view (filters, result
cards with image/set/number/rarity/price/source, Add flow confirming
variant/finish, quantity, condition, grade, purchase details, folder, notes),
manual/custom entry path for sports, comics, slabs, other (SEA-04 routes there).

### M4 — image ingestion
`services/image-algorithms.js` (background estimation from corners, color-distance
+ gradient foreground mask, dilate/erode, 4-neighbor connected components,
area/aspect/fill filtering, overlap merge, slight expansion, coordinate mapping —
heuristic per spec §7.1), `services/scan-workbench.js` (canvas boundary editor:
select, move, lower-right resize, draw-new, delete, retry detection, 1–12 row/col
binder grid), crop generation (JPEG data URL, max 720px, q 0.84),
`services/image.js` (TextDetector-first OCR, lazy Tesseract fallback, query
extraction favoring long distinctive words and number tokens), 64-bit dHash from
9×8 grayscale + 62/38 visual/text rerank where CORS permits,
`services/scan-review.js` (per-crop states unmatched/identifying/matched/error,
explicit approval only, batch add of approved crops only, custom-holding fallback
per crop, draft save/resume surviving reload — CAP-09).

### M5 — optional Supabase sync
`supabase/migrations/0001_initial.sql` (profiles, holdings, holding_deletions,
portfolio_snapshots, scan_sessions, updated-at triggers, indexes, profile-creation
trigger, full per-user RLS), `services/supabase.js` (direct Auth REST: sign-up,
password sign-in, magic link, implicit-flow callback consumption, refresh;
PostgREST holdings/tombstones; sync algorithm spec §9.3 exactly — tombstone-first,
last-write-wins by ISO updatedAt, on_conflict=id, ≤180KB inline user image).
App must be fully functional with no key configured (DAT-04).

### M6 — release plumbing
`netlify.toml` (build `npm run build`, publish `dist`, Node 22, SPA rewrite,
security headers per spec §10/§12, no-cache for sw.js), `scripts/validate.mjs`
(required files, unsafe placeholders, insecure URLs, index references, sw shell
references, relative import resolution, JS syntax via `node --check`),
`tests/` (node:test units: valuation, sorting, OCR query extraction, similarity,
connected components/grid/merge on synthetic pixel data, provider normalization
from fixture JSON), `.github/workflows/ci.yml` running `npm run check`,
`README.md` replacing the stub (features, local dev, deploy pointer to
`docs/NETLIFY_DEPLOY.md`).

## Non-negotiables to re-verify before your final commit

- No holding is ever added without explicit user approval (CAP-06/08, §11 metric 6).
- Provider failures never discard other providers' results (SEA-02).
- Manual value overrides display but never delete provider data (HOL-03).
- Market value and cost basis are separate chart lines (HOL-06).
- All user-entered strings HTML-escaped; external images `referrerpolicy="no-referrer"`.
- Full source photos never uploaded anywhere; crops stay local (§10).
- `npm run check` passes with zero third-party packages installed.
