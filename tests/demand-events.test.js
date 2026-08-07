import test from 'node:test';
import assert from 'node:assert/strict';
import { demandEventEligible, demandEventId, demandEventRow, DEMAND_EVENT_TYPES, hourBucket } from '../app/assets/js/services/demand-events.js';

const canonicalVariantId = '123e4567-e89b-42d3-a456-426614174000';

test('hour bucket truncates to the hour, ignoring minutes/seconds', () => {
  assert.equal(hourBucket('2026-08-06T18:49:03.000Z'), '2026-08-06T18');
  assert.equal(hourBucket('2026-08-06T18:00:00.000Z'), hourBucket('2026-08-06T18:59:59.999Z'));
  assert.notEqual(hourBucket('2026-08-06T18:59:59.999Z'), hourBucket('2026-08-06T19:00:00.000Z'));
});

test('demand event id is deterministic for the same user/variant/type/bucket', () => {
  const id = demandEventId('user-1', canonicalVariantId, 'watch_add', '2026-08-06T18');
  assert.equal(id, demandEventId('user-1', canonicalVariantId, 'watch_add', '2026-08-06T18'));
  assert.notEqual(id, demandEventId('user-1', canonicalVariantId, 'watch_remove', '2026-08-06T18'));
});

test('every supported PRD event type is eligible for a signed-in, opted-in, mapped variant', () => {
  for (const eventType of DEMAND_EVENT_TYPES) {
    assert.equal(
      demandEventEligible({ eventType, canonicalVariantId, optedOut: false, signedIn: true }),
      true
    );
  }
});

test('unknown event types are rejected rather than silently recorded', () => {
  assert.throws(
    () => demandEventEligible({ eventType: 'bogus_type', canonicalVariantId, optedOut: false, signedIn: true }),
    /Unknown demand event type/
  );
});

test('opted-out users are never eligible, even for a mapped variant while signed in', () => {
  assert.equal(
    demandEventEligible({ eventType: 'watch_add', canonicalVariantId, optedOut: true, signedIn: true }),
    false
  );
});

test('unmapped items (no canonical variant UUID) are never eligible', () => {
  assert.equal(
    demandEventEligible({ eventType: 'watch_add', canonicalVariantId: '', optedOut: false, signedIn: true }),
    false
  );
  assert.equal(
    demandEventEligible({ eventType: 'watch_add', canonicalVariantId: 'not-a-uuid', optedOut: false, signedIn: true }),
    false
  );
});

test('signed-out usage is never eligible, matching the local-only architecture boundary', () => {
  assert.equal(
    demandEventEligible({ eventType: 'watch_add', canonicalVariantId, optedOut: false, signedIn: false }),
    false
  );
});

test('demand event row shapes the exact PostgREST payload the migration expects', () => {
  const row = demandEventRow({
    userId: 'user-1',
    catalogVariantId: canonicalVariantId,
    eventType: 'card_view',
    eventKey: '2026-08-06T18',
    occurredAt: '2026-08-06T18:49:03.000Z'
  });
  assert.deepEqual(row, {
    user_id: 'user-1',
    catalog_variant_id: canonicalVariantId,
    event_type: 'card_view',
    event_key: '2026-08-06T18',
    occurred_at: '2026-08-06T18:49:03.000Z'
  });
});
