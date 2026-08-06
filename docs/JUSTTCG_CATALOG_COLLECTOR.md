# JustTCG private catalog collector

## Purpose and boundary

The scheduled Netlify collector uses the server-only `JUSTTCG_API_KEY` to stage a private catalog/history bootstrap in Netlify Blobs. It is designed to consume the current Free allowance safely and efficiently without adding the key or provider payloads to the PWA.

This is not a public price feed or production ingestion path. The Free plan is personal/non-commercial. The collector has no HTTP read route, browser import, Supabase service-role key, mapping approval, observation writer, model trainer, or publication action. Public/commercial prices and derived analytics remain disabled until the paid subscription, immutable source review, mapping, database, evidence, and operator gates in the price-intelligence runbook pass.

## Verified API contract

The implementation follows the provider documentation reviewed August 5, 2026:

| Free-plan rule | Collector behavior |
|---|---|
| 1,000 requests/month | One collection reserves at most 1,000 outbound attempts and never auto-resets |
| 100 requests/day | At most 100 attempts per UTC date; reset is exactly 00:00 UTC |
| 10 requests/minute | One request every five minutes |
| 20 cards/request | `limit=20` is fixed and response `meta.limit` must match |
| Offset pagination | Requests `offset=0,20,40,...` and persists the next offset after every page |
| Page termination | Stops on `meta.hasMore=false`; it does not assume exactly 1,000 pages |
| Rate-limit response | Honors `Retry-After`; otherwise uses exponential backoff with jitter |

At 100 successful full pages per UTC day, a 1,000-page collection takes at least 10 full UTC days and stores at most 20,000 card records. A late first-day deployment, provider failures, an already-partially-used account cycle, a short final page, or `meta.hasMore=false` can extend the schedule or reduce the count.

JustTCG does not document a stable card-ID sort for `GET /cards`; the available `orderBy` values are price/change measures. The collector therefore pins `orderBy=price&order=desc`, prioritizing the most useful priced records, and detects repeated pages and duplicate IDs within a page. Because price ordering can move during a multi-day offset crawl, 20,000 response records cannot be promised to be 20,000 unique cards. State carries a compact card-ID Bloom filter and reports `approximateUniqueCardCount` so drift is visible. The raw immutable pages remain the source of truth for exact offline deduplication.

## Data maximized per request

Every call requests:

- all priced games by default, or one stable game ID from `JUSTTCG_GAME`;
- 20 cards;
- current variants, excluding null-price-only cards;
- the trailing one-year `priceHistory`; and
- 7-day, 30-day, 90-day, and all-time statistics.

This gathers current pricing and the largest documented history window without spending separate requests. For a Pokémon-only bootstrap set `JUSTTCG_GAME=pokemon`; `Pokemon` is a display name, while `pokemon` is the documented stable game ID.

For discovery, `GET /cards` with `limit` and `offset` is the correct endpoint. `POST /cards` is better only for later refreshes of a known portfolio/watchlist identifier set; on Free it accepts up to 20 lookup items and uses identifier precedence `variantId`, `tcgplayerSkuId`, `tcgplayerId`, `mtgjsonId`, `scryfallId`, `cardId`.

## Durable state and failure behavior

The function runs every five minutes, stays within Netlify's 30-second scheduled-function ceiling, and makes no more than one provider call per invocation. Netlify Blobs uses strong reads plus ETag conditional writes. Before the HTTP call, the collector atomically reserves the daily and collection attempt and obtains a two-minute lease. The page is then written immutably before the cursor advances.

If the page write succeeds but cursor finalization is interrupted, the next invocation reconciles that exact stored page and advances without calling JustTCG again. Ambiguous network attempts remain charged to the local conservative quota and retry the same offset only after backoff. The API key is sent only in `X-API-Key`; redirects are rejected, responses are capped at 8 MiB, and logs contain only collection/cursor/quota summaries.

Collection stops fail-closed on:

- `meta.offset`/`meta.limit`/`meta.hasMore` inconsistencies;
- a page over 20 cards, a short nonterminal page, or duplicate IDs in one page;
- a repeated recent page hash or conflicting immutable page;
- reported API-plan mismatch (default expected plan: `Free`);
- zero provider requests remaining or 1,000 reserved attempts;
- invalid/corrupt durable state; or
- authentication failures and `EXCESSIVE_FREE_TIER_USAGE`.

The last error code and offset are stored without provider bodies or credentials. `EXCESSIVE_FREE_TIER_USAGE` is a documented Free-key risk on shared serverless infrastructure such as Netlify; the provider's resolution is a paid plan, not more retries.

## Environment and operation

Required:

```text
JUSTTCG_API_KEY=<Netlify server environment secret>
```

Optional:

```text
JUSTTCG_EXPECTED_PLAN=Free
JUSTTCG_COLLECTION_ID=catalog-v1
JUSTTCG_GAME=pokemon
```

Omit `JUSTTCG_GAME` to spend the collection on all priced games. The default collection ID is `catalog-v1`. The state path includes the collection ID and a hash of the complete query/limits, so changing scope never silently reuses the old cursor.

Do not rotate `JUSTTCG_COLLECTION_ID` merely to restart quota. A new ID creates a new 1,000-attempt safety envelope; first confirm the provider's account-creation-day monthly reset and current dashboard usage. The provider metadata `apiRequestsRemaining` is also checked on every successful page.

After a published deployment:

1. Confirm **Functions → justtcg-catalog** shows the scheduled badge.
2. Confirm the private `collectfolio-justtcg-private` Blob store receives `catalog/<collection>/<query-hash>/state.json` and `pages/00000000.json`.
3. Check the summary log for `page_stored`, offset 20, attempts 1, and no secret/raw response.
4. Watch `cardRecordCount`, `approximateUniqueCardCount`, `dailyAttempts`, `totalAttempts`, and `apiRequestsRemaining`.
5. If state becomes `blocked`, investigate `lastError.code`; do not edit the offset by hand.

There is intentionally no deploy, manual invocation, quota-consuming request, Supabase migration, or public activation performed by the repository implementation itself.

## Primary documentation

- <https://justtcg.com/docs/api/cards>
- <https://justtcg.com/docs/rate-limits>
- <https://justtcg.com/pricing>
- <https://docs.netlify.com/build/functions/scheduled-functions/>
- <https://docs.netlify.com/build/data-and-storage/netlify-blobs/>
