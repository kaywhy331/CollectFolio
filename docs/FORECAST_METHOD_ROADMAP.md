# Forecast Method Roadmap — from scenario bands to per-card price predictions

Status: **planning baseline, approved method direction pending Kevin's review**
Date: 2026-08-16
Owner: price-intelligence lane

## 1. Problem statement

The user-facing prediction surface today is `local-scenario-v1`
(`app/assets/js/core/local-scenarios.js`): a random-walk drift/volatility band
built from a holding's own sparse local observations plus a fixed prior. Its
median forecast is (approximately) the current price, so it **never attempts a
directional per-card prediction** — it only widens a ±% band. That is exactly
the outcome this roadmap retires:

> A usable prediction states, for a specific card at a specific horizon, a
> **price point** (median expected price), a **trajectory** (the path implied
> by real trend statistics), and a **calibrated band** derived from that
> card's and its cohort's measured residuals — never a generic ±%.

Non-goals: financial advice framing, guaranteed returns, per-user model
training, or shipping any model that has not passed the existing walk-forward
scorecard and promotion governance (`docs/PRICE_INTELLIGENCE_FOUNDATION.md`).

## 2. What already exists (do not rebuild)

| Asset | Location | State |
|---|---|---|
| Research forecast ensemble (`forecast-ensemble-v2`) | `analytics/.../forecast_engine.py` | 30/90-day shadow horizons, residual-calibrated quantiles, research-only |
| Transparent baselines: no-change, damped momentum, market index, lifecycle cohort, structural convergence | `analytics/.../baselines.py` | governance requires all five as comparators |
| Trend primitives: endpoint log returns, Theil–Sen slope, MAD volatility, drawdown, freshness | `analytics/.../trends.py` | deterministic, point-in-time safe |
| Walk-forward evaluation: pinball loss, coverage, MAE/MdAPE/sMAPE, direction, Brier, baseline lift | `analytics/.../evaluation.py`, `walk_forward.py` | rejects future leakage; immutable Scored/Unscorable rows |
| Quantile contract q10/q25/q50/q75/q90, noncrossing | `analytics/.../quantiles.py` | publication precondition |
| Historical import bridge (observed/available/ingested time) | `analytics/.../historical_import.py` | production data plane, bounded runs so far |
| TCGCSV daily archive plan (~450K products, ~500K price series/day) | `docs/TCGCSV_MARKET_UNIVERSE.md` | designed; private R2 raw + Parquet layout |
| Legacy video formula (`log P = 2.4187 + 0.1775·pull_score + 0.3416·desirability`) | `analytics/.../video_model_v0.py` | forensic benchmark only: 22 observations, no out-of-sample validation |
| Client scenario generator | `app/assets/js/core/local-scenarios.js` | to be demoted to fallback for uncovered items |

The gap is not machinery — it is (a) a **method that actually predicts**, (b)
**historical panel data at full-universe scale** to fit and honestly validate
it, and (c) a **serving path** that puts per-card predictions in the product.

## 3. Method research (external evidence)

1. **Global cross-learned models beat per-series models at scale.** The M5
   competition (42,840 related series) was won by pooled LightGBM models;
   cross-learning across correlated series dominated, and the uncertainty
   track's winners produced the required quantiles the same way
   ([M5 accuracy results](https://www.sciencedirect.com/science/article/pii/S0169207021001874),
   [M5 uncertainty results](https://www.sciencedirect.com/science/article/pii/S0169207021001722),
   [practitioner summary](https://medium.com/artefact-engineering-and-data-science/sales-forecasting-in-retail-what-we-learned-from-the-m5-competition-445c5911e2f6)).
   Our card panel is the same shape: hundreds of thousands of correlated
   series that individually are short and noisy but collectively dense.
2. **The strongest per-series statistical trajectories are Theta and damped
   trend exponential smoothing.** Theta won M3 and outperformed ARIMA/ETS as
   an M4 benchmark over 100,000 series; damped trend is the other benchmark
   any method must beat
   ([Theta model](https://www.sciencedirect.com/science/article/abs/pii/S0169207000000662),
   [structural Theta in M4](https://www.sciencedirect.com/science/article/pii/S0169207024000906),
   [Wiley overview](https://onlinelibrary.wiley.com/doi/abs/10.1002/9781118445112.stat08270)).
   These give a real *directional* per-card trajectory from history — not a
   band around today.
3. **Collectible/art econometrics decomposes price into market/index structure
   plus item-level effects.** Repeat-sales indices (Case–Shiller/Mei-Moses
   style) measure market movement from the *same item's* successive prices;
   hedonic regression prices an item from its attributes and is the standard
   cold-start tool; hybrids correct each other's biases
   ([hedonic fine-art pricing](https://www.mdpi.com/2078-2489/11/5/252),
   [hybrid hedonic + repeat-sales](https://www.researchgate.net/publication/325980257_Econometric_Fine_Art_Valuation_by_Combining_Hedonic_and_Repeat-Sales_Information),
   [Heckman repeat-sales](https://www.sciencedirect.com/science/article/abs/pii/S1062976921000053),
   [collectibles hedonic example](https://www.researchgate.net/publication/390059748_Evaluating_collectibles_as_alternative_investments_a_hedonic_pricing_analysis_of_vintage_Hot_Wheels_TM)).
   Because TCGCSV gives us daily marks for the *same* card, our panel supports
   a repeat-sales-style index at every level (market → game → set) with no
   sample-matching loss.
4. **Calibrated intervals come from residuals, not assumptions.** Conformal
   prediction wraps any point forecaster and calibrates bands from held-out
   residuals; time-series variants (split conformal, adaptive conformal,
   EnbPI) handle exchangeability violations
   ([CP for time series benchmark](https://arxiv.org/abs/2601.18509),
   [conformal time-series forecasting](https://proceedings.neurips.cc/paper/2021/file/312f1ba2a72318edaaa995a67835fad5-Paper.pdf)).
   This replaces the fixed ±% prior with bands each card earns from data.
5. **TCG-specific literature says events and cross-sectional features matter.**
   MTG studies found price jumps are frequently event-driven (reprints, bans,
   meta shifts) and that classification of "will it jump" is tractable while
   pure intrinsic-feature regression is weak
   ([Stanford CS229 2014](https://cs229.stanford.edu/proj2014/Matt%20Pawlicki,%20Joe%20Polin,%20Jesse%20Zhang,%20Prediction%20of%20Price%20Increase%20for%20MTG%20Cards.pdf),
   [Springer 2019](https://link.springer.com/chapter/10.1007/978-3-030-29029-0_70),
   [reprint-effect study](https://erlendd.github.io/2017/03/20/predicting-mtg-card-prices-neural-network.html)).
   The YouTube-video formula (pull cost × desirability) is a two-feature
   hedonic regression — the right *family* for cold-start features, but its
   22-observation fit is not a forecaster and does not generalize beyond
   sealed-era Pokémon.

**Conclusion.** No single off-the-shelf formula is "the accurate method." The
evidence converges on a layered architecture: *hierarchical index
decomposition* (collectibles econometrics) + *damped-trend/Theta trajectory
per card* (M3/M4) + *conformal residual quantiles* (calibration) + *hedonic
cross-section for cold start* (art-market practice, generalizing the video's
idea), with a *pooled gradient-boosted global model* (M5) as the challenger
once the panel exists. Every layer is testable against the five governance
baselines we already require.

## 4. Chosen architecture — `trajectory-v1.1`

The production panel is weekly and keyed by exact variant (card × finish ×
source). For card *i* on week *t*: `y_i,t = m_t + g_t + s_t + r_i,t`

- `m_t` — market index: trimmed-mean weekly log-return across all priced
  variants, cumulated (repeat-sales logic on the full panel).
- `g_t` — game/category index relative to market (same construction within
  the TCGCSV category).
- `s_t` — set/cohort index relative to game, aligned on **release age** so
  every set contributes to one lifecycle curve library (hype decay,
  rotation, post-reprint regimes).
- `r_i,t` — the card's residual: what makes this card different from its set.

For nominal horizons 30, 60, and 90 days (4, 9, and 13 weekly steps), the
point forecast is:

`log(P_i,t+h / P_i,t) = a_h F_common + c_h F_reversion + b_h F_drift`

The coefficients are dynamic by category and horizon, not by set: one shared
triple is selected from the preregistered grid `a ∈ {0,.25,.5,1}`,
`c ∈ {0,.1,.25,.5}`, `b ∈ {-.25,0,.25}`. This gives each game and horizon
room to choose its evidence-supported behavior without fitting bespoke set
weights that cannot generalize.

1. Forecast `m` and `g` with damped-trend exponential smoothing on the log
   index. Phi is fixed at `0.85` before evaluation; the Theta SES alpha is
   fixed at `0.3`, preventing full-panel hyperparameter selection leakage.
2. Forecast `s` by blending the set's own damped trend with the release-age
   lifecycle curve of matched historical cohorts (existing `lifecycle_cohort`
   logic, now fitted on the full panel instead of one research cohort).
3. Build `F_reversion` from the trailing 13-week median of the card's
   index-adjusted log level minus its current adjusted level. Forecast `r_i`
   with the Theta method on the card's residual series, with
   empirical-Bayes shrinkage of its drift toward 0 by `n/(n+n₀)` (short or
   flat histories predict little idiosyncratic drift; long trending histories
   keep theirs).
4. **Point prediction** = `exp(ŷ)` of the recombined median at each independent
   checkpoint. No daily or weekly forecast path is manufactured between them.
5. **Band**: split-conformal quantiles from walk-forward residuals pooled by
   (game × volatility bucket × horizon), scaled by the card's own MAD
   volatility; adaptive recalibration as each day's archive matures. Output
   keeps the q10/q25/q50/q75/q90 contract.
6. **Cold start** (no observed anchor): hedonic log-price regression per game —
   rarity, finish, release age, set family, sealed/single kind, scarcity or
   pull-rate features where curated (`pull_rates.py`), subsuming
   `video_model_v0`'s inputs — provides the prior that shrinkage pulls
   toward. It is published only as an `attribute-reference` range, not a
   directional forecast. Low-history or failed horizons become symmetric,
   current-price-centered `range-only` context.

Validation is rolling and causal. Origins are non-overlapping horizon blocks;
every origin-sensitive feature is rebuilt as of the origin; coefficients use
past blocks only; and each scored set is removed from coefficient selection and
conformal calibration. A directional tier requires positive aggregate and
macro held-out-set lift, a positive 90% block/set bootstrap lower bound, three
or more eligible sets with at least 20 variants each, at least 80% of sets above
the no-harm floor, three actual scored blocks, and 80% coverage in `[75%, 88%]`.
This supports a claim about eligible held-out sets, not "all sets."

The 2026-08-21 qualification used all 80 available weekly snapshots and a
deterministic 20,000-variant sample in each of categories 1, 2, 3, and 85.
All 12 standard-cohort category × horizon cells remained `range-only`:
30/60-day lifts were absent or too fragile across time blocks and held-out
sets, and every 90-day cell had only two post-fit score blocks. This is an
empirical result, not a permanent product rule; future runs promote each cell
independently when it clears the same preregistered gate. Full coefficients,
set counts, coverage diagnostics, and failure reasons are in
[`evaluation-summary.md`](receipts/trajectory-v1/evaluation-summary.md).

Event overrides (reprint announced, ban/rotation, grading-pop shifts) are
explicit Phase-6 features, surfaced as flags on the packet before they ever
modify a number.

## 5. Phases

### Phase 1 — Historical panel at full-universe scale
Ingest the TCGCSV daily archive backlog (Feb 2024 → present) through the
`historical_import` contract into private R2 + Parquet per
`docs/TCGCSV_MARKET_UNIVERSE.md`; nightly worker appends each new day.
**Deliverables:** ≥18 months of daily series for every priced variant;
storage-budget receipts; lineage hashes. **Gate:** row/hash reconciliation
against source archives; point-in-time audit passes.

### Phase 2 — Index + trajectory engine (`trajectory-v1.1`)
New pure-Python analytics modules for the index decomposition, lifecycle
library, per-card Theta/damped-trend residual model, and conformal
calibrator; emit full-universe research packets at 30/60/90 days.
**Gate:** deterministic replay (same inputs → same packet hash); synthetic
regression tests; runtime budget for ~500K series per nightly run.

### Phase 3 — Hedonic cold-start + cross-sectional features
Per-game hedonic regressions with out-of-sample validation; shrinkage blend
into `trajectory-v1.1`; `video_model_v0` retired to an ablation row in the
scorecard. **Gate:** cold-start cards get predictions with honest wide bands;
hedonic R² and residual diagnostics recorded per game.

### Phase 4 — Mass walk-forward evaluation + promotion
Run causal, non-overlapping rolling blocks across the archive; scorecards vs
all five baselines and held-out sets; human promotion review per the runbook.
**Acceptance criteria (per category × standard cohort × horizon):**
- aggregate and macro held-out-set log-return MAE lift over no-change > 0;
- 90% block/set cluster-bootstrap lower bound > 0;
- at least three eligible sets (20 variants each), three scored blocks, and
  80% of sets above the preregistered no-harm floor;
- 80% band empirical coverage within 75–88%; q50 remains the point model;
- failures publish only no-direction ranges, never an upgraded point claim.

### Phase 5 — Serving per-card predictions
Nightly worker publishes compact forecast packets (independent checkpoints, quantiles,
model version, confidence, coverage stats) to R2 alongside the catalog;
app renders evidence-qualified points or ranges on card detail, browse,
insights, and portfolio; `local-scenario-v1` demoted to fallback for
custom/manual items only, relabeled "manual scenario." Browser stays
dependency-free — it only renders precomputed JSON.
**Gate:** packet size budget; SW/cache versioning; visible model card and
"model output, not advice" framing preserved.

### Phase 6 — Challenger track + monitoring
Pooled gradient-boosted quantile challenger (M5-style) trained offline on the
panel — requires an explicit dependency decision (LightGBM in the analytics
venv only); event-flag features (reprint/ban/rotation calendars); drift
monitoring and adaptive conformal updates via `monitoring.py`; champion/
challenger per cohort decided by scorecards, never by default.

### Phase 7 — sealed-aware modeling (preregistered)
Recorded ahead of implementation per the 2026-08-26 forecast audit (finding
FA-06), under the same preregistration discipline as the coefficient grid in
Sec 4: each candidate below is a next-phase research direction, not a
standing capability, and none of it may serve a directional claim until it
independently clears the existing walk-forward gate (Sec 4, Phase 4
acceptance criteria). FA-03 already forces every currently served sealed- or
unknown-kind packet to `range-only` at publish time — a structural
downgrade, never a promotion — precisely because none of the following
exists yet.

(a) **Sealed cohort separation** — sealed-only set/category indices (the
    `m_t`/`g_t`/`s_t` decomposition rerun on a sealed-only panel slice, not
    weights borrowed from the singles cohort), sealed lifecycle curves
    (restock/discontinuation regimes differ from a single card's
    release-age hype decay), sealed conformal calibration pools, and
    per-kind promotion cells, so a sealed cohort's evidence tier is judged
    against its own scored blocks, never a singles cohort's.

(b) **Set-EV features for the sealed cohort** — pull-rate-weighted sum of
    the set's singles prices (`pull_rates.py` pull rates ×
    `sealed.py`'s `packs_per_product`), EV momentum (the trailing change in
    that sum), and EV/price ratio (sealed price relative to computed EV) as
    cross-sectional features for the cold-start hedonic prior and,
    pending validation, the sealed trajectory itself.

(c) **Per-kind gating earning its way back up** — the publisher already
    classifies every served variant's `productKind` (single/sealed/unknown)
    and structurally downgrades sealed/unknown packets out of a directional
    tier at publish time (FA-03). This phase is what would let a sealed
    cohort re-qualify for a directional tier on sealed-specific evidence
    scored under (a) and (b), rather than only ever being downgraded.

Every candidate above requires the standard gate before serving: causal
non-overlapping origins, the scored set removed from its own coefficient
selection and conformal calibration, positive aggregate and macro held-out
lift, the 90% block/set bootstrap floor, and 80% coverage in `[75%, 88%]`.
Reference: 2026-08-26 forecast audit, findings FA-03 (serving-contract gate,
already structural) and FA-06 (this preregistration).

## 6. Risks

- **Archive backlog size** (~1.5 GB/yr compressed, millions of rows/day):
  bounded by Parquet compaction + storage budget receipts (Phase 1 gate).
- **Regime shifts** (reprint waves, grading booms): adaptive conformal keeps
  coverage honest even when point error rises; event flags are the durable fix.
- **Sparse/illiquid cards**: shrinkage + hedonic prior prevents fake
  precision; confidence labels stay tied to measured history density.
- **Overfitting the backtest**: all model selection happens inside
  walk-forward folds; the promotion reviewer sees out-of-fold metrics only.
- **Rights boundary**: packets derive from TCGCSV per existing source terms;
  JustTCG/Cardbase enrichment stays behind their unactivated gates.
