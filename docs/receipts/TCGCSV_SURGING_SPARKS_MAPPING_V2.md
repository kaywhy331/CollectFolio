# TCGCSV Surging Sparks mapping-v2 receipt

**Hosted project:** `agmjgyyvhfcivbwdlvzk`  
**Committed:** August 8, 2026 at `2026-08-08T16:41:00.927048Z`  
**Outcome:** One approved current mapping now routes future TCGCSV research to canonical `sv8`; all v1 history remains immutable.

## Reviewed operation

- Supersession manifest: `analytics/manifests/tcgcsv-surging-sparks-mapping-supersession-v2.json`
- Manifest SHA-256: `b5ad203bbdc44d29bc87dff206c6c3ec8704543ef5df4ce0860e54b1770319b9`
- Mapping review: `docs/mapping-reviews/TCGCSV_590027_HOLOFOIL_V2.md`
- Review SHA-256: `90affc83a1341382185c42f63f2767c6a6bc38014477cddc5a1d1a777f78750a`
- Rollback rehearsal SQL SHA-256: `f7154edc7b15177295ce7c222c9888d5419944a4709edfc002369777825c4c0d`
- Commit SQL SHA-256: `e3bfa72c91cae703848801d3afeb25c4863dddce1a34e6db2921ed81fc56f3c4`
- Ephemeral operator artifacts: `/tmp/collectfolio-reconciliation.ULksFx/`

The rehearsal invoked the real guarded RPC inside a transaction and rolled it back. Its final read showed the old mapping still approved and unsuperseded, no successor, 54 observations, 43 trend snapshots, 215 predictions, and `public_price_intelligence=false`. The commit file was generated from the same manifest and differed from the rehearsal only at `ROLLBACK` versus `COMMIT`.

## Immutable lineage

| Record | v1 historical identity | v2 current identity |
|---|---|---|
| Mapping | `874f918c-8988-59f5-93ba-ff1ea961bd5a` — rejected and superseded | `649be0ee-0893-459a-bad6-331a218e069b` — approved and current |
| Variant | `80b4934a-96db-5f4c-8641-f7c74e0eb949` (`sv08`, `238/191`) | `af796afb-d8d3-5b4b-a95a-417e39e77b0a` (`sv8`, `238`) |
| Price observations | 54 preserved on v1 | 0 at supersession |
| Trend snapshots | 43 preserved on v1 | unchanged by supersession |
| Forecast predictions | 215 preserved on v1 | unchanged by supersession |
| Public candidates/publications | 0 / 0 | 0 / 0 |

The RPC appended correction review event `be4fcbd2-fcba-402f-acd1-5ede8a2cf871`. Post-commit verification found exactly one unsuperseded mapping for TCGCSV product `590027` / `holofoil`, exactly one v2 correction event, zero observations claimed by the successor mapping, and no public candidate or publication for either variant.

The source remains `research_only`, all commercial/catalog/raw/derived/image permissions remain denied, and `public_price_intelligence` remains disabled. The historical v1 manifest and review are retained unchanged; the scheduled current-snapshot workflow alone advances to the v2 manifest.
