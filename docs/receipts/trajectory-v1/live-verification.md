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

# 0.8.15 — forecast display everywhere + 90d-only mode (2026-08-17, second release)

- PR #37 merged 3cf75306; Netlify live at APP_VERSION "0.8.15".
- Root cause of "forecasts only on portfolio": production Supabase flag public_price_intelligence=false gated all trajectory hydration. Trajectory forecasts now run on their own default-on kill switch (trajectory_forecasts row can disable) — decoupled from the cloud-published-intelligence rights gate.
- Hydration now covers search results, browse products, holdings, watchlist, and the open detail item.
- 90d-only serving mode ENABLED for Magic(1)/YuGiOh(2) standard cohorts per Kevin's 2026-08-17 directive (curated allowlist; both pass every gate criterion at 90d).
- R2 republish: 1,532/1,532 objects (one transient failure retried successfully; manifest uploaded last).
- Live checks: manifest servedHorizonsByCategory {1:{standard:[90]},2:{standard:[90]},3:{standard:[30,90]},85:cold-start-only}; cat1 group 100: 514 standard variants carry ONLY horizon 90 (sample q50@90 $192.71 vs lastKnown $211.50), cold-start keeps 30+90; cat3 group 1367 standard keeps 30+90.
- Newly eligible variants: cat1 163,197; cat2 60,460 (was 4,710/213 cold-start-only).
