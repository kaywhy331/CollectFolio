# Redesign Compatibility Baseline

**Status:** Protection baseline
**Recorded:** August 9, 2026
**Applies before:** routing, normalized view-model adapters, or page conversion

## Purpose

The redesign modernizes the front end around the existing CollectFolio system.
This baseline records the behavior and data that later tranches must preserve.
It is intentionally not a router, storage migration, or page redesign.

The synthetic fixtures under `tests/fixtures/redesign/` contain no credentials,
real account identifiers, private notes, or provider payloads.

## Protected persistence boundary

| Surface | Current contract | Foundation rule |
| --- | --- | --- |
| IndexedDB | Database `collectfolio`, additive version 5; representative v4 fixture retained | Open and read existing stores without destructive conversion; seed only one current local value anchor on upgrade |
| Portable backup | `collectfolio-backup`, version 2; version 1 still imports | Existing exports remain importable and excluded telemetry remains excluded |
| Holdings | Existing embedded `item` snapshot plus acquisition fields | Adapt to view models; do not rewrite records merely to render new pages |
| Snapshots | Legacy `portfolio:YYYY-MM-DD` plus currency-qualified `portfolio:CCC:YYYY-MM-DD`, both with `rights-aware-v1` | Preserve and deduplicate valid current-policy points; do not manufacture missing history |
| Watchlist | Exact canonical or source-level `watchKey` with tombstones | Preserve identity and deletion behavior |
| Scan drafts | Active IndexedDB `scans` records retain editable crops and explicit approval; completed drafts may be compacted into bounded, image-free receipts | Preserve active-draft crops, match decisions, and recovery semantics; never treat completed-receipt retention as permission to prune active work |
| Cloud holdings | Last-write-wins by `updatedAt`, deletion tombstones first | Preserve local images and avoid resurrection or duplication |
| Cloud snapshots | Validated daily identity and deterministic tie-break | Preserve fail-closed validation and merge behavior |
| Intelligence cache | Approved publication payloads keyed by exact variant | Clear or adapt safely; never elevate unsupported data |
| Local value observations | Append-only, source-separated daily unit values keyed by holding; corrections use unique IDs plus `supersedes` | Keep capture time separate from optional catalog source freshness; never backfill history or infer a market observation |
| Demand outbox | Private local queue excluded from backups | Keep excluded from portable imports and exports |

No foundation change may delete, bulk-rewrite, or silently reinterpret these
records. A later persistence change needs its own versioned migration,
representative before/after fixtures, idempotence proof, rollback plan, and
approval.

Version 5 satisfies that later-change boundary additively: it creates only
`localValueObservations` plus `subjectId` and `observedAt` indexes. A version-4
holding with a usable current value receives exactly one upgrade-time anchor dated
when the upgrade runs. The migration does not invent earlier checks, rewrite the
holding, or combine a manual estimate with a catalog series.

## Protected calculation semantics

The protection tests pin these current rules:

- Manual unit value wins when explicitly present, but does not erase the stored
  catalog reference.
- A permitted catalog price is the fallback unit value; a restricted provider
  price contributes zero.
- Holding market value is unit value multiplied by non-negative quantity.
- Cost basis is purchase price multiplied by quantity, plus total fees.
- Portfolio gain is market value minus cost basis.
- Return percentage is unavailable when cost basis is zero.
- Daily snapshots use current calculation output and the current pricing-policy
  version; old-policy snapshots do not enter the chart.

These are compatibility expectations, not permission to display a value whose
source policy is restricted.

## Cloud merge semantics

- Tombstones are resolved before holdings.
- The newest well-formed `updatedAt` wins at holding granularity.
- A locally stored image survives a newer remote record that omits an image.
- A deleted holding cannot be resurrected by an older local or remote record.
- Snapshot rows fail closed on malformed IDs, dates, policy versions, negative
  values, fractional counts, or invalid timestamps.
- Equal-time snapshot conflicts use the existing deterministic payload tie-break.

## Forecast and source-rights boundary

The UI may only consume layers retained by `normalizeIntelligencePayload` for
the publication's approved support tier. It must not reconstruct stripped
prices, trends, fair value, forecasts, confidence, or scorecards.

Public intelligence also remains subject to the runtime build gate, hosted
`public_price_intelligence` flag, exact canonical mapping, current source review,
publication expiry, and operator-controlled model/publication workflows. A new
component or route cannot weaken any of those conditions.

## Legacy view-to-route contract

The current application has in-memory views rather than restorable routes. The
fixture `tests/fixtures/redesign/legacy-routes.json` records their required new
destinations. It distinguishes legacy state from a real legacy URL so the
foundation does not claim compatibility that never existed.

Key decisions:

- `home` becomes Overview at `/`.
- Search becomes Discover search mode.
- Holdings and Watchlist remain Portfolio views.
- Existing Forecasts move under Insights.
- Add and scan review receive restorable Add routes.
- Profile becomes Settings.
- A detail opened for a holding resolves to a holding URL; a catalog result
  resolves to a card URL.
- Browser Back must close a Quick Inspector before leaving its underlying page.

Sets, Sold, Alerts, Track Record, and a multi-portfolio selector are not exposed
until their supporting capabilities exist.

## Browser protection baseline

The browser suite protects the current shell before route conversion:

- guest/local-only startup;
- hydration of a representative version-4 IndexedDB dataset;
- current Overview calculations and first snapshot rendering;
- current primary navigation and Add entry points;
- preservation of active scan-draft visibility and recovery semantics;
- forecast fail-closed presentation when publication is disabled;
- a critical accessibility scan;
- a stable first-use visual snapshot.

Later converted pages add their own route, accessibility, and visual assertions
in the same tranche. The legacy snapshot is not the target design; it is evidence
that foundation work did not accidentally remove working behavior.

## Review gates

Protection baseline approval is required before foundation implementation.
Foundation approval is required before the Overview → Discover → Quick
Inspector → Add → Portfolio slice. Neither approval authorizes a destructive
storage migration or activation of public pricing and forecasts.
