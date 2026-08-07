# TCGCSV mapping review — product 590027 / holofoil

**Reviewed:** August 5, 2026  
**Decision:** Approved for the private research mapping ledger  
**Mapping version:** `tcgcsv-research-mapping-v1`

## Proposed identity

| Field | TCGCSV | Independent catalog evidence | Canonical value |
|---|---|---|---|
| Game | Pokémon category `3` | Pokémon TCG API card `sv8-238` | `pokemon` |
| Set | Group `23651`, `SV08: Surging Sparks` | Set `sv8`, `Surging Sparks` | `set|pokemon|en|sv08` |
| Card | `Pikachu ex - 238/191` | `Pikachu ex`, number `238`, printed total `191` | `Pikachu ex`, `238/191` |
| Rarity | `Special Illustration Rare` | `Special Illustration Rare` | `Special Illustration Rare` |
| Finish | Price subtype `Holofoil` | The catalog's TCGplayer price object exposes only `holofoil` | `holofoil` |
| Condition class | Aggregate raw-card market price | Ungraded card catalog record | `raw` |

Evidence endpoints retrieved during review:

- <https://tcgcsv.com/tcgplayer/3/23651/products>
- <https://tcgcsv.com/tcgplayer/3/23651/prices>
- <https://api.pokemontcg.io/v2/cards/sv8-238>

The deterministic canonical variant is `80b4934a-96db-5f4c-8641-f7c74e0eb949`. The first live candidate used `exact_variant_identity`, confidence `0.99`, and candidate hash `f12339854c50b3bfd14160270bdec3959407994fa0afebc529919508426563fa`.

## Decision boundary

The set, card number, name, rarity, finish, and raw condition semantics agree, so the external identity `590027 / holofoil` is approved for this canonical variant. The stable mapping ID is `874f918c-8988-59f5-93ba-ff1ea961bd5a`.

This review approves identity only. It does not grant public/commercial source rights, approve imagery, convert TCGCSV out of research-only mode, validate any forecast, or authorize `public_price_intelligence`.
