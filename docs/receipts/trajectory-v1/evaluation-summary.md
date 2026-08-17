# trajectory-v1 -- T4 remediation: component-weight selection + honest holdout gate

Per (category x horizon): weights `(a, b)` selected by grid search on TRAINING
origins only (minimizing standard-cohort MAE), then gated on HOLDOUT origins only
with conformal offsets calibrated from TRAINING origins only -- see
`trajectory_eval.select_component_weights` / `gate_holdout_evaluation`.

## Selected weights

| Category | Horizon (d) | a | b | Train lift | Train n | Train origins | Holdout origins |
|---|---|---|---|---|---|---|---|
| 1 | 30 | 0.0 | 0.0 | 0.0 | 221313 | 12 | 8 |
| 1 | 90 | 0.25 | 0.0 | 0.001483327942348872 | 220438 | 12 | 8 |
| 2 | 30 | 0.25 | 0.0 | 9.505884331154069e-05 | 226499 | 12 | 8 |
| 2 | 90 | 0.5 | 0.0 | 0.0003638481944089611 | 225863 | 12 | 8 |
| 3 | 30 | 0.0 | 0.0 | 0.00047471599875674453 | 217713 | 12 | 8 |
| 3 | 90 | 1.0 | 0.0 | 0.002915369014760749 | 216358 | 12 | 8 |
| 85 | 30 | 0.0 | 0.0 | 0.0 | 143642 | 12 | 8 |
| 85 | 90 | 0.0 | 0.0 | 0.0006926537877721961 | 137593 | 12 | 8 |

## Holdout gate: pass/fail per (category x cohort x horizon)

| Category | Cohort | Horizon (d) | n | MAE lift | Direction acc (>=5% movers) | Coverage80 | Pinball beats no-change | Pass | Serving eligible |
|---|---|---|---|---|---|---|---|---|---|
| 1 | insufficient-history | 30 | 0 | n/a | n/a | n/a | False | False | False |
| 1 | insufficient-history | 90 | 0 | n/a | n/a | n/a | False | False | False |
| 1 | low-history | 30 | 355 | 0.000000 | 0.1161 | 0.5408 | False | False | False |
| 1 | low-history | 90 | 53 | -0.002247 | 0.7895 | 0.8679 | False | False | False |
| 1 | standard | 30 | 154181 | 0.000000 | 0.6367 | 0.8126 | False | False | False |
| 1 | standard | 90 | 152533 | 0.007051 | 0.6818 | 0.8039 | True | True | True |
| 2 | insufficient-history | 30 | 0 | n/a | n/a | n/a | False | False | False |
| 2 | insufficient-history | 90 | 0 | n/a | n/a | n/a | False | False | False |
| 2 | low-history | 30 | 136 | 0.045940 | 0.8421 | 0.8603 | True | True | True |
| 2 | low-history | 90 | 44 | -0.002533 | 0.8235 | 0.8864 | False | False | False |
| 2 | standard | 30 | 155826 | -0.000042 | 0.5601 | 0.8107 | False | False | False |
| 2 | standard | 90 | 154563 | 0.001004 | 0.5753 | 0.8074 | True | True | True |
| 3 | insufficient-history | 30 | 0 | n/a | n/a | n/a | False | False | False |
| 3 | insufficient-history | 90 | 0 | n/a | n/a | n/a | False | False | False |
| 3 | low-history | 30 | 383 | -0.002704 | 0.1659 | 0.5274 | False | False | False |
| 3 | low-history | 90 | 112 | -0.014394 | 0.7255 | 0.8661 | False | False | False |
| 3 | standard | 30 | 151865 | 0.001780 | 0.7050 | 0.7964 | True | True | True |
| 3 | standard | 90 | 150009 | 0.021138 | 0.8025 | 0.7961 | True | True | True |
| 85 | insufficient-history | 30 | 0 | n/a | n/a | n/a | False | False | False |
| 85 | insufficient-history | 90 | 0 | n/a | n/a | n/a | False | False | False |
| 85 | low-history | 30 | 1180 | 0.000000 | 0.5602 | 0.9356 | False | False | False |
| 85 | low-history | 90 | 594 | -0.001819 | 0.6198 | 0.9276 | False | False | False |
| 85 | standard | 30 | 122232 | 0.000000 | 0.5464 | 0.8449 | False | False | False |
| 85 | standard | 90 | 114944 | -0.003154 | 0.4964 | 0.8603 | False | False | False |

## Serving-eligibility conclusions

| Category | Cohort | Serving eligible |
|---|---|---|
| 1 | insufficient-history | False |
| 1 | low-history | False |
| 1 | standard | False |
| 2 | insufficient-history | False |
| 2 | low-history | False |
| 2 | standard | False |
| 3 | insufficient-history | False |
| 3 | low-history | False |
| 3 | standard | True |
| 85 | insufficient-history | False |
| 85 | low-history | False |
| 85 | standard | False |

## Variant sampling (no silent caps)

| Category | Total variants | Sampled variants | Sampling applied |
|---|---|---|---|
| 1 | 161852 | 20000 | True |
| 2 | 61113 | 20000 | True |
| 3 | 46331 | 20000 | True |
| 85 | 32365 | 20000 | True |
- Category 1: metrics are computed on a deterministic 20000-of-161852 variant sample (deterministic N-of-M variant sample: every (productId, subTypeName) key is ranked by sha256(f'{productId}|{subTypeName}')'s hex digest (ties broken by the key itself), and the first N in that ranking are kept -- order-independent (depends only on the key set, not on load order) and exactly reproducible.).
- Category 2: metrics are computed on a deterministic 20000-of-61113 variant sample (deterministic N-of-M variant sample: every (productId, subTypeName) key is ranked by sha256(f'{productId}|{subTypeName}')'s hex digest (ties broken by the key itself), and the first N in that ranking are kept -- order-independent (depends only on the key set, not on load order) and exactly reproducible.).
- Category 3: metrics are computed on a deterministic 20000-of-46331 variant sample (deterministic N-of-M variant sample: every (productId, subTypeName) key is ranked by sha256(f'{productId}|{subTypeName}')'s hex digest (ties broken by the key itself), and the first N in that ranking are kept -- order-independent (depends only on the key set, not on load order) and exactly reproducible.).
- Category 85: metrics are computed on a deterministic 20000-of-32365 variant sample (deterministic N-of-M variant sample: every (productId, subTypeName) key is ranked by sha256(f'{productId}|{subTypeName}')'s hex digest (ties broken by the key itself), and the first N in that ranking are kept -- order-independent (depends only on the key set, not on load order) and exactly reproducible.).

## Near-miss notes (informational; ENABLED entries are explicitly reviewed serving decisions)

- Category 1, standard cohort: passes 90d only (30d fails) -- ENABLED 2026-08-17 as 90d-only serving mode per Kevin's 'forecasts should be for all products' directive.
- Category 2, standard cohort: passes 90d only (30d fails) -- ENABLED 2026-08-17 as 90d-only serving mode per Kevin's 'forecasts should be for all products' directive.

cold-start: unevaluable by construction (no walk-forward truth exists for variants
with zero observed prices anywhere in the panel) -- serve only with explicit
cold-start labeling per PRD Sec4 hard criterion 3b.
