# CollectFolio Technical Specification

**Version:** 0.1  
**Target:** Static Netlify PWA + optional Supabase  
**Runtime:** Modern evergreen browsers; Node.js 20+ for build/test scripts

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
        providers/
      views/
scripts/
  build.mjs
  dev.mjs
  validate.mjs
supabase/migrations/
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

The supplied URL is `https://agmjgyyvhfcivbwdlvzk.supabase.co`. The public key is intentionally not committed.

## 4. Client state and persistence

### 4.1 In-memory state

`core/store.js` exposes `getState`, `setState`, and `subscribe`. State contains:

- active view;
- holdings and snapshots;
- settings;
- search request/results/error;
- portfolio filter/sort;
- auth session and sync state;
- scan draft count.

The current view is rendered after state mutation. Complex modal workflows own their local transient state to avoid whole-app rerenders while editing Canvas or OCR progress.

### 4.2 IndexedDB

Database: `collectfolio`, version 2. The backup interchange format remains version 1 for backward-compatible import/export.

| Store | Key | Contents |
|---|---|---|
| `holdings` | `id` | Catalog snapshot plus ownership metadata |
| `snapshots` | `id` | Portfolio-level daily valuation snapshots |
| `settings` | `key` | Currency, theme, and preferences |
| `scans` | `id` | Draft crops and review progress |
| `catalogCache` | `key` | Search responses with expiry timestamp |
| `deletions` | `id` | Holding tombstones for deterministic cross-device deletion sync |

Indexes on holdings include `catalogId` and `updatedAt`.

### 4.3 Holding model

```js
{
  id,                    // app UUID
  catalogId,             // provider-independent reference string
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

Provider data is snapshotted inside the holding so a provider outage does not remove identity or last-known value.

## 5. Valuation rules

- Unit value = `manualMarketPrice` when set; otherwise `item.price`; otherwise 0.
- Holding market value = unit value × quantity.
- Holding cost basis = purchase price × quantity + fees.
- Unrealized gain = market value − cost basis.
- Return percentage = gain ÷ cost basis × 100 when cost basis is positive.
- Portfolio summary is the sum of holding values and costs.
- Daily snapshot IDs use `portfolio:YYYY-MM-DD`; subsequent changes on the same day replace that day’s point.

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
- Price options are derived from returned TCGplayer finish fields.
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

This is deterministic last-write-wins at holding granularity with persistent deletion tombstones. It does not merge individual fields. Clearing all browser data is intentionally different from deleting holdings inside the app: a browser reset does not issue cloud deletions, while an explicit holding deletion records a tombstone and propagates on the next sync.

## 10. Privacy and security

- Full source photos are not uploaded by the app.
- User crops remain local by default.
- Cloud sync includes an inline user image only when under 180 KB; the database enforces a 220 KB ceiling.
- Netlify receives only static deploy artifacts.
- Supabase public keys are safe to expose only because RLS is mandatory.
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
2. Node built-in tests for valuation, sorting, OCR query extraction, similarity, image components/grids/merges, and provider normalization;
3. production build into `dist/`.

CI runs the same command on pushes and pull requests.

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
