# CollectFolio Redesign PRD

**Working concept:** Market Gallery
**Document type:** Product Requirements Document
**Scope:** Responsive web application redesign
**Status:** Approved for phased implementation; protection baseline in progress
**Primary objective:** Transform CollectFolio from a functional dark dashboard into a premium, collector-first portfolio and forecasting platform.

---

## 0. Approved Execution Constraints

**Approved:** August 9, 2026

This redesign is an architectural front-end modernization around the existing
CollectFolio system. The following constraints govern implementation and take
precedence over any broader interpretation of later requirements:

1. **Protection baseline first.** Before routing or page redesign begins,
   capture representative IndexedDB and cloud fixtures, current calculation
   expectations, legacy view-to-route mappings, and browser smoke tests. The
   protection baseline and foundation must land as separate reviewable changes.
2. **No destructive foundation migration.** Existing IndexedDB records, cloud
   synchronization, local-only operation, scan and crop workflows, forecast
   fail-closed behavior, source-rights controls, and operator approval gates
   must remain intact. The foundation introduces normalized view-model adapters
   between current services/storage and new UI components. Persistence changes
   require a later explicit migration plan, compatibility tests, rollback plan,
   and separate approval.
3. **Real routes with compatibility.** The foundation will provide routes for
   Overview, Portfolio, Discover, Insights, Add, Card Detail, and Settings.
   Search filters and inspector state should be restorable through URLs where
   practical. Browser Back closes an inspector before leaving its underlying
   page. Existing view state receives documented compatibility mappings.
4. **Truthful information architecture.** Watchlist remains inside Portfolio.
   The architecture may anticipate multiple portfolios, but no selector appears
   until multiple portfolios actually work. Sets and Sold remain hidden. Alerts
   and Track Record remain hidden until their supporting contracts are real.
5. **Identity buckets are evidence-based.** Provider selection moves to an
   advanced or operator-facing control. Standard search uses Exact, Likely, and
   Possible buckets. A high text-similarity percentage alone must never produce
   an Exact label.
6. **Semantic status roles.** Primary action, positive movement, negative
   movement, forecast information, warning, error, and focus use distinct
   semantic roles. Positive financial movement must not reuse the primary-action
   treatment.
7. **Approved first vertical slice.** After the foundation is accepted, build
   Overview → Discover → Quick Inspector → Add → Portfolio while
   preserving local-only operation, URL state, filters, scroll position,
   browser history, and existing storage compatibility.
8. **No invented capabilities.** Do not invent time-range performance,
   attention states, forecast confidence, modeled fair value, alerts, or
   prediction history. Render only capabilities supported by approved current
   contracts, with useful unavailable states elsewhere.
9. **Existing publication gates remain authoritative.** The redesigned UI must
   not bypass rights, exact-mapping, model-validation, feature-flag, or operator
   approval controls for public pricing or forecasting.
10. **Quality ships with each page.** Browser end-to-end, accessibility, and
    visual-regression coverage are added incrementally with every converted page,
    beginning with the protection baseline rather than deferred to final polish.

The implementation sequence is therefore:

1. protection baseline review and approval;
2. foundation review and approval;
3. approved core vertical slice;
4. later intake, management, insights, and release tranches.

Broad page redesign must not begin before both protection baseline and
foundation changes have been independently reviewed and accepted.

---

## 1. Executive Summary

CollectFolio should become a modern portfolio platform where collectors can:

* Search and identify exact cards and collectible variants.
* Add single items or entire batches quickly.
* Track holdings, cost basis, current value, and performance.
* Watch collectibles before purchasing.
* Receive price and market alerts.
* View transparent short- and long-term forecasts.
* Understand forecast confidence, drivers, and historical accuracy.
* Maintain ownership of their portfolio locally or through optional cloud synchronization.
* Support cards, sealed products, slabs, sports cards, comics, and custom collectibles.

The current product has a solid foundation, but its visual hierarchy, page density, navigation, terminology, and card presentation need substantial refinement. The redesign should make collectible artwork the visual centerpiece, portfolio movement the informational centerpiece, and forecasting transparency the product differentiator.

The finished experience should feel like a combination of:

* A premium investment portfolio interface.
* A curated digital card gallery.
* A fast collection-management utility.
* A transparent forecasting and market-intelligence product.

It should not feel like a generic administrative dashboard, spreadsheet, database browser, or developer tool.

---

# 2. Product Problem

The current application is functional but presents several usability and positioning problems.

## 2.1 Current problems

1. Page headings consume too much vertical space.
2. Card artwork is too small relative to surrounding UI.
3. Multiple pages contain large areas of unused space.
4. Most cards and panels have similar visual weight.
5. Technical terms such as provider, canonical mapping, Supabase, and identity tier are exposed to ordinary users.
6. Search results are vertically inefficient.
7. Search confidence is presented as raw technical percentages.
8. Current value, manually entered value, modeled value, and future forecast value are not sufficiently differentiated.
9. The Add screen asks users to choose between single-card and multi-card scanning before the system needs that distinction.
10. Watchlist and forecast empty states repeat zero values instead of directing users toward a useful action.
11. The portfolio trend area can appear empty even after holdings have been added.
12. Navigation does not cleanly separate collection management from market intelligence.
13. Unsupported or unpriced cards feel incomplete rather than useful.
14. Forecasting is described as a future feature rather than presented as a structured product capability.
15. The interface does not yet have a distinctive visual language that users would associate specifically with CollectFolio.

---

# 3. Product Goals

## 3.1 Primary goals

The redesign must allow a user to understand the following within five seconds of opening the Overview screen:

* Current portfolio value.
* Recent portfolio movement.
* Cost basis and unrealized gain or loss.
* Forecast availability and likely range.
* Items or data requiring attention.

The redesign must also:

* Make adding an item fast enough for frequent use.
* Make exact variant identification clear.
* Improve search result density without reducing readability.
* Treat cards and collectible imagery as primary content.
* Clearly distinguish verified market data from manual or modeled values.
* Provide useful states when pricing or forecasts are unavailable.
* Preserve the product’s truth-first approach.
* Work well for guest, local-only, and signed-in users.
* Provide an extensible structure for cards, comics, slabs, sealed products, and additional collectible categories.

## 3.2 Secondary goals

* Increase watchlist usage.
* Increase the percentage of holdings with complete purchase information.
* Encourage users to create price alerts.
* Create a recognizable forecasting visualization.
* Make cloud synchronization understandable without exposing implementation details.
* Support power users without overwhelming casual collectors.
* Create a foundation that can later support mobile applications.

---

# 4. Non-Goals

The redesign does not require the following unless separately scoped:

* Building a marketplace.
* Allowing users to directly purchase or sell cards.
* Replacing the existing pricing ingestion infrastructure.
* Creating a completely new forecasting model.
* Approving unlicensed or unreviewed data providers.
* Building a social feed or collector community.
* Building native iOS or Android applications.
* Guaranteeing forecast accuracy.
* Automating card grading.
* Replacing existing operator or administrative workflows.
* Redesigning the public marketing website.

The UI may expose data from these systems, but the redesign should not depend on rebuilding them.

---

# 5. Assumptions

1. Existing local holdings must continue to load after the redesign.
2. Cloud synchronization remains optional.
3. Some cards will have verified pricing.
4. Some cards will have manual values only.
5. Some cards will be identified but not canonically mapped.
6. Some cards will have no forecast.
7. Forecast availability will vary by category and data quality.
8. Search may return exact, likely, and possible matches.
9. Users may hold raw, graded, sealed, or custom collectibles.
10. Dark mode remains the primary visual theme.
11. A light theme may be supported through the same design tokens but is not required for the first redesign release.
12. Existing route compatibility should be maintained where reasonably possible.

---

# 6. Target Users

## 6.1 Casual Collector

Needs to:

* Find a card.
* Add it quickly.
* See what the collection is worth.
* Avoid complicated investment or technical terminology.

## 6.2 Active Collector

Needs to:

* Track dozens or hundreds of exact variants.
* Record purchase price, condition, fees, and quantity.
* Monitor price changes.
* Maintain a watchlist.
* Use filters and bulk editing.

## 6.3 Portfolio-Oriented Collector

Needs to:

* Understand performance by item, set, and category.
* Compare cost basis with current market value.
* View forecasts and confidence.
* Track whether prior predictions were accurate.
* Identify opportunities and risks.

## 6.4 Local-First or Privacy-Oriented User

Needs to:

* Use the app without an account.
* Understand where data is stored.
* Export and back up the portfolio.
* Enable synchronization only when desired.

---

# 7. Core Product Principles

## 7.1 Cards First

Card artwork and collectible imagery must be more visually prominent than generic interface panels.

## 7.2 Truth Before Polish

The application must never manufacture a price, movement, confidence level, or forecast merely to avoid an empty state.

## 7.3 Exact Variant Before General Identity

The application should distinguish between:

* A card character or subject.
* A card printing.
* A set and number.
* A variant.
* A language.
* A condition or grade.

## 7.4 Actual and Forecast Values Must Never Be Confused

Current market value, manual value, modeled fair value, and future forecast must each have different labels and visual treatments.

## 7.5 Progressive Disclosure

Ordinary users should see understandable information first. Provider details, mapping status, model versions, confidence scores, and data lineage should remain accessible through a secondary details panel.

## 7.6 One Clear Primary Action

Empty states, dialogs, and major workflow steps should have one obvious primary action.

## 7.7 Motion Must Explain State

Animation should communicate where a card, panel, or data point came from and where it moved. Motion should not exist solely as decoration.

## 7.8 Local Ownership Must Be Understandable

Users should understand whether their portfolio is:

* Saved locally.
* Backed up.
* Synchronized.
* Offline.
* Awaiting synchronization.

They should not need to understand the underlying database provider.

---

# 8. Information Architecture

## 8.1 Primary navigation

The redesigned application will use the following primary destinations:

| Destination | Purpose                                                                         |
| ----------- | ------------------------------------------------------------------------------- |
| Overview    | Current value, recent movement, forecast summary, and attention items           |
| Portfolio   | Holdings, watchlist, sets, and sold items                                       |
| Discover    | Search, image recognition, browsing, trending items, and comparisons            |
| Insights    | Performance, forecasts, alerts, and prediction track record                     |
| Add         | Global intake action for scanning, uploading, searching, importing, or creating |

Profile and application settings should be accessed through the user avatar rather than consuming a primary navigation position.

## 8.2 Recommended routes

```text
/
  Overview

/portfolio
  /portfolio?view=holdings
  /portfolio?view=watchlist
  /portfolio?view=sets
  /portfolio?view=sold

/discover
  /discover?mode=search
  /discover?mode=image
  /discover?mode=sets
  /discover?mode=market

/insights
  /insights?view=performance
  /insights?view=forecasts
  /insights?view=alerts
  /insights?view=track-record

/cards/:cardId
/holdings/:holdingId
/add
/settings
```

The Add experience may open as a modal or full-screen workspace, but it must also have a route that supports refresh and deep linking.

---

# 9. Priority Definitions

| Priority | Meaning                                                                       |
| -------- | ----------------------------------------------------------------------------- |
| P0       | Required for the redesign release                                             |
| P1       | Required shortly after the core redesign or when the supporting data is ready |
| P2       | Enhancement that may follow without blocking release                          |

---

# 10. Detailed Product Requirements

---

## 10.1 Global Application Shell and Navigation

**Priority:** P0

### Objective

Create a consistent application framework that keeps navigation available, reduces repeated page-level chrome, and gives users access to search, portfolio status, synchronization, notifications, and account controls.

### Required changes

#### Desktop navigation

The current left navigation should be replaced with:

* Overview
* Portfolio
* Discover
* Insights
* Prominent Add action
* Notifications
* Avatar or account menu

The Add action should remain visually distinct but should not overpower all other navigation.

#### Global top bar

The desktop top bar should include:

* Current portfolio selector.
* Global card and action search.
* Data freshness or synchronization status.
* Notification access.
* User avatar.
* Command palette shortcut.

#### Mobile navigation

The mobile bottom navigation should contain:

* Home
* Discover
* Add
* Portfolio
* Insights

Profile and settings should be accessed through the avatar or an account menu.

#### Command palette

The command palette should support:

* Searching cards.
* Opening recent cards.
* Navigating to app sections.
* Adding an item.
* Switching portfolios.
* Opening settings.
* Importing or exporting.
* Opening alerts.

### Completion criteria

* [ ] Desktop navigation appears consistently on every primary application route.
* [ ] Mobile bottom navigation appears at supported mobile breakpoints.
* [ ] Active navigation state is visually clear without relying on color alone.
* [ ] Add is accessible from every primary screen.
* [ ] Settings and profile are accessible without occupying a primary mobile navigation slot.
* [ ] Current portfolio can be changed from the global application shell.
* [ ] Search can be opened from the top bar or command palette.
* [ ] Navigation can be completed using keyboard controls.
* [ ] Focus order follows the visible interface order.
* [ ] Browser back and forward controls work correctly between routes, inspectors, and detail pages.
* [ ] Existing deep links either remain functional or redirect to the corresponding new location.
* [ ] The application shell does not visibly shift while page content loads.
* [ ] No primary content is hidden behind the mobile bottom navigation.
* [ ] The navigation functions correctly at 390 px, 768 px, 1024 px, 1440 px, and 1920 px widths.

---

## 10.2 Design System and Visual Foundation

**Priority:** P0

### Objective

Establish a consistent, reusable design system that creates a premium visual hierarchy without making every element look like a glowing dashboard card.

### Required changes

#### Semantic color system

The design system must use semantic tokens rather than page-specific colors.

Required token roles:

* Canvas background.
* Primary workspace background.
* Secondary surface.
* Interactive surface.
* Primary text.
* Secondary text.
* Muted text.
* Border.
* Primary action.
* Positive movement.
* Negative movement.
* Forecast information.
* Warning or incomplete data.
* Error.
* Focus ring.

Recommended role usage:

* Chartreuse for primary actions and selected states.
* Emerald or mint for positive value movement.
* Coral or red-orange for negative movement.
* Violet or cool blue for forecast information.
* Amber for uncertainty or incomplete data.
* Neutral blue-gray for supporting information.

Positive gain must not use the same exact treatment as the primary Add button.

#### Typography

Recommended desktop scale:

* Page title: 36–44 px.
* Section title: 22–28 px.
* Card title: 16–20 px.
* Body: 15–16 px.
* Metadata: 12–14 px.
* Major portfolio value: 48–64 px.

Recommended mobile scale:

* Page title: 28–32 px.
* Section title: 20–24 px.
* Major portfolio value: 40–52 px.

All prices and percentages should use tabular numerals.

#### Surface system

Use no more than three normal application surface levels:

1. Canvas.
2. Primary surface.
3. Interactive or selected surface.

Elevated shadow treatments should be reserved for:

* Modals.
* Menus.
* Inspectors.
* Dragged items.
* Floating controls.

#### Card imagery

Use consistent image containers for:

* Raw cards.
* Graded slabs.
* Sealed products.
* Comics.
* Custom items.

Raw card imagery should default to approximately a 5:7 aspect ratio.

### Completion criteria

* [ ] All colors are implemented through documented semantic tokens.
* [ ] No page introduces an undocumented hard-coded status color.
* [ ] Primary actions, positive values, forecasts, warnings, and errors are visually distinguishable.
* [ ] Text and meaningful controls meet the project’s accessible contrast standard.
* [ ] Price columns use tabular numerals.
* [ ] Utility pages no longer use oversized marketing-style headings.
* [ ] The same typography scale is used across Overview, Discover, Portfolio, Insights, and Settings.
* [ ] Card imagery uses standardized aspect-ratio components.
* [ ] Raw cards, slabs, sealed products, and custom items do not appear distorted.
* [ ] Ordinary panels do not each receive unnecessary shadows or glow.
* [ ] Spacing follows a documented base spacing system.
* [ ] Radius, border, input, button, badge, tab, and panel styles are reusable components.
* [ ] Dark theme colors are tested against representative card artwork.
* [ ] The design system documentation includes examples of correct and incorrect status-color use.

---

## 10.3 Overview Screen

**Priority:** P0

### Objective

Allow users to understand their portfolio’s current condition, recent movement, forecast coverage, and required actions without navigating to another page.

### Required layout

#### Portfolio hero

The primary area should include:

* Current estimated market value.
* Selected time range.
* Value change for that range.
* Portfolio trend chart.
* Pricing coverage.
* Last updated time.
* Cost basis.
* Unrealized gain or loss.

Time ranges:

* 1D
* 7D
* 1M
* 3M
* 1Y
* All

#### Today or Attention panel

Show actionable portfolio information such as:

* Items with price changes.
* Items needing manual review.
* Items with outdated values.
* Forecast changes.
* Alerts triggered.
* Synchronization errors.

#### Supporting modules

The Overview should include:

* Top movers.
* 90-day outlook.
* Collection mix.
* Recent holdings.
* Watchlist opportunities.
* Recent activity.

Not all modules must appear if there is no data. The layout should adapt rather than display empty card shells.

### Portfolio chart states

#### No holdings

Show:

* Clear first-run message.
* Add first collectible action.
* Search action as a secondary option.

#### Holdings added but no history

Show:

* Current portfolio value as the first chart point.
* “Tracking began today” or equivalent language.
* Do not show a large empty chart.

#### Partial pricing

Show:

* Market-priced item count.
* Manual-value item count.
* Unpriced item count.
* Coverage percentage.

### Completion criteria

* [ ] At 1440 × 900, the first viewport contains portfolio value, recent movement, chart, cost basis, gain or loss, and forecast summary.
* [ ] The user does not need to scroll to understand the current portfolio condition.
* [ ] The portfolio chart renders a valid starting point after the first holding is added.
* [ ] The chart never implies historical data that does not exist.
* [ ] Partial pricing coverage is clearly disclosed.
* [ ] Manual values are distinguishable from market-observed values.
* [ ] Forecast values are visually separate from current values.
* [ ] Time-range changes update the chart and supporting change metrics.
* [ ] Top movers include visible card imagery.
* [ ] Attention items link directly to the relevant correction or review workflow.
* [ ] Empty modules collapse rather than occupying large blank spaces.
* [ ] The no-holdings state has one primary action.
* [ ] Positive and negative movement do not rely only on green and red.
* [ ] The screen remains usable when no forecast data is available.
* [ ] The layout works in one column on mobile without changing the meaning of the metrics.

---

## 10.4 Discover and Search

**Priority:** P0

### Objective

Make finding an exact card, variant, set, player, character, or collectible fast while reducing search-result density problems and simplifying provider-specific controls.

### Required changes

#### Unified search control

The main search control should support:

* Card name.
* Character.
* Player.
* Set.
* Card number.
* Year.
* Product name.
* Variant.
* Barcode or identifier where available.

The primary search bar should include:

* Text input.
* Image search trigger.
* Filter trigger.
* Clear action.
* Recent searches.
* Suggested completions.

#### Search modes

Recommended modes:

* Search.
* Image.
* Sets.
* Market.

Image search may open from the camera icon instead of requiring a separate prominent button.

#### Filters

Context-sensitive filters should change by collectible category.

Pokémon examples:

* Set.
* Number.
* Rarity.
* Variant.
* Language.
* Raw or graded.

Sports examples:

* Sport.
* Player.
* Year.
* Manufacturer.
* Set.
* Parallel.
* Serial numbering.
* Grade.

Comic examples:

* Publisher.
* Series.
* Issue.
* Year.
* Grade.

Provider selection should be placed in an advanced Data Source control rather than treated as a primary collector decision.

#### Match quality

Search results should be grouped as:

* Exact matches.
* Likely matches.
* Possible matches.

Raw matching percentages should not be shown in the normal user interface.

#### Result views

Support:

* Gallery view.
* List view.

Remember the user’s last selected view.

#### Quick inspector

Selecting a result should open a right-side inspector on desktop and a bottom sheet on mobile.

The inspector should allow users to:

* Review the exact variant.
* See current value.
* See pricing status.
* See forecast availability.
* Watch the card.
* Add it to a portfolio.
* Open the full detail page.

### Completion criteria

* [ ] Users can search by card name, set, and card number.
* [ ] Image search can be opened directly from the primary search area.
* [ ] Search filters adapt to the selected collectible category.
* [ ] Provider selection is not required for an ordinary search.
* [ ] Raw confidence percentages are not displayed in standard search results.
* [ ] Exact, likely, and possible matches have distinct labels.
* [ ] Search results show enough identity information to distinguish variants.
* [ ] Each search result includes card image, name, set, number, variant, and pricing state when available.
* [ ] Search results do not show “price unavailable” and “no provider price” as separate repetitive messages.
* [ ] “Pricing pending” or an equivalent user-facing state is used consistently.
* [ ] Desktop gallery view supports at least four columns at a typical 1440 px width.
* [ ] Mobile gallery view supports two columns where card text remains readable.
* [ ] Desktop list view displays at least five useful result rows in a typical viewport after the search controls.
* [ ] The entire result row or card opens the inspector.
* [ ] A separate Details button is not required for basic navigation.
* [ ] Watch and Add remain directly accessible.
* [ ] Filter state remains after returning from a card detail page.
* [ ] Search result scrolling remains smooth with large result sets.
* [ ] No-result states suggest corrective actions such as removing filters or searching by image.
* [ ] Search errors do not discard the user’s search term or active filters.
* [ ] The selected result and scroll position are preserved when the inspector is closed.

---

## 10.5 Add and Collection Intake

**Priority:** P0

### Objective

Create one unified intake flow that supports a single card, multiple cards, image uploads, catalog search, imports, and custom items without forcing unnecessary early decisions.

### Required flow

#### Step 1: Capture or source

Primary action:

* Scan or upload cards.

Secondary actions:

* Take photo.
* Upload images.
* Search catalog.
* Import file.
* Create custom item.

The system should automatically determine whether one or multiple items are present.

#### Step 2: Detection and matching

For scanned or uploaded images, show:

* Detected item crops.
* Proposed match.
* Match quality.
* Exact variant.
* Replace match.
* Exclude item.
* Unmatched status.

Provide queue summary:

* Total detected.
* Exact matches.
* Needs review.
* Unmatched.

#### Step 3: Acquisition details

For each item, allow entry of:

* Portfolio.
* Quantity.
* Condition.
* Grade and grading company.
* Purchase price.
* Fees.
* Purchase date.
* Seller or source.
* Storage location.
* Notes.
* Manual current value when necessary.

For multiple items, use a compact bulk editor and “apply to all” controls.

#### Step 4: Review and confirmation

The review screen must show:

* Items being added.
* Exact identities.
* Unresolved variants.
* Total quantity.
* Total cost basis.
* Market pricing coverage.
* Portfolio destination.

#### Step 5: Success

After adding:

* Confirm how many items were added.
* Show unresolved items separately.
* Provide direct access to the portfolio.
* Allow the user to continue adding.

### Draft recovery

The intake flow should preserve a draft if:

* The browser refreshes.
* The user accidentally closes the flow.
* The app temporarily goes offline.
* Authentication interrupts the workflow.

### Completion criteria

* [ ] The user is not asked to choose single-card versus multi-card scanning before capture.
* [ ] One uploaded image can produce one or multiple detected items.
* [ ] Each detected crop can be edited or removed.
* [ ] Exact variants can be corrected before being added.
* [ ] Uncertain matches are explicitly marked for review.
* [ ] Unmatched items can be converted into custom items.
* [ ] Bulk intake supports condition, quantity, purchase price, fees, and acquisition date.
* [ ] “Apply to all” functions work for appropriate bulk fields.
* [ ] Total cost basis is visible before confirmation.
* [ ] Items with unresolved identity cannot silently enter as exact matches.
* [ ] The add operation is transactional enough to prevent accidental duplicate submissions.
* [ ] The success screen accurately reports added, skipped, and unresolved items.
* [ ] A single catalog item can be added in no more than four meaningful user decisions after it is selected.
* [ ] A user can add one known card through search in approximately 30 seconds under normal conditions.
* [ ] A saved draft can be recovered after a refresh.
* [ ] Camera permission denial produces a clear upload alternative.
* [ ] Mobile capture controls are reachable with one hand.
* [ ] The workflow supports keyboard entry and review on desktop.
* [ ] The flow does not lose completed field values when the user corrects one card match.

---

## 10.6 Portfolio and Holdings

**Priority:** P0

### Objective

Provide an efficient workspace for reviewing, filtering, editing, grouping, and valuing owned collectibles.

### Required sections

Portfolio should include:

* Holdings.
* Watchlist.
* Sets.
* Sold.

The Sold view may be P1 if the supporting data model is not ready, but the navigation structure should anticipate it.

### Header summary

Show:

* Portfolio name.
* Total estimated market value.
* Cost basis.
* Unrealized gain or loss.
* Total unique items.
* Total quantity.
* Pricing coverage.
* Last updated time.

### Views

Support:

* Gallery.
* List or table.

### Filters

Support:

* Category.
* Set.
* Raw, graded, or sealed.
* Condition.
* Grading company.
* Language.
* Pricing status.
* Gain or loss range.
* Added date.
* Portfolio.
* Tags.

### Sorting

Support:

* Highest value.
* Largest gain.
* Largest loss.
* Recently added.
* Recently changed.
* Name.
* Set order.
* Quantity.
* Missing information.

### Holding information

Each row or card should display:

* Card image.
* Exact card identity.
* Condition or grade.
* Quantity.
* Current value.
* Cost basis.
* Gain or loss.
* Recent movement.
* Forecast availability.
* Pricing status.

### Bulk actions

When items are selected, show:

* Edit.
* Move.
* Add tags.
* Duplicate.
* Mark sold.
* Export.
* Delete.

### Completion criteria

* [ ] Holdings, Watchlist, Sets, and Sold are clearly separated.
* [ ] Portfolio summary remains visible without requiring the user to interpret multiple disconnected metric cards.
* [ ] Users can switch between gallery and list views.
* [ ] View preference persists.
* [ ] Exact variant, condition, and quantity are visible without opening every holding.
* [ ] Market value and cost basis are distinguishable.
* [ ] Manual values carry a visible source label.
* [ ] Unpriced holdings remain visible and editable.
* [ ] Filters can be combined.
* [ ] Active filters are shown as removable chips or an equally clear representation.
* [ ] Users can clear all filters in one action.
* [ ] Sorting persists during the session.
* [ ] Selecting items reveals a bulk-action toolbar.
* [ ] Bulk actions are hidden when no items are selected.
* [ ] Destructive bulk actions require explicit confirmation.
* [ ] Editing a quantity updates total quantity, cost basis, and value correctly.
* [ ] Duplicate exact variants can either be merged or maintained as separate acquisition lots according to the data model.
* [ ] Large portfolios do not render every row at once if doing so would cause performance problems.
* [ ] Mobile presentation converts dense tables into readable item cards or a horizontally constrained layout.
* [ ] Returning from card detail preserves filters, sort order, and scroll position.

---

## 10.7 Watchlist

**Priority:** P0

### Objective

Allow users to follow exact collectible variants, define purchase targets, receive alerts, and identify potential opportunities.

### Empty state

When the watchlist is empty, do not show:

* Three zero-value statistic panels.
* Empty filter controls.
* A separate zero-result heading.
* A second empty-state card.

Instead show:

**Track cards before you buy**

Supporting copy:

“Watch prices, set targets, and follow future outlooks.”

Primary action:

* Find a card.

### Populated state

Each watched item should show:

* Exact variant.
* Current market price.
* 7-day and 30-day movement.
* User target price.
* Distance from target.
* Forecasted range when available.
* Forecast confidence.
* Alert state.
* Last pricing update.
* Sales frequency or liquidity when available.

### Watchlist sorting

Support:

* Best opportunity.
* Closest to target.
* Largest forecasted upside.
* Largest decline.
* Recently changed.
* Highest value.
* Recently added.

Recommended default:

* Best opportunity.

### Completion criteria

* [ ] Empty watchlist shows one focused empty state rather than repeated zero metrics.
* [ ] The primary empty-state action opens Discover.
* [ ] Watchlist entries always represent an exact variant.
* [ ] Adding the same exact variant twice does not create accidental duplicate watchlist entries.
* [ ] The user can set, edit, and remove a target price.
* [ ] The user can create and disable alerts.
* [ ] Current value and future forecast are visually separated.
* [ ] Items without forecasts remain useful and watchable.
* [ ] Items without current pricing show a clear pending or manual-value state.
* [ ] Best Opportunity does not rank an item as attractive without enough supporting data.
* [ ] Sort and filter controls appear only when they are useful.
* [ ] Watchlist entries can be converted into holdings.
* [ ] Removing an item provides an undo opportunity or confirmation.
* [ ] Alert state is accessible without opening the full card detail page.
* [ ] The interface explains why an item appears as a high-priority opportunity.

---

## 10.8 Insights and Forecasting

**Priority:** P0 for the structure and core forecast presentation
**Priority:** P1 for advanced accuracy reporting

### Objective

Make forecasting a transparent, understandable, and accountable product capability rather than a single speculative number.

### Required Insights sections

* Performance.
* Forecasts.
* Alerts.
* Track Record.

### Required value definitions

The interface must consistently distinguish:

#### Current market value

A value derived from current or recent approved market observations.

#### Manual value

A value entered by the user.

#### Modeled fair value

An estimate of what the item may reasonably be worth now based on the model.

#### Future forecast

A projected range for a specific future date or horizon.

### Portfolio forecast summary

Show:

* Current market value.
* Forecast horizon.
* Likely forecast range.
* Confidence label.
* Forecast coverage.
* As-of date.
* Model update date.

Example:

```text
Current market value
$1,332

90-day likely range
$1,280–$1,470

Confidence
Medium

Coverage
4 of 7 holdings
```

### Forecast Ribbon

The standard forecasting chart should use:

* Solid line for historical market value.
* Clear marker for the present date.
* Dotted or visually distinct expected path.
* Shaded likely range.
* Labeled maturity date.
* Confidence label.
* Optional scenarios behind an advanced control.

The forecast region must never look like historical observed data.

### Forecast horizons

Support where data exists:

* 7 days.
* 30 days.
* 90 days.
* 180 days.
* 1 year.

### Forecast explanation

Each forecast should include:

* Likely range.
* Confidence level.
* Confidence explanation.
* Data freshness.
* Forecast coverage.
* Positive drivers.
* Risks.
* What changed since the previous forecast.
* Model version in advanced details.

### Forecast availability states

#### Available

Required fields and data quality threshold are met.

#### Limited

A forecast may be shown with low confidence and a clear explanation.

#### Unavailable

Show why, using customer-friendly language:

* Pricing history is too limited.
* Exact variant is awaiting verification.
* Recent sales are insufficient.
* This category is not supported yet.
* The item uses a manual value.

### Prediction track record

Each immutable forecast record should contain:

* Forecast creation date.
* Forecast horizon.
* Predicted range.
* Expected midpoint.
* Maturity date.
* Actual result.
* Absolute error.
* Direction correct or incorrect.
* Model version.
* Data snapshot or provenance reference.

Aggregate track-record metrics may include:

* Matured forecasts.
* Median absolute error.
* Directional accuracy.
* Accuracy by horizon.
* Accuracy by category.
* Accuracy over time.

Metrics should not be displayed before a defined minimum sample threshold is reached.

### Completion criteria

* [ ] Current market value, manual value, modeled fair value, and future forecast use separate labels.
* [ ] Forecasts are displayed as ranges, not merely as isolated precise future values.
* [ ] Every forecast displays a horizon.
* [ ] Every forecast displays an as-of date.
* [ ] Every forecast displays a confidence label or an unavailable state.
* [ ] Confidence includes a human-readable explanation.
* [ ] Forecast coverage states how many holdings or items contributed.
* [ ] Historical chart data and forecasted chart data are visually distinguishable.
* [ ] The current-date boundary is obvious.
* [ ] Forecast shading does not obscure historical values.
* [ ] Items with insufficient data do not receive fabricated forecasts.
* [ ] Unavailable forecasts still provide a useful explanation and next action.
* [ ] The user can change forecast horizons where supported.
* [ ] Forecast changes can be traced to a previous forecast record.
* [ ] Matured forecasts are not overwritten.
* [ ] Track-record metrics exclude forecasts that have not matured.
* [ ] Accuracy percentages are not shown with an insufficient sample.
* [ ] Model version and data details are available through progressive disclosure.
* [ ] The forecast chart includes a nonvisual summary for accessibility.
* [ ] Forecast colors are not used as the sole communication method.
* [ ] The forecast UI remains understandable without animation.
* [ ] Portfolio forecast value is never included in current portfolio value.
* [ ] Copy does not imply certainty or guaranteed return.

---

## 10.9 Card Detail Page

**Priority:** P0

### Objective

Make each card or collectible feel like a premium product page while exposing ownership, market, forecast, and data-quality information.

### Recommended desktop layout

#### Left column

* Large card image.
* Front and back toggle.
* Zoom.
* Alternate image or slab image where available.
* Optional restrained card-specific ambient treatment.

#### Center column

* Card name.
* Set.
* Number.
* Rarity.
* Variant.
* Language.
* Raw or graded state.
* Variant selector.
* User holding information.
* Notes and acquisition information.

#### Right column

* Current market value.
* Recent movement.
* Model fair value where available.
* Forecast range.
* Confidence.
* Data freshness.
* Primary actions.

### Primary actions

* Add to portfolio or Edit holding.
* Watch or Unwatch.
* Compare.
* Share.

### Detail tabs

* Overview.
* Market.
* Forecast.
* Sales.
* Details.

### Pricing unavailable state

Instead of presenting the page as unavailable, show:

**Card identified**

“Market pricing has not been verified yet.”

Available actions:

* Add to portfolio.
* Enter manual value.
* Watch for pricing.
* Correct match.
* View related variants.

Technical mapping status should live in a collapsed Data Details panel.

### Completion criteria

* [ ] Card artwork is visually dominant on desktop and mobile detail pages.
* [ ] Raw card art is displayed at a useful inspection size.
* [ ] Exact identity is visible without opening an advanced panel.
* [ ] Variant, language, condition, and grade cannot be mistaken for each other.
* [ ] Holding information is separated from general market information.
* [ ] Current market value and forecast are presented in separate areas.
* [ ] Pricing freshness is shown.
* [ ] Watch and Add actions are available above the fold.
* [ ] A card can be added or edited without leaving the page unnecessarily.
* [ ] Unpriced cards still provide useful metadata and actions.
* [ ] Technical terms such as canonical mapping and identity tier are hidden from the default presentation.
* [ ] Related variants are clearly distinguished from the selected variant.
* [ ] Sales data identifies whether it represents raw, graded, or another variant.
* [ ] The page handles missing image, missing price, missing forecast, and partial metadata states.
* [ ] Front and back images are keyboard accessible.
* [ ] Mobile layout places primary actions within easy reach.
* [ ] The page can be directly linked and restored after refresh.
* [ ] Metadata displayed on the page corresponds to the card’s exact canonical identity or is labeled as unverified.

---

## 10.10 Quick Card Inspector

**Priority:** P0

### Objective

Allow users to inspect, watch, and add a card without losing their place in search or portfolio results.

### Required behavior

On desktop:

* Open as a right-side panel.
* Preserve the underlying page and scroll position.
* Show card art, exact identity, value, movement, forecast status, and actions.

On mobile:

* Open as a bottom sheet or full-height sheet.
* Support drag or explicit close.
* Keep actions visible near the bottom.

### Completion criteria

* [ ] Opening the inspector does not navigate away from the current result set.
* [ ] Closing the inspector restores the prior scroll position.
* [ ] The inspector supports Add, Watch, and Open Full Details.
* [ ] Exact variant information is visible.
* [ ] The inspector handles pricing and forecast unavailable states.
* [ ] Browser back closes the inspector before leaving the underlying page.
* [ ] Inspector focus is trapped correctly while open.
* [ ] Focus returns to the originating result when closed.
* [ ] Mobile inspector does not conflict with bottom navigation.
* [ ] Only one inspector instance can be open at a time.

---

## 10.11 Profile, Account, Sync, and Settings

**Priority:** P0

### Objective

Explain account status, local storage, cloud backup, preferences, privacy, and data portability using user-facing language.

### Required sections

#### Account and sync

Guest state:

* Saved locally.
* Number of holdings on device.
* Enable cloud backup.
* Sign in or create account.

Signed-in state:

* Synchronized.
* Last synchronized time.
* Current device status.
* Resolve synchronization issue.
* Sign out.

#### Preferences

* Currency.
* Appearance.
* Default condition.
* Default language.
* Default portfolio.
* Default forecast horizon.
* Price-source preference where appropriate.
* Notification preferences.

#### Data

* Export backup.
* Import backup.
* CSV export.
* Delete local data.
* Remove cloud data.
* Storage usage.
* Synchronization history.

#### Privacy

* Private analytics participation.
* Personalized recommendations.
* Diagnostic data.
* Public profile visibility if introduced later.
* Clear explanation of aggregate data requirements.

### Required terminology changes

| Internal or current term | User-facing term                 |
| ------------------------ | -------------------------------- |
| Supabase                 | Cloud backup & sync              |
| Local mode               | Saved locally                    |
| Public key configured    | Remove from user-facing UI       |
| Canonical mapping        | Exact card verification          |
| Provider price           | Market pricing                   |
| Tier 0 identity only     | Card identified; pricing pending |
| Demand analytics         | Private market insights          |
| Signals                  | Alerts or market alerts          |

### Completion criteria

* [ ] The word Supabase does not appear in ordinary user-facing settings.
* [ ] Public keys and backend configuration are not exposed.
* [ ] The user can determine whether data is local, synchronized, or offline.
* [ ] Local use remains available without account creation.
* [ ] Enabling cloud synchronization clearly states what will happen.
* [ ] Synchronization errors include a recovery action.
* [ ] Export creates a usable backup or documented portable file.
* [ ] Import validates the file before changing the active portfolio.
* [ ] Destructive data actions require explicit confirmation.
* [ ] Currency changes update display values without rewriting original source currency incorrectly.
* [ ] Preference changes provide visible saved confirmation.
* [ ] Privacy controls use understandable descriptions.
* [ ] Settings remain usable on mobile.
* [ ] Account and synchronization status are not represented solely by color.
* [ ] Signed-out and signed-in states are covered by automated tests.

---

## 10.12 Empty, Loading, Error, Offline, and Partial-Data States

**Priority:** P0

### Objective

Create consistent system states that remain useful and do not make the application appear broken.

### Required state categories

#### First-use empty state

Used when the user has not created any data.

Must include:

* Explanation.
* One primary action.
* Optional secondary text action.

#### Filtered empty state

Used when data exists but filters produce no results.

Must include:

* Active filter context.
* Clear filters.
* Modify search.

#### Data unavailable state

Used when an item exists but pricing, forecasting, or sales data is unavailable.

Must include:

* What is known.
* What is unavailable.
* Why, when appropriate.
* What the user can still do.

#### Loading state

Use structure-matching skeletons rather than generic full-screen spinners for page content.

#### Recoverable error

Must include:

* Plain-language problem.
* Retry action.
* Preserved user input.

#### Offline state

Must distinguish between:

* Local actions that still work.
* Cloud actions waiting to synchronize.
* Search or pricing actions requiring a connection.

### Completion criteria

* [ ] Every primary page has a documented empty state.
* [ ] Empty states do not repeat zero values in multiple panels.
* [ ] Every empty state has no more than one visually dominant action.
* [ ] Loading skeletons resemble the final layout.
* [ ] Search terms and form values survive recoverable errors.
* [ ] Retry actions do not create duplicate submissions.
* [ ] Offline-created holdings are clearly queued for synchronization when appropriate.
* [ ] Missing pricing does not prevent adding a holding.
* [ ] Missing forecasting does not hide current value information.
* [ ] Partial data is labeled rather than silently omitted.
* [ ] Error messages avoid provider and database terminology.
* [ ] Error states include support or diagnostic references only in expandable details.
* [ ] Screen readers are notified when loading, success, or error status changes.
* [ ] No page shows an endless loading state without timeout and recovery behavior.

---

## 10.13 Responsive and Mobile Experience

**Priority:** P0

### Objective

Ensure that the product remains functional, premium, and understandable across mobile, tablet, desktop, and large desktop layouts.

### Recommended layout ranges

* Mobile: 0–767 px.
* Tablet: 768–1023 px.
* Desktop: 1024–1439 px.
* Large desktop: 1440 px and above.

Exact breakpoints may be adjusted based on component behavior.

### Mobile requirements

* Bottom navigation.
* Camera-first Add flow.
* Sticky primary actions where appropriate.
* Two-column card gallery when readable.
* Single-column data sections.
* Bottom-sheet inspectors.
* Charts with simplified labels and horizontal interaction.
* No desktop-style dense tables.
* Safe-area support.
* Inputs compatible with mobile keyboards and camera permissions.

### Completion criteria

* [ ] No required workflow depends on hover.
* [ ] Every action available on desktop has a mobile equivalent.
* [ ] Mobile navigation remains visible without obscuring content.
* [ ] Card detail actions are reachable without scrolling through the entire page.
* [ ] Search filters open in a mobile-appropriate sheet.
* [ ] Tables convert to cards, stacked rows, or controlled horizontal layouts.
* [ ] Charts remain readable at 390 px width.
* [ ] Card imagery remains large enough to identify the item.
* [ ] Modals do not exceed the mobile viewport.
* [ ] Inputs remain visible when the on-screen keyboard opens.
* [ ] Camera and upload flows work from supported mobile browsers.
* [ ] Touch targets meet the project minimum target size.
* [ ] Safe-area insets are respected on devices with display cutouts.
* [ ] Landscape mobile orientation does not make primary actions inaccessible.
* [ ] The application is tested at representative phone, tablet, laptop, and desktop sizes.

---

## 10.14 Accessibility

**Priority:** P0

### Objective

Ensure that the redesigned application can be operated and understood through keyboard, screen reader, reduced motion, high zoom, and non-color-dependent states.

### Requirements

* Keyboard navigation.
* Visible focus.
* Logical heading order.
* Descriptive image alternatives.
* Form labels.
* Status announcements.
* Chart summaries.
* Reduced-motion support.
* Sufficient contrast.
* Non-color status indicators.
* Accessible dialogs and sheets.
* Minimum usable touch targets.
* Zoom support.

### Completion criteria

* [ ] Every interactive element is keyboard accessible.
* [ ] Focus is always visibly identifiable.
* [ ] Modal, menu, and inspector focus is managed correctly.
* [ ] Card images have meaningful alternative text.
* [ ] Decorative visual effects are hidden from assistive technology.
* [ ] Chart data includes a textual summary or table representation.
* [ ] Positive, negative, warning, and forecast states use icons, labels, or patterns in addition to color.
* [ ] Reduced-motion mode disables nonessential transforms and animated chart drawing.
* [ ] Page hierarchy uses valid heading order.
* [ ] Inputs have programmatically associated labels.
* [ ] Error messages identify the relevant input.
* [ ] The interface remains usable at 200% zoom.
* [ ] No critical information is revealed only on hover.
* [ ] Automated accessibility testing is part of continuous integration.
* [ ] Manual keyboard and screen-reader checks are completed for all P0 workflows.

---

## 10.15 Motion and Signature Interactions

**Priority:** P1, except basic transitions required for P0 usability

### Objective

Create a distinctive experience through purposeful movement without compromising speed or accessibility.

### Signature interaction: Card Capture

Recommended sequence:

1. Card edges are detected.
2. The identified card visually separates from the source image.
3. Metadata resolves beside the card.
4. Pricing and data status appear.
5. The card moves into the review queue or portfolio.

### Signature visual: Forecast Ribbon

The Forecast Ribbon should be consistently used in:

* Portfolio forecasts.
* Individual card forecasts.
* Watchlist outlooks.
* Forecast track record.

### Card Aura

A restrained artwork-derived ambient treatment may be used on:

* Card detail hero.
* Scan confirmation.
* Major collection milestone.
* Selected showcase card.

It should not appear around every card result.

### Completion criteria

* [ ] Motion communicates navigation or state change.
* [ ] Ordinary interactions remain fast and do not wait on decorative animation.
* [ ] Search results visually connect to the inspector or detail page when supported.
* [ ] Added cards visibly confirm their destination.
* [ ] The Forecast Ribbon uses the same visual language across the product.
* [ ] Card Aura is limited to documented contexts.
* [ ] Reduced-motion mode replaces transformations with immediate or subtle state changes.
* [ ] Animation does not block input.
* [ ] Animations do not cause layout shift.
* [ ] Motion is tested on lower-powered mobile devices.
* [ ] The product remains fully understandable with motion disabled.

---

## 10.16 Terminology and Content Design

**Priority:** P0

### Objective

Replace system-oriented wording with collector-oriented wording and standardize labels across the application.

### Required content rules

* Use “card” when the item is known to be a card.
* Use “collectible” for generic or cross-category contexts.
* Use “market value” for observed current pricing.
* Use “manual value” when entered by the user.
* Use “forecast” only for future-looking model output.
* Use “pricing pending” when identity is known but pricing is not ready.
* Use “exact variant” rather than “canonical entity.”
* Use “data details” rather than “provider metadata.”
* Use “market alerts” rather than “signals.”

### Completion criteria

* [ ] A shared terminology glossary is created.
* [ ] The same value type uses the same label on every page.
* [ ] No ordinary user-facing screen contains “canonical,” “Tier 0,” “public key,” or “provider price.”
* [ ] Forecast language includes horizon and uncertainty.
* [ ] Empty-state copy is concise and action-oriented.
* [ ] Button labels describe the resulting action.
* [ ] Generic labels such as Details are avoided when the entire container is already clickable.
* [ ] Long technical explanations are moved to progressive disclosure.
* [ ] Content is reviewed across empty, loading, partial-data, and error states.
* [ ] Mobile labels do not truncate critical identity information.

---

## 10.17 Onboarding and First-Run Experience

**Priority:** P1

### Objective

Help a new user create their first useful portfolio without requiring an account or lengthy setup.

### Recommended flow

1. Explain the core value in one screen.
2. Confirm local or cloud preference.
3. Select currency.
4. Add first collectible.
5. Show initial portfolio value or pricing status.
6. Introduce watchlist and forecasts only after the first item is added.

### Completion criteria

* [ ] Account creation is not required before adding a local holding.
* [ ] The user understands that local data belongs to the device.
* [ ] Currency is set before displaying portfolio totals.
* [ ] The first Add action is available immediately.
* [ ] Onboarding can be skipped.
* [ ] Skipped onboarding does not leave required settings unresolved.
* [ ] The first holding produces a meaningful Overview state.
* [ ] Forecasting is not promised for unsupported items.
* [ ] Users can reopen onboarding guidance or help later.
* [ ] Onboarding progress is not lost after refresh.

---

## 10.18 Alerts and Notifications

**Priority:** P1

### Objective

Provide useful, manageable notifications for price movement, forecast changes, target prices, data corrections, and synchronization issues.

### Alert types

* Target price reached.
* Price increased or decreased by a chosen threshold.
* New verified market price.
* Forecast range changed.
* Forecast matured.
* Exact card mapping completed.
* Watchlist opportunity changed.
* Synchronization failed.
* Import completed.
* Data needs review.

### Completion criteria

* [ ] Users can create an alert from Watchlist and Card Detail.
* [ ] Alert conditions are visible and editable.
* [ ] Alerts identify the exact card variant.
* [ ] Duplicate alerts are prevented or intentionally grouped.
* [ ] Notifications link to the relevant card or action.
* [ ] Users can mute individual alerts.
* [ ] Users can configure notification channels when available.
* [ ] Forecast alerts disclose that they are model-based.
* [ ] A notification is not sent for a change below the configured threshold.
* [ ] Synchronization and system errors are visually distinct from market alerts.
* [ ] Notification history is accessible.
* [ ] Read and unread states do not rely only on color.

---

# 11. Required Data Contracts

The redesign depends on consistent data states. Engineering should provide normalized interfaces even when underlying providers differ.

## 11.1 Search result contract

Recommended fields:

```text
id
canonicalId
sourceId
category
name
setName
setCode
cardNumber
variant
language
rarity
year
imageUrl
matchBucket
pricingStatus
currentMarketValue
currency
change7d
change30d
priceUpdatedAt
forecastStatus
```

`matchBucket` should return:

* exact
* likely
* possible
* unmatched

Raw numerical confidence may remain available for operator tools but should not be required by customer-facing components.

## 11.2 Holding contract

Recommended fields:

```text
holdingId
canonicalId
portfolioId
quantity
condition
grade
gradingCompany
purchasePrice
fees
purchaseDate
seller
storageLocation
notes
manualValue
manualValueDate
valueSource
createdAt
updatedAt
syncStatus
```

## 11.3 Forecast contract

Recommended fields:

```text
forecastId
canonicalId
holdingId
horizon
asOfDate
maturityDate
lowerBound
expectedValue
upperBound
currency
confidenceLabel
confidenceReason
coverageStatus
drivers
risks
modelVersion
forecastStatus
createdAt
maturedAt
actualValueAtMaturity
absoluteError
directionResult
```

## 11.4 Pricing state values

Recommended normalized values:

* verified.
* delayed.
* manual.
* pending.
* unsupported.
* unavailable.
* error.

## Completion criteria

* [ ] UI components consume normalized data states rather than provider-specific strings.
* [ ] Missing optional values do not cause page errors.
* [ ] Every displayed price has a source type.
* [ ] Every displayed forecast has an as-of date and horizon.
* [ ] Every card displayed as exact has a canonical or explicitly verified identity.
* [ ] Manual values cannot be mistaken for verified market values.
* [ ] Forecast records are versioned and not silently overwritten.
* [ ] Sync state is available for local and cloud records.
* [ ] Data contracts are documented and covered by schema or type validation.
* [ ] Representative fixtures exist for full, partial, unavailable, error, and offline states.

---

# 12. Analytics and Product Measurement

**Release 0.7.0 disposition:** ship only the documented, optional, privacy-scoped
private demand-event contract. The broader taxonomy below remains a future measurement
plan and is not a release gate for 0.7.0. No uploaded image, private note, seller,
storage location, or general navigation funnel is transmitted by this release.
This scope reduction preserves useful product behavior without inventing general
telemetry before a separately reviewed privacy and environment-separation plan exists.

## 12.1 Required events

Recommended event taxonomy:

```text
overview_viewed
portfolio_time_range_changed
search_submitted
search_filter_applied
search_result_selected
card_inspector_opened
card_detail_viewed
add_flow_started
image_uploaded
scan_completed
match_corrected
holding_added
bulk_holdings_added
holding_edited
watch_added
watch_removed
target_price_created
forecast_viewed
forecast_horizon_changed
forecast_explanation_opened
alert_created
cloud_sync_enabled
export_completed
import_completed
error_displayed
```

## 12.2 Privacy requirements

* Do not store uploaded card images for analytics without explicit permission.
* Do not expose individual watch activity publicly.
* Aggregate analytics should follow the configured privacy threshold.
* Guest activity should not be merged into an account without clear user action.
* Sensitive notes, seller information, and storage location must not enter product analytics.

### Completion criteria

* [ ] Event names and payloads are documented.
* [ ] Events do not include private notes or unapproved image data.
* [ ] Events distinguish local guest and authenticated sessions without exposing unnecessary identity.
* [ ] Funnel reporting can measure search-to-add and scan-to-add completion.
* [ ] Duplicate submissions do not create duplicate completion events.
* [ ] Analytics failures do not block user workflows.
* [ ] Privacy settings are respected before events are transmitted.
* [ ] Development and production analytics environments are separated.

---

# 13. Product Success Metrics

Initial targets should be validated against current baselines.

## 13.1 Task completion

* At least 90% of usability-test participants can identify current portfolio value within five seconds.
* At least 80% can correctly distinguish current value from forecast value.
* At least 85% can add a known card without assistance.
* At least 80% can correct an uncertain match.
* At least 85% can create a watchlist target alert.

## 13.2 Workflow targets

* Median time to add one known card through search: 30 seconds or less.
* Median time to review a correctly identified scanned card: 15 seconds or less.
* Search-to-detail abandonment decreases from the existing baseline.
* Add-flow completion rate improves from the existing baseline.
* Fewer users abandon after encountering a missing-price state.
* Forecast explanation open rate and forecast return usage can be measured.

## 13.3 Quality targets

* No fabricated portfolio or forecast values.
* No customer-facing backend terminology.
* No critical data loss during migration.
* No P0 accessibility failures.
* No P0 responsive layout failures.
* No duplicate holding creation from ordinary retry behavior.

---

# 14. Performance Requirements

These are product targets rather than guarantees tied to a specific framework.

* Primary navigation should respond immediately.
* Existing cached portfolio data should render before slower remote enrichment.
* Search should show an active response state quickly.
* Large lists should use pagination, cursor loading, or virtualization.
* Images should load responsively and avoid downloading unnecessarily large assets.
* Card imagery should use placeholders that preserve layout.
* Forecast charts should not block page interaction.
* Local changes should feel immediate even when cloud synchronization continues in the background.

### Completion criteria

* [ ] Cached portfolio summary renders without waiting for optional remote pricing refresh.
* [ ] Image dimensions are reserved to prevent layout shift.
* [ ] Large result sets remain smooth while scrolling.
* [ ] Search requests can be canceled or superseded by a new query.
* [ ] Duplicate search responses do not overwrite newer results.
* [ ] Background synchronization does not freeze the interface.
* [ ] Route transitions do not require a full-page reload.
* [ ] Performance is tested with at least 1,000 holdings and 1,000 search results through realistic pagination or virtualization.
* [ ] The application remains usable on a mid-range mobile device.
* [ ] Performance regressions are included in release review.

---

# 15. Migration and Backward Compatibility

## Requirements

* Preserve guest portfolios.
* Preserve authenticated portfolios.
* Preserve watchlist entries.
* Preserve purchase prices and fees.
* Preserve manual values.
* Preserve existing IDs where possible.
* Redirect old routes.
* Migrate saved filter or appearance preferences where practical.
* Avoid requiring users to manually re-add existing holdings.

### Completion criteria

* [ ] A copy of representative existing local data loads in the redesigned application.
* [ ] Existing cloud holdings load without duplication.
* [ ] Migration is idempotent.
* [ ] Failed migration does not delete the original data.
* [ ] A backup is created or recoverable before destructive schema conversion.
* [ ] Old card links redirect to the correct detail page.
* [ ] Old portfolio links redirect to the relevant new tab.
* [ ] Local-only users are not forced to sign in during migration.
* [ ] Migration errors provide a recovery path and diagnostic reference.
* [ ] Migration behavior is documented for support and engineering.

---

# 16. Testing Requirements

## 16.1 Required test states

Every major page should be tested with:

* No data.
* One item.
* Multiple items.
* Full pricing.
* Partial pricing.
* Manual values.
* No forecast.
* Limited forecast.
* Full forecast.
* Local-only state.
* Signed-in state.
* Offline state.
* Synchronization error.
* Missing image.
* Long card names.
* Multiple currencies.
* Large collection.
* Large search-result set.

## 16.2 Required test types

* Component testing.
* Route testing.
* Integration testing.
* End-to-end testing.
* Visual regression testing.
* Accessibility testing.
* Responsive testing.
* Migration testing.
* Data-contract validation.
* Error-state testing.

### Completion criteria

* [ ] All P0 workflows have automated end-to-end coverage.
* [ ] Design-system components have visual regression coverage.
* [ ] Search, Add, Watch, Edit, Import, Export, and Sync workflows are tested.
* [ ] Forecast availability states are tested independently.
* [ ] Existing local data is included in migration tests.
* [ ] No unresolved P0 or P1 defects remain at release.
* [ ] Keyboard testing is completed for every primary workflow.
* [ ] Mobile camera and upload workflows receive real-device testing.
* [ ] Error boundaries are intentionally triggered during QA.
* [ ] Analytics events are verified in staging.
* [ ] Release QA includes representative browsers and viewport sizes.

---

# 17. Implementation Phases

## Phase 0: Discovery and Foundation

Deliverables:

* Confirm final information architecture.
* Inventory existing routes and components.
* Inventory current data states.
* Define normalized pricing and forecast contracts.
* Create design tokens.
* Create terminology glossary.
* Establish responsive grid and component library.

**Exit criteria**

* [ ] Page map is approved.
* [ ] Data contracts are documented.
* [ ] Existing data migration plan is approved.
* [ ] Design tokens are implemented.
* [ ] Core component inventory is complete.

---

## Phase 1: Application Shell and Core Visual System

Deliverables:

* Desktop navigation.
* Mobile navigation.
* Global top bar.
* Buttons, inputs, tabs, badges, panels, and dialogs.
* Card image components.
* Loading, error, and empty states.

**Exit criteria**

* [ ] Application shell works on all primary routes.
* [ ] Core components pass accessibility review.
* [ ] No primary page depends on legacy page-specific visual styles.
* [ ] Responsive layout foundation is stable.

---

## Phase 2: Core Vertical Slice

Deliverables:

* Overview.
* Discover.
* Quick Inspector.
* Card Detail.
* Basic Add from search.
* Portfolio Holdings.

This vertical slice should establish the final visual and interaction standard for the rest of the product.

**Exit criteria**

* [ ] User can search for a card.
* [ ] User can inspect the exact variant.
* [ ] User can add it.
* [ ] It appears in the portfolio.
* [ ] Overview updates.
* [ ] Card Detail reflects the holding.
* [ ] All steps work locally without requiring an account.

---

## Phase 3: Intake and Collection Management

Deliverables:

* Image upload.
* Single- and multi-card detection.
* Match review queue.
* Bulk acquisition editor.
* Watchlist.
* Bulk portfolio actions.
* Import and export.

**Exit criteria**

* [ ] Single and multi-card intake use the same entry flow.
* [ ] Bulk review works.
* [ ] Draft recovery works.
* [ ] Watchlist targets and alerts can be created.
* [ ] Portfolio filters and bulk actions are stable.

---

## Phase 4: Forecasting and Insights

Deliverables:

* Performance view.
* Forecast summary.
* Forecast Ribbon.
* Forecast explanations.
* Forecast availability states.
* Alerts.
* Prediction Track Record.

**Exit criteria**

* [ ] Actual and forecast values cannot be confused.
* [ ] Every forecast has horizon, range, confidence, and as-of date.
* [ ] Forecast history is immutable.
* [ ] Unavailable forecasts have useful explanations.
* [ ] Track-record calculations exclude immature forecasts.

---

## Phase 5: Account, Sync, Polish, and Release

Deliverables:

* Account and sync redesign.
* Privacy settings.
* Onboarding.
* Advanced motion.
* Performance optimization.
* Accessibility remediation.
* Migration.
* Release documentation.

**Exit criteria**

* [ ] Existing user data migrates successfully.
* [ ] User-facing settings contain no backend terminology.
* [ ] Performance and accessibility targets pass.
* [ ] Release QA is complete.
* [ ] Rollback plan is documented.

---

# 18. Global Definition of Done

A redesigned section is not complete merely because it visually matches a design file.

Every section must satisfy all applicable criteria below:

## Functional

* [ ] Required actions work using real application data.
* [ ] Empty, partial, loading, error, and offline states work.
* [ ] Browser navigation behaves correctly.
* [ ] User input is not lost during recoverable failures.

## Visual

* [ ] Uses shared design-system tokens.
* [ ] Matches approved hierarchy and spacing.
* [ ] Card imagery is rendered correctly.
* [ ] No unapproved technical terminology appears.
* [ ] No placeholder values are presented as real data.

## Responsive

* [ ] Tested on mobile, tablet, desktop, and wide desktop.
* [ ] Does not depend on hover.
* [ ] Does not overflow or hide critical actions.
* [ ] Mobile navigation and safe areas are respected.

## Accessibility

* [ ] Keyboard accessible.
* [ ] Screen-reader labels are present.
* [ ] Focus management is correct.
* [ ] Status does not rely only on color.
* [ ] Reduced motion is supported.

## Data integrity

* [ ] Values display their correct source type.
* [ ] Exact identities are not inferred beyond available confidence.
* [ ] Forecast data includes required metadata.
* [ ] Retry behavior does not duplicate records.

## Quality assurance

* [ ] Automated tests pass.
* [ ] Visual regression is approved.
* [ ] Analytics events are verified.
* [ ] No unresolved P0 or P1 defect remains.
* [ ] Product and design acceptance has been completed.

---

# 19. Open Product Decisions

The following decisions should be finalized before engineering reaches the affected phase.

1. Whether Watchlist remains a Portfolio tab or receives a dedicated primary destination.

   * **Recommendation:** Keep it inside Portfolio.

2. Whether Add opens as a route, modal, or hybrid.

   * **Recommendation:** Hybrid—modal or workspace with a persistent route.

3. Whether users may maintain multiple portfolios in the initial redesign.

   * **Recommendation:** Support the selector architecture immediately, even if only one portfolio is initially available.

4. Minimum forecast confidence required before a forecast can appear.

   * **Recommendation:** Establish a product policy rather than allowing each provider or page to decide.

5. Minimum matured sample size before displaying model accuracy.

   * **Recommendation:** Do not display percentages until the sample threshold is statistically and product-appropriate.

6. Whether modeled fair value is required for the first forecasting release.

   * **Recommendation:** Do not introduce it unless users can clearly distinguish it from current price and future forecast.

7. Whether Sold items retain historical performance attribution.

   * **Recommendation:** Yes, but implement after core holdings are stable.

8. Whether custom items can receive manual forecasts.

   * **Recommendation:** No. Allow manual current values, but reserve forecasts for supported data-backed identities.

9. Whether card-derived Card Aura styling is generated automatically.

   * **Recommendation:** Treat as P1 polish and ensure a neutral fallback.

---

# 20. Final Release Acceptance

The redesign is ready for production when:

* Users can search, inspect, add, edit, watch, and track an exact collectible.
* Existing local and cloud portfolios remain intact.
* The Overview communicates value, movement, outlook, and attention items in the first viewport.
* Search results are denser and preserve exact identity.
* The Add workflow automatically handles one or multiple items.
* Unsupported pricing and forecasting states remain useful.
* Current values and forecast values cannot reasonably be mistaken for one another.
* Card artwork is visually prominent across Discover, Portfolio, and Card Detail.
* User-facing pages contain no database or operator terminology.
* Desktop and mobile workflows reach feature parity.
* Accessibility, migration, performance, and end-to-end checks pass.
* Forecast history is traceable and not silently rewritten.
* The product maintains a consistent, recognizable visual system rather than a collection of disconnected dashboard panels.

**Recommended next step:** finalize the information architecture and normalized pricing/forecast data contracts, then build Overview, Discover, Card Detail, and the basic Add workflow as the first end-to-end redesign slice.
