# trajectory-v1 — T7 live verification (2026-08-17)

## Merges
- PR #33 (feature, v0.8.13) merged: bacec8302da2, 2026-08-17T17:37:07Z; CI: analytics/browser/check/market-universe all pass.
- PR #34 (deploy-workflow APP_VERSION fix) merged: 8c73c4ba45a9 — netlify-deploy.yml hardcodes APP_VERSION and was missed by the multi-file bump pattern (now part of the bump set).

## Deploys
- Netlify (GitHub Actions "Deploy to Netlify" on main): success; live runtime-config.js reports APP_VERSION "0.8.13".
- Worker collectfolio-tcgcsv-refresh deployed to production, version 8a2aaea2-a6df-4cd6-a53f-e0e9e5630222.
- R2 upload: 638/638 objects (637 group objects + manifest) to collectfolio-tcgcsv-current under forecasts/, 0 failures.

## Live endpoint checks (https://collectfolio-tcgcsv-refresh.kevinyang331.workers.dev)
| Check | Result |
|---|---|
| GET /catalog/forecasts/manifest | 200 application/json; modelVersion trajectory-v1; categories 1/2/3/85; cat3 eligibleVariants 45,572 |
| GET /catalog/forecasts/3/2464 (eligible) | 200, 89,700 B (≤128KiB) |
| GET /catalog/forecasts/3/2374.part2 (multi-part) | 200 |
| GET /catalog/forecasts/1/999999 (unknown/excluded) | 404 |
| Netlify runtime-config.js | APP_VERSION "0.8.13" |

Serving state per the T4 fail-closed gate: cat3 standard cohort + cold-start (labeled) everywhere; all other cohorts excluded ("insufficient evidence" in-app).

# 0.8.17 — deep-link fix, history bar charts, portfolio trend (2026-08-18)

- PR #41 merged aa0f1420 (one CI round-trip: the new portfolio module's heading/coverage phrasing collided with protection-baseline strict-mode locators; fixed by rewording, 38/38 test:browser green). Netlify live at APP_VERSION "0.8.17".
- History publication: publish-history run over the 80-week panel — 1,832 objects / 301,780 variants / 65MB, 17.9 min, 1.1GB peak RSS; 1,832/1,832 uploaded to R2 under history/ (manifest last), 0 failures. Worker deployed (version ccb28570) with /catalog/history routes.
- Live checks: history manifest 200; history/2/24621 200 (183 variants; product 695695 '1st Edition' has 11 weekly points 2026-05-30 $1,299.00 → 2026-08-08 $1,196.63); unknown group 404; forecasts routes unaffected.
- The user-reported card (/cards/tcgcsv:2:24621:695695) now has: deep-link forecast hydration (bug fixed + regression test), a served 90d forecast, and history chart data live.
- Note for future gates: CI runs `npm run test:browser` (38 tests) — plain `npx playwright test` runs fewer; always gate with the npm script.
