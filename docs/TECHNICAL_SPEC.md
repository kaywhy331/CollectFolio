# CollectFolio Technical Specification

**Version:** 0.7
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
        settings.js           # normalized preferences, onboarding, and sync history
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
        onboarding.js         # persistent first-run storage/currency/Add flow
        profile.js            # collector-facing Settings and data controls
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
    tcgcsv_universe.py       # provider-wide archive normalization/features
    tcgcsv_universe_io.py    # DuckDB/PostgreSQL/catalog-snapshot adapters
    structural_gap.py        # current-origin whole-group structural lab
    structural_gap_cli.py    # mode-0600 private lab packet writer
    qualification.py         # private history/trend/forecast evidence packets
    forecasting.py           # immutable research baseline predictions
    forecast_engine.py       # private 30/90-day calibrated shadow ensemble
    forecast_lab_cli.py      # bounded point-in-time feature-manifest runner
    demand.py                # privacy-gated, versioned interim demand diagnostics
    prospective.py           # canonical challenged-execution payload contracts
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
| `ENABLE_WATCHLISTS` | No | Independent rollback switch for the local Watchlist UI; defaults to `true` |
| `ENABLE_PRICE_INTELLIGENCE` | No | Fail-closed gate for approved public intelligence; defaults to `false` and still requires the hosted publication flag |
| `ENABLE_CLOUD_DATA_REMOVAL` | No | Fail-closed gate for the migration-0015 erasure RPC; defaults to `false` until hosted recovery, rollback, and isolation qualification pass |

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
- auth session, connectivity, pending-change count, and sync state;
- normalized onboarding/preferences and browser storage estimate;
- scan draft count.

The current view is rendered after state mutation. Complex modal workflows own their local transient state to avoid whole-app rerenders while editing Canvas or OCR progress.

### 4.2 IndexedDB

Database: `collectfolio`, additive version 6. New exports use interchange version 2; version 1 backups remain importable. Version 5 added `localValueObservations` and seeded one current anchor for already-valued version-4 holdings without inventing history. Version 6 removes legacy `sourceImage`, `sourceImageRetainedAt`, and `sourceImageDeletedAt` fields from every saved scan; import, export, and normal scan writes apply the same scrub so a full source photo cannot re-enter persistence.

| Store | Key | Contents |
|---|---|---|
| `holdings` | `id` | Catalog snapshot plus ownership metadata |
| `snapshots` | `id` | Portfolio-level daily valuation snapshots stamped with the active pricing-policy version |
| `settings` | `key` | Normalized preferences, onboarding progress, sync history, and diagnostics |
| `scans` | `id` | Active crop drafts plus bounded, image-free completion receipts |
| `catalogCache` | `key` | Search/detail responses with expiry timestamp and bounded retention |
| `deletions` | `id` | Holding tombstones for deterministic cross-device deletion sync |
| `watchlistItems` | `id` | Exact source or canonical variant snapshot plus alert preferences |
| `watchlistDeletions` | `id` | Watch-key tombstones for deterministic cross-device deletion sync |
| `intelligenceCache` | `key` | Last approved public intelligence payloads; no research data |
| `localValueObservations` | `id` | Source-separated, append-only daily unit-value checks for owned holdings; same-day corrections link with `supersedes` |
| `alerts` | `id` | Local in-app alert state |
| `demandEventsQueue` | `id` | Private limited-retention signed-in analytics outbox; excluded from portable backups |

Indexes on holdings include `catalogId` and `updatedAt`. Local value observations
are indexed by `subjectId` and `observedAt`. Their `observedAt` is the device capture
time; optional `sourceUpdatedAt` retains the catalog's declared price date and governs
freshness without being mislabeled as device-observed market history.

Optional cloud sync records the current day's valuation after holdings merge, then reconciles only well-formed `rights-aware-v1` snapshots by canonical currency/day ID and ISO `updatedAt`. New rows use `portfolio:CCC:YYYY-MM-DD`; existing `portfolio:YYYY-MM-DD` rows are read as their embedded currency and canonicalized without deleting the compatibility row. Local and hosted identities must agree on currency, date, and `snapshot_date`; legacy-policy, mismatched, negative, non-finite, or fractional-count records do not cross the sync boundary. Equal timestamps use a stable payload tie-break, and the client never treats an absent hosted snapshot as a deletion.

### 4.3 Settings, onboarding, and portability

`core/settings.js` owns schema version 1 inside the existing `settings` object store;
this is a record migration, not an IndexedDB version change. It fills and normalizes
known keys, removes unknown values from application state, and writes only changed
records. Existing collectors with holdings are marked onboarding-complete the first
time the marker is introduced. Once the marker exists, an explicitly reopened or
partially completed onboarding state wins and survives refresh.

First use persists storage preference, portfolio currency, and the first-Add step before
advancing. Condition and language defaults flow into both manual holding forms and
scan acquisition drafts. Synchronization history is newest-first and bounded to 12
success/error entries; failures store collector-facing recovery copy plus a diagnostic
reference that contains no portfolio data. Pending-change counts include holdings,
both tombstone collections, Watchlist items, and the private demand-event outbox.

Backup import rejects files above 128 MiB before reading them, then validates the
top-level format, every included store, store-specific record shapes, every primary
key, duplicate keys, private/unknown stores, and record-count bounds before starting
a single multi-store read/write transaction. An invalid file performs no writes. Image selection similarly
rejects files above 25 MiB before decode; accepted scan images expose dimensions through
at most 1 MiB of JPEG/PNG/WebP/GIF header data, then a single `createImageBitmap` call
requests decoder-side resize to at most 8,000,000 pixels and a 3,200 px longest edge.
Browsers without that bounded decode path fail closed. Browser storage usage is an estimate from the Storage API
and is reported as unavailable when the browser cannot supply it.

### 4.4 Holding model

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
  seller,
  folder,
  tags,
  notes,
  userImage,
  createdAt,
  updatedAt,
  lastPriceRefresh,
  dirty
}
```

Provider identity data is snapshotted inside the holding so an outage does not remove the collectible reference. Existing holdings are not destructively rewritten: `catalogKey` supplies an exact provider-level bridge, while `canonicalVariantId` remains empty until an approved mapping exists. A legacy provider value remains in the user's record for provenance but cannot enter valuation or display when the source policy marks that route restricted.

Selecting a catalog result opens a prefilled exact-printing summary rather than a second catalog editor. Name, set, number, rarity, finish, artwork, and source are carried forward from the chosen result; the primary form asks only for quantity, condition, and optional purchase price. Dates, fees, seller/source, organization, tags, grading, manual value, notes, and a local photo remain available through progressive disclosure. Custom collectibles retain editable identity fields because no catalog record exists to supply them.

## 5. Valuation rules

- Unit value = `manualMarketPrice` when set; otherwise a locally permitted `item.price`; otherwise 0. Pokémon/TCGplayer catalog prices are restricted until a licensed publication exists.
- Holding market value = unit value × quantity.
- Holding cost basis = purchase price × quantity + fees.
- Unrealized gain = market value − cost basis.
- Return percentage = gain ÷ cost basis × 100 when cost basis is positive.
- Portfolio summary is the sum of holding values and costs.
- Daily snapshot IDs use `portfolio:CCC:YYYY-MM-DD`; subsequent changes in the same currency on the same day replace only that currency’s point. Older `portfolio:YYYY-MM-DD` records remain readable and are deduplicated against their currency-qualified successor. Only snapshots stamped with the current rights-aware pricing-policy version are charted, so an older TCGplayer/Cardmarket-derived total cannot survive the source-policy transition through historical charts.

Market and cost lines are drawn separately so adding a collectible is not visually represented as pure market appreciation. The 90-day SVG includes an explicit currency scale, date anchors, series legend, and exact latest values; it does not rely on an unlabeled line shape.

Portfolio Sets is a derived local view, not a new persistence store. Named sets are grouped by normalized game/category plus set name; exact canonical variants or provider printing/finish identities deduplicate multiple acquisition lots, while copies and lots remain separately counted. Tracked value includes only rights-permitted or manual values in the selected portfolio currency. Unpriced, other-currency, and missing-set records remain explicit. Search, category filters, and sorting only narrow or reorder the retained groups, and rendering begins at 60 groups. The browser never guesses a catalog total or completion percentage; those stay unavailable until an authoritative set manifest is linked.

## 6. Catalog provider abstraction

Every provider normalizes into the internal item shape. The app never stores a provider ID as the holding’s primary key.

### Pokémon

- Search endpoint: `GET https://api.pokemontcg.io/v2/cards`.
- Set discovery endpoint: `GET https://api.pokemontcg.io/v2/sets`, with TCGdex `/v2/en/sets` used for resilient set-name discovery.
- Browse-set cards use the same paginated card endpoint constrained by exact set ID and retain every metadata-only result.
- Detail endpoint: `/v2/cards/{id}`.
- Query parsing prefers the longest contiguous exact set-name match, removes those tokens, and combines the remaining card name and number with the resolved set ID. Thus a set name searches the full set while `card name + set name` searches their intersection; numeric set names such as `Base Set 2` are resolved before card-number parsing.
- Set metadata is cached in browser storage for 24 hours. A failed primary set-ID lookup has a short backoff and falls through to a set-name clause instead of blocking discovery.
- If the primary card provider fails or has no cards for a recognized set, TCGdex set detail supplies the complete set and applies remaining name/number filters locally. An empty result from that complete set is authoritative rather than reported as a provider outage.
- Requests are metadata-only (`id,name,number,rarity,set,images`). Embedded TCGplayer/Cardmarket prices are not requested or normalized.
- The browser build intentionally uses the unauthenticated tier so no private/provider API key is exposed in client code.

### Magic: The Gathering

- Search endpoint: `GET https://api.scryfall.com/cards/search`.
- Set discovery endpoint: `GET https://api.scryfall.com/sets`; digital-only and empty sets are omitted from the paper-card browser.
- Browse-set cards use exact set-code queries and follow every provider page.
- Detail endpoint: `/cards/{id}`.
- Printings remain distinct.
- Regular, foil, and etched USD prices become selectable options.
- Double-faced cards use the first face with image URIs.

### Yu-Gi-Oh!

- Endpoint: `GET https://db.ygoprodeck.com/api/v7/cardinfo.php`.
- Set discovery endpoint: `GET https://db.ygoprodeck.com/api/v7/cardsets.php`; exact set-name card requests are reduced back to matching printings.
- Each returned set printing becomes a distinct internal candidate using set code.
- A small remote image is displayed during search.
- The service worker stores successfully retrieved provider images in a browser-local cache for repeat views.
- On add, the app attempts to create a compressed user-owned copy, further reducing repeat requests.

### Failure isolation

Catalog searches use `Promise.allSettled`. One provider failure produces a partial warning but retains successful provider results.

Discover exposes Search cards and Browse sets as peer intents. Browse routes are `/discover/browse`, `/discover/{game}`, and `/discover/{game}/{set}`. The all-games landing renders its directory without requesting every game’s set index; choosing a game requests only that category’s groups. Games and sets use a provider-neutral adapter, while set products keep their exact provider printing identity. Discover results and sets default to newest-release ordering; Discover results, sets, and products all use flat responsive tile grids with no match-bucket, set-family, or product-family wrappers. Each catalog page mounts at most 48 tiles. TCGCSV set products use the Worker’s bounded 48-row cursor contract; Next fetches only the needed page, while explicit in-set search, type filtering, or cross-page sorting completes remaining metadata before filtering and still slices the result to 48 visible tiles. Product forecast and history hydration coalesces concurrent requests for a shared manifest or group artifact. Set covers hydrate from 48-product samples in small idle batches. Shared catalog tiles preserve wrapping titles and label compact forecast changes as comparisons with the model baseline. Search value sorting uses the same rights-aware catalog valuation gate as displayed values, so a suppressed raw provider price cannot affect ordering. `ENABLE_SET_BROWSING` provides a static rollback gate. Private `tcgcsv_*` tables are never read by this browser path.

### Local caching

The cache key includes category, selected provider, and normalized query. Search and
detail records expire after 30 minutes; maintenance removes expired records and keeps
at most 250 active entries. Provider images from approved hosts are cached separately
by the service worker in its bounded 160-entry store.

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

The client builds an adaptive Sobel edge map, proposes orientation-constrained Hough lines, scores card-shaped quadrilaterals, and returns typed outlines with a confidence and method. An unreliable detection is never reported as success: the editor shows an explicit inset `manual-fallback` outline instead. Canvas stores four corners in original-image coordinates and scales them for display. Pointer interactions support:

- click/tap selection;
- dragging inside a selected box to move;
- dragging any of four corner handles to correct perspective;
- drawing a new box in Add mode;
- deleting a selected box;
- re-running detection;
- replacing boxes with a row/column grid.

The Canvas is keyboard-focusable. `[`/`]` cycle crops, `0` or Escape selects
whole-box movement, `1`–`4` select corners, arrow keys move the active box or corner
by one scale-adjusted step (ten with Shift), and Delete removes it. Every action
updates the live status announcement.

### 7.3 Crop generation

Each four-corner outline is mapped through a projective homography and bilinearly resampled into an upright JPEG with a maximum width of 900 px and 0.90 quality. One shared bounded raster serves sequential crop jobs, which yield between crops to keep the interface responsive. The straightened crop becomes the user-owned portfolio image and remains in IndexedDB; one decoder-bounded source working image may remain only in memory for immediate boundary edits during the active review, is never part of the persisted draft, and is released on navigation, explicit release, discard, completion, or page exit.

### 7.4 OCR

The sequence is:

1. attempt a browser-native `TextDetector` when available;
2. quality-gate native text and otherwise lazy-load one reusable Tesseract.js worker from jsDelivr;
3. probe 0°, 90°, 180°, and 270°, then run grayscale/threshold title and footer passes at the best orientation;
4. fuse only quality-gated pass evidence and reject symbol soup, boilerplate, and short single-token noise;
5. generate ordered title + collector-number, collector-number-only, title, and cautious OCR-noise-relaxed queries;
6. search variants automatically and preserve provider outages as retryable errors instead of false no-matches.

OCR begins when a straightened crop enters review. OCR exceptions, unavailable browser detection, and disabled/unavailable Tesseract all fall through to the independent visual candidate index before returning control to manual query entry; no approved price source is required for identification.

### 7.5 Visual candidate recovery and reranking

The app computes a 64-bit difference hash from a 9×8 grayscale rendering of the straightened crop. A versioned, sharded Pokémon index contains compact catalog metadata and the same fingerprint for 20,392 of 20,444 indexed cards, pinned to an immutable `PokemonTCG/pokemon-tcg-data` commit. When OCR produces no useful catalog result, the nearest index records become real catalog candidates without downloading every provider image.

For OCR-generated candidates whose images permit CORS access, metadata remains primary and full-card dHash is only a tie-breaker:

- 88% title / collector-number metadata match;
- 12% visual hash similarity.

When candidate images cannot be read through Canvas, ranking falls back to metadata similarity. Candidate-image reads are capped at four concurrent requests.

Visual similarity never establishes an approvable catalog identity. A reverse-image
provider result is bridged through the approved TCGCSV catalog and becomes exact only
when one unique product/finish identity remains. A collector-selected TCGCSV candidate
with an exact numeric external product identity is also approvable; ambiguous reverse
bridges and visual-index-only suggestions remain review aids and cannot pass approval.

## 8. Review safety model

A crop can be `queued`, `unmatched`, `identifying`, `matched`, or `error`. Persisted queued/interrupted crops restart automatically when their draft resumes. It is only included in batch add when:

- a candidate or explicit custom fallback is selected; and
- `approved === true`.

“Approve 80%+” is still an explicit user action. The application never runs it automatically.

Review state can be saved as a draft and resumed or discarded independently from Home or Add. Discard is scoped to the selected draft and remains safe if an older recognition task completes afterward. Completion first
copies crop images into approved holdings, then replaces the draft with an image-free
summary receipt. At most 20 completion receipts younger than 30 days are retained;
active drafts are never removed by this maintenance.

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

Authenticated portfolio sync uses those existing CRUD grants and per-user RLS
policies. Holdings, tombstones, snapshots, and Watchlist collections use stable-key
ordering with 500-row Range pages and exact totals, fail closed above 100,000 rows,
upsert at most 20 rows per request, and limit individual remote deletes to 10 at a
time. Snapshot reconciliation remains deterministic last-write-wins with one row per
currency/day through `(user_id, id)`. Saved scan sessions remain device-local because
their image-size and privacy contract has not been approved.

Migration `0021_account_owned_sync_keys.sql` transactionally replaces the global
`holdings.id` and `scan_sessions.id` primary keys with `(user_id, id)` and adds
non-unique ID-only diagnostic indexes. The same client UUID may therefore exist in two
accounts without crossing ownership boundaries. The browser prefers composite-key
upserts and falls back to the legacy `id` conflict target only for PostgreSQL `42P10`,
which is the explicit pre-migration compatibility signal.

Migration `0002_price_intelligence_foundation.sql` is intentionally a separately reviewed operator step. It adds versioned source-terms reviews, a private canonical catalog, a nullable existing-holding bridge, exact-key watchlists and tombstones, runtime product flags, and the only anonymous intelligence publication table. Raw catalog/source tables have no anon or authenticated grants. Public publication RLS re-evaluates every lineage source against its current approved terms review and expiration.

Migration `0003_price_intelligence_research_pipeline.sql` adds private append-oriented mapping candidates/reviews, exact-mapping price observations, data-quality events, analytics runs/source lineage, trend snapshots, descriptive publication candidates/reviews, and immutable promotion receipts. Composite foreign keys bind every observation to its exact source, terms review, approved mapping, variant, and ingestion run. All research tables have RLS with no anon/authenticated grants.

Migration `0004_price_intelligence_function_acl_hardening.sql` removes Supabase default function execution from browser roles and leaves descriptive publication service-role-only. Migration `0005_private_forecast_research_ledgers.sql` adds append-only model versions, research predictions, matured evaluations, scorecards, and promotion-review evidence. Forecast tables are private; predictions are schema-limited to `research_only` or `quarantined`, and the evaluation-lineage trigger helper is unavailable to API roles.

Migration `0006_price_intelligence_governance_hardening.sql` makes the database `public_price_intelligence` flag and exact source attribution part of the public RLS predicate; terms-review rows become append-only. Mapping corrections use a one-to-one supersession RPC that preserves referenced versions. Model records distinguish static definitions, nullable training datasets, and code artifacts. Every matured outcome is `scored` or `unscorable`, while scorecards persist a complete case partition, exact membership/hash, and versioned policy/hash. Direct service-role model-review inserts are revoked: an authenticated JWT with server-managed `app_metadata.price_intelligence_operator=true` must use `review_model_promotion`. Descriptive publication and per-card quarantine remain separate service-role RPCs, and disable actions append control receipts. This migration added two RLS-protected tables and is included in the hosted migration inventory recorded below.

Migration `0019_centralized_historical_price_imports.sql` defines the operated central
history store for bulk backfills. It adds append-only import manifests and exact
import-to-observation membership, allowing identical observations in overlapping rolling
archives to be reused without transferring physical row ownership. Deterministic import,
run, series, observation, and membership contracts make exact replay a no-op and reject
conflicting overlap. Each batch is bounded to 2,000 exact series and 100,000 observations.
The source availability claim is retained as `source_available_at`; PostgreSQL authors
`collectfolio_first_seen_at` and advances effective `available_at` to at least that time.
`observed_at_proxy` can be stored but is marked point-in-time-ineligible. The tables have no
browser grants. A security-invoker, service-role-only
`centralized_history_publication_evidence` view chooses the earliest sealed eligible import
per observation, preserving retrospective eligibility when later archives overlap. It
carries source availability, database first sight, and import seal time; proxy-only rows
are absent. The migration installs no forecast publisher, and applying it to a hosted
database remains a separate backed-up operator action.

Migration `0015_remove_my_cloud_data.sql` is checked in and intentionally not applied.
It installs one authenticated security-definer RPC that binds its target to
`auth.uid()`, removes only that collector's portfolio, Watchlist, snapshot, scan, and
private-market rows, and retains the Auth account and profile. The client requires an
online session and typed confirmation, signs out after success, and leaves local data
untouched. RPC installation and any later invocation are separate transactions;
installation itself removes no collector data.

The service-role-only `publish_descriptive_intelligence` function accepts only a latest approved candidate review with source-rights and mapping attestations. It rechecks current commercial, attribution, and per-usage permissions, rejects non-published or above-Tier-2 payloads and any `fairValue`/`forecasts` key, then atomically replaces the public payload and lineage. It does not change the public feature flag. The flag remains a separate global operator decision; `disable_public_intelligence` is the append-receip per-card rollback path.

The service-role key is never used or exposed in the browser.

### 9.3 Sync algorithm

1. Obtain a valid user session, refreshing if required; derive the account UUID from the signed access-token `sub` and reject conflicting session metadata.
2. Atomically claim the local collection's persistent sync owner. A different account cannot reuse that browser collection until local data is deliberately cleared or restored into its intended account.
3. Read local holdings and local deletion tombstones.
4. Read account-filtered remote holdings and tombstones; verify that every returned row repeats the signed-in owner UUID and fail closed otherwise.
5. Merge tombstones by holding UUID, retaining the newest `deletedAt` value.
6. Upsert new local tombstones to Supabase.
7. Purge every tombstoned holding locally and issue only account-filtered remote deletes.
8. Exclude tombstoned IDs, group remaining holdings by app-generated UUID, and retain the copy with the lexicographically newest ISO `updatedAt`.
9. Write merged holdings to IndexedDB and upsert them with `on_conflict=user_id,id` (using the narrow pre-0021 fallback above).
10. Mark synchronized local rows clean.

The watchlist follows the same deletion-first/LWW pattern using its exact `watchKey`. A default cloud watchlist is obtained through an invoker-secured RPC. Failure of the optional watchlist schema does not roll back an otherwise successful holdings sync; the user receives a migration-required warning and local watchlist data stays intact.

The shell derives `local`, `pending`, `syncing`, `synced`, `offline`, or `error` from
the actual session, connectivity, dirty records, last-success timestamp, and current
request state. Offline and failed operations retain local writes. A reconnect retries
a signed-in pending or failed sync automatically, while a generation guard prevents
an older search response from replacing a newer query.

This is deterministic last-write-wins at holding granularity with persistent deletion tombstones. It does not merge individual fields. Clearing all browser data is intentionally different from deleting holdings inside the app: a browser reset does not issue cloud deletions, while an explicit holding deletion records a tombstone and propagates on the next sync.

### 9.4 Publication hydration and analytics isolation

The browser requests publications only for deduplicated canonical UUIDs represented in Holdings or Watchlist, in batches of 50. IndexedDB cache entries expire at the earlier of six hours or the publication's own expiry. A hydration generation prevents an older in-flight response from restoring intelligence after its last mapped card is removed.

The display contract validates finite values, quality metadata, known trend states, fixed forecast horizons, explicit available/limited status, probabilities, confidence, and noncrossing q10/q25/q50/q75/q90. Trajectory-v1 additionally validates bounded exact manifest membership, object keys, group/category/part identity, optional variant counts, product/finish identity, model version, allowed confidence, ordered median paths, and only 30/90-day checkpoints; groups and manifest parts are fetched with bounded concurrency. Support tiers are layered: Tier 1 observed market, Tier 2 trends and approved observation history, Tier 3 fair value, Tier 4 forecasts, and Tier 5 complete public scorecards. Invalid, stale, or above-tier layers are omitted rather than repaired or guessed. Search withholds stale trajectories; detail gives an explicit newer-observation explanation. A Tier-4 product outlook plots an approved history line when one is published, marks the present boundary, and renders future medians as a dotted path inside distinct 50%/80% quantile bands. The browser never reconstructs history from trend percentages or extrapolates a forecast from them; without both an approved observation and approved forecast, the projection graph is absent.

Insights has independent restorable Performance, Forecasts, Alerts, and Track Record routes. Performance consumes only local portfolio snapshots. Local Scenario Outlooks use source-separated saved unit values and qualitative confidence, work from a single deliberately broad anchor, refuse values stale beyond 180 days, and never feed Track Record. Published portfolio forecast aggregation remains separate and excludes manual values, unmapped holdings, missing horizons, missing approved observations, and currencies that would require an unapproved conversion. Confidence scores are preserved item-by-item as a score or range rather than averaged into a new claim. Actual current value and either modeled future product remain separate in markup, copy, and visual treatment.

The latest publication keeps the bounded `intelligence:v1:` TTL cache. Refresh also writes a content-addressed `intelligence-history:v1:` receipt into the existing `intelligenceCache` store only when its key does not exist. These public-payload receipts support revision links and open/matured status without exposing private prediction ledgers. The browser never derives maturity outcomes or accuracy from a later current price. It shows evaluation fields only when a complete approved record exists and aggregate percentages only from Tier 5 scorecards. Alert read and per-notification mute timestamps remain optional backward-compatible fields in the existing `alerts` store.

The Python analytics core requires exact series identity plus `observed_at` and `available_at`; only accepted records knowable at the feature cutoff enter a snapshot. Outliers remain in the immutable ledger and its audit hash but never become features or realized targets. It implements deterministic canonical rows, conservative mapping candidates, rights-gated observation packets, descriptive features, no-change/damped-momentum baselines, quantile validation, pull-scarcity formulas, and the research-only legacy formula. Evaluation uses the seven-day maturity median and reports point, direction, probability, interval, and baseline-relative metrics.

The client never owns the historical corpus. CollectFolio's centralized database retains
normalized history for every supported exact catalog variant as licensed data becomes
available, including later bulk loads. A backfill first seen today may support an estimate
generated today but not an earlier walk-forward origin. Before descriptive publication,
the complete trend snapshot and observed value must reproduce from the sealed centralized
evidence view using database-effective availability and import seal time. Publications may
then carry an optional, rights-gated chart slice of at most 180 ascending exact-series
points; final hosted revisions are selected across every status before accepted rows are
filtered. Authenticating a physical card is outside this data and forecasting contract.

The retrospective builder creates a separate static-baseline model version and selects eligible historical origins at preregistered 30-day spacing. Each origin gets a run/snapshot, an exact feature-dataset hash, and horizon predictions; the model stores a definition hash and current Python code-artifact hash. Deterministic evaluation/scorecard IDs and explicit `retrospective_walk_forward` plus `not_prospectively_generated` reason codes prevent historical simulations from masquerading as prospective outputs. Historical origins are feature cutoffs only: model creation, analytics execution, and evaluation timestamps use the actual generation instant. Rights are checked at that instant and again when guarded SQL executes.

Prospective execution is a separate unapplied 0017/0018 contract. A future-dated
scorecard plan binds the model, independent executor key, exact-series policy, horizon,
cohort/source/purpose, 6–18 exact future origin slots, five-baseline policy, and
quantitative gates before outcomes. Slot anchors are at least 22 days apart so their
24-hour challenge windows leave 21 full days between any two actual origins, and every
slot must be consumed exactly once. A database nonce then binds one
manifest-complete trend run to one still-running
output-free forecast run. The isolated executor HMAC-signs an order-independent packet
covering exact-series quantiles, confidence/status/reasons, origin-time cost commitment,
five baseline prices, after-cost probability, and structural lower bound. The guarded
transaction independently rehashes it, finalizes the analytics run, makes challenge
issuance the forecast origin, and writes immutable receipts and prediction-level outputs.
Every prediction insert first locks its analytics-run row and rejects challenged-run
writes outside the receipt transaction. The recorder holds that same lock, rechecks for
zero unsigned predictions immediately before finalization, and admits its reconstructed
rows only under a transaction-local challenge identifier, closing the direct-insert race.
Before commit—and again at scorecard creation—the canonical commitment is reconstructed
from stored typed predictions, cost rows, baselines, and database-required reason codes.
`service_role` cannot read/provision executor keys or call the older unattested writer.

`tests/postgres/run_forecast_runtime.py` provides executable local evidence against a
fresh database on an isolated PostgreSQL 15+ cluster. It applies every checked-in
migration except the unrelated pg_cron-only 0008 schedule, then exercises key ACLs,
malformed payload and HMAC tamper/replay rejection, terminal-run and challenged-run lock
serialization, expired-challenge and late-failure rollback, a complete provider-cost row,
a Python-signed receipt, and canonical stored-output parity. This is a narrow compatibility
and transaction
contract test, not hosted Supabase proof: restored-backup migration behavior, production
roles/RLS, pg_cron, provider rights, executor isolation, prospective outcome windows, and
six-slot scorecard execution plus human promotion review remain separate gates. The test
cannot enable public forecasts.

After the full plan window matures, one dedicated evaluation run must contain exactly
one outcome per planned prediction. The prospective scorecard RPC accepts only plan/run
IDs and derives exact membership plus point, direction, Brier/calibration, pinball,
coverage/width, five-baseline, deterministic origin-cluster bootstrap, after-cost, and
selected-pocket metrics in the same transaction as its hashes and recommendation.
Direct prospective scorecard declarations are denied. The HMAC is principal attestation,
not cryptographic workload proof, so receipts retain `artifactExecutionVerified=false`.
No prospective function publishes a forecast or enables a feature flag.

Every matured prediction receives an immutable outcome. A trailing-window target with accepted observations is `scored`; one without them is `unscorable` with null metrics, zero observations, the exact target window, and a reason. Quarantined predictions may still receive outcomes for completeness but are counted separately and excluded from comparable metric slices. Each scorecard stores matured/scored/unscorable/excluded counts, exact evaluation membership, and the full promotion policy. No-change, damped momentum, market index, lifecycle cohort, and structural convergence are required comparisons; absent data makes the result `insufficient`. The SQL exporter recomputes config, evaluation, policy, membership, packet, code-artifact, and per-origin dataset contracts before emitting rollback-first SQL. Promotion remains a separate authenticated human event and the research packet structurally requires empty promotion-review and public-candidate arrays.

The TCGCSV adapter is bounded to a fixed HTTPS origin, response-size limits, one current consistency window, and at most 53 exact-weekly PPMd archives. Packet CLIs have no Supabase credential; the operator explicitly supplies a bounded hosted-row export. A scheduled no-secret workflow runs qualification and monitoring without database writes. There is no production trainer or automatic promotion path.

## 10. Privacy and security

- Full source photos are neither uploaded nor persisted by the app; the bounded working image exists only in memory for the active review and is released when that review closes.
- User crops remain local by default.
- Cloud sync includes an inline user image only when under 180 KB; the database enforces a 220 KB ceiling.
- Netlify receives only static deploy artifacts.
- Supabase public keys are safe to expose only because RLS is mandatory.
- Raw price/model/source tables are not browser-readable; only an unexpired, rights-approved publication payload can pass public RLS.
- Netlify headers disable framing, sniffing, geolocation, microphone, and cross-origin camera use.
- External images use `referrerpolicy="no-referrer"`.
- User-entered strings are escaped before HTML insertion.
- Destructive actions require confirmation.
- Local and cloud deletion are distinct typed-confirmation paths; clearing the browser
  never manufactures cloud tombstones or invokes the cloud-removal RPC.
- Portable imports complete full preflight validation before one atomic write
  transaction, and private activity records cannot enter or leave through backups.

## 11. PWA and offline behavior

The service worker caches the application shell and all local modules. Shell
`collectfolio-shell-v0.8.27` includes the Settings, onboarding, local-scenario, image-identification, complete 48-tile catalog pagination, demand-driven provider-neutral set-browse, searchable 90-category TCGCSV directory, authenticated category-scoped TCGCSV provider, legacy TCGCSV identity-to-image reconstruction, interactive history/forecast chart controls, and local Collection Sets modules plus the visual-index manifest. Navigation
uses network-first with cached `index.html` fallback. Same-origin scripts, styles, and
images use cache-first after first fetch. Approved provider images use a dedicated,
160-entry cache-first store to reduce repeat downloads without unbounded growth. The
visual index uses a separate 20-entry cache, enough for its manifest and 16 shards;
the installed shell manifest remains the first-offline-use fallback.
Runtime configuration uses network-first delivery with its installed copy as an
offline-only fallback, so key rotation and feature rollback are not hidden by a stale
shell cache. External catalog API calls are not intercepted, so stale provider data is
not silently substituted as current data.

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
2. Node built-in tests for valuation, rights-aware sorting, OCR query extraction/fallback, exact recognition approval, similarity, bounded image work, image components/grids/merges, provider normalization, account-bound sync, watchlist behavior, trajectory/publication contracts, and migration-governance markers;
3. Python standard-library tests for point-in-time leakage, robust trends, baselines, five-baseline promotion blocking, Scored/Unscorable outcomes, exact scorecard membership/hash lineage, quantiles, scarcity, and `video_model_v0` reproduction;
4. production build into `dist/`.

CI runs the same command on pushes and pull requests, then qualifies the recognition path on Chromium, Firefox, and WebKit. A path-filtered Python 3.12 workflow independently protects the analytics package, and a second job installs the optional DuckDB/PostgreSQL adapters, applies every migration to disposable PostgreSQL 16, proves account-owned sync-key/RLS behavior, and prevents provider-wide Parquet tests from silently skipping.

## 14. Known limitations and next engineering work

- Heuristic detection performs best on separated rectangular items against a contrasting background.
- Heuristic rotated/perspective detection can still require manual corner correction.
- Tesseract’s first use downloads an external worker/model and may be slow.
- OCR is English-only in the MVP.
- Perceptual hashing detects broad visual similarity but cannot reliably distinguish every parallel.
- Sports-card and comic catalog automation remains manual-assisted.
- Saved-scan synchronization remains schema-ready but is not implemented in the client; crop-image payload limits and the cross-device privacy contract still need an explicit design decision.
- Stable asset filenames require release discipline around service-worker cache versioning.
- One TCGCSV identity and 53-week cohort are qualified for research only; no public/commercial TCGplayer-derived permission exists. JustTCG's paid contract is the preferred licensed alternative and its bounded adapter is implemented, but no paid account, API secret, or live approved review exists, so public price intelligence remains disabled.
- Migrations 0001 through 0014 are hosted. Migration 0006's guarded mapping supersession and ACL/RLS contracts have been exercised against the hosted project, and migrations 0009/0014 now hold the reviewed pull-rate registry and explicit missing-data evidence. Migration 0015 is checked in but intentionally unapplied. The project still lacks independently retained proof of a restorable Auth/storage-aware backup; WAL-G without PITR and logical dumps do not satisfy that recovery requirement for a future destructive migration.
- Trend thresholds and interval widths remain configurable research defaults and failed the first real walk-forward calibration gate.
- The August 5 legacy retrospective evidence contains 109 stored evaluations. The 7-day scorecard rejects the damped-momentum baseline; 30/90/180-day slices are insufficient; all scored horizons have negative no-change-relative lift and under-covered 80% intervals. It predates the 30-day/five-baseline/Unscorable evidence contract and cannot support promotion. Human model promotion remains intentionally empty.

## 15. Private market-universe plane

Migration `0020_tcgcsv_market_universe.sql` adds a private provider-native
current-state plane backed by immutable raw archives and daily Parquet history.
The daily compiler produces one feature row for every current provider series
and one set feature for every archive group, including explicit insufficient
rows. It produces limited research-only 30/90/180/365-day damped-momentum
estimates but installs no public forecast publisher.

Archive evidence records the actual post-acquisition `source_available_at` and
binds raw, Parquet, market-feature, and set-feature object URIs plus their hashes
into the sealed run. After catalog ingestion, the restricted role exports all
current catalog rows under `REPEATABLE READ` with a database-authored
availability timestamp, latest pointers, per-row run provenance, row counts,
the sealed feature hash/count, an exact current-series manifest hash, and
price/product reconciliation. Partial refreshes and unresolved or missing
priced products are explicit abstentions.

The separately disabled Sunday Structural Gap Lab consumes only that current
feature object and catalog snapshot. It partitions complete provider groups
across disjoint training, calibration, and held-out sets; compiles subtype,
rarity, card-type, set-age, and target-excluding peer aggregates; and emits
private held-out current-price bands with fold/artifact/input hashes. Three
gap-free weekly origins spanning at least 14 days are required for persistent
below-band telemetry. V2 has a single pinned NumPy 2.4.2 float64 solver path,
rounds coefficients before use, and seals the solver version, actual NumPy
runtime, precision, and implementation-source hash into packets, fold/artifact
hashes, and persistence compatibility. It claims neither future value nor
canonical identity and has no browser/publication integration. V2 models
Pokémon category 3 only while hashing all full-archive exclusions; games cannot
share folds or coefficients.
Full packets remain in private object storage, and the public-repository Actions
artifact exposes sanitized receipts only.

Trajectory-v1 forecasts are fitted on the weekly panel and serve calibrated
30-day and 90-day quantile checkpoints plus a weekly median path. Component
weights selected at those two horizons are blended continuously across the
intermediate weekly path, avoiding the former nearest-horizon switch around
day 60. The detail chart resamples that single latest path into daily hover
values; those values are interpolation, not independent daily refits. Its
1M/3M/6M/1Y/All controls change observed-history context only, while the
forecast overlay remains independently switchable and never extends beyond
the served horizon. The browser accepts only a bounded, exact manifest/part set
whose group envelope, product/finish identity, model version, confidence, horizons,
ordered path, and five noncrossing quantiles validate. A trajectory older than the
current observation is withheld instead of being presented against fresher data.

Search-result hydration now includes canonical variants represented by the
current search result set in addition to Holdings and Watchlist. The result
adapter and view display name, type, set, observed price, approved rolling
30-day return, and approved 1/3/6/12-month median estimates. Exact market-series
selection, support-tier validation, rights checks, and the public feature flag
still fail closed; private TCGCSV rows never enter that client path directly.

See [TCGCSV_MARKET_UNIVERSE.md](TCGCSV_MARKET_UNIVERSE.md) for the data layout,
sync algorithm, role/object-store requirements, and recovery contract.
