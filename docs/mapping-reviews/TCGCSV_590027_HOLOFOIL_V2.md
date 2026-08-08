# TCGCSV mapping correction — product 590027 / holofoil

**Reviewed:** August 8, 2026  
**Decision:** Correct to the canonical catalog identity for future private research  
**Mapping version:** `tcgcsv-research-mapping-v2`

## Exact replacement

| Field | Reviewed external evidence | Canonical replacement |
|---|---|---|
| External identity | TCGCSV product `590027`, price subtype `Holofoil`, group `23651` | unchanged |
| Set | Group label `SV08: Surging Sparks`; upstream set ID `sv8`, name `Surging Sparks` | `set|pokemon|en|sv8` |
| Card | `Pikachu ex - 238/191`; upstream card `sv8-238`, number `238` | `card|set|pokemon|en|sv8|238|pikachu-ex` |
| Rarity | `Special Illustration Rare` in both sources | `Special Illustration Rare` |
| Printing | TCGCSV price subtype `Holofoil` | `holofoil`, standard, English, raw |

The replacement catalog IDs are:

- set `369d6905-d6ac-597e-9a5c-9c0d153a6af7`;
- card `9b2cc742-ad22-5b4d-9542-0dd2dfbdeb4d`; and
- variant `af796afb-d8d3-5b4b-a95a-417e39e77b0a`.

Evidence retrieved during the review:

- <https://tcgcsv.com/tcgplayer/3/23651/products> — product `590027` is `Pikachu ex - 238/191`, with card number `238/191` and rarity `Special Illustration Rare`;
- <https://tcgcsv.com/tcgplayer/3/23651/prices> — product `590027` exposes the `Holofoil` subtype;
- <https://raw.githubusercontent.com/PokemonTCG/pokemon-tcg-data/master/sets/en.json> — set `sv8` is `Surging Sparks`, printed total `191`, released `2024-11-08`; and
- <https://raw.githubusercontent.com/PokemonTCG/pokemon-tcg-data/master/cards/en/sv8.json> — card `sv8-238` is `Pikachu ex`, number `238`, rarity `Special Illustration Rare`.

The hosted canonical catalog independently contains the exact set, card, and finish-specific variant above. The TCGCSV group label's zero-padded `SV08` and its display number `238/191` are source presentation fields; the canonical catalog uses the upstream set ID `sv8` and collector number `238`.

## Supersession boundary

The approved v1 mapping `874f918c-8988-59f5-93ba-ff1ea961bd5a` points to duplicate variant `80b4934a-96db-5f4c-8641-f7c74e0eb949`. It must not be edited or deleted. The guarded supersession RPC will reject and close that mapping, create one approved v2 successor, and append a `corrected` mapping-review event.

All 54 historical observations, 43 trend snapshots, and 215 predictions remain attached to the v1 `sv08` lineage. Only future current-snapshot research may use the v2 `sv8` mapping. No historical row is re-keyed, no public candidate or publication is created, TCGCSV remains research-only, `public_price_intelligence` remains disabled, and this decision grants no catalog, pricing, imagery, or commercial rights.
