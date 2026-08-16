# CollectFolio Product Requirements Document

**Version:** 0.1 MVP  
**Date:** July 31, 2026  
**Status:** Implemented baseline; Supabase key and Netlify project setup remain operator steps

## 1. Product summary

CollectFolio is a mobile-first collectible portfolio for trading cards, sports cards, other cards, graded slabs, comics, and related collectibles. Its defining workflow is batch ingestion: a user photographs several items, the app separates them into editable crops, assists with identification, and presents an explicit approval queue before adding anything to the portfolio.

The MVP is local-first and requires no paid API. The static application runs on Netlify, performs image work in the browser, and stores the collection in IndexedDB. Supabase adds optional authentication and cross-device synchronization without becoming a prerequisite for local use.

### Product promise

> Turn a table, binder page, or camera roll into a tracked collectible portfolio—without surrendering control of the match or the data.

## 2. Problem

Collectors currently face four linked problems:

1. Adding a large collection is slow because most trackers are optimized around one-item-at-a-time search.
2. Image recognition often hides ambiguity between editions, parallels, foil treatments, comic variants, and graded/raw copies.
3. Portfolio charts can confuse deposits with market gains and frequently obscure source quality.
4. A broad collector may need separate tools for TCGs, sports cards, and comics.

CollectFolio addresses these through editable batch capture, confidence-aware review, provider-independent holdings, transparent price attribution, and universal manual entries.

## 3. Goals

### MVP goals

- Make the first holding addable in under one minute.
- Let a user photograph multiple separated items and review each crop independently.
- Search free Pokémon, Magic, and Yu-Gi-Oh! catalogs from a single interface.
- Support sports cards, comics, slabs, and unsupported collectibles through a strong assisted-manual path.
- Provide current value, cost basis, gain/loss, allocation, and item-level drilldown.
- Work without an account and survive external API downtime.
- Allow full JSON backup and CSV export.
- Make Supabase cloud synchronization optional and protected by Row Level Security.

### Non-goals for MVP

- Automated condition or grade prediction.
- Guaranteed identification of every parallel, print run, autograph, or variant.
- A marketplace, automated checkout, auction bidding, or trade escrow.
- Scraping Google Images, PriceCharting, TCGplayer, eBay, or protected marketplaces.
- Universal automated pricing for sports cards and comics.
- Tax-lot reporting or realized-gain accounting.

## 4. Target users

### A. The binder collector

Owns dozens to thousands of TCG cards and wants to ingest pages quickly. Values speed, visible confidence, and batch controls.

### B. The mixed-category collector

Owns Pokémon, sports rookies, graded slabs, and comics. Values one portfolio even when some valuations must be manual.

### C. The value-conscious collector

Tracks purchase price, fees, current market value, and concentration. Values source attribution, backup, and historical snapshots.

## 5. Product principles

1. **Approval over automation:** recognition proposes; the collector decides.
2. **Local before cloud:** the portfolio remains available without sign-in or network access.
3. **Source transparency:** every automated value names its provider and refresh time.
4. **Universal internal identity:** no external provider ID becomes the product’s primary identity.
5. **Progressive enhancement:** free catalog automation where dependable; manual assistance everywhere else.
6. **Fast correction:** delete, retry, change query, select alternate match, or create custom item without restarting the batch.

## 6. Information architecture

The persistent mobile bottom navigation contains:

| Tab | Primary purpose |
|---|---|
| Home | Total value, gain/loss, allocation, trend, top holdings, scan shortcut |
| Search | Text or image-assisted catalog discovery and add-to-portfolio |
| Add | Multi-scan, single scan, manual search, and custom item entry |
| Portfolio | Holdings list, filtering, sorting, refresh, export, and drilldown |
| Profile | Local/cloud status, authentication, sync, settings, backup, and reset |

The Add action is visually elevated because ingestion is the highest-frequency growth action.

## 7. Core workflows

### 7.1 Batch scan

1. User chooses **Scan multiple items**.
2. User takes or uploads a photograph.
3. Browser analyzes the image locally.
4. Detected rectangles are drawn over the source.
5. User can:
   - select and move a box;
   - resize from its lower-right handle;
   - draw a missing box;
   - delete a false detection;
   - retry automatic detection;
   - apply a configurable row/column binder grid.
6. App creates compressed individual crops.
7. Straightened crops automatically run local OCR and catalog search.
8. Reliable OCR text becomes ordered catalog queries; visual recovery remains available when text is unusable.
9. Pokémon, Magic, and Yu-Gi-Oh! results are normalized and ranked.
10. A perceptual image hash reranks candidate images when cross-origin image access permits.
11. User selects the exact match and explicitly approves it.
12. Approved items are added in one batch with their original crop as the user-owned image.
13. Unidentified items can become custom holdings without leaving the queue.
14. The review can be saved and resumed later without losing crop, match, or approval state.

### 7.2 Text search

1. User enters a name, set, number, character, or player.
2. User may restrict category or provider.
3. Results show image, game, set, number, rarity/variant, price estimate, and match score.
4. User opens Add, confirms variant/finish, quantity, condition, grade, purchase details, folder, and notes.
5. Holding is written to IndexedDB and a daily portfolio snapshot is recorded.

### 7.3 Portfolio review

1. User sees market value, cost basis, unrealized gain, and return.
2. User filters by category or text and sorts by value, gain, name, or recency.
3. Item drilldown exposes unit value, quantity, cost basis, grade, folder, notes, source, and manual override.
4. User may update or delete the holding.
5. Free-provider prices refresh only on explicit request.

### 7.4 Cloud sync

1. App remains in local mode until Supabase URL and public key are configured.
2. User signs up, signs in, or requests a magic link; callback tokens are consumed on return to the app.
3. Sync reads local and remote holdings plus deletion tombstones.
4. Explicit deletions are propagated before remaining holdings are merged.
5. For each non-deleted common ID, the copy with the newest `updated_at` wins.
6. Merged holdings are written to both stores.
7. Supabase RLS limits every row to `auth.uid()`.

## 8. Functional requirements

### Navigation and shell

- **NAV-01:** Five bottom navigation actions must remain reachable with one thumb on a mobile viewport.
- **NAV-02:** Add must be visually distinct but retain a text label.
- **NAV-03:** Each view must retain accessible headings and keyboard focus states.
- **NAV-04:** The app must be installable as a PWA.

### Search

- **SEA-01:** Text search must query all enabled free TCG providers concurrently.
- **SEA-02:** Provider failures must not discard successful results from other providers.
- **SEA-03:** Search responses must be cached locally for 30 minutes.
- **SEA-04:** Sports/comics filters must route to custom entry rather than imply universal pricing coverage.
- **SEA-05:** Search-by-image must route into the same crop, OCR, candidate, and approval pipeline as Add.

### Capture and recognition

- **CAP-01:** Multi-image analysis must occur in the browser.
- **CAP-02:** The app must return at least one editable box; full-frame fallback is acceptable when auto-detection fails.
- **CAP-03:** Users must be able to add, move, resize, delete, and retry boundaries.
- **CAP-04:** Binder grid fallback must support 1–12 rows and columns.
- **CAP-05:** OCR must be lazy-loaded, local, automatically initiated after crop confirmation, and safely retryable/manual when unavailable.
- **CAP-06:** Low-confidence results must never be silently added.
- **CAP-07:** Users must be able to approve, retry, search manually, delete, or create a custom item per crop.
- **CAP-08:** Batch add must add only explicitly approved crops.
- **CAP-09:** A partially reviewed batch must be saveable and resumable with its decisions intact.

### Holdings and portfolio

- **HOL-01:** Holding records must separate catalog identity from ownership metadata.
- **HOL-02:** Quantity, condition, grade, purchase price, fees, manual value, folder, notes, and user image must be editable.
- **HOL-03:** Manual market value must override provider price without deleting provider data.
- **HOL-04:** Portfolio value equals unit market value multiplied by quantity.
- **HOL-05:** Cost basis equals purchase price multiplied by quantity plus fees.
- **HOL-06:** Charts must show market value and cost basis separately.
- **HOL-07:** A daily snapshot must be recorded when holdings change or prices refresh.
- **HOL-08:** Automated prices must display provider attribution and update time.

### Portability and cloud

- **DAT-01:** Users must be able to export all local stores as JSON.
- **DAT-02:** Users must be able to merge a valid JSON backup.
- **DAT-03:** Users must be able to export holdings as CSV.
- **DAT-04:** Local access must not require Supabase.
- **DAT-05:** Cloud rows must be protected by RLS.
- **DAT-06:** Clearing local data must require explicit destructive confirmation.
- **DAT-07:** Explicit holding deletion must create a tombstone that propagates during signed-in synchronization.

## 9. Data-source policy

### Automated free sources in MVP

- Pokémon TCG API for Pokémon card metadata, images, and included market fields.
- Scryfall for Magic printings, images, and daily price fields.
- YGOPRODeck API v7 for Yu-Gi-Oh! metadata, printings, images, and listed set prices.

### Manual-assisted sources

Sports cards, comics, autographs, memorabilia, unsupported TCGs, altered items, and rare variants use custom records in the MVP. The collector’s own crop is the canonical portfolio image.

### Price semantics

- Values are estimates, not appraisals or guaranteed sale prices.
- Active-listing asking prices must not be represented as completed-sale market value.
- Provider value, manual override, source URL, and update time remain distinct fields.

## 10. Non-functional requirements

- Initial shell should remain small and dependency-free.
- External OCR code may load only after the user explicitly chooses/captures an image and confirms its crop; no OCR runs during ordinary browsing.
- Original photos must not be automatically uploaded.
- The UI must work from 320 px through desktop widths.
- All interactive controls must have visible focus states.
- Reduced-motion preferences must be respected.
- Core local features must work after initial PWA caching while offline.
- Static deployment must not require Netlify Functions or paid compute.

## 11. Success metrics

For an early pilot:

- Median first-item completion time under 60 seconds.
- At least 80% of users who start a clean multi-item scan reach the review queue.
- Under 10% accidental deletion/restart rate during batch review.
- At least 70% of matched TCG crops accepted without editing the OCR query in controlled test photos.
- At least 95% successful local portfolio reloads after browser restart.
- Zero holdings added without explicit user approval.

## 12. MVP acceptance criteria

The MVP is complete when:

1. All five navigation views render on mobile and desktop.
2. Text search returns normalized Pokémon, Magic, and Yu-Gi-Oh! results.
3. A user can upload a multi-item image and receive editable crop boundaries.
4. Boundary add, move, resize, delete, retry, and grid split work.
5. OCR automatically produces an editable query or an explicit recoverable fallback.
6. Candidate results can be selected and explicitly approved.
7. Approved crops can be batch-added; unapproved crops are excluded.
8. Custom sports/comic/other entries can use the user’s photo.
9. Holdings persist in IndexedDB after reload.
10. Market value, cost basis, gain/loss, allocation, and trend render correctly.
11. Holdings can be edited, deleted, refreshed, filtered, sorted, and exported.
12. JSON backup import/export works.
13. A saved scan can be resumed after reload with prior review state intact.
14. The Supabase migration creates RLS-protected holdings and deletion-ledger tables.
15. Explicit deletion is preserved across a two-client synchronization test.
16. The app builds with `npm run build` and passes `npm run check` without third-party packages.
17. `netlify.toml` produces a static `dist/` deployment with SPA fallback.

## 13. Roadmap

### Phase 1 — implemented MVP

Local-first PWA, free TCG search, editable multi-scan, OCR-assisted review, manual universal holdings, portfolio analytics, backup, optional Supabase sync.

### Phase 2 — recognition quality

Category-specific preprocessing, set-symbol detection, better parallel/variant prompts, back-image pairing, barcode/certification recognition, correction analytics, and controlled benchmark datasets.

### Phase 3 — portfolio intelligence

Watchlists, alerts, sale recording, acquisition lots, realized gains, liquidity/confidence labels, richer historical snapshots, and provider comparison.

### Phase 4 — approved ecosystem integrations

Commercially licensed sports/comic datasets, approved marketplace adapters, graded certification verification, and optional seller workflows.
