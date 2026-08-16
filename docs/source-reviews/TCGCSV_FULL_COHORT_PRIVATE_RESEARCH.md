# TCGCSV full-cohort source review — one-time private research snapshot

**Review ID:** `f455c2f2-06d0-4a12-a97f-3bbb2c59aacf`
**Decision date:** August 15, 2026
**Decision:** `research_only`
**Next review:** September 14, 2026

## Approved scope

This engineering review permits one provider-wide ingestion of the current
TCGCSV card-category price archive and current catalog into CollectFolio's
private research plane. The bounded operation may retain:

- the exact compressed current price archive;
- normalized private CSV and Parquet price-series facts;
- the complete current card-category catalog packet;
- deterministic private card/set feature files and integrity receipts.

This decision does not approve historical backfill, recurring ingestion,
Structural Gap Lab training, public or authenticated-client access, catalog or
price publication, derived-value publication, image retrieval, or commercial
use. A new immutable review is required before any of those boundaries change.

## Evidence reviewed

- TCGCSV documentation and FAQ, retrieved August 15, 2026 from
  <https://tcgcsv.com/docs> and <https://tcgcsv.com/faq>.
- TCGCSV repository metadata, retrieved August 15, 2026 from
  <https://github.com/CptSpaceToaster/tcgcsv>.
- The August 5, 2026 TCGplayer API terms evidence recorded in
  `TCGCSV_RESEARCH_ONLY.md`; the upstream terms page returned HTTP 403 during
  this review and therefore provides no new or expanded permission.
- CollectFolio's private market-universe ingestion and publication controls.

TCGCSV states that its data is intended for server-side ingestion into a
database or cache and that its cached catalog and price responses are direct
exports from TCGplayer API endpoints. It also publishes compressed daily price
archives. The TCGCSV repository still declares no license. These facts support
the private technical experiment above but do not establish public,
commercial, or derivative-publication rights.

This is a conservative engineering classification, not legal advice or written
permission from TCGplayer or TCGCSV.

## Storage and retention

The snapshot is stored only in the private Cloudflare R2 bucket
`collectfolio-tcgcsv-private` in WNAM Standard storage. Public bucket access is
not enabled. A whole-bucket indefinite lock prevents object deletion and
overwriting; every uploaded object is downloaded or metadata-checked after
upload and bound to a SHA-256 receipt.

The indefinite lock is an evidence-integrity control for this single snapshot,
not permission to collect additional dates. Recurring accumulation remains
disabled and requires a new review that establishes an explicit retention
period and current rights evidence.

## Capability decision

| Capability | Allowed |
|---|---:|
| One complete current private snapshot | Yes |
| Private deterministic feature computation | Yes |
| Historical archive backfill | No |
| Recurring or scheduled ingestion | No |
| Structural Gap Lab or learned-model training | No |
| Browser or authenticated-client access | No |
| Catalog, raw-price, or derived publication | No |
| Commercial use | No |

## Mandatory controls

- Keep all source objects and packets outside the public repository and browser.
- Do not configure `TCGCSV_FULL_UNIVERSE_RESEARCH_ENABLED=true`.
- Keep `TCGCSV_STRUCTURAL_GAP_LAB_ENABLED=false` and
  `ENABLE_PRICE_INTELLIGENCE=false`.
- Use only the fixed TCGCSV HTTPS origin and the identifiable CollectFolio user
  agent, with the checked-in request, size, extraction, and file-count limits.
- Fail closed if a requested card category disappears or the upstream build
  changes during preparation.
- Emit no publication candidate, public mapping, or client-readable endpoint.
- Stop and append a new review if terms, provenance, or source behavior changes.
