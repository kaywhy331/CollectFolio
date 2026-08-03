# CollectFolio

CollectFolio is a dependency-free, local-first progressive web app for collectible cards, comics, graded slabs, sports cards, and related items. Its central workflow turns a multi-item photo into editable crops, optional OCR suggestions, catalog candidates, and an explicit approval queue. Nothing enters the portfolio until the collector approves it.

## MVP features

- Five-view mobile-first shell with dark, light, and system themes
- IndexedDB portfolio with editable ownership metadata, tombstoned deletion, and daily snapshots
- Separate market value and cost-basis trend lines, gain/loss, allocation, and top holdings
- Concurrent failure-isolated Pokémon TCG API, Scryfall, and YGOPRODeck search with a 30-minute local cache
- Manual entries for sports, comics, slabs, unsupported items, and variants
- In-browser boundary detection with add, move, lower-right resize, delete, retry, and 1–12 row/column grid tools
- Browser-native OCR first, with user-triggered Tesseract.js fallback when enabled
- Per-crop selection and approval, approved-only batch add, and resumable local scan drafts
- JSON interchange v1 backup/merge restore and CSV export
- Optional Supabase password or magic-link authentication and tombstone-first last-write-wins synchronization
- Installable offline shell with dedicated provider-image caching

Full source photos are never uploaded. Scan drafts store compressed crops locally. Cloud synchronization is optional, and crops larger than 180 KB stay on the device.

## Local development

Node.js 22 or newer is required. There are no npm dependencies or devDependencies.

```sh
npm run dev
```

Open `http://localhost:4173`. To run the complete validation, unit-test, and production-build sequence:

```sh
npm run check
```

Other scripts are `npm test` for Node built-in tests and `npm run build` for a static `dist/` build. The build writes `dist/runtime-config.js` from `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `APP_VERSION`, and `ENABLE_TESSERACT`.

With no Supabase public key, every local feature remains available. Tesseract.js is fetched from jsDelivr only after the user explicitly requests OCR and only when `ENABLE_TESSERACT` is enabled.

## Deployment

Netlify builds with `npm run build` and publishes `dist/`; no Functions or paid compute are required. Supabase schema setup, environment variables, Auth redirect configuration, and the two-browser deletion-sync qualification are documented in [docs/NETLIFY_DEPLOY.md](docs/NETLIFY_DEPLOY.md).

Product requirements, technical architecture, and final UI references live in [`docs/`](docs/).
