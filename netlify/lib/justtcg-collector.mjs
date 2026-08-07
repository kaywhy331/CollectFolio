import { createHash, randomUUID } from 'node:crypto';

import {
  cleanString,
  isObject,
  JustTcgRequestError,
  normalizePlan,
  parseRetryAfter,
  readBoundedResponse,
  safeProviderCode
} from './justtcg-http.mjs';

export { JustTcgRequestError };

export const JUSTTCG_CARDS_URL = 'https://api.justtcg.com/v1/cards';
export const JUSTTCG_PAGE_LIMIT = 20;
export const JUSTTCG_DAILY_REQUEST_LIMIT = 100;
export const JUSTTCG_COLLECTION_REQUEST_LIMIT = 1_000;
export const JUSTTCG_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const JUSTTCG_SCHEDULE = '*/5 * * * *';

const STATE_SCHEMA_VERSION = 1;
const BLOOM_BYTES = 32 * 1024;
const BLOOM_HASHES = 8;
const LEASE_MS = 2 * 60 * 1_000;
const REQUEST_TIMEOUT_MS = 15 * 1_000;
const RECENT_HASH_LIMIT = 32;
const GAME_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const COLLECTION_ID = /^[a-z0-9]+(?:[a-z0-9._-]*[a-z0-9])?$/i;

export class CollectorConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CollectorConfigError';
  }
}

export class CollectorContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CollectorContractError';
    this.code = code;
  }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

export function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

export function sha256(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : stableJson(value)).digest('hex');
}

export function createCollectorConfig(environment = process.env) {
  const apiKey = cleanString(environment.JUSTTCG_API_KEY);
  if (!apiKey) throw new CollectorConfigError('JUSTTCG_API_KEY is required');

  const game = cleanString(environment.JUSTTCG_GAME).toLowerCase();
  if (game && (!GAME_ID.test(game) || game.length > 80)) {
    throw new CollectorConfigError('JUSTTCG_GAME must be a stable JustTCG game ID such as pokemon');
  }

  const collectionId = cleanString(environment.JUSTTCG_COLLECTION_ID) || 'catalog-v1';
  if (!COLLECTION_ID.test(collectionId) || collectionId.length > 80) {
    throw new CollectorConfigError('JUSTTCG_COLLECTION_ID must be a short stable identifier');
  }

  const expectedPlan = cleanString(environment.JUSTTCG_EXPECTED_PLAN) || 'Free';
  if (!normalizePlan(expectedPlan) || expectedPlan.length > 40) {
    throw new CollectorConfigError('JUSTTCG_EXPECTED_PLAN must be a short plan name');
  }

  // The API has no stable-ID sort. An explicit price-descending order makes the
  // quota-bounded subset useful and keeps the query contract from silently
  // changing, while page/card hashes expose drift during the multi-day crawl.
  const query = Object.freeze({
    ...(game ? { game } : {}),
    include_null_prices: false,
    include_price_history: true,
    include_statistics: '7d,30d,90d,allTime',
    limit: JUSTTCG_PAGE_LIMIT,
    order: 'desc',
    orderBy: 'price',
    priceHistoryDuration: '1y'
  });
  const persistedConfig = Object.freeze({
    collectionId,
    expectedPlan,
    maxCollectionRequests: JUSTTCG_COLLECTION_REQUEST_LIMIT,
    maxDailyRequests: JUSTTCG_DAILY_REQUEST_LIMIT,
    query
  });

  return Object.freeze({
    apiKey,
    collectionId,
    expectedPlan,
    normalizedExpectedPlan: normalizePlan(expectedPlan),
    maxCollectionRequests: JUSTTCG_COLLECTION_REQUEST_LIMIT,
    maxDailyRequests: JUSTTCG_DAILY_REQUEST_LIMIT,
    query,
    queryHash: sha256(persistedConfig),
    requestTimeoutMs: REQUEST_TIMEOUT_MS
  });
}

export function buildCardsUrl(query, offset) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset % JUSTTCG_PAGE_LIMIT !== 0) {
    throw new CollectorConfigError('offset must be a non-negative multiple of 20');
  }
  const url = new URL(JUSTTCG_CARDS_URL);
  for (const [key, value] of Object.entries({ ...query, offset }).sort(([left], [right]) => left.localeCompare(right))) {
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

export async function fetchJustTcgPage({ config, offset, fetchImpl = globalThis.fetch, now = new Date() }) {
  if (typeof fetchImpl !== 'function') throw new CollectorConfigError('fetch implementation is required');
  const url = buildCardsUrl(config.query, offset);
  let response;
  try {
    response = await fetchImpl(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'CollectFolio/0.1 private JustTCG catalog research',
        'X-API-Key': config.apiKey
      },
      redirect: 'error',
      signal: AbortSignal.timeout(config.requestTimeoutMs)
    });
  } catch {
    throw new JustTcgRequestError(
      'ambiguous_request',
      'JustTCG request failed before a response was available',
      { retryable: true }
    );
  }

  const text = await readBoundedResponse(response, JUSTTCG_MAX_RESPONSE_BYTES);
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new JustTcgRequestError('invalid_json', 'JustTCG response was not valid JSON');
  }

  if (!response.ok) {
    const providerCode = safeProviderCode(payload);
    const retryAfterMs = parseRetryAfter(response.headers?.get?.('retry-after'), now.getTime());
    const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
    throw new JustTcgRequestError(
      providerCode === 'EXCESSIVE_FREE_TIER_USAGE' ? 'excessive_free_tier_usage' : `http_${response.status}`,
      `JustTCG request failed with HTTP ${response.status}`,
      { status: response.status, providerCode, retryAfterMs, retryable }
    );
  }
  return payload;
}

function integer(value, name, { minimum = 0 } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new CollectorContractError('invalid_pagination_metadata', `${name} must be an integer of at least ${minimum}`);
  }
  return value;
}

function cardId(card, index) {
  if (!isObject(card)) throw new CollectorContractError('invalid_card', `data[${index}] must be an object`);
  const id = cleanString(card.id);
  if (!id || id.length > 120) {
    throw new CollectorContractError('invalid_card_id', `data[${index}].id must be a stable identifier`);
  }
  return id;
}

export function validatePage(payload, { config, requestedOffset }) {
  if (!isObject(payload) || !Array.isArray(payload.data) || !isObject(payload.meta) || !isObject(payload._metadata)) {
    throw new CollectorContractError('invalid_envelope', 'JustTCG response envelope is incomplete');
  }
  const total = integer(payload.meta.total, 'meta.total');
  const limit = integer(payload.meta.limit, 'meta.limit', { minimum: 1 });
  const offset = integer(payload.meta.offset, 'meta.offset');
  if (limit !== JUSTTCG_PAGE_LIMIT || offset !== requestedOffset) {
    throw new CollectorContractError('pagination_mismatch', 'JustTCG pagination metadata does not match the request');
  }
  if (typeof payload.meta.hasMore !== 'boolean') {
    throw new CollectorContractError('invalid_has_more', 'meta.hasMore must be boolean');
  }
  if (payload.data.length > limit) {
    throw new CollectorContractError('oversized_page', 'JustTCG returned more than 20 cards');
  }
  if (payload.meta.hasMore && payload.data.length !== limit) {
    throw new CollectorContractError('short_page', 'JustTCG returned a short page while meta.hasMore is true');
  }
  const covered = offset + payload.data.length;
  if (payload.meta.hasMore && covered >= total) {
    throw new CollectorContractError('invalid_has_more', 'meta.hasMore conflicts with meta.total');
  }
  if (!payload.meta.hasMore && covered < total) {
    throw new CollectorContractError('invalid_has_more', 'meta.hasMore ended before meta.total');
  }

  const ids = payload.data.map(cardId);
  if (new Set(ids).size !== ids.length) {
    throw new CollectorContractError('duplicate_card_in_page', 'JustTCG returned duplicate card IDs in one page');
  }

  const apiPlan = cleanString(payload._metadata.apiPlan);
  if (normalizePlan(apiPlan) !== config.normalizedExpectedPlan) {
    throw new CollectorContractError(
      'plan_mismatch',
      `JustTCG reported plan ${apiPlan || '(missing)'}; expected ${config.expectedPlan}`
    );
  }
  const apiRequestsRemaining = integer(
    payload._metadata.apiRequestsRemaining,
    '_metadata.apiRequestsRemaining'
  );

  return Object.freeze({
    apiPlan,
    apiRequestsRemaining,
    cardIds: ids,
    dataHash: sha256(payload.data),
    hasMore: payload.meta.hasMore,
    limit,
    offset,
    payloadHash: sha256(payload),
    total
  });
}

function utcDay(now) {
  return now.toISOString().slice(0, 10);
}

function nextUtcDay(now) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();
}

function emptyBloom() {
  return Buffer.alloc(BLOOM_BYTES).toString('base64');
}

function updateBloom(encoded, ids) {
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.byteLength !== BLOOM_BYTES) {
    throw new CollectorContractError('invalid_state_bloom', 'collector state has an invalid card-ID bloom filter');
  }
  const bitCount = BLOOM_BYTES * 8;
  let newlyObserved = 0;
  for (const id of ids) {
    const digest = createHash('sha256').update(id).digest();
    let alreadyPresent = true;
    const indexes = [];
    for (let index = 0; index < BLOOM_HASHES; index += 1) {
      const bit = digest.readUInt32BE(index * 4) % bitCount;
      indexes.push(bit);
      if ((bytes[bit >> 3] & (1 << (bit & 7))) === 0) alreadyPresent = false;
    }
    for (const bit of indexes) bytes[bit >> 3] |= 1 << (bit & 7);
    if (!alreadyPresent) newlyObserved += 1;
  }
  return { encoded: bytes.toString('base64'), newlyObserved };
}

export function createInitialState(config, now = new Date()) {
  const at = now.toISOString();
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    collectionId: config.collectionId,
    queryHash: config.queryHash,
    query: config.query,
    expectedPlan: config.expectedPlan,
    status: 'collecting',
    nextOffset: 0,
    pageCount: 0,
    cardRecordCount: 0,
    approximateUniqueCardCount: 0,
    cardIdBloom: emptyBloom(),
    initialTotal: null,
    latestTotal: null,
    totalChanges: 0,
    recentDataHashes: [],
    quota: {
      maxDailyRequests: config.maxDailyRequests,
      maxCollectionRequests: config.maxCollectionRequests,
      utcDay: utcDay(now),
      dailyAttempts: 0,
      dailySuccesses: 0,
      totalAttempts: 0,
      totalSuccesses: 0,
      apiRequestsRemaining: null
    },
    retry: {
      consecutiveFailures: 0,
      notBefore: null,
      ambiguousAttempts: 0
    },
    lease: null,
    lastError: null,
    startedAt: at,
    updatedAt: at,
    completedAt: null
  };
}

function assertStateCompatible(state, config) {
  if (!isObject(state) || state.schemaVersion !== STATE_SCHEMA_VERSION) {
    throw new CollectorContractError('invalid_state', 'collector state schema is invalid');
  }
  if (state.collectionId !== config.collectionId || state.queryHash !== config.queryHash) {
    throw new CollectorContractError('state_query_mismatch', 'collector state belongs to a different query');
  }
  if (stableJson(state.query) !== stableJson(config.query) || state.expectedPlan !== config.expectedPlan) {
    throw new CollectorContractError('state_config_mismatch', 'collector state configuration changed');
  }
  if (
    state.quota?.maxDailyRequests !== config.maxDailyRequests ||
    state.quota?.maxCollectionRequests !== config.maxCollectionRequests ||
    !Number.isSafeInteger(state.nextOffset) ||
    state.nextOffset < 0 ||
    state.nextOffset % JUSTTCG_PAGE_LIMIT !== 0
  ) {
    throw new CollectorContractError('invalid_state', 'collector state quota or offset is invalid');
  }
}

function withoutExpiredLease(state, now) {
  if (!state.lease) return state;
  const expiresAt = Date.parse(state.lease.expiresAt);
  if (Number.isFinite(expiresAt) && expiresAt > now.getTime()) return null;
  return { ...state, lease: null };
}

function withCurrentDay(state, now) {
  const day = utcDay(now);
  if (state.quota.utcDay === day) return state;
  return {
    ...state,
    quota: { ...state.quota, utcDay: day, dailyAttempts: 0, dailySuccesses: 0 }
  };
}

function retryDelayMs(state, error, random) {
  const failures = Math.min(10, (state.retry?.consecutiveFailures || 0) + 1);
  const exponential = Math.min(6 * 60 * 60 * 1_000, 60_000 * (2 ** (failures - 1)));
  const floor = Math.max(exponential, error.retryAfterMs || 0);
  return floor + Math.floor(floor * 0.25 * random());
}

function safeError(error, state, now, random) {
  const isRequest = error instanceof JustTcgRequestError;
  const isContract = error instanceof CollectorContractError;
  const excessive = isRequest && error.code === 'excessive_free_tier_usage';
  const authFailure = isRequest && (error.status === 401 || error.status === 403);
  const retryable = isRequest && error.retryable && !excessive && !authFailure;
  const exhausted = state.quota.totalAttempts >= state.quota.maxCollectionRequests;
  const code = isRequest || isContract ? error.code : 'collector_failure';
  const delay = retryable && !exhausted ? retryDelayMs(state, error, random) : 0;
  return {
    ...state,
    status: exhausted ? 'quota_exhausted' : (retryable ? 'collecting' : 'blocked'),
    lease: null,
    retry: {
      consecutiveFailures: (state.retry?.consecutiveFailures || 0) + 1,
      notBefore: delay ? new Date(now.getTime() + delay).toISOString() : null,
      ambiguousAttempts: (state.retry?.ambiguousAttempts || 0) + (code === 'ambiguous_request' ? 1 : 0)
    },
    lastError: {
      at: now.toISOString(),
      code,
      httpStatus: isRequest ? error.status : 0,
      providerCode: isRequest ? error.providerCode : '',
      requestedOffset: state.nextOffset
    },
    updatedAt: now.toISOString(),
    completedAt: exhausted ? now.toISOString() : null
  };
}

function pageRecord(payload, normalized, config, now) {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    collectionId: config.collectionId,
    queryHash: config.queryHash,
    requestedOffset: normalized.offset,
    retrievedAt: now.toISOString(),
    dataHash: normalized.dataHash,
    payloadHash: normalized.payloadHash,
    response: payload
  };
}

function finalizePage(state, record, normalized, now) {
  if (state.recentDataHashes.includes(normalized.dataHash)) {
    throw new CollectorContractError('repeated_page', 'JustTCG repeated a previously stored card page');
  }
  const bloom = updateBloom(state.cardIdBloom, normalized.cardIds);
  const initialTotal = state.initialTotal === null ? normalized.total : state.initialTotal;
  const totalChanged = state.latestTotal !== null && state.latestTotal !== normalized.total;
  const quota = {
    ...state.quota,
    dailySuccesses: state.quota.dailySuccesses + 1,
    totalSuccesses: state.quota.totalSuccesses + 1,
    apiRequestsRemaining: normalized.apiRequestsRemaining
  };
  let status = 'collecting';
  if (!normalized.hasMore) status = 'complete';
  else if (
    quota.totalAttempts >= quota.maxCollectionRequests ||
    normalized.apiRequestsRemaining === 0
  ) status = 'quota_exhausted';
  const terminal = status === 'complete' || status === 'quota_exhausted';
  return {
    ...state,
    status,
    // Keep the durable cursor aligned to the API page size even on a short
    // terminal page. Terminal invocations never request this offset, but the
    // invariant makes completed state safe to validate after a redeploy.
    nextOffset: normalized.offset + normalized.limit,
    pageCount: state.pageCount + 1,
    cardRecordCount: state.cardRecordCount + normalized.cardIds.length,
    approximateUniqueCardCount: state.approximateUniqueCardCount + bloom.newlyObserved,
    cardIdBloom: bloom.encoded,
    initialTotal,
    latestTotal: normalized.total,
    totalChanges: state.totalChanges + (totalChanged ? 1 : 0),
    recentDataHashes: [...state.recentDataHashes, normalized.dataHash].slice(-RECENT_HASH_LIMIT),
    quota,
    retry: { consecutiveFailures: 0, notBefore: null, ambiguousAttempts: state.retry.ambiguousAttempts },
    lease: null,
    lastError: null,
    updatedAt: now.toISOString(),
    completedAt: terminal ? now.toISOString() : null,
    lastPage: {
      offset: normalized.offset,
      dataHash: record.dataHash,
      payloadHash: record.payloadHash,
      retrievedAt: record.retrievedAt
    }
  };
}

function summary(outcome, state, extra = {}) {
  return {
    outcome,
    status: state.status,
    nextOffset: state.nextOffset,
    pageCount: state.pageCount,
    cardRecordCount: state.cardRecordCount,
    approximateUniqueCardCount: state.approximateUniqueCardCount,
    dailyAttempts: state.quota.dailyAttempts,
    totalAttempts: state.quota.totalAttempts,
    apiRequestsRemaining: state.quota.apiRequestsRemaining,
    ...extra
  };
}

async function persistFailure(repository, state, etag, error, now, random) {
  const failed = safeError(error, state, now, random);
  const write = await repository.saveState(failed, etag);
  if (!write.modified) return summary('concurrent_state_change', state);
  return summary(failed.status === 'blocked' ? 'blocked' : 'request_deferred', failed, {
    errorCode: failed.lastError.code,
    notBefore: failed.retry.notBefore
  });
}

export async function runCollectorInvocation({
  repository,
  config,
  fetchPage = ({ offset }) => fetchJustTcgPage({ config, offset }),
  now = () => new Date(),
  random = Math.random,
  leaseId = randomUUID
}) {
  const instant = now();
  if (!(instant instanceof Date) || !Number.isFinite(instant.getTime())) {
    throw new CollectorConfigError('now must return a valid Date');
  }

  let entry = await repository.loadState();
  if (!entry) {
    const initial = createInitialState(config, instant);
    const created = await repository.saveState(initial, null);
    if (!created.modified) return summary('concurrent_state_change', initial);
    entry = { state: initial, etag: created.etag };
  }
  assertStateCompatible(entry.state, config);

  let state = withoutExpiredLease(entry.state, instant);
  if (state === null) return summary('lease_active', entry.state);
  state = withCurrentDay(state, instant);

  if (state.status !== 'collecting') return summary('terminal', state);
  if (state.retry.notBefore && Date.parse(state.retry.notBefore) > instant.getTime()) {
    return summary('retry_backoff', state, { notBefore: state.retry.notBefore });
  }
  if (state.quota.apiRequestsRemaining === 0 || state.quota.totalAttempts >= state.quota.maxCollectionRequests) {
    const exhausted = { ...state, status: 'quota_exhausted', completedAt: instant.toISOString(), updatedAt: instant.toISOString() };
    const write = await repository.saveState(exhausted, entry.etag);
    return summary(write.modified ? 'collection_quota_exhausted' : 'concurrent_state_change', write.modified ? exhausted : state);
  }
  if (state.quota.dailyAttempts >= state.quota.maxDailyRequests) {
    return summary('daily_quota_exhausted', state, { nextEligibleAt: nextUtcDay(instant) });
  }

  const stored = await repository.loadPage(state.nextOffset);
  if (stored) {
    try {
      if (
        stored.queryHash !== config.queryHash ||
        stored.requestedOffset !== state.nextOffset ||
        state.quota.totalAttempts <= state.quota.totalSuccesses
      ) {
        throw new CollectorContractError('orphaned_page', 'stored page cannot be reconciled with collector state');
      }
      const normalized = validatePage(stored.response, { config, requestedOffset: state.nextOffset });
      if (stored.dataHash !== normalized.dataHash || stored.payloadHash !== normalized.payloadHash) {
        throw new CollectorContractError('stored_page_hash_mismatch', 'stored page hash does not match its response');
      }
      const reconciled = finalizePage(state, stored, normalized, instant);
      const write = await repository.saveState(reconciled, entry.etag);
      return summary(write.modified ? 'page_reconciled' : 'concurrent_state_change', write.modified ? reconciled : state);
    } catch (error) {
      return persistFailure(repository, state, entry.etag, error, instant, random);
    }
  }

  const reserved = {
    ...state,
    quota: {
      ...state.quota,
      dailyAttempts: state.quota.dailyAttempts + 1,
      totalAttempts: state.quota.totalAttempts + 1
    },
    lease: {
      id: leaseId(),
      acquiredAt: instant.toISOString(),
      expiresAt: new Date(instant.getTime() + LEASE_MS).toISOString()
    },
    updatedAt: instant.toISOString()
  };
  const reservation = await repository.saveState(reserved, entry.etag);
  if (!reservation.modified) return summary('concurrent_state_change', state);

  let payload;
  let normalized;
  try {
    payload = await fetchPage({ offset: reserved.nextOffset, config });
    normalized = validatePage(payload, { config, requestedOffset: reserved.nextOffset });
    if (reserved.recentDataHashes.includes(normalized.dataHash)) {
      throw new CollectorContractError('repeated_page', 'JustTCG repeated a previously stored card page');
    }
  } catch (error) {
    return persistFailure(repository, reserved, reservation.etag, error, instant, random);
  }

  let record = pageRecord(payload, normalized, config, instant);
  const pageWrite = await repository.savePage(record);
  if (!pageWrite.modified) {
    const existing = await repository.loadPage(reserved.nextOffset);
    if (!existing || existing.payloadHash !== record.payloadHash) {
      return persistFailure(
        repository,
        reserved,
        reservation.etag,
        new CollectorContractError('page_write_conflict', 'a different response already exists for this offset'),
        instant,
        random
      );
    }
    record = existing;
  }

  try {
    const completed = finalizePage(reserved, record, normalized, instant);
    const write = await repository.saveState(completed, reservation.etag);
    return summary(write.modified ? 'page_stored' : 'page_pending_reconciliation', write.modified ? completed : reserved);
  } catch (error) {
    return persistFailure(repository, reserved, reservation.etag, error, instant, random);
  }
}
