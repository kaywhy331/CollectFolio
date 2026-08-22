import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchTrajectoryGroup,
  fetchTrajectoryManifest,
  getTrajectoryForecast,
  getTrajectoryForecastForItem,
  isTrajectoryStale,
  manifestGroupEntry,
  normalizeTrajectoryBand,
  normalizeTrajectoryPacket,
  trajectoryForecastEstimates,
  trajectoryKeyForItem
} from '../app/assets/js/services/forecast-trajectory.js';
import { fetchHistoryGroup } from '../app/assets/js/services/history-trajectory.js';

// A minimal in-memory IndexedDB shim covering only what core/db.js's
// getRecord/putRecord need against the single 'catalogCache' store this
// service reuses. Node has no IndexedDB; without this shim getRecord/
// putRecord reject and forecast-trajectory.js's cached() helper falls
// back to "always miss, always reload" (its documented fail-open
// behavior), which would make the TTL-reuse tests below vacuous. This
// stays test-local and does not add a runtime dependency.
function installFakeIndexedDB() {
  const stores = { catalogCache: new Map() };
  function requestFor(action) {
    const target = new EventTarget();
    target.result = undefined;
    target.error = undefined;
    queueMicrotask(() => {
      try {
        target.result = action();
        target.dispatchEvent(new Event('success'));
      } catch (error) {
        target.error = error;
        target.dispatchEvent(new Event('error'));
      }
    });
    return target;
  }
  const db = {
    objectStoreNames: { contains: () => true },
    transaction(_names, _mode) {
      const txTarget = new EventTarget();
      queueMicrotask(() => txTarget.dispatchEvent(new Event('complete')));
      return {
        objectStore: (name) => ({
          get: (key) => requestFor(() => stores[name].get(key)),
          put: (value) => requestFor(() => { stores[name].set(value.key, value); return value; })
        }),
        addEventListener: txTarget.addEventListener.bind(txTarget)
      };
    }
  };
  const original = globalThis.indexedDB;
  globalThis.indexedDB = { open: () => requestFor(() => db) };
  return () => { globalThis.indexedDB = original; };
}

// requestTCGCSVCatalog (the fetch primitive this service reuses) resolves
// its base URL from window.COLLECTFOLIO_CONFIG.TCGCSV_CATALOG_URL; without
// it every call throws "not configured" before fetchImpl is ever reached.
globalThis.window = { COLLECTFOLIO_CONFIG: { TCGCSV_CATALOG_URL: 'https://catalog.example/' } };

function fakeResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body)
  };
}

function manifestWith(categoryId, groupId, entry) {
  return { asOf: '2026-08-10', categories: { [categoryId]: { groups: { [groupId]: entry } } } };
}

test('manifestGroupEntry is fail-closed: only an explicit published status with parts counts as eligible', () => {
  const published = manifestWith(3, 100, { status: 'published', parts: [{ part: 1, partsTotal: 1, objectKey: 'forecasts/3/100.json.gz' }] });
  assert.equal(manifestGroupEntry(published, 3, 100).eligibility, 'published');

  const excluded = manifestWith(3, 101, { status: 'excluded', reason: 'insufficient variants' });
  assert.equal(manifestGroupEntry(excluded, 3, 101).eligibility, 'excluded');

  const emptyParts = manifestWith(3, 102, { status: 'published', parts: [] });
  assert.equal(manifestGroupEntry(emptyParts, 3, 102).eligibility, 'unknown');

  const incompleteParts = manifestWith(3, 104, { status: 'published', parts: [{ part: 1, partsTotal: 2, objectKey: 'forecasts/3/104.part1.json.gz' }] });
  assert.equal(manifestGroupEntry(incompleteParts, 3, 104).eligibility, 'unknown');

  const crossedObjectKey = manifestWith(3, 105, { status: 'published', parts: [{ part: 1, partsTotal: 1, objectKey: 'forecasts/3/999.json.gz' }] });
  assert.equal(manifestGroupEntry(crossedObjectKey, 3, 105).eligibility, 'unknown');

  const unrecognizedStatus = manifestWith(3, 103, { status: 'pending' });
  assert.equal(manifestGroupEntry(unrecognizedStatus, 3, 103).eligibility, 'unknown');

  assert.equal(manifestGroupEntry(published, 3, 999).eligibility, 'unknown');
  assert.equal(manifestGroupEntry(published, 999, 100).eligibility, 'unknown');
  assert.equal(manifestGroupEntry(null, 3, 100).eligibility, 'unknown');
});

test('fetchTrajectoryGroup merges multi-part payloads in part order and validates the part/partsTotal sequence', async () => {
  const restore = installFakeIndexedDB();
  try {
    const manifestEntry = {
      status: 'published',
      parts: [
        { part: 2, partsTotal: 2, objectKey: 'forecasts/3/200.part2.json.gz' },
        { part: 1, partsTotal: 2, objectKey: 'forecasts/3/200.part1.json.gz' }
      ]
    };
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(String(url));
      if (String(url).includes('part1')) {
        return fakeResponse({ categoryId: 3, groupId: 200, asOf: '2026-08-10', modelVersion: 'trajectory-v1', part: 1, partsTotal: 2, variants: [{ productId: 1, subTypeName: 'Holofoil' }] });
      }
      return fakeResponse({ categoryId: 3, groupId: 200, asOf: '2026-08-10', modelVersion: 'trajectory-v1', part: 2, partsTotal: 2, variants: [{ productId: 2, subTypeName: 'Normal' }] });
    };
    const group = await fetchTrajectoryGroup(3, 200, manifestEntry, { session: {}, fetchImpl, bypassCache: true });
    assert.deepEqual(group.variants.map((v) => v.productId), [1, 2]);
    assert.equal(calls.some((url) => url.includes('/catalog/forecasts/3/200.part1')), true);
    assert.equal(calls.some((url) => url.includes('/catalog/forecasts/3/200.part2')), true);
  } finally {
    restore();
  }
});

test('fetchTrajectoryGroup rejects an incomplete manifest part set before fetching it', async () => {
  const restore = installFakeIndexedDB();
  try {
    const manifestEntry = { status: 'published', parts: [{ part: 1, partsTotal: 2, objectKey: 'forecasts/3/201.part1.json.gz' }] };
    let calls = 0;
    const fetchImpl = async () => { calls += 1; return fakeResponse({}); };
    await assert.rejects(
      fetchTrajectoryGroup(3, 201, manifestEntry, { session: {}, fetchImpl, bypassCache: true }),
      /invalid part set/
    );
    assert.equal(calls, 0);
  } finally {
    restore();
  }
});

test('fetchTrajectoryGroup rejects a payload count that disagrees with its manifest', async () => {
  const restore = installFakeIndexedDB();
  try {
    const manifestEntry = {
      status: 'published', eligibleVariantCount: 2,
      parts: [{ part: 1, partsTotal: 1, variantCount: 1, objectKey: 'forecasts/3/202.json.gz' }]
    };
    const fetchImpl = async () => fakeResponse({
      categoryId: 3, groupId: 202, asOf: '2026-08-10', modelVersion: 'trajectory-v1',
      part: 1, partsTotal: 1, variants: [{ productId: 1 }]
    });
    await assert.rejects(
      fetchTrajectoryGroup(3, 202, manifestEntry, { session: {}, fetchImpl, bypassCache: true }),
      /manifest variant count/
    );
  } finally {
    restore();
  }
});

test('fetchTrajectoryManifest and fetchTrajectoryGroup reuse the cached value within TTL and skip a second network call', async () => {
  const restore = installFakeIndexedDB();
  try {
    let manifestCalls = 0;
    const manifestFetch = async () => {
      manifestCalls += 1;
      return fakeResponse(manifestWith(3, 300, { status: 'published', parts: [{ part: 1, partsTotal: 1, objectKey: 'forecasts/3/300.json.gz' }] }));
    };
    const first = await fetchTrajectoryManifest({ session: {}, fetchImpl: manifestFetch });
    const second = await fetchTrajectoryManifest({ session: {}, fetchImpl: manifestFetch });
    assert.equal(manifestCalls, 1);
    assert.deepEqual(first, second);

    let groupCalls = 0;
    const groupFetch = async () => {
      groupCalls += 1;
      return fakeResponse({ categoryId: 3, groupId: 300, asOf: '2026-08-10', modelVersion: 'trajectory-v1', part: 1, partsTotal: 1, variants: [{ productId: 9 }] });
    };
    const entry = { status: 'published', parts: [{ part: 1, partsTotal: 1, objectKey: 'forecasts/3/300.json.gz' }] };
    await fetchTrajectoryGroup(3, 300, entry, { session: {}, fetchImpl: groupFetch });
    await fetchTrajectoryGroup(3, 300, entry, { session: {}, fetchImpl: groupFetch });
    assert.equal(groupCalls, 1);
  } finally {
    restore();
  }
});

test('trajectory group cache is bound to the manifest content generation', async () => {
  const restore = installFakeIndexedDB();
  try {
    let calls = 0;
    const fetchImpl = async () => fakeResponse({
      categoryId: 3, groupId: 301, asOf: '2026-08-10', modelVersion: 'trajectory-v1',
      part: 1, partsTotal: 1, variants: [{ productId: ++calls }]
    });
    const part = { part: 1, partsTotal: 1, variantCount: 1, objectKey: 'forecasts/3/301.json.gz' };
    const first = await fetchTrajectoryGroup(3, 301, {
      status: 'published', eligibleVariantCount: 1,
      parts: [{ ...part, contentHash: 'a'.repeat(64) }]
    }, { session: {}, fetchImpl });
    const second = await fetchTrajectoryGroup(3, 301, {
      status: 'published', eligibleVariantCount: 1,
      parts: [{ ...part, contentHash: 'b'.repeat(64) }]
    }, { session: {}, fetchImpl });
    assert.equal(calls, 2);
    assert.notDeepEqual(first.variants, second.variants);
  } finally {
    restore();
  }
});

test('concurrent card hydration shares one in-flight group request', async () => {
  const restore = installFakeIndexedDB();
  try {
    let calls = 0;
    const entry = { status: 'published', parts: [{ part: 1, partsTotal: 1, objectKey: 'forecasts/3/302.json.gz' }] };
    const fetchImpl = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return fakeResponse({ categoryId: 3, groupId: 302, asOf: '2026-08-10', modelVersion: 'trajectory-v1', part: 1, partsTotal: 1, variants: [] });
    };
    const groups = await Promise.all(Array.from({ length: 24 }, () =>
      fetchTrajectoryGroup(3, 302, entry, { session: {}, fetchImpl })));
    assert.equal(calls, 1);
    assert.equal(groups.length, 24);
    assert.ok(groups.every((group) => group === groups[0]));
  } finally {
    restore();
  }
});

test('concurrent card-history hydration shares one in-flight group request', async () => {
  const restore = installFakeIndexedDB();
  try {
    let calls = 0;
    const entry = { status: 'published', parts: [{ part: 1, partsTotal: 1, objectKey: 'history/3/303.json.gz' }] };
    const fetchImpl = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return fakeResponse({ part: 1, partsTotal: 1, variants: [] });
    };
    const groups = await Promise.all(Array.from({ length: 24 }, () =>
      fetchHistoryGroup(3, 303, entry, { session: {}, fetchImpl })));
    assert.equal(calls, 1);
    assert.equal(groups.length, 24);
    assert.ok(groups.every((group) => group === groups[0]));
  } finally {
    restore();
  }
});

test('fetchTrajectoryManifest with bypassCache always reloads and refreshes the stored cache value', async () => {
  const restore = installFakeIndexedDB();
  try {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return fakeResponse({ asOf: `call-${calls}`, categories: {} });
    };
    const first = await fetchTrajectoryManifest({ session: {}, fetchImpl, bypassCache: true });
    const second = await fetchTrajectoryManifest({ session: {}, fetchImpl, bypassCache: true });
    assert.equal(calls, 2);
    assert.notEqual(first.asOf, second.asOf);
  } finally {
    restore();
  }
});

test('getTrajectoryForecast resolves the matching variant end to end and stays fail-closed for excluded/unknown groups', async () => {
  const restore = installFakeIndexedDB();
  try {
    const manifest = manifestWith(3, 400, { status: 'published', parts: [{ part: 1, partsTotal: 1, objectKey: 'forecasts/3/400.json.gz' }] });
    const fetchImpl = async (url) => {
      if (String(url).includes('/manifest')) return fakeResponse(manifest);
      return fakeResponse({
        categoryId: 3, groupId: 400, asOf: '2026-08-10', modelVersion: 'trajectory-v1', part: 1, partsTotal: 1,
        variants: [{ productId: 55, subTypeName: 'Holofoil', confidence: 'standard', lastKnownPrice: 10, lastKnownDate: '2026-08-01', medianPath: [], horizons: { 30: { q10: 8, q25: 9, q50: 10, q75: 11, q90: 12 } } }]
      });
    };
    const found = await getTrajectoryForecast(3, 400, 55, 'Holofoil', { session: {}, fetchImpl, bypassCache: true });
    assert.equal(found.eligibility, 'published');
    assert.equal(found.packet.productId, 55);
    assert.equal(found.packet.modelVersion, 'trajectory-v1');

    const missingVariant = await getTrajectoryForecast(3, 400, 999, 'Holofoil', { session: {}, fetchImpl, bypassCache: true });
    assert.equal(missingVariant.eligibility, 'unknown');
    assert.equal(missingVariant.packet, null);

    const excludedFetch = async () => fakeResponse(manifestWith(3, 401, { status: 'excluded', reason: 'thin cohort' }));
    const excluded = await getTrajectoryForecast(3, 401, 1, 'Holofoil', { session: {}, fetchImpl: excludedFetch, bypassCache: true });
    assert.equal(excluded.eligibility, 'excluded');
    assert.equal(excluded.packet, null);

    const invalidIdentity = await getTrajectoryForecast(0, 0, 0, '', { session: {}, fetchImpl, bypassCache: true });
    assert.equal(invalidIdentity.eligibility, 'unknown');
  } finally {
    restore();
  }
});

test('trajectoryKeyForItem only resolves an identity for tcgcsv catalog items with a complete numeric identity', () => {
  assert.equal(trajectoryKeyForItem({ provider: 'tcgcsv', categoryId: 3, groupId: 100, productId: 55, variant: 'Holofoil' }), '3:100:55:Holofoil');
  assert.equal(trajectoryKeyForItem({ provider: 'tcgcsv', categoryId: 3, groupId: 100, productId: 0 }), '');
  assert.equal(trajectoryKeyForItem({ provider: 'custom', categoryId: 3, groupId: 100, productId: 55 }), '');
  assert.equal(trajectoryKeyForItem({}), '');
});

test('getTrajectoryForecastForItem is a no-op for non-tcgcsv items and never issues a network call', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return fakeResponse({}); };
  const result = await getTrajectoryForecastForItem({ provider: 'custom' }, { session: {}, fetchImpl });
  assert.equal(result.eligibility, 'unknown');
  assert.equal(result.packet, null);
  assert.equal(calls, 0);
});

test('trajectoryForecastEstimates returns independent 30/60/90 checkpoints and never invents 180d/365d', () => {
  const packet = {
    lastKnownPrice: 100,
    confidence: 'standard',
    modelVersion: 'trajectory-v1',
    horizons: {
      30: { q10: 90, q25: 95, q50: 110, q75: 120, q90: 130, horizonDaysActual: 28, evidenceTier: 'category-validated' },
      60: { q10: 85, q25: 95, q50: 120, q75: 135, q90: 150, horizonDaysActual: 63, evidenceTier: 'category-validated' },
      90: { q10: 80, q25: 95, q50: 130, q75: 150, q90: 170, horizonDaysActual: 91, evidenceTier: 'category-validated' }
    }
  };
  const estimates = trajectoryForecastEstimates(packet);
  assert.deepEqual(Object.keys(estimates).sort(), ['30', '60', '90']);
  assert.equal(estimates[30].estimatedValue, 110);
  assert.ok(Math.abs(estimates[30].estimatedChange - 0.1) < 1e-9);
  assert.equal(estimates[60].horizonDaysActual, 63);
  assert.equal(estimates[90].lowerBound, 80);
  assert.equal(estimates[90].upperBound, 170);
  assert.equal(trajectoryForecastEstimates(null).constructor, Object);
  assert.deepEqual(trajectoryForecastEstimates({}), {});
});

test('trajectoryForecastEstimates skips a horizon whose band is missing q50, rather than fabricating a value', () => {
  const packet = { lastKnownPrice: 50, horizons: { 30: { q10: 40, q25: 45, q75: 55, q90: 60 }, 90: { q10: 40, q25: 45, q50: 60, q75: 70, q90: 80 } } };
  const estimates = trajectoryForecastEstimates(packet);
  assert.deepEqual(Object.keys(estimates), ['90']);
});

test('trajectory packet validation rejects crossing bands, unknown horizons, invalid paths, and wrong identities', () => {
  const packet = {
    productId: 55,
    subTypeName: 'Holofoil',
    confidence: 'standard',
    lastKnownPrice: 50,
    lastKnownDate: '2026-08-01',
    medianPath: [{ date: '2026-08-01', price: 50 }, { date: '2026-08-08', price: 51 }],
    horizons: { 30: { q10: 40, q25: 45, q50: 55, q75: 60, q90: 70 } }
  };
  const normalized = normalizeTrajectoryPacket(packet, {
    expectedProductId: 55,
    expectedSubTypeName: 'Holofoil',
    modelVersion: 'trajectory-v1'
  });
  assert.equal(normalized.horizons[30].q50, 55);
  assert.equal(normalizeTrajectoryBand({ q10: 40, q25: 60, q50: 55, q75: 70, q90: 80 }), null);
  assert.equal(normalizeTrajectoryPacket({ ...packet, horizons: { 180: packet.horizons[30] } }, { modelVersion: 'trajectory-v1' }), null);
  assert.equal(normalizeTrajectoryPacket({ ...packet, horizons: { '030': packet.horizons[30] } }, { modelVersion: 'trajectory-v1' }), null);
  assert.equal(normalizeTrajectoryPacket({ ...packet, horizons: { 30: { ...packet.horizons[30], q10: '40' } } }, { modelVersion: 'trajectory-v1' }), null);
  assert.equal(normalizeTrajectoryPacket({ ...packet, medianPath: [...packet.medianPath].reverse() }, { modelVersion: 'trajectory-v1' }), null);
  assert.equal(normalizeTrajectoryPacket({ ...packet, lastKnownDate: '2026-02-31' }, { modelVersion: 'trajectory-v1' }), null);
  assert.equal(normalizeTrajectoryPacket(packet, { expectedProductId: 99, modelVersion: 'trajectory-v1' }), null);
  assert.equal(normalizeTrajectoryPacket({ ...packet, modelVersion: 'other-model' }, { modelVersion: 'trajectory-v1' }), null);
  assert.equal(normalizeTrajectoryPacket({ ...packet, categoryId: 3, groupId: 400, asOf: '2026-08-10' }, {
    expectedCategoryId: 3, expectedGroupId: 401, expectedAsOf: '2026-08-10', modelVersion: 'trajectory-v1'
  }), null);
  assert.deepEqual(trajectoryForecastEstimates({ ...packet, horizons: { 30: { q10: 40, q25: 60, q50: 55, q75: 70, q90: 80 } } }), {});

  const coldStart = normalizeTrajectoryPacket({
    ...packet, confidence: 'cold-start', lastKnownPrice: null, lastKnownDate: null
  }, { modelVersion: 'trajectory-v1' });
  assert.equal(coldStart.confidence, 'cold-start');
  assert.equal(coldStart.lastKnownPrice, null);
  assert.equal(trajectoryForecastEstimates(coldStart)[30].estimatedChange, null);
});

test('isTrajectoryStale flags anything more than 8 weeks behind asOf, and never flags a cold-start packet with no dated history', () => {
  assert.equal(isTrajectoryStale({ lastKnownDate: '2026-06-01' }, '2026-08-10'), true);
  assert.equal(isTrajectoryStale({ lastKnownDate: '2026-08-01' }, '2026-08-10'), false);
  assert.equal(isTrajectoryStale({ lastKnownDate: '', confidence: 'cold-start' }, '2026-08-10'), false);
  assert.equal(isTrajectoryStale({ lastKnownDate: '', confidence: 'standard' }, '2026-08-10'), true);
});
