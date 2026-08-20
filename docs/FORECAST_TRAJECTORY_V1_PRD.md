# Trajectory-v1 PRD — per-card price prediction, end to end

Status: **execution-approved** (Kevin directive, 2026-08-16: build, commit,
merge, deploy). Method basis: `docs/FORECAST_METHOD_ROADMAP.md`.
Execution model: one supervised implementation lane works the tasks below
**strictly in order**; the supervisor verifies every completion criterion
before the next task starts. Merges to `main` and production deploys are
performed by the supervisor/Kevin, never by the lane.

## 1. Product definition

For every covered card variant, CollectFolio shows a **predicted price** — a
concrete currency amount — at 30-day and 90-day horizons, with a weekly model
path resampled into daily display values and calibrated q10/q25/q50/q75/q90
bands at the served horizons, derived from real historical statistics. Daily
display points are interpolation, not separately refitted forecast vintages.
No fixed ±% bands. Cards or cohorts whose model fails
the evaluation gate are **not served a prediction** (fail closed, labeled
"insufficient evidence"), never served a pretend range.

### Non-goals (v1)
- No investment-advice framing; every surface keeps "model estimate, not
  advice" and a model card.
- No per-user training, no third-party npm packages in the browser app, no
  new Python dependencies beyond the standard library.
- No event-driven overrides (reprint/ban calendars) — Phase 6 of the roadmap.
- No JustTCG/Cardbase sources (still gated).

### Source-rights note (explicit, do not silently bypass)
`analytics/.../tcgcsv.py::assert_tcgcsv_research_terms` still encodes
`research_only` SourceTerms. Kevin's community-free-access decision already
serves TCGCSV-derived catalog and prices publicly, and the 2026-08-16
directive extends that decision to derived forecast statistics. Implement a
new `SourceTerms` record (decision `community_free_access`, granted scopes
for derived-statistics publication) recorded beside the old one; the
`research_only` assertion stays intact for the legacy research paths. This
conflict and its resolution must appear in the final PR description.

## 2. Model (normative summary)

Daily/weekly log price per exact variant decomposes as
`y = market + game + set + card-residual` (trimmed-mean repeat-sales
indices). Forecasts: damped-trend exponential smoothing on market/game
indices; set level blends its own damped trend with release-age lifecycle
curves fitted across all sets; card residual uses the Theta method with
empirical-Bayes drift shrinkage `n/(n+n0)`. Point prediction = exp of the
recombined median path. Bands = split-conformal quantiles of walk-forward
residuals pooled by (category × volatility bucket × horizon), scaled by the
card's MAD volatility, emitted as noncrossing q10/q25/q50/q75/q90
(`quantiles.py` contract). Cold start uses a per-category hedonic log-price
regression (rarity, finish, release age, set family, sealed/single kind)
as the shrinkage prior with wide honest bands. The weekly median path preserves
the exact component weights selected at the 30-day and 90-day checkpoints and
linearly blends those weights between checkpoints; it never switches to the
nearest horizon's parameter set at the midpoint.

## 3. Data contract

- Source archives: `https://tcgcsv.com/archive/tcgplayer/prices-YYYY-MM-DD.ppmd.7z`
  (client + member extraction already in `analytics/.../tcgcsv.py`; host has
  `7z` with PPMd). Archives exist from 2024-02-08.
- v1 panel resolution: **weekly** samples (7-day interval) from the earliest
  practical date (target ≥ 2025-02-01, stretch 2024-02-08) through the most
  recent complete archive; daily accumulation forward is Phase-2 work in the
  roadmap, not v1.
- v1 category scope: **1 (Magic), 2 (YuGiOh), 3 (Pokémon), 85 (Pokémon
  Japan)** minimum; more only if runtime budget allows.
- Each archive date is downloaded **once**, all scoped members extracted in
  one pass, raw bytes hashed; panel rows carry archiveDate as observed
  time and archiveDate+1d as conservative available time (point-in-time
  safety), matching `historical_import.py` semantics.
- Panel storage: local `analytics/data/panel/` (gitignored) as compact
  JSONL/CSV per category; a receipts JSON (dates, hashes, row counts,
  coverage) is committed under `docs/receipts/`.

## 4. Tasks — sequential, each with completion criteria

### T1 — Panel builder
Extend analytics with a bulk archive panel builder
(`tcgcsv_panel.py` + `tcgcsv_panel_cli.py`): resumable download of scoped
archive dates, single-pass member extraction, per-variant weekly series
(productId × subTypeName, marketPrice preferred per `PRICE_FIELDS`), receipts.
**Complete when:**
- `python3 -m collectfolio_analytics.tcgcsv_panel_cli --help` documents
  bounded, resumable operation; interrupted runs resume without refetching.
- Panel exists for categories {1,2,3,85} at weekly resolution with ≥ 26
  sample dates spanning ≥ 12 months; per-date receipts (archive sha256,
  member counts, parse rejects) written to `docs/receipts/trajectory-v1/`.
- Unit tests with synthetic archive fixtures cover parsing, resume,
  reject handling; `npm run test:analytics` green; no new dependencies.
- gitignore covers `analytics/data/`; nothing > 1 MB enters git.

### T2 — Index + trajectory engine
New modules (`indices.py`, `lifecycle.py`, `trajectory.py`,
`trajectory_cli.py`): market/game/set trimmed-mean log-return indices;
release-age lifecycle library; damped-trend + Theta + shrinkage per-card
forecasts; split-conformal calibrator; packet emitter for 30/90-day
horizons (calendar days, mapped onto the weekly grid).
**Complete when:**
- Deterministic: same panel input → byte-identical packet hash (test).
- Synthetic-series unit tests validate: index recovery from constructed
  panels, damped-trend/Theta forecasts against hand-computed values,
  shrinkage limits (n=0 → pure prior; n→∞ → own drift), noncrossing
  quantiles, conformal coverage on synthetic residuals.
- Full covered-universe run completes on this host ≤ 45 min and emits one
  packet per covered variant with q10–q90 + weekly median path checkpoints.
- `npm run test:analytics` green.

### T3 — Hedonic cold start
Per-category hedonic log-price regression (pure Python OLS on the design
matrix; rarity/finish/release-age/set-family/kind features), blended as the
shrinkage prior; ablation row reproducing `video_model_v0` inputs.
**Complete when:**
- Out-of-sample (held-out sets) hedonic RMSE/R² reported per category in a
  committed receipt; cold-start variants (zero history) receive packets
  with confidence label `cold-start` and widened conformal bands.
- Unit tests cover design-matrix construction, singular-matrix fallback,
  and the blend weights; `npm run test:analytics` green.

### T4 — Walk-forward evaluation gate
Run the panel through walk-forward evaluation vs all five baselines
(no-change, damped momentum, market index, lifecycle cohort, structural
convergence) using existing `evaluation.py` machinery, ≥ 6 origins per
horizon, grouped by category and price tier.
**Complete when, per served category** (all measured out-of-fold):
- log-return MAE lift over no-change > 0 at 30d and 90d;
- direction accuracy > 52% on variants that moved ≥ 5%;
- 80% band empirical coverage in [75%, 88%]; pinball(q50) beats no-change.
- A scorecard receipt (JSON + markdown summary) is committed under
  `docs/receipts/trajectory-v1/`; any failing category is listed as
  **excluded from serving** — that is a valid, reportable outcome, not a
  task failure. If ALL categories fail, STOP: supervisor reports to Kevin.

### T5 — Publication + worker serving
Compact per-group forecast packets (bounded ≤ 128 KiB per object, matching
existing page limits) published to R2 under the current catalog publication
layout (new `forecasts/` prefix + manifest + sha256 receipts) via the
existing publication tooling; `cloudflare/tcgcsv-refresh` worker serves
`GET /catalog/forecasts/<categoryId>/<groupId>` anonymously under
`CATALOG_PUBLIC_ACCESS`, same headers/CORS/limits as other catalog routes.
**Complete when:**
- Packet schema documented in the PRD appendix section of the final PR;
  includes per-variant: q10–q90 at 30/90d, median weekly path (downsampled
  ≤ 32 points), asOf, modelVersion `trajectory-v1`, confidence label,
  coverage stats pointer.
- Worker unit tests (`npm run test:tcgcsv-refresh`) cover the new route:
  anonymous 200 under public access, 404 unknown group, size bounds,
  no `/v1/*` regression; `wrangler deploy --dry-run` (npm script) passes.
- R2 upload executed and verified by reading back one packet per category
  through the production worker URL (after supervisor deploys).

### T6 — App integration
Hydrate forecast packets for TCGCSV variants (fetch per visible group,
cached in IndexedDB with TTL) into the existing intelligence display
contract so `marketOutlookMarkup`, card detail, quick inspector, insights,
and portfolio outlook render real predicted prices; add a trajectory chart
(existing SVG chart helpers) showing history + median path + band on the
price-intelligence detail view; demote `local-scenario-v1` to
manual/custom items only, relabeled "Manual scenario"; excluded cohorts
show "insufficient evidence", never a band.
**Complete when:**
- Zero new browser dependencies; packets rendered read-only.
- Unit tests for the packet client (parse/validate/reject oversized or
  crossing quantiles) and view-model mapping; Playwright spec stubs a
  packet and asserts predicted price + trajectory render on detail and
  outlook estimates appear on a browse result card.
- `npm run check` and `npx playwright test` green locally.

### T7 — Release
Version bump (rotate SW cache, full established bump pattern), CHANGELOG
note in README if present, final receipts, PR(s) to `main` with CI green.
**Complete when:**
- `npm run check:all` green; CI green on the PR(s).
- Supervisor/Kevin merges; Netlify deploy workflow succeeds; worker
  deployed via wrangler to production; live verification: production site
  serves the new app version, `GET /catalog/forecasts/...` returns 200
  anonymously, and a covered card's detail view shows a predicted price.
- Live receipts appended to `docs/receipts/trajectory-v1/`.

## 5. Global acceptance criteria (feature-level definition of done)
1. A covered card's detail view shows: predicted price at 30d and 90d
   (currency amounts), a trajectory line with band, confidence label,
   model version, and the not-advice notice.
2. Every displayed number traces to the committed scorecard receipt for
   its category; excluded categories visibly say so.
3. The generic ±% local scenario no longer appears for covered variants.
4. All tests green (node, analytics, worker, browser) and production
   endpoints verified live.

## 6. Lane operating rules
- Work only on branch `agent/trajectory-v1`, one task at a time, in order.
- Never run `git push`, `gh pr merge`, `wrangler deploy` (non-dry-run), or
  any R2 mutation without the supervisor's explicit go in the task brief.
- Keep tool output lean: sample large files with head/grep, never cat
  whole archives; long downloads run in background with progress receipts.
- No new dependencies (npm or pip). Python is stdlib-only; app is
  framework-free ES modules.
- On any gate failure or ambiguity: stop, report `status: blocked` with
  evidence — do not improvise around a gate.
- Report each task completion as: what changed (files), how verified
  (commands + results), receipts written, deviations from this PRD.
