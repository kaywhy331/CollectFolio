# TCGCSV rolling R2 import receipt — August 15, 2026 source build

## Result

The inaugural recurring-private rolling cohort completed successfully under
source review `3775d954-f0ce-4abc-97fb-a7a6938c134a`.

- Source ID: `f24c78f8-d4b9-55a3-a8f7-b05d484c052e`
- Source build: `2026-08-15T20:05:57.000Z`
- Archive date: `2026-08-15`
- Successful completion: `2026-08-16T03:58:14.367Z`
- Logical rolling slot: `0`
- Private bucket: `collectfolio-tcgcsv-current` (WNAM / Standard)
- Public bucket access: not enabled
- Worker status after completion: `current`

The coordinator re-read TCGCSV's source timestamp before sealing, verified all
six R2 objects against their byte counts and SHA-256 receipts, and only then
published the slot marker. A second authenticated claim immediately returned
`current` with `started=false`, proving the same source build is a no-op.

## Full-cohort scope

- Card-category price/finish series: 527,618
- Deterministic market-feature rows: 527,618
- Deterministic set-feature rows: 3,717
- Catalog categories: 90
- Card groups: 3,717 of 3,717 planned and successful
- Products: 449,968
- Catalog status: complete (`partial=false`, zero errors)

The normalized source-availability boundary equals the exact source-build
timestamp. This makes same-build retries deterministic instead of embedding
network completion time in Parquet and feature facts. The catalog crawl checked
the upstream timestamp before and after collection; the Worker checked it once
more before sealing.

## Artifact receipts

The private marker contains the corresponding run-isolated object identities.
Those R2 keys are intentionally omitted here and from the browser status API.

| Artifact | Stored bytes | SHA-256 |
|---|---:|---|
| Raw daily archive | 4,019,731 | `f48cff35d36524e7820490bae3314fe9e5526ede2d0932579e2eb9793570647f` |
| Normalized Parquet | 39,382,117 | `8dc59a29501d1ebfbc7ac184089940e5b3624b818a9f581d349c34880f08ae03` |
| Deterministic market features (`gzip -n -9`) | 45,388,374 | `164137c236144dcbfa1116e8552d3b4585a87cbb8055df468ae97540c4580913` |
| Set features | 358,599 | `633bd9d194d2064953e8723e29cdf40985715ef3390b77c9735ee73402463468` |
| Archive packet | 707,069 | `b2767f8b6a73dae712df5f1959b9fc48b6851ada15c853616681b19dac57e258` |
| Complete catalog packet (`gzip -n -9`) | 63,114,369 | `0b711773c868464de3e8e61ea88f0c8e37187d517497dda3b5518d74df1ce483` |

## Boundaries retained

- Migration `0020_tcgcsv_market_universe.sql` was not applied.
- No PostgreSQL or Supabase ingestion occurred.
- No source artifact, R2 key, catalog packet, raw price, or feature row was
  exposed to the app. The public Worker response contains only refresh state
  and source/success timestamps.
- No Structural Gap Lab, public price intelligence, learned-model training,
  image retrieval, commercial use, AI inference, or LLM processing occurred.
- The locked one-time evidence bucket `collectfolio-tcgcsv-private` was not
  changed.
