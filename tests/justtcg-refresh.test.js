import test from 'node:test';
import assert from 'node:assert/strict';
import { refreshOutcomeMessage, requestPriceRefresh } from '../app/assets/js/services/justtcg-refresh.js';

function sessionToken(userId = '123e4567-e89b-42d3-a456-426614174000') {
  const payload = Buffer.from(JSON.stringify({ sub: userId })).toString('base64url');
  return `header.${payload}.signature`;
}

async function withSession(callback) {
  const previousWindow = globalThis.window;
  const previousStorage = globalThis.localStorage;
  globalThis.window = { COLLECTFOLIO_CONFIG: { SUPABASE_URL: 'https://cloud.example.test', SUPABASE_ANON_KEY: 'public-key' } };
  const value = JSON.stringify({
    access_token: sessionToken(),
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id: '123e4567-e89b-42d3-a456-426614174000' }
  });
  globalThis.localStorage = { getItem: () => value, setItem() {}, removeItem() {} };
  try { return await callback(); } finally {
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
    if (previousStorage === undefined) delete globalThis.localStorage; else globalThis.localStorage = previousStorage;
  }
}

test('price-prioritization responses remain status-only and forward the signed-in bearer token', async () => withSession(async () => {
  let request;
  const result = await requestPriceRefresh({ fetcher: async (url, options) => {
    request = { url, options };
    return { ok: true, status: 200, json: async () => ({ outcome: 'ok', fetched: 2, alreadyFresh: 1 }) };
  } });
  assert.equal(request.url, '/.netlify/functions/justtcg-refresh');
  assert.match(request.options.headers.Authorization, /^Bearer header\./);
  assert.ok(request.options.signal instanceof AbortSignal);
  assert.equal(result.message, '2 cards queued for the next research pass; 1 already recent');
  assert.equal(Object.hasOwn(result, 'price'), false);
}));

test('price-prioritization requests abort at a bounded deadline', async () => withSession(async () => {
  await assert.rejects(requestPriceRefresh({
    timeout: 5,
    fetcher: async (_url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    })
  }), (error) => error.name === 'TimeoutError' && /timed out/i.test(error.message));
}));

test('the price-prioritization deadline remains active while the response body is read', async () => withSession(async () => {
  await assert.rejects(requestPriceRefresh({
    timeout: 5,
    fetcher: async (_url, options) => ({
      ok: true,
      status: 200,
      json: async () => new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
      })
    })
  }), (error) => error.name === 'TimeoutError' && /timed out/i.test(error.message));
}));

test('price-prioritization outcome copy remains useful for deferred and unauthorized states', () => {
  assert.match(refreshOutcomeMessage('quota_deferred'), /try again later/i);
  assert.match(refreshOutcomeMessage('unauthorized'), /sign in/i);
});
