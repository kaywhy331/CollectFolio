# Premium UX Human Validation Receipt — Template

Copy this file to a dated receipt. Do not mark a lane complete without linked evidence.
Do not place participant names, contact details, authentication material, real collection
content, raw photos, notes, purchase prices, or search text in this repository.

## Build identity

| Field | Recorded value |
|---|---|
| Receipt status | Draft / accepted / rejected |
| Application version | Pending |
| Commit SHA | Pending |
| URL or installed build | Pending |
| Service-worker shell | Pending |
| Test window and timezone | Pending |
| Protocol revision | `docs/PREMIUM_UX_HUMAN_VALIDATION.md` at pending SHA |
| Study/review owner | Pending |
| Independent reviewer | Pending |

## Scope and disposition

| Evidence lane | Executed? | Disposition | Reviewer | Evidence links |
|---|---|---|---|---|
| Moderated collector study | No | Pending | Pending | Pending |
| Physical-device / installed-PWA review | No | Pending | Pending | Pending |
| Manual screen-reader review | No | Pending | Pending | Pending |
| Consented production field metrics | No | Pending | Pending | Pending |

Overall disposition: **Pending**

This receipt does not change the state of an unexecuted lane.

## Consent and data handling

- [ ] Purpose, activities, collected fields, recordings, retention, withdrawal, and
      compensation were disclosed before evidence collection.
- [ ] Consent records are retained outside this repository under a restricted reference.
- [ ] Participant codes cannot be resolved from this receipt alone.
- [ ] Synthetic accounts, items, images, and values were used, or an approved exception
      is linked.
- [ ] No prohibited payload or personal collection content appears in notes or attachments.
- [ ] Every recording has explicit consent, an access owner, and a deletion date.
- [ ] Protocol deviations and invalid observations remain visible.

Restricted consent reference: Pending

Evidence-retention owner and deletion date: Pending

## Moderated collector study

### Preregistered plan

| Field | Plan |
|---|---|
| Pilot size | Pending |
| Measured cohort target | Pending |
| Recruitment profiles | Pending |
| Inclusion/exclusion rules | Pending |
| Task order/randomization | Pending |
| Stopping rule | Pending |
| Timing and interaction-count rule | Protocol default / approved deviation |
| KPI/uncertainty method, if any | No population claim / pending preregistration |

### Cohort receipt

| Count | Planned | Observed | Excluded/invalid | Reason |
|---|---:|---:|---:|---|
| Pilot sessions | — | — | — | Pending |
| Measured sessions | — | — | — | Pending |
| First-time CollectFolio users | — | — | — | Pending |
| Mixed-category collectors | — | — | — | Pending |
| Frequent photo-intake users | — | — | — | Pending |

### Required-task results

`N` is the eligible denominator after preregistered exclusions. Do not calculate a rate
from blank or insufficient evidence.

| # | Task | N | Unassisted | Assisted | Failed | Invalid | Median time | Median interactions | Finding links |
|---:|---|---:|---:|---:|---:|---:|---:|---:|---|
| 1 | Find an exact known item | — | — | — | — | — | Pending | Pending | Pending |
| 2 | Browse game → set → item | — | — | — | — | — | Pending | Pending | Pending |
| 3 | Distinguish pack, box, and case | — | — | — | — | — | Pending | Pending | Pending |
| 4 | Add a confirmed item | — | — | — | — | — | Pending | Pending | Pending |
| 5 | Resolve an uncertain match | — | — | — | — | — | Pending | Pending | Pending |
| 6 | Scan multiple items | — | — | — | — | — | Pending | Pending | Pending |
| 7 | Identify an unpriced holding | — | — | — | — | — | Pending | Pending | Pending |
| 8 | Add a manual current value | — | — | — | — | — | Pending | Pending | Pending |
| 9 | Find a watched item | — | — | — | — | — | Pending | Pending | Pending |
| 10 | Distinguish scenario and forecast | — | — | — | — | — | Pending | Pending | Pending |
| 11 | Group holdings and inspect purchases | — | — | — | — | — | Pending | Pending | Pending |
| 12 | Return without losing catalog context | — | — | — | — | — | Pending | Pending | Pending |

Sanitized session notes: Pending

Debrief synthesis: Pending

Moderator deviations: Pending

## Physical-device and installed-PWA review

| Device code | Manufacturer/model | OS | Browser/version | Browser or installed | Orientation/input/network | App + shell | Result | Evidence/findings |
|---|---|---|---|---|---|---|---|---|
| Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending |

- [ ] iPhone-class Safari browser and installed PWA critical path executed.
- [ ] Android-class Chrome browser and installed PWA critical path executed.
- [ ] Physical tablet critical path executed.
- [ ] Desktop/laptop mouse and keyboard critical path executed.
- [ ] Install, prior-shell update, offline relaunch, and reconnection checked.
- [ ] Portrait, landscape, safe areas, and virtual keyboard checked where applicable.
- [ ] Camera/photo picker, crop editing, background/resume, and cancellation checked.
- [ ] Browser Back, dialogs/sheets, sticky actions, charts, long titles, and failed images checked.
- [ ] Attached captures contain only synthetic/redacted content.

Device-matrix disposition: **Pending**

Reviewer and date: Pending

## Manual screen-reader review

| Run | Assistive technology/version | OS | Browser or installed mode | Input/settings | Paths completed | Result | Evidence/findings |
|---|---|---|---|---|---|---|---|
| Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending |

- [ ] At least one mobile screen-reader/browser pair executed.
- [ ] At least one desktop screen-reader/browser pair executed.
- [ ] Five-destination navigation and current location announced.
- [ ] Search, filters, Quick Inspector, close, and focus return completed.
- [ ] Identity uncertainty, confirmation state, and available actions announced.
- [ ] Upload/manual recovery and an error-recovery path completed.
- [ ] Add/edit success completed without duplicate submission.
- [ ] Collection value, coverage, unpriced state, and chart summary understood.
- [ ] Current, manual, scenario, and forecast language distinguished.
- [ ] Form errors identify both problem and associated recovery control.
- [ ] Names, roles, values, states, headings, landmarks, live regions, and inert content reviewed.

Screen-reader disposition: **Pending**

Reviewer and date: Pending

## Consented production field metrics

### Authorization prerequisites

- [ ] Separate instrumentation change and data-flow diagram approved.
- [ ] Explicit opt-in is off by default, revocable, and buffers nothing before consent.
- [ ] Schema, endpoint logs, access, retention, aggregation, and deletion are reviewed.
- [ ] Automated tests reject prohibited payloads and stable unapproved identifiers.
- [ ] Sampling, internal/bot exclusion, baseline/window, retry, offline, and dedupe rules are fixed.
- [ ] KPI formulas, denominators, uncertainty, ownership, alerts, and shutdown are fixed.
- [ ] Privacy, security, and release-owner approvals are linked.

Instrumentation PR and schema: Pending

Consent-copy approval: Pending

Observation window: Pending

Deletion verification: Pending

### Field results

| KPI | Numerator / eligible denominator | Excluded / invalid | Window and versions | Estimate and uncertainty | Disposition |
|---|---|---|---|---|---|
| Search → exact-item completion | Pending | Pending | Pending | Unavailable | Pending |
| Scan → confirmed-add completion | Pending | Pending | Pending | Unavailable | Pending |
| Search → add time/interactions | Pending | Pending | Pending | Unavailable | Pending |
| Discover abandonment change | Pending | Pending | Pending | Unavailable | Pending |
| Unpriced-item review change | Pending | Pending | Pending | Unavailable | Pending |
| LCP / INP / CLS p75 | Pending | Pending | Pending | Unavailable | Pending |
| Crash-free sessions | Pending | Pending | Pending | Unavailable | Pending |

Field-metric disposition: **Pending**

Reviewer and date: Pending

## Findings register

| ID | Severity | Lane/task | Build/device | Observation | Owner/issue | Disposition | Verification |
|---|---|---|---|---|---|---|---|
| Pending | P0/P1/P2/P3 | Pending | Pending | Pending | Pending | Pending | Pending |

Unresolved P0 count: Pending

Unresolved P1 count: Pending

Deferred-finding rationale and trigger: Pending

## Final review

- [ ] Evidence links resolve and contain no prohibited participant data.
- [ ] Preregistered denominators, exclusions, deviations, and invalid attempts reconcile.
- [ ] Every finding has an owner and disposition.
- [ ] No P0 or P1 remains unresolved.
- [ ] Each completed lane has a named reviewer and date.
- [ ] `docs/PREMIUM_UX_ACCEPTANCE.md` was updated only for claims proved here.

Final decision: **Pending**

Accountable reviewer: Pending

Decision date and timezone: Pending

Rationale: Pending
