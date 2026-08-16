import { dataUrlBytes } from '../core/utils.js';
import { isUUID } from '../core/catalog-identity.js';
import { portfolioSnapshotId } from '../core/calculations.js';
import { deleteRecord, getAll, putRecord, recordDailySnapshot, recordLocalHoldingObservations } from '../core/db.js';
import { isSupportedPricingPolicyVersion } from '../core/pricing-policy.js';
import { mergeWatchlistItems, mergeWatchlistTombstones } from './watchlist.js';

const SESSION_KEY = 'collectfolio:supabase-session';
const INLINE_IMAGE_LIMIT = 180 * 1024;
export const SUPABASE_REQUEST_TIMEOUT_MS = 12_000;
export const SYNC_PAGE_SIZE = 500;
export const SYNC_WRITE_BATCH_SIZE = 20;
export const SYNC_DELETE_CONCURRENCY = 10;
export const SYNC_RECORD_LIMIT = 100_000;

function config() {
  return globalThis.window?.COLLECTFOLIO_CONFIG || {};
}

export function isSupabaseConfigured() {
  return Boolean(config().SUPABASE_URL && config().SUPABASE_ANON_KEY);
}

export async function fetchPublicFeatureFlags() {
  if (!isSupabaseConfigured()) return {};
  const rows = await request('/rest/v1/product_feature_flags?select=key,enabled,updated_at');
  return Object.fromEntries((rows || []).map((row) => [row.key, Boolean(row.enabled)]));
}

export function normalizeIntelligencePublication(row = {}) {
  const payload = row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload) ? row.payload : {};
  const payloadSeries = payload.seriesIdentity && typeof payload.seriesIdentity === 'object'
    ? payload.seriesIdentity
    : {};
  return {
    variantId: row.catalog_variant_id || '',
    publicationId: row.id || row.catalog_variant_id || '',
    seriesIdentity: {
      sourceId: row.market_source_id || payloadSeries.sourceId || '',
      currency: row.market_currency || payloadSeries.currency || '',
      language: row.market_language || payloadSeries.language || '',
      finish: row.market_finish || payloadSeries.finish || '',
      conditionClass: row.condition_class || payloadSeries.conditionClass || '',
      marketCondition: row.market_condition || payloadSeries.marketCondition || '',
      priceSemantics: row.price_semantics || payloadSeries.priceSemantics || ''
    },
    supportTier: Math.max(0, Math.min(5, Number(row.support_tier) || 0)),
    status: row.publication_status || 'unsupported',
    reasonCodes: Array.isArray(row.reason_codes) ? row.reason_codes.map(String) : [],
    payload,
    sourceAttributions: Array.isArray(row.source_attributions) ? row.source_attributions : [],
    sourcePolicyHash: row.source_policy_hash || '',
    payloadHash: row.payload_hash || '',
    publishedAt: row.published_at || '',
    expiresAt: row.expires_at || ''
  };
}

export async function fetchPublishedIntelligence(variantIds = []) {
  if (!isSupabaseConfigured()) return [];
  const ids = [...new Set(variantIds.filter(isUUID).map((id) => id.toLowerCase()))];
  if (!ids.length) return [];
  const rows = [];
  for (let index = 0; index < ids.length; index += 50) {
    const batch = ids.slice(index, index + 50).join(',');
    const path = `/rest/v1/card_intelligence_publications?catalog_variant_id=in.(${encodeURIComponent(batch)})&select=catalog_variant_id,support_tier,publication_status,reason_codes,payload,source_attributions,source_policy_hash,payload_hash,published_at,expires_at`;
    rows.push(...await request(path));
  }
  return rows.map(normalizeIntelligencePublication);
}

function requireConfig() {
  if (!isSupabaseConfigured()) throw new Error('Cloud backup is not available in this build.');
  return { url: String(config().SUPABASE_URL).replace(/\/$/, ''), key: config().SUPABASE_ANON_KEY };
}

export async function request(path, { method = 'GET', body, session, headers = {}, timeout = SUPABASE_REQUEST_TIMEOUT_MS, withMetadata = false } = {}) {
  const { url, key } = requireConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, Number(timeout) || SUPABASE_REQUEST_TIMEOUT_MS));
  try {
    const response = await fetch(`${url}${path}`, {
      method,
      signal: controller.signal,
      headers: { apikey: key, Authorization: `Bearer ${session?.access_token || key}`, 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    const value = text ? JSON.parse(text) : null;
    if (!response.ok) {
      throw Object.assign(
        new Error(value?.msg || value?.message || value?.error_description || `Cloud request failed (${response.status}).`),
        { status: response.status, code: value?.code || '' }
      );
    }
    return withMetadata
      ? { value, contentRange: response.headers?.get?.('content-range') || '' }
      : value;
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw Object.assign(new Error(`Cloud request timed out after ${Math.ceil((Number(timeout) || SUPABASE_REQUEST_TIMEOUT_MS) / 1000)} seconds.`), { name: 'TimeoutError' });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function chunkRecords(records = [], size = SYNC_WRITE_BATCH_SIZE) {
  const width = Math.max(1, Math.trunc(Number(size) || SYNC_WRITE_BATCH_SIZE));
  const values = Array.isArray(records) ? records : [];
  return Array.from({ length: Math.ceil(values.length / width) }, (_, index) =>
    values.slice(index * width, (index + 1) * width));
}

function contentRangeTotal(value) {
  const match = /\/(\d+)$/.exec(String(value || ''));
  return match ? Number(match[1]) : null;
}

export async function requestAllPages(path, {
  session,
  pageSize = SYNC_PAGE_SIZE,
  maximumRecords = SYNC_RECORD_LIMIT,
  requester = request
} = {}) {
  const width = Math.max(1, Math.trunc(Number(pageSize) || SYNC_PAGE_SIZE));
  const maximum = Math.max(1, Math.trunc(Number(maximumRecords) || SYNC_RECORD_LIMIT));
  const rows = [];
  while (true) {
    const start = rows.length;
    const result = await requester(path, {
      session,
      headers: { Range: `${start}-${start + width - 1}`, 'Range-Unit': 'items', Prefer: 'count=exact' },
      withMetadata: true
    });
    const page = Array.isArray(result) ? result : result?.value;
    if (!Array.isArray(page)) throw new Error('Cloud backup returned an invalid paginated response.');
    const total = contentRangeTotal(Array.isArray(result) ? '' : result?.contentRange);
    if (total !== null && total > maximum) {
      throw new Error(`Cloud backup exceeds the ${maximum.toLocaleString('en-US')}-record safety limit.`);
    }
    if (rows.length + page.length > maximum) {
      throw new Error(`Cloud backup exceeds the ${maximum.toLocaleString('en-US')}-record safety limit.`);
    }
    rows.push(...page);
    // Exact counts disambiguate a final short page from a deployment whose
    // server-side row cap is smaller than the requested range. If an older
    // endpoint omits the count, a short page remains the compatibility stop.
    if (!page.length || (total !== null ? rows.length >= total : page.length < width)) return rows;
  }
}

export async function upsertInBatches(path, rows, {
  session,
  headers = {},
  batchSize = SYNC_WRITE_BATCH_SIZE,
  requester = request
} = {}) {
  for (const batch of chunkRecords(rows, batchSize)) {
    await requester(path, { method: 'POST', session, headers, body: batch });
  }
}

export async function forEachInBatches(values, callback, concurrency = SYNC_DELETE_CONCURRENCY) {
  for (const batch of chunkRecords(values, concurrency)) await Promise.all(batch.map(callback));
}

function normalizeSession(payload) {
  const session = payload?.session || payload;
  if (!session?.access_token) return null;
  return { ...session, expires_at: Number(session.expires_at) || Math.floor(Date.now() / 1000) + Number(session.expires_in || 3600) };
}

export function loadSession() {
  try { return normalizeSession(JSON.parse(localStorage.getItem(SESSION_KEY))); } catch { return null; }
}

function storeSession(payload) {
  const session = normalizeSession(payload);
  if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  return session;
}

export function authRedirectPath(path, current = globalThis.location) {
  if (!current?.origin) return path;
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}redirect_to=${encodeURIComponent(`${current.origin}${current.pathname || '/'}`)}`;
}

export async function signUp(email, password) {
  return storeSession(await request(authRedirectPath('/auth/v1/signup'), { method: 'POST', body: { email, password } }));
}

export async function signIn(email, password) {
  return storeSession(await request('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password } }));
}

export async function requestMagicLink(email) {
  await request(authRedirectPath('/auth/v1/otp'), { method: 'POST', body: { email, create_user: true } });
}

export function consumeAuthCallback() {
  if (!location.hash) return { session: loadSession(), error: '' };
  const params = new URLSearchParams(location.hash.slice(1));
  const error = params.get('error_description') || params.get('error') || '';
  let session = null;
  if (params.get('access_token')) session = storeSession({ access_token: params.get('access_token'), refresh_token: params.get('refresh_token'), expires_in: Number(params.get('expires_in') || 3600), token_type: params.get('token_type') || 'bearer', user: params.get('user') ? JSON.parse(params.get('user')) : undefined });
  if (error || session) history.replaceState(null, '', `${location.pathname}${location.search}`);
  return { session: session || loadSession(), error };
}

export async function refreshSession(session = loadSession()) {
  if (!session?.refresh_token) throw new Error('Your cloud session has expired. Sign in again.');
  return storeSession(await request('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: session.refresh_token } }));
}

export async function validSession() {
  const session = loadSession();
  if (!session) throw new Error('Sign in before syncing.');
  return session.expires_at * 1000 <= Date.now() + 60_000 ? refreshSession(session) : session;
}

export async function signOut() {
  const session = loadSession();
  try { if (session) await request('/auth/v1/logout', { method: 'POST', session }); } catch { /* Local sign-out must still work offline. */ } finally { localStorage.removeItem(SESSION_KEY); }
}

export function mergeTombstones(...sets) {
  const merged = new Map();
  for (const tombstone of sets.flat()) {
    if (!tombstone?.id) continue;
    const current = merged.get(tombstone.id);
    if (!current || String(tombstone.deletedAt) > String(current.deletedAt)) merged.set(tombstone.id, { ...tombstone });
  }
  return [...merged.values()];
}

export function mergeHoldings(local, remote, deletedIds = new Set()) {
  const localImages = new Map(local.filter((holding) => holding?.id && holding.userImage).map((holding) => [holding.id, holding.userImage]));
  const merged = new Map();
  for (const holding of [...local, ...remote]) {
    if (!holding?.id || deletedIds.has(holding.id)) continue;
    const current = merged.get(holding.id);
    if (!current || String(holding.updatedAt || '') > String(current.updatedAt || '')) merged.set(holding.id, { ...holding });
  }
  return [...merged.values()].map((holding) => holding.userImage || !localImages.has(holding.id)
    ? holding
    : { ...holding, userImage: localImages.get(holding.id) });
}

function isCalendarDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1];
}

function normalizeISODateTime(value) {
  if (typeof value !== 'string') return '';
  const match = /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
  if (!match || !isCalendarDate(match[1])) return '';
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : '';
}

function canonicalPortfolioSnapshotId(value, date, currency) {
  const id = String(value || '');
  const canonical = portfolioSnapshotId(date, currency);
  if (id === `portfolio:${date}`) return canonical;
  const qualified = /^portfolio:([A-Z]{3}):(\d{4}-\d{2}-\d{2})$/i.exec(id);
  return qualified && qualified[1].toUpperCase() === currency && qualified[2] === date
    ? canonical
    : '';
}

export function normalizePortfolioSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
  if (typeof snapshot.id !== 'string' || typeof snapshot.date !== 'string') return null;
  if (!isCalendarDate(snapshot.date)) return null;
  if (!isSupportedPricingPolicyVersion(snapshot.pricingPolicyVersion)) return null;
  // Pre-currency snapshots contained provider USD amounts even when the UI
  // relabeled them. Treat that legacy numeric history as USD, never as the
  // collector's later display preference.
  const currency = String(snapshot.currency || 'USD').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) return null;
  const id = canonicalPortfolioSnapshotId(snapshot.id, snapshot.date, currency);
  if (!id) return null;
  const updatedAt = normalizeISODateTime(snapshot.updatedAt);
  if (!updatedAt) return null;
  if (typeof snapshot.marketValue !== 'number' || !Number.isFinite(snapshot.marketValue) || snapshot.marketValue < 0) return null;
  if (typeof snapshot.costBasis !== 'number' || !Number.isFinite(snapshot.costBasis) || snapshot.costBasis < 0) return null;
  if (!Number.isInteger(snapshot.uniqueItems) || snapshot.uniqueItems < 0) return null;
  if (!Number.isInteger(snapshot.totalQuantity) || snapshot.totalQuantity < 0) return null;
  return {
    id,
    date: snapshot.date,
    pricingPolicyVersion: snapshot.pricingPolicyVersion,
    currency,
    marketValue: snapshot.marketValue === 0 ? 0 : snapshot.marketValue,
    costBasis: snapshot.costBasis === 0 ? 0 : snapshot.costBasis,
    uniqueItems: snapshot.uniqueItems === 0 ? 0 : snapshot.uniqueItems,
    totalQuantity: snapshot.totalQuantity === 0 ? 0 : snapshot.totalQuantity,
    updatedAt
  };
}

export function remotePortfolioSnapshot(row = {}) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const embedded = normalizePortfolioSnapshot(row.data);
  const updatedAt = normalizeISODateTime(row.updated_at);
  const rowId = embedded ? canonicalPortfolioSnapshotId(row.id, embedded.date, embedded.currency) : '';
  if (!embedded || !updatedAt || rowId !== embedded.id || row.snapshot_date !== embedded.date) return null;
  return { ...embedded, updatedAt };
}

export function portfolioSnapshotRow(snapshot, userId) {
  const normalized = normalizePortfolioSnapshot(snapshot);
  if (!normalized || typeof userId !== 'string' || !userId) return null;
  return {
    user_id: userId,
    id: normalized.id,
    data: normalized,
    snapshot_date: normalized.date,
    updated_at: normalized.updatedAt
  };
}

export function mergePortfolioSnapshots(...sets) {
  const merged = new Map();
  for (const snapshot of sets.flatMap((set) => Array.isArray(set) ? set : [])) {
    const normalized = normalizePortfolioSnapshot(snapshot);
    if (!normalized) continue;
    const current = merged.get(normalized.id);
    const timestampOrder = current ? normalized.updatedAt.localeCompare(current.updatedAt) : 1;
    const tieOrder = current ? JSON.stringify(normalized).localeCompare(JSON.stringify(current)) : 1;
    if (!current || timestampOrder > 0 || (timestampOrder === 0 && tieOrder > 0)) merged.set(normalized.id, normalized);
  }
  return [...merged.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function remoteHolding(row) {
  return { ...row.data, id: row.id, userImage: row.user_image || row.data?.userImage || '', updatedAt: row.updated_at || row.data?.updatedAt, dirty: false };
}

function holdingRow(holding, userId) {
  const includeImage = holding.userImage && dataUrlBytes(holding.userImage) <= INLINE_IMAGE_LIMIT;
  const data = { ...holding, userImage: '' };
  return { id: holding.id, user_id: userId, data, user_image: includeImage ? holding.userImage : null, updated_at: holding.updatedAt };
}

export async function syncPortfolioSnapshots(session, userId) {
  await recordDailySnapshot();
  const [localSnapshots, remoteRows] = await Promise.all([
    getAll('snapshots'),
    requestAllPages('/rest/v1/portfolio_snapshots?select=id,data,snapshot_date,updated_at&order=id.asc', { session })
  ]);
  const remoteSnapshots = Array.isArray(remoteRows)
    ? remoteRows.map(remotePortfolioSnapshot).filter(Boolean)
    : [];
  const merged = mergePortfolioSnapshots(localSnapshots, remoteSnapshots);
  for (const snapshot of merged) await putRecord('snapshots', snapshot);
  if (merged.length) {
    await upsertInBatches('/rest/v1/portfolio_snapshots?on_conflict=user_id,id',
      merged.map((snapshot) => portfolioSnapshotRow(snapshot, userId)), {
      session,
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }
    });
  }
  return merged.length;
}

export function remoteWatchlistItem(row) {
  const catalogRef = row.catalog_snapshot || {};
  return {
    id: row.watch_key,
    watchKey: row.watch_key,
    canonicalVariantId: row.catalog_variant_id || catalogRef.canonicalVariantId || '',
    catalogRef,
    marketCondition: row.market_condition || catalogRef.marketCondition || '',
    targetPrice: row.target_price === null || row.target_price === undefined ? '' : Number(row.target_price),
    targetCurrency: String(catalogRef.targetCurrency || catalogRef.currency || 'USD').toUpperCase(),
    alertPercentChange: row.alert_percent_change === null || row.alert_percent_change === undefined ? '' : Number(row.alert_percent_change),
    alertTrendChange: Boolean(row.alert_trend_change),
    alertRangeChange: Boolean(row.alert_range_change),
    alertForecastChange: Boolean(row.alert_forecast_change),
    notes: row.notes || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    dirty: false
  };
}

export function watchlistRow(entry, userId, watchlistId, { includeMarketCondition = true } = {}) {
  const row = {
    watchlist_id: watchlistId,
    user_id: userId,
    watch_key: entry.watchKey,
    catalog_variant_id: isUUID(entry.canonicalVariantId) ? entry.canonicalVariantId : null,
    catalog_snapshot: {
      ...(entry.catalogRef || {}),
      marketCondition: entry.marketCondition || entry.catalogRef?.marketCondition || '',
      targetCurrency: entry.targetCurrency || entry.catalogRef?.currency || 'USD'
    },
    target_price: entry.targetPrice === '' || entry.targetPrice === null || entry.targetPrice === undefined ? null : Number(entry.targetPrice),
    alert_percent_change: entry.alertPercentChange === '' || entry.alertPercentChange === null || entry.alertPercentChange === undefined ? null : Number(entry.alertPercentChange),
    alert_trend_change: Boolean(entry.alertTrendChange),
    alert_range_change: Boolean(entry.alertRangeChange),
    alert_forecast_change: Boolean(entry.alertForecastChange),
    notes: entry.notes || '',
    created_at: entry.createdAt,
    updated_at: entry.updatedAt
  };
  if (includeMarketCondition) row.market_condition = entry.marketCondition || null;
  return row;
}

function missingWatchlistMarketCondition(error) {
  return error?.code === '42703' && /\bmarket_condition\b/i.test(error.message || '');
}

export async function requestWatchlistItems(encodedWatchlistId, {
  session,
  requester = requestAllPages
} = {}) {
  const base = `/rest/v1/watchlist_items?watchlist_id=eq.${encodedWatchlistId}&select=`;
  const common = 'watch_key,catalog_variant_id,catalog_snapshot,target_price,alert_percent_change,alert_trend_change,alert_range_change,alert_forecast_change,notes,created_at,updated_at&order=watch_key.asc';
  try {
    return {
      rows: await requester(`${base}watch_key,catalog_variant_id,market_condition,catalog_snapshot,target_price,alert_percent_change,alert_trend_change,alert_range_change,alert_forecast_change,notes,created_at,updated_at&order=watch_key.asc`, { session }),
      supportsMarketCondition: true
    };
  } catch (error) {
    if (!missingWatchlistMarketCondition(error)) throw error;
    return {
      rows: await requester(`${base}${common}`, { session }),
      supportsMarketCondition: false
    };
  }
}

function jwtSubject(token) {
  const segment = token?.split('.')[1];
  if (!segment) throw new Error('Your cloud session is invalid. Sign in again.');
  const normalized = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  return JSON.parse(atob(padded)).sub;
}

export async function syncPortfolio() {
  const session = await validSession();
  const userId = session.user?.id || jwtSubject(session.access_token);
  const [localHoldings, localTombstones, remoteHoldingRows, remoteTombstoneRows] = await Promise.all([
    getAll('holdings'), getAll('deletions'),
    requestAllPages('/rest/v1/holdings?select=id,data,user_image,updated_at&order=id.asc', { session }),
    requestAllPages('/rest/v1/holding_deletions?select=holding_id,deleted_at&order=holding_id.asc', { session })
  ]);
  const remoteHoldings = (remoteHoldingRows || []).map(remoteHolding);
  const remoteTombstones = (remoteTombstoneRows || []).map((row) => ({ id: row.holding_id, deletedAt: row.deleted_at, dirty: false }));
  const tombstones = mergeTombstones(localTombstones, remoteTombstones);

  if (tombstones.length) {
    await upsertInBatches('/rest/v1/holding_deletions?on_conflict=user_id,holding_id',
      tombstones.map((entry) => ({ user_id: userId, holding_id: entry.id, deleted_at: entry.deletedAt })), {
        session, headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }
      });
  }

  const deletedIds = new Set(tombstones.map((entry) => entry.id));
  for (const id of deletedIds) await deleteRecord('holdings', id);
  await forEachInBatches([...deletedIds], (id) =>
    request(`/rest/v1/holdings?id=eq.${encodeURIComponent(id)}`, {
      method: 'DELETE', session, headers: { Prefer: 'return=minimal' }
    }));

  const merged = mergeHoldings(localHoldings, remoteHoldings, deletedIds);
  for (const holding of merged) await putRecord('holdings', { ...holding, dirty: false });
  // Cloud holding rows do not carry the device-owned local scenario ledger.
  // Capture their reconciled current values locally after LWW resolution.
  await recordLocalHoldingObservations(merged);
  if (merged.length) {
    await upsertInBatches('/rest/v1/holdings?on_conflict=id', merged.map((holding) => holdingRow(holding, userId)), {
      session, headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }
    });
  }
  for (const tombstone of tombstones) await putRecord('deletions', { ...tombstone, dirty: false });
  const snapshots = await syncPortfolioSnapshots(session, userId);
  return { holdings: merged.length, deletions: tombstones.length, snapshots, omittedImages: merged.filter((holding) => holding.userImage && dataUrlBytes(holding.userImage) > INLINE_IMAGE_LIMIT).length };
}

export async function syncWatchlist() {
  const session = await validSession();
  const userId = session.user?.id || jwtSubject(session.access_token);
  const watchlistId = await request('/rest/v1/rpc/get_or_create_default_watchlist', {
    method: 'POST', session, body: {}
  });
  if (!isUUID(watchlistId)) throw new Error('Cloud watchlist setup returned an invalid identifier.');

  const encodedWatchlistId = encodeURIComponent(watchlistId);
  const [localItems, localTombstones, remoteResult, remoteDeletionRows] = await Promise.all([
    getAll('watchlistItems'),
    getAll('watchlistDeletions'),
    requestWatchlistItems(encodedWatchlistId, { session }),
    requestAllPages(`/rest/v1/watchlist_deletions?watchlist_id=eq.${encodedWatchlistId}&select=watch_key,deleted_at&order=watch_key.asc`, { session })
  ]);

  const remoteItems = (remoteResult.rows || []).map(remoteWatchlistItem);
  const remoteTombstones = (remoteDeletionRows || []).map((row) => ({
    id: row.watch_key, deletedAt: row.deleted_at, dirty: false
  }));
  const tombstones = mergeWatchlistTombstones(localTombstones, remoteTombstones);

  if (tombstones.length) {
    await upsertInBatches('/rest/v1/watchlist_deletions?on_conflict=watchlist_id,watch_key',
      tombstones.map((entry) => ({
        watchlist_id: watchlistId,
        user_id: userId,
        watch_key: entry.id,
        deleted_at: entry.deletedAt,
        updated_at: entry.deletedAt
      })), {
      session,
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    });
  }

  const deletedKeys = new Set(tombstones.map((entry) => entry.id));
  for (const watchKey of deletedKeys) await deleteRecord('watchlistItems', watchKey);
  await forEachInBatches([...deletedKeys], (watchKey) =>
    request(`/rest/v1/watchlist_items?watchlist_id=eq.${encodedWatchlistId}&watch_key=eq.${encodeURIComponent(watchKey)}`, {
      method: 'DELETE', session, headers: { Prefer: 'return=minimal' }
    }));

  const merged = mergeWatchlistItems(localItems, remoteItems, deletedKeys);
  for (const entry of merged) await putRecord('watchlistItems', { ...entry, dirty: false });
  if (merged.length) {
    await upsertInBatches('/rest/v1/watchlist_items?on_conflict=watchlist_id,watch_key',
      merged.map((entry) => watchlistRow(entry, userId, watchlistId, {
        includeMarketCondition: remoteResult.supportsMarketCondition
      })), {
      session,
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    });
  }
  for (const tombstone of tombstones) await putRecord('watchlistDeletions', { ...tombstone, dirty: false });
  return { items: merged.length, deletions: tombstones.length };
}

/** Best-effort push of the demand-analytics opt-out to the user's own
 * profiles row so the server-side aggregation job can honor it (migration
 * 0007). Callers treat failure as retryable, never blocking. */
export async function pushDemandAnalyticsOptOut(optedOut) {
  const session = await validSession();
  const userId = session.user?.id || jwtSubject(session.access_token);
  await request(`/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    session,
    headers: { Prefer: 'return=minimal' },
    body: { demand_analytics_opt_out: Boolean(optedOut) }
  });
}

/** Returns the server-side opt-out flag, or null when unknowable (signed
 * out, migration not applied yet, network failure). RLS limits the read to
 * the user's own row. */
export async function fetchDemandAnalyticsOptOut() {
  try {
    const session = await validSession();
    const rows = await request('/rest/v1/profiles?select=demand_analytics_opt_out', { session });
    if (!Array.isArray(rows) || !rows.length) return null;
    return Boolean(rows[0].demand_analytics_opt_out);
  } catch {
    return null;
  }
}

export async function syncAll() {
  const portfolio = await syncPortfolio();
  try {
    return { ...portfolio, watchlist: await syncWatchlist(), watchlistError: '' };
  } catch (error) {
    return { ...portfolio, watchlist: null, watchlistError: error.message || 'Watchlist sync is not available.' };
  }
}

export async function removeCloudData() {
  const session = await validSession();
  return request('/rest/v1/rpc/remove_my_cloud_data', {
    method: 'POST',
    session,
    body: {}
  });
}
