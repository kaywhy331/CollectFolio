# TCGCSV recurring private rolling-cohort review

**Review ID:** `3775d954-f0ce-4abc-97fb-a7a6938c134a`
**Decision date:** August 15, 2026
**Decision:** `private_rolling_research`
**Next review:** September 14, 2026

## Approved boundary

This engineering review permits CollectFolio to check TCGCSV's declared source
build hourly and privately collect one complete current card-category cohort
when, and only when, the exact `last-updated.txt` timestamp differs from the
last successful build. The approved operation retains only the latest and previous successful cohorts in the private mutable Cloudflare R2 bucket
`collectfolio-tcgcsv-current`.

The original evidence snapshot in `collectfolio-tcgcsv-private` remains locked
and is not modified by this lane. This recurring decision does not approve
historical backfill, PostgreSQL ingestion, browser access to source artifacts,
catalog or price publication, learned-model training, image retrieval, or
commercial use.

The user approved this private rolling refresh behavior on August 15, 2026.
That operational approval does not establish or expand rights from TCGplayer
or TCGCSV. This remains a conservative engineering classification, not legal
advice or written permission from either source.

## Evidence and source posture

- The evidence listed in `TCGCSV_FULL_COHORT_PRIVATE_RESEARCH.md` remains the
  governing source and terms record for this review.
- TCGCSV documents server-side ingestion into a database or cache and daily
  compressed price archives, but its repository still declares no license.
- The exact fixed origin is `https://tcgcsv.com/`; the identifiable
  CollectFolio user agent, request budget, extraction limits, and card-category
  policy remain mandatory.
- A material terms, provenance, format, or source-behavior change stops this
  lane pending a new immutable review.

## Idempotency and snapshot integrity

1. The GitHub cron runs hourly in UTC and asks the Cloudflare coordinator to
   claim the current source build.
2. The coordinator compares the normalized upstream timestamp with the two
   successful slot markers. A match exits without downloading or importing.
3. One conditional R2 claim grants a 90-minute lease. A matching active claim
   exits without starting duplicate work; a failed run releases the build for
   the next hourly retry.
4. Artifacts upload under a run-isolated prefix. A slot marker is replaced only
   after all six objects match their byte counts, SHA-256 receipts, run ID, and
   source timestamp. Failed staging cannot alter the prior successful cohort.
5. TCGCSV's timestamp is checked before and after archive preparation, before
   and after the full catalog crawl, and again before the coordinator seals the
   marker. A change fails closed instead of mixing snapshots.
6. Normalized source availability is pinned to the declared source-build
   timestamp for this lane. Together with fixed parser/dependency versions and
   `gzip -n -9`, retries of one build produce deterministic facts and payloads.

Network timing, scheduling delay, and retry count may vary. No LLM, generative
model, fuzzy mapper, or AI inference participates in acquisition,
normalization, validation, compression, slot selection, or receipt creation.

## Rolling retention

Each successful cohort contains only:

- the exact compressed price archive;
- normalized private Parquet price facts;
- deterministic gzip-compressed market features;
- deterministic set features;
- the archive packet and its source/normalization receipt;
- the deterministic gzip-compressed complete catalog packet.

UTC archive-date parity selects one of two logical markers. Publishing a new
cohort to a marker deletes that marker's prior run-isolated objects only after
the new marker is sealed. Explicit failures delete staged objects. Therefore
the active data plane exposes exactly the latest and previous successful
cohorts, without daily historical accumulation.

## Capability decision

| Capability | Allowed |
|---|---:|
| Hourly source-build check | Yes |
| One full private refresh per new source build | Yes |
| Latest and previous private cohorts | Yes |
| Deterministic private feature computation | Yes |
| Public refresh state and successful timestamp | Yes |
| Raw, catalog, price, feature, key, or receipt access from the browser | No |
| Historical accumulation or backfill | No |
| PostgreSQL migration or ingestion | No |
| Structural Gap Lab or learned-model training | No |
| Catalog, raw-price, or derived-value publication | No |
| Commercial use | No |

## Mandatory controls

- Keep the R2 bucket private and expose object reads/writes only through the
  bearer-authenticated Worker gateway.
- The unauthenticated `/status` response may contain only refresh state, the
  current source timestamp, and latest successful timestamps. It must not
  contain object keys, artifact metadata, payloads, or run identities.
- Keep migration `0020_tcgcsv_market_universe.sql`, database credentials,
  publication, Structural Gap Lab, and price-intelligence enablement out of the
  recurring workflow.
- Keep workflow permissions at `contents: read`, serialize executions, and
  retain only small SHA-256/control receipts as GitHub artifacts.
- Stop rather than publish a partial catalog, any catalog error, a missing card
  category outside the reviewed empty exceptions, a hash/size mismatch, an
  expired lease, or a changed upstream source build.
