# Pull-rate registry curation and operator runbook

As of August 8, 2026, the checked-in TCGplayer curation covers 20 of the 22 canonical Scarlet & Violet / Mega Evolution expansions with 19 primary pack-opening studies and 112 set/rarity rows. Shrouded Fable and Pitch Black have no TCGplayer Authentication Center study in the publisher's pull-rate index. Black Bolt and White Flare's Black White Rare rate is also explicitly unknown because the pooled study observed zero copies in more than 700 packs.

The database lane stays private research-only: `pull_rate_sources`, `set_pull_rates`, and `pull_rate_unavailability` have RLS enabled, no anon/authenticated grants, and append-only service-role access. Nothing here enables public price intelligence or publishes pull rates to the browser.

The weekly `pull-rate-integrity.yml` workflow rebuilds the deterministic packet, re-fetches all 19 primary article JSON documents from the fixed HTTPS API origin, verifies their UUID/title/date/update/body hashes, regenerates rollback-only SQL, and retains both artifacts for 30 days. It has no Supabase credential or database command. A changed article or packet hash fails visibly and requires a new operator review; the workflow never accepts drift by rewriting the manifest.

## Coverage

| Canonical set | Primary study state |
|---|---|
| Scarlet & Violet (`sv1`) | TCGplayer article; 5 rates |
| Paldea Evolved (`sv2`) | TCGplayer article; 5 rates |
| Obsidian Flames (`sv3`) | TCGplayer article; 5 rates |
| 151 (`sv3pt5`) | TCGplayer article; 6 rates |
| Paradox Rift (`sv4`) | TCGplayer article; 5 rates |
| Paldean Fates (`sv4pt5`) | TCGplayer article; 7 rates |
| Temporal Forces (`sv5`) | TCGplayer article; 6 rates |
| Twilight Masquerade (`sv6`) | TCGplayer article; 6 rates |
| Shrouded Fable (`sv6pt5`) | Explicitly unavailable; no study found |
| Stellar Crown (`sv7`) | TCGplayer article; 6 rates |
| Surging Sparks (`sv8`) | TCGplayer article; 6 rates |
| Prismatic Evolutions (`sv8pt5`) | TCGplayer article; 7 rates |
| Journey Together (`sv9`) | TCGplayer article; 5 rates |
| Destined Rivals (`sv10`) | TCGplayer article; 5 rates |
| Black Bolt (`zsv10pt5`) | Pooled Black Bolt / White Flare article; 6 known rates, Black White Rare unknown |
| White Flare (`rsv10pt5`) | Pooled Black Bolt / White Flare article; 6 known rates, Black White Rare unknown |
| Mega Evolution (`me1`) | TCGplayer article; 5 rates |
| Phantasmal Flames (`me2`) | TCGplayer article; 5 rates |
| Ascended Heroes (`me2pt5`) | TCGplayer article; 6 rates |
| Perfect Order (`me3`) | TCGplayer article; 5 rates |
| Chaos Rising (`me4`) | TCGplayer article; 5 rates |
| Pitch Black (`me5`) | Explicitly unavailable; no study found |

## Curation decisions

- Rates, confidence margins, and rounded `1 in N` values come from each article's overall rarity table. The validator checks that the point estimate and rounded value agree within the registry's 15% communication-rounding tolerance.
- Article sample sizes are lower bounds because the articles say “more than N packs.” The source methodology and structured evidence preserve that qualifier.
- Eighty-five rows derive specific-card probabilities under an explicit article equal-population statement. Scarlet & Violet, Paldea Evolved, and Obsidian Flames omit specific fields because their articles do not state that assumption.
- Black Bolt / White Flare attaches the pooled rates to each set under the article's stated equal-set-rate assumption, but omits specific-card fields because the article pools two distinct checklists.
- Prismatic Evolutions' SIR number is labeled as average SIR cards per pack, not necessarily the share of packs with at least one SIR, because Demigod packs can contain three.
- Three Mega Hyper Rare normal-approximation intervals reach or cross zero. Migration 0009 requires a positive lower bound, so those CI columns are null and the exact published margin plus omission reason remain in immutable evidence/notes.
- Known article transcription/copy errors are documented on the affected rows; the overall rarity table wins. No value is silently repaired.

## Build and verify

Generate a permission-restricted packet while re-fetching every bounded public article record and requiring all 19 body hashes to match:

```sh
PYTHONPATH=analytics/src python3 -m collectfolio_analytics.pull_rate_curation_cli \
  analytics/manifests/tcgplayer-sv-me-pull-rates.json \
  /secure/new-pull-rate-packet.json \
  --verify-sources
```

Generate rollback-first SQL:

```sh
PYTHONPATH=analytics/src python3 -m collectfolio_analytics.pull_rate_sql_cli \
  /secure/new-pull-rate-packet.json \
  /secure/new-pull-rate-rehearsal.sql
```

The packet and SQL writers create mode-0600 files and refuse existing paths. The SQL generator recomputes the packet hash over database rows, source evidence, canonical-set evidence, and the missing-data ledger. Its transaction loads expected rows into temporary tables, re-verifies all 22 hosted catalog identities, inserts with deterministic IDs, and compares every stored field to the reviewed packet. It ends in `ROLLBACK` by default.

Apply migration `0014_pull_rate_unavailability_registry.sql` before the seed. Run the rehearsal SQL against the intended hosted project and confirm it completes with no persistent row-count change. Only then create the commit form:

```sh
PYTHONPATH=analytics/src python3 -m collectfolio_analytics.pull_rate_sql_cli \
  /secure/new-pull-rate-packet.json \
  /secure/new-pull-rate-commit.sql \
  --commit
```

Execute database artifacts only from a controlled service-role/operator PostgreSQL session. Never place database credentials in the packet, generated SQL, repository, browser, or command output.

## Refresh policy

Do not rewrite the August 8 snapshot. If TCGplayer edits an article, review the changed body, record a new retrieval timestamp/body hash, and append a new source/version. If a Shrouded Fable or Pitch Black study appears, append the new rates; retain the historical unavailability check. An article's later publication does not make its estimates point-in-time evidence before their actual publication/retrieval date.

The integrity workflow verifies known sources; it does not claim that an unavailable set can never receive a later study. Operators must still review the publisher index for Shrouded Fable, Pitch Black, and future sets. When a new primary study appears, append it through the same review, rehearsal, and commit lane rather than weakening the fixed packet hash in place.
