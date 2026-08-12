import test from 'node:test';
import assert from 'node:assert/strict';
import { indexPublications, intelligenceVariantIds, mergePublicationHistory, publicationCacheRecord, publicationHistoryRecord } from '../app/assets/js/services/price-intelligence.js';

const first = '123e4567-e89b-42d3-a456-426614174000';
const second = '223e4567-e89b-42d3-a456-426614174000';

test('intelligence hydration targets only unique approved canonical UUIDs', () => {
  assert.deepEqual(intelligenceVariantIds(
    [{ canonicalVariantId: first }, { canonicalVariantId: '' }],
    [{ canonicalVariantId: first }, { canonicalVariantId: second }]
  ), [first, second]);
});

test('publication cache never outlives source publication expiry', () => {
  const now = Date.parse('2026-08-05T00:00:00.000Z');
  const record = publicationCacheRecord({ variantId: first, expiresAt: '2026-08-05T01:00:00.000Z' }, now);
  assert.equal(record.expiresAt, Date.parse('2026-08-05T01:00:00.000Z'));
});

test('publication index ignores malformed variant identities', () => {
  assert.deepEqual(indexPublications([{ variantId: 'bad' }, { variantId: first, supportTier: 2 }]), {
    [first]: { variantId: first, supportTier: 2 }
  });
});

test('publication history uses immutable content-addressed keys and deduplicates refreshes', () => {
  const value = { variantId: first, supportTier: 4, publishedAt: '2026-08-05T00:00:00.000Z', payloadHash: 'hash-1', payload: { forecasts: {} } };
  const record = publicationHistoryRecord(value, '2026-08-05T01:00:00.000Z');
  assert.match(record.key, /^intelligence-history:v1:/);
  assert.equal(record.immutable, true);
  const merged = mergePublicationHistory([record], [value], '2026-08-05T02:00:00.000Z');
  assert.equal(merged.length, 1);
  assert.equal(merged[0].archivedAt, '2026-08-05T01:00:00.000Z');
});
