# Cardbase MTG private research collector

## Boundary

Cardbase is CollectFolio's preferred continuous **Magic-only private research** source.
It does not replace JustTCG for the reviewed Pokémon path, and it does not activate
public price intelligence. TCGCSV is retained as a manual/static research batch and
corroboration source; its scheduled pulls are parked.

The collector:

- requests up to 365 days for a bounded, operator-reviewed cohort of at most 50
  Scryfall printings and 250 exact series per run;
- uses exactly one `CARDBASE_API_KEY` and never rotates keys or pools quota;
- keeps vendor, finish, price type, and currency as separate exact market series;
- paces price requests at 1.05 seconds or slower and honors bounded `Retry-After`;
- persists first-seen availability so a rolling replay cannot invent historical
  knowledge;
- requires the canonical first-seen state to restore successfully before any hosted
  request, so an object-store outage cannot silently reset provenance;
- emits incremental `centralized-history-import-v1` packets containing only new or
  revised price points;
- stores full packets and the first-seen ledger only in a private object store; and
- emits no publication or forecast rows and writes no database.

The source decision and live-review findings are in
[`source-reviews/CARDBASE_MTG_RESEARCH_CANDIDATE.md`](source-reviews/CARDBASE_MTG_RESEARCH_CANDIDATE.md).

## Cohort manifest

The cohort manifest is operator evidence and stays in the private archive. Its source
`documentHash` must equal the SHA-256 of the checked-in source review. A minimal shape
is:

```json
{
  "mode": "private_cardbase_mtg_history",
  "source": {
    "id": "source UUID",
    "termsReviewId": "terms-review UUID",
    "currentTermsReviewId": "the same current review UUID",
    "code": "cardbase",
    "name": "Cardbase MTG price history API",
    "decision": "research_only",
    "active": true,
    "commercialUseAllowed": true,
    "catalogMetadataAllowed": true,
    "publicRawDisplayAllowed": false,
    "publicDerivedDisplayAllowed": false,
    "attributionRequired": false,
    "attributionText": "",
    "documentHash": "SHA-256 of the checked-in Cardbase source review",
    "reviewedAt": "timezone-aware ISO timestamp",
    "expiresAt": "short, timezone-aware ISO expiry"
  },
  "mappingVersion": "cardbase-mtg-mapping-v1",
  "mappingReview": {
    "decision": "approved",
    "scope": "private_research",
    "documentHash": "SHA-256 of the operator mapping-review artifact",
    "reviewedAt": "timezone-aware ISO timestamp"
  },
  "cardbase": {
    "historyDays": 365,
    "requestIntervalSeconds": 1.05,
    "qualityScore": 0.85,
    "printings": [
      {
        "scryfallId": "reviewed Scryfall printing UUID",
        "series": [
          {
            "mappingId": "approved external mapping UUID",
            "variantId": "canonical catalog variant UUID",
            "vendor": "tcgplayer",
            "finish": "normal",
            "priceType": "retail",
            "currency": "USD",
            "language": "en",
            "conditionClass": "raw",
            "marketCondition": "provider-aggregate",
            "mappingConfidence": 1.0,
            "minimumPoints": 30
          }
        ]
      }
    ]
  },
  "operator": {
    "label": "cardbase-mtg-private-research",
    "parserVersion": "cardbase-api-v1",
    "codeVersion": "deployed commit SHA",
    "metadata": { "cohort": "reviewed cohort identifier" }
  }
}
```

The manifest intentionally has no `apiKeys`, `keyRotation`, or similar field. The CLI
rejects those fields. A mapping declares `provider-aggregate` because the reviewed API
does not supply condition-specific history. Mapping approval must also compare
overlapping 7-, 30-, and 365-day responses for stable vendor/finish/type/currency and
amounts; the August 15 review found a Cardhoarder TIX/USD drift across windows, so an
operator may not infer that those dimensions are stable.

## Private workflow configuration

The scheduled workflow is present but inactive until the following configuration is
provided:

Repository variable:

- `CARDBASE_MTG_RESEARCH_ENABLED=true`
- `CARDBASE_MTG_MANIFEST_S3_URI=s3://private-bucket/path/cohort.json`
- `CARDBASE_MTG_ARCHIVE_S3_URI=s3://private-bucket/path/cardbase`
- `CARDBASE_MTG_ARCHIVE_S3_ENDPOINT` only for an S3-compatible non-AWS endpoint
- `CARDBASE_MTG_ARCHIVE_REGION` (defaults to `us-east-1`)

Repository secret:

- `CARDBASE_API_KEY` — one free Cardbase key with prefix `cbdev_`
- `CARDBASE_MTG_ARCHIVE_ACCESS_KEY_ID`
- `CARDBASE_MTG_ARCHIVE_SECRET_ACCESS_KEY`

The object store should be private and versioned. Its service credential should be
limited to the configured prefix. The canonical state object is mutable by design but
must have bucket versioning; import packets and receipts are immutable run objects.
Before enabling the workflow, seed
`state/first-seen-ledger.json` below the configured archive URI with this empty,
integrity-checked ledger (or restore the latest valid ledger when resuming an existing
cohort):

```json
{
  "contractVersion": "cardbase-first-seen-ledger-v1",
  "recordCount": 0,
  "entries": [],
  "ledgerSha256": "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"
}
```

The hosted workflow treats a missing or unreadable canonical state as a hard failure.
It never assumes that a restore error means this is the first run.

## Local rehearsal

Use a temporary directory with restrictive permissions. The first run has no prior
state:

```sh
umask 077
export CARDBASE_API_KEY='cbdev_server_secret'
PYTHONPATH=analytics/src python3 -m collectfolio_analytics.cardbase_history_cli \
  cohort.json \
  --output cardbase-import.json \
  --state-output cardbase-first-seen.json \
  --sql-output cardbase-import-rehearsal.sql
```

Later runs supply the prior state and write a new state path:

```sh
PYTHONPATH=analytics/src python3 -m collectfolio_analytics.cardbase_history_cli \
  cohort.json \
  --state cardbase-first-seen.json \
  --output cardbase-import-next.json \
  --state-output cardbase-first-seen-next.json
```

An exact replay returns a `private_cardbase_mtg_history_noop` receipt. A later day emits
only new dates; a provider correction emits a new value-digested record with its new
first-seen timestamp. The optional SQL always defaults to `rollback` and is unavailable
for a no-op.

## Promotion and database gates

The private packet is evidence, not a prediction. Do not apply its SQL until:

1. migrations 0015–0019 pass independent backup, rollback, Auth/storage, and ACL/RLS
   rehearsal on the target project;
2. the data source, terms review, canonical variants, and exact mappings already exist
   in the target database and match the packet;
3. the operator reviews the packet hashes, counts, history floor, and every quarantine;
4. a dedicated database write credential and audited transaction path are approved; and
5. public feature flags remain false.

Cardbase histories can improve MTG research coverage, but they do not by themselves
increase forecast confidence. Confidence must come from prospective observations,
held-out evaluation, calibration, source-specific baselines, and enough independent
cards/origins—not from treating correlated vendor feeds or revised backfills as extra
samples.
