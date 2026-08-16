# Authenticated full TCGCSV catalog production receipt

**Date:** August 16, 2026

## Promoted source and publication

- Source build: `2026-08-15T20:05:57.000Z`
- Sealed R2 run: `36f693e6-6800-4c0f-80a3-8bb3eb5c3c5d`
- Publication: `be9c5618c036b6de0ef3f31898115ff8ec695cf57fab5eee10c356096b0b45d7`
- Promoted at: `2026-08-16T09:10:40.394Z`
- Private bucket: `collectfolio-tcgcsv-current`
- Worker version: `18f43126-eaed-431d-8794-90b923a6fad5`
- Worker URL: `https://collectfolio-tcgcsv-refresh.kevinyang331.workers.dev`
- Schedule: hourly at minute 0 UTC

The promoted manifest contains 192 hash-verified assets totaling 1,012,744,937
bytes. Its 10,253 product/search ranges are no larger than 131,072 bytes.
The Worker verified the exact manifest object set, every R2 object size and
SHA-256 receipt, and the sealed source-run identity before atomically updating
the current pointer.

## Complete catalog counts

- 90 categories
- 3,717 groups
- 449,968 products
- 414,947 priced products
- 35,021 unpriced products retained
- 527,618 finish-price rows
- 8,510 search prefixes

One deterministic mapping sample was `Ambassador Oak` in `Morningtide`, with
Foil market/mid/low/high/direct-low values of $0.42/$0.46/$0.22/$3.99/$0.42.
The same serving path retained the unpriced `Morningtide Theme Deck - "Going
Rogue"` with a null display price rather than zero or a borrowed value.

## Release and deployment

- Release commit: `185479d` (`Add authenticated full TCGCSV catalog`)
- Merge commit: `888c387510988d2c0724aceafb7e458f473ad3ce`
- Pull request: [#19](https://github.com/kaywhy331/CollectFolio/pull/19)
- Netlify site: `collectfolio-staging` (`05b0e479-ad35-4466-a5c0-fa40d93d1a77`)
- Netlify deploy: `6a818004a3bffe6effe1213f`
- Production URL: `https://collectfolio-staging.netlify.app`

The deployed runtime identifies app `0.8.6`, service-worker shell
`collectfolio-shell-v0.8.6`, the production catalog/status Worker URLs, and a
configured Supabase browser key. The TCGCSV provider module is present and
contains the `authenticated-private-test` entitlement contract.

## Verification

- `npm run check`: 343 Node tests and 337 analytics tests passed; 5 analytics
  tests were skipped; the production build completed.
- Focused catalog/Worker/browser policy suite: 42 tests passed.
- Wrangler generated types check and production dry-run passed; the deployed
  bundle is 76.01 KiB (15.79 KiB gzip) with a 3 ms startup time.
- GitHub PR browser, validation, analytics, and market-universe checks passed.
- Post-merge refresh workflow run
  [31938658786](https://github.com/kaywhy331/CollectFolio/actions/runs/31938658786)
  succeeded and correctly no-op'd for the already-current source build.
- Live `/status` reports the exact sealed source build as current.
- Live anonymous `/catalog/summary` returns HTTP 401.
- Hosted Chromium passed 23 functional/accessibility/service-worker scenarios.
  Its sole pixel-baseline mismatch was expected: production renders the live
  `Market data is current` status banner while the local empty-config baseline
  intentionally has no refresh endpoint. The same snapshot passed in CI.

A real signed-in catalog request still requires a human Supabase session; no
user password, access token, or confirmation email was available to the
deployment operator. The live authorization boundary therefore remains
fail-closed until the collector signs in and performs the final session-backed
smoke check. Unit and Worker tests cover bearer forwarding, Supabase user
validation, pagination, product detail, search, every price field, and 401
behavior.

The R2 bucket has no public domain. Coordinator and Supabase validation secrets
remain Worker/GitHub secrets and are not present in the Netlify browser runtime
or repository.
