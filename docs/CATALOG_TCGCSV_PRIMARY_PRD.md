# PRD: TCGCSV-primary catalog identity (catalog-v2)

Kevin's directive (2026-08-17, verbatim intent): "the baseline should be the tcgcsv, while pokemon tcg api / scryfall / ygoprodeck should be secondary source for alternative/additional data. All products should be associated to the TCGCSV dataset. All of the TCGCSV data set should be available within our catalog dataset, whether we choose to have certain attributes hidden or shown."

## Architecture decision
- **TCGCSV is the canonical catalog spine.** Every product surfaced in the app carries a TCGCSV identity `(categoryId, groupId, productId, subTypeName)` when one exists. Pricing, price intelligence, and trajectory-v1 forecasts attach to that identity.
- **Pokémon TCG API / Scryfall / YGOPRODeck are enrichment providers**, joined onto TCGCSV identities (never the reverse). They contribute alternative/additional data: set art and series metadata, high-res images, oracle/card text, legalities, localized data.
- **No TCGCSV data is dropped.** The full dataset (all categories, groups, products, prices, `extendedData` attributes) remains available through the worker catalog; the app controls per-attribute visibility (hidden vs shown), not availability.

## Current state (baseline, v0.8.14/0.8.15)
- Worker `collectfolio-tcgcsv-refresh` already serves the full TCGCSV catalog from R2: `/catalog/summary`, `/catalog/groups`, `/catalog/search`, `/catalog/assets`, `/catalog/publications`, `/catalog/forecasts/*` — anonymous under `CATALOG_PUBLIC_ACCESS`.
- `services/providers/tcgcsv.js` normalizes products preserving `extendedData`.
- App browse treats API providers as the primary games (`CATALOG_GAMES` in `catalog-browse.js`) and appends TCGCSV categories as extra games; search fans out across providers with no cross-provider identity join.
- Forecasts (trajectory-v1) only attach to items with `provider === 'tcgcsv'`.

## Tasks (sequential; lane executes, supervisor gates/commits)

### B1 — Browse identity inversion
Flagship games browse the TCGCSV catalog as baseline: Pokémon → category 3 (Pokémon Japan → 85, its own game entry), Magic → 1, Yu-Gi-Oh! → 2. `CATALOG_GAMES` entries resolve to TCGCSV category data (groups as sets, products as cards/sealed) instead of API-provider lists. API providers no longer define the product universe for these games.
**Done when:** browsing Pokémon/Magic/YuGiOh set pages lists TCGCSV groups/products (with prices + forecasts attached natively); product-kind Cards/Sealed tabs still work; no regression for TCGCSV-only categories; unit + Playwright coverage.

### B2 — Enrichment bridge (secondary providers join TCGCSV)
Deterministic association layer mapping provider entities onto TCGCSV identities:
- Set-level: TCGCSV group ↔ provider set via normalized name + release-date proximity (+ abbreviation from group `abbreviation`/set code where present). Mapping table built offline in analytics (stdlib, receipts with match-rate stats), published into the catalog dataset via the worker (`/catalog/bridge/<categoryId>` or folded into groups payload), cached client-side.
- Product-level: within a mapped set, provider card ↔ TCGCSV product via collector number, falling back to normalized name; ambiguous/unmatched → no enrichment (fail-closed, never a wrong join).
Enrichment is additive display data on the TCGCSV product (better image, card text, set art). **Done when:** mapping receipts report per-category set-level and product-level match rates; browse/detail show enriched fields for mapped products; unmatched products render fine unenriched; tests for the matcher (exact, fallback, ambiguous-rejection).

### B3 — Search primacy
`/catalog/search` (TCGCSV) becomes the primary search backend; secondary providers may fill image/text gaps for mapped results (via B2 bridge) but do not introduce products without TCGCSV identity for the flagship games. Non-flagship content sources are unaffected.
**Done when:** search results for flagship games are TCGCSV-identified (forecasts/pricing attach), enrichment visible where mapped, result quality receipts (spot checks) recorded.

### B4 — Full-attribute surfacing with visibility control
Product detail exposes the complete TCGCSV record (all `extendedData` attributes, all price fields/subtypes) behind a per-attribute visibility config (constant map in app code; default: current display set shown, remainder collapsible "All attributes" section). Nothing is stripped during normalization.
**Done when:** any TCGCSV attribute reachable in the UI; visibility config documented; tests.

### B5 — Release
Version bump (established pattern incl. `.github/workflows/netlify-deploy.yml`), `check:all` green, PR with receipts, merge, Netlify deploy, worker deploy only if worker code changed, live verification receipts.

## Constraints
- Analytics side: Python stdlib only; host ≤1.5GB RSS; deterministic with receipts.
- App side: dependency-free, existing state/store/view patterns, theme tokens.
- Fail-closed joins: a wrong provider→TCGCSV association is worse than no enrichment.
- Lane rules unchanged: no push/merge/deploy by the lane; supervisor gates each task.
