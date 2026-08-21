# Premium UX Human Validation Protocol

**Status:** Protocol ready; no human or field-data gate is completed by this document

**Canonical requirements:** `PRD/CollectFolio Premium UX Redesign — PRD & UI-UX Specification.md`

**Repository acceptance:** `docs/PREMIUM_UX_ACCEPTANCE.md`

**Receipt template:** `docs/receipts/PREMIUM_UX_HUMAN_VALIDATION_TEMPLATE.md`

## Purpose and evidence boundary

The automated Premium UX acceptance suite covers deterministic behavior, responsive
layout, keyboard operation, accessibility rules, migration fixtures, network recovery,
and lab performance. Four follow-ups require observations that repository automation
cannot manufacture:

1. a moderated external collector study;
2. review on physical devices and installed PWAs;
3. manual screen-reader review; and
4. consented production field metrics.

This protocol makes those activities reproducible and auditable. It does not turn a
simulation into human evidence, infer participant success from browser assertions, or
authorize telemetry. A gate closes only when a dated copy of the receipt template is
completed, evidence is linked, findings are dispositioned, and the accountable reviewer
signs the relevant lane.

## Shared prerequisites

Before any lane begins:

- Record the application version, commit SHA, URL, service-worker shell, date, timezone,
  moderator or reviewer, and protocol revision in the receipt.
- Use a fresh browser profile and synthetic study data unless the participant explicitly
  chooses otherwise after consent. Never ask for a production password, access token,
  personal backup, or real collection photograph.
- Explain the purpose, activities, recording choice, retained fields, retention period,
  withdrawal route, and whether compensation is offered before collecting evidence.
- Assign a study-specific participant code. Keep names, email addresses, recruitment
  records, and consent records outside the product-evidence receipt.
- Predeclare the cohort target, exclusions, task order, stopping rule, and analysis plan.
  Do not change them after seeing results without recording a protocol deviation.
- Verify that instrumentation, screen recording, voice recording, and crash collection
  are off unless each is separately disclosed and consented.

The receipt may contain task outcomes, timings, interaction counts, coarse device class,
app version, observations, and issue links. It must not contain raw photos, OCR text,
collection notes, purchase prices, manual values, account identifiers, authentication
material, exact personal search queries, or an export of a participant's collection.
Recordings are optional, require separate consent, and must have an owner and deletion
date.

## Lane A — Moderated collector study

### Recruitment and analysis

Run a pilot before the measured round. Recruit collectors with a mix of experience,
collection sizes, and categories rather than only project contributors. Include people
who have not used CollectFolio before. A small qualitative round may identify usability
problems, but it must not be presented as a statistically representative completion
percentage. Any KPI claim requires a preregistered sample target, denominator, exclusion
policy, and uncertainty method.

Use neutral prompts. The moderator may repeat a task or ask the participant to think
aloud, but must not name the control or route that completes it. If help is required,
record the first prompt and classify the outcome as assisted.

### Outcome rules

Use exactly one outcome per participant and task:

- **Unassisted:** the participant reaches the stated end state without task-specific help.
- **Assisted:** the participant reaches it after a moderator hint or recovery intervention.
- **Failed:** the participant stops, reaches the wrong state, or cannot recover.
- **Invalid:** the observation is unusable because of an external outage, study setup
  failure, or protocol deviation. Invalid attempts remain visible and are excluded only
  under the preregistered rule.

Start timing when the moderator finishes the prompt and stop at the observable end state.
Count intentional taps, clicks, key activations, and submitted commands consistently;
exclude think-aloud speech and operating-system actions outside the task. Record errors,
backtracking, confidence, and recovery separately from completion.

### Required tasks

| # | Neutral prompt | Observable end state |
|---:|---|---|
| 1 | Find the exact known item supplied by the moderator. | The exact printing or product detail is open. |
| 2 | Browse from the named game to the named set and item. | The supplied item in that set is open. |
| 3 | Show which result is a pack, box, and case. | All three formats are correctly distinguished. |
| 4 | Add the confirmed item with the supplied ownership details. | The item appears in Collection with the supplied quantity. |
| 5 | Resolve the supplied uncertain match. | The correct identity is explicitly confirmed or safely left unresolved. |
| 6 | Add the confirmed items from a supplied multi-item image. | Correct crops are reviewed; unresolved crops are not silently added. |
| 7 | Find the supplied unpriced holding and explain its status. | The participant identifies the missing value and a valid next action. |
| 8 | Add the supplied manual current value. | The value is saved and described as manual, not market-observed. |
| 9 | Find the supplied watched item. | The exact watched variant is visible. |
| 10 | Explain the difference between the displayed scenario and forecast. | The explanation distinguishes assumptions from published evidence. |
| 11 | Group the supplied matching holdings and inspect their purchases. | The grouped item and separate purchases are both found. |
| 12 | Open an item from a filtered catalog, then return. | Filters, position, and originating context are preserved. |

Use a synthetic fixture with known expected identities and values. Keep the fixture and
task prompts stable across a measured round. Randomized task order is permitted only when
the randomization method and dependencies are declared in advance.

### Debrief

After the tasks, ask without leading:

- What felt easiest and most difficult?
- Which values or labels were unclear?
- At any point, were you unsure whether an item would be added or changed?
- What did you expect Back, Close, and the primary action to do?
- What would prevent you from using this for a real collection?

Link findings to an issue or record an explicit no-finding result. Do not replace observed
behavior with the participant's stated preference; retain both as separate evidence.

## Lane B — Physical-device and installed-PWA review

The automated viewport matrix remains the regression baseline. Physical review adds
browser chrome, display cutouts, virtual keyboards, camera and photo pickers, memory
pressure, install/update behavior, and real touch input.

At minimum, execute the critical path on:

- one supported iPhone-class device in Safari and as an installed PWA;
- one supported Android-class device in Chrome and as an installed PWA;
- one physical tablet class; and
- one desktop or laptop with mouse and keyboard.

Record manufacturer/model, OS version, browser version, viewport or display class,
browser versus installed mode, input method, network state, and app/service-worker
version. A simulator or device-emulation run may supplement but cannot be labeled as a
physical-device result.

Check each applicable target:

- fresh install, first launch, update from the previous shell, and relaunch;
- portrait, landscape, display cutout/safe areas, and virtual-keyboard resize;
- bottom navigation or rail reachability, sticky actions, scrolling, and browser Back;
- camera permission, photo picker, multi-item review, crop editing, cancellation, and
  recovery after backgrounding;
- offline launch with previously loaded local data and reconnection recovery;
- tap targets, long titles, failed images, chart labels, dialogs, sheets, and zoom;
- storage persistence after process termination; and
- no unexpected upload of source photos or disclosure of local collection content.

Capture screenshots only with synthetic data. Redact operating-system notifications,
account names, and unrelated application content before attaching evidence.

## Lane C — Manual screen-reader review

The minimum evidence set contains one mobile and one desktop screen-reader/browser pair.
The preferred matrix is VoiceOver with iOS Safari or installed PWA, TalkBack with Android
Chrome or installed PWA, NVDA with current Windows Chrome or Firefox, and VoiceOver with
macOS Safari. Record the exact assistive-technology, OS, browser, speech, verbosity, and
input settings used.

Complete these paths without relying on sight:

1. identify the application and current destination, then traverse all five destinations;
2. search, apply and clear a filter, open Quick Inspector, close it, and confirm focus
   returns to the originating result;
3. inspect an uncertain identity and verify that confirmation state and available actions
   are announced;
4. use the upload/manual fallback path, review an error, and find its recovery action;
5. add or edit a synthetic holding and confirm success without duplicate submission;
6. find Collection value, pricing coverage, unpriced status, and the chart's text summary;
7. distinguish current value, manual value, scenario, and forecast language; and
8. trigger form validation and verify the problem and recovery are associated with the
   relevant control.

For every path, record names, roles, values, state changes, focus order, landmarks,
headings, live announcements, dialog boundaries, escape/close behavior, and whether
hidden or inert content remains silent. A task that is technically reachable but has an
ambiguous name, missing state, focus loss, or repeated announcement is still a finding.

## Lane D — Consented production field metrics

General product telemetry is not currently enabled. The private demand-event queue is a
separately governed price-intelligence research contract and must not be repurposed for
Premium UX measurement. This protocol does not authorize a new endpoint, database table,
cookie, device identifier, or third-party analytics product.

Before an instrumentation change is implemented or enabled, approve all of the following
in a separate reviewed change:

- the exact questions being answered and the minimum event/field set needed;
- explicit opt-in copy, an off-by-default state, withdrawal, deletion, and no pre-consent
  buffering;
- event schema and version, pseudonymous session strategy, access controls, encryption,
  endpoint logging behavior, retention, aggregation, and deletion verification;
- prohibited payload tests covering photos, OCR, search text, item identity, notes,
  prices, collection contents, account identity, and authentication material;
- sampling, bot/internal-session exclusion, baseline and observation windows, clock and
  retry semantics, offline deduplication, and crash-session definition;
- KPI formulas, minimum denominators, uncertainty reporting, dashboard ownership, alert
  thresholds, and a documented shutdown path; and
- privacy, security, and release-owner approval.

The canonical PRD event names are a design input, not evidence that collection exists.
A minimal approved payload should prefer event name, schema version, app version,
coarse route/device class, bounded duration or Web Vital, outcome code, and a rotating
study/session identifier. It should not retain a stable cross-session person or device
identifier unless that additional need is separately justified and consented.

Report every KPI with its numerator, denominator, eligible and excluded counts, date
window, app versions, cohort definition, and uncertainty. Search-to-add, scan completion,
abandonment, unpriced-resolution, LCP/INP/CLS p75, and crash-free-session claims remain
unavailable until their preregistered definitions and evidence windows are satisfied.

## Findings and disposition

Classify observed findings consistently:

- **P0:** data loss, privacy/security breach, incorrect confirmed identity or value,
  inaccessible critical path, or an unrecoverable primary workflow.
- **P1:** a required task is blocked or commonly fails without moderator assistance.
- **P2:** recoverable friction, unclear hierarchy/copy, or a significant efficiency issue.
- **P3:** polish or preference with no material task impact.

The human-validation follow-up cannot close with an unresolved P0 or P1. Each finding
must have an owner, issue link, affected build/device, disposition, verification evidence,
and reviewer. Deferral requires written rationale and a re-evaluation trigger; silence is
not acceptance.

## Receipt workflow

1. Copy `docs/receipts/PREMIUM_UX_HUMAN_VALIDATION_TEMPLATE.md` to a dated receipt.
2. Complete only the lanes actually executed; leave unexecuted lanes explicitly pending.
3. Link consent records by restricted reference, not by embedding personal data.
4. Link sanitized notes, screenshots, recordings, issues, and metric definitions.
5. Re-run repository gates for any remediation and record the tested commit and version.
6. Obtain the named reviewer disposition for each lane.
7. Update `docs/PREMIUM_UX_ACCEPTANCE.md` only after the receipt proves the claim.

Recommended order is a protocol pilot, moderated round, physical-device pass, manual
screen-reader pass, remediation and regression, then a separately approved field-metric
instrumentation proposal. Field telemetry is not a prerequisite for learning from the
first three lanes.
