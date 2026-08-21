// Trajectory-v1 forecast hydration (T6, PRD Sec4 app integration).
//
// Reads the publication artifacts T5 slices onto the worker
// (`GET /catalog/forecasts/<categoryId>/<groupId>[.partN]` and
// `GET /catalog/forecasts/manifest`) and turns them into the same
// small set of horizons the published-intelligence display contract
// already understands: 30-day and 90-day q10/q50/q90 estimates. There is
// no 180-day or 365-day trajectory-v1 output -- callers must never invent
// one; `trajectoryForecastEstimates` only ever returns the horizons the
// source packet actually carries.
//
// Identity here is TCGCSV's own (categoryId, groupId, productId,
// subTypeName), not the app's canonical variant UUID -- the manifest and
// object payloads are keyed that way, and there is no cross-index from
// UUID back to TCGCSV identity to invert. Callers with a TCGCSV catalog
// item (categoryId/groupId/productId already present on the mapped
// catalog item, see services/providers/tcgcsv.js) can resolve a forecast
// directly; anything else is out of scope for trajectory-v1.
import { getRecord, putRecord } from '../core/db.js';
import { requestTCGCSVCatalog } from './providers/tcgcsv.js';

export const TRAJECTORY_HORIZONS = Object.freeze([30, 90]);
const CACHE_PREFIX = 'trajectory:v1:';
const MANIFEST_CACHE_MS = 6 * 60 * 60 * 1000;
const GROUP_CACHE_MS = 6 * 60 * 60 * 1000;
const STALENESS_MS = 8 * 7 * 24 * 60 * 60 * 1000; // 8 weeks, per the T6 display rule.
const MAX_PARTS = 64; // publish-time safety bound; a real group never approaches this.
const requestsInFlight = new Map();

function manifestCacheKey() {
  return `${CACHE_PREFIX}manifest`;
}

function groupCacheKey(categoryId, groupId) {
  return `${CACHE_PREFIX}group:${categoryId}:${groupId}`;
}

async function cached(key, ttlMs, loader) {
  if (requestsInFlight.has(key)) return requestsInFlight.get(key);
  const request = (async () => {
    const record = await getRecord('catalogCache', key).catch(() => null);
    if (record?.expiresAt > Date.now() && record.value) return record.value;
    const value = await loader();
    await putRecord('catalogCache', { key, expiresAt: Date.now() + ttlMs, value }).catch(() => {});
    return value;
  })();
  requestsInFlight.set(key, request);
  try {
    return await request;
  } finally {
    if (requestsInFlight.get(key) === request) requestsInFlight.delete(key);
  }
}

export async function fetchTrajectoryManifest({ session, fetchImpl, bypassCache = false } = {}) {
  const load = () => requestTCGCSVCatalog('/catalog/forecasts/manifest', { session, fetchImpl });
  if (bypassCache) {
    const value = await load();
    await putRecord('catalogCache', { key: manifestCacheKey(), expiresAt: Date.now() + MANIFEST_CACHE_MS, value }).catch(() => {});
    return value;
  }
  return cached(manifestCacheKey(), MANIFEST_CACHE_MS, load);
}

// Fail-closed: any manifest shape we don't recognize is treated as
// "unknown", never as "eligible". A group only ever counts as eligible
// when the manifest explicitly says status === 'published'.
export function manifestGroupEntry(manifest, categoryId, groupId) {
  const category = manifest?.categories?.[String(categoryId)];
  if (!category) return { eligibility: 'unknown', entry: null };
  const entry = category.groups?.[String(groupId)];
  if (!entry) return { eligibility: 'unknown', entry: null };
  if (entry.status === 'published' && Array.isArray(entry.parts) && entry.parts.length) {
    return { eligibility: 'published', entry };
  }
  if (entry.status === 'excluded') return { eligibility: 'excluded', entry };
  return { eligibility: 'unknown', entry: null };
}

function partSuffix(objectKey) {
  const match = /\.(part\d+)\.json\.gz$/.exec(String(objectKey || ''));
  return match ? `.${match[1]}` : '';
}

async function fetchGroupParts(categoryId, groupId, parts, { session, fetchImpl } = {}) {
  const ordered = [...parts].sort((left, right) => Number(left.part) - Number(right.part)).slice(0, MAX_PARTS);
  const partsTotal = ordered[0]?.partsTotal ?? ordered.length;
  const fetched = await Promise.all(ordered.map((part) => requestTCGCSVCatalog(
    `/catalog/forecasts/${categoryId}/${groupId}${partSuffix(part.objectKey)}`,
    { session, fetchImpl }
  )));
  const variants = [];
  let asOf = '';
  let modelVersion = '';
  fetched.forEach((payload, index) => {
    const expected = ordered[index];
    if (Number(payload?.part) !== Number(expected.part) || Number(payload?.partsTotal) !== Number(partsTotal)) {
      throw new Error('A trajectory forecast part is out of sequence with its manifest entry.');
    }
    asOf ||= payload.asOf || '';
    modelVersion ||= payload.modelVersion || '';
    variants.push(...(Array.isArray(payload.variants) ? payload.variants : []));
  });
  return { categoryId: Number(categoryId), groupId: Number(groupId), asOf, modelVersion, variants };
}

export async function fetchTrajectoryGroup(categoryId, groupId, manifestEntry, { session, fetchImpl, bypassCache = false } = {}) {
  const key = groupCacheKey(categoryId, groupId);
  const load = () => fetchGroupParts(categoryId, groupId, manifestEntry.parts, { session, fetchImpl });
  if (bypassCache) {
    const value = await load();
    await putRecord('catalogCache', { key, expiresAt: Date.now() + GROUP_CACHE_MS, value }).catch(() => {});
    return value;
  }
  return cached(key, GROUP_CACHE_MS, load);
}

// Top-level lookup: manifest -> (published | excluded | unknown), then the
// merged group object -> the single matching variant. Never falls back to
// a fabricated result -- every branch is explicit about which of the three
// T6 display states applies.
export async function getTrajectoryForecast(categoryId, groupId, productId, subTypeName, opts = {}) {
  if (![categoryId, groupId, productId].every((value) => Number.isSafeInteger(Number(value)) && Number(value) > 0)) {
    return { eligibility: 'unknown', packet: null };
  }
  const manifest = await fetchTrajectoryManifest(opts);
  const { eligibility, entry } = manifestGroupEntry(manifest, categoryId, groupId);
  if (eligibility !== 'published') return { eligibility, packet: null, manifest };
  const group = await fetchTrajectoryGroup(categoryId, groupId, entry, opts);
  const productVariants = group.variants.filter((variant) => Number(variant.productId) === Number(productId));
  // Exact (productId, subTypeName) match first. If the catalog item carries
  // no usable finish (e.g. a product with no price rows maps to variant '')
  // or its finish doesn't name any published packet, fall back to the
  // product's packet ONLY when it is unambiguous (exactly one variant
  // published for the product) -- never guess between finishes.
  const packet = productVariants.find((variant) => String(variant.subTypeName || '') === String(subTypeName || ''))
    || (productVariants.length === 1 ? productVariants[0] : null);
  if (!packet) return { eligibility: 'unknown', packet: null, manifest };
  return { eligibility: 'published', packet, manifest, groupAsOf: group.asOf };
}

// A TCGCSV-provider catalog item already carries categoryId/groupId/
// productId directly (see services/providers/tcgcsv.js's
// normalizeTCGCSVProduct); `variant` on that item is the preferred price
// option's subtypeName, which is the same field trajectory-v1 packets key
// on as `subTypeName`. Anything without provider === 'tcgcsv' (custom
// items, other providers with no TCGCSV identity) is out of scope for
// trajectory-v1 and returns an empty key.
export function trajectoryKeyForItem(item = {}) {
  if (item?.provider !== 'tcgcsv') return '';
  const { categoryId, groupId, productId } = item;
  if (![categoryId, groupId, productId].every((value) => Number.isSafeInteger(Number(value)) && Number(value) > 0)) return '';
  return `${Number(categoryId)}:${Number(groupId)}:${Number(productId)}:${String(item.variant || '')}`;
}

export function getTrajectoryForecastForItem(item = {}, opts = {}) {
  if (item?.provider !== 'tcgcsv') return Promise.resolve({ eligibility: 'unknown', packet: null });
  return getTrajectoryForecast(item.categoryId, item.groupId, item.productId, item.variant, opts);
}

export function isTrajectoryStale(packet, asOf) {
  const lastKnown = Date.parse(packet?.lastKnownDate || '');
  const reference = Date.parse(asOf || '') || Date.now();
  if (!Number.isFinite(lastKnown)) return packet?.confidence === 'cold-start' ? false : true;
  return reference - lastKnown > STALENESS_MS;
}

// Builds the {30, 90} estimate map the existing marketOutlookMarkup/
// searchResultViewModel display contract already reads (see
// core/view-models.js's forecastFor(horizon)). 180d/365d are
// intentionally absent -- trajectory-v1 does not produce them, and the
// contract already renders "not enough history" for a missing horizon
// rather than a fabricated one.
export function trajectoryForecastEstimates(packet) {
  const estimates = {};
  if (!packet?.horizons) return estimates;
  for (const horizon of TRAJECTORY_HORIZONS) {
    const band = packet.horizons[String(horizon)];
    if (!band || !Number.isFinite(Number(band.q50))) continue;
    const basis = Number(packet.lastKnownPrice);
    estimates[horizon] = {
      horizon,
      estimatedValue: Number(band.q50),
      lowerBound: Number.isFinite(Number(band.q10)) ? Number(band.q10) : null,
      upperBound: Number.isFinite(Number(band.q90)) ? Number(band.q90) : null,
      estimatedChange: Number.isFinite(basis) && basis > 0 ? Number(band.q50) / basis - 1 : null,
      confidence: packet.confidence,
      modelVersion: packet.modelVersion || 'trajectory-v1'
    };
  }
  return estimates;
}
