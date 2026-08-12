# Redesign Forecasting and Insights

Date: August 10, 2026

Status: Implemented locally; repository qualification is recorded below
Governing requirements: `PRD/redesign.md` Phase 4 and sections 10.8, 10.18, and 11.3

## Review boundary

This tranche converts Insights from a compatibility forecast panel into a dedicated,
URL-restorable workspace with Performance, Forecasts, Alerts, and Track Record. It
uses only local portfolio records and rights-cleared public intelligence publications.
It does not expose private research tables or enable the public-intelligence feature
flag.

The supported paths are:

`Insights → Performance → recorded portfolio history`

`Insights → Forecasts → horizon → portfolio summary → exact-item explanation → Detail`

`Insights → Alerts → read or mute → exact watched variant or rule editor`

`Insights → Track Record → immutable receipt → approved Tier 5 scorecard`

All four sections have real routes. The default remains
`/insights?view=forecasts`; other views and non-default horizons are restored from the
URL. Browser Back still closes Quick Inspector before leaving Insights.

## Completed tranche

- Added the dedicated Insights renderer and real Performance, Forecasts, Alerts, and
  Track Record routes.
- Added a portfolio forecast summary with current recorded value, covered approved
  current value, likely range, published-confidence span, coverage, as-of boundary,
  and publication date.
- Added five fixed, contract-approved forecast horizons: 7, 30, 90, 180, and 365
  days. A missing horizon produces an explanation and lists available choices.
- Upgraded the Forecast Ribbon with an observed-history line when approved history is
  present, a labeled present boundary, dotted modeled median, nested shaded ranges,
  maturity labels, legends, and a nonvisual summary.
- Added explicit available, limited, and unavailable item states with customer-facing
  reasons and next actions.
- Added confidence explanations, freshness, coverage, drivers, risks, change tracing,
  model details, and source attribution through progressive disclosure.
- Added local notification history with textual unread/read/muted/system/market states,
  exact-item links, rule editing, mark-all-read, and per-notification mute controls.
- Added append-only local public-forecast receipts and a Track Record that displays
  percentages only from complete Tier 5 scorecards.

## Performance contract

Performance is local recorded history, not forecast performance. It uses the existing
version-4 portfolio snapshots and current holding calculations. The screen labels:

- total recorded portfolio value;
- market/catalog-valued holdings;
- explicit manual values;
- cost basis;
- unrealized gain or loss;
- movement across the selected local snapshot range.

Manual and market values remain visibly separated in the source breakdown. Modeled
fair value and future forecasts are never inserted into current value, gain/loss, or
historical snapshots. A first-day portfolio states that no earlier snapshot exists
instead of inventing a return.

## Forecast summary and availability contract

Portfolio forecast aggregation includes one holding record only when all of these are
true:

1. the public-intelligence feature flag is enabled;
2. the holding has an exact canonical variant;
3. it does not use a manual value;
4. an approved Tier 4 or Tier 5 publication exists;
5. the selected horizon has a complete ordered forecast range;
6. the approved observation uses the portfolio currency.

The aggregate multiplies approved current observation and q25/q50/q75 values by the
holding quantity. It never carries an uncovered item forward at a flat value and never
guesses currency conversion. Coverage counts holding records and states how many use
an explicitly limited forecast.

Confidence is not averaged into a new model claim. A single score is shown as
published; multiple covered holdings show the published minimum-to-maximum span, and
partially undisclosed confidence stays disclosed as such. The oldest included as-of
date is the conservative freshness boundary. A publication date is not relabeled as a
training or model-update date.

Unavailable reasons include disabled publication, missing exact mapping, manual value,
missing approved publication, insufficient evidence, unsupported horizon, and currency
mismatch. Approved public reason codes are mapped to collector-facing copy. Unknown
codes are humanized, not used to synthesize a number.

## Forecast Ribbon and explanation contract

The normalized public payload may include approved observation history. Invalid dates,
negative prices, and history above the approved support tier are removed. Up to 180
ordered observations are retained by the view model.

The Ribbon renders:

- a solid observed-history line when approved history exists;
- an explicit present-date marker;
- a dotted modeled median after the present boundary;
- separate 50% and 80% shaded ranges;
- horizon labels and the last maturity point;
- text and a screen-reader summary that identify observed and modeled regions.

When no approved history is published, the chart begins at the approved current
observation and explicitly says that no historical series was supplied. It does not
reconstruct history from trend percentages.

Each available forecast displays its likely and full ranges, horizon, maturity date,
published confidence score or nondisclosure, human explanation, probability of gain
when published, data freshness, coverage, recorded drivers and risks, change receipt,
model version, and attribution. Limited status is accepted only when the approved
payload explicitly publishes it.

## Immutable history and Track Record contract

The latest publication cache remains replaceable and retains its six-hour TTL. In
parallel, every approved public publication loaded during refresh receives a distinct
content-addressed `intelligence-history:v1:` record in the existing
`intelligenceCache` object store. Refresh checks for an existing key before writing, so
the application never overwrites a prior receipt. This needs no IndexedDB version
change.

Track Record combines those local receipts with the current approved publication,
deduplicates exact forecast IDs, links each variant/horizon revision to its previous
receipt, and labels each record as:

- open and excluded from metrics;
- matured but awaiting an approved evaluation;
- matured and evaluated when every evaluation field is present.

The browser does not derive an actual-at-maturity value, absolute error, direction
result, or aggregate accuracy from a current price. It displays those fields only when
the approved payload contains a complete evaluation. Percentages appear only from a
Tier 5 scorecard, whose support tier represents the existing operator-reviewed,
held-out/prospective evidence boundary. Without such a scorecard, the screen explains
that the minimum sample is not met and shows no percentage.

Portable backups remain user-owned and can carry public cache receipts. That does not
turn an imported or locally modified backup into an approved publication; runtime
display still requires the public feature flag and normalization gates.

## Alerts contract

Alert history uses the existing version-4 `alerts` store. It exposes events created by
approved Watchlist-intelligence evaluation and preserves exact `watchKey` and canonical
variant identity. The screen supports All, Unread, and Muted filters, plus:

- mark one notification read or unread;
- mark every unread notification read;
- mute or unmute one recorded notification;
- open the still-watched exact card;
- edit the Watchlist rule that governs future alerts.

Muting a notification does not silently disable its future Watchlist rule. Future rule
changes remain explicit in the existing Target & Alerts editor. Forecast-change events
are labeled model-based and are not described as observed market movement. Read and
mute states use text in addition to visual treatment.

This tranche does not add browser push, email, SMS, or a notification-channel setting.
It does not manufacture synchronization, import, or mapping notifications that the
current client does not record.

## Compatibility and safety

- IndexedDB remains `collectfolio` version 4.
- Existing holdings, snapshots, Watchlist rows, alerts, cache rows, and backups remain
  readable without conversion.
- Existing exact-key Watchlist migration and tombstone behavior is unchanged.
- Public-intelligence data remains empty in application state when the feature flag is
  disabled.
- Support tiers continue stripping every layer above its approved boundary.
- Forecast ranges require ordered q10/q25/q50/q75/q90 values and a fixed horizon.
- Manual values, unknown currencies, missing mappings, and missing observations never
  enter the portfolio forecast aggregate.
- Private prediction, evaluation, and scorecard tables remain service-role-only and
  are not queried by the browser.
- User and provider strings remain escaped; external-capable images keep
  `referrerpolicy="no-referrer"`.
- No public forecast, price source, feature flag, hosted data, or operator approval was
  created or changed by this local UI tranche.

## Responsive and accessibility acceptance

- The four Insights tabs and five horizons remain keyboard-operable and horizontally
  scrollable without page overflow at narrow widths.
- Actual and forecast values use separate labels, border treatments, line styles, and
  legends; color is not the only distinction.
- The present boundary and forecast maturity remain understandable with animation
  disabled.
- The Ribbon includes an SVG title and adjacent screen-reader-only summary.
- Unavailable, limited, unread, read, muted, system, and market states are expressed in
  text.
- Long names, model IDs, exact variant IDs, and source attributions wrap instead of
  widening the page.
- Quick Inspector preserves Insights context and focus on close.

## Verification

Focused coverage protects forecast normalization, manual and currency exclusion,
limited and missing-horizon states, confidence disclosure, immutable history linking,
maturity handling, Tier 5 scorecard gating, alert filters, fail-closed rendering, and
content-addressed receipt deduplication.

Browser acceptance protects the dormant fail-closed state and a fully approved
synthetic Phase 4 path: actual/forecast separation, portfolio range math, historical
Ribbon and present marker, horizon unavailability, alert read/mute persistence,
Track Record gating, route restoration, and serious/critical accessibility checks.

The service-worker shell is `collectfolio-shell-v0.6.0`. Final repository and browser
qualification is recorded in `docs/IMPLEMENTATION_PLAN.md`.

## Deferred capabilities

Public feature enablement, production Tier 4/5 publications, notification delivery
channels, notification bell/history outside Insights, seller workflows, sales and
realized-gain accounting, multiple portfolios, private research inspection, and
account/sync redesign remain deferred. Phase 5 owns account, sync, onboarding, release
polish, and final cross-browser/device qualification.
