import { isUUID } from '../core/catalog-identity.js';
import { deleteRecord, getAll, putRecord } from '../core/db.js';
import { getState } from '../core/store.js';
import { isSupabaseConfigured, request, validSession } from './supabase.js';

// PRD Sec 15.7 first-party demand list. scan_confirm and alert_create stay
// in the private raw ledger only; the public aggregate (Sec 19.6) has no
// column for them.
export const DEMAND_EVENT_TYPES = Object.freeze([
  'watch_add', 'watch_remove', 'search_view', 'card_view',
  'portfolio_add', 'scan_confirm', 'alert_create'
]);

/** Hour-truncated ISO bucket. Also the server-side rate-limit/dedup key
 * (Sec 29.2): the database's unique constraint on (user, variant, type, key)
 * silently collapses repeats within the same hour rather than trusting the
 * client to throttle itself. */
export function hourBucket(occurredAt) {
  const iso = new Date(occurredAt).toISOString();
  return iso.slice(0, 13);
}

export function demandEventId(userId, canonicalVariantId, eventType, eventKey) {
  return `${userId}:${canonicalVariantId}:${eventType}:${eventKey}`;
}

/** Pure eligibility check, isolated from session/config lookups so the
 * decision itself is unit-testable without a browser. */
export function demandEventEligible({ eventType, canonicalVariantId, optedOut, signedIn }) {
  if (!DEMAND_EVENT_TYPES.includes(eventType)) throw new Error(`Unknown demand event type: ${eventType}`);
  if (optedOut) return false;
  if (!isUUID(canonicalVariantId)) return false; // only exact-mapped variants are tracked
  if (!signedIn) return false; // local-only usage never reaches the aggregate boundary
  return true;
}

export function demandEventRow(entry) {
  return {
    user_id: entry.userId,
    catalog_variant_id: entry.catalogVariantId,
    event_type: entry.eventType,
    event_key: entry.eventKey,
    occurred_at: entry.occurredAt
  };
}

async function postDemandEvent(entry, session) {
  await request('/rest/v1/demand_events?on_conflict=user_id,catalog_variant_id,event_type,event_key', {
    method: 'POST',
    session,
    headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
    body: [demandEventRow(entry)]
  });
}

/**
 * Queues a first-party demand signal and makes a best-effort attempt to sync
 * it immediately. Never throws for expected conditions (opted out, unmapped
 * item, signed out, offline, transient network failure) — telemetry must
 * never interrupt the user action that triggered it. Returns the queued
 * record, or null if nothing was recorded.
 */
export async function recordDemandEvent(canonicalVariantId, eventType, { occurredAt = new Date().toISOString() } = {}) {
  let session = null;
  try {
    if (isSupabaseConfigured()) session = await validSession().catch(() => null);
  } catch {
    session = null;
  }
  const eligible = demandEventEligible({
    eventType,
    canonicalVariantId,
    optedOut: Boolean(getState().settings.demandAnalyticsOptOut),
    signedIn: Boolean(session?.user?.id)
  });
  if (!eligible) return null;

  const eventKey = hourBucket(occurredAt);
  const record = {
    id: demandEventId(session.user.id, canonicalVariantId, eventType, eventKey),
    userId: session.user.id,
    catalogVariantId: canonicalVariantId,
    eventType,
    eventKey,
    occurredAt,
    synced: false
  };
  try {
    await putRecord('demandEventsQueue', record);
  } catch {
    return null; // local persistence failed; drop rather than risk blocking the caller
  }
  await syncDemandEvents().catch(() => {});
  return record;
}

export const DEMAND_QUEUE_MAX_AGE_DAYS = 30;

/** Entries past local retention (or with unparseable timestamps), which are
 * dropped instead of synced — Sec 15.7 "limited retention" applies to the
 * local outbox too, so a permanently signed-out device cannot accumulate an
 * unbounded private event history. */
export function staleDemandQueueEntries(entries = [], nowMs = Date.now(), maxAgeDays = DEMAND_QUEUE_MAX_AGE_DAYS) {
  const cutoff = nowMs - maxAgeDays * 86_400_000;
  return entries.filter((entry) => !(Date.parse(entry?.occurredAt) > cutoff));
}

/**
 * Reconciliation rule between the local opt-out setting and the server-side
 * profiles flag. Deliberately asymmetric in the privacy-safe direction:
 * a remote opt-out is adopted locally, but a remote opt-IN never silently
 * re-enables recording on a device whose user opted out — that device
 * instead re-pushes its opt-out. Opting back in only propagates through an
 * explicit toggle on each device.
 */
export function mergeDemandOptOut(localOptedOut, remoteOptedOut) {
  if (remoteOptedOut === null || remoteOptedOut === undefined) return { adoptLocalOptOut: false, pushOptOut: false };
  if (remoteOptedOut && !localOptedOut) return { adoptLocalOptOut: true, pushOptOut: false };
  if (!remoteOptedOut && localOptedOut) return { adoptLocalOptOut: false, pushOptOut: true };
  return { adoptLocalOptOut: false, pushOptOut: false };
}

/** Flushes queued demand events to Supabase after pruning stale entries.
 * Best-effort: entries that fail to sync stay queued for the next attempt
 * (limited local retention — Sec 15.7 "Private, user-linked event stream
 * with limited retention"). */
export async function syncDemandEvents() {
  if (!isSupabaseConfigured()) return { synced: 0 };
  const all = await getAll('demandEventsQueue');
  const stale = staleDemandQueueEntries(all);
  for (const entry of stale) {
    if (entry?.id) await deleteRecord('demandEventsQueue', entry.id).catch(() => {});
  }
  const staleIds = new Set(stale.map((entry) => entry?.id));
  const queued = all.filter((entry) => !entry.synced && !staleIds.has(entry.id));
  if (!queued.length) return { synced: 0 };
  let session;
  try {
    session = await validSession();
  } catch {
    return { synced: 0 };
  }
  let synced = 0;
  for (const entry of queued) {
    try {
      await postDemandEvent(entry, session);
      await deleteRecord('demandEventsQueue', entry.id);
      synced += 1;
    } catch {
      // Leave queued; a later sync retries.
    }
  }
  return { synced };
}
