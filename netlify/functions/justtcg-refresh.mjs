// User-triggered ("on-demand") companion to the scheduled justtcg-catalog.mjs
// collector. Reachable only via an explicit POST from a signed-in browser
// session — there is deliberately no schedule and no custom path here.
//
// Boundary (same as the scheduled collector, see docs/JUSTTCG_ONDEMAND_REFRESH.md):
// this function never writes to Supabase, never returns price data to the
// browser, never holds an elevated Supabase credential, and never flips the
// public-intelligence publication flag. It only (a) asks Supabase to
// validate the caller's own session token, (b)
// reads that same user's own holdings/watchlist through that same token
// (Supabase's RLS does the scoping, exactly like the frontend's own
// services/supabase.js), and (c) delegates everything else to the
// on-demand orchestrator, which stores results only in the private
// 'collectfolio-justtcg-private' Blobs store.
import { getStore } from '@netlify/blobs';

import { sha256 } from '../lib/justtcg-collector.mjs';
import { createOnDemandConfig, runOnDemandRefresh } from '../lib/justtcg-ondemand-collector.mjs';
import { createJustTcgOnDemandRepository } from '../lib/justtcg-ondemand-repository.mjs';

const STORE_NAME = 'collectfolio-justtcg-private';
const HOLDINGS_LIMIT = 2_000;
const WATCHLIST_LIMIT = 2_000;
const AUTH_TIMEOUT_MS = 2_000;
const REST_TIMEOUT_MS = 2_000;

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

async function fetchJson(url, headers, timeoutMs) {
  const response = await fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`request failed with HTTP ${response.status}`);
  return response.json();
}

// Never decodes the bearer token itself — a validated user only ever comes
// from Supabase Auth's own server-side signature check via /auth/v1/user, so
// this function can key rate limits on a real identity without adding a
// JWT-verification dependency (scripts/validate.mjs pins the dependency set).
async function validatedUser(supabaseUrl, anonKey, token) {
  try {
    const user = await fetchJson(`${supabaseUrl}/auth/v1/user`, { apikey: anonKey, Authorization: `Bearer ${token}` }, AUTH_TIMEOUT_MS);
    return typeof user?.id === 'string' && user.id ? user : null;
  } catch {
    return null;
  }
}

function identityFromHolding(row) {
  const item = row?.data?.item;
  if (!item || typeof item !== 'object') return null;
  return {
    provider: item.provider,
    externalId: item.externalId,
    language: item.language,
    finish: item.finish || item.variant,
    conditionClass: row?.data?.grade ? 'graded' : 'raw',
    name: item.name,
    setName: item.setName,
    game: item.game || item.category
  };
}

function identityFromWatchlistItem(row) {
  const snapshot = row?.catalog_snapshot;
  if (!snapshot || typeof snapshot !== 'object') return null;
  return {
    provider: snapshot.provider,
    externalId: snapshot.externalId,
    language: snapshot.language,
    finish: snapshot.finish,
    conditionClass: snapshot.conditionClass,
    name: snapshot.name,
    setName: snapshot.setName,
    game: snapshot.game
  };
}

export default async (req) => {
  if (req.method !== 'POST') return jsonResponse(405, { outcome: 'method_not_allowed' });

  const authorization = req.headers.get('authorization') || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  if (!token) return jsonResponse(401, { outcome: 'unauthorized' });

  const supabaseUrl = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const anonKey = process.env.SUPABASE_ANON_KEY || '';
  if (!supabaseUrl || !anonKey) return jsonResponse(503, { outcome: 'not_configured' });

  const user = await validatedUser(supabaseUrl, anonKey, token);
  if (!user) return jsonResponse(401, { outcome: 'unauthorized' });

  const restHeaders = { apikey: anonKey, Authorization: `Bearer ${token}` };
  let holdings;
  let watchlistItems;
  try {
    [holdings, watchlistItems] = await Promise.all([
      fetchJson(`${supabaseUrl}/rest/v1/holdings?select=data&limit=${HOLDINGS_LIMIT}`, restHeaders, REST_TIMEOUT_MS),
      fetchJson(`${supabaseUrl}/rest/v1/watchlist_items?select=catalog_snapshot&limit=${WATCHLIST_LIMIT}`, restHeaders, REST_TIMEOUT_MS)
    ]);
  } catch {
    // Either request can fail this way if the token is stale/expired even
    // though /auth/v1/user briefly accepted it (a race, not a real
    // authorization decision worth surfacing differently) — treat the same
    // as unauthorized rather than a generic 500, and spend no quota.
    return jsonResponse(401, { outcome: 'unauthorized' });
  }

  const identities = [
    ...(Array.isArray(holdings) ? holdings.map(identityFromHolding).filter(Boolean) : []),
    ...(Array.isArray(watchlistItems) ? watchlistItems.map(identityFromWatchlistItem).filter(Boolean) : [])
  ];

  let refreshConfig;
  try {
    refreshConfig = createOnDemandConfig(process.env);
  } catch {
    return jsonResponse(503, { outcome: 'not_configured' });
  }

  const store = getStore({ name: STORE_NAME, consistency: 'strong' });
  const repository = createJustTcgOnDemandRepository(store, {
    collectionId: refreshConfig.collectionId,
    catalogQueryHash: refreshConfig.queryHash
  });
  const userHash = sha256(user.id);

  let result;
  try {
    result = await runOnDemandRefresh({ repository, config: refreshConfig, userHash, identities });
  } catch (error) {
    console.info('JustTCG on-demand refresh', JSON.stringify({ outcome: 'internal_error', errorCode: error?.code || 'unknown' }));
    return jsonResponse(500, { outcome: 'internal_error' });
  }

  // Literal whitelist, never a spread of the orchestrator's internal result:
  // this is the one place that decides exactly what a browser is allowed to
  // learn, and it never includes a price, a currency, or a card name.
  const responseBody = Object.freeze({
    requestId: result.requestId,
    outcome: result.outcome,
    checked: result.checked,
    eligible: result.eligible,
    fetched: result.fetched,
    alreadyFresh: result.alreadyFresh,
    needsMapping: result.needsMapping,
    deferred: result.deferred
  });

  // This is deliberately the only log record. It contains outcome/counts
  // only, never the bearer token, the JustTCG API key, request headers, raw
  // response bodies, card names, or prices.
  console.info('JustTCG on-demand refresh', JSON.stringify({
    outcome: responseBody.outcome,
    checked: responseBody.checked,
    fetched: responseBody.fetched
  }));

  return jsonResponse(200, responseBody);
};

export const config = { method: ['POST'] };
