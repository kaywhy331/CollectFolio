import { dataUrlBytes } from '../core/utils.js';
import { isUUID } from '../core/catalog-identity.js';
import { deleteRecord, getAll, putRecord, recordDailySnapshot } from '../core/db.js';
import { mergeWatchlistItems, mergeWatchlistTombstones } from './watchlist.js';

const SESSION_KEY = 'collectfolio:supabase-session';
const INLINE_IMAGE_LIMIT = 180 * 1024;

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
  return {
    variantId: row.catalog_variant_id || '',
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
  if (!isSupabaseConfigured()) throw new Error('Supabase public-key configuration is not enabled.');
  return { url: String(config().SUPABASE_URL).replace(/\/$/, ''), key: config().SUPABASE_ANON_KEY };
}

export async function request(path, { method = 'GET', body, session, headers = {} } = {}) {
  const { url, key } = requireConfig();
  const response = await fetch(`${url}${path}`, {
    method,
    headers: { apikey: key, Authorization: `Bearer ${session?.access_token || key}`, 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  const value = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(value?.msg || value?.message || value?.error_description || `Supabase request failed (${response.status}).`);
  return value;
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
  if (!session?.refresh_token) throw new Error('Your Supabase session has expired. Sign in again.');
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

function remoteHolding(row) {
  return { ...row.data, id: row.id, userImage: row.user_image || row.data?.userImage || '', updatedAt: row.updated_at || row.data?.updatedAt, dirty: false };
}

function holdingRow(holding, userId) {
  const includeImage = holding.userImage && dataUrlBytes(holding.userImage) <= INLINE_IMAGE_LIMIT;
  const data = { ...holding, userImage: '' };
  return { id: holding.id, user_id: userId, data, user_image: includeImage ? holding.userImage : null, updated_at: holding.updatedAt };
}

export function remoteWatchlistItem(row) {
  const catalogRef = row.catalog_snapshot || {};
  return {
    id: row.watch_key,
    watchKey: row.watch_key,
    canonicalVariantId: row.catalog_variant_id || catalogRef.canonicalVariantId || '',
    catalogRef,
    targetPrice: row.target_price === null || row.target_price === undefined ? '' : Number(row.target_price),
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

export function watchlistRow(entry, userId, watchlistId) {
  return {
    watchlist_id: watchlistId,
    user_id: userId,
    watch_key: entry.watchKey,
    catalog_variant_id: isUUID(entry.canonicalVariantId) ? entry.canonicalVariantId : null,
    catalog_snapshot: entry.catalogRef || {},
    target_price: entry.targetPrice === '' || entry.targetPrice === null || entry.targetPrice === undefined ? null : Number(entry.targetPrice),
    alert_percent_change: entry.alertPercentChange === '' || entry.alertPercentChange === null || entry.alertPercentChange === undefined ? null : Number(entry.alertPercentChange),
    alert_trend_change: Boolean(entry.alertTrendChange),
    alert_range_change: Boolean(entry.alertRangeChange),
    alert_forecast_change: Boolean(entry.alertForecastChange),
    notes: entry.notes || '',
    created_at: entry.createdAt,
    updated_at: entry.updatedAt
  };
}

function jwtSubject(token) {
  const segment = token?.split('.')[1];
  if (!segment) throw new Error('Supabase session token is invalid. Sign in again.');
  const normalized = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  return JSON.parse(atob(padded)).sub;
}

export async function syncPortfolio() {
  const session = await validSession();
  const userId = session.user?.id || jwtSubject(session.access_token);
  const [localHoldings, localTombstones, remoteHoldingRows, remoteTombstoneRows] = await Promise.all([
    getAll('holdings'), getAll('deletions'),
    request('/rest/v1/holdings?select=id,data,user_image,updated_at', { session }),
    request('/rest/v1/holding_deletions?select=holding_id,deleted_at', { session })
  ]);
  const remoteHoldings = (remoteHoldingRows || []).map(remoteHolding);
  const remoteTombstones = (remoteTombstoneRows || []).map((row) => ({ id: row.holding_id, deletedAt: row.deleted_at, dirty: false }));
  const tombstones = mergeTombstones(localTombstones, remoteTombstones);

  if (tombstones.length) {
    await request('/rest/v1/holding_deletions?on_conflict=user_id,holding_id', { method: 'POST', session, headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: tombstones.map((entry) => ({ user_id: userId, holding_id: entry.id, deleted_at: entry.deletedAt })) });
  }

  const deletedIds = new Set(tombstones.map((entry) => entry.id));
  for (const id of deletedIds) {
    await deleteRecord('holdings', id);
    await request(`/rest/v1/holdings?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE', session, headers: { Prefer: 'return=minimal' } });
  }

  const merged = mergeHoldings(localHoldings, remoteHoldings, deletedIds);
  for (const holding of merged) await putRecord('holdings', { ...holding, dirty: false });
  if (merged.length) {
    await request('/rest/v1/holdings?on_conflict=id', { method: 'POST', session, headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: merged.map((holding) => holdingRow(holding, userId)) });
  }
  for (const tombstone of tombstones) await putRecord('deletions', { ...tombstone, dirty: false });
  await recordDailySnapshot();
  return { holdings: merged.length, deletions: tombstones.length, omittedImages: merged.filter((holding) => holding.userImage && dataUrlBytes(holding.userImage) > INLINE_IMAGE_LIMIT).length };
}

export async function syncWatchlist() {
  const session = await validSession();
  const userId = session.user?.id || jwtSubject(session.access_token);
  const watchlistId = await request('/rest/v1/rpc/get_or_create_default_watchlist', {
    method: 'POST', session, body: {}
  });
  if (!isUUID(watchlistId)) throw new Error('Cloud watchlist setup returned an invalid identifier.');

  const encodedWatchlistId = encodeURIComponent(watchlistId);
  const [localItems, localTombstones, remoteRows, remoteDeletionRows] = await Promise.all([
    getAll('watchlistItems'),
    getAll('watchlistDeletions'),
    request(`/rest/v1/watchlist_items?watchlist_id=eq.${encodedWatchlistId}&select=watch_key,catalog_variant_id,catalog_snapshot,target_price,alert_percent_change,alert_trend_change,alert_range_change,alert_forecast_change,notes,created_at,updated_at`, { session }),
    request(`/rest/v1/watchlist_deletions?watchlist_id=eq.${encodedWatchlistId}&select=watch_key,deleted_at`, { session })
  ]);

  const remoteItems = (remoteRows || []).map(remoteWatchlistItem);
  const remoteTombstones = (remoteDeletionRows || []).map((row) => ({
    id: row.watch_key, deletedAt: row.deleted_at, dirty: false
  }));
  const tombstones = mergeWatchlistTombstones(localTombstones, remoteTombstones);

  if (tombstones.length) {
    await request('/rest/v1/watchlist_deletions?on_conflict=watchlist_id,watch_key', {
      method: 'POST', session,
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: tombstones.map((entry) => ({
        watchlist_id: watchlistId,
        user_id: userId,
        watch_key: entry.id,
        deleted_at: entry.deletedAt,
        updated_at: entry.deletedAt
      }))
    });
  }

  const deletedKeys = new Set(tombstones.map((entry) => entry.id));
  for (const watchKey of deletedKeys) {
    await deleteRecord('watchlistItems', watchKey);
    await request(`/rest/v1/watchlist_items?watchlist_id=eq.${encodedWatchlistId}&watch_key=eq.${encodeURIComponent(watchKey)}`, {
      method: 'DELETE', session, headers: { Prefer: 'return=minimal' }
    });
  }

  const merged = mergeWatchlistItems(localItems, remoteItems, deletedKeys);
  for (const entry of merged) await putRecord('watchlistItems', { ...entry, dirty: false });
  if (merged.length) {
    await request('/rest/v1/watchlist_items?on_conflict=watchlist_id,watch_key', {
      method: 'POST', session,
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: merged.map((entry) => watchlistRow(entry, userId, watchlistId))
    });
  }
  for (const tombstone of tombstones) await putRecord('watchlistDeletions', { ...tombstone, dirty: false });
  return { items: merged.length, deletions: tombstones.length };
}

export async function syncAll() {
  const portfolio = await syncPortfolio();
  try {
    return { ...portfolio, watchlist: await syncWatchlist(), watchlistError: '' };
  } catch (error) {
    return { ...portfolio, watchlist: null, watchlistError: error.message || 'Watchlist sync is not available.' };
  }
}
