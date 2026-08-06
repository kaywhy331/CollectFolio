import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CANDIDATE_MAPPING_VERSION,
  computeIdentityHash,
  createOnDemandConfig,
  matchCandidate,
  runOnDemandRefresh
} from '../netlify/lib/justtcg-ondemand-collector.mjs';
import { identityShard } from '../netlify/lib/justtcg-ondemand-repository.mjs';
import { JustTcgRequestError } from '../netlify/lib/justtcg-http.mjs';

const API_KEY = 'server-only-test-key';
const BASE_TIME = new Date('2026-08-06T12:00:00.000Z');

function clone(value) {
  return structuredClone(value);
}

function config(overrides = {}) {
  return createOnDemandConfig({ JUSTTCG_API_KEY: API_KEY, ...overrides });
}

class MemoryOnDemandRepository {
  constructor({ collectorState = null, collectorPages = {} } = {}) {
    this.control = null;
    this.controlEtag = null;
    this.controlVersion = 0;
    this.freshnessShards = new Map();
    this.mappingShards = new Map();
    this.candidateShards = new Map();
    this.responses = new Map();
    this.collectorState = collectorState;
    this.collectorPages = collectorPages;
  }

  async loadControl() {
    return this.control ? { control: clone(this.control), etag: this.controlEtag } : null;
  }

  async saveControl(control, expectedEtag) {
    if (expectedEtag === null) {
      if (this.control) return { modified: false };
    } else if (!this.control || expectedEtag !== this.controlEtag) {
      return { modified: false };
    }
    this.controlVersion += 1;
    this.controlEtag = `control-${this.controlVersion}`;
    this.control = clone(control);
    return { modified: true, etag: this.controlEtag };
  }

  async loadFreshnessShard(shard) {
    const entry = this.freshnessShards.get(shard);
    return entry ? { map: clone(entry.map), etag: entry.etag } : { map: {}, etag: null };
  }

  async saveFreshnessShard(shard, map) {
    const version = (this.freshnessShards.get(shard)?.version || 0) + 1;
    this.freshnessShards.set(shard, { map: clone(map), etag: `fresh-${shard}-${version}`, version });
    return { modified: true };
  }

  async loadMappingShard(shard) {
    return clone(this.mappingShards.get(shard) || {});
  }

  setMapping(hash, entry) {
    const shard = identityShard(hash);
    const current = this.mappingShards.get(shard) || {};
    this.mappingShards.set(shard, { ...current, [hash]: entry });
  }

  async loadCandidateShard(shard) {
    return clone(this.candidateShards.get(shard) || {});
  }

  async saveCandidateShard(shard, map) {
    this.candidateShards.set(shard, clone(map));
    return { modified: true };
  }

  setFreshness(hash, entry) {
    const shard = identityShard(hash);
    const current = this.freshnessShards.get(shard)?.map || {};
    const version = (this.freshnessShards.get(shard)?.version || 0) + 1;
    this.freshnessShards.set(shard, { map: { ...current, [hash]: entry }, etag: `fresh-${shard}-${version}`, version });
  }

  async saveResponse(record) {
    if (this.responses.has(record.requestId)) return { modified: false };
    this.responses.set(record.requestId, clone(record));
    return { modified: true };
  }

  async readCollectorState() {
    return this.collectorState ? clone(this.collectorState) : null;
  }

  async readCollectorPage(offset) {
    return this.collectorPages[offset] ? clone(this.collectorPages[offset]) : null;
  }
}

function identity(overrides = {}) {
  return {
    provider: 'pokemon',
    externalId: 'base1-4',
    name: 'Charizard',
    setName: 'Base Set',
    game: 'pokemon',
    ...overrides
  };
}

function lookupResponsePayload(items, { remaining = 999, plan = 'Free' } = {}) {
  return {
    data: items.map((item, index) => ({
      id: `jt-${item.value}`,
      name: `Card ${index}`,
      variants: [{ id: `variant-${index}`, price: 5 + index }]
    })),
    meta: { total: items.length, limit: 20, offset: 0, hasMore: false },
    _metadata: { apiPlan: plan, apiRequestsRemaining: remaining }
  };
}

test('computeIdentityHash always produces a clean 64-char hex digest, even for adversarial input', () => {
  const clean = computeIdentityHash(identity());
  assert.match(clean, /^[0-9a-f]{64}$/);

  const malicious = computeIdentityHash(identity({ externalId: '../../../catalog/catalog-v1/deadbeef/state' }));
  assert.match(malicious, /^[0-9a-f]{64}$/);
  assert.equal(malicious.includes('catalog'), false);
  assert.equal(malicious.includes('/'), false);

  assert.equal(computeIdentityHash(identity({ externalId: '' })), null);
  assert.equal(computeIdentityHash({}), null);
});

test('identityShard rejects anything that is not a validated 64-char hex hash', () => {
  assert.throws(() => identityShard('../../catalog/x'));
  assert.throws(() => identityShard(''));
  assert.match(identityShard(computeIdentityHash(identity())), /^[0-9a-f]$/);
});

test('a mapped, stale card is fetched and its provenance/freshness are recorded', async () => {
  const repository = new MemoryOnDemandRepository();
  const card = identity();
  const hash = computeIdentityHash(card);
  repository.setMapping(hash, { identifierField: 'cardId', identifierValue: 'base1-4' });

  const calls = [];
  const result = await runOnDemandRefresh({
    repository,
    config: config(),
    userHash: 'user-a',
    identities: [card],
    now: () => BASE_TIME,
    random: () => 0,
    requestId: () => 'req-1',
    fetchLookup: async (args) => {
      calls.push(args.items);
      return lookupResponsePayload(args.items, { remaining: 30 });
    }
  });

  assert.equal(result.outcome, 'ok');
  assert.equal(result.checked, 1);
  assert.equal(result.eligible, 1);
  assert.equal(result.fetched, 1);
  assert.equal(result.alreadyFresh, 0);
  assert.equal(result.needsMapping, 0);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [{ field: 'cardId', value: 'base1-4' }]);

  const record = repository.responses.get('req-1');
  assert.ok(record, 'a provenance record must be persisted');
  assert.equal(record.requestId, 'req-1');
  assert.equal(record.fetchedAt, BASE_TIME.toISOString());
  assert.equal(record.normalizationVersion, 'justtcg-ondemand-v1');
  assert.deepEqual(record.requestedIdentifiers, [{ identityHash: hash, field: 'cardId', value: 'base1-4' }]);
  assert.equal(record.provenance.endpoint, 'POST /cards');
  assert.equal(record.provenance.apiRequestsRemaining, 30);
  assert.ok(record.response, 'raw response must be preserved verbatim');
  assert.equal(JSON.stringify(result).match(/\bprice\b/i), null, 'the returned summary must never carry price data');

  const shard = identityShard(hash);
  const freshness = repository.freshnessShards.get(shard).map[hash];
  assert.equal(freshness.t, Math.floor(BASE_TIME.getTime() / 1_000));
  assert.equal(freshness.f, 0);
  assert.equal(freshness.nb, null);
  assert.equal(repository.control.inFlight[hash], undefined, 'the claim must be released after a successful finalize');
});

test('an already-fresh mapped card is skipped and never reaches the provider', async () => {
  const repository = new MemoryOnDemandRepository();
  const card = identity();
  const hash = computeIdentityHash(card);
  repository.setMapping(hash, { identifierField: 'cardId', identifierValue: 'base1-4' });
  repository.setFreshness(hash, { t: Math.floor(BASE_TIME.getTime() / 1_000) - 3_600, f: 0, nb: null });

  let calls = 0;
  const result = await runOnDemandRefresh({
    repository,
    config: config(),
    userHash: 'user-a',
    identities: [card],
    now: () => BASE_TIME,
    fetchLookup: async () => { calls += 1; return lookupResponsePayload([]); }
  });

  assert.equal(result.outcome, 'no_eligible_cards');
  assert.equal(result.alreadyFresh, 1);
  assert.equal(result.fetched, 0);
  assert.equal(calls, 0);
});

test('an unmapped card is never fetched and is reported as needing a mapping', async () => {
  const repository = new MemoryOnDemandRepository();
  let calls = 0;
  const result = await runOnDemandRefresh({
    repository,
    config: config(),
    userHash: 'user-a',
    identities: [identity()],
    now: () => BASE_TIME,
    fetchLookup: async () => { calls += 1; return lookupResponsePayload([]); }
  });
  assert.equal(result.outcome, 'no_eligible_cards');
  assert.equal(result.needsMapping, 1);
  assert.equal(calls, 0);
});

test('a card in per-identity backoff (nb in the future) is skipped by selection', async () => {
  const repository = new MemoryOnDemandRepository();
  const card = identity();
  const hash = computeIdentityHash(card);
  repository.setMapping(hash, { identifierField: 'cardId', identifierValue: 'base1-4' });
  repository.setFreshness(hash, { t: 0, f: 3, nb: Math.floor(BASE_TIME.getTime() / 1_000) + 3_600 });

  let calls = 0;
  const result = await runOnDemandRefresh({
    repository,
    config: config(),
    userHash: 'user-a',
    identities: [card],
    now: () => BASE_TIME,
    fetchLookup: async () => { calls += 1; return lookupResponsePayload([]); }
  });
  assert.equal(result.outcome, 'no_eligible_cards');
  assert.equal(result.eligible, 0);
  assert.equal(result.alreadyFresh, 0, 'a backed-off card is neither fresh nor eligible, just excluded');
  assert.equal(calls, 0);
});

test('a provider failure releases the claim, backs off, and never refunds the reserved attempt', async () => {
  const repository = new MemoryOnDemandRepository();
  const card = identity();
  const hash = computeIdentityHash(card);
  repository.setMapping(hash, { identifierField: 'cardId', identifierValue: 'base1-4' });

  const result = await runOnDemandRefresh({
    repository,
    config: config(),
    userHash: 'user-a',
    identities: [card],
    now: () => BASE_TIME,
    random: () => 0,
    fetchLookup: async () => {
      throw new JustTcgRequestError('http_500', 'boom', { status: 500, retryable: true });
    }
  });

  assert.equal(result.outcome, 'provider_error');
  assert.equal(repository.control.dailyAttempts, 1, 'the reserved attempt is charged even though the call failed');
  assert.equal(repository.control.inFlight[hash], undefined, 'the claim is released after a failure');
  assert.equal(repository.control.consecutiveFailures, 1);
  assert.ok(Date.parse(repository.control.notBefore) > BASE_TIME.getTime());
});

test('a claim still held by an in-flight request is never re-claimed by a concurrent request', async () => {
  // Deterministic interleaving instead of hoping Promise.all races a
  // particular way: invocation A is deliberately paused *after* it has
  // reserved its claims but *before* it calls the provider, so invocation B
  // runs concurrently against a control.json that provably still holds A's
  // live, unexpired claims.
  const repository = new MemoryOnDemandRepository();
  const cards = [identity({ externalId: 'base1-1', name: 'Card 1' }), identity({ externalId: 'base1-2', name: 'Card 2' })];
  cards.forEach((card) => repository.setMapping(computeIdentityHash(card), { identifierField: 'cardId', identifierValue: card.externalId }));

  let releaseA;
  const gate = new Promise((resolve) => { releaseA = resolve; });
  const aPromise = runOnDemandRefresh({
    repository, config: config(), userHash: 'user-a', identities: cards, now: () => BASE_TIME, random: () => 0,
    fetchLookup: async (args) => { await gate; return lookupResponsePayload(args.items); }
  });

  // Let A run through every microtask-only step (mapping/freshness reads,
  // the reserve-floor check, and the control.json CAS reservation) up to the
  // point where it is suspended awaiting the gated provider call.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(Object.keys(repository.control?.inFlight || {}).length, 2, "A's claims must already be live before B starts");

  const bResult = await runOnDemandRefresh({
    repository, config: config(), userHash: 'user-b', identities: cards, now: () => BASE_TIME, random: () => 0,
    fetchLookup: async () => { throw new Error('B must never reach the provider while A holds the claim'); }
  });
  assert.equal(bResult.fetched, 0, 'B must not fetch anything A is still holding a live claim on');
  assert.ok(['busy', 'no_eligible_cards'].includes(bResult.outcome));

  releaseA();
  const aResult = await aPromise;
  assert.equal(aResult.outcome, 'ok');
  assert.equal(aResult.fetched, 2);
  assert.equal(repository.control.inFlight[computeIdentityHash(cards[0])], undefined, 'A releases its claims once it finalizes');
});

test('the per-user daily cap defers a request even when the card itself is eligible', async () => {
  const repository = new MemoryOnDemandRepository();
  const userDailyLimit = 3;
  const cards = Array.from({ length: userDailyLimit + 1 }, (_, index) => identity({ externalId: `base1-${index}`, name: `Card ${index}` }));
  const outcomes = [];
  for (const card of cards) {
    const hash = computeIdentityHash(card);
    repository.setMapping(hash, { identifierField: 'cardId', identifierValue: card.externalId });
    // eslint-disable-next-line no-await-in-loop
    const result = await runOnDemandRefresh({
      repository, config: config({ JUSTTCG_ONDEMAND_USER_DAILY_LIMIT: String(userDailyLimit), JUSTTCG_ONDEMAND_USER_MIN_INTERVAL_MS: '0' }),
      userHash: 'user-a', identities: [card], now: () => BASE_TIME, random: () => 0,
      fetchLookup: async (args) => lookupResponsePayload(args.items)
    });
    outcomes.push(result.outcome);
  }
  assert.deepEqual(outcomes.slice(0, userDailyLimit), ['ok', 'ok', 'ok']);
  assert.equal(outcomes[userDailyLimit], 'quota_deferred');
});

test('the per-user minimum interval defers a second request from the same user too soon', async () => {
  const repository = new MemoryOnDemandRepository();
  const first = identity({ externalId: 'base1-1', name: 'Card 1' });
  const second = identity({ externalId: 'base1-2', name: 'Card 2' });
  repository.setMapping(computeIdentityHash(first), { identifierField: 'cardId', identifierValue: 'base1-1' });
  repository.setMapping(computeIdentityHash(second), { identifierField: 'cardId', identifierValue: 'base1-2' });

  const shared = { repository, config: config(), userHash: 'user-a', random: () => 0, fetchLookup: async (args) => lookupResponsePayload(args.items) };
  const initial = await runOnDemandRefresh({ ...shared, identities: [first], now: () => BASE_TIME });
  assert.equal(initial.outcome, 'ok');

  const tooSoon = await runOnDemandRefresh({ ...shared, identities: [second], now: () => new Date(BASE_TIME.getTime() + 1_000) });
  assert.equal(tooSoon.outcome, 'quota_deferred');
});

test('the reserve-floor guard defers when the scheduled crawl reports low remaining quota, before spending any on-demand attempt', async () => {
  const repository = new MemoryOnDemandRepository({ collectorState: { quota: { apiRequestsRemaining: 10 } } });
  const card = identity();
  repository.setMapping(computeIdentityHash(card), { identifierField: 'cardId', identifierValue: 'base1-4' });

  let calls = 0;
  const result = await runOnDemandRefresh({
    repository, config: config({ JUSTTCG_ONDEMAND_RESERVE_FLOOR: '50' }), userHash: 'user-a',
    identities: [card], now: () => BASE_TIME,
    fetchLookup: async () => { calls += 1; return lookupResponsePayload([]); }
  });
  assert.equal(result.outcome, 'quota_deferred');
  assert.equal(calls, 0);
  assert.equal(repository.control, null, 'no attempt was ever reserved');
});

test('a low apiRequestsRemaining observed from an on-demand fetch itself also defers the next request', async () => {
  const repository = new MemoryOnDemandRepository();
  const first = identity({ externalId: 'base1-1', name: 'Card 1' });
  const second = identity({ externalId: 'base1-2', name: 'Card 2' });
  repository.setMapping(computeIdentityHash(first), { identifierField: 'cardId', identifierValue: 'base1-1' });
  repository.setMapping(computeIdentityHash(second), { identifierField: 'cardId', identifierValue: 'base1-2' });

  const shared = { repository, config: config(), random: () => 0 };
  const initial = await runOnDemandRefresh({
    ...shared, userHash: 'user-a', identities: [first], now: () => BASE_TIME,
    fetchLookup: async (args) => lookupResponsePayload(args.items, { remaining: 40 })
  });
  assert.equal(initial.outcome, 'ok');

  let calls = 0;
  const next = await runOnDemandRefresh({
    ...shared, userHash: 'user-b', identities: [second], now: () => BASE_TIME,
    fetchLookup: async (args) => { calls += 1; return lookupResponsePayload(args.items); }
  });
  assert.equal(next.outcome, 'quota_deferred');
  assert.equal(calls, 0, 'the reserve-floor guard must block before spending a second attempt');
});

test('an unmapped card with exactly one name+set match in already-crawled pages produces an unreviewed candidate, never an approved mapping', async () => {
  const repository = new MemoryOnDemandRepository({
    collectorState: { nextOffset: 20, quota: { apiRequestsRemaining: 999 } },
    collectorPages: {
      0: { response: { data: [{ id: 'jt-pika', name: 'Pikachu', set_name: 'Base Set', game: 'pokemon', tcgplayerId: 555 }] } }
    }
  });
  const card = identity({ externalId: 'base1-58', name: 'Pikachu', setName: 'Base Set' });
  const result = await runOnDemandRefresh({
    repository, config: config(), userHash: 'user-a', identities: [card], now: () => BASE_TIME,
    fetchLookup: async () => { throw new Error('must not be called for an unmapped card'); }
  });
  assert.equal(result.candidatesGenerated, 1);
  const hash = computeIdentityHash(card);
  const candidate = repository.candidateShards.get(identityShard(hash))[hash];
  assert.equal(candidate.disposition, 'review');
  assert.equal(candidate.notAnApprovedCanonicalMapping, true);
  assert.equal(candidate.privateLedgerStatus, 'unreviewed_candidate');
  assert.equal(candidate.identifierField, 'tcgplayerId');
  assert.equal(candidate.identifierValue, '555');
  assert.equal(candidate.mappingVersion, CANDIDATE_MAPPING_VERSION);
  assert.ok(candidate.mappingConfidence < 0.98, 'a heuristic candidate must never reach the real-mapping confidence threshold');
});

test('matchCandidate abstains rather than guessing when zero or multiple cards match', () => {
  assert.equal(matchCandidate(identity({ name: 'Pikachu' }), []), null);
  assert.equal(
    matchCandidate(identity({ name: 'Pikachu', setName: 'Base Set' }), [
      { id: 'a', name: 'Pikachu', set_name: 'Base Set' },
      { id: 'b', name: 'Pikachu', set_name: 'Base Set' }
    ]),
    null
  );
});
