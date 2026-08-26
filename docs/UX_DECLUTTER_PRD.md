# CollectFolio UX Declutter PRD

| | |
|---|---|
| Status | Draft for Kevin's review |
| Date | 2026-08-25 |
| Baseline | v0.8.33 (sidebar shell) |
| Companion docs | CollectFolio UX Audit (artifact: https://claude.ai/code/artifact/41ed21bd-8275-4f35-85db-b93777f4366c) · `CollectFolio Premium UX Redesign — PRD & UI-UX Specification.md` (root) |
| Scope | All 87 audit findings (G-01…G-13, N-01…N-06, SH-01…SH-03, H-01…H-10, D-01…D-10, Q-01…Q-02, DT-01…DT-10, S-01…S-09, C-01…C-10, I-01…I-06, ST-01…ST-07, O-01) |

---

## 1. Overview

The audit found that CollectFolio's data honesty — its best quality — is expressed as **prose instead of design**. Five systemic patterns produce roughly 80% of the clutter: governance text repeated on collector surfaces, absence rendered as content, engineering vocabulary in user copy, the same metric rendered 2–4×, and fifteen different words for "unknown".

This PRD converts all 87 findings into 11 workstreams with numbered requirements (`DCL-*`), a phased rollout, and a completion-criteria checklist per workstream. It **implements** the root redesign PRD's principles (§5, §9, §14); where it amends the root PRD, the conflict is flagged explicitly (see §5 Open decisions).

## 2. Goals

1. Every screen passes a need-to-see test: each visible element informs a decision now, or lives behind a disclosure.
2. Every policy/methodology statement appears **exactly once** app-wide.
3. Collector vocabulary only — zero engineering or governance terms in visible copy.
4. Each metric rendered once per screen.
5. Measurable text reduction on the five densest surfaces (targets in DCL-VER-01) with **zero loss of data-integrity behavior**.

### Non-goals

- No new features, providers, or data-layer changes.
- No route re-architecture beyond the naming/co-location items in WS-9.
- No weakening of fail-closed behavior: charts still refuse to render without evidence, unknowns are never shown as `$0.00`, scenarios and forecasts stay separate. Every guarantee survives; only its *repetition* is removed.
- No visual redesign beyond the icon/token work in WS-10.

## 3. Global design rules

All workstreams implement these eight rules. They are the law; the requirements are the application.

- **RULE-1 — Say it once.** Every policy sentence has one canonical home (the Methodology disclosure, DCL-LEX-11). Repeating surfaces get at most a state label.
- **RULE-2 — Conditional rendering.** A section with no data renders nothing. One page-level line covers all absent market sections: *"More market data appears here as it's verified."*
- **RULE-3 — Collector lexicon.** If a term describes how the system is built rather than what the collector sees, it does not ship (banned list: Appendix C).
- **RULE-4 — Metric ownership.** Each metric has exactly one owning element per screen.
- **RULE-5 — Unknown-value lexicon.** Exactly four forms: `Unpriced` (missing market value) · `Not recorded` (missing user input) · `—` (dense grids) · `No verified market price` (long form, detail contexts only).
- **RULE-6 — Badge grammar.** ≤2 words, status only, never an instruction.
- **RULE-7 — Eyebrow grammar.** 1–2 plain wayfinding words. No slogans.
- **RULE-8 — Toast grammar.** Past-tense result, ≤6 words where possible, no internals.

---

## 4. Workstreams

### WS-1 · Copy system & lexicon (`DCL-LEX`)

Foundation for every other workstream. Builds the shared copy registry so strings can't drift back.

| ID | Requirement | Audit | Phase |
|---|---|---|---|
| DCL-LEX-01 | Create `app/assets/js/core/copy.js` exporting all shared user-facing strings: unknown-value labels, match-state labels, badge labels, policy statements, toast templates. Views import; no view re-declares a registry string. | G-01, G-05, G-06 | P1 |
| DCL-LEX-02 | Apply the full replacement table (Appendix A, 30 rows) across all views, modals, and toasts. | G-02 | P1 |
| DCL-LEX-03 | Unknown-value sweep to the four approved forms (RULE-5). | G-05, H-04 | P0 |
| DCL-LEX-04 | One match-state vocabulary everywhere: `Exact` / `Likely` / `Needs confirmation` / `No match`, plus `Confirmed by you` after approval. Badges carry status only; verbs live on buttons. | G-06, D-04 | P1 |
| DCL-LEX-05 | Terminology per root PRD §14.1: *Item* = catalog identity, *Quantity* = number owned, *Purchase* = acquisition, *watched cards* for Watchlist entries. | G-07 | P1 |
| DCL-LEX-06 | Eyebrow sweep to RULE-7. Removed: "Evidence before prediction", "Accountable model output", "Actionable collection signals", "Assumption workspace", "Append-only local receipts", "Collection intake". | G-09, S-08 | P1 |
| DCL-LEX-07 | Toast sweep to RULE-8 ("Backup imported", "Local data cleared", "Magic link sent"). | G-13 | P1 |
| DCL-LEX-08 | Badge sweep to RULE-6 (SUPPORT_LABELS become "Pricing pending", "Forecast ready", etc.; tier explanations move to Data & Methodology). | C-08 | P1 |
| DCL-LEX-09 | Storage/local-first messaging is owned by the shell (sync pill + sidebar note). All page subtitles, cards, and metric notes drop "Saved on this device" and equivalents. | G-08 | P0 |
| DCL-LEX-10 | Negation budget: at most one "is / is not" clarifier per surface class, sourced from the registry ("Scenarios are estimates from your assumptions, not market data."). All other never/no-fabricated/not-an-appraisal constructions removed. | G-12 | P1 |
| DCL-LEX-11 | Build the shared **Methodology disclosure** ("How CollectFolio handles data") — one collapsed component holding every guarantee (Appendix B), rendered from Item Detail, Insights, and Scenario surfaces. This is the destination for all P0 prose removals. | G-01 | P0 |

**Completion criteria — WS-1**

- [ ] `core/copy.js` exists; match states, unknown-value labels, badges, and policy strings render only via the registry (spot-check: changing a registry string changes every surface).
- [ ] Banned-phrase lint (DCL-VER-02) passes with zero hits outside the registry allowlist.
- [ ] Grep census: the only unknown-value forms in `views/` are the four approved ones.
- [ ] Every badge ≤2 words; every eyebrow ≤2 words (manual pass + grep of `eyebrow` strings).
- [ ] The Methodology disclosure contains every Appendix-B guarantee exactly once app-wide; no guarantee text appears anywhere else.
- [ ] All e2e specs assert current strings; none assert removed strings.

---

### WS-2 · Home (`DCL-HOME`)

Target layout, top to bottom: hero (value + movement + chart) → 3 summary stats → Needs attention (conditional) → modules (conditional) → Data Health (collapsed).

| ID | Requirement | Audit | Phase |
|---|---|---|---|
| DCL-HOME-01 | Remove the page header when holdings exist; the hero card is the first element. (Topbar keeps the collection name — see DCL-SET-08.) | H-01, SH-01 | P0 |
| DCL-HOME-02 | Hero shows: label "Estimated value", the value, freshness badge, movement line, range control, chart. Removed from hero: "· USD only", "X of Y items priced", "estimated gain" support line. | H-02 | P0 |
| DCL-HOME-03 | Metric ownership: pricing coverage renders only as its summary stat; the chart-meta row is deleted; gain renders only as its summary stat. | H-03, G-03 | P0 |
| DCL-HOME-04 | Unknown values per RULE-5 ("Unpriced" for values, "Not recorded" for cost basis). | H-04 | P0 |
| DCL-HOME-05 | Range control renders only ranges with ≥2 chart points (others hidden or disabled); default is the widest eligible range. Honors the day-scaled single-chart directive. | H-05 | P1 |
| DCL-HOME-06 | Remove the "Value concentration" summary stat; Insights owns concentration. Home's stats become: Cost basis · Estimated gain · Pricing coverage. | H-06 | P0 |
| DCL-HOME-07 | "History coverage %" renders only inside Data Health. | H-07 | P0 |
| DCL-HOME-08 | Data Health copy: status detail "Prices are up to date."; timestamp label "Updated \<date\>". | H-08 | P1 |
| DCL-HOME-09 | Empty state: "Scan or search for your first collectible to start tracking its value." | H-09 | P1 |
| DCL-HOME-10 | The currency-scope note ("EUR amounts are shown separately from USD totals.") lives only in Data Health; the in-flow fine-print paragraph is deleted. | H-10, G-08 | P0 |

**Completion criteria — WS-2**

- [ ] With holdings present, no `page-header` renders on Home; the hero is the first child.
- [ ] Coverage value appears exactly once in the Home DOM (e2e assertion); gain appears exactly once.
- [ ] Home renders exactly 3 summary stats.
- [ ] No enabled range button exists for a range with <2 points (fixture test with sparse snapshots).
- [ ] Data Health contains: coverage breakdown, history coverage, stale count, manual count, last update, refresh status, currency-scope note — and these appear nowhere else on Home.
- [ ] Text census (DCL-VER-01): Home visible text reduced ≥40% vs the v0.8.33 fixture.

---

### WS-3 · Discover (`DCL-DISC`)

| ID | Requirement | Audit | Phase |
|---|---|---|---|
| DCL-DISC-01 | Header = title + mode switch. The instructional description is deleted. | D-01 | P1 |
| DCL-DISC-02 | Gallery result card content is exactly: image (+ sealed-format badge), name, one meta line (set · #number), price line, match badge, primary action. Deleted from cards: the outlook `<dl>` (all horizons), outlook note rows, provenance line, facts row. | D-02, D-03 | P0 |
| DCL-DISC-03 | List view may additionally show one provenance small line and one 30-day movement chip (Decision D-2). No other market data on result cards. | D-02 | P0 |
| DCL-DISC-04 | Match badge for possible matches reads "Possible match" (status per DCL-LEX-04); "Confirm exact item" stays a button verb only. | D-04 | P1 |
| DCL-DISC-05 | Search placeholder: "Search the catalog". | D-05 | P1 |
| DCL-DISC-06 | Custom-category empty state: "No catalog covers {category} yet. Add yours with the details you know." | D-06 | P1 |
| DCL-DISC-07 | Delete browse self-narration: the sort explainer, the rights note, "X of Y products loaded" (spinner covers loading), and "Card count pending" (omit the line when unknown). | D-07 | P0 |
| DCL-DISC-08 | Delete both "Price sorting is unavailable because…" notices (the hidden option needs no explanation). | D-08 | P0 |
| DCL-DISC-09 | Remove the "Data source" control and its explanation from the filter panel (Decision D-4). | D-09 | P1 |
| DCL-DISC-10 | Source warnings: one human sentence + Retry; raw provider strings only behind a "Details" disclosure. | D-10 | P1 |

**Completion criteria — WS-3**

- [ ] `.result-market-outlook` is absent from all result grids (e2e assertion); gallery cards render ≤6 content elements.
- [ ] Grep census: "model baseline", "assumes flat market", "early estimate", "attribute-based" have zero hits in Discover views.
- [ ] Exactly one search input is visible pre-results (the page field; shell button excluded).
- [ ] No sort control anywhere in Discover has an accompanying explanation paragraph.
- [ ] Browse set headers show a plain total; loading states are spinners, not copy.
- [ ] Every Discover empty state has one sentence + ≤2 actions.
- [ ] Text census: gallery result card visible text reduced ≥60%.

---

### WS-4 · Item Detail & Quick View (`DCL-DET`)

| ID | Requirement | Audit | Phase |
|---|---|---|---|
| DCL-DET-01 | Trend, fair-value, forecast, drivers sections render **only with data** (RULE-2). One absence line replaces the stack. The Sales section is removed entirely until a sales feed exists. The "Additional updates needed" history card folds into the same absence line. | DT-01, DT-09, G-04 | P0 |
| DCL-DET-02 | All model/provenance metadata (model version, as-of, matures-at, immutability note, "weekly model target", absent-confidence line) moves into the Data & Methodology disclosure. Each visible section keeps at most one short label ("Estimate, not an appraisal"). | DT-02, DT-07 | P0 |
| DCL-DET-03 | The action bar contains actions only — no price rendering. | DT-03, G-03 | P0 |
| DCL-DET-04 | Unsupported state: H2 "No verified pricing yet" (no period); disclosure retitled "Why there's no market data yet" with one collector-facing reason; the "Nothing here is a fabricated estimate." line is deleted. | DT-04 | P1 |
| DCL-DET-05 | No identity pill renders when there is nothing to show ("Variant not specified" deleted). | DT-05 | P0 |
| DCL-DET-06 | Section renames: "Structural fair value" → "Typical market range"; "Attribute-based reference range" → "Price range (reference only)"; "Why this estimate? / Recorded drivers" → "What's driving this price". Precise terms live in Data & Methodology. | DT-06 | P1 |
| DCL-DET-07 | Chart explainer paragraphs become visual legend chips (● observed · ◇ outlook). | DT-08 | P1 |
| DCL-DET-08 | Single "Edit purchase" button; "Update quantity" removed (or becomes a real stepper — not a duplicate label). | N-05 | P1 |
| DCL-DET-09 | Detail nav styled as an in-page index with scroll-spy; the outlook section gets one stable anchor id regardless of scenario presence (Decision D-3). | N-06 | P2 |
| DCL-DET-10 | Data & Methodology labels are plain ("Catalog ID", not "Internal catalog reference"). | DT-10 | P2 |
| DCL-DET-11 | Quick View: one "Unpriced" stat replaces the standalone no-price line; "Identity details pending" is omitted (or "No set details"). | Q-01, Q-02 | P1 |

**Completion criteria — WS-4**

- [ ] Fixture item with zero market data renders exactly one absence line and zero absence cards (e2e).
- [ ] The price appears exactly once above the fold.
- [ ] "not disclosed" strings appear only inside Data & Methodology.
- [ ] No fine-print line renders under forecast/scenario sections except the single registry label.
- [ ] Outlook anchor id is identical with and without a local scenario (fixture pair).
- [ ] Quick View shows exactly one representation of a missing price.
- [ ] Text census: unsupported-item detail page reduced ≥50%.

---

### WS-5 · Scan & Add (`DCL-SCAN`)

| ID | Requirement | Audit | Phase |
|---|---|---|---|
| DCL-SCAN-01 | Add page: keep the numbered step strip; delete both prose restatements (header description, hero paragraph). Hero = title + "Open Camera" + "Upload Photo" + one line ("Drop or paste an image anywhere."). | S-01 | P1 |
| DCL-SCAN-02 | Privacy: one surface line — "**Private by default.** Photos stay on this device; only the card crop is sent for identification." — plus a "How photos are handled" disclosure holding the full text, written once and shared by Add and Review. | S-02 | P1 |
| DCL-SCAN-03 | Crop identification status copy is "Identifying…" in every recognition mode. Pipeline details (service names, rollback state) live only inside the privacy disclosure. | S-03 | P1 |
| DCL-SCAN-04 | Per-crop acquisition fields mirror `holding-form.js`: essentials visible (quantity, condition, purchase price + currency); "Purchase & organization" and "Grading, value & notes" collapsed. | S-04 | P1 |
| DCL-SCAN-05 | Condition fields: "Condition" and "Marketplace condition *(optional — used for price tracking)*". The "never inferred" sentence is deleted. | S-05 | P1 |
| DCL-SCAN-06 | Approval control: "Confirm" → "Confirmed ✓" with a separate small "Undo". Match vocabulary per DCL-LEX-04 (retiring "Catalog printing selected", "Confirmed printing", "Confirmed · remove confirmation"). | S-06 | P1 |
| DCL-SCAN-07 | Confirmation bar small print: "Only confirmed items are added." | S-07 | P1 |
| DCL-SCAN-08 | Eyebrow: "Add items" (replaces "Collection intake" in all four headers). | S-08 | P1 |
| DCL-SCAN-09 | Import card copy: "Merge a CollectFolio backup file." (no Settings directions). | S-09 | P1 |

**Completion criteria — WS-5**

- [ ] Header + hero visible copy on the Add page totals ≤30 words (excluding the step strip and button labels).
- [ ] The full privacy text exists exactly once app-wide, inside the disclosure; each surface line is ≤20 words.
- [ ] A crop card in its default state shows ≤2 sentences of guidance.
- [ ] Each crop shows ≤5 acquisition fields expanded by default; the two disclosure groups match the holding form's grouping.
- [ ] Lint: "CollectCapture", "rollback", "bounded crop" have zero hits in visible copy (allowed inside the privacy disclosure body only for the service name).
- [ ] The scan e2e flow (capture → review → confirm → add) passes unchanged in behavior.

---

### WS-6 · Collection (`DCL-COLL`)

| ID | Requirement | Audit | Phase |
|---|---|---|---|
| DCL-COLL-01 | Summary compresses to a one-line strip: value · item count · coverage % (sparkline optional). Gain breakdown, last-updated, and the currency fine print are removed (Home and Data Health own them). | C-01, G-03 | P0 |
| DCL-COLL-02 | Watchlist card = art + alert chip, name/meta, current price, 30-day move, target distance, two actions (Details, Add) + overflow (Target & alerts, Compare, Remove). Removed: forecast range + confidence, liquidity line, support-badge sentence, the opportunity-ranking paragraph, 7-day stat, last-update stat; alert signals capped at one. | C-02, G-01 | P0 |
| DCL-COLL-03 | Sets: delete the section governance paragraph, the per-card "Catalog total not linked…" fine print, and "Saved on this device". | C-03, G-08 | P0 |
| DCL-COLL-04 | Delete leaves holding cards; it lives in the edit form, the detail page, and bulk selection. Cards keep Watch + Edit. | C-04 | P1 |
| DCL-COLL-05 | Grouped-card value note shows one attention status only ("1 of 3 unpriced") and only when something needs attention. Provenance moves to the detail page. | C-05 | P1 |
| DCL-COLL-06 | One control row above the grid: segments stay; the grouped/purchases toggle folds into the sort menu or a single display popover with the view toggle; the filter panel stays closed until opened; chips are the persistent filter representation; one filter count; selects with a single distinct value are hidden. | C-06, N-03 | P1 |
| DCL-COLL-07 | Watchlist overview: "N watched cards · M alerts". | C-07 | P1 |
| DCL-COLL-08 | The forecasts section is retitled "Forecasts" and its gated state is one sentence: "Forecasts aren't available yet. Watchlists work now." — no badge, no bullets. | C-09, N-01 | P0 |
| DCL-COLL-09 | Sets empty states: "Add a set name to an item and it appears here." | C-10 | P1 |
| DCL-COLL-10 | All Collection badges per DCL-LEX-08. | C-08 | P1 |

**Completion criteria — WS-6**

- [ ] The summary strip renders ≤3 data points (+ optional sparkline).
- [ ] Watchlist cards render ≤8 content elements; the ranking paragraph is absent (e2e).
- [ ] Grep census: "intentionally unavailable" and "authoritative catalog total" have zero hits.
- [ ] Exactly one control row above the holdings grid (chips excluded).
- [ ] No Delete button exists in holding-card DOM.
- [ ] No section inside Collection is titled "Insights".
- [ ] Text census: watchlist card reduced ≥50%.

---

### WS-7 · Insights (`DCL-INS`)

| ID | Requirement | Audit | Phase |
|---|---|---|---|
| DCL-INS-01 | Overview rows render only with data (RULE-2). The two unpriced-count rows merge into one. The permanent "Recently completed sets" row and the meta-subtitle ("…shown only when their supporting data exists.") are deleted. | I-01 | P0 |
| DCL-INS-02 | Scenario Lab leads with the output card under defaults. The seven assumption controls collapse into an "Adjust assumptions" disclosure summarized in one line ("Market unchanged · typical volatility"). | I-02 | P1 |
| DCL-INS-03 | The publication-gate explainer card is deleted; when the flag is off, the section simply doesn't render. | I-03 | P0 |
| DCL-INS-04 | Track Record when empty is one line: "Forecast accuracy appears here once predictions mature." Governance prose moves to the Methodology disclosure. | I-04 | P0 |
| DCL-INS-05 | Assumption summaries humanized; unset dimensions omitted (no "category none unchanged"). | I-05 | P1 |
| DCL-INS-06 | Alert chips mark exceptions only (Unread, Muted, System); default states are unmarked. | I-06 | P1 |

**Completion criteria — WS-7**

- [ ] No Overview row renders whose value is permanently "Unavailable"/"None" by construction.
- [ ] Exactly one Overview row references the unpriced count.
- [ ] The scenario output card is the first element after the horizon control; assumptions are collapsed by default.
- [ ] With flags off, the forecasts and track-record surfaces each render ≤1 sentence.
- [ ] Lint: "feature-flag", "operator-review", "walk-forward" have zero hits.
- [ ] Alert cards in read/market state carry zero chips.

---

### WS-8 · Settings, Shell & Onboarding (`DCL-SET`)

| ID | Requirement | Audit | Phase |
|---|---|---|---|
| DCL-SET-01 | "Prioritize my cards" copy: "Ask for a sooner price check on your cards. Values update only after new data is verified." | ST-01 | P1 |
| DCL-SET-02 | Disabled cloud-removal copy: "Not available yet." | ST-02 | P1 |
| DCL-SET-03 | Hide "Default forecast horizon" behind the forecast flag; sync "Preferred market source" options with the live provider set (retire the Pokémon/Magic/Yu-Gi-Oh! provider options catalog-v2 removed from search). | ST-03 | P1 |
| DCL-SET-04 | Remove the duplicate subtitle (keep eyebrow or lede, not both). | ST-04 | P1 |
| DCL-SET-05 | "Sync" replaces "Synchronization/Synchronize" in labels, statuses, and history ("Sync now", "Sync needs attention", "No syncs yet"). | ST-05 | P1 |
| DCL-SET-06 | "…isn't available yet." replaces "in this build" / "in this release" everywhere. | ST-06 | P1 |
| DCL-SET-07 | Fix the version fallback (0.8.17 → current); add `profile.js` to the version-bump checklist and to `scripts/validate.mjs` coverage. | ST-07 | P1 |
| DCL-SET-08 | Shell: the topbar owns the collection name (Home header drops it per DCL-HOME-01); shell search label becomes "Search"; the brand subtitle "Collection gallery" is removed (the sidebar-note line covers the tagline). | SH-01…03 | P1 |
| DCL-SET-09 | Onboarding states step position exactly once: keep the progress bar; drop "Three quick steps" and the per-card "Step N of 3" eyebrows. | O-01 | P2 |

**Completion criteria — WS-8**

- [ ] Lint: "in this build", "this release", "research queue", "isolation", "rollback" have zero hits in Settings copy.
- [ ] The market-source option list is generated from (or tested against) the live provider registry.
- [ ] The version fallback matches `package.json`; the bump checklist and validate script cover `profile.js` (9th pinned spot).
- [ ] Settings renders "Sync" terminology throughout.
- [ ] Onboarding shows step position in exactly one place.
- [ ] The shell search button reads "Search"; the brand block has no subtitle.

---

### WS-9 · Navigation & IA (`DCL-NAV`)

| ID | Requirement | Audit | Phase |
|---|---|---|---|
| DCL-NAV-01 | Exactly one surface titled "Insights": Collection's forecasts section is retitled "Forecasts" (with DCL-COLL-08). | N-01 | P0 |
| DCL-NAV-02 | Watchlist and Alerts co-locate per Decision D-1 (recommended: the Watchlist surface owns alert review; Insights keeps only the unread-count deep link). **Flag: amends root PRD §11.7 / INSIGHTS-002, which places Alerts under Insights — needs Kevin's sign-off.** | N-01 | P1 |
| DCL-NAV-03 | Unpriced CTAs (Home attention item, Insights "Resolve pricing") deep-link to Collection with `pricing=unpriced` applied and the filter chip visible. | N-02 | P1 |
| DCL-NAV-04 | One Discover landing serves both modes (search field above the browse landing); the breadcrumb is the sole upward navigation — the separate "All games" / "All sets" buttons are removed. | N-04 | P1 |

**Completion criteria — WS-9**

- [ ] Grep + render check: exactly one H1/H2 titled "Insights" app-wide.
- [ ] The watch → alert → review loop completes without leaving its destination (manual walkthrough).
- [ ] Home/Insights unpriced CTAs land with the unpriced filter chip visible (e2e).
- [ ] Browse pages contain the breadcrumb as the only upward navigation.
- [ ] Decision D-1 recorded (accepted or amended) before WS-9 P1 work starts.

---

### WS-10 · Visual system (`DCL-VIS`)

| ID | Requirement | Audit | Phase |
|---|---|---|---|
| DCL-VIS-01 | Replace unicode glyph icons (▦ ☷ ▣ ⌕ ↥ ◇ ••• ☑ ☐ ★ ☆ ↻ ⇣) with the existing inline-SVG icon system; every icon-only control keeps its aria-label. | G-10 | P2 |
| DCL-VIS-02 | Accent-role separation per root PRD §10.3: `--accent` is reserved for interactive emphasis (primary action, active selection). New semantic tokens carry market movement — green positive / red negative, blue for modeled overlays (per the chart-color directive). Decorative accent uses (privacy notes, hero ornaments, progress decorations) drop to neutrals. | G-11 | P2 |
| DCL-VIS-03 | Badge/chip visual hierarchy distinguishes status from action (status chips never styled like buttons). | C-08 | P2 |

**Completion criteria — WS-10**

- [ ] Lint: none of the listed glyphs appear in `views/` or `core/` markup strings.
- [ ] `var(--accent)` usage reduced from ~90 component contexts to interactive/selection contexts only (target ≤30; CSS review documents each remaining use).
- [ ] Movement colors come from semantic tokens, never `--accent`.
- [ ] Axe pass: every icon-only button has an accessible name; focus states visible.

---

### WS-11 · Verification & tooling (`DCL-VER`)

The instruments that make "done" checkable and keep it done.

| ID | Requirement | Phase |
|---|---|---|
| DCL-VER-01 | **Text census** — `scripts/text-census.mjs` renders fixed state fixtures through each view and counts visible characters. Baselines from v0.8.33 are checked in. Targets: Home −40% · gallery result card −60% · watchlist card −50% · unsupported-item detail −50% · Add page −40%. | P0 |
| DCL-VER-02 | **Banned-phrase lint** — `scripts/check-copy.mjs` fails on any Appendix-C pattern in view/core string literals, with an allowlist for `core/copy.js` (registry) and the privacy-disclosure body. Wired into `npm test`. | P0 |
| DCL-VER-03 | **Same-PR rule** — any PR changing user-facing strings updates the asserting e2e/unit specs in the same PR (`tests/e2e` premium-ux-acceptance specs pin many strings). | P0 |
| DCL-VER-04 | **Data-integrity invariants stay green** — the non-negotiables: charts with <2 points render their empty state; unknown values never render as `$0.00`; scenario output never appears inside a Forecast-labeled section; manual and market values remain visually distinguished; no new estimate is displayed without its existing eligibility gate. Covered by existing tests plus new fixture assertions where removal touches them. | P0–P2 |
| DCL-VER-05 | **A11y regression** — axe pass per view; tab/segment patterns keep consistent aria semantics after control consolidation (WS-6). | P1 |

**Completion criteria — WS-11**

- [ ] Census script + baselines committed; all five reduction targets met and enforced in CI.
- [ ] Copy lint in CI; zero violations.
- [ ] No merged PR in this effort changed a string without its spec update (review of PR history at close).
- [ ] Full existing test suite green at each phase exit; invariant fixtures added for DET-01, HOME-05, DISC-02.
- [ ] Axe: no new violations vs the v0.8.33 baseline.

---

## 5. Open decisions (need Kevin)

| ID | Decision | Recommendation |
|---|---|---|
| D-1 | Where do Alerts live? | **DECIDED 2026-08-26 (Kevin): recommended path accepted.** Watchlist surface owns alert review (cards/alerts switch in Collection → Watchlist); Insights keeps the unread-count deep link; `/insights/alerts` forwards to the new location. Amends root PRD §11.7 (INSIGHTS-002). |
| D-2 | 30-day movement chip on result cards? | Yes, list view only; gallery tiles stay identity + price + badge. |
| D-3 | Detail nav: real tabs or index? | In-page index with scroll-spy (cheapest honest treatment; real tabs are a P3 candidate). |
| D-4 | Discover "Data source" filter control | Remove entirely (automatic behavior is the only sensible default). |
| D-5 | Identity confirmation gating? | **DECIDED 2026-08-26 (Kevin):** Identity confirmation removed — extracted/matched identities are trusted; Add/Watch are never gated on confirmation. Amends root redesign PRD QUICK-003, SCAN-004/005, DISC-009. |

## 6. Phasing & release mapping

| Phase | Theme | Contents | Target |
|---|---|---|---|
| **P0** | Structural removals — pure deletion, low risk, hits every session | DCL-VER-01/02/03 first, then: HOME-01…04, 06, 07, 10 · DISC-02, 03, 07, 08 · DET-01, 02, 03, 05 · COLL-01, 02, 03, 08 · INS-01, 03, 04 · NAV-01 · LEX-03, 09, 11 | v0.8.34 |
| **P1** | Copy sweep + flow | LEX-01, 02, 04…08, 10 · HOME-05, 08, 09 · DISC-01, 04, 05, 06, 09, 10 · DET-04, 06, 07, 08, 11 · SCAN-01…09 · COLL-04…07, 09, 10 · INS-02, 05, 06 · SET-01…08 · NAV-02, 03, 04 · VER-05 | v0.8.35 |
| **P2** | System polish | VIS-01…03 · DET-09, 10 · SET-09 | v0.8.36 |

Each phase ships as one release train; e2e updates ride in the same PRs as their string changes (DCL-VER-03). Phase exit = that phase's workstream checklists fully checked + full suite green.

## 7. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Copy changes break e2e specs that pin strings | DCL-VER-03 same-PR rule; the specs are also the ninth-spot lesson from the version-bump checklist. |
| Removing explanations reads as reduced honesty | Nothing is deleted — every guarantee moves to the Methodology disclosure (Appendix B), reachable from every surface that used to repeat it. |
| Root-PRD conflict on Alerts location | Flagged as Decision D-1; no work starts on NAV-02 until recorded. |
| Scope creep into feature work | §2 non-goals; PRs limited to the listed requirement IDs. |
| Regressing fail-closed behavior while deleting markup | DCL-VER-04 invariants run at every phase exit; conditional rendering (RULE-2) removes *sections*, never *gates*. |

## 8. Master completion checklist

- [ ] All 87 audit findings mapped here are closed (traceability: each `DCL-*` lists its audit IDs; no audit ID unclaimed).
- [ ] WS-1 through WS-11 section checklists fully checked.
- [ ] All four open decisions recorded.
- [ ] Text-census targets met and enforced in CI.
- [ ] Copy lint green in CI with zero violations.
- [ ] Data-integrity invariants green; no fail-closed behavior weakened.
- [ ] Root-PRD alignment: §14.1 terminology, §14.2 replacements, §10.3 accent rules all satisfied; amendments (D-1) documented in the root PRD.
- [ ] Version-bump checklist updated (profile.js fallback = 9th spot).
- [ ] Kevin sign-off per phase before release tag.

---

## Appendix A — Copy replacement table

| Current | Replacement |
|---|---|
| Research gate active / Publication gate active | *(remove badge)* |
| Forecasts are not publicly available… until source rights, mapping, and walk-forward model gates pass. | Forecasts aren't available yet. Watchlists work now. |
| Opportunity ranking withheld until offer price, taxes, shipping, selling fees, and liquidity evidence are recorded… | *(remove from cards; Methodology: "Rankings need purchase-cost details you haven't entered.")* |
| Catalog total not linked; completion percentage is intentionally unavailable. | *(remove)* |
| Estimated collection value · USD only | Estimated value |
| The latest available price refresh completed successfully. | Prices are up to date. |
| Last successful refresh: \<timestamp\> | Updated \<date\> |
| No exchange rate was guessed. | *(remove; one "shown separately" clause in Data Health)* |
| Collection intake | Add items |
| Sending this bounded crop to CollectCapture for recognition and catalog suggestions. | Identifying… |
| Reading this bounded crop with the explicit local scanner rollback. | Identifying on this device… |
| Required for an exact-condition market forecast; never inferred from collection condition. | Optional — used for price tracking. |
| Confirmed · remove confirmation | Confirmed ✓ *(+ separate "Undo")* |
| Destination: Local collection. Unconfirmed and unmatched items are skipped. | Only confirmed items are added. |
| 12 exact variants saved on this device. | 12 watched cards |
| Approved intelligence alerts: 2 | 2 alerts |
| Card identified; pricing pending *(badge)* | Pricing pending |
| Exact card verified · approved outlook not published | No forecast yet |
| Structural fair value | Typical market range |
| Why intelligence is unavailable | Why there's no market data yet |
| Nothing here is a fabricated estimate. | *(remove)* |
| An existing forecast is never rewritten. | *(Methodology, once)* |
| Confirm variant *(badge)* | Possible match |
| There is no universal rights-cleared catalog for this category. | No catalog covers this category yet. |
| Ask the private research queue to check your held and watched cards sooner. | Ask for a sooner price check on your cards. |
| Unavailable until independently recoverable cloud removal has passed hosted isolation and rollback checks. | Not available yet. |
| Cloud backup is unavailable in this build. | Cloud backup isn't available yet. |
| Evidence before prediction *(eyebrow)* | Insights |
| Search cards, sets, players, products, or set codes | Search the catalog |
| Scenarios are assumption-based estimates and are not appraisals, market observations, investment recommendations, or guaranteed outcomes. | Scenarios are estimates from your assumptions, not market data. *(once per surface class)* |

## Appendix B — Methodology disclosure contents

The single home for every guarantee (rendered by DCL-LEX-11, one collapsed component):

1. Values render only from verified market data, your manual entries, or clearly labeled estimates — never fabricated.
2. Charts and ranges appear only when their supporting evidence exists.
3. Scenarios come from your assumptions; forecasts come from validated models; the two are never mixed.
4. A published forecast is never rewritten; matured predictions are scored as-is.
5. Manual values stay distinct from market observations and never create cross-source returns.
6. Amounts in other currencies are shown separately; no exchange rate is applied.
7. Set completion is shown only when an authoritative catalog total is linked.
8. Opportunity rankings require your purchase costs, fees, and liquidity evidence before they appear.

## Appendix C — Banned-phrase lint list

Patterns failing `scripts/check-copy.mjs` outside the registry/privacy-disclosure allowlist:

`research gate` · `publication gate` · `walk-forward` · `feature-flag` · `operator-review` · `rights-cleared` · `bounded crop` · `scanner rollback` · `research queue` · `hosted isolation` · `rollback checks` · `append-only` · `immutable key` · `in this build` · `this release` · `intentionally unavailable` · `authoritative catalog total` · `fabricated` · `exchange rate was guessed` · `model baseline` · `assumes flat market` · `Collection intake` · `Destination:` · `not disclosed` *(outside Data & Methodology)* · `never inferred` · `never rewritten` *(outside registry)*
