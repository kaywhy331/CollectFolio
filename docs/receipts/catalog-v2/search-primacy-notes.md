# catalog-v2 B3 -- search primacy notes

Executor lane spot-check receipts for B3 (search primacy). Generated
2026-08-17 against the app-layer code change (`searchCatalog` in
`app/assets/js/services/catalog.js`) and the real B2 bridge tables already
committed at `2216b68` (`analytics/data/bridge/bridge/{1,2,3}.json.gz`).

No live worker request was made from this lane (lane rule: no deploy/live
verification) -- the checks below are code-level (unit + Playwright) and
against the locally-committed bridge/panel data. Live `/catalog/search`
result-quality verification against the deployed worker is the
coordinator's B5 step.

## Code-level change verified

`searchCatalog` now excludes `pokemon`/`scryfall`/`ygoprodeck` from
provider selection whenever the requested category is a flagship game
(`pokemon`/`magic`/`yugioh`) -- including `category: 'all'`, and
**regardless of an explicit `provider` request** (matches
`docs/CATALOG_TCGCSV_PRIMARY_PRD.md` B3: "secondary providers ... do not
introduce products without TCGCSV identity for the flagship games", stated
unconditionally). Confirmed by
`tests/providers.test.js` -- "search primacy (B3): flagship categories
never select secondary providers, in automatic or explicit-provider mode"
-- which asserts every outbound fetch for `category: 'pokemon'` (automatic
and `provider: 'pokemon'` explicit) and `category: 'all'` hits only the
TCGCSV catalog host, never `pokemontcg.io`/`scryfall.com`/`ygoprodeck.com`.

Detail/refresh routing for pre-existing holdings and watches
(`catalogRouteId`, `getCatalogRouteItem`, `refreshCatalogItem`) is
untouched -- the `providers` registry keeps every provider's `detail`
fetcher wired. Spot-checked live by the existing (unmodified, still
passing) `tests/e2e/phase5.spec.js` scryfall detail-route test.

## Known-card spot checks (per flagship category, against the committed B2 bridge)

| Category | Card | Provider id | In bridge (`providerCardId`)? |
|---|---|---|---|
| Pokemon (3) | Charizard, Base Set #4 | `base1-4` | Yes |
| Pokemon (3) | Pikachu, Base Set #58 | `base1-58` | Yes |
| Yu-Gi-Oh! (2) | Blue-Eyes White Dragon, LOB-001 | `89631139:LOB-001` | Yes |
| Magic (1) | Lightning Bolt, M11 #149 | `e768c957-3a1f-42f5-853a-96942f645df5` (fetched live from `api.scryfall.com/cards/named`) | Yes |
| Magic (1) | Black Lotus, Alpha (LEA) #232 | `b0faa7f2-b547-42c4-a810-839da50dadfe` | No -- LEA (1993) predates TCGCSV's TCGplayer-SKU catalog; expected, not a regression (matches the committed `no-candidate` unmatched reasons in `bridge-coverage-summary-1.md`) |

These four "yes" rows are cards a normal flagship search (name + number)
resolves to a TCGCSV identity with a mapped enrichment card behind it --
i.e. exactly the B3 "done when" bar (search results are TCGCSV-identified,
enrichment visible where mapped). The one "no" row is an expected fail-closed
absence (pre-TCGCSV-catalog print), not a matcher defect.

## Behavior deltas a user would notice

1. **Search results for Pokémon/Magic/Yu-Gi-Oh! are now TCGCSV items.**
   Prices and trajectory forecasts attach natively (previously only browse
   items did, per B1); a mapped card additionally shows a
   "enriched from <provider>" note + higher-res image on its detail view,
   identical to a browse-originated result (same lazy enrichment path,
   `services/catalog-enrichment.js`, unmodified -- verified by the
   still-passing `tests/e2e/catalog-enrichment.spec.js`).
2. **The "Market source" advanced filter's Pokémon/Magic/Yu-Gi-Oh! options
   are removed** (`app/assets/js/views/search.js`). They only ever
   searched a single flagship category each, and per the PRD's
   unconditional wording those providers no longer introduce flagship
   search results at all -- keeping the options would have offered a
   selection that always returned zero results. "Automatic" and "TCGCSV
   games" remain.
3. **Scan/image-search candidate recovery** (`services/scan-review.js`'s
   `searchCatalogCandidates`, used by the "Search from an image" / add
   flow) calls `searchCatalog({ query })` with no category (`'all'`), so it
   now resolves flagship cards to TCGCSV identity too -- previously it
   could resolve the same physical card to a secondary-provider identity.
   This is the intended consistency fix (a card found via scan and a card
   found via browse now converge on the same identity); the OCR
   query-relaxation Playwright spec (`tests/e2e/image-search.spec.js`) was
   updated to stub `/catalog/search` in place of `pokemontcg.io` and still
   passes with the same relaxation contract (over-specific query misses,
   relaxed query recovers a candidate).
4. **Watchlist orphan risk, addressed.** A watch created before B3 under a
   secondary-provider identity (e.g. `pokemon:base1-4`) is no longer the
   watchKey a fresh flagship search will reproduce (search now returns
   `tcgcsv:3:<groupId>:<productId>`). Added a scoped compat fallback,
   `legacyProviderWatchMatch` in `app/assets/js/services/watchlist.js`,
   invoked as the last resort inside `findWatchedItem`: a new TCGCSV result
   with no exact/legacy watchKey match is checked against existing watches
   that still carry a legacy provider identity, matched on
   name+set+number+condition-class. Covered by two new fixture tests in
   `tests/watchlist.test.js` (resolves the same card across providers;
   never crosses two distinct cards). Note this is a *display-time*
   resolution (the stored watchKey itself is not rewritten) -- it finds the
   right existing watch to show as "Watching" and to edit, it does not
   silently migrate the stored record. That's consistent with B1's
   documented precedent (old provider-slug set bookmarks also don't
   auto-migrate) and is called out here explicitly as requested.

## Files changed

- `app/assets/js/services/catalog.js` -- `FLAGSHIP_GAMES` + provider
  selection filter.
- `app/assets/js/views/search.js` -- removed dead secondary-provider
  "Market source" options.
- `app/assets/js/services/watchlist.js` -- `legacyProviderWatchMatch` +
  `findWatchedItem` fallback wiring.
- `tests/providers.test.js` -- outage/retry test repointed at `tcgcsv`
  (the category it now actually selects); new search-primacy unit test.
- `tests/watchlist.test.js` -- two new legacy cross-provider fixture tests.
- `tests/e2e/image-search.spec.js` -- OCR-relaxation spec repointed at a
  stubbed `/catalog/search` instead of `pokemontcg.io`.
- `docs/receipts/catalog-v2/search-primacy-notes.md` -- this file.

## Test results

- `node --test tests/*.test.js`: 394 passed, 0 failed.
- `npx playwright test tests/e2e/image-search.spec.js tests/e2e/catalog-enrichment.spec.js tests/e2e/browse-sets.spec.js`: 9 passed, 0 failed.
- Analytics regression (`PYTHONPATH=analytics/src python3 -m pytest analytics/tests/ -q`): unaffected by this task (no analytics files touched); left at its prior-round baseline of 621 passed / 5 skipped.
