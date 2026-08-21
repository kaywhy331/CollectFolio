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
const PART_FETCH_CONCURRENCY = 4;
const MAX_GROUP_VARIANTS = 25_000;
const MAX_PATH_POINTS = 32;
const QUANTILE_FIELDS = Object.freeze(['q10', 'q25', 'q50', 'q75', 'q90']);
const HORIZON_KEYS = new Set(TRAJECTORY_HORIZONS.map(String));
const CONFIDENCE_TIERS = new Set(['standard', 'low-history', 'insufficient-history', 'cold-start']);
const requestsInFlight = new Map();

function manifestCacheKey() {
  return `${CACHE_PREFIX}manifest`;
}

function groupCacheKey(categoryId, groupId, manifestEntry = {}) {
  const generation = (manifestEntry.parts || []).map((part) =>
    String(part?.contentHash || `${part?.objectKey || ''}:${part?.variantCount ?? ''}`)).join(',');
  return `${CACHE_PREFIX}group:${categoryId}:${groupId}:${generation}`;
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
  if (entry.status === 'published' && validManifestParts(entry.parts, categoryId, groupId)) {
    return { eligibility: 'published', entry };
  }
  if (entry.status === 'excluded') return { eligibility: 'excluded', entry };
  return { eligibility: 'unknown', entry: null };
}

function partSuffix(objectKey) {
  const match = /\.(part\d+)\.json\.gz$/.exec(String(objectKey || ''));
  return match ? `.${match[1]}` : '';
}

function validManifestParts(parts, categoryId, groupId) {
  if (!Array.isArray(parts) || !parts.length || parts.length > MAX_PARTS) return false;
  const total = parts.length;
  const expectedKeys = new Set(Array.from({ length: total }, (_, index) => index + 1));
  for (const part of parts) {
    const number = part?.part;
    const partsTotal = part?.partsTotal;
    const expectedObjectKey = total === 1
      ? `forecasts/${Number(categoryId)}/${Number(groupId)}.json.gz`
      : `forecasts/${Number(categoryId)}/${Number(groupId)}.part${number}.json.gz`;
    if (!Number.isSafeInteger(number) || number < 1 || number > total
      || partsTotal !== total || String(part?.objectKey || '') !== expectedObjectKey
      || (part?.variantCount !== undefined && (!Number.isSafeInteger(part.variantCount) || part.variantCount < 0))
      || (part?.contentHash !== undefined && !/^[0-9a-f]{64}$/i.test(String(part.contentHash)))
      || !expectedKeys.delete(number)) return false;
  }
  return expectedKeys.size === 0;
}

function positiveInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function finiteNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function isoDate(value) {
  const text = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return '';
  const parsed = new Date(`${text}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text ? text : '';
}

function validDateTime(value) {
  if (isoDate(value)) return true;
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Boolean(isoDate(value.slice(0, 10)))
    && Number.isFinite(Date.parse(value));
}

export function normalizeTrajectoryBand(band) {
  if (!band || typeof band !== 'object' || Array.isArray(band)) return null;
  const values = QUANTILE_FIELDS.map((field) => finiteNonNegative(band[field]));
  if (values.some((value) => value === null) || values[2] <= 0) return null;
  if (values.some((value, index) => index > 0 && value < values[index - 1])) return null;
  return Object.fromEntries(QUANTILE_FIELDS.map((field, index) => [field, values[index]]));
}

// The worker response is untrusted network input. A packet is eligible for
// display only when its exact product/finish identity, confidence tier,
// served horizons, noncrossing quantiles, and bounded median path all match
// the trajectory-v1 publication contract. Invalid packets are omitted; no
// value is repaired, reordered, or inferred in the browser.
export function normalizeTrajectoryPacket(packet, {
  expectedCategoryId = null,
  expectedGroupId = null,
  expectedProductId = null,
  expectedSubTypeName = null,
  expectedAsOf = '',
  modelVersion = ''
} = {}) {
  if (!packet || typeof packet !== 'object' || Array.isArray(packet)) return null;
  const productId = positiveInteger(packet.productId);
  const subTypeName = String(packet.subTypeName || '').slice(0, 160);
  if (!productId || (expectedProductId !== null && productId !== Number(expectedProductId))) return null;
  if (packet.categoryId !== undefined && (!positiveInteger(packet.categoryId)
    || (expectedCategoryId !== null && packet.categoryId !== Number(expectedCategoryId)))) return null;
  if (packet.groupId !== undefined && (!positiveInteger(packet.groupId)
    || (expectedGroupId !== null && packet.groupId !== Number(expectedGroupId)))) return null;
  if (packet.asOf !== undefined && (!validDateTime(packet.asOf) || (expectedAsOf && packet.asOf !== expectedAsOf))) return null;
  if (expectedSubTypeName !== null && subTypeName !== String(expectedSubTypeName || '')) return null;
  if (!CONFIDENCE_TIERS.has(packet.confidence)) return null;

  const lastKnownPrice = finiteNonNegative(packet.lastKnownPrice);
  const lastKnownDate = isoDate(packet.lastKnownDate);
  if (packet.confidence === 'cold-start') {
    if (lastKnownPrice !== null || lastKnownDate) return null;
  } else if (lastKnownPrice === null || lastKnownPrice <= 0 || !lastKnownDate) return null;

  if (!packet.horizons || typeof packet.horizons !== 'object' || Array.isArray(packet.horizons)) return null;
  const horizonKeys = Object.keys(packet.horizons);
  if (!horizonKeys.length || horizonKeys.some((key) => !HORIZON_KEYS.has(key))) return null;
  const horizons = {};
  for (const horizon of TRAJECTORY_HORIZONS) {
    if (!Object.prototype.hasOwnProperty.call(packet.horizons, String(horizon))) continue;
    const band = normalizeTrajectoryBand(packet.horizons[String(horizon)]);
    if (!band) return null;
    horizons[horizon] = band;
  }

  if (!Array.isArray(packet.medianPath) || packet.medianPath.length > MAX_PATH_POINTS) return null;
  let previousPathTime = -Infinity;
  const medianPath = [];
  for (const point of packet.medianPath) {
    const date = isoDate(point?.date);
    const price = finiteNonNegative(point?.price);
    const time = Date.parse(`${date}T00:00:00.000Z`);
    if (!date || price === null || price <= 0 || time <= previousPathTime) return null;
    previousPathTime = time;
    medianPath.push({ date, price });
  }

  const sampleSize = packet.sampleSize === undefined ? null : packet.sampleSize;
  if (sampleSize !== null && (!Number.isSafeInteger(sampleSize) || sampleSize < 0)) return null;
  const packetModelVersion = packet.modelVersion === undefined ? '' : String(packet.modelVersion).trim();
  const expectedModelVersion = String(modelVersion || '').trim();
  if (packetModelVersion && expectedModelVersion && packetModelVersion !== expectedModelVersion) return null;
  const resolvedModelVersion = packetModelVersion || expectedModelVersion;
  if (!resolvedModelVersion || resolvedModelVersion.length > 120) return null;
  return {
    ...packet,
    productId,
    subTypeName,
    confidence: packet.confidence,
    lastKnownPrice,
    lastKnownDate,
    horizons,
    medianPath,
    ...(sampleSize === null ? {} : { sampleSize }),
    modelVersion: resolvedModelVersion
  };
}

async function fetchGroupParts(categoryId, groupId, manifestEntry, { session, fetchImpl } = {}) {
  const parts = manifestEntry?.parts;
  if (!validManifestParts(parts, categoryId, groupId)) {
    throw new Error('The trajectory forecast manifest has an invalid part set.');
  }
  const ordered = [...parts].sort((left, right) => Number(left.part) - Number(right.part));
  const partsTotal = ordered.length;
  const fetched = new Array(ordered.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < ordered.length) {
      const index = nextIndex++;
      const part = ordered[index];
      fetched[index] = await requestTCGCSVCatalog(
        `/catalog/forecasts/${categoryId}/${groupId}${partSuffix(part.objectKey)}`,
        { session, fetchImpl }
      );
    }
  };
  await Promise.all(Array.from({ length: Math.min(PART_FETCH_CONCURRENCY, ordered.length) }, () => worker()));
  const variants = [];
  let asOf = '';
  let modelVersion = '';
  fetched.forEach((payload, index) => {
    const expected = ordered[index];
    const payloadAsOf = String(payload?.asOf || '');
    const payloadModelVersion = String(payload?.modelVersion || '');
    if (Number(payload?.categoryId) !== Number(categoryId) || Number(payload?.groupId) !== Number(groupId)
      || Number(payload?.part) !== Number(expected.part) || Number(payload?.partsTotal) !== partsTotal
      || !validDateTime(payloadAsOf) || !payloadModelVersion) {
      throw new Error('A trajectory forecast part is out of sequence with its manifest entry.');
    }
    if ((asOf && asOf !== payloadAsOf) || (modelVersion && modelVersion !== payloadModelVersion)) {
      throw new Error('Trajectory forecast parts disagree on publication identity.');
    }
    if (!Array.isArray(payload.variants)
      || (expected.variantCount !== undefined && Number(expected.variantCount) !== payload.variants.length)
      || variants.length + payload.variants.length > MAX_GROUP_VARIANTS) {
      throw new Error('A trajectory forecast group exceeded its bounded variant contract.');
    }
    asOf ||= payloadAsOf;
    modelVersion ||= payloadModelVersion;
    variants.push(...payload.variants);
  });
  if (manifestEntry.eligibleVariantCount !== undefined
    && (!Number.isSafeInteger(manifestEntry.eligibleVariantCount)
      || manifestEntry.eligibleVariantCount < 0
      || manifestEntry.eligibleVariantCount !== variants.length)) {
    throw new Error('A trajectory forecast group disagrees with its manifest variant count.');
  }
  return { categoryId: Number(categoryId), groupId: Number(groupId), asOf, modelVersion, variants };
}

export async function fetchTrajectoryGroup(categoryId, groupId, manifestEntry, { session, fetchImpl, bypassCache = false } = {}) {
  const key = groupCacheKey(categoryId, groupId, manifestEntry);
  const load = () => fetchGroupParts(categoryId, groupId, manifestEntry, { session, fetchImpl });
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
  const exact = productVariants.filter((variant) => String(variant.subTypeName || '') === String(subTypeName || ''));
  const selected = exact.length === 1 ? exact[0] : (!exact.length && productVariants.length === 1 ? productVariants[0] : null);
  const packet = selected ? normalizeTrajectoryPacket(selected, {
    expectedCategoryId: categoryId,
    expectedGroupId: groupId,
    expectedProductId: productId,
    expectedSubTypeName: exact.length === 1 ? subTypeName : selected.subTypeName,
    expectedAsOf: group.asOf,
    modelVersion: group.modelVersion
  }) : null;
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
    const band = normalizeTrajectoryBand(packet.horizons[String(horizon)]);
    if (!band) continue;
    const basis = Number(packet.lastKnownPrice);
    estimates[horizon] = {
      horizon,
      estimatedValue: band.q50,
      lowerBound: band.q10,
      upperBound: band.q90,
      estimatedChange: Number.isFinite(basis) && basis > 0 ? band.q50 / basis - 1 : null,
      baselineValue: Number.isFinite(basis) && basis > 0 ? basis : null,
      baselineDate: isoDate(packet.lastKnownDate),
      confidence: packet.confidence,
      modelVersion: packet.modelVersion || 'trajectory-v1'
    };
  }
  return estimates;
}
