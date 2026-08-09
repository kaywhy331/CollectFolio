# Redesign Foundation

**Status:** Foundation implementation

**Recorded:** August 9, 2026

**Depends on:** `docs/REDESIGN_COMPATIBILITY.md`

## Purpose and review boundary

This tranche establishes the route, view-model, application-shell, and design-token
contracts required before production pages are redesigned. It deliberately keeps
the existing page renderers and version-4 IndexedDB records in place. Reviewers can
therefore evaluate navigation, state normalization, responsive shell behavior, and
truthfulness independently from the later Overview-to-Portfolio visual slice.

This foundation does not authorize a persistence migration, public forecast
activation, provider-rights change, or production page conversion. Existing
source-rights checks and publication gates remain authoritative.

## Supported route map

| Destination | Canonical route | Current renderer | Restorable state |
| --- | --- | --- | --- |
| Overview | `/` | `renderHome` | Route identity |
| Portfolio holdings | `/portfolio?view=holdings` | `renderPortfolio` | Selected section |
| Portfolio watchlist | `/portfolio?view=watchlist` | `renderPortfolio` | Selected section |
| Discover search | `/discover?mode=search` | `renderSearch` | Query, category, provider |
| Insights forecasts | `/insights?view=forecasts` | `renderPortfolio` | Forecast section and publication gate |
| Add | `/add` | `renderAdd` | Route identity |
| Add review | `/add?step=review` | `renderScanReview` | Most recent incomplete local draft |
| Settings | `/settings` | `renderProfile` | Route identity |
| Card detail | `/cards/:cardId` | `renderPriceIntelligenceDetail` | Safe opaque card identity |
| Holding detail | `/holdings/:holdingId` | `renderPriceIntelligenceDetail` | Existing local holding identity |

`app/assets/js/core/router.js` owns parsing, canonicalization, legacy-view mapping,
and route-to-store patches. Navigation uses the History API. Browser Back closes a
detail inspector before leaving its underlying route, and root-relative shell assets
allow canonical detail URLs to survive a hard refresh.

Unknown paths fail closed to Overview. Unsupported query values canonicalize to the
nearest implemented destination while retaining an internal `unsupported` reason;
the shell does not imply that the deferred capability exists.

## Application shell

The shell is static HTML so navigation and top-bar geometry do not shift while local
data hydrates.

- From 320 px through 919 px, the primary navigation is a fixed bottom bar with Home,
  Discover, Add, Portfolio, and Insights. Main content reserves bottom-safe-area space.
- At 920 px and above, the same navigation moves into a persistent 224 px desktop rail.
  The DOM order and keyboard focus order remain identical across layouts.
- The top bar exposes a truthful local portfolio label, Discover search, synchronization
  status, and Settings through the account control.
- The `/` keyboard shortcut opens Discover search and focuses its query field when the
  user is not already editing a form control.
- Active navigation combines `aria-current="page"`, a selected surface, and a physical
  edge marker, so selection does not rely on color alone.
- The responsive acceptance test covers 390, 768, 1024, 1440, and 1920 px widths.

“Local portfolio” is context text, not a selector. “Saved on this device,” “Syncing…,”
and “Cloud sync available” are derived from real session state. The shell contains no
notification affordance, unread badge, multi-portfolio switcher, or command-palette
claim because those capabilities are not implemented.

## Normalized view-model contracts

`app/assets/js/core/view-models.js` is a pure adapter boundary. It never writes to
IndexedDB and never changes provider or publication policy.

### Search result

The adapter emits stable identity, category, descriptive metadata, image reference,
match bucket, pricing status, market value, movement fields, freshness, and forecast
availability. Customer-facing match buckets are `exact`, `likely`, `possible`, and
`unmatched`. Text similarity by itself cannot produce `exact`; that label requires an
approved mapped or exact-source identity.

### Holding

The adapter emits holding and portfolio identities, quantity, condition and grading,
acquisition fields, notes and storage location, manual-value metadata, calculated unit
and total values, timestamps, sync state, and eligible forecasts. It clones derived
arrays and leaves the persistence record unchanged.

### Forecast

Forecast view models include immutable identity, canonical and holding references,
horizon and maturity, interval bounds, currency, confidence disclosure, drivers,
risks, model version, and future maturity-score fields. Support tiers below 4 return
no public forecast models.

### Shell

Shell state is limited to `local`, `syncing`, `synced`, and `error`. Local-only startup
never claims cloud synchronization, multiple portfolios, or unread notifications.

### Pricing states

The normalized pricing states are `verified`, `delayed`, `manual`, `pending`,
`unsupported`, `unavailable`, and `error`. Manual values remain distinguishable from
verified provider values; rights-restricted prices remain unsupported and do not leak
through a fallback.

## Data-state inventory

| State source | Adapter behavior | Foundation constraint |
| --- | --- | --- |
| IndexedDB holdings | Read into normalized holding models | No record rewrite during rendering |
| Pricing snapshots | Current policy version only | No manufactured history |
| Scan drafts | Most recent incomplete draft resolves Add review | Preserve crops and approval decisions |
| Search results | Normalize provider differences at render boundary | Preserve exact-source and canonical distinctions |
| Watchlist items | Preserve `watchKey`, mapping, and tombstone behavior | No identity promotion |
| Intelligence publications | Normalize only retained support-tier fields | Tier and rights gates remain fail closed |
| Authentication | Derive local, syncing, or synced shell copy | Never claim sync without a session |

The version-4 compatibility fixtures remain the migration baseline. A later storage
change requires its own version, idempotence proof, rollback plan, representative
before-and-after fixtures, and approval.

## Semantic token reference

All literal palette values live in the root theme declarations. Components consume
semantic roles, including compatibility aliases used by the legacy renderers.

| Token | Role |
| --- | --- |
| `--color-canvas` | Browser canvas and page background |
| `--color-workspace` | Primary application workspace and chrome |
| `--color-surface` | Normal panels and controls |
| `--color-interactive` | Interactive or selected supporting surface |
| `--color-selected` | Selected-surface tint |
| `--color-text-primary` | Primary copy |
| `--color-text-secondary` | Supporting copy |
| `--color-text-muted` | Low-emphasis metadata |
| `--color-border` / `--color-border-strong` | Normal and emphasized boundaries |
| `--color-action` | Primary actions and selected navigation |
| `--color-positive` | Positive portfolio movement |
| `--color-negative` | Negative portfolio movement |
| `--color-forecast` | Forecast and modeled information |
| `--color-warning` | Incomplete or uncertain state |
| `--color-error` | Operational and validation errors |
| `--color-focus` | Keyboard focus ring |

Primary action and positive movement intentionally use different values. Correct use:
an Add button uses `--color-action`, while a positive return uses `--color-positive`.
Incorrect use: coloring positive returns with the Add-button token or presenting a
forecast in the positive-movement color. Forecast intervals use `--color-forecast`;
warnings and errors remain separate.

The spacing scale is 4, 8, 12, 16, 24, 32, and 48 px through `--space-1` to
`--space-12`. Reusable radii are `--radius-control`, `--radius-panel`, and
`--radius-dialog`. Prices, percentages, and compact metrics use tabular numerals.
Normal page content uses canvas, primary surface, and interactive surface; elevated
shadows are reserved for floating, navigation, modal, and transient controls.

## Component inventory

| Component | Contract | Current implementation |
| --- | --- | --- |
| Application rail / bottom bar | Five supported destinations, active state, keyboard order | `app/index.html`, `.primary-nav` |
| Global top bar | Portfolio context, search, sync, account | `app/index.html`, `shellViewModel` |
| Buttons | Primary, secondary, ghost, danger, compact | `.button` variants |
| Inputs | Text, search, select, textarea, checkbox | Base form styles |
| Tabs | Selected state plus ARIA tab semantics | `.segmented-control` |
| Badges | Supported, restricted, partial, neutral | `.support-badge` variants |
| Panels | One normal panel treatment | `.card`, `.form-section` |
| Dialogs | Focus-managed modal layer and actions | `core/ui.js`, `.modal` |
| Empty / loading / error | Truthful absence and operational state | `.empty-state`, status copy, toasts |
| Card image | Approximately 5:7, contained, no-referrer, fallback | `externalImage`, `.image-placeholder` |
| Route adapter | Parse, canonicalize, patch state | `core/router.js` |
| View-model adapter | Normalize search, holding, forecast, shell | `core/view-models.js` |

Page-specific renderer conversion is intentionally deferred. Existing renderer markup
continues to consume these reusable foundations until each page enters the vertical
slice and receives its own acceptance boundary.

## Validation and acceptance

- Router and view-model unit tests exercise supported and unsupported paths, null-safe
  navigation, match truthfulness, pricing states, immutable holding adaptation,
  forecast gating, and shell states.
- Browser acceptance exercises History API navigation, filter restoration, detail Back,
  holding deep-link hydration, supported shell controls, keyboard search, responsive
  navigation, forecast fail-closed behavior, accessibility, and the visual baseline.
- The repository validator requires the route/view-model modules, semantic and layout
  tokens, supported shell actions, root-relative deep-link assets, documentation, and
  complete service-worker shell coverage.
- The service-worker cache version is `collectfolio-shell-v0.3.0` and includes both new
  core modules.

## Deferred capabilities

The foundation does not expose Sets, Sold, Discover image/sets/market modes, Insights
performance/alerts/track record, notification history, a command palette, portfolio
switching, or public forecasts. It also does not convert production pages, migrate to
IndexedDB v5, add cloud persistence, or weaken any source-rights, mapping, model,
publication, or feature-flag gate.
