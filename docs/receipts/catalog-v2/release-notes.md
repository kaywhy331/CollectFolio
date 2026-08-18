# catalog-v2 release notes (B1-B4, shipping as v0.8.16)

Summary of `docs/CATALOG_TCGCSV_PRIMARY_PRD.md` tasks B1-B4 for the B5
release. Written by the executor lane; B5's own steps (final gates, PR,
merge, R2 bridge upload, worker deploy, live verification) are the
supervisor's and are not covered here.

## What changed for users

- **Flagship browse and search are now TCGCSV-native.** Pokémon, Magic,
  and Yu-Gi-Oh! browse (set pages, cards/sealed tabs) and search results
  are TCGCSV-identified products (`categoryId`/`groupId`/`productId`)
  instead of Pokémon TCG API / Scryfall / YGOPRODeck listings. Prices and
  trajectory-v1 forecasts now attach natively everywhere a flagship card
  appears -- browse and search alike -- because both paths resolve to the
  same TCGCSV identity that pricing/forecasting already key off of.
  Non-flagship TCGCSV categories (e.g. Pokémon Japan) are unaffected;
  they already worked this way.
- **Enrichment notes on mapped cards.** Where a TCGCSV product maps to a
  secondary provider's card through the B2 bridge, its detail view shows
  a "enriched from `<provider>`" note plus that provider's higher-resolution
  image and (where it differs) rarity, filled in lazily only once the
  detail view opens -- never during list/browse hydration. Unmapped
  products render exactly as before: no note, no broken image (fail-closed).
- **"All attributes" disclosure on card detail.** The full card detail
  page now has a collapsed-by-default "All attributes" section (next to
  the existing "Data details" section) exposing the complete TCGCSV
  record for that printing: every `extendedData` attribute the category
  carries beyond what's already shown up top (e.g. Stage, HP, attack
  text), every price subtype (Normal/Holofoil/1st Edition/...) with all
  five TCGPlayer price fields (market/mid/low/high/direct low), and
  group/category identity (category, set/group name, category/group/
  product IDs). A per-attribute visibility config decides what's shown by
  default vs. collapsed -- it never decides what data exists; every field
  the dataset carries is always reachable on the page.

## Bridge match-rate table (B2, from the committed offline mapping receipts)

| Category | Provider | Sets matched | Products matched |
|---|---|---|---|
| 1 -- Magic | Scryfall | 333 / 453 (73.5%) | 78,984 / 94,712 (83.4%) |
| 2 -- Yu-Gi-Oh! | YGOPRODeck | 556 / 658 (84.5%) | 38,512 / 43,842 (87.8%) |
| 3 -- Pokémon | Pokémon TCG API | 160 / 217 (73.7%) | 17,383 / 21,844 (79.6%) |

Source: `docs/receipts/catalog-v2/bridge-coverage-summary-{1,2,3}.md`
(generated 2026-08-17, committed at `2216b68`). Product-level matching is
100% `collector-number` for all three categories -- no name-similarity
fallback was needed at product level; the remainder are `no-candidate`
(usually pre-TCGCSV-catalog prints or provider-only promos) plus a small
`ambiguous` residue (13 Pokémon, 2,562 Yu-Gi-Oh after dedupe, 0 Magic),
which fail closed to no enrichment rather than guessing. Unmatched
products render fine unenriched -- this is a display gap, not a pricing
or forecast gap, since pricing/forecasting key off the TCGCSV identity
directly, not the bridge.

## Behavior deltas users may notice

1. **Old set-level bookmarks for provider slugs no longer resolve.**
   (B1.) A saved/shared URL pointing at a Pokémon-TCG-API-slug or
   Scryfall-slug *set* page from before this change won't resolve to that
   set anymore -- browse now indexes flagship sets by TCGCSV
   `categoryId:groupId`. Game-level URLs (e.g. "Pokémon", "Magic") are
   unaffected and still work. Individual card links already carry
   provider-agnostic routing via `catalogRouteId`/watch-key resolution
   and were not broken by this (see also the watchlist compat note
   below).
2. **The "Market source" advanced search filter lost its
   Pokémon/Magic/Yu-Gi-Oh! options.** (B3.) Those three options each only
   ever searched a single secondary-provider API; since flagship search
   now always resolves through TCGCSV, keeping them would have offered a
   selection that always returned zero results. "Automatic" and "TCGCSV
   games" remain and cover the same ground.
3. **Watches created before B3 stay watched.** A watch stored under an
   old secondary-provider identity (e.g. `pokemon:base1-4`) is resolved
   to the same watch by a fresh TCGCSV search result through a scoped
   display-time compat match (name + set + number + condition class) --
   it's still shown as "Watching," can still be edited/removed, and
   receives alerts as before. The stored watch key itself is not
   silently rewritten, consistent with the set-bookmark precedent above.

## B2 SourceTerms posture

The B2 bridge tables (`analytics/data/bridge/bridge/{1,2,3}.json.gz`,
served by the worker at `/catalog/bridge/<categoryId>`) contain **only
identifiers and mapping metadata**: TCGCSV `(categoryId, groupId,
productId)`, the secondary provider's own card/set identifier, and the
match method that produced the row (`collector-number`, `name-exact`,
`abbreviation-exact`, `name-similarity`). **No provider content
(images, card text, names, prices, or any other provider-owned field) is
stored in or republished from the bridge table.** When a detail view
needs a mapped card's enrichment data, the client fetches it live from
the provider (Pokémon TCG API / Scryfall / YGOPRODeck) at display time,
under that provider's own API terms -- exactly as the app already did
before catalog-v2, just triggered by a TCGCSV-identity lookup instead of
a provider-native search. This keeps the bridge itself free of any
provider-content redistribution concern; it is purely a same-card
correspondence table.

## Test results as of this receipt

- `node scripts/validate.mjs`: passed (183 required files, version
  0.8.16 consistent across `package.json`/`package-lock.json`/
  `app/runtime-config.js`/`app/sw.js`/`scripts/build.mjs`).
- `node --test tests/*.test.js`: 399 passed, 0 failed.
- `node scripts/build.mjs`: succeeded.
- `PYTHONPATH=analytics/src python3 -m unittest discover -s analytics/tests -p 'test_*.py'`:
  626 tests, OK (5 skipped, 0 failed).
- `npx playwright test` (full suite): see the B5 report to the supervisor
  for the final count -- run alongside this receipt.

## Files changed across B1-B4 (for reference; already committed)

- B1 (`e475552`): `app/assets/js/services/catalog-browse.js`,
  `app/assets/js/views/search.js`, `tests/catalog-browse.test.js`,
  `tests/discover.test.js`, `tests/e2e/browse-sets.spec.js`.
- B2 (`2216b68`): enrichment bridge builder/service, bridge coverage
  receipts, matcher tests (see `docs/receipts/catalog-v2/bridge-coverage-summary-{1,2,3}.md`).
- B3 (`e084a86`): `app/assets/js/services/catalog.js`,
  `app/assets/js/views/search.js`, `app/assets/js/services/watchlist.js`,
  `tests/providers.test.js`, `tests/watchlist.test.js`,
  `tests/e2e/image-search.spec.js`,
  `docs/receipts/catalog-v2/search-primacy-notes.md`.
- B4 (`a9c9a20`): `app/assets/js/views/price-intelligence-detail.js`,
  `tests/detail-view.test.js`, `tests/e2e/catalog-enrichment.spec.js`.
