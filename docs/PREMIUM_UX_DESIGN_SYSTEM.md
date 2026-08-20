# CollectFolio Premium UX Design System

This document is the release contract for the premium gallery and collection-intelligence interface. The implemented source of truth is `app/assets/css/app.css`; shared rendering primitives live in `app/assets/js/core/components.js` and `app/assets/js/core/ui.js`.

## Product structure

The five primary destinations have distinct jobs:

| Destination | Primary job | Dominant action |
|---|---|---|
| Home | Understand collection value, coverage, freshness, and attention needs | Resolve the highest-priority gap |
| Discover | Browse or search for an exact item | Inspect an exact result |
| Scan | Capture, crop, match, and confirm one or many items | Confirm reviewed matches |
| Collection | Manage saved items, purchases, sets, and Watchlist | Find or manage inventory |
| Insights | Review evidence, alerts, scenarios, and approved track records | Investigate a collection signal |

User-facing terminology follows one vocabulary: Collection, item, quantity, purchase or lot, set or series, variant or printing, market value, manual value, scenario, forecast, unpriced, and pricing coverage. Internal storage, provider, mapping, and model identifiers stay out of primary flows and may appear only in a collapsed methodology disclosure when useful.

## Color tokens

Colors are semantic, not decorative status aliases. Both dark and light themes define the same roles.

| Role | Dark token | Use |
|---|---|---|
| Canvas | `--color-canvas: #080b10` | Application background |
| Workspace | `--color-workspace: #0d1218` | Shell and content workspace |
| Surface | `--color-surface: #121921` | Ordinary cards and groups |
| Interactive/elevated | `--color-interactive`, `--color-surface-elevated` | Controls, sheets, dialogs |
| Primary text | `--color-text-primary: #f5f7f2` | Headings and essential values |
| Secondary/muted text | `--color-text-secondary`, `--color-text-muted` | Supporting copy and metadata |
| Brand/primary action | `--color-action: #b8f36b` | Brand marks and the dominant action only |
| Positive | `--color-positive: #63ddb2` | Verified positive change |
| Warning | `--color-warning: #ffca6d` | Attention and recoverable risk |
| Negative/error | `--color-negative`, `--color-error` | Loss and errors, with text/icons |
| Market/forecast | `--color-forecast: #8bbcff` | Externally supported evidence and forecasts |
| Modeled | `--color-modeled: #a78bfa` | User scenarios and modeled ranges |
| Focus | `--color-focus: #d6ff9e` | Three-pixel keyboard focus ring |

Lime is reserved for the brand and primary interaction. Status always has a textual or icon cue, so color is never the only distinction. Functional text does not use chromatic shadows.

## Type, numbers, and spacing

- Inter Variable is the preferred family, with native system fallbacks.
- Primary reading text is 16/24 pixels or larger. Metadata is normally 12–14 pixels and uses the secondary or muted contrast-approved token.
- Page titles use a responsive 32–44 pixel scale; section titles use 22–32 pixels.
- Currency, percentages, quantities, dates in tables, and chart labels use tabular numerals.
- The spacing scale is 4, 8, 12, 16, 20, 24, 32, 40, 48, and 64 pixels (`--space-1` through `--space-16`).
- Controls use a 12-pixel radius, ordinary panels 20 pixels, and dialogs/sheets 24 pixels.
- Every primary pointer target is at least 44 × 44 CSS pixels.

## Surfaces and components

Canvas, workspace, ordinary surface, and elevated interaction form the depth hierarchy. Borders communicate grouping or interaction; whitespace and surface changes handle ordinary layout. Avoid more than two nested bordered surfaces.

Shared component rules:

- Page header: eyebrow, one page title, and a plain-language purpose statement. It does not repeat a dashboard summary.
- Primary button: one visually dominant action per task region. Secondary, ghost, and danger treatments express decreasing or destructive priority.
- Metric: label, truthful value or explicit `Unpriced`/`Unavailable`, then a short evidence note. Unknown values never become zero.
- Item card: real responsive art or an intentional category fallback, exact identity, value status, and a context-appropriate action.
- Quick Inspector: modal sheet with medium and expanded mobile detents, context-preserving backdrop, focus trap, focus restoration, and navigation recession.
- Empty state: what is missing, why it matters, and one relevant next action. Empty charts are not cards with flat lines.
- Error state: identifies the failed operation and exposes Retry or another recovery action without erasing completed work.
- Freshness: readable relative language in the primary flow; exact timestamps may appear in supporting detail.
- Methodology: collapsed by default and reserved for sources, identifiers, assumptions, and calculation details.
- Chart: renders only with enough valid observations. It includes an accessible prose summary, distinct current/median/50%/80% semantics, and meaningful auto-scaling.

## Product imagery

Image containers reserve their dimensions before loading and request an appropriate responsive source:

| Collectible | Aspect ratio |
|---|---|
| Trading card | 5:7 |
| Comic or slab | 2:3 |
| Sealed product | 1:1 |

Below-the-fold images are lazy-loaded. Failed remote images become an intentional placeholder with a Retry image action; a repeated failure remains a designed fallback rather than a broken-image icon. Direct image zoom is available from item detail.

## Responsive shell

- 0–767 pixels: sixteen-pixel gutters, bottom navigation, one or two readable columns, and full-width sheets. Below 360 pixels, metrics collapse further. Landscape phones use a shorter navigation treatment.
- 768–919 pixels: compact navigation rail and expanded content grids.
- 920–1199 pixels: persistent sidebar with adaptable workspace grids; the layout already has room for desktop interaction while retaining tablet-safe density.
- 1200 pixels and above: desktop spacing, split item detail where useful, and efficient use of width up to the 1440-pixel content measure.

Bottom and sticky actions include safe-area insets and sit above global navigation. Content padding reserves navigation height. No primary flow relies on a nested scrolling result region.

## Interaction and accessibility

- All workflows support keyboard operation, visible `:focus-visible` rings, logical focus order, and Escape dismissal where applicable.
- Modal sheets trap focus while open and restore it to the originating control on close.
- Navigation selection combines shape, label, and color.
- Icons receive accessible names; decorative artwork and glyphs are hidden from assistive technology.
- Errors are announced and include recovery instructions. Toasts provide non-destructive confirmation feedback.
- `prefers-reduced-motion`, `prefers-contrast: more`, and `prefers-reduced-transparency: reduce` are implemented.
- Browser zoom at 200% must preserve the five primary workflows without clipped controls or obscured focus.

## Data-trust rules

- Collection totals include only accepted market values and explicit manual values in the selected currency; exclusions and coverage are disclosed.
- Estimated gain appears only when both cost and current value exist.
- A manual value is not a market observation. A scenario is not a forecast. Forecasts remain gated until evidence and publication requirements pass.
- Neutral scenarios say `Unchanged scenario` and do not imply a positive return.
- Price history needs at least two valid observations. Forecast horizons render only when the approved payload contains that horizon.
- Set completion is unavailable until an authoritative catalog total is linked.

## Review contract

Any new UI must reuse these tokens and behaviors, pass the automated WCAG 2.2 A/AA scan with no serious or critical findings, remain operable at the supported viewport matrix and 200% zoom, and preserve the data-trust rules above. Release evidence is recorded in `docs/PREMIUM_UX_ACCEPTANCE.md`.
