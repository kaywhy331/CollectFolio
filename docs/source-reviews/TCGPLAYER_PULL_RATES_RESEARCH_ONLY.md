# TCGplayer pull-rate article review — research only

**Decision date:** August 8, 2026  
**Decision:** `research_only`  
**Next review:** November 6, 2026

## Scope

This decision permits manual curation of factual pack-opening estimates from public TCGplayer articles into CollectFolio's private, service-role-only pull-rate registry. It does not approve article-body republication, images, public raw-rate display, price ingestion, or commercial analytics publication.

## Evidence reviewed

- Nineteen TCGplayer pull-rate articles listed individually in `analytics/manifests/tcgplayer-sv-me-pull-rates.json`
- The public TCGplayer content application and its same-origin article API representation
- TCGplayer API Terms and Conditions: <https://help.tcgplayer.com/hc/en-us/articles/360061115874-TCGplayer-API-Terms-Conditions>
- CollectFolio Price Intelligence PRD sections 15.5, 19.4, and the source matrix

The checked-in manifest retains article identity, publication/update timestamps, retrieval time, and a SHA-256 of each exact article body. It retains no article body, infographic, image, card list, or price data. The live verifier fetches only the bounded public article record and fails if its immutable identity or body hash differs.

This is a conservative engineering classification, not legal advice or written permission from TCGplayer.

## Capability decision

| Capability | Allowed |
|---|---:|
| Private pull-rate research registry | Yes |
| Store source URL and immutable body hash | Yes |
| Store transcribed point estimates and confidence intervals | Yes |
| Copy article bodies or infographics | No |
| Public raw-rate display | No |
| Public derived scarcity/fair-value/forecast display | No |
| Price ingestion | No |
| Commercial use | No |

## Mandatory controls

- Data remains in RLS-enabled, service-role-only, append-only research tables with no browser grants.
- Every numeric row carries the exact article source, sample-size semantics, confidence interval when representable, and collation notes.
- `sample_size` stores the article's reported strict lower bound when the article says “more than,” never a fabricated exact count.
- Specific-card probabilities exist only where the article explicitly acknowledges an equal-population assumption and the eligible count is known.
- A pooled two-set study does not silently become a card-specific single-set estimate.
- An unknown or missing rate is recorded in the explicit unavailability ledger and is never converted to zero or imputed from another set.
- Raw article bodies and images are neither committed nor written to the database.
- Changed source content, changed terms, or wider use requires a new immutable review rather than editing this decision into an approval.
