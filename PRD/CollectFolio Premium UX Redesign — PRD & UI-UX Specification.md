# CollectFolio Premium UX Redesign

**Document type:** Product Requirements Document and UI/UX Specification
**Status:** Build-ready
**Product:** CollectFolio
**Target:** Responsive web application / PWA
**Primary platforms:** Mobile, tablet, and desktop
**Design direction:** Premium collector gallery × trusted portfolio intelligence

---

## 1. Executive Summary

CollectFolio will be redesigned from a dense analytics-style dashboard into a premium, collector-first experience that makes it easy to:

1. Identify and add collectibles.
2. Browse large catalogs without becoming overwhelmed.
3. Understand collection value and data quality.
4. Review items that need attention.
5. Explore scenarios without confusing them with verified market forecasts.

The redesign must preserve CollectFolio’s existing dark visual identity, local-first privacy model, catalog depth, portfolio tracking, scanning, and scenario capabilities while substantially improving clarity, trust, usability, visual hierarchy, responsiveness, accessibility, and product delight.

### Product promise

> Know what you own, what it is worth, and what needs attention—without fighting the interface.

### North-star experience

CollectFolio should feel like a curated digital collection gallery combined with a trustworthy modern portfolio application—not an internal analytics dashboard.

---

# 2. Problem Statement

The current interface is functional but has several usability and presentation issues.

## 2.1 Data and trust issues

- Charts appear even when chart-history coverage is reported as 0%.
- Unknown values sometimes appear as `$0.00`.
- Empty 30-day, 1-month, and 3-month metrics are displayed as dashes.
- Scenario outputs are presented within a Forecasts section even though they are not evidence-backed forecasts.
- Time horizons are inconsistent, such as an 80-day control paired with a 90-day title.
- Technical language such as market-data builds, model identifiers, and source-check terminology appears in the primary interface.
- Flat scenario charts can imply a prediction even when no directional assumption exists.

## 2.2 Navigation and layout issues

- Fixed bottom navigation can overlap content and primary actions.
- The center Add control behaves visually like both a tab and a floating action button.
- The same mobile-oriented layout is used at large desktop widths.
- Home and Portfolio repeat much of the same summary information.
- Several pages contain large amounts of unused space.
- Grid cards become too narrow, causing truncation and reduced readability.

## 2.3 Discoverability issues

- Discover contains multiple search inputs and several competing entry points.
- A large internally scrolling category area creates nested scrolling.
- Games, products, accessories, stores, and collectible types are mixed in one taxonomy.
- Users must process too many filters before expressing what they are looking for.
- Deep set pages retain unnecessary Discover page content.
- Related product formats are shown as nearly identical separate cards.
- Price sorting remains available when products have no prices.

## 2.4 Visual hierarchy issues

- Nearly every section uses the same dark card, border, radius, and label treatment.
- Primary content, metadata, warnings, and actions receive similar emphasis.
- Lime is used for branding, positive movement, selection, buttons, navigation, and decorative borders.
- Small blue-gray text has insufficient visual prominence.
- Text shadows and chromatic offsets reduce sharpness.
- Placeholder-heavy content makes the catalog appear unfinished.

## 2.5 Collection workflow issues

- Product terminology does not adapt to collectible type.
- Sealed products can be described using raw-card terminology.
- Item identities can be added before uncertainty is resolved.
- The item detail page prioritizes metadata before price and action.
- Selection controls appear even when bulk-selection mode is inactive.
- Export Backup appears as an Add workflow option even though it does not add collectibles.

## 2.6 Insights issues

- Manual scenarios and forecasts are not sufficiently separated.
- The page presents repeated charts, legends, warnings, and methodology for every item.
- Confidence wording is technical and difficult to interpret.
- Users are not immediately shown what changed, what requires attention, or which items have meaningful evidence.

---

# 3. Product Goals

## 3.1 Primary goals

1. Make the app understandable within the first 30 seconds.
2. Give every screen one clearly dominant user task.
3. Make collection artwork the primary visual content.
4. Make pricing confidence and data limitations immediately understandable.
5. Reduce the time required to find and add an exact item.
6. Remove misleading or decorative data visualizations.
7. Create a coherent catalog hierarchy across games and collectible types.
8. Deliver a premium responsive experience across mobile, tablet, and desktop.
9. Meet WCAG 2.2 AA accessibility requirements.
10. Introduce restrained, meaningful motion and collector-specific delight.

## 3.2 Business and product outcomes

- Increase successful item additions.
- Reduce catalog-search abandonment.
- Increase use of Watch and Needs Attention workflows.
- Improve trust in portfolio totals.
- Increase repeat engagement with Collection and Insights.
- Establish a reusable design system for future collectible categories.
- Make CollectFolio visually differentiated from generic collection trackers.

## 3.3 Non-goals

This redesign does not include:

- Building a new market-price provider.
- Creating a social marketplace.
- Adding automated buying or selling.
- Creating an evidence-backed forecasting engine.
- Replacing the existing local-first privacy architecture.
- Adding decorative glass effects to every surface.
- Redesigning the catalog database itself unless required to correct taxonomy or product-family relationships.

---

# 4. Target Users and Jobs to Be Done

## 4.1 Casual collector

**Need:** Quickly add an item and see its approximate value.

> When I acquire a collectible, I want to identify and add it with minimal effort so my collection remains accurate.

## 4.2 Active collector

**Need:** Browse sets, variants, sealed products, and exact printings.

> When I browse a catalog, I want to narrow from category to exact item without sorting through unrelated results.

## 4.3 Portfolio-focused collector

**Need:** Understand total value, cost basis, concentration, and missing prices.

> When I review my collection, I want to know what it is worth, what changed, and which values are incomplete.

## 4.4 Power user

**Need:** Maintain lots, quantities, manual values, exports, custom items, and scenario assumptions.

> When catalog or market data is incomplete, I want clear tools to correct, estimate, and manage the item without compromising the portfolio’s integrity.

---

# 5. Product Principles

## 5.1 Collectibles first

Artwork, card images, product packaging, comics, slabs, and other collectible media should visually lead the experience.

## 5.2 Truth over decoration

The app must never display charts, percentages, or values that imply evidence that does not exist.

## 5.3 One screen, one dominant task

Each screen must have a clear primary purpose.

## 5.4 Progressive disclosure

Advanced methodology, data sources, confidence details, and technical information remain accessible without dominating normal workflows.

## 5.5 Action near context

Actions such as Add, Watch, Review Price, and Confirm Identity should appear next to the information that triggers them.

## 5.6 Consistency without monotony

Components should share a system while maintaining distinct hierarchy between content, navigation, alerts, actions, and analytics.

## 5.7 Responsive by design

Layouts must adapt structurally rather than simply stretching mobile screens across desktop widths.

## 5.8 Restrained delight

Motion and visual effects should reinforce ownership, collection, discovery, and completion—not distract from them.

---

# 6. Success Metrics

Baselines must be captured before release. The following are target outcomes.

| Metric | Target |
|---|---:|
| Search-to-exact-item task completion | At least 90% in usability testing |
| Scan-to-confirmed-add completion | At least 85% |
| Median search-to-add time | 60 seconds or less |
| Median known-item add flow | 3 primary interactions or fewer |
| Discover abandonment | Reduce by at least 25% from baseline |
| Unpriced-item review completion | Increase by at least 30% |
| Misleading no-data charts | 0 |
| Unknown values represented as zero | 0 |
| Content obscured by fixed navigation | 0 |
| WCAG 2.2 AA critical failures | 0 |
| Lighthouse accessibility score | 95 or greater |
| Largest Contentful Paint | Under 2.5 seconds at the 75th percentile |
| Interaction to Next Paint | Under 200 milliseconds at the 75th percentile |
| Cumulative Layout Shift | Under 0.1 |
| Crash-free sessions | At least 99.5% |

---

# 7. Information Architecture

## 7.1 Primary destinations

1. **Home**
2. **Discover**
3. **Scan**
4. **Collection**
5. **Insights**

“Portfolio” is renamed to **Collection** because the screen’s primary responsibility is inventory management.

“Add” is renamed to **Scan** because it communicates CollectFolio’s differentiated intake capability.

## 7.2 Supporting destinations

- Item detail
- Set detail
- Search results
- Match review
- Add/edit holding
- Alerts
- Scenario Lab
- Track Record
- Profile
- Settings
- Data & Backups
- Methodology
- Privacy

## 7.3 Recommended route structure

```text
/home
/discover
/discover/search
/games/:gameId
/sets/:setId
/items/:itemId
/scan
/scan/review
/collection
/collection/items
/collection/sets
/collection/watchlist
/insights
/insights/alerts
/insights/scenarios
/insights/track-record
/settings
/settings/data
```

---

# 8. Global Application Requirements

## 8.1 App shell

### Mobile

- Use a five-destination bottom navigation.
- Scan may be visually emphasized but remains a navigation destination.
- Do not display a separate floating Add button in addition to the Scan destination.
- Account for device safe-area insets.
- Add sufficient page padding so no content is obscured.

### Tablet

- Use a compact navigation rail where space permits.
- Allow grid layouts to expand to three or four columns.
- Allow quick-view panels to appear as side sheets in landscape orientation.

### Desktop

- Use a persistent left sidebar.
- Use a maximum content width between 1,360 and 1,440 pixels.
- Use split-panel layouts for browsing and item details where appropriate.
- Do not scale mobile typography or spacing proportionally to fill desktop space.

## 8.2 Header

The global header must contain:

- CollectFolio mark or compact wordmark.
- Active portfolio selector.
- Global search control.
- Profile/avatar control.
- Optional sync or data-status indicator when relevant.

Replace the persistent “Local portfolio” label with a user-defined portfolio name such as:

> Personal Collection

Local-only or privacy status should appear within settings or a contextual status indicator.

## 8.3 Navigation state

- Active destination must be identifiable by color, icon, label, and shape.
- Navigation state must not rely on color alone.
- Navigation must remain keyboard-accessible.
- Modal sheets must visually recess or hide the bottom navigation.
- Opening and closing a detail page must preserve the previous result position and filter state.

## 8.4 Safe areas and sticky elements

- Sticky action bars must sit above bottom navigation.
- Content padding must equal navigation height, safe-area inset, and at least 16 additional pixels.
- Focused controls must never be hidden behind sticky UI.
- Mobile browser toolbars must not cause action controls to disappear.

## 8.5 Global feedback

Use consistent feedback patterns:

- Skeleton state for loading.
- Empty state for valid absence of content.
- Inline recovery state for recoverable errors.
- Toast for confirmation.
- Undo for reversible destructive or organizational actions.
- Modal confirmation only for irreversible actions.

---

# 9. Data Integrity and Presentation Rules

These rules apply across every screen.

## 9.1 Unknown values

Unknown values must display as:

- `Unpriced`
- `No verified market price`
- `Value not available`

Unknown values must never display as:

- `$0.00`
- `0%`
- A flat chart line
- A populated gain/loss calculation

## 9.2 Portfolio totals

- Portfolio total includes only holdings with accepted values.
- The interface must clearly disclose the number of unpriced holdings.
- Example:

> $1,332 estimated value
> 4 of 5 holdings priced

- Unpriced items must not silently reduce or distort the total.

## 9.3 Pricing coverage

```text
Pricing coverage =
priced unique holdings ÷ total unique holdings
```

Display both the percentage and count:

> 80% coverage · 4 of 5 holdings priced

## 9.4 Cost basis and gain

Estimated gain may be calculated only when both an accepted value and cost basis exist.

```text
Estimated gain = accepted current value − cost basis
Gain percentage = estimated gain ÷ cost basis
```

If either input is missing, display:

> Gain unavailable

## 9.5 Chart eligibility

A historical chart may render only when:

- At least two valid observations exist.
- The observations have different timestamps.
- The selected period contains meaningful elapsed time.
- The values are not placeholder or synthetic display values.

Otherwise render a purposeful empty state.

Example:

> **Portfolio history starts here**
> We will chart changes as verified prices are added.

## 9.6 Data freshness

Data freshness thresholds must be configurable by provider.

Recommended user-facing states:

- **Updated today**
- **Updated recently**
- **Price may be stale**
- **Update time unavailable**

Avoid exposing ingestion jobs, build identifiers, or database timestamps in the normal interface.

## 9.7 Manual values

Manual values must be visually and semantically separate from market values.

Use:

- `Manual value`
- `Your estimate`
- `Saved scenario value`

Do not describe a manual value as:

- Market price
- Market observation
- Appraisal
- Published forecast

## 9.8 Scenario versus forecast

### Scenario

A scenario is based on user assumptions, broad priors, or local modeling.

Label it:

> Scenario

### Forecast

A forecast may be labeled as such only when it meets defined evidence requirements, including:

- Published methodology.
- Sufficient historical data.
- Documented model version.
- Reproducible calculation.
- Trackable historical prediction.
- Evaluation against later outcomes.

Until those conditions exist, the interface must use **Scenario Lab**, not Forecasts.

## 9.9 Horizon consistency

Every control, title, chart endpoint, and calculation must use the same selected horizon.

Approved horizons:

- 7 days
- 30 days
- 90 days
- 6 months
- 1 year

Do not pair an 80-day control with a 90-day title.

---

# 10. Visual Design System Specification

## 10.1 Design direction

The visual system should combine:

- Premium digital gallery presentation.
- Modern financial clarity.
- Restrained futuristic controls.
- High-quality collectible imagery.
- Trustworthy data presentation.

The application should not resemble a generic admin dashboard.

## 10.2 Color tokens

Suggested starting tokens:

```css
--color-canvas: #070B0F;
--color-surface-1: #0F171E;
--color-surface-2: #16212B;
--color-surface-elevated: #1A2732;

--color-text-primary: #F7FAFC;
--color-text-secondary: #A5B5C3;
--color-text-tertiary: #778A99;

--color-border-subtle: rgba(155, 185, 209, 0.16);
--color-border-active: rgba(183, 255, 90, 0.72);

--color-brand: #B7FF5A;
--color-positive: #63E6BE;
--color-warning: #FFC857;
--color-negative: #FF7474;
--color-info: #70B7FF;
--color-modeled: #A78BFA;
```

Final values may be adjusted, but all combinations must pass required contrast checks.

## 10.3 Accent-color rules

Brand lime is reserved for:

- Primary action.
- Active navigation.
- Brand highlight.
- Direct manipulation.
- Important completion moments.

Do not use brand lime for every positive number, border, badge, label, and chart line.

Semantic colors:

- Mint: positive value movement.
- Amber: incomplete or attention-required state.
- Coral: destructive or error state.
- Blue: verified market data.
- Violet: modeled or scenario data.
- Neutral gray-blue: secondary and inactive states.

## 10.4 Typography

Use two coordinated type families:

- **UI family:** neutral variable sans-serif.
- **Display family:** expressive but highly legible variable sans-serif.

Recommended hierarchy:

| Token | Mobile | Desktop | Usage |
|---|---:|---:|---|
| Display XL | 40/44 | 52/56 | Portfolio value |
| H1 | 32/38 | 38/44 | Page title |
| H2 | 25/31 | 29/35 | Major section |
| H3 | 20/26 | 22/28 | Card group |
| Body | 16/24 | 16/24 | Primary copy |
| Small | 14/20 | 14/20 | Secondary copy |
| Caption | 12/16 | 12/16 | Supporting metadata |
| Eyebrow | 11/14 | 12/16 | Short category labels |

Requirements:

- Remove chromatic text shadows from functional text.
- Use tabular numerals for values, percentages, quantities, and chart labels.
- Do not use uppercase for long explanations.
- Prevent item titles from shrinking below readable sizes.
- Support text zoom up to 200%.

## 10.5 Spacing

Use a four-pixel base with an eight-pixel primary rhythm.

```text
4, 8, 12, 16, 20, 24, 32, 40, 48, 64
```

Recommended application:

- Mobile page padding: 16 pixels.
- Tablet page padding: 24 pixels.
- Desktop page padding: 32 pixels.
- Section separation: 32–48 pixels.
- Card padding: 16–20 pixels.
- Compact control gap: 8 pixels.
- Related content gap: 12–16 pixels.

## 10.6 Surfaces

Use three primary elevation levels.

### Canvas

- Main application background.
- No visible border.

### Content surface

- Slight tonal lift.
- Normally borderless.
- Used for ordinary cards and groups.

### Elevated interaction surface

- Bottom sheet.
- Selected item.
- Sticky action bar.
- Important alert.
- May use subtle border and shadow.

Avoid more than two nested bordered surfaces.

## 10.7 Borders

Borders should indicate:

- Selection.
- Focus.
- Warning.
- Active filter.
- Interactive grouping where spacing is insufficient.

Do not border every layout region by default.

## 10.8 Radius

- Small control: 10–12 pixels.
- Card: 16 pixels.
- Hero card: 20–24 pixels.
- Bottom sheet: 24–28 pixels at the top.
- Pills: fully rounded.

## 10.9 Buttons

### Primary button

- Height: 48–52 pixels.
- Filled brand accent.
- High-contrast label.
- One primary action per region.

### Secondary button

- Height: 44–48 pixels.
- Elevated or outlined surface.
- Must remain visually subordinate.

### Icon button

- Minimum hit area: 44 × 44 pixels.
- Visible hover, focus, pressed, and disabled states.

## 10.10 Product imagery

The image container must adapt to content type:

- Trading card: card aspect ratio.
- Graded slab: slab aspect ratio.
- Comic: comic-book aspect ratio.
- Sealed product: contained product image without forced cropping.
- Booster pack: narrow package ratio.
- Booster box: product-box ratio.

Generic `CF` placeholders should be replaced with:

- Game or category mark.
- Product silhouette.
- Image skeleton while loading.
- Retry state if loading fails.

---

# 11. Screen Specifications

# 11.1 Home

## Purpose

Give the user an immediate, trustworthy overview of collection health and recent activity.

## Required structure

1. Portfolio-value hero.
2. Needs Attention.
3. Key metrics.
4. Recent holdings.
5. Collection mix.
6. Collapsed Data Health section.

## Requirements

### HOME-001 — Portfolio hero

Display:

- Estimated portfolio value.
- Number of priced holdings.
- Cost basis when available.
- Estimated gain when valid.
- Human-readable update time.

Example:

> **$1,332**
> Estimated portfolio value
> +$472 estimated gain · 4 of 5 holdings priced
> Prices updated 14 minutes ago

Do not show market-data build terminology.

### HOME-002 — Conditional chart

- Show the value chart only when chart-eligibility requirements are met.
- Use market value as the primary line.
- Cost basis may be enabled as a comparison.
- Directly label the latest values.
- Support pointer or touch scrubbing.
- Fit the y-axis to the meaningful range.

When data is insufficient, show the chart empty state instead of axes and flat lines.

### HOME-003 — Needs Attention

Display a full-width actionable module.

Possible issues:

- Unpriced item.
- Stale price.
- Unconfirmed identity.
- Missing cost basis.
- Failed image.
- Duplicate candidate.

Each issue must contain:

- Plain-language title.
- Why it matters.
- One primary action.
- Optional dismiss or snooze when appropriate.

### HOME-004 — Metrics

Use a two-by-two mobile layout or horizontally scrollable metric strip.

Recommended metrics:

- Cost basis.
- Estimated gain.
- Pricing coverage.
- Value concentration.

Avoid a fifth orphan card on a separate row.

### HOME-005 — Collection mix

Use a 100% stacked bar with a ranked list rather than relying solely on a donut chart.

Display:

- Category name.
- Percentage.
- Value.
- Optional item count.

### HOME-006 — Recent holdings

- Show high-quality images.
- Make each row fully interactive.
- Display title, set, value status, and quantity.
- Do not rely on small arrow targets.

### HOME-007 — Data Health

Move technical information into a collapsed section containing:

- Price-source coverage.
- History coverage.
- Stale-value count.
- Manual-value count.
- Last successful data refresh.

---

# 11.2 Discover

## Purpose

Help users move from an idea, game, set, code, player, or image to an exact collectible.

## Required structure

1. Universal search.
2. Continue browsing.
3. Favorite categories or games.
4. Recently viewed.
5. Popular or new releases.
6. Results and filters after intent is expressed.

## Requirements

### DISC-001 — Universal search

Use one primary search field.

Placeholder:

> Search cards, sets, players, products, or set codes

Search should support:

- Item names.
- Set names.
- Set codes.
- Card numbers.
- Players.
- Characters.
- Product formats.
- Common spelling errors.
- Recent searches.
- Image search entry.

### DISC-002 — Browse navigation

Show a limited number of visually recognizable game or category tiles.

Include:

- Favorites.
- Recently viewed.
- Popular categories.
- View All.

“View All” opens a dedicated picker rather than an internally scrolling panel.

### DISC-003 — Taxonomy

Use the following hierarchy:

1. Collectible type.
2. Game, brand, sport, or franchise.
3. Set, release, series, or season.
4. Item.
5. Variant or exact printing.

Do not mix games with supplies, stores, or product types in the same filter dimension.

### DISC-004 — Filter system

Use a sticky filter toolbar with:

- Filters count.
- Sort control.
- Grid/list toggle.

Applied filters appear as removable chips.

Example:

```text
Cardfight Vanguard ×
2026 ×
Sealed ×
Clear all
```

Filters open in a bottom sheet on mobile and side panel on desktop.

### DISC-005 — No nested scrolling

- The page must have one primary scrolling container.
- Category pickers may use dedicated full-screen overlays or sheets.
- Do not place a scrollable category region inside the scrolling page.

### DISC-006 — Result grids

Use responsive minimum-width cards.

Recommended:

```css
grid-template-columns:
  repeat(auto-fill, minmax(170px, 1fr));
```

- Two columns on ordinary phones when content remains readable.
- One column or list layout for long sealed-product names on narrow devices.
- Three columns on tablet.
- Four or more columns on desktop.

### DISC-007 — Sorting

Only show sort methods supported by the current result data.

Examples:

- If no result has a price, disable or hide Price sorting.
- If release date is unknown, do not expose release-date sorting.
- Explain disabled sorting when needed.

### DISC-008 — Result-card content

Each set card must show:

- Image or symbol.
- Game or category.
- Set name.
- Release year.
- Item count.
- Optional ownership or completion status.

The entire card must be tappable.

### DISC-009 — Deep-page header

Once a user opens a set:

- Remove the full Discover introduction.
- Show compact back navigation.
- Show set image or emblem.
- Show set name, year, and item count.
- Preserve active filter and search context.

### DISC-010 — Product families

Group related formats under one product family when appropriate.

Example:

> Strike of Illusionary Shadows

Formats:

- Booster Pack.
- Booster Box.
- 16-Box Case.

Users may choose a format inside the family rather than interpreting several nearly identical cards.

### DISC-011 — Product-card content

Each product card must contain:

1. Product image.
2. Product-format badge.
3. Distinct title.
4. Current value or No Verified Price.
5. Price source and update time when available.
6. Watch action.
7. Add action.

Remove empty 30-day, 1-month, and 3-month boxes.

---

# 11.3 Quick View

## Purpose

Allow users to inspect and act on an item without losing their catalog position.

## Requirements

### QUICK-001 — Presentation

- Use a bottom sheet on mobile.
- Use a side sheet or centered panel on larger screens.
- Support medium and expanded detents.
- Use moderate background dimming or blur.
- Recess the global navigation while the sheet is open.

### QUICK-002 — Content

Display:

- Product image.
- Exact item title.
- Product format.
- Set or series.
- Current value when available.
- Identity confidence.
- Primary and secondary actions.

Do not display internal database identifiers.

### QUICK-003 — Identity confidence

Approved states:

- Exact match.
- Likely match.
- Confirm variant.
- Identity unresolved.

If identity is uncertain, the primary action must be:

> Confirm exact item

The user must not be able to silently add an unresolved identity as though it were confirmed.

### QUICK-004 — Conditional metrics

Do not render price, movement, or forecast cards when unavailable.

Use a compact state such as:

> No verified market price yet

### QUICK-005 — Actions

After identity is confirmed:

- Primary: Add to collection.
- Secondary: Watch.
- Tertiary: Open full details.

Opening and closing the sheet must preserve the result-grid position.

---

# 11.4 Item Detail

## Purpose

Help users understand the exact collectible and take ownership-related actions.

## Required hierarchy

1. Product media.
2. Set or collection context.
3. Exact item title.
4. Product type and variant.
5. Price and movement.
6. Add and Watch actions.
7. Market history.
8. Ownership details.
9. Technical details and methodology.

## Requirements

### DETAIL-001 — Hero media

- Use a correctly proportioned product image.
- Allow tap or click to enter image zoom.
- Support pinch zoom on touch devices.
- Remove the separate small Zoom Image control.
- Optionally use a restrained image-derived ambient background.

### DETAIL-002 — Title hierarchy

- Reduce title size on mobile.
- Limit the title width for readability.
- Avoid allowing long product names to dominate the entire first viewport.

### DETAIL-003 — Pricing priority

Place current value and movement near the title and before secondary metadata.

Display:

- Current market value.
- Manual value when used.
- Movement.
- Price source.
- Update time.
- Pricing-confidence state.

### DETAIL-004 — Type-aware metadata

Metadata must change according to collectible type.

For a sealed booster pack:

- Type: Sealed product.
- Format: Booster pack.
- Condition: Factory sealed or Unconfirmed.
- Language: English.
- Edition: Standard.
- Set: DZ-BT15.

Do not label a sealed product as Raw.

### DETAIL-005 — Ownership action

Use a sticky action area above global navigation.

Display:

- Current value or Unpriced.
- Watch.
- Add to collection.

If already owned:

- Update quantity.
- Edit purchase.
- View lots.

### DETAIL-006 — Market sections

Only display market-history components when valid data exists.

When unavailable:

> Price history will appear after additional verified updates.

### DETAIL-007 — Methodology

Move the following into an expandable Data & Methodology section:

- Provider identifiers.
- Model version.
- Source checks.
- Data quality.
- Internal catalog identifiers.
- Calculation methodology.

Internal IDs must never appear in the default detail view.

---

# 11.5 Scan and Add Collectibles

## Purpose

Allow users to add one or several collectibles quickly and confidently.

## Required flow

1. Capture or upload.
2. Detect items.
3. Review crops.
4. Review matches.
5. Confirm exact identities.
6. Enter ownership details.
7. Add to collection.

## Requirements

### SCAN-001 — Primary entry actions

Replace the combined button with:

- Open camera.
- Upload photo.

On desktop also support:

- Drag and drop.
- Paste image.
- File browser.

### SCAN-002 — Workflow preview

Display a compact three-step explanation:

1. Scan or upload.
2. Review detected items.
3. Confirm and add.

### SCAN-003 — Multi-item detection

The system must:

- Detect one or multiple items.
- Draw editable boundaries.
- Display detected-item count.
- Allow crop movement, resizing, deletion, and retry.
- Preserve the original source locally during review.

### SCAN-004 — Match review

Each detected item must display:

- Proposed match.
- Match confidence.
- Alternative matches.
- Confirm action.
- Search manually action.
- Create custom item action.

### SCAN-005 — Confidence gating

- High-confidence exact matches may be preselected.
- Medium-confidence matches require review.
- Low-confidence matches require explicit confirmation.
- Unresolved items may not be presented as confirmed catalog items.

### SCAN-006 — Ownership details

After identity confirmation, allow:

- Quantity.
- Purchase price.
- Purchase date.
- Condition.
- Language.
- Grading company and grade.
- Notes.
- Storage location.
- Optional photo retention.

### SCAN-007 — Privacy

Clearly state:

- Whether the full source photo remains on-device.
- What cropped data may be processed.
- When data leaves the device.
- Whether users can delete retained images.

Do not collect or transmit raw source images without disclosure and consent.

### SCAN-008 — Alternate intake methods

Retain:

- Search catalog.
- Import collection.
- Create custom item.

Move Export Backup to:

> Settings → Data & Backups

### SCAN-009 — Error recovery

Provide recovery for:

- Camera permission denied.
- Unsupported image.
- No items detected.
- Too many items detected.
- Poor lighting.
- Network unavailable.
- Catalog match unavailable.

No error should force the user to restart the full flow unless required.

---

# 11.6 Collection

## Purpose

Manage owned collectibles, quantities, lots, watchlist items, and collection organization.

## Required structure

1. Compact collection summary.
2. Items, Sets, and Watchlist tabs.
3. Search/filter/sort toolbar.
4. Collection grid or list.
5. Bulk actions when activated.

## Requirements

### COLLECTION-001 — Compact summary

Display:

- Estimated total value.
- Holding count.
- Pricing coverage.
- Estimated gain when valid.
- Small sparkline only when history exists.

Do not repeat the full Home dashboard.

### COLLECTION-002 — Primary views

Use:

- Items.
- Sets.
- Watchlist.

### COLLECTION-003 — Search and filtering

Use one sticky toolbar:

- Search.
- Filters.
- Sort.
- Grid/list toggle.
- Overflow menu.

Move Export CSV into the overflow menu.

### COLLECTION-004 — Collection cards

Each card must show:

- Artwork.
- Item title.
- Set or series.
- Quantity.
- Current value or Unpriced.
- Gain/loss when valid.
- Pricing-source badge.
- Attention state when applicable.

### COLLECTION-005 — Bulk selection

- Do not display checkboxes by default.
- Enter selection mode through Select or long-press.
- Show bulk actions only while selection mode is active.

Possible bulk actions:

- Add tag.
- Change location.
- Export selected.
- Update condition.
- Delete.
- Add to list.

### COLLECTION-006 — Purchases and lots

Replace technical wording such as “Exact lots remain separate” with:

> Showing individual purchases

Provide a control:

> Group matching items

Users must be able to switch between:

- Aggregated item view.
- Individual purchase-lot view.

### COLLECTION-007 — Empty collection

Display a visually inviting empty state with:

- Scan items.
- Search catalog.
- Import collection.
- Create custom item.

---

# 11.7 Insights

## Purpose

Explain changes, identify risks or missing information, and allow users to explore assumptions.

## Primary sections

1. Overview.
2. Alerts.
3. Scenario Lab.
4. Track Record.

A Published Forecasts section may be added only when evidence-backed forecasts exist.

## Requirements

### INSIGHTS-001 — Overview

Display concise, actionable insights:

- Largest value increase.
- Largest value decrease.
- Highest concentration.
- Missing prices.
- Stale prices.
- Watchlist alerts.
- Coverage improvements.
- Recently completed sets.

### INSIGHTS-002 — Alerts

Support:

- Price target reached.
- Price movement threshold.
- New catalog price.
- Price became stale.
- Item became unpriced.
- Set release or availability.
- Watchlist change.

### INSIGHTS-003 — Scenario Lab

Use the title:

> Scenario Lab

Description:

> Explore how your collection could change under different assumptions.

Allow users to adjust:

- Time horizon.
- Broad market direction.
- Category-level direction.
- Volatility.
- Individual item assumptions.
- Manual-value assumptions.

### INSIGHTS-004 — Scenario output

Display:

- Current saved value.
- Median scenario value.
- Middle 50% range.
- Broad 80% range.
- Difference from current value.
- Coverage count.
- Evidence level.

Use:

> Unchanged scenario

instead of `+0.0%` when assumptions are neutral.

### INSIGHTS-005 — Scenario chart

- Automatically scale the y-axis to the relevant range.
- Clearly label current value and scenario median.
- Display 50% and 80% ranges.
- Support pointer and touch scrubbing.
- Maintain consistent horizon labels.
- Do not use a flat line to imply a forecast.

### INSIGHTS-006 — Evidence language

Replace technical confidence labels with plain language.

Example:

> **Low evidence**
> Based on two observations from one source.

Approved levels:

- Limited evidence.
- Moderate evidence.
- Strong evidence.

Do not describe confidence as an accuracy percentage unless statistically validated.

### INSIGHTS-007 — Item outlooks

Use compact comparison rows rather than repeating a complete chart and disclaimer for every holding.

Each row should display:

- Item image.
- Item title.
- Current value.
- Scenario midpoint.
- Scenario range.
- Evidence level.
- Expand action.

Sort by:

- Largest upside.
- Largest downside.
- Widest uncertainty.
- Strongest evidence.
- Highest value.

Only one detailed item panel should be expanded at a time.

### INSIGHTS-008 — Disclosure

Use one page-level disclosure:

> Scenarios are assumption-based estimates and are not appraisals, market observations, investment recommendations, or guaranteed outcomes.

Do not repeat the full warning inside every item card.

### INSIGHTS-009 — Methodology

Place detailed methodology behind an expandable panel containing:

- Model name.
- Model version.
- Inputs.
- Assumptions.
- Observation count.
- Data-source coverage.
- Calculation timestamp.

---

# 12. Shared Component Specification

| Component | Required behavior |
|---|---|
| App Shell | Responsive bottom navigation, rail, or sidebar |
| Portfolio Selector | Switch portfolios without losing current destination |
| Universal Search | Suggestions, recents, keyboard navigation, clear action |
| Filter Sheet | Faceted filters, count preview, clear all, apply |
| Applied Filter Chip | Removable, keyboard-accessible, readable without color |
| Item Card | Type-aware ratio, full-card interaction, image states |
| Product Family Card | Groups related formats and variants |
| Metric Card | One primary value, one supporting description |
| Needs Attention Card | Issue, explanation, primary action |
| Data Empty State | Explains absence and provides a next action |
| Data Freshness Badge | Updated, recent, stale, or unknown |
| Confidence Badge | Plain-language evidence status |
| Chart | Conditional rendering, direct labels, accessible summary |
| Bottom Sheet | Multiple detents, safe-area support, focus trapping |
| Sticky Action Bar | Sits above navigation, preserves content visibility |
| Toast | Confirmation and optional Undo |
| Skeleton | Matches final layout and prevents shifting |
| Image Error State | Retry, alternate source, or custom image |
| Bulk Action Bar | Appears only during selection mode |
| Methodology Accordion | Technical detail hidden by default |

---

# 13. Chart Specification

## 13.1 General rules

- Every chart must communicate one primary idea.
- Charts must not be used merely to fill space.
- Chart colors must have semantic meaning.
- Charts must include an accessible text summary.
- Hover-only interaction is not sufficient.
- Legends should be replaced by direct labels when possible.

## 13.2 Portfolio chart

Primary series:

- Market value.

Optional comparison:

- Cost basis.

Display:

- Start value.
- End value.
- Absolute change.
- Percentage change.
- Selected period.
- Data coverage.

## 13.3 Scenario chart

Series:

- Current-value boundary.
- Scenario median.
- Middle 50% range.
- Broad 80% range.

The chart must visually distinguish:

- Verified present value.
- Modeled future scenario.
- Uncertainty.

## 13.4 Empty chart state

Do not show:

- Axes.
- Legends.
- Flat lines.
- Zero values.

Show:

- Explanation.
- Required next event.
- Relevant action.

---

# 14. Content and Terminology Specification

## 14.1 Standard terminology

| Concept | Approved term |
|---|---|
| Owned inventory | Collection |
| Unique catalog identity | Item |
| Number owned | Quantity |
| Separate acquisition | Purchase or Lot |
| Official release group | Set or Series |
| Exact version | Variant or Printing |
| Externally sourced price | Market value |
| User-entered amount | Manual value |
| Assumption-based range | Scenario |
| Validated predictive output | Forecast |
| Missing accepted price | Unpriced |
| Pricing completeness | Pricing coverage |

## 14.2 Required copy replacements

| Current wording | Replacement |
|---|---|
| Market data build completed successfully | Prices updated recently |
| Pricing unavailable | No verified market price |
| Not enough approved history | Price history will appear after more verified updates |
| Early confidence | Limited evidence |
| Exact lots remain separate | Showing individual purchases |
| Local scenario | Your scenario |
| Comparable unrealized gain or loss | Estimated gain |
| `$0.00` for unknown value | Unpriced |
| 4 modeled | 4 of 5 holdings modeled |
| Raw for sealed product | Sealed product |
| Review identity | Confirm exact item |

---

# 15. Responsive Layout Specification

## 15.1 Breakpoints

```text
Mobile: 0–767 px
Tablet: 768–1199 px
Desktop: 1200 px and above
```

## 15.2 Mobile

- Bottom navigation.
- Sixteen-pixel page gutters.
- One or two-column content grids.
- Full-width bottom sheets.
- Sticky action bar above navigation.
- Collapsed secondary information.

## 15.3 Tablet

- Navigation rail where appropriate.
- Twenty-four-pixel gutters.
- Two- to four-column grids.
- Side sheet for item quick view in landscape.
- Split summary and supporting content when space permits.

## 15.4 Desktop

- Persistent sidebar.
- Thirty-two-pixel gutters.
- Maximum content width of approximately 1,440 pixels.
- Four- to six-column catalog grids.
- Split browsing/detail layouts.
- Persistent contextual filters where useful.
- No large stretches of empty space caused by fixed narrow mobile containers.

## 15.5 Large titles and cards

Use responsive typography and container queries to prevent:

- Oversized titles.
- Extremely narrow grid cards.
- Excessive white or empty space.
- Controls stretching beyond comfortable reading widths.

---

# 16. Motion and Interaction Specification

## 16.1 Motion principles

Motion must explain:

- Where content came from.
- What changed.
- Whether an action succeeded.
- Which element is active.

## 16.2 Recommended transitions

- Shared image transition from result card to quick view and detail.
- Gentle value-number morph when switching periods.
- Bottom-sheet spring transition.
- Chart-line reveal after data loads.
- Press depth on interactive cards.
- Watch confirmation animation.
- Add-to-collection success confirmation.
- Set-completion celebration.

## 16.3 Timing

Suggested motion tokens:

```text
Fast feedback: 120–160 ms
Standard transition: 180–240 ms
Large spatial transition: 260–340 ms
```

## 16.4 Collector-specific effects

Optional effects:

- Subtle foil response to pointer or device tilt.
- Image-derived ambient light.
- Soft parallax on hero artwork.
- Small completion animation for a finished set.

Requirements:

- No continuous decorative animation.
- Effects must not reduce readability.
- Effects must not materially degrade performance.
- Respect reduced-motion and reduced-transparency preferences.

---

# 17. Accessibility Requirements

The application must meet WCAG 2.2 AA.

## Required behavior

- Minimum 44 × 44-pixel touch target for primary interactions.
- Minimum required contrast for text and controls.
- Strong visible focus indicator.
- Full keyboard navigation.
- Logical focus order.
- Screen-reader names for all controls.
- Alternative text for meaningful images.
- Decorative images hidden from assistive technology.
- No information communicated by color alone.
- Charts include text summaries.
- Modal sheets trap focus and restore focus when closed.
- Navigation never obscures focused content.
- Support reduced motion.
- Support increased contrast.
- Support text resizing to 200%.
- Support landscape mobile orientation.
- Error messages identify the field and recovery action.
- Status changes are announced when appropriate.

---

# 18. Performance Requirements

## 18.1 Media

- Serve responsive image sizes.
- Prefer AVIF or WebP with fallback.
- Lazy-load below-the-fold images.
- Reserve image dimensions to prevent layout shift.
- Use thumbnails in grids and higher-resolution media only in detail views.
- Retry failed images without reloading the page.

## 18.2 Catalog lists

- Virtualize or incrementally render large result sets.
- Avoid rendering thousands of cards at once.
- Preserve filters and scroll positions.
- Use pagination or infinite loading with clear progress and recovery.

## 18.3 Scan processing

- Run image preprocessing off the main UI thread where possible.
- Show progress by stage.
- Do not freeze the interface during multi-card detection.
- Allow cancellation.
- Preserve local work after recoverable failures.

## 18.4 Offline and local-first behavior

When supported by the current architecture:

- Collection inventory remains available offline.
- Previously stored values remain visible with freshness status.
- Offline changes queue safely.
- Source photos remain local unless upload is explicitly required and disclosed.

---

# 19. Analytics and Instrumentation

Analytics must not capture raw collection photos, sensitive notes, or personally identifying information unnecessarily.

Recommended events:

| Event | Purpose |
|---|---|
| `discover_search_submitted` | Measure search usage |
| `discover_result_opened` | Measure result relevance |
| `filter_applied` | Understand filter usage |
| `filter_cleared` | Detect filter friction |
| `quick_view_opened` | Measure contextual inspection |
| `identity_confirmation_started` | Measure uncertain-match volume |
| `identity_confirmed` | Measure confirmation completion |
| `scan_started` | Measure intake entry |
| `scan_detection_completed` | Measure technical success |
| `scan_review_completed` | Measure review completion |
| `item_added` | Measure core conversion |
| `item_watched` | Measure watch usage |
| `attention_item_opened` | Measure issue engagement |
| `attention_item_resolved` | Measure resolution |
| `scenario_created` | Measure scenario engagement |
| `collection_filter_applied` | Measure inventory organization |
| `image_load_failed` | Detect catalog-media problems |

---

# 20. Testing Requirements

## 20.1 Required usability tasks

Test users must be able to:

1. Find an exact known card or product.
2. Browse from game to set to exact item.
3. Distinguish a booster pack from a box and case.
4. Add a confirmed item.
5. Resolve an uncertain match.
6. Scan multiple items.
7. Identify an unpriced holding.
8. Add a manual value.
9. Find a watched item.
10. Understand the difference between a scenario and a forecast.
11. Group matching holdings.
12. Return from item detail without losing catalog position.

## 20.2 Required data-state tests

Test:

- No collection.
- One item.
- Large collection.
- All items priced.
- Some items unpriced.
- No chart history.
- Partial chart history.
- Stale prices.
- Failed price provider.
- Manual values only.
- Mixed market and manual values.
- No cost basis.
- Duplicate purchases.
- Unconfirmed identity.
- Failed image.
- Long title.
- Missing language or condition.

## 20.3 Required device testing

At minimum:

- Narrow mobile screen.
- Standard iPhone-class screen.
- Large Android-class screen.
- Mobile landscape.
- Small tablet.
- Large tablet.
- Laptop.
- Large desktop.
- Touch and mouse input.
- Keyboard-only operation.

---

# 21. Implementation Priorities

## Phase 1 — P0 Correctness and usability

1. Fix navigation overlap and safe-area behavior.
2. Remove charts without sufficient data.
3. Replace unknown zero values with Unpriced.
4. Correct horizon and timestamp inconsistencies.
5. Remove unavailable metric boxes.
6. Prevent unresolved identities from being added as confirmed.
7. Correct collectible-type terminology.
8. Remove nested scrolling from Discover.
9. Ensure controls meet minimum touch sizes.
10. Fix low-contrast and overly small text.

## Phase 2 — P1 Architecture and design system

1. Implement global design tokens.
2. Implement responsive navigation.
3. Redesign the application header.
4. Build the new item-card system.
5. Build shared data states and empty states.
6. Implement universal search and filter sheet.
7. Separate Collection from Home.
8. Separate Scenario Lab from Forecasts.

## Phase 3 — P1 Core screen redesign

1. Home.
2. Discover landing.
3. Set detail.
4. Quick view.
5. Item detail.
6. Scan and review.
7. Collection.
8. Insights.

## Phase 4 — P2 Premium polish

1. Shared-element transitions.
2. Image-derived ambient backgrounds.
3. Refined chart interactions.
4. Haptics.
5. Foil and collection-completion effects.
6. Light theme if included in roadmap.
7. Advanced desktop split views.

---

# 22. Completion Criteria Checklist

## 22.1 Product foundation

- [x] Home, Discover, Scan, Collection, and Insights have clearly different purposes.
- [x] The application uses one approved terminology system.
- [x] Manual values, market values, scenarios, and forecasts are visually and semantically distinct.
- [x] Every screen has one clearly dominant user task.
- [x] Technical implementation language is removed from primary user flows.
- [x] Product design tokens are documented and implemented.
- [x] Shared components are used consistently across all screens.

## 22.2 Navigation and application shell

- [x] Mobile uses a five-destination bottom navigation.
- [x] Scan is not duplicated as both a tab and independent floating button.
- [x] Tablet navigation adapts to available width.
- [x] Desktop uses a rail or sidebar rather than stretched mobile navigation.
- [x] Bottom navigation never obscures page content.
- [x] Sticky action bars always sit above global navigation.
- [x] Device safe-area insets are respected.
- [x] Active navigation is identifiable without relying only on color.
- [x] Modal sheets correctly recess or hide background navigation.
- [x] Browser Back returns users to the correct previous position.
- [x] Catalog filters and scroll position persist after opening an item.

## 22.3 Data correctness

- [x] Unknown values never display as `$0.00`.
- [x] Unpriced holdings are clearly labeled.
- [x] Portfolio totals disclose the number of excluded unpriced holdings.
- [x] Pricing coverage count and percentage are consistent.
- [x] Estimated gain appears only when cost basis and current value exist.
- [x] No historical chart appears with fewer than two valid observations.
- [x] Empty charts are replaced with purposeful next-step states.
- [x] Flat placeholder lines are removed.
- [x] Time-horizon controls match titles and calculations.
- [x] All displayed update times are consistent.
- [x] Manual values are not represented as market observations.
- [x] Neutral scenarios do not display misleading `+0.0%` performance.
- [x] Scenarios are not labeled as forecasts.
- [x] Internal model names and database identifiers are hidden by default.
- [x] Price sorting is unavailable when price data does not support it.

## 22.4 Home

- [x] The Home hero shows value, coverage, gain when valid, and readable freshness.
- [x] Developer-oriented market-build messaging is removed.
- [x] Needs Attention spans the available content width.
- [x] Every attention item contains one clear resolution action.
- [x] Metrics use a balanced responsive layout.
- [x] No orphan metric card appears on a separate row without purpose.
- [x] Collection mix uses a more comparable stacked-bar or ranked format.
- [x] Recent holdings use real artwork or intentional image states.
- [x] Data Health is collapsed by default.
- [x] Home does not duplicate the full Collection experience.

## 22.5 Discover

- [x] Discover uses one universal search field.
- [x] Search supports item names, set names, set codes, numbers, players, and product formats.
- [x] Browse categories are separated from product types and stores.
- [x] Only a limited number of categories appear before View All.
- [x] View All opens a dedicated picker.
- [x] The page contains no nested scrolling regions.
- [x] Applied filters appear as removable chips.
- [x] Filters show active counts.
- [x] Filters can be cleared individually and collectively.
- [x] Result cards meet the minimum readable width.
- [x] Mobile layouts do not force three narrow product columns.
- [x] Every set card is fully interactive.
- [x] Placeholder cards have intentional category branding or silhouettes.
- [x] Failed images provide retry or fallback behavior.
- [x] Deep set pages remove the full Discover introduction.
- [x] Breadcrumbs and back controls are readable and accessible.
- [x] Related product formats are grouped where appropriate.
- [x] Booster packs, boxes, and cases have clearly distinct names.
- [x] Empty forecast-period boxes are removed from product cards.
- [x] Sort controls reflect available result data.

## 22.6 Quick view

- [x] Quick view preserves the user’s catalog context.
- [x] Mobile quick view supports medium and expanded sheet sizes.
- [x] Background blur or dimming does not eliminate useful context.
- [x] Bottom navigation is visually recessed while the sheet is open.
- [x] Internal catalog IDs are not shown.
- [x] Identity confidence is clearly communicated.
- [x] Uncertain items require confirmation before adding.
- [x] Unavailable metrics do not occupy empty cards.
- [x] Add, Watch, and Full Details have clear hierarchy.
- [x] Closing the sheet restores focus to the originating result.

## 22.7 Item detail

- [x] Product media uses the correct aspect ratio.
- [x] Item images support direct tap/click zoom.
- [x] Long titles remain readable without overwhelming the viewport.
- [x] Current value appears before secondary metadata.
- [x] Price source and freshness are understandable.
- [x] Metadata adapts to collectible type.
- [x] Sealed products are never labeled Raw.
- [x] Internal IDs are hidden in the default view.
- [x] Technical methodology is collapsed.
- [x] Sticky Add and Watch actions remain above bottom navigation.
- [x] Price-history sections render only with valid data.
- [x] Already-owned items offer appropriate edit and quantity actions.

## 22.8 Scan and add

- [x] Open Camera and Upload Photo are separate actions.
- [x] Desktop supports drag-and-drop and paste when technically available.
- [x] The intake workflow explains Scan, Review, and Confirm.
- [x] Single-item and multi-item photos are supported.
- [x] Detection boundaries are visible and editable.
- [x] Users can delete, resize, move, and retry crops.
- [x] Match confidence is visible.
- [x] Alternative matches are available.
- [x] Low-confidence matches require confirmation.
- [x] Unresolved items can be searched manually or created as custom items.
- [x] Ownership details can be added before final confirmation.
- [x] Raw source-photo privacy is clearly disclosed.
- [x] Recoverable scan errors do not erase completed work.
- [x] Export Backup is moved out of the Add screen.
- [x] Successful additions produce confirmation feedback.

## 22.9 Collection

- [x] Portfolio is renamed Collection in user-facing navigation.
- [x] Collection is inventory-first rather than a duplicate dashboard.
- [x] The summary is compact.
- [x] A large chart is not shown without valid history.
- [x] Items, Sets, and Watchlist are available.
- [x] Search, Filter, Sort, and view controls form one coherent toolbar.
- [x] Export CSV is placed in an overflow or data menu.
- [x] Collection cards show title, set, quantity, value, and status.
- [x] Artwork loads at an appropriate resolution.
- [x] Selection controls are hidden until selection mode begins.
- [x] Long-press or Select enters bulk mode.
- [x] Users can switch between grouped items and individual purchases.
- [x] “Exact lots remain separate” is replaced with user-friendly wording.
- [x] The empty collection state directs users to Scan, Search, Import, or Custom Item.

## 22.10 Insights

- [x] Insights contains Overview, Alerts, Scenario Lab, and Track Record.
- [x] Manual scenarios are not placed under a Forecasts label.
- [x] Scenario controls use consistent horizons.
- [x] Scenario charts auto-scale to meaningful ranges.
- [x] Current value, median, 50% range, and 80% range are clearly distinct.
- [x] Neutral scenarios use Unchanged Scenario rather than misleading returns.
- [x] Confidence language is understandable without statistical expertise.
- [x] Evidence explanations include observation count and source diversity.
- [x] Per-item outlooks use compact comparison rows.
- [x] Only one item detail expands at a time.
- [x] Outlooks can be sorted by upside, downside, uncertainty, evidence, and value.
- [x] The main disclosure appears once per page.
- [x] Detailed methodology remains available in an expandable section.
- [x] Published Forecasts remains hidden until evidence requirements are met.

## 22.11 Visual system

- [x] Lime is reserved for brand and primary interaction.
- [x] Positive, warning, negative, market, and modeled states use distinct semantic colors.
- [x] Functional text has no chromatic shadow.
- [x] Currency and metrics use tabular numerals.
- [x] Body text remains at least 16 pixels in primary reading contexts.
- [x] Small metadata remains legible and passes contrast requirements.
- [x] Surface hierarchy uses canvas, content, and elevated interaction levels.
- [x] Ordinary layout regions do not all use visible borders.
- [x] No section contains more than two nested bordered surfaces.
- [x] Card radius, padding, and spacing use documented tokens.
- [x] Product image containers adapt to collectible type.
- [x] Empty imagery looks intentional rather than broken.

## 22.12 Responsive behavior

- [x] The application is tested below 360 pixels wide.
- [x] Standard phone layouts use one or two readable columns.
- [x] Tablet layouts use expanded grids or navigation rails.
- [x] Desktop uses available width efficiently.
- [x] Desktop item detail can use a split layout.
- [x] No screen displays excessive unused horizontal space.
- [x] No title or control overflows its container.
- [x] Landscape mobile orientation remains usable.
- [x] Browser zoom at 200% does not break core workflows.

## 22.13 Accessibility

- [x] All primary touch targets are at least 44 × 44 pixels.
- [x] All normal text meets required contrast.
- [x] Focus indicators are consistently visible.
- [x] All workflows are keyboard-operable.
- [x] Bottom sheets trap and restore focus correctly.
- [x] Charts have accessible text summaries.
- [x] Icons have accessible names.
- [x] Decorative imagery is hidden from screen readers.
- [x] Color is never the only indication of state.
- [x] Error messages identify both the problem and recovery action.
- [x] Reduced-motion preference is respected.
- [x] Increased-contrast and reduced-transparency modes remain usable.
- [x] Sticky controls do not obscure focused content.
- [x] No critical WCAG 2.2 AA violations remain.

## 22.14 Performance and resilience

- [x] Images use responsive sizes and modern formats.
- [x] Below-the-fold imagery is lazy-loaded.
- [x] Image dimensions are reserved to prevent layout shift.
- [x] Large result sets render incrementally or virtually.
- [x] Catalog interactions remain responsive with thousands of results.
- [x] Scan processing does not block the main interface.
- [x] Scan progress is visible.
- [x] Failed images can be retried.
- [x] Network failures show recoverable states.
- [x] Previously loaded local collection data remains available when offline.
- [x] LCP, INP, and CLS targets are met.
- [x] No major memory or scroll-performance regressions remain.

## 22.15 Final release acceptance

- [x] A new user can find and add an exact known item without assistance.
- [x] A user can distinguish a booster pack, booster box, and case from the result screen.
- [x] A user can explain why the displayed portfolio total may exclude an item.
- [x] A user can resolve an unpriced holding.
- [x] A user can tell the difference between market value, manual value, scenario, and forecast.
- [x] A user can scan several cards and correct every detected crop.
- [x] A user can return from item detail without losing browsing position.
- [x] No primary action is hidden behind navigation.
- [x] No fake or placeholder chart is visible in production.
- [x] No unknown value is represented as zero.
- [x] No unresolved catalog match is added as confirmed without user approval.
- [x] All P0 requirements are complete.
- [x] Accessibility review passes.
- [x] Responsive QA passes.
- [x] Performance budget passes.
- [x] Usability-test targets are met or documented exceptions are approved.

---

# 23. Release Blockers

The redesign must not ship with any of the following:

- Content or focus hidden behind fixed navigation.
- Unknown prices displayed as zero.
- Charts displayed without valid historical data.
- Scenarios labeled as verified forecasts.
- Unresolved identities added without confirmation.
- Nested scrolling in the primary Discover experience.
- Sealed products labeled using raw-card terminology.
- Inaccessible primary actions.
- Inconsistent time horizons.
- Technical model or database identifiers exposed in normal user flows.
- Mobile product grids too narrow to distinguish products.
- Critical WCAG 2.2 AA failures.

---

# 24. Final Definition of Done

The redesign is complete when CollectFolio provides a coherent, responsive, accessible, collector-first experience in which:

- Artwork leads the visual hierarchy.
- Portfolio data is honest and immediately understandable.
- Catalog discovery progresses naturally from broad intent to exact identity.
- Scanning supports review rather than blindly trusting recognition.
- Collection management is distinct from portfolio overview.
- Scenarios are clearly separated from evidence-backed forecasts.
- Missing data produces useful next actions instead of empty components.
- Technical details remain available without overwhelming ordinary users.
- Every major workflow works cleanly on mobile, tablet, desktop, keyboard, touch, and assistive technology.
- The overall experience feels intentionally designed rather than assembled from repeated dashboard cards.
