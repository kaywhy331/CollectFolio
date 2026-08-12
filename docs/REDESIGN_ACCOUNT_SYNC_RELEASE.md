# Redesign Account, Sync, Polish, and Release

Acceptance date: August 11, 2026

Promotion date: August 12, 2026

Status: Safe base release deployed after repository, immutable-candidate, and live qualification
Governing requirements: `PRD/redesign.md` Phase 5 and sections 10.11, 10.16,
10.17, 18, and 20

## Review boundary

This tranche completes the collector-facing redesign with persistent onboarding,
Settings, synchronization recovery, privacy and portability controls, accessibility
remediation, and release discipline. It preserves IndexedDB version 4 and the
existing local-first rule: an account is optional, local records remain usable while
offline, and a failed cloud operation never removes the local portfolio.

The subsequent 0.8.0 scenario release additively upgrades IndexedDB to version 5.
It adds only the local value-observation ledger and indexes; all Phase 5 stores and
the representative version-4 migration fixture remain intact. The account, sync,
cloud-removal, and public-publication boundaries documented here are unchanged.

The checked-in `0015_remove_my_cloud_data.sql` migration is a separately reviewed
hosted operation. It was not applied, and the client keeps its control disabled with
`ENABLE_CLOUD_DATA_REMOVAL=false`. Immutable candidate
`6a7bf73c1c0748c0e87115bf` passed all 15 hosted Chromium scenarios, was published
unchanged to `https://collectfolio-staging.netlify.app`, and passed the same 15
scenarios again on the live alias. No database mutation or public-intelligence
enablement is part of this base-release qualification.

## Completed tranche

- Replaced the former Profile surface with a responsive Settings workspace covering
  account state, preferences, privacy, storage, portability, synchronization history,
  and destructive data controls.
- Added textual local, waiting, synchronizing, synchronized, offline, and error states,
  with bounded history and a diagnostic reference for recovery.
- Added a persistent three-step first-run flow for storage preference, display
  currency, and the first Add action. Existing collectors bypass it safely.
- Applied saved condition and language defaults to manual and scan-based acquisitions.
- Made backup import validate every store and record before opening one atomic
  multi-store write transaction.
- Added typed confirmations that distinguish clearing this device from removing
  signed-in cloud data.
- Added online/offline recovery, stale-search generation protection, modal focus
  containment, application inert state, storage estimates, reduced-motion handling,
  and bounded rendering for large portfolios.
- Standardized ordinary page copy around collector-facing terms and added a static
  terminology gate.

## Settings and synchronization contract

Settings derives account state from real session, connectivity, pending-write, sync,
and error state. Text accompanies every visual status:

- **Saved locally** means there is no active cloud session.
- **Waiting to synchronize** means a signed-in device has dirty rows or has not
  completed its first synchronization.
- **Synchronizing now** means a sync request is active.
- **Synchronized** requires a session, no pending changes, and a recorded successful
  synchronization.
- **Offline** keeps local records available and disables cloud actions until the
  browser reconnects.
- **Synchronization needs attention** retains local data, supplies a retry action,
  and records a timestamp-derived diagnostic reference.

Pending counts include dirty holdings, holding tombstones, Watchlist rows, Watchlist
tombstones, and queued private market events. Successful and failed attempts are
newest-first and bounded to 12 local entries. Reconnection automatically retries a
signed-in pending or failed synchronization without blocking local use.

Preferences persist individually in the existing `settings` object store. Currency,
appearance, default condition, default language, default forecast horizon, preferred
market source, private-market participation, personalization, and synchronization
notices are normalized against explicit allowed values. Display-currency changes do
not rewrite the source currency stored with a holding or publication.

## Onboarding contract

New empty installations enter three durable steps:

1. choose storage on this device or optional cloud backup;
2. choose the display currency;
3. open the existing Add workflow for the first collectible.

Every transition is persisted before the next screen is rendered. Refresh resumes
the current step. Setup may be skipped with complete recommended defaults, and it can
be reopened from Settings. Account creation is never required to add locally. When a
build has no cloud configuration, the connect action is disabled and explains that
the collector can continue on the device.

The first successful manual or scan-based holding completes onboarding. A collector
who already had holdings before the settings schema marker was introduced is marked
complete by an idempotent record migration and is not forced through first-run setup.

## Data portability and deletion contract

Portable JSON remains `collectfolio-backup` version 2, with version 1 accepted. Before
any import write, the client rejects unknown stores, private activity records,
non-array sections, malformed store-specific records, invalid primary keys, duplicate
keys, and oversized sections. A
valid plan is merged through one IndexedDB transaction spanning every included store;
an error aborts the whole merge. CSV remains a holdings-oriented portable export.

Cloud collection reads use stable-key 500-row pages with exact counts rather than
depending on a deployment's default row cap. Writes are split into 20-row requests,
remote deletes are concurrency-bounded, and collections above 100,000 records fail
closed with local data unchanged.

**Clear this device** requires typing `CLEAR`. It removes local application stores,
provider metadata caches, provider-image caches, and application-shell CacheStorage
buckets. It does not issue cloud tombstones or change cloud records. A backup is the
only supported way to restore data after that local clear.

**Remove cloud data** is fail closed unless `ENABLE_CLOUD_DATA_REMOVAL=true`, then
requires an online signed-in session and typing `REMOVE`. The flag must remain off
until migration 0015 has independently restorable recovery proof plus rollback and
two-user isolation qualification. Once qualified, the client calls one authenticated
RPC, then signs out while retaining all local records.
Migration `0015` scopes every delete to `auth.uid()`, removes the collector's holdings,
tombstones, snapshots, scan rows, Watchlist rows, private market events, and private
artwork-pairwise votes, opts the retained profile out of future private-market
participation, and retains the Auth account and profile. PostgreSQL executes the RPC
call atomically. The vote ledger remains append-only outside this owner-scoped erasure
RPC.

## Migration and compatibility

- The accepted 0.7.0 base used database version 4. Release 0.8.0 opens version 5,
  adds `localValueObservations` plus `subjectId`/`observedAt` indexes, and replaces
  no existing object store or index.
- The settings schema is a normalized set of records inside the existing store, not
  an IndexedDB upgrade. Re-running migration produces no further writes.
- Existing holdings, snapshots, scans, Watchlist records, alerts, intelligence cache,
  tombstones, and version-1/version-2 backups remain readable. Upgrade and legacy
  backup import create only one current anchor per valued holding; they do not
  manufacture price history.
- Newly saved settings and synchronization history are ignored safely by older
  clients that do not recognize their keys.
- Migration `0015` only installs the account-scoped removal RPC. Installing it does
  not delete records; deletion occurs only after an authenticated collector confirms
  the action in the client.
- Public pricing and forecast gates, source-rights policy, and operator review
  boundaries remain unchanged.

## Performance, motion, and accessibility acceptance

- Portfolio rendering is bounded to 100 holdings per page; a 1,000-holding unit
  fixture proves the first render does not create the full list.
- Search generations prevent a stale, slower request from replacing newer results.
- Settings is checked at 390, 768, and 1440 px without horizontal document overflow.
- Onboarding, settings, and status transitions remain understandable with reduced
  motion enabled; animation is never required to reveal state.
- Modal dialogs trap focus, make the application inert, close with Escape, and return
  focus to the invoking control.
- Hidden file inputs have programmatic labels. Synchronization and destructive states
  are represented by text, not color alone.
- Serious and critical WCAG 2.0/2.1 A/AA axe findings are blocked in the Phase 5
  browser acceptance paths.

## Release procedure

1. Keep `ENABLE_PRICE_INTELLIGENCE=false` unless its independent rights, evidence,
   review, database, and runtime gates have all been approved.
2. Run `npm run check`, `npm run test:browser`, and `git diff --check` from a clean
   qualification environment.
3. Confirm `package.json`, the build default, runtime display, and the release
   environment all identify the intended release (`0.8.0` for local scenarios).
4. Confirm `collectfolio-shell-v0.8.0` precaches `core/settings.js`,
   `core/local-scenarios.js`, and `views/onboarding.js`, then verify an installed
   PWA replaces the prior shell.
5. Review `0015_remove_my_cloud_data.sql` separately. Before applying it, capture an
   independently restorable hosted backup, rehearse installation and RPC revocation
   in a rollback transaction, and obtain explicit hosted-change approval.
6. On an immutable candidate deploy, qualify empty first-run, an existing version-4
   portfolio, local import/export, guest Settings, signed-in sync, offline recovery,
   and a deliberately failed sync without enabling public intelligence. Set
   `PLAYWRIGHT_BASE_URL` to the immutable HTTPS deploy URL to run the same 15-scenario
   Chromium suite against that hosted candidate without starting the local server.
   Synthetic cloud fixtures use same-origin reserved test paths so the hosted run
   retains the candidate's production Content Security Policy.
7. If `0015` is approved and applied, use disposable authenticated data to prove
   per-user isolation, retained account/profile, complete target-row removal, and zero
   cross-user deletion before exposing the cloud-removal control as qualified.

## Rollback plan

For a client-only regression, publish the last accepted application logic with a new
service-worker cache name and a forward-compatible database opener. Do not clear
browser storage. Once a browser opens version 5, the unchanged 0.7.0 client cannot
open its version-4 request; retain the additive observation store and roll forward.
Disable the affected hosted route or roll back the static artifact before asking a
collector to retry; local data remains the recovery source of truth.

If migration `0015` has been installed but its RPC must be disabled, revoke execute
from `authenticated` and drop `public.remove_my_cloud_data()` in an approved
transaction. That rollback removes the deletion capability; it does not restore rows
that a collector already chose to remove. Restoring deleted hosted rows requires the
pre-release backup and explicit account-owner authorization. The retained Auth account
and profile are not recreated because the RPC never deletes them.

If synchronization is degraded, leave local use available, stop retry loops by
signing out or disabling the cloud control in the client artifact, retain tombstones,
and do not convert a browser clear into cloud deletion. Public-intelligence rollback
remains independent through its existing runtime/database flags.

## Qualification receipt

`npm run check` passes: the validator covers 128 required files and 42 browser
modules, all 34 Node suites pass, all 194 Python analytics tests pass, and the
production version-0.7.0 build completes. `npm run test:browser` passes all 15
Chromium scenarios locally.

The four Phase 5 scenarios protect persistent onboarding and first Add,
responsive/accessible guest Settings and modal focus, successful synchronization
with offline recovery, and failed-sync recovery details. The consolidated suite also
protects version-4 migration, Phase 2–4 routes and behavior, serious/critical
accessibility checks, and the unchanged core visual baseline. Both the immutable
candidate and the promoted live alias pass the same 15-scenario Chromium suite under
the production Content Security Policy. Runtime version, fail-closed capability flags,
service-worker shell, deep-link fallback, and security headers were rechecked on the
live alias. `git diff --check` passes. The consolidated receipt is recorded in
`docs/REDESIGN_FINAL_ACCEPTANCE.md`.

## Deferred hosted work

Applying migration `0015`, mutating hosted data, verifying a real backup restore,
enabling cloud removal or public intelligence, and real-device or ongoing production
monitoring all require separate authorization. The safe base client is deployed; the
repository does not claim that any independently gated hosted capability was enabled.
