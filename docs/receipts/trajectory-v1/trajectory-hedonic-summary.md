# trajectory-v1 — T3 hedonic cold-start fit + full-universe re-run summary

- Generated at: 2026-08-17T13:02:46Z (supervisor-run, harness-tracked)
- Fits: `fit-hedonic` per category, products metadata cache `analytics/data/hedonic/products_metadata.json.gz` (10.8 MB, rarity coverage 93.7–98.2%)
- Total fit wall clock: 407.2 s; peak fit RSS 539 MB (≤ 1.5 GB ceiling)
- Full-universe `run-category` re-run with hedonic blend + cold-start inputs: 309,273 packets (301,661 with history + 7,612 cold-start), 61.6 MB, 338.9 s, peak RSS 439 MB, 0 rejects

## Main hedonic model (held-out-SETS 5-fold CV, log-price)

| Category | n | Groups | Features | Holdout RMSE | Holdout R² | Intercept-only fallback |
|---|---|---|---|---|---|---|
| 1 (Magic) | 161,852 | 442 | 28 | 1.2948 | 0.5537 | no |
| 2 (YuGiOh) | 61,113 | 615 | 37 | 1.1572 | 0.5583 | no |
| 3 (Pokémon) | 46,331 | 213 | 39 | 1.3184 | 0.6946 | no |
| 85 (Pokémon JP) | 32,365 | 442 | 38 | 1.0622 | 0.6769 | no |

## video_model_v0 ablation row (research-only; proxy features — see per-category receipts' proxyNotes)

| Category | Holdout RMSE | Holdout R² |
|---|---|---|
| 1 | 1.9572 | −0.0197 |
| 2 | 1.7152 | 0.0296 |
| 3 | 2.2086 | 0.1429 |
| 85 | 1.6868 | 0.1851 |

The 2-proxy video_model_v0 form is decisively worse than the full hedonic model in every category, confirming it as an ablation baseline only.

## Cold-start packets

| Category | Cold-start packets | Content hash (packets) |
|---|---|---|
| 1 | 4,710 | `e6302f8a318d` |
| 2 | 213 | `ec8681388e02` |
| 3 | 561 | `af059e35ec9f` |
| 85 | 2,128 | `5cb0f6db97f8` |

Spot-check (category 1): cold-start packet has `confidence: "cold-start"`, no lastKnownPrice/date, noncrossing quantiles, and bands ~2× wider (relwidth 0.85 @30d / 2.63 @90d) than a comparable standard packet (0.42 / 1.34) via COLD_START_BAND_WIDEN_FACTOR on the widest calibrated pool.

## Tracked concerns → enforced at T4 (evaluation gate) / T6 (display)

1. **Staleness** (carried from T2): stale-series variants can still carry `standard` confidence; staleness-based degradation is a required T4 criterion and a T6 display rule.
2. **low-history band blowout**: sampled low-history packet shows 90d relwidth ≈ 236 (q90 $64,294 on a $680 card). Honest but unserveable; cohort must pass T4 or be excluded fail-closed.
3. **Level-blend dominance at low n**: sampled insufficient-history variant with lastKnownPrice $81,421 gets a hedonic-dominated median ≈ $111 (n/(n+n0) log-level blend). Possibly correcting a one-off misprice, but the cohort must demonstrate walk-forward accuracy at T4 or be excluded from serving.
