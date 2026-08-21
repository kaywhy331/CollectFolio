# CollectFolio Premium UX Release Acceptance

**Acceptance date:** 2026-08-20
**Scope:** CollectFolio Premium UX Redesign PRD
**Canonical requirements:** `PRD/CollectFolio Premium UX Redesign — PRD & UI-UX Specification.md`

This receipt records deterministic repository acceptance. Browser tasks use real DOM, pointer, touch, keyboard, IndexedDB, history, focus, and network-failure behavior with controlled catalog fixtures. It does not represent a moderated human panel or production field telemetry; metrics that require an installed-user population are explicitly dispositioned below.

## Release result

The implementation passes the premium acceptance layer:

- Final repository gate: validation, 463 JavaScript tests, 648 analytics tests (5 skipped by their documented environment gates), and the production build all pass.
- Final browser gate: all 44 Chromium end-to-end scenarios pass.
- Eight viewport classes from 320 × 720 through 1920 × 1080, including mobile landscape, touch, and mouse.
- Keyboard navigation and 200% text zoom without horizontal overflow, clipped controls, or obscured focus.
- Axe WCAG 2.2 A/AA scans across Home, Discover, Scan, Collection, and Insights with no serious or critical violations.
- Lighthouse accessibility score 100 on desktop and mobile; best-practices score 100 on both.
- Lab LCP 808 ms, interaction latency 120 ms, and CLS 0 in the repeatable Playwright release fixture.
- A failed remote image exposes Retry image and recovers in place.
- A 5,000-result catalog remains bounded to 200 rendered cards; the renderer completed in approximately 224 ms in the test environment.

The Chrome DevTools audit found a development-server ES-module waterfall rather than a CSS bottleneck. Adding an early `modulepreload` for the application graph reduced its measured maximum critical request path from 2,011 ms to 276 ms. The raw HTTP/1.1 development trace has no CrUX field data and is not used as the production percentile; the repeatable release fixture remains the lab performance gate.

## Post-deploy visual follow-up — 2026-08-21

A populated migration fixture was audited against the live `0.8.28` application at
1440 × 900 and 390 × 844 across Home, Discover, Scan, Collection, and Insights.
The ten representative captures produced no browser errors and did not reveal a P0
workflow, hierarchy, overflow, or action-reachability defect.

The audit did expose one narrow-screen readability gap in the collection-value
chart: its fixed desktop SVG viewBox scaled 11-unit axis labels to approximately
4–5 CSS pixels on a phone. The next-release change gives that chart a scoped mobile
axis treatment and sufficient plot margin. A 320 × 720 browser regression now
measures the rendered label boxes, requires readable height, and proves that every
label stays inside the chart. The audited post-fix fixture renders those labels at
13 CSS pixels at 320 px.

An apparent clipped global header in whole-viewport Chromium screenshots was
investigated and rejected as a capture artifact: live DOM geometry, overflow, and
route-by-route element screenshots all show the complete header within the viewport.

The remaining follow-ups still require evidence that repository automation cannot
manufacture: a moderated external collector study, physical-device review, manual
screen-reader review, and consented production field metrics. None is represented
as complete by this receipt. The execution protocol and blank evidence receipt are
[`PREMIUM_UX_HUMAN_VALIDATION.md`](PREMIUM_UX_HUMAN_VALIDATION.md) and
[`receipts/PREMIUM_UX_HUMAN_VALIDATION_TEMPLATE.md`](receipts/PREMIUM_UX_HUMAN_VALIDATION_TEMPLATE.md).
Those artifacts make the work reproducible; their existence does not close a human gate.

## Required usability-task simulations

| # | Task | Acceptance evidence | Result |
|---:|---|---|---|
| 1 | Find an exact known card or product | Catalog search fixture returns and opens the requested exact result; `portfolio-history-chart.spec.js` completes the search flow. | Pass |
| 2 | Browse game → set → exact item | `browse-sets.spec.js` drills from Pokémon to Silver Tempest, preserves the route after reload, and reveals all 121 cards. | Pass |
| 3 | Distinguish pack, box, and case | `discover.test.js` renders one product family with explicit Booster pack, Booster box, and Case badges. | Pass |
| 4 | Add a confirmed item | `portfolio-history-chart.spec.js` confirms identity, opens the purchase form, saves, and verifies Collection state. | Pass |
| 5 | Resolve an uncertain match | Quick Inspector and scan-review tests withhold Add until `Confirm exact item`; alternative/manual recovery remains available. | Pass |
| 6 | Scan multiple items | The two-crop recovery fixture reviews both detections, adds only the confirmed crop, preserves the unresolved crop, and reports the result. Worker/unit coverage verifies bounded multi-crop detection and isolated retry. | Pass |
| 7 | Identify an unpriced item | Home, Collection, and protection fixtures label the item `Unpriced`, disclose coverage, and show a resolution path without `$0.00`. | Pass |
| 8 | Add a manual value | The purchase editor exposes Manual current value, persists its currency separately, and Collection/Scenario Lab retain manual semantics. | Pass |
| 9 | Find a watched item | The Watchlist route restores the exact saved variant; browser coverage edits its target and confirms removal. | Pass |
| 10 | Distinguish scenario from forecast | Browser coverage opens Scenario Lab, verifies the assumption disclosure, and keeps Published Forecasts gated and visually separate. | Pass |
| 11 | Group matching items | Collection tests combine quantities and values while retaining two individual purchases and the `View purchases` action. | Pass |
| 12 | Return without losing catalog position | Browser history test restores the canonical route, filters, Quick Inspector origin focus, and saved scroll position. | Pass |

These automated simulations achieved 12/12 completion. A moderated external collector study remains an operational validation activity, not a claim made by this repository receipt.

## Required data states

| State | Evidence |
|---|---|
| No collection | Home and Collection first-use empty states, visual baseline, primary-route axe scan |
| One item | Home single-point history and chart-gating unit tests |
| Large collection | 1,000-purchase and 1,000-set bounded Collection tests; 5,000-result Discover test |
| All priced / some unpriced | Pricing coverage and Collection summary tests |
| No / partial chart history | Home, Collection, and item-detail chart gates; browser history reconstruction tests |
| Stale prices | Provider-specific freshness and collection freshness tests |
| Failed price provider | Recoverable catalog/search failures and preserved local-data browser tests |
| Manual values only / mixed values | Home, Collection, local-scenario, and Scenario Lab fixtures |
| No cost basis | Collection displays `Not recorded` and withholds estimated gain |
| Duplicate purchases | Grouping unit coverage and browser bulk-duplicate flow |
| Unconfirmed identity | Quick Inspector and scan review require explicit confirmation |
| Failed image | Browser Retry image recovery test |
| Long title | Detail retains the complete title and responsive CSS wraps it |
| Missing language or condition | Detail says `Not specified` and `Unconfirmed`; it does not invent display metadata |

## Device and input matrix

| Class | Size | Navigation expectation | Result |
|---|---:|---|---|
| Narrow mobile | 320 × 720 | Five-item bottom navigation | Pass |
| iPhone class | 390 × 844 | Five-item bottom navigation | Pass |
| Large Android | 412 × 915 | Five-item bottom navigation | Pass |
| Mobile landscape | 740 × 412 | Compact bottom navigation | Pass |
| Small tablet | 768 × 1024 | Compact rail | Pass |
| Large tablet | 1024 × 900 | Persistent adaptive sidebar | Pass |
| Laptop | 1366 × 768 | Desktop sidebar and expanded grids | Pass |
| Large desktop | 1920 × 1080 | Bounded 1440-pixel workspace | Pass |

Touch, mouse, and keyboard interactions pass. Every sampled primary control and navigation target is at least 44 × 44 CSS pixels.

## Performance and accessibility budgets

| Gate | Target | Observed | Result |
|---|---:|---:|---|
| Largest Contentful Paint, repeatable lab fixture | < 2,500 ms | 808 ms | Pass |
| Interaction latency / INP proxy | < 200 ms | 120 ms | Pass |
| Cumulative Layout Shift | < 0.1 | 0 | Pass |
| Lighthouse accessibility | ≥ 95 | 100 desktop / 100 mobile | Pass |
| Serious or critical WCAG 2.2 A/AA findings | 0 | 0 across five destinations | Pass |
| Horizontal overflow / clipped controls | 0 | 0 across eight viewports | Pass |
| Unknown values rendered as zero | 0 | 0 in focused and full correctness suites | Pass |
| Misleading no-data charts | 0 | 0; insufficient data renders a next-step state | Pass |

The interaction measurement uses the browser Event Timing API. Because no production population exists in this repository, 75th-percentile field confirmation remains a post-deploy monitoring gate.

## KPI dispositions requiring field data

The following PRD targets cannot be truthfully calculated from an offline repository because they require a participant cohort, a prior production baseline, or sustained sessions:

- Search-to-exact-item and scan-to-confirmed-add human completion percentages.
- Median human search-to-add time and median primary-interaction count.
- Discover abandonment reduction from baseline.
- Unpriced-item review improvement from baseline.
- Production 75th-percentile LCP/INP/CLS.
- Crash-free sessions.

Release disposition: the deterministic task workflows are implemented and the canonical
PRD defines a privacy-scoped event taxonomy, but general product telemetry is not enabled.
The existing private demand-event queue is separately governed price-intelligence
research infrastructure and must not be repurposed for UX measurement. No
baseline-dependent percentage is fabricated. These KPIs remain unavailable until a
separately reviewed, explicitly consented instrumentation change and preregistered sample
meet the requirements in
[`PREMIUM_UX_HUMAN_VALIDATION.md`](PREMIUM_UX_HUMAN_VALIDATION.md). The
identity-confirmation step is retained even if it adds an interaction because removing it
would violate the P0 rule against silently confirming unresolved matches.

## Reproduction commands

```sh
npm run check
npm run test:browser
npx playwright test tests/e2e/premium-ux-acceptance.spec.js
```

The full commands above are the release gate. The focused premium suite is also useful when iterating on CSS, navigation, accessibility, or media recovery.
