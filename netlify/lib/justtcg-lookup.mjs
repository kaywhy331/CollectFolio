// JustTCG POST /cards adapter for the on-demand, identity-driven lookup path.
// This module knows nothing about storage, quota, or eligibility — it only
// builds a bounded request and validates the response envelope. Storage lives
// in justtcg-ondemand-repository.mjs; orchestration lives in
// justtcg-ondemand-collector.mjs. Keeping the adapter separate from storage
// means a future operator-reviewed promotion path can reuse this exact
// request/response contract unchanged.
import {
  cleanString,
  isObject,
  JustTcgRequestError,
  normalizePlan,
  parseRetryAfter,
  readBoundedResponse,
  safeProviderCode
} from './justtcg-http.mjs';
import { CollectorContractError, JUSTTCG_CARDS_URL, sha256 } from './justtcg-collector.mjs';

// Matches the Free-tier POST /cards batch cap the collector doc already
// documents (docs/JUSTTCG_CATALOG_COLLECTOR.md): "on Free it accepts up to 20
// lookup items". A paid plan raises this, but this on-demand path stays on
// the same conservative Free-tier assumption as the rest of this repo until
// an operator explicitly changes it.
export const JUSTTCG_LOOKUP_BATCH_LIMIT = 20;
export const JUSTTCG_LOOKUP_NORMALIZATION_VERSION = 'justtcg-ondemand-v1';
export const JUSTTCG_LOOKUP_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const JUSTTCG_LOOKUP_TIMEOUT_MS = 6 * 1_000;
// Distinct from both the scheduled crawl's User-Agent and the Python
// production adapter's, so all three JustTCG code paths are distinguishable
// in provider-side logs.
export const JUSTTCG_LOOKUP_USER_AGENT = 'CollectFolio/0.1 private on-demand JustTCG lookup';

// Identifier precedence per JustTCG's documented POST /cards contract:
// variantId > tcgplayerSkuId > tcgplayerId > mtgjsonId > scryfallId > cardId.
// One identifier field per item.
export const JUSTTCG_IDENTIFIER_FIELDS = Object.freeze([
  'variantId', 'tcgplayerSkuId', 'tcgplayerId', 'mtgjsonId', 'scryfallId', 'cardId'
]);
const IDENTIFIER_FIELD_SET = new Set(JUSTTCG_IDENTIFIER_FIELDS);

export class LookupConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LookupConfigError';
  }
}

// items: [{ field: 'cardId'|'variantId'|..., value, condition?, printing? }]
// Returns the bare JSON array JustTCG's POST /cards expects (not wrapped in
// an { items: [...] } object) — confirmed against the provider's own SDK
// example, which passes a plain array to client.cards.batch([...]).
export function buildLookupBody(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new LookupConfigError('items must be a non-empty array');
  }
  if (items.length > JUSTTCG_LOOKUP_BATCH_LIMIT) {
    throw new LookupConfigError(`items must not exceed ${JUSTTCG_LOOKUP_BATCH_LIMIT} per batch`);
  }
  return items.map((item, index) => {
    if (!isObject(item)) throw new LookupConfigError(`items[${index}] must be an object`);
    const field = cleanString(item.field);
    if (!IDENTIFIER_FIELD_SET.has(field)) {
      throw new LookupConfigError(`items[${index}].field must be one of ${JUSTTCG_IDENTIFIER_FIELDS.join(', ')}`);
    }
    const value = cleanString(item.value);
    if (!value || value.length > 200) {
      throw new LookupConfigError(`items[${index}].value must be a non-empty identifier`);
    }
    const entry = { [field]: value };
    const condition = cleanString(item.condition);
    if (condition) entry.condition = condition;
    const printing = cleanString(item.printing);
    if (printing) entry.printing = printing;
    return entry;
  });
}

export async function fetchJustTcgLookup({ config, items, fetchImpl = globalThis.fetch, now = new Date() }) {
  if (typeof fetchImpl !== 'function') throw new LookupConfigError('fetch implementation is required');
  const body = buildLookupBody(items);
  let response;
  try {
    response = await fetchImpl(JUSTTCG_CARDS_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': JUSTTCG_LOOKUP_USER_AGENT,
        'X-API-Key': config.apiKey
      },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(JUSTTCG_LOOKUP_TIMEOUT_MS)
    });
  } catch {
    throw new JustTcgRequestError(
      'ambiguous_request',
      'JustTCG lookup failed before a response was available',
      { retryable: true }
    );
  }

  const text = await readBoundedResponse(response, JUSTTCG_LOOKUP_MAX_RESPONSE_BYTES);
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new JustTcgRequestError('invalid_json', 'JustTCG lookup response was not valid JSON');
  }

  if (!response.ok) {
    const providerCode = safeProviderCode(payload);
    const retryAfterMs = parseRetryAfter(response.headers?.get?.('retry-after'), now.getTime());
    const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
    throw new JustTcgRequestError(
      providerCode === 'EXCESSIVE_FREE_TIER_USAGE' ? 'excessive_free_tier_usage' : `http_${response.status}`,
      `JustTCG lookup failed with HTTP ${response.status}`,
      { status: response.status, providerCode, retryAfterMs, retryable }
    );
  }
  return payload;
}

function integer(value, name) {
  if (!Number.isSafeInteger(value)) {
    throw new CollectorContractError('invalid_lookup_metadata', `${name} must be an integer`);
  }
  return value;
}

// Deliberately does NOT assert meta.total/offset/hasMore consistency the way
// the crawl's validatePage() does for GET /cards: JustTCG's own POST /cards
// documentation reuses the GET pagination-envelope example verbatim, so those
// fields are unverified in practice for a fixed-identifier batch and must not
// become a false-failure source here.
export function validateLookup(payload, { requestedCount, config }) {
  if (!isObject(payload) || !Array.isArray(payload.data) || !isObject(payload._metadata)) {
    throw new CollectorContractError('invalid_envelope', 'JustTCG lookup response envelope is incomplete');
  }
  if (payload.data.length > requestedCount) {
    throw new CollectorContractError('oversized_lookup_response', 'JustTCG returned more cards than requested');
  }

  const cardIds = payload.data.map((card, index) => {
    if (!isObject(card)) throw new CollectorContractError('invalid_card', `data[${index}] must be an object`);
    const id = cleanString(card.id);
    if (!id || id.length > 120) {
      throw new CollectorContractError('invalid_card_id', `data[${index}].id must be a stable identifier`);
    }
    return id;
  });
  if (new Set(cardIds).size !== cardIds.length) {
    throw new CollectorContractError('duplicate_card_in_lookup', 'JustTCG returned duplicate card IDs in one lookup');
  }

  const apiPlan = cleanString(payload._metadata.apiPlan);
  if (config && normalizePlan(apiPlan) !== config.normalizedExpectedPlan) {
    throw new CollectorContractError(
      'plan_mismatch',
      `JustTCG reported plan ${apiPlan || '(missing)'}; expected ${config.expectedPlan}`
    );
  }
  const apiRequestsRemaining = integer(payload._metadata.apiRequestsRemaining, '_metadata.apiRequestsRemaining');

  return Object.freeze({
    apiPlan,
    apiRequestsRemaining,
    cardIds,
    dataHash: sha256(payload.data),
    payloadHash: sha256(payload)
  });
}
