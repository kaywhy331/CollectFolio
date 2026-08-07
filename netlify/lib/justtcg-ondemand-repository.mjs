// Netlify Blobs storage for the on-demand JustTCG lookup path. Reuses the
// SAME 'collectfolio-justtcg-private' store as the scheduled crawl
// (justtcg-blob-repository.mjs), under a separate 'ondemand/' prefix, so
// operator recovery tooling only ever has one store to reason about.
//
// Key-safety invariant: every key this module builds is either (a) a fixed
// literal, (b) derived from server-configured collectionId/queryHash (never
// request data), or (c) a single hex character or a full 64-char hex sha256
// digest that has been format-validated immediately before use. Nothing a
// caller supplies can ever reach a key unless it has already passed one of
// those two regexes — so it is not possible for request-derived data (an
// externalId, a card name, anything from Supabase jsonb) to influence a blob
// path, let alone one that collides with the crawl's own 'catalog/' prefix.
// The one and only place this module references 'catalog/' is
// readCollectorState() below, built from the same already-validated
// collectionId/queryHash the crawl itself validates in createCollectorConfig
// — never from anything in an HTTP request.
import { CollectorContractError } from './justtcg-collector.mjs';

const HEX_HASH = /^[0-9a-f]{64}$/;
const HEX_SHARD = /^[0-9a-f]$/;
const SAFE_COLLECTION_ID = /^[a-z0-9]+(?:[a-z0-9._-]*[a-z0-9])?$/i;
const SAFE_REQUEST_ID = /^[0-9a-f-]{1,80}$/i;

function assertMatches(value, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new CollectorContractError('invalid_identity', `${label} failed validation`);
  }
  return value;
}

// The shard a given identity's freshness/mapping/candidate record lives in —
// always exactly one of the 16 hex characters, so there are always exactly
// 16 shard files per ledger regardless of how many distinct cards exist.
export function identityShard(identityHash) {
  return assertMatches(identityHash, HEX_HASH, 'identityHash')[0];
}

export function createJustTcgOnDemandRepository(store, { collectionId, catalogQueryHash }) {
  if (
    !store ||
    typeof store.getWithMetadata !== 'function' ||
    typeof store.setJSON !== 'function' ||
    typeof store.get !== 'function'
  ) {
    throw new TypeError('a Netlify Blobs store is required');
  }
  const safeCollectionId = assertMatches(collectionId, SAFE_COLLECTION_ID, 'collectionId');
  const safeQueryHash = assertMatches(catalogQueryHash, HEX_HASH, 'catalogQueryHash');
  const prefix = `ondemand/${safeCollectionId}`;
  const collectorStateKey = `catalog/${safeCollectionId}/${safeQueryHash}/state.json`;

  return Object.freeze({
    async loadControl() {
      const entry = await store.getWithMetadata(`${prefix}/control.json`, { consistency: 'strong', type: 'json' });
      return entry ? { control: entry.data, etag: entry.etag } : null;
    },

    async saveControl(control, expectedEtag) {
      return store.setJSON(
        `${prefix}/control.json`,
        control,
        expectedEtag ? { onlyIfMatch: expectedEtag } : { onlyIfNew: true }
      );
    },

    // Lower rigor than control.json by design: a lost update here just costs
    // one redundant refetch later, never a correctness violation, so plain
    // read-modify-write (last write wins) is an accepted trade-off — see the
    // plan doc's "Identity and the private mapping/candidate ledgers".
    async loadFreshnessShard(shard) {
      assertMatches(shard, HEX_SHARD, 'shard');
      const entry = await store.getWithMetadata(`${prefix}/freshness/${shard}.json`, { consistency: 'strong', type: 'json' });
      return entry ? { map: entry.data, etag: entry.etag } : { map: {}, etag: null };
    },

    async saveFreshnessShard(shard, map) {
      assertMatches(shard, HEX_SHARD, 'shard');
      return store.setJSON(`${prefix}/freshness/${shard}.json`, map);
    },

    // Operator-maintained only. The runtime on-demand path only ever reads
    // this; nothing in this module writes it back except saveMappingShard,
    // which only the out-of-band seeding script calls.
    async loadMappingShard(shard) {
      assertMatches(shard, HEX_SHARD, 'shard');
      const value = await store.get(`${prefix}/mappings/${shard}.json`, { consistency: 'strong', type: 'json' });
      return value || {};
    },

    async saveMappingShard(shard, map) {
      assertMatches(shard, HEX_SHARD, 'shard');
      return store.setJSON(`${prefix}/mappings/${shard}.json`, map);
    },

    async loadCandidateShard(shard) {
      assertMatches(shard, HEX_SHARD, 'shard');
      const value = await store.get(`${prefix}/candidates/${shard}.json`, { consistency: 'strong', type: 'json' });
      return value || {};
    },

    async saveCandidateShard(shard, map) {
      assertMatches(shard, HEX_SHARD, 'shard');
      return store.setJSON(`${prefix}/candidates/${shard}.json`, map);
    },

    // Immutable evidence: one record per batch call, never overwritten.
    async saveResponse(record) {
      const requestId = assertMatches(record.requestId, SAFE_REQUEST_ID, 'requestId');
      const fetchedAt = new Date(record.fetchedAt);
      if (!Number.isFinite(fetchedAt.getTime())) {
        throw new CollectorContractError('invalid_identity', 'fetchedAt must be a valid instant');
      }
      const yyyy = String(fetchedAt.getUTCFullYear());
      const mm = String(fetchedAt.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(fetchedAt.getUTCDate()).padStart(2, '0');
      return store.setJSON(`${prefix}/responses/${yyyy}/${mm}/${dd}/${requestId}.json`, record, { onlyIfNew: true });
    },

    // Read-only cross-read of the scheduled crawl's own durable state, used
    // only as a reserve-floor guard so this feature yields headroom to the
    // crawl rather than racing it. This module never writes to 'catalog/'.
    async readCollectorState() {
      return store.get(collectorStateKey, { consistency: 'strong', type: 'json' });
    },

    // Read-only cross-read of one already-crawled catalog page, used only for
    // zero-extra-API-cost candidate generation. Offset must be a non-negative
    // multiple of 20, matching the crawl's own page-file convention exactly
    // (netlify/lib/justtcg-blob-repository.mjs's pageFile()).
    async readCollectorPage(offset) {
      if (!Number.isSafeInteger(offset) || offset < 0 || offset % 20 !== 0) {
        throw new CollectorContractError('invalid_identity', 'offset must be a non-negative multiple of 20');
      }
      const key = `catalog/${safeCollectionId}/${safeQueryHash}/pages/${String(offset).padStart(8, '0')}.json`;
      return store.get(key, { consistency: 'strong', type: 'json' });
    }
  });
}
