# TCGCSV source review — research only

**Decision date:** August 5, 2026  
**Decision:** `research_only`  
**Next review:** November 3, 2026

## Scope

This decision permits bounded ingestion into CollectFolio's private, service-role-only research ledgers for catalog mapping, data-quality work, and walk-forward experiments. It does not approve production or public use.

## Evidence reviewed

- TCGCSV documentation and FAQ: <https://tcgcsv.com/docs> and <https://tcgcsv.com/faq>
- TCGCSV repository metadata: <https://github.com/CptSpaceToaster/tcgcsv>
- TCGplayer API Terms and Conditions: <https://help.tcgplayer.com/hc/en-us/articles/360061115874-TCGplayer-API-Terms-Conditions>
- CollectFolio Price Intelligence PRD, especially its critical data-rights conclusion and source matrix

As retrieved on August 5, 2026, TCGCSV states that its cached JSON is sourced directly from TCGplayer's API and that its archive records those prices daily. The TCGCSV repository declares no license through GitHub repository metadata. The CollectFolio PRD concludes that TCGplayer-derived raw data and derivatives require written approval before public/commercial use.

This is a conservative engineering classification, not legal advice or written permission from TCGplayer or TCGCSV.

## Capability decision

| Capability | Allowed |
|---|---:|
| Restricted research ingestion | Yes |
| Catalog metadata publication | No |
| Image display or caching | No |
| Public raw-price display | No |
| Public derived trends/fair value/forecasts | No |
| Commercial use | No |

## Mandatory controls

- Data remains behind service-role-only tables with RLS and no browser grants.
- Raw source payloads are not committed to the repository or copied into a public client surface.
- Every initial product/finish mapping requires an operator review; confidence alone cannot approve it.
- Research predictions remain labeled `research_only` and cannot enter the public publication function.
- Revocation, changed terms, or source ambiguity immediately stops ingestion.
- Changing any capability above requires independent written source-rights evidence and a new terms-review record; this document must never be edited into an approval retroactively.
