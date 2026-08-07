import test from 'node:test';
import assert from 'node:assert/strict';
import { demandEventEligible, demandEventId, demandEventRow, DEMAND_EVENT_TYPES, DEMAND_QUEUE_MAX_AGE_DAYS, hourBucket, mergeDemandOptOut, staleDemandQueueEntries } from '../app/assets/js/services/demand-events.js';
import { BACKUP_EXCLUDED_STORES, STORES } from '../app/assets/js/core/db.js';

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

test('queue retention prunes entries past the age limit and keeps fresh ones', () => {
  const nowMs = Date.parse('2026-08-07T00:00:00.000Z');
  const fresh = { id: 'fresh', occurredAt: '2026-08-01T00:00:00.000Z' };
  const boundary = { id: 'boundary', occurredAt: new Date(nowMs - (DEMAND_QUEUE_MAX_AGE_DAYS * 86_400_000) + 1000).toISOString() };
  const stale = { id: 'stale', occurredAt: '2026-01-01T00:00:00.000Z' };
  const pruned = staleDemandQueueEntries([fresh, boundary, stale], nowMs);
  assert.deepEqual(pruned.map((entry) => entry.id), ['stale']);
});

test('queue retention treats unparseable timestamps as stale rather than immortal', () => {
  const nowMs = Date.parse('2026-08-07T00:00:00.000Z');
  const malformed = { id: 'bad', occurredAt: 'not-a-date' };
  const missing = { id: 'none' };
  assert.deepEqual(staleDemandQueueEntries([malformed, missing], nowMs).map((entry) => entry.id), ['bad', 'none']);
});

test('opt-out merge adopts a remote opt-out locally', () => {
  assert.deepEqual(mergeDemandOptOut(false, true), { adoptLocalOptOut: true, pushOptOut: false });
});

test('opt-out merge re-pushes a local opt-out the server lost, never re-enabling locally', () => {
  assert.deepEqual(mergeDemandOptOut(true, false), { adoptLocalOptOut: false, pushOptOut: true });
});

test('opt-out merge is a no-op when states agree or the server is unknowable', () => {
  assert.deepEqual(mergeDemandOptOut(true, true), { adoptLocalOptOut: false, pushOptOut: false });
  assert.deepEqual(mergeDemandOptOut(false, false), { adoptLocalOptOut: false, pushOptOut: false });
  assert.deepEqual(mergeDemandOptOut(false, null), { adoptLocalOptOut: false, pushOptOut: false });
  assert.deepEqual(mergeDemandOptOut(true, null), { adoptLocalOptOut: false, pushOptOut: false });
});

test('the demand outbox exists as a store but is excluded from portable backups', () => {
  assert.ok(STORES.includes('demandEventsQueue'));
  assert.ok(BACKUP_EXCLUDED_STORES.includes('demandEventsQueue'));
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
