# Redesign Intake and Collection Management

Date: August 10, 2026

Status: Implemented locally; final repository qualification is recorded below
Governing requirements: `PRD/redesign.md` Phase 3 and sections 10.5–10.7

## Review boundary

This tranche converts the supported Phase 3 path from image capture through local
collection management. It builds on the accepted redesign foundation and core
vertical slice without changing their route, data-rights, or publication contracts.

The supported path is:

`Add → camera or upload → boundary review → match queue → acquisition editor →
explicit approval → success → Portfolio → Watchlist or bulk tools → import/export`

It does not add Sets, Sold, a sales ledger, multiple portfolios, public forecast
publication, or notification history. Those labels remain absent rather than
implying that unsupported records or evidence exist.

## Completed tranche

- One camera/upload entry opens the same automatic single- or multi-item detector.
- Camera capture and file upload are separate choices inside that entry, so denied
  camera permission always has an explicit upload alternative.
- Editable boundaries, binder grids, local crop generation, OCR/search retry, match
  replacement, crop exclusion, and custom identities remain supported.
- The review queue now distinguishes total, exact, needs-review, and unmatched items.
- Shared acquisition values can be applied to every crop, then refined per item.
- The confirmation boundary shows approved count, total quantity, cost basis,
  pricing coverage, skipped-item behavior, and the local portfolio destination.
- The success state reports added, skipped, and unresolved items before navigation.
- Watchlist now has focused empty/populated states, target distance, alert state,
  observed movement, approved outlook disclosure, evidence-aware sorting, and
  confirmed removal.
- Selected holdings expose Edit, Move, Add tags, Duplicate, Export, and confirmed
  Delete. Actions stay hidden until a holding is selected.
- Add exposes validated JSON import and full portable JSON export; Portfolio keeps
  full/selection CSV export.

## Unified intake and review contract

Capture does not ask the collector to predict whether an image contains one card or
many. The existing detector proposes boundaries and the workbench remains the source
of truth for the resulting crops. A source photo exists only while boundaries are
edited. It is not saved in the draft or uploaded; only local crop images may become
user-owned holding images.

Every crop keeps its previous recovery semantics. Interrupted identification changes
to an explicit retryable error. Old drafts without Phase 3 acquisition fields hydrate
with safe defaults instead of requiring an IndexedDB migration.

Recognition confidence and identity resolution remain separate:

- exact means an explicitly exact provider/canonical identity and match state;
- likely and possible remain review states even if a candidate has been selected;
- custom identity is visibly manual;
- unmatched never silently becomes an exact item;
- selecting or editing a candidate removes prior approval;
- only a selected exact candidate or explicit custom identity can be approved.

## Acquisition and submission contract

Each crop supports quantity, condition, grading company and grade, purchase price,
fees, purchase date, seller/source, storage location, manual current value, and notes.
The shared editor applies filled values to all crops but never changes approval.

The review footer totals only explicitly approved crops. Cost basis uses the existing
holding rule: per-item purchase price multiplied by quantity, plus total fees. Pricing
coverage counts only a permitted catalog value or an explicit manual value.

Submission assigns a stable holding ID to every approved crop before the first write.
The draft is saved in `adding` state, then each holding is written under its stable ID.
If the browser is interrupted, recovery returns the draft to review and a retry
overwrites the same IDs instead of creating duplicate lots. Completion persists a
result receipt and a second submission of a completed draft is a no-op that returns
the original count.

Unapproved and unmatched crops are skipped. This tranche does not weaken the
longstanding explicit-approval requirement.

## Watchlist contract

An empty Watchlist renders one message—“Track cards before you buy”—and one Find a
card action. It does not render zero metrics, empty controls, a separate result
heading, or a second empty state.

Populated entries preserve exact finish/condition identity and show:

- current permitted catalog or approved observed value;
- separate 7-day and 30-day movement when Tier 2 evidence exists;
- target value and distance from the current value;
- a visually separate approved forecast range and confidence when Tier 4 exists;
- alert configuration and unread signal state;
- last observed/update date and an explicit unavailable liquidity state;
- direct Detail, Compare, Add to portfolio, Target/alerts, and Remove actions.

Best Opportunity is deliberately unavailable for ranking unless one entry has all of
an approved observed price, an approved forecast median, probability of gain, and
confidence. Unsupported entries sort after supported entries in that mode and explain
why they were not ranked. This prevents catalog values or missing model evidence from
being presented as investment guidance.

Removing any watched item requires confirmation. The compatibility path also repairs
legacy v4 rows whose IndexedDB primary key differs from `watchKey`: edit migrates the
row to the exact watch key in one transaction, while remove deletes the legacy key and
writes the tombstone under the exact watch key used by optional sync.

## Collection management and portability

Holding tags and seller/source are optional backward-compatible record fields; no
object-store or database-version change is required. Tags participate in holding
search and filters. The selection toolbar supports:

- Edit for one selected lot;
- Move to a storage location for one or many lots;
- Add comma-separated tags without removing existing tags;
- Duplicate as separate acquisition lots with new IDs;
- export only the selected lots to CSV;
- confirmed deletion with existing sync tombstones.

Mark Sold remains absent because no sale-proceeds, fees, date, buyer, realized-gain,
or reversal ledger exists. Sets and multi-portfolio moves likewise remain absent.

Portable backups remain `collectfolio-backup` version 2, version 1 remains importable,
and the private demand-event outbox remains excluded. CSV now includes seller/source
and tags without exporting disallowed provider history or forecast data.

## Compatibility and safety

- IndexedDB remains `collectfolio` version 4.
- Existing holdings, snapshots, scans, Watchlist entries, alerts, tombstones, and
  settings hydrate without destructive conversion.
- Optional new holding fields travel inside the existing cloud JSON payload.
- Full source photos never enter IndexedDB, Supabase, Netlify, or analytics.
- Provider failures and OCR failures remain isolated and retryable.
- User strings remain escaped and external-capable images keep
  `referrerpolicy="no-referrer"`.
- Source-rights tiers, approved-publication normalization, feature flags, and
  forecast fail-closed behavior are unchanged.
- Public price intelligence remains disabled unless the existing independent rights,
  mapping, evaluation, review, and runtime gates all pass.

## Responsive and accessibility acceptance

- Capture choices, queue summary, per-crop editors, and confirmation controls reflow
  from 320 px through desktop without horizontal page overflow.
- Mobile confirmation stays above the bottom navigation safe area.
- Desktop review uses a wider match workspace while preserving DOM and keyboard order.
- Review and Watchlist status are expressed in text, not color alone.
- Every crop, target, alert, and destructive action has a programmatic label.
- Modal focus behavior, visible focus rings, reduced motion, and existing shell
  keyboard behavior remain in force.

## Verification

Focused unit coverage protects queue classification, acquisition normalization and
totals, apply-to-all without approval, completion receipts, focused Watchlist empty
state, evidence-complete opportunity ranking, current/forecast separation, tags, and
selection-only bulk controls.

Browser acceptance protects camera-denial fallback, version-4 draft recovery, the
approved-only add and success path, tag/duplicate behavior, Watchlist preference
migration, confirmed removal, existing route/focus behavior, accessibility, and the
unchanged core-slice visual baseline.

The service-worker shell is `collectfolio-shell-v0.5.0`. `npm run check` validates
112 required files and 38 browser modules, passes 183 Node tests and 194 Python
analytics tests, and completes the production build. `npm run test:browser` passes
all 8 Chromium tests, including serious/critical accessibility checks on review and
populated Watchlist plus the unchanged core-slice visual baseline. The consolidated
receipt is recorded in `docs/IMPLEMENTATION_PLAN.md`.

## Deferred capabilities

Sets, Sold and realized-gain accounting, multi-portfolio switching, public Insights,
notification history, command palette, front/back image switching when no back image
exists, related-variant browsing, and verified sales remain deferred until their data
and acceptance boundaries are implemented.
