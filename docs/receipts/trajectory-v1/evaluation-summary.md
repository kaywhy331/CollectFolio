# trajectory-v1.1 -- causal rolling held-out-set validation

Per (category x horizon): deployment coefficients `(a, c, b)` are selected from
matured non-overlapping blocks. Validation is independently rolling and leaves
each scored set out of coefficient selection and conformal calibration.

## Selected weights

| Category | Horizon (d) | a common | c reversion | b drift | Fit lift | Fit n | Fit blocks |
|---|---|---|---|---|---|---|---|
| 1 | 30 | 0.25 | 0.0 | 0.0 | 2.8735112774779703e-05 | 297004 | 16 |
| 1 | 60 | 1.0 | 0.0 | 0.0 | 0.0005206449996335411 | 129327 | 7 |
| 1 | 90 | 1.0 | 0.0 | 0.0 | 0.0006067088433157389 | 72973 | 4 |
| 2 | 30 | 0.0 | 0.0 | 0.0 | 0.0 | 303728 | 16 |
| 2 | 60 | 0.0 | 0.0 | 0.0 | 0.0 | 132295 | 7 |
| 2 | 90 | 0.0 | 0.0 | 0.0 | 0.0 | 74920 | 4 |
| 3 | 30 | 1.0 | 0.0 | 0.0 | 0.00039078398193975576 | 292488 | 16 |
| 3 | 60 | 1.0 | 0.0 | 0.0 | 0.0017757114104927213 | 127447 | 7 |
| 3 | 90 | 1.0 | 0.0 | 0.0 | 0.002340681503796134 | 71795 | 4 |
| 85 | 30 | 0.0 | 0.0 | 0.0 | 0.0 | 201523 | 16 |
| 85 | 60 | 0.25 | 0.0 | 0.0 | 3.205329329666894e-05 | 84667 | 7 |
| 85 | 90 | 0.5 | 0.0 | 0.0 | 0.00045860099205526815 | 44654 | 4 |

## Holdout gate: pass/fail per (category x cohort x horizon)

| Category | Cohort | Horizon (d) | n | Blocks | Sets | MAE lift | Macro set lift | Bootstrap lower90 | No-harm sets | Coverage80 | Evidence tier | Pass |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | insufficient-history | 30 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | range-only | False |
| 1 | insufficient-history | 60 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | range-only | False |
| 1 | insufficient-history | 90 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | range-only | False |
| 1 | low-history | 30 | 2483 | 14 | 23 | 0.001987 | -0.0011622626409420382 | -0.0032154981847966006 | 0.8695652173913043 | 0.8103 | range-only | False |
| 1 | low-history | 60 | 721 | 5 | 10 | 0.001995 | -0.010694165418522323 | -0.07733121824006293 | 0.6 | 0.8017 | range-only | False |
| 1 | low-history | 90 | 326 | 2 | 5 | 0.032045 | 0.013058297579958023 | -0.008787326248077194 | 1.0 | 0.7423 | range-only | False |
| 1 | standard | 30 | 261630 | 14 | 260 | 0.000026 | 5.122578779483845e-05 | -3.6555108290278916e-05 | 1.0 | 0.8149 | range-only | False |
| 1 | standard | 60 | 93767 | 5 | 257 | 0.000530 | 0.0005674927680324997 | -2.689606852156417e-05 | 0.9961089494163424 | 0.8141 | range-only | False |
| 1 | standard | 90 | 37262 | 2 | 250 | -0.000063 | -6.582690061836755e-05 | -0.000888721428606709 | 0.98 | 0.7942 | range-only | False |
| 2 | insufficient-history | 30 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | range-only | False |
| 2 | insufficient-history | 60 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | range-only | False |
| 2 | insufficient-history | 90 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | range-only | False |
| 2 | low-history | 30 | 1703 | 14 | 18 | 0.000000 | 3.556420818342529e-18 | -5.1194612344992266e-17 | 1.0 | 0.8191 | range-only | False |
| 2 | low-history | 60 | 576 | 5 | 10 | 0.000000 | 3.1310553894524447e-18 | -1.1866479050353237e-17 | 1.0 | 0.7431 | range-only | False |
| 2 | low-history | 90 | 180 | 2 | 4 | 0.017233 | -0.006690910387515632 | -0.017842427700041734 | 0.75 | 0.6333 | range-only | False |
| 2 | standard | 30 | 267012 | 14 | 312 | 0.000000 | 1.62947321775076e-17 | 1.535631431099296e-17 | 1.0 | 0.7974 | range-only | False |
| 2 | standard | 60 | 95557 | 5 | 311 | 0.000000 | 4.818860649431596e-18 | 7.854247943168611e-19 | 1.0 | 0.7978 | range-only | False |
| 2 | standard | 90 | 38115 | 2 | 306 | -0.000067 | -4.814260112401771e-05 | -0.00029429762929630745 | 0.9967320261437909 | 0.7902 | range-only | False |
| 3 | insufficient-history | 30 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | range-only | False |
| 3 | insufficient-history | 60 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | range-only | False |
| 3 | insufficient-history | 90 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | range-only | False |
| 3 | low-history | 30 | 2976 | 14 | 12 | 0.006407 | -0.0030952279970297724 | -0.017050770159526045 | 0.9166666666666666 | 0.6589 | range-only | False |
| 3 | low-history | 60 | 556 | 5 | 5 | -0.041902 | -0.03455547179130386 | -0.15270089496543388 | 0.6 | 0.6817 | range-only | False |
| 3 | low-history | 90 | 240 | 2 | 2 | 0.025359 | -0.05565022174094808 | -0.11130044348189616 | 0.5 | 0.6417 | range-only | False |
| 3 | standard | 30 | 257610 | 14 | 162 | 0.000304 | 0.0001762316681356251 | -1.859179503567085e-05 | 1.0 | 0.7995 | range-only | False |
| 3 | standard | 60 | 92527 | 5 | 160 | 0.001996 | -0.0001807497678241754 | -0.0026217375776649322 | 0.975 | 0.7953 | range-only | False |
| 3 | standard | 90 | 36765 | 2 | 157 | 0.002687 | -0.0006001718668808235 | -0.007848741053146783 | 0.9808917197452229 | 0.7780 | range-only | False |
| 85 | insufficient-history | 30 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | range-only | False |
| 85 | insufficient-history | 60 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | range-only | False |
| 85 | insufficient-history | 90 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | range-only | False |
| 85 | low-history | 30 | 9557 | 14 | 98 | 0.000000 | 5.051715771258458e-17 | 5.075597451824653e-17 | 1.0 | 0.8209 | range-only | False |
| 85 | low-history | 60 | 2957 | 5 | 27 | 0.006608 | 0.005879676471310209 | -0.0002153991331299087 | 1.0 | 0.7650 | range-only | False |
| 85 | low-history | 90 | 1341 | 2 | 6 | 0.007322 | 0.023652695214931168 | -0.0005717299750884493 | 1.0 | 0.7211 | range-only | False |
| 85 | standard | 30 | 183197 | 14 | 224 | 0.000000 | 3.506124084547613e-17 | 3.2253929962523993e-17 | 1.0 | 0.7588 | range-only | False |
| 85 | standard | 60 | 65991 | 5 | 216 | -0.000010 | 6.0585186383337e-05 | -0.00016730344523326946 | 1.0 | 0.7417 | range-only | False |
| 85 | standard | 90 | 25516 | 2 | 196 | 0.000334 | 0.00016900066175798656 | -9.018835490938111e-05 | 1.0 | 0.7250 | range-only | False |

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
| 3 | standard | False |
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

## Near-miss notes (informational; failed horizons remain range-only)

- none

cold-start: no observed current-price anchor exists. Hedonic output is published
only as an attribute-based reference range, never as a directional forecast.
