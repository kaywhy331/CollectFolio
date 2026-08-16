import assert from 'node:assert/strict';
import test from 'node:test';

import {
  fetchTcgcsvRefreshStatus,
  normalizeTcgcsvRefreshStatus
} from '../app/assets/js/services/tcgcsv-refresh-status.js';

const CURRENT = {
  contractVersion: 'tcgcsv-r2-refresh-v1',
  status: 'current',
  sourceUpdatedAt: '2026-08-15T20:05:57.000Z',
  lastSuccessfulSourceBuild: '2026-08-15T20:05:57.000Z',
  lastSuccessfulAt: '2026-08-16T03:30:00.000Z'
};

test('refresh status keeps only the public state and successful timestamps', () => {
  assert.deepEqual(normalizeTcgcsvRefreshStatus({
    ...CURRENT,
    key: 'must-not-cross-the-browser-boundary',
    artifacts: { private: true }
  }), {
    status: 'current',
    sourceUpdatedAt: CURRENT.sourceUpdatedAt,
    lastSuccessfulSourceBuild: CURRENT.lastSuccessfulSourceBuild,
    lastSuccessfulAt: CURRENT.lastSuccessfulAt,
    error: ''
  });
});

test('refresh status fails closed on inconsistent current or oversized responses', async () => {
  assert.throws(() => normalizeTcgcsvRefreshStatus({
    ...CURRENT,
    lastSuccessfulSourceBuild: '2026-08-14T20:05:57.000Z'
  }), /does not match/);

  await assert.rejects(fetchTcgcsvRefreshStatus(
    'https://refresh.example/status',
    async () => new Response('{}', { headers: { 'content-length': String(20 * 1024) } })
  ), /too large/);
});

test('refresh status fetches a bounded no-store JSON contract', async () => {
  let requestUrl = '';
  let requestOptions;
  const result = await fetchTcgcsvRefreshStatus('https://refresh.example/status', async (url, options) => {
    requestUrl = String(url);
    requestOptions = options;
    const body = JSON.stringify(CURRENT);
    return new Response(body, {
      headers: { 'content-type': 'application/json', 'content-length': String(body.length) }
    });
  });
  assert.equal(requestUrl, 'https://refresh.example/status');
  assert.equal(requestOptions.cache, 'no-store');
  assert.equal(requestOptions.headers.accept, 'application/json');
  assert.equal(result.status, 'current');
});
