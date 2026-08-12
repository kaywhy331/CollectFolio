# Redesign Core Vertical Slice

**Status:** Implemented

**Recorded:** August 10, 2026

**Depends on:** `docs/REDESIGN_FOUNDATION.md`

## Review boundary

This tranche converts the local-first path from Overview through Discover, Quick
Inspector, basic catalog Add, Portfolio Holdings, and Card/Holding Detail. It uses
the route, view-model, semantic-token, and application-shell contracts approved in
the redesign foundation.

It does not change IndexedDB version 4, rewrite holding records, activate a public
price or forecast source, relax source-rights checks, or expose capabilities whose
data model is not ready. Existing scan review, cloud synchronization, Watchlist,
Insights publication, and provider-governance behavior remains intact.

## Completed slice

| Surface | Implemented behavior | Truthfulness boundary |
| --- | --- | --- |
| Overview | Range-filtered portfolio chart, cohesive value summary, pricing coverage, attention items, movers, recent holdings, collection mix | A first holding creates one current point; no missing history or forecast is invented |
| Discover | Unified query, direct image entry, category-aware filters, advanced source choice, recent queries, gallery/list preference, grouped match quality | Raw match percentages are hidden; exact requires an approved exact identity |
| Quick Inspector | Desktop side panel, mobile bottom sheet, Add, Watch, full detail, focus trap/return, Escape and browser Back | The underlying result set remains rendered and inert; unavailable price and forecast states stay explicit |
| Add | One automatic scan/upload entry plus catalog, backup, and custom paths | The user is not asked to predict one versus many cards; every existing approval gate remains in force |
| Portfolio Holdings | Cohesive summary, combined filters, removable chips, expanded sorting, gallery/list preference, bounded rendering, selection-only bulk tools | Market, manual, and unpriced values remain distinct; unpriced holdings remain editable |
| Card/Holding Detail | Large artwork, exact identity, ownership, market, forecast, sales, and data-detail regions | Technical mapping is collapsed; current value, holding value, fair value, and forecast remain separate |

## Overview contract

The Overview range control supports 1D, 7D, 1M, 3M, 1Y, and All. It filters stored
daily snapshots and appends only the current calculated portfolio point. With one
point it says “Tracking began today.” Selected-range movement is shown only when two
valid points exist.

Pricing coverage counts holdings, not quantity. It reports market-priced, manual,
and unpriced holdings independently. Forecast coverage is unavailable unless the
hosted feature flag is enabled and a tier-4 publication survives browser contract
normalization.

## Discover and inspector contract

Ordinary search defaults to every enabled provider. A provider may be selected only
inside the advanced Data Source control. Set, number, and variant filters are applied
to the returned catalog candidates; sports, comics, and slabs adapt to identity
fields used by custom entry.

Result groups are Exact, Likely, Possible, and Review. The entire result card opens
the Quick Inspector while Add and Watch remain independent controls. Gallery/list
preference and recent searches persist as local settings. Search terms and filters
survive partial-provider errors.

An inspector push creates a restorable detail URL without replacing the visible
Discover or Portfolio result set. Escape, the close control, and browser Back return
to the originating card and restore keyboard focus. “Open full details” keeps the
same URL and converts the overlay into the directly linkable page.

## Portfolio and detail contract

The Portfolio summary presents market value, cost basis, gain or loss, unique and
total quantity, pricing coverage, and last update as one region. Filters combine
query, category, set, raw/graded/sealed state, condition, grading company, language,
pricing state, and gain/loss state. Sorting supports value, gain, loss, added time,
changed time, name, set order, quantity, and missing information.

The renderer shows at most 100 holdings initially and adds the next bounded page on
request. Selection reveals Edit, selected CSV export, and confirmed Delete only.
Unsupported Move, Tags, and Sold operations are not exposed.

Full detail keeps exact identity outside technical disclosure. Holding quantity,
condition or grade, portfolio value, cost basis, and notes are separate from general
market data. Missing market prices show “Card identified” and remain actionable.
Verified sales do not appear until a source can identify the exact raw, graded,
sealed, or other variant.

## Compatibility and safety

- IndexedDB stays at version 4 and existing version-4 fixtures hydrate unchanged.
- View adapters and renderers do not rewrite records merely to display them.
- Manual values override portfolio valuation without deleting provider references.
- Rights-restricted prices remain excluded from valuation and public display.
- Public forecasts still require the runtime gate, hosted flag, exact mapping,
  source review, valid publication, and sufficient support tier.
- Full source photos remain browser-local and every crop still requires explicit
  approval before addition.
- New external images retain `referrerpolicy="no-referrer"` and safe URL filtering.

## Responsive and accessibility acceptance

- Overview, Discover, Add, Portfolio, Inspector, and Detail use one-column mobile
  layouts and expand without changing metric meaning.
- Discover gallery reaches at least four columns at a typical 1440 px desktop width.
- The Inspector avoids the mobile navigation safe area and becomes a right rail from
  the desktop breakpoint.
- Inspector focus is trapped, Escape closes it, and focus returns to its origin.
- Result and holding cards support Enter and Space in addition to pointer activation.
- Status and movement use text or symbols as well as semantic color.
- The first-use Overview has no serious or critical axe violations.

## Verification

Unit coverage protects Overview ranges and coverage, Discover grouping and adaptive
filters, unified Add entry, Inspector unavailable states, Portfolio filters/sorts,
selection-only bulk tools, pricing-source distinctions, and full Detail disclosure.

Browser acceptance protects primary routes, responsive shell geometry, deep-link
hydration, Quick Inspector focus/Back/full-detail behavior, version-4 compatibility,
scan recovery, forecast fail-closed behavior, accessibility, and the new core-slice
visual baseline. The prior legacy Overview image remains retained as protection
history. The service-worker shell is `collectfolio-shell-v0.4.0` and precaches the
Quick Inspector module.

## Deferred capabilities

At core-slice acceptance, redesigned scan review, bulk acquisition, and full
Watchlist remained deferred. Those three capabilities are now implemented under the
separate Phase 3 boundary in `docs/REDESIGN_INTAKE_COLLECTION_MANAGEMENT.md`.

Sets, Sold, multi-portfolio switching, public Insights, notification history,
command palette, front/back image switching when no back image exists,
related-variant browsing, and verified sales remain deferred until their supporting
data and acceptance boundaries are ready.
