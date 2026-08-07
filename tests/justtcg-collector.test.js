import assert from 'node:assert/strict';
import test from 'node:test';

import { createJustTcgBlobRepository } from '../netlify/lib/justtcg-blob-repository.mjs';
import {
  JUSTTCG_COLLECTION_REQUEST_LIMIT,
  JUSTTCG_DAILY_REQUEST_LIMIT,
  JUSTTCG_PAGE_LIMIT,
  JUSTTCG_SCHEDULE,
  CollectorConfigError,
  JustTcgRequestError,
  buildCardsUrl,
  createCollectorConfig,
  createInitialState,
  fetchJustTcgPage,
  runCollectorInvocation,
  validatePage
} from '../netlify/lib/justtcg-collector.mjs';

const API_KEY = 'server-only-test-key';
const BASE_TIME = new Date('2026-08-05T00:10:00.000Z');

function clone(value) {
  return structuredClone(value);
}

function collectorConfig(overrides = {}) {
  return createCollectorConfig({ JUSTTCG_API_KEY: API_KEY, ...overrides });
}

function cards(offset, count = JUSTTCG_PAGE_LIMIT) {
  return Array.from({ length: count }, (_, index) => ({
    id: `card-${String(offset + index).padStart(8, '0')}`,
    name: `Card ${offset + index}`,
    variants: [{ id: `variant-${offset + index}`, price: 10 + index, priceHistory: [] }]
  }));
}

function pagePayload({
  offset = 0,
  count = JUSTTCG_PAGE_LIMIT,
  total = 25_000,
  hasMore = offset + count < total,
  plan = 'Free',
  remaining = 999,
  data = cards(offset, count),
  limit = JUSTTCG_PAGE_LIMIT
} = {}) {
  return {
    data,
    meta: { total, limit, offset, hasMore },
    _metadata: { apiPlan: plan, apiRequestsRemaining: remaining }
  };
}

class MemoryRepository {
  constructor(state = null) {
    this.state = state ? clone(state) : null;
    this.etag = state ? 'etag-1' : null;
    this.version = state ? 1 : 0;
    this.pages = new Map();
  }

  async loadState() {
    return this.state ? { state: clone(this.state), etag: this.etag } : null;
  }

  async saveState(state, expectedEtag) {
    if (expectedEtag === null) {
      if (this.state) return { modified: false };
    } else if (!this.state || expectedEtag !== this.etag) {
      return { modified: false };
    }
    this.version += 1;
    this.etag = `etag-${this.version}`;
    this.state = clone(state);
    return { modified: true, etag: this.etag };
  }

  async loadPage(offset) {
    const value = this.pages.get(offset);
    return value ? clone(value) : null;
  }

  async savePage(page) {
    if (this.pages.has(page.requestedOffset)) return { modified: false };
    this.pages.set(page.requestedOffset, clone(page));
    return { modified: true, etag: `page-${page.requestedOffset}` };
  }
}

test('collector config fixes the Free-tier quota and maximizes history per 20-card call', () => {
  const config = collectorConfig({ JUSTTCG_GAME: 'pokemon', JUSTTCG_COLLECTION_ID: 'pokemon-v1' });
  assert.equal(config.query.limit, 20);
  assert.equal(config.query.game, 'pokemon');
  assert.equal(config.query.include_price_history, true);
  assert.equal(config.query.priceHistoryDuration, '1y');
  assert.equal(config.query.include_statistics, '7d,30d,90d,allTime');
  assert.equal(config.query.include_null_prices, false);
  assert.equal(config.query.orderBy, 'price');
  assert.equal(config.query.order, 'desc');
  assert.equal(config.maxDailyRequests, 100);
  assert.equal(config.maxCollectionRequests, 1_000);
  assert.equal(JUSTTCG_SCHEDULE, '*/5 * * * *');
  assert.equal(JUSTTCG_DAILY_REQUEST_LIMIT, 100);
  assert.equal(JUSTTCG_COLLECTION_REQUEST_LIMIT, 1_000);
});

test('collector config defaults to all priced games and rejects unsafe identifiers', () => {
  assert.equal('game' in collectorConfig().query, false);
  assert.throws(() => createCollectorConfig({}), CollectorConfigError);
  assert.throws(
    () => collectorConfig({ JUSTTCG_GAME: 'pokemon&limit=200' }),
    /stable JustTCG game ID/
  );
});

test('cards URL uses offset pagination without placing the API key in the URL', () => {
  const config = collectorConfig({ JUSTTCG_GAME: 'pokemon' });
  const url = new URL(buildCardsUrl(config.query, 40));
  assert.equal(url.origin + url.pathname, 'https://api.justtcg.com/v1/cards');
  assert.equal(url.searchParams.get('limit'), '20');
  assert.equal(url.searchParams.get('offset'), '40');
  assert.equal(url.searchParams.get('game'), 'pokemon');
  assert.equal(url.searchParams.get('priceHistoryDuration'), '1y');
  assert.equal(url.toString().includes(API_KEY), false);
  assert.throws(() => buildCardsUrl(config.query, 1), /multiple of 20/);
});

test('HTTP client sends header-only authentication and returns bounded JSON', async () => {
  const config = collectorConfig();
  let request;
  const expected = pagePayload();
  const result = await fetchJustTcgPage({
    config,
    offset: 0,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify(expected), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    },
    now: BASE_TIME
  });
  assert.deepEqual(result, expected);
  assert.equal(request.options.headers['X-API-Key'], API_KEY);
  assert.equal(request.options.redirect, 'error');
  assert.equal(request.url.includes(API_KEY), false);
});

test('page contract follows meta.hasMore and rejects pagination inconsistencies', () => {
  const config = collectorConfig();
  const final = validatePage(pagePayload({ count: 7, total: 7, hasMore: false }), {
    config,
    requestedOffset: 0
  });
  assert.equal(final.hasMore, false);
  assert.throws(
    () => validatePage(pagePayload({ count: 7, total: 100, hasMore: true }), { config, requestedOffset: 0 }),
    /short page/
  );
  assert.throws(
    () => validatePage(pagePayload({ offset: 20 }), { config, requestedOffset: 0 }),
    /does not match/
  );
});

test('one invocation durably stores one page and advances exactly 20 cards', async () => {
  const config = collectorConfig();
  const repository = new MemoryRepository();
  const result = await runCollectorInvocation({
    repository,
    config,
    now: () => BASE_TIME,
    leaseId: () => 'lease-1',
    fetchPage: async ({ offset }) => pagePayload({ offset, remaining: 999 })
  });
  assert.equal(result.outcome, 'page_stored');
  assert.equal(repository.state.nextOffset, 20);
  assert.equal(repository.state.pageCount, 1);
  assert.equal(repository.state.cardRecordCount, 20);
  assert.equal(repository.state.approximateUniqueCardCount, 20);
  assert.equal(repository.state.quota.dailyAttempts, 1);
  assert.equal(repository.state.quota.totalAttempts, 1);
  assert.equal(repository.state.quota.totalSuccesses, 1);
  assert.equal(repository.pages.size, 1);
  assert.equal(JSON.stringify(repository.state).includes(API_KEY), false);
  assert.equal(JSON.stringify([...repository.pages.values()]).includes(API_KEY), false);
});

test('terminal short page remains valid and no later invocation calls the API', async () => {
  const config = collectorConfig();
  const repository = new MemoryRepository();
  let calls = 0;
  const first = await runCollectorInvocation({
    repository,
    config,
    now: () => BASE_TIME,
    fetchPage: async () => {
      calls += 1;
      return pagePayload({ count: 7, total: 7, hasMore: false });
    }
  });
  const second = await runCollectorInvocation({
    repository,
    config,
    now: () => new Date('2026-08-05T00:15:00.000Z'),
    fetchPage: async () => {
      calls += 1;
      throw new Error('must not fetch');
    }
  });
  assert.equal(first.status, 'complete');
  assert.equal(repository.state.nextOffset, 20);
  assert.equal(second.outcome, 'terminal');
  assert.equal(calls, 1);
});

test('daily request reservation stops at 100 attempts and resets only at UTC midnight', async () => {
  const config = collectorConfig();
  const state = createInitialState(config, BASE_TIME);
  state.quota.dailyAttempts = 100;
  const repository = new MemoryRepository(state);
  let calls = 0;
  const stopped = await runCollectorInvocation({
    repository,
    config,
    now: () => new Date('2026-08-05T23:59:00.000Z'),
    fetchPage: async () => { calls += 1; return pagePayload(); }
  });
  assert.equal(stopped.outcome, 'daily_quota_exhausted');
  assert.equal(stopped.nextEligibleAt, '2026-08-06T00:00:00.000Z');
  assert.equal(calls, 0);

  const resumed = await runCollectorInvocation({
    repository,
    config,
    now: () => new Date('2026-08-06T00:00:00.000Z'),
    fetchPage: async () => { calls += 1; return pagePayload(); }
  });
  assert.equal(resumed.outcome, 'page_stored');
  assert.equal(repository.state.quota.dailyAttempts, 1);
  assert.equal(calls, 1);
});

test('the 1000th successful 20-card request stops at the 20,000-record ceiling', async () => {
  const config = collectorConfig();
  const state = createInitialState(config, BASE_TIME);
  Object.assign(state, {
    nextOffset: 19_980,
    pageCount: 999,
    cardRecordCount: 19_980,
    approximateUniqueCardCount: 19_980,
    initialTotal: 25_000,
    latestTotal: 25_000
  });
  Object.assign(state.quota, {
    dailyAttempts: 99,
    dailySuccesses: 99,
    totalAttempts: 999,
    totalSuccesses: 999,
    apiRequestsRemaining: 1
  });
  const repository = new MemoryRepository(state);
  const result = await runCollectorInvocation({
    repository,
    config,
    now: () => BASE_TIME,
    fetchPage: async ({ offset }) => pagePayload({ offset, total: 25_000, hasMore: true, remaining: 0 })
  });
  assert.equal(result.status, 'quota_exhausted');
  assert.equal(repository.state.quota.totalAttempts, 1_000);
  assert.equal(repository.state.quota.totalSuccesses, 1_000);
  assert.equal(repository.state.cardRecordCount, 20_000);
  assert.equal(repository.state.approximateUniqueCardCount, 20_000);
});

test('plan mismatch fails closed after reserving one outbound call', async () => {
  const config = collectorConfig();
  const repository = new MemoryRepository();
  const result = await runCollectorInvocation({
    repository,
    config,
    now: () => BASE_TIME,
    random: () => 0,
    fetchPage: async () => pagePayload({ plan: 'Starter' })
  });
  assert.equal(result.outcome, 'blocked');
  assert.equal(result.errorCode, 'plan_mismatch');
  assert.equal(repository.state.status, 'blocked');
  assert.equal(repository.state.quota.totalAttempts, 1);
  assert.equal(repository.pages.size, 0);
});

test('429 honors Retry-After without retrying inside the scheduled invocation', async () => {
  const config = collectorConfig();
  const repository = new MemoryRepository();
  let current = BASE_TIME;
  let calls = 0;
  const fetchPage = async () => {
    calls += 1;
    throw new JustTcgRequestError('http_429', 'rate limited', {
      status: 429,
      providerCode: 'RATE_LIMIT_EXCEEDED',
      retryAfterMs: 10 * 60 * 1_000,
      retryable: true
    });
  };
  const first = await runCollectorInvocation({
    repository,
    config,
    now: () => current,
    random: () => 0,
    fetchPage
  });
  assert.equal(first.outcome, 'request_deferred');
  assert.equal(first.notBefore, '2026-08-05T00:20:00.000Z');
  current = new Date('2026-08-05T00:15:00.000Z');
  const second = await runCollectorInvocation({ repository, config, now: () => current, fetchPage });
  assert.equal(second.outcome, 'retry_backoff');
  assert.equal(calls, 1);
});

test('shared-serverless EXCESSIVE_FREE_TIER_USAGE blocks instead of burning quota', async () => {
  const config = collectorConfig();
  const repository = new MemoryRepository();
  const result = await runCollectorInvocation({
    repository,
    config,
    now: () => BASE_TIME,
    fetchPage: async () => {
      throw new JustTcgRequestError('excessive_free_tier_usage', 'blocked', {
        status: 429,
        providerCode: 'EXCESSIVE_FREE_TIER_USAGE',
        retryable: true
      });
    }
  });
  assert.equal(result.outcome, 'blocked');
  assert.equal(result.errorCode, 'excessive_free_tier_usage');
  assert.equal(repository.state.retry.notBefore, null);
});

test('a repeated data page blocks offset drift and preserves the first page', async () => {
  const config = collectorConfig();
  const repository = new MemoryRepository();
  const repeated = cards(0);
  await runCollectorInvocation({
    repository,
    config,
    now: () => BASE_TIME,
    fetchPage: async () => pagePayload({ data: repeated })
  });
  const result = await runCollectorInvocation({
    repository,
    config,
    now: () => new Date('2026-08-05T00:15:00.000Z'),
    fetchPage: async ({ offset }) => pagePayload({ offset, data: repeated, remaining: 998 })
  });
  assert.equal(result.outcome, 'blocked');
  assert.equal(result.errorCode, 'repeated_page');
  assert.equal(repository.state.pageCount, 1);
  assert.equal(repository.pages.size, 1);
});

test('persisted page is reconciled after a state-finalization interruption without another API call', async () => {
  const config = collectorConfig();
  const state = createInitialState(config, BASE_TIME);
  state.quota.dailyAttempts = 1;
  state.quota.totalAttempts = 1;
  const repository = new MemoryRepository(state);
  const response = pagePayload();
  const normalized = validatePage(response, { config, requestedOffset: 0 });
  repository.pages.set(0, {
    schemaVersion: 1,
    collectionId: config.collectionId,
    queryHash: config.queryHash,
    requestedOffset: 0,
    retrievedAt: BASE_TIME.toISOString(),
    dataHash: normalized.dataHash,
    payloadHash: normalized.payloadHash,
    response
  });
  let calls = 0;
  const result = await runCollectorInvocation({
    repository,
    config,
    now: () => new Date('2026-08-05T00:15:00.000Z'),
    fetchPage: async () => { calls += 1; return response; }
  });
  assert.equal(result.outcome, 'page_reconciled');
  assert.equal(calls, 0);
  assert.equal(repository.state.quota.totalAttempts, 1);
  assert.equal(repository.state.quota.totalSuccesses, 1);
  assert.equal(repository.state.nextOffset, 20);
});

test('Netlify Blobs repository uses strong reads and conditional writes', async () => {
  const calls = [];
  const store = {
    async getWithMetadata(...args) { calls.push(['getWithMetadata', ...args]); return null; },
    async get(...args) { calls.push(['get', ...args]); return null; },
    async setJSON(...args) { calls.push(['setJSON', ...args]); return { modified: true, etag: 'new' }; }
  };
  const repository = createJustTcgBlobRepository(store, {
    collectionId: 'catalog-v1',
    queryHash: 'a'.repeat(64)
  });
  await repository.loadState();
  await repository.saveState({ ok: true }, null);
  await repository.saveState({ ok: true }, 'old');
  await repository.loadPage(20);
  await repository.savePage({ requestedOffset: 20 });

  assert.deepEqual(calls[0][2], { consistency: 'strong', type: 'json' });
  assert.deepEqual(calls[1][3], { onlyIfNew: true });
  assert.deepEqual(calls[2][3], { onlyIfMatch: 'old' });
  assert.match(calls[3][1], /pages\/00000020\.json$/);
  assert.deepEqual(calls[3][2], { consistency: 'strong', type: 'json' });
  assert.deepEqual(calls[4][3], { onlyIfNew: true });
});
