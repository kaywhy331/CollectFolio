import assert from 'node:assert/strict';
import test from 'node:test';

import { createCollectorConfig } from '../netlify/lib/justtcg-collector.mjs';
import { JustTcgRequestError } from '../netlify/lib/justtcg-http.mjs';
import {
  buildLookupBody,
  fetchJustTcgLookup,
  JUSTTCG_LOOKUP_BATCH_LIMIT,
  LookupConfigError,
  validateLookup
} from '../netlify/lib/justtcg-lookup.mjs';

const API_KEY = 'server-only-test-key';

function config(overrides = {}) {
  return createCollectorConfig({ JUSTTCG_API_KEY: API_KEY, ...overrides });
}

function lookupResponse({ count = 1, plan = 'Free', remaining = 40, cards } = {}) {
  const data = cards || Array.from({ length: count }, (_, index) => ({
    id: `card-${index}`,
    name: `Card ${index}`,
    variants: [{ id: `variant-${index}`, price: 10 + index }]
  }));
  return {
    data,
    meta: { total: data.length, limit: JUSTTCG_LOOKUP_BATCH_LIMIT, offset: 0, hasMore: false },
    _metadata: { apiPlan: plan, apiRequestsRemaining: remaining }
  };
}

test('buildLookupBody produces a bare array with one identifier per item', () => {
  const body = buildLookupBody([
    { field: 'scryfallId', value: 'abc-123' },
    { field: 'cardId', value: 'card-9', condition: 'NM', printing: 'Normal' }
  ]);
  assert.deepEqual(body, [
    { scryfallId: 'abc-123' },
    { cardId: 'card-9', condition: 'NM', printing: 'Normal' }
  ]);
});

test('buildLookupBody rejects empty input, oversized batches, and unknown identifier fields', () => {
  assert.throws(() => buildLookupBody([]), LookupConfigError);
  assert.throws(
    () => buildLookupBody(Array.from({ length: JUSTTCG_LOOKUP_BATCH_LIMIT + 1 }, () => ({ field: 'cardId', value: 'x' }))),
    /must not exceed 20/
  );
  assert.throws(() => buildLookupBody([{ field: 'notAField', value: 'x' }]), /must be one of/);
  assert.throws(() => buildLookupBody([{ field: 'cardId', value: '' }]), /non-empty identifier/);
});

test('lookup HTTP client POSTs with header-only authentication and never puts the key in the body or URL', async () => {
  let request;
  const expected = lookupResponse({ count: 2 });
  const result = await fetchJustTcgLookup({
    config: config(),
    items: [{ field: 'cardId', value: 'card-1' }, { field: 'scryfallId', value: 'sf-2' }],
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify(expected), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });
  assert.deepEqual(result, expected);
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers['X-API-Key'], API_KEY);
  assert.equal(request.options.redirect, 'error');
  assert.equal(request.url, 'https://api.justtcg.com/v1/cards');
  assert.equal(JSON.parse(request.options.body).length, 2);
  assert.equal(request.options.body.includes(API_KEY), false);
});

test('lookup response validation accepts a valid envelope and reports apiRequestsRemaining', () => {
  const payload = lookupResponse({ count: 2, remaining: 7 });
  const result = validateLookup(payload, { requestedCount: 2, config: config() });
  assert.equal(result.apiRequestsRemaining, 7);
  assert.equal(result.cardIds.length, 2);
});

test('lookup validation does not enforce GET-style pagination consistency', () => {
  // The provider's own POST /cards docs reuse the GET example's meta verbatim
  // (total/offset/hasMore), so a lookup response with "odd" pagination fields
  // for a fixed-identifier batch must still validate.
  const payload = lookupResponse({ count: 1 });
  payload.meta = { total: 999, limit: 1, offset: 40, hasMore: true };
  assert.doesNotThrow(() => validateLookup(payload, { requestedCount: 1, config: config() }));
});

test('lookup validation rejects more cards than requested and duplicate IDs', () => {
  const oversized = lookupResponse({ count: 3 });
  assert.throws(() => validateLookup(oversized, { requestedCount: 2, config: config() }), /more cards than requested/);

  const duplicated = lookupResponse({ cards: [{ id: 'same' }, { id: 'same' }] });
  assert.throws(() => validateLookup(duplicated, { requestedCount: 2, config: config() }), /duplicate/);
});

test('lookup validation rejects a plan mismatch', () => {
  const payload = lookupResponse({ plan: 'Starter' });
  assert.throws(() => validateLookup(payload, { requestedCount: 1, config: config() }), /plan_mismatch|expected Free/);
});

test('lookup HTTP client maps EXCESSIVE_FREE_TIER_USAGE and Retry-After like the crawl adapter', async () => {
  const error = await fetchJustTcgLookup({
    config: config(),
    items: [{ field: 'cardId', value: 'card-1' }],
    fetchImpl: async () => new Response(JSON.stringify({ code: 'EXCESSIVE_FREE_TIER_USAGE' }), {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': '120' }
    })
  }).catch((caught) => caught);
  assert.ok(error instanceof JustTcgRequestError);
  assert.equal(error.code, 'excessive_free_tier_usage');
  assert.equal(error.retryAfterMs, 120_000);
});
