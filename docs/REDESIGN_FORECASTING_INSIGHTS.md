# Redesign Forecasting and Insights

Date: August 10, 2026

Status: Extended for the 0.8.0 local-scenario release
Governing requirements: `PRD/redesign.md` Phase 4 and sections 10.8, 10.18, and 11.3

## Review boundary

This tranche converts Insights from a compatibility forecast panel into a dedicated,
URL-restorable workspace with Performance, Forecasts, Alerts, and Track Record. It
uses only local portfolio records and rights-cleared public intelligence publications.
It does not expose private research tables or enable the public-intelligence feature
flag.

The 0.8.0 extension separates two products. **Local Scenario Outlooks** are always
available from the collector's own saved catalog values or explicitly labeled
estimates. **Published Market Forecasts** retain the existing Tier 4/publication
gates. Track Record remains publication-only because a local scenario cannot claim
measured accuracy.

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
- Added append-only daily local unit-value observations and an immediate broad
  scenario from the first saved value, without reconstructing historical prices.
- Added source-separated per-holding and portfolio scenario ranges, qualitative
  confidence labels, staleness refusal, and concentration/cost-basis insights.
- Added a local-scenario Forecast Ribbon mode while preserving the approved-publication
  default and its existing fail-closed validation.

## Local scenario contract

Local scenarios use only values stored for an owned holding. The latest usable value
anchors each range and is labeled **Your estimate** or with its saved catalog source
and date. `observedAt` records when this device captured the saved value;
`sourceUpdatedAt` separately retains a catalog's declared price date when available,
and that earlier date governs freshness. Manual and catalog observations remain
separate series and never create a cross-source return. A changed same-day value
appends a unique correction that references the active predecessor with `supersedes`;
an unchanged repeat adds no row. Future records are excluded, superseded records are
ignored, and extreme changes are quarantined.

Irregularly spaced log returns feed calendar-time EWMA drift and volatility. Drift
uses a 180-day half-life and is shrunk toward zero by `spanDays / (spanDays + 730)`;
volatility uses a 60-day half-life, blends toward a 2.5% daily prior by `n/(n+10)`,
and is bounded to 1.5–6%. Student-t (df=4) scenario quantiles use fixed q10/q25/q50/
q75/q90 scores. Horizon drift and volatility caps keep early ranges finite and broad.
A saved value older than 180 days produces no projection.

Early, Low, Developing, and Moderate are disclosure labels, not accuracy percentages.
One observation intentionally produces a prior-driven range. Local scenario values
never enter current portfolio totals, actual history, alerts based on approved market
movement, immutable public forecast receipts, or Track Record accuracy.

## Performance contract

Performance is local recorded history, not forecast performance. It uses existing
portfolio snapshots and current holding calculations. The screen labels:

- total recorded portfolio value;
- market/catalog-valued holdings;
- explicit manual values;
- cost basis;
- unrealized gain or loss;
- movement across the selected local snapshot range.

Manual and catalog values remain visibly separated in the source breakdown. Modeled
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

Alert history uses the existing `alerts` store. It exposes events created by
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

- IndexedDB is additively upgraded to `collectfolio` version 5 with a
  `localValueObservations` store and `subjectId`/`observedAt` indexes.
- Existing holdings, snapshots, Watchlist rows, alerts, cache rows, and backups remain
  readable without conversion.
- A v4 upgrade records one current observation for each already-valued holding; it
  never backfills history. Version-1 and version-2 backups remain importable, and
  current exports include the new store.
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

Browser acceptance protects the always-available local scenario path, append-only
same-day corrections, v4-to-v5 migration, the dormant fail-closed publication state,
and a fully approved synthetic Phase 4 path: actual/forecast separation, portfolio
range math, historical Ribbon and present marker, horizon unavailability, alert
read/mute persistence, Track Record gating, route restoration, and serious/critical
accessibility checks.

The service-worker shell is `collectfolio-shell-v0.8.0`. The 0.8.0 release receipt is
recorded below after immutable hosted-candidate and production-alias qualification.

### 0.8.0 release receipt — August 12, 2026

- Application commit `dfeafbf` contains the shipped local-scenario implementation;
  test-harness follow-up `ca31443` makes the v4 migration fixture portable across
  hosts without changing the deployed application artifact.
- `npm run check` passed the 130-file/43-browser-module validator, 248 Node tests,
  194 Python analytics tests, and the production 0.8.0 build.
- `npm audit --omit=dev` reported zero vulnerabilities; `git diff --check` passed.
- All 16 Chromium scenarios passed locally, on immutable Netlify candidate
  `6a7c96d51e890b9fd17baef7`, and again after that exact deploy was promoted to
  `https://collectfolio-staging.netlify.app`.
- The deployed static artifact digest was
  `2674ca413631884746848be69a87d8be17593b457c895296be259d973d30d3a2`.
- Netlify site `05b0e479-ad35-4466-a5c0-fa40d93d1a77` reports that candidate as its
  published deploy. Runtime version 0.8.0, deep-link fallback, production CSP,
  `collectfolio-shell-v0.8.0`, v4-to-v5 migration, append-only correction ledger,
  local scenario UI, and offline reload all passed hosted verification.
- `ENABLE_PRICE_INTELLIGENCE=false` and `ENABLE_CLOUD_DATA_REMOVAL=false` remained
  fail closed. No Supabase migration, hosted data mutation, source approval, public
  forecast publication, or operator-review state was created or changed.

## Deferred capabilities

Public feature enablement, production Tier 4/5 publications, notification delivery
channels, notification bell/history outside Insights, seller workflows, sales and
realized-gain accounting, multiple portfolios, private research inspection, and
account/sync redesign remain deferred. Phase 5 owns account, sync, onboarding, release
polish, and final cross-browser/device qualification.
