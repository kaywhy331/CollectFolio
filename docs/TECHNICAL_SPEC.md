# CollectFolio Technical Specification

**Version:** 0.4
**Target:** Static Netlify PWA + optional Supabase  
**Runtime:** Modern evergreen browsers; Node.js 22+ and Python 3.11+ for complete checks

## 1. Architecture decision

CollectFolio is implemented as a dependency-free static progressive web application. This choice is intentional:

- Netlify serves the static application and performs no image compute.
- Browser-native ES modules avoid a framework runtime and package supply-chain overhead.
- IndexedDB provides the primary datastore.
- Canvas performs detection, cropping, resizing, and perceptual hashing.
- OCR is lazy-loaded from the free Tesseract.js browser distribution only when requested.
- Free catalog APIs are accessed directly from the browser.
- Supabase is an optional synchronization layer accessed through its Auth and PostgREST HTTP APIs.

```text
Netlify static CDN
        │
        ▼
Browser PWA
├── View modules and event controller
├── IndexedDB primary datastore
├── Canvas image pipeline
├── Lazy OCR engine
├── Free catalog adapters
└── Optional Supabase Auth/PostgREST sync
```

No Netlify Function, Edge Function, server-side renderer, paid inference endpoint, or required application server exists in the MVP.

The standard-library Python package under `analytics/` is research and CI infrastructure. It is not shipped to the browser, does not ingest live provider data, and cannot publish intelligence.

## 2. Repository layout

```text
app/
  index.html
  manifest.webmanifest
  sw.js
  assets/
    css/app.css
    icons/
    js/
      app.js                  # orchestration and event handling
      core/
        calculations.js       # valuation formulas
        catalog-identity.js   # exact source/canonical variant bridge
        pricing-policy.js     # fail-closed local provider-price eligibility
        intelligence-contract.js # support-tier and payload validation
        components.js         # shared render helpers
        db.js                 # IndexedDB gateway
        store.js              # in-memory observable state
        ui.js                 # modal, toast, icons, charts
        utils.js              # formatting, fetch, similarity
      services/
        catalog.js            # provider fan-out, cache, ranking
        image-algorithms.js   # masks, components, boxes, hashes
        image.js              # Canvas/OCR/image utilities
        scan-workbench.js     # boundary editor
        scan-review.js        # OCR/match/approval queue
        supabase.js           # optional Auth/PostgREST sync
        watchlist.js          # local exact-variant watchlist and merge rules
        price-intelligence.js # approved-publication cache/hydration
        providers/
      views/
scripts/
  build.mjs
  dev.mjs
  validate.mjs
supabase/migrations/
analytics/
  src/collectfolio_analytics/
    catalog_mapping.py       # deterministic identity and quarantine packets
    market_pipeline.py       # rights/mapping/outlier observation preparation
    justtcg.py               # licensed fixed-origin current/history adapter
    tcgcsv.py                # bounded current/archive research adapter
    qualification.py         # private history/trend/forecast evidence packets
    forecasting.py           # immutable research baseline predictions
    private_sql.py           # guarded rollback-first hosted SQL export
    walk_forward.py          # honest retrospective origins/evaluations/scorecards
    walk_forward_cli.py      # bounded hosted-row export to mode-0600 packet
    walk_forward_sql.py      # guarded retrospective rollback/commit SQL
    monitoring.py            # deterministic operator health and alerts
    publication.py           # reviewable Tier 0–2 candidate packets
    trends.py                # point-in-time descriptive market features
  tests/                      # synthetic leakage/formula tests
tests/
docs/
```

## 3. Build and runtime configuration

`npm run build` copies `app/` to `dist/` and writes `dist/runtime-config.js` from environment variables.

| Variable | Required | Purpose |
|---|---:|---|
| `SUPABASE_URL` | No | Supabase project URL; supplied project is the default |
| `SUPABASE_ANON_KEY` | No | Browser-safe public/publishable key; enables auth and sync |
| `APP_VERSION` | No | Displayed and embedded version |
| `ENABLE_TESSERACT` | No | Disables external OCR loading when set to `false` |
| `ENABLE_PRICE_INTELLIGENCE` | No | Rollback switch for Watchlist/Forecasts UI; defaults to `true` |

The supplied URL is `https://agmjgyyvhfcivbwdlvzk.supabase.co`. The public key is intentionally not committed.

## 4. Client state and persistence

### 4.1 In-memory state

`core/store.js` exposes `getState`, `setState`, and `subscribe`. State contains:

- active view;
- holdings and snapshots;
- exact-variant watchlist items and local alerts;
- settings;
- search request/results/error;
- portfolio section/filter/sort;
- server/runtime feature flags;
- approved publication state indexed by canonical variant UUID;
- auth session and sync state;
- scan draft count.

The current view is rendered after state mutation. Complex modal workflows own their local transient state to avoid whole-app rerenders while editing Canvas or OCR progress.

### 4.2 IndexedDB

Database: `collectfolio`, version 3. New exports use interchange version 2; version 1 backups remain importable.

| Store | Key | Contents |
|---|---|---|
| `holdings` | `id` | Catalog snapshot plus ownership metadata |
| `snapshots` | `id` | Portfolio-level daily valuation snapshots stamped with the active pricing-policy version |
| `settings` | `key` | Currency, theme, and preferences |
| `scans` | `id` | Draft crops and review progress |
| `catalogCache` | `key` | Search responses with expiry timestamp |
| `deletions` | `id` | Holding tombstones for deterministic cross-device deletion sync |
| `watchlistItems` | `id` | Exact source or canonical variant snapshot plus alert preferences |
| `watchlistDeletions` | `id` | Watch-key tombstones for deterministic cross-device deletion sync |
| `intelligenceCache` | `key` | Last approved public intelligence payloads; no research data |
| `alerts` | `id` | Local in-app alert state |

Indexes on holdings include `catalogId` and `updatedAt`.

### 4.3 Holding model

```js
{
  id,                    // app UUID
  catalogId,             // provider-scoped legacy reference string
  catalogKey,            // exact source variant/finish/condition bridge
  canonicalVariantId,    // approved catalog UUID when mapping exists
  item: {
    id, externalId, provider, category, game,
    name, setName, number, variant, rarity, year,
    image, imageSmall, price, priceOptions,
    currency, priceSource, priceUrl, priceUpdatedAt
  },
  quantity,
  condition,
  gradeCompany,
  grade,
  purchasePrice,
  purchaseDate,
  fees,
  manualMarketPrice,
  folder,
  notes,
  userImage,
  createdAt,
  updatedAt,
  lastPriceRefresh,
  dirty
}
```

Provider identity data is snapshotted inside the holding so an outage does not remove the collectible reference. Existing holdings are not destructively rewritten: `catalogKey` supplies an exact provider-level bridge, while `canonicalVariantId` remains empty until an approved mapping exists. A legacy provider value remains in the user's record for provenance but cannot enter valuation or display when the source policy marks that route restricted.

## 5. Valuation rules

- Unit value = `manualMarketPrice` when set; otherwise a locally permitted `item.price`; otherwise 0. Pokémon/TCGplayer catalog prices are restricted until a licensed publication exists.
- Holding market value = unit value × quantity.
- Holding cost basis = purchase price × quantity + fees.
- Unrealized gain = market value − cost basis.
- Return percentage = gain ÷ cost basis × 100 when cost basis is positive.
- Portfolio summary is the sum of holding values and costs.
- Daily snapshot IDs use `portfolio:YYYY-MM-DD`; subsequent changes on the same day replace that day’s point. Only snapshots stamped with the current rights-aware pricing-policy version are charted, so an older TCGplayer/Cardmarket-derived total cannot survive the source-policy transition through historical charts.

Market and cost lines are drawn separately so adding a collectible is not visually represented as pure market appreciation.

## 6. Catalog provider abstraction

Every provider normalizes into the internal item shape. The app never stores a provider ID as the holding’s primary key.

### Pokémon

- Search endpoint: `GET https://api.pokemontcg.io/v2/cards`.
- Set discovery endpoint: `GET https://api.pokemontcg.io/v2/sets`, with TCGdex `/v2/en/sets` used for resilient set-name discovery.
- Detail endpoint: `/v2/cards/{id}`.
- Query parsing prefers the longest contiguous exact set-name match, removes those tokens, and combines the remaining card name and number with the resolved set ID. Thus a set name searches the full set while `card name + set name` searches their intersection; numeric set names such as `Base Set 2` are resolved before card-number parsing.
- Set metadata is cached in browser storage for 24 hours. A failed primary set-ID lookup has a short backoff and falls through to a set-name clause instead of blocking discovery.
- If the primary card provider fails or has no cards for a recognized set, TCGdex set detail supplies the complete set and applies remaining name/number filters locally. An empty result from that complete set is authoritative rather than reported as a provider outage.
- Requests are metadata-only (`id,name,number,rarity,set,images`). Embedded TCGplayer/Cardmarket prices are not requested or normalized.
- The browser build intentionally uses the unauthenticated tier so no private/provider API key is exposed in client code.

### Magic: The Gathering

- Search endpoint: `GET https://api.scryfall.com/cards/search`.
- Detail endpoint: `/cards/{id}`.
- Printings remain distinct.
- Regular, foil, and etched USD prices become selectable options.
- Double-faced cards use the first face with image URIs.

### Yu-Gi-Oh!

- Endpoint: `GET https://db.ygoprodeck.com/api/v7/cardinfo.php`.
- Each returned set printing becomes a distinct internal candidate using set code.
- A small remote image is displayed during search.
- The service worker stores successfully retrieved provider images in a browser-local cache for repeat views.
- On add, the app attempts to create a compressed user-owned copy, further reducing repeat requests.

### Failure isolation

Catalog searches use `Promise.allSettled`. One provider failure produces a partial warning but retains successful provider results.

### Local caching

The cache key includes category, selected provider, and normalized query. Search results expire after 30 minutes. Provider images from the three approved hosts are cached separately by the service worker until the user clears site data or a future cache migration removes them.

## 7. Image pipeline

### 7.1 Boundary detection

The detector downsizes the source for analysis and:

1. estimates background color from corner samples;
2. creates a foreground mask using color distance and local gradient;
3. performs dilation and erosion to connect fragmented edges;
4. finds four-neighbor connected components;
5. filters by area, aspect ratio, and fill ratio;
6. merges overlapping or near-adjacent fragments;
7. expands each retained boundary slightly;
8. maps boundaries back to original-image coordinates.

This is a heuristic detector, not a trained object model. It is intentionally paired with direct correction tools and a full-frame fallback.

### 7.2 Boundary editor

Canvas stores boxes in original-image coordinates and scales them for display. Pointer interactions support:

- click/tap selection;
- dragging inside a selected box to move;
- dragging the lower-right handle to resize;
- drawing a new box in Add mode;
- deleting a selected box;
- re-running detection;
- replacing boxes with a row/column grid.

### 7.3 Crop generation

Crops are rendered to JPEG data URLs with a maximum width of 720 px and 0.84 quality. The crop becomes the user-owned portfolio image and remains in IndexedDB.

### 7.4 OCR

The sequence is:

1. attempt a browser-native `TextDetector` when available;
2. otherwise lazy-load Tesseract.js from jsDelivr;
3. recognize English text locally;
4. normalize OCR lines;
5. prioritize distinctive long words and number-containing tokens;
6. present an editable query before or after catalog search.

OCR is advisory. Failure returns control to manual query entry.

### 7.5 Visual reranking

The app computes a 64-bit difference hash from a 9×8 grayscale rendering of the user crop. For candidate images that permit CORS access, it computes the same hash and combines:

- 62% visual hash similarity;
- 38% text/metadata match score.

When candidate images cannot be read through Canvas, ranking falls back to metadata similarity.

## 8. Review safety model

A crop can be `unmatched`, `identifying`, `matched`, or `error`. It is only included in batch add when:

- a candidate or explicit custom fallback is selected; and
- `approved === true`.

“Approve 80%+” is still an explicit user action. The application never runs it automatically.

Review state can be saved as a draft and resumed from Home or Add. A completed batch is marked complete so it no longer appears as an active draft.

## 9. Supabase design

### 9.1 Authentication

The browser calls Supabase Auth directly using the public key:

- sign-up;
- password grant sign-in;
- email OTP/magic link request;
- implicit-flow callback consumption from the URL fragment;
- callback-error extraction and user-visible reporting;
- refresh-token grant.

Session data is stored in local storage; the primary collection remains in IndexedDB.

### 9.2 Database

Migration `0001_initial.sql` creates:

- `profiles`;
- `holdings`;
- `holding_deletions`;
- `portfolio_snapshots`;
- `scan_sessions`;
- update timestamp triggers;
- indexes;
- user-profile creation trigger;
- complete per-user RLS policies.

Migration `0002_price_intelligence_foundation.sql` is intentionally a separately reviewed operator step. It adds versioned source-terms reviews, a private canonical catalog, a nullable existing-holding bridge, exact-key watchlists and tombstones, runtime product flags, and the only anonymous intelligence publication table. Raw catalog/source tables have no anon or authenticated grants. Public publication RLS re-evaluates every lineage source against its current approved terms review and expiration.

Migration `0003_price_intelligence_research_pipeline.sql` adds private append-oriented mapping candidates/reviews, exact-mapping price observations, data-quality events, analytics runs/source lineage, trend snapshots, descriptive publication candidates/reviews, and immutable promotion receipts. Composite foreign keys bind every observation to its exact source, terms review, approved mapping, variant, and ingestion run. All research tables have RLS with no anon/authenticated grants.

Migration `0004_price_intelligence_function_acl_hardening.sql` removes Supabase default function execution from browser roles and leaves descriptive publication service-role-only. Migration `0005_private_forecast_research_ledgers.sql` adds append-only model versions, research predictions, matured evaluations, scorecards, and promotion-review evidence. Forecast tables are private; predictions are schema-limited to `research_only` or `quarantined`, and the evaluation-lineage trigger helper is unavailable to API roles.

Pending migration `0006_price_intelligence_governance_hardening.sql` makes the database `public_price_intelligence` flag and exact source attribution part of the public RLS predicate; terms-review rows become append-only. Mapping corrections use a one-to-one supersession RPC that preserves referenced versions. Model records distinguish static definitions, nullable training datasets, and code artifacts. Every matured outcome is `scored` or `unscorable`, while scorecards persist a complete case partition, exact membership/hash, and versioned policy/hash. Direct service-role model-review inserts are revoked: an authenticated JWT with server-managed `app_metadata.price_intelligence_operator=true` must use `review_model_promotion`. Descriptive publication and per-card quarantine remain separate service-role RPCs, and disable actions append control receipts. This migration adds two RLS-protected tables, bringing the expected hosted inventory from 34 to 36 only after it is actually applied.

The service-role-only `publish_descriptive_intelligence` function accepts only a latest approved candidate review with source-rights and mapping attestations. It rechecks current commercial, attribution, and per-usage permissions, rejects non-published or above-Tier-2 payloads and any `fairValue`/`forecasts` key, then atomically replaces the public payload and lineage. It does not change the public feature flag. The flag remains a separate global operator decision; `disable_public_intelligence` is the append-receip per-card rollback path.

The service-role key is never used or exposed in the browser.

### 9.3 Sync algorithm

1. Obtain a valid user session, refreshing if required.
2. Read local holdings and local deletion tombstones.
3. Read remote holdings and remote deletion tombstones owned by the authenticated user.
4. Merge tombstones by holding UUID, retaining the newest `deletedAt` value.
5. Upsert new local tombstones to Supabase.
6. Purge every tombstoned holding locally and delete the remote row when it still exists.
7. Exclude tombstoned IDs, group remaining holdings by app-generated UUID, and retain the copy with the lexicographically newest ISO `updatedAt`.
8. Write merged holdings to IndexedDB and upsert them to Supabase with `on_conflict=id`.
9. Mark synchronized local rows clean.

The watchlist follows the same deletion-first/LWW pattern using its exact `watchKey`. A default cloud watchlist is obtained through an invoker-secured RPC. Failure of the optional watchlist schema does not roll back an otherwise successful holdings sync; the user receives a migration-required warning and local watchlist data stays intact.

This is deterministic last-write-wins at holding granularity with persistent deletion tombstones. It does not merge individual fields. Clearing all browser data is intentionally different from deleting holdings inside the app: a browser reset does not issue cloud deletions, while an explicit holding deletion records a tombstone and propagates on the next sync.

### 9.4 Publication hydration and analytics isolation

The browser requests publications only for deduplicated canonical UUIDs represented in Holdings or Watchlist, in batches of 50. IndexedDB cache entries expire at the earlier of six hours or the publication's own expiry. A hydration generation prevents an older in-flight response from restoring intelligence after its last mapped card is removed.

The display contract validates finite values, quality metadata, known trend states, fixed forecast horizons, probabilities, confidence, and noncrossing q10/q25/q50/q75/q90. Support tiers are layered: Tier 1 observed market, Tier 2 trends, Tier 3 fair value, and Tier 4 forecasts. Invalid or above-tier layers are omitted rather than repaired or guessed.

The Python analytics core requires exact series identity plus `observed_at` and `available_at`; only accepted records knowable at the feature cutoff enter a snapshot. Outliers remain in the immutable ledger and its audit hash but never become features or realized targets. It implements deterministic canonical rows, conservative mapping candidates, rights-gated observation packets, descriptive features, no-change/damped-momentum baselines, quantile validation, pull-scarcity formulas, and the research-only legacy formula. Evaluation uses the seven-day maturity median and reports point, direction, probability, interval, and baseline-relative metrics.

The retrospective builder creates a separate static-baseline model version and selects eligible historical origins at preregistered 30-day spacing. Each origin gets a run/snapshot, an exact feature-dataset hash, and horizon predictions; the model stores a definition hash and current Python code-artifact hash. Deterministic evaluation/scorecard IDs and explicit `retrospective_walk_forward` plus `not_prospectively_generated` reason codes prevent historical simulations from masquerading as prospective outputs. Historical origins are feature cutoffs only: model creation, analytics execution, and evaluation timestamps use the actual generation instant. Rights are checked at that instant and again when guarded SQL executes.

Every matured prediction receives an immutable outcome. A trailing-window target with accepted observations is `scored`; one without them is `unscorable` with null metrics, zero observations, the exact target window, and a reason. Quarantined predictions may still receive outcomes for completeness but are counted separately and excluded from comparable metric slices. Each scorecard stores matured/scored/unscorable/excluded counts, exact evaluation membership, and the full promotion policy. No-change, damped momentum, market index, lifecycle cohort, and structural convergence are required comparisons; absent data makes the result `insufficient`. The SQL exporter recomputes config, evaluation, policy, membership, packet, code-artifact, and per-origin dataset contracts before emitting rollback-first SQL. Promotion remains a separate authenticated human event and the research packet structurally requires empty promotion-review and public-candidate arrays.

The TCGCSV adapter is bounded to a fixed HTTPS origin, response-size limits, one current consistency window, and at most 53 exact-weekly PPMd archives. Packet CLIs have no Supabase credential; the operator explicitly supplies a bounded hosted-row export. A scheduled no-secret workflow runs qualification and monitoring without database writes. There is no production trainer or automatic promotion path.

## 10. Privacy and security

- Full source photos are not uploaded by the app.
- User crops remain local by default.
- Cloud sync includes an inline user image only when under 180 KB; the database enforces a 220 KB ceiling.
- Netlify receives only static deploy artifacts.
- Supabase public keys are safe to expose only because RLS is mandatory.
- Raw price/model/source tables are not browser-readable; only an unexpired, rights-approved publication payload can pass public RLS.
- Netlify headers disable framing, sniffing, geolocation, microphone, and cross-origin camera use.
- External images use `referrerpolicy="no-referrer"`.
- User-entered strings are escaped before HTML insertion.
- Destructive actions require confirmation.

## 11. PWA and offline behavior

The service worker caches the application shell and all local modules. Navigation uses network-first with cached `index.html` fallback. Same-origin scripts, styles, and images use cache-first after first fetch. Approved provider images use a dedicated cache-first store to reduce repeat downloads. External catalog API calls are not intercepted, so stale provider data is not silently substituted as current data.

IndexedDB remains the source of truth offline. Search and price refresh naturally require connectivity.

## 12. Deployment

`netlify.toml` defines:

- build command: `npm run build`;
- publish directory: `dist`;
- Node.js 22;
- SPA rewrite to `/index.html`;
- security headers;
- no-cache service worker;
- long-lived fingerprint-independent asset caching.

Because filenames are currently stable, browser assets use short revalidation headers and service-worker cache versioning. Every release that changes browser modules must increment `CACHE` in `app/sw.js`.

## 13. Testing and validation

`npm run check` executes:

1. custom validation for required files, unsafe placeholders, insecure URLs, missing index references, service-worker shell references, relative import resolution, and JavaScript syntax;
2. Node built-in tests for valuation, sorting, OCR query extraction, similarity, image components/grids/merges, provider normalization, watchlist behavior, publication contracts, and migration-governance markers;
3. Python standard-library tests for point-in-time leakage, robust trends, baselines, five-baseline promotion blocking, Scored/Unscorable outcomes, exact scorecard membership/hash lineage, quantiles, scarcity, and `video_model_v0` reproduction;
4. production build into `dist/`.

CI runs the same command on pushes and pull requests. A path-filtered Python 3.12 workflow independently protects the analytics package.

## 14. Known limitations and next engineering work

- Heuristic detection performs best on separated rectangular items against a contrasting background.
- Perspective correction and rotated-rectangle detection are not yet implemented.
- Tesseract’s first use downloads an external worker/model and may be slow.
- OCR is English-only in the MVP.
- Perceptual hashing detects broad visual similarity but cannot reliably distinguish every parallel.
- Sports-card and comic catalog automation remains manual-assisted.
- Remote snapshot and saved-scan synchronization are schema-ready but not implemented in the client; holdings and explicit deletions are synchronized.
- Portfolio snapshots are currently local; remote snapshot sync is schema-ready but not implemented in the client.
- Stable asset filenames require release discipline around service-worker cache versioning.
- One TCGCSV identity and 53-week cohort are qualified for research only; no public/commercial TCGplayer-derived permission exists. JustTCG's paid contract is the preferred licensed alternative and its bounded adapter is implemented, but no paid account, API secret, or live approved review exists, so public price intelligence remains disabled.
- Migrations 0002 through 0005 are hosted and security-qualified. Migration 0006 is implemented and statically/parser-validated but remains pending a restorable backup, database rehearsal, application, and 36-table RLS/ACL verification. The project has WAL-G without PITR or a physical backup; retained logical dumps do not replace a restorable Auth/storage-aware backup.
- Trend thresholds and interval widths remain configurable research defaults and failed the first real walk-forward calibration gate.
- The August 5 legacy retrospective evidence contains 109 stored evaluations. The 7-day scorecard rejects the damped-momentum baseline; 30/90/180-day slices are insufficient; all scored horizons have negative no-change-relative lift and under-covered 80% intervals. It predates the 30-day/five-baseline/Unscorable evidence contract and cannot support promotion. Human model promotion remains intentionally empty.
