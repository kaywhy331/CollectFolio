import { dataUrlBytes } from '../core/utils.js';
import { deleteRecord, getAll, putRecord, recordDailySnapshot } from '../core/db.js';

const SESSION_KEY = 'collectfolio:supabase-session';
const INLINE_IMAGE_LIMIT = 180 * 1024;

function config() {
  return globalThis.window?.COLLECTFOLIO_CONFIG || {};
}

export function isSupabaseConfigured() {
  return Boolean(config().SUPABASE_URL && config().SUPABASE_ANON_KEY);
}

function requireConfig() {
  if (!isSupabaseConfigured()) throw new Error('Supabase public-key configuration is not enabled.');
  return { url: String(config().SUPABASE_URL).replace(/\/$/, ''), key: config().SUPABASE_ANON_KEY };
}

async function request(path, { method = 'GET', body, session, headers = {} } = {}) {
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
