import { validSession } from './supabase.js';

const ENDPOINT = '/.netlify/functions/justtcg-refresh';
export const PRICE_REFRESH_TIMEOUT_MS = 20_000;

// Deliberately no client-side price display and no polling loop: the server
// response is an operational status/progress summary only — this service
// lets a signed-in collector ask that their own held/watched cards be
// prioritized in the next private research pass, not fetch a price. See
// docs/JUSTTCG_ONDEMAND_REFRESH.md for the boundary this depends on.
export async function requestPriceRefresh({ timeout = PRICE_REFRESH_TIMEOUT_MS, fetcher = globalThis.fetch } = {}) {
  let session;
  try {
    session = await validSession();
  } catch {
    throw new Error('Sign in to request a price refresh.');
  }
  const controller = new AbortController();
  const deadline = Math.max(1, Number(timeout) || PRICE_REFRESH_TIMEOUT_MS);
  const timer = setTimeout(() => controller.abort(), deadline);
  try {
    const response = await fetcher(ENDPOINT, {
      method: 'POST',
      signal: controller.signal,
      headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
      body: '{}'
    });
    let body = {};
    try { body = await response.json(); } catch (error) {
      if (error?.name === 'AbortError') throw error;
      // Fall through to the generic status message for malformed bodies.
    }
    if (!response.ok && response.status !== 401) {
      throw new Error(refreshOutcomeMessage(body.outcome, body) || `Price refresh request failed (${response.status}).`);
    }
    return { ...body, message: refreshOutcomeMessage(body.outcome, body) };
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw Object.assign(new Error('Price refresh request timed out. Try again.'), { name: 'TimeoutError' });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function refreshOutcomeMessage(outcome, counts = {}) {
  switch (outcome) {
    case 'ok': {
      const parts = [];
      if (counts.fetched) parts.push(`${counts.fetched} card${counts.fetched === 1 ? '' : 's'} queued for the next research pass`);
      if (counts.alreadyFresh) parts.push(`${counts.alreadyFresh} already recent`);
      if (counts.needsMapping) parts.push(`${counts.needsMapping} still need identity mapping`);
      return parts.length ? parts.join('; ') : 'Checked your cards; nothing new to queue right now.';
    }
    case 'no_eligible_cards':
      return counts.needsMapping
        ? `Checked your cards; ${counts.needsMapping} still need identity mapping before they can be prioritized.`
        : 'Checked your cards; nothing needs a refresh right now.';
    case 'busy':
      return 'A refresh for one of your cards is already in progress. Try again shortly.';
    case 'quota_deferred':
      return 'The shared private research budget is low right now. Try again later.';
    case 'unauthorized':
      return 'Sign in to request a price refresh.';
    case 'not_configured':
      return 'Price refresh is not configured for this deployment.';
    default:
      return 'Price refresh request could not be completed.';
  }
}
