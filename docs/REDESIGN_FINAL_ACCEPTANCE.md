# Redesign Final Acceptance

Acceptance date: August 11, 2026

Promotion date: August 12, 2026

Status: Repository-qualified candidate, immutable hosted candidate, and safe base release deployed

Governing requirements: `PRD/redesign.md` sections 18, 19, and 20
Release target: application `0.7.0`, service-worker shell
`collectfolio-shell-v0.7.0`

## Acceptance boundary

This receipt closes the repository, immutable-hosted-candidate, and safe-base-release
boundaries for the redesign. It consolidates the Phase 2–5 evidence, resolves the open
product decisions for this release, and records the release owner's authorization to promote the safe
base client. Immutable Netlify candidate
`6a7bf73c1c0748c0e87115bf` passed the same 15-scenario Chromium suite used locally
under the production Content Security Policy, was published unchanged to
`https://collectfolio-staging.netlify.app`, and passed that suite again on the live
alias. No hosted database was changed and no disabled capability is represented as
qualified.

Public price intelligence remains fail closed unless its separate rights, Tier 4+
publication, evidence, database, runtime, and human-review gates all pass. That
disabled state is a supported product state and does not block the local-first base
release. Migration `0015_remove_my_cloud_data.sql` remains checked in and unapplied.

## Global Definition of Done evidence

| Area | Repository evidence | Disposition |
| --- | --- | --- |
| Functional | Node coverage exercises real IndexedDB records, routing, search, Add, scan recovery, holdings, Watchlist, Insights, onboarding, Settings, synchronization recovery, and atomic backup restore. Chromium covers empty, signed-in, offline, and failed-sync paths. | Pass locally and on the immutable hosted candidate. |
| Visual | `app/assets/css/app.css` provides shared semantic tokens across dark, light, and system themes. The validator blocks technical terminology, placeholders, missing tokens, and literal account-status colors. The Overview baseline protects the accepted structure. | Automated baseline passes locally and hosted. The release owner authorized promotion without separate image inspection; manual imagery review remains a non-blocking follow-up. |
| Responsive | `tests/e2e/protection-baseline.spec.js` covers 390, 768, 1024, 1440, and 1920 px shell behavior. Phase 5 additionally checks Settings at 390, 768, and 1440 px for overflow and critical-action visibility. | Pass locally and on the immutable hosted candidate. Real-device review remains a non-blocking follow-up. |
| Accessibility | Keyboard routing, dialog focus containment and return, inert background state, programmatic labels, textual status, safe-area navigation, and reduced-motion behavior are protected. Axe blocks serious and critical WCAG 2.0/2.1 A/AA findings in acceptance paths. | Automated pass locally and hosted. Manual assistive-technology review remains a non-blocking follow-up. |
| Data integrity | Exact-variant identity, source-typed values, forecast metadata and publication gates, immutable forecast history, idempotent Add/sync behavior, version-4 compatibility, and atomic backup preflight have dedicated tests. | Base client passes. Hosted destructive migration 0015 remains unapplied and its UI capability is explicitly disabled. |
| Quality assurance | `npm run check`, the 15-scenario Chromium suite, and `git diff --check` form the repository gate. The optional, privacy-scoped demand-event contract is unit tested and excluded from portable backups; the redesign adds no general product telemetry. | Local and immutable-hosted gates pass. PRD section 12 records the 0.7.0 analytics scope disposition, and no known P0/P1 defect remains. |

The automated screenshot is a regression guard, not a substitute for human visual
review. Under the requested no-image-inspection constraint, the release owner accepted
that guard plus hosted responsive and accessibility evidence for this promotion. No
known P0 or P1 defect remains in the qualified paths.

## August 11 audit remediation

The repository audit separated the local Watchlist gate from fail-closed public price
intelligence; preserved explicit currencies through holdings, snapshots, exports,
Watchlist targets, and scan intake; and excluded unlike currencies from totals and
alerts instead of guessing an exchange rate. It also added clean-device shared-card
hydration, complete application-cache clearing, bounded cloud requests, CSV formula
neutralization, and the account-owned artwork-vote erasure path in migration 0015.

The final pass made runtime configuration network-first with an offline fallback,
bounded the provider-image cache to 160 entries, and prevented publication currency
corrections from producing mixed-currency percentage alerts. Invalid imported currency
codes now render an explicit unavailable state rather than crashing or masquerading as
USD. Currency-qualified snapshot IDs retain parallel same-day histories while old
daily IDs remain readable and deduplicated. Image and backup selections are bounded
before browser allocation at 25 MiB and 128 MiB respectively. `@netlify/blobs` is
pinned to the production-audit-clean `9.1.5` release.

The follow-up pass closed the remaining engineering audit findings. Backup preflight
now validates store-specific record shapes before its atomic transaction. Cloud
holdings, snapshots, tombstones, and Watchlist reads are paginated with exact counts;
writes and deletes are bounded. Expired catalog entries and old completed scan receipts
are pruned, completed receipts drop crop images immediately, and the private research
prioritization request has a 20-second client deadline.

PRD section 12 now records the release-owner disposition for 0.7.0: the optional,
privacy-scoped private demand-event contract is the complete release scope. The broad
general-product taxonomy is deferred to a separately reviewed measurement plan. No
general telemetry was added during remediation.

## Open product decision dispositions

1. **Watchlist stays inside Portfolio.** Holdings and Watchlist remain sibling tabs;
   Watchlist does not consume another primary-navigation destination.
2. **Add remains hybrid.** `/add` is the durable, reloadable workspace route, while
   focused review and confirmation interactions may use a modal or responsive sheet.
3. **Single portfolio only.** This release does not show a fake selector. Selector
   architecture returns only when a real multi-portfolio data and ownership model is
   approved.
4. **Forecast display uses governed evidence, not a client cutoff.** A forecast needs
   an approved Tier 4+ publication with explicit confidence and the existing horizon,
   range, and as-of metadata. Individual pages cannot invent a confidence threshold.
5. **Accuracy requires an approved Tier 5 scorecard.** The browser displays only
   reviewed, promotion-eligible matured metrics and never synthesizes its own sample
   eligibility or percentage.
6. **Fair value remains optional and separate.** When approved evidence includes fair
   value, the UI labels it independently from recorded current value and forecast;
   its absence never produces a fabricated substitute.
7. **Sold remains deferred.** Historical sold-item attribution waits for a real sale
   ledger and cost/performance policy rather than overloading holding deletion.
8. **Custom items cannot receive manual forecasts.** Collectors may enter a current
   value for unsupported items, but forecast surfaces require a supported,
   evidence-backed exact identity.
9. **Card Aura remains deferred.** Shared neutral card styling is the release fallback;
   no automatic artwork-derived palette is implied.

These dispositions govern `0.7.0`. Reopening one requires a product decision and an
updated data, accessibility, migration, and test contract where applicable.

## Final release acceptance matrix

| PRD acceptance statement | Evidence and disposition |
| --- | --- |
| Search, inspect, add, edit, watch, and track an exact collectible | Discover, Quick Inspector, detail, holding form, scan review, Portfolio, Watchlist, and Insights unit/browser paths pass with exact-variant fixtures. Repository pass. |
| Existing local and cloud portfolios remain intact | IndexedDB v4 hydration, versioned backups, tombstones, and sync compatibility pass locally; hosted synthetic success/failure qualification passes under the production CSP. Destructive cloud removal remains disabled. |
| Overview communicates value, movement, outlook, and attention in the first viewport | Normalized Overview tests and the Chromium visual baseline protect the first-use and populated hierarchy locally and hosted. Release pass. |
| Search is denser and preserves exact identity | Discover view-model and browser route/filter restoration preserve provider and exact-printing context. Repository pass. |
| Add handles one or multiple items | Manual Add and multi-crop scan review share the approved-only, idempotent acquisition path. Repository pass. |
| Unsupported pricing and forecasting remain useful | Unavailable states retain Add, manual current-value, Watchlist, and identity-tracking actions without fabricated estimates. Repository pass. |
| Current values and forecasts cannot be confused | Actuals, optional fair value, forecast ranges, confidence, horizon, as-of date, and unavailable explanations are separately labeled and tested. Repository pass. |
| Artwork is prominent across Discover, Portfolio, and detail | Shared image components, exact variant labels, fallbacks, and referrer policy are statically and behaviorally protected. Release-owner automated-evidence disposition accepted. |
| User pages contain no database or operator terminology | `scripts/validate.mjs` scans ordinary UI sources for the prohibited vocabulary. Repository pass. |
| Desktop and mobile reach workflow parity | Shell and Settings acceptance spans mobile, tablet, desktop, and wide desktop without hiding primary actions. Local and immutable-hosted pass. |
| Accessibility, migration, performance, and end-to-end checks pass | Axe, keyboard/focus, version-4 migration, 1,000-holding render bounds, stale-search protection, unit suites, and Chromium acceptance pass locally and on the immutable hosted candidate. |
| Forecast history is traceable and never silently rewritten | Immutable publication receipts, horizon-specific history, open/mature eligibility, and Tier 5 scorecard membership are tested. Repository pass. |
| One recognizable visual system is maintained | Shared semantic color, spacing, radius, component, surface, and navigation contracts span every redesign phase. Repository pass; design sign-off pending. |

## Production promotion blockers

The base 0.7.0 client is accepted for promotion. The prior blockers were disposed as
follows without weakening the independent capability gates:

1. **Release-owner acceptance:** promotion was explicitly authorized after the full
   automated hierarchy, responsive, visual-regression, accessibility, and P0/P1 gate;
   separate image inspection and real-device review are non-blocking follow-ups.
2. **Candidate qualification:** immutable candidate `6a7bf73c1c0748c0e87115bf`
   passed all 15 hosted Chromium scenarios, including fresh use, version-4 data,
   breakpoints, keyboard/focus, sync success/failure, offline recovery, deep links,
   accessibility, and service-worker replacement.
3. **Recovery proof:** not claimed. No schema was applied, and
   `ENABLE_CLOUD_DATA_REMOVAL=false` keeps the dependent destructive control disabled.
4. **Hosted deletion boundary:** not claimed. Migration 0015 remains unapplied; its
   rollout still requires independent backup, rollback, RPC, and two-user isolation
   qualification before the capability flag may be enabled.

Public intelligence must remain disabled unless its independent promotion gates pass.
Its enablement is not bundled into these four base-release approvals. Cloud removal
must likewise remain disabled until receipts 3 and 4 are complete.

## Qualification receipt

The local repository gate for this receipt is:

- `npm run check`: 128 required files, 42 browser modules, 34 Node suites, 194 Python
  analytics tests, and the production `0.7.0` build;
- `npm run test:browser`: 15 of 15 Chromium scenarios, including the unchanged core
  visual baseline and serious/critical accessibility gates;
- `PLAYWRIGHT_BASE_URL=https://6a7bf73c1c0748c0e87115bf--collectfolio-staging.netlify.app npm run test:browser`:
  15 of 15 Chromium scenarios under the candidate's production CSP;
- `PLAYWRIGHT_BASE_URL=https://collectfolio-staging.netlify.app npm run test:browser`:
  15 of 15 Chromium scenarios after production promotion;
- immutable candidate runtime: application `0.7.0`, Watchlist enabled, public
  intelligence disabled, and cloud removal disabled; deep links and security headers
  return successfully, with both Netlify functions bundled;
- production alias: immutable deploy `6a7bf73c1c0748c0e87115bf`, published August 12,
  2026 at `12:41:04Z`; runtime config, service-worker shell, deep-link fallback, and
  security headers were rechecked from the live URL;
- `git diff --check`: no whitespace errors.

The immutable draft and its unchanged production promotion are part of this receipt.
No migration application, hosted database mutation, public-intelligence enablement,
cloud-removal enablement, or Git push occurred. The qualified application artifact is
now live on the intended `collectfolio-staging` alias.
