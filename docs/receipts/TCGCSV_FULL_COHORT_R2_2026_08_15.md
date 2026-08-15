# TCGCSV full-cohort R2 import receipt — August 15, 2026

## Decision boundary

This receipt records one complete current TCGCSV card-category snapshot in
private object storage under source review
`f455c2f2-06d0-4a12-a97f-3bbb2c59aacf`. It does not activate recurring
ingestion, historical backfill, Structural Gap Lab, public price intelligence,
catalog publication, or commercial use.

Production migration `0020_tcgcsv_market_universe.sql` remains unapplied. No
PostgreSQL current-state rows or browser-readable data were created by this
operation.

## Source and scope

- Source ID: `f24c78f8-d4b9-55a3-a8f7-b05d484c052e`
- Archive date: `2026-08-15`
- Upstream build: `2026-08-15T20:05:57+00:00`
- CollectFolio availability: `2026-08-15T22:29:25.119942+00:00`
- Scoped card categories: 61
- Reviewed empty categories retained in scope: 21 and 84
- Price/finish series: 527,618
- Price-archive group receipts: 3,717
- Private market feature rows: 527,618
- Private set-feature rows: 3,717
- Catalog categories: 90 total
- Catalog groups: 3,717
- Catalog products: 449,968
- Catalog status: complete (`partial=false`, zero errors)

Category 21 is the retired My Little Pony identity whose groups endpoint
returns HTTP 404. Category 84 is Neopets Battledome whose groups endpoint
returns a successful empty result. Both remain hash-bound into the requested
scope with zero group receipts. Every other missing requested card category
still fails the import closed.

## Private storage

- Cloudflare account: `c78cd5839a82fd10b1160340f1b31790`
- R2 bucket: `collectfolio-tcgcsv-private`
- Location/storage class: WNAM / Standard
- Public access: not enabled
- Bucket lock: `collectfolio-tcgcsv-immutable`, all prefixes, indefinite

| Object | Bytes | SHA-256 |
|---|---:|---|
| `raw/archive_date=2026-08-15/prices-2026-08-15.ppmd.7z` | 4,019,731 | `f48cff35d36524e7820490bae3314fe9e5526ede2d0932579e2eb9793570647f` |
| `history/archive_date=2026-08-15/prices.parquet` | 39,382,117 | `90ac9e63ef33eeb8ce4b4c26bf9aa34fd4188014d1d41228b6974130ec71e12c` |
| `features/archive_date=2026-08-15/market-features.csv` | 138,196,681 | `415cb90dcd6482a84619d44f5dbf85469f44c5e8624c57193c56b0f4382aae4c` |
| `features/archive_date=2026-08-15/set-features.csv` | 358,599 | `633bd9d194d2064953e8723e29cdf40985715ef3390b77c9735ee73402463468` |
| `receipts/archive_date=2026-08-15/archive-packet-c3b4b0ebccc75cb75113c3e2badcdfa8e01ec3261837f52a24be7785575f27b4.json` | 982,943 | `c3b4b0ebccc75cb75113c3e2badcdfa8e01ec3261837f52a24be7785575f27b4` |
| `catalog/source_date=2026-08-15/catalog-packet-d83cfa5dd13ba2e468ca5c676ee6e1be09adc4819c6592b7c65876f31b1c088a.json.gz` | 63,114,369 stored | `d83cfa5dd13ba2e468ca5c676ee6e1be09adc4819c6592b7c65876f31b1c088a` uncompressed content |
| `reviews/terms_review_id=f455c2f2-06d0-4a12-a97f-3bbb2c59aacf/review-e8c890e7d58167a101bf03429b509e9b11cd0c38678eb449145defb36a0e6106.md` | 3,803 | `e8c890e7d58167a101bf03429b509e9b11cd0c38678eb449145defb36a0e6106` |

The catalog packet is deterministically gzip-compressed for R2 upload because
Wrangler limits individual uploads to 300 MiB. Its object key and receipt bind
the 473,017,510-byte uncompressed JSON content hash. The deterministic gzip
payload hash is
`81d5cc945dfa043a5695560b7cc59f401f03e9ada7354bae70fc32128a4954e4`.

## Verification

- The upstream build timestamp was identical before and after archive
  preparation and before and after the full catalog crawl.
- All four price artifacts, the archive packet, catalog packet, and source
  review were downloaded from R2 after upload. Every round-trip SHA-256 matched
  the local source content shown above.
- The catalog packet retained no provider image or commerce URLs.
- The catalog sealed with `partial=false` and no endpoint errors.
- All 333 analytics tests passed after adding the reviewed-empty-category
  handling; unrelated missing card categories continue to fail closed.
- `TCGCSV_FULL_UNIVERSE_RESEARCH_ENABLED` remains absent/false,
  `TCGCSV_STRUCTURAL_GAP_LAB_ENABLED` remains false, and
  `ENABLE_PRICE_INTELLIGENCE` remains false.
