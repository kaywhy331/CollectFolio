import { validSession } from './supabase.js';

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_IMAGE_DATA_URL_LENGTH = 2_800_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
// card_lookup_busy retries are free server-side (no quota unit is deducted
// for a 503 rejection), so a small bounded number of silent retries costs
// the collector nothing but time.
const MAX_BUSY_RETRIES = 2;
const DEFAULT_BUSY_RETRY_SECONDS = 5;
const MAX_BUSY_RETRY_SECONDS = 15;

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runtimeConfig() {
  return globalThis.window?.COLLECTFOLIO_CONFIG || {};
}

export function collectCaptureBaseUrl(configuration = runtimeConfig()) {
  if (configuration.ENABLE_COLLECTCAPTURE !== true) {
    throw new Error("CollectCapture card lookup isn't available yet.");
  }
  const configured = String(configuration.COLLECTCAPTURE_API_URL || '').trim();
  if (!configured) throw new Error('CollectCapture card lookup is not configured.');
  let url;
  try {
    url = new URL(configured);
  } catch {
    throw new Error('The CollectCapture API URL is invalid.');
  }
  const loopbackHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !loopbackHttp) {
    throw new Error('CollectCapture must use HTTPS.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('The CollectCapture API URL must not include credentials, a query, or a fragment.');
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}

export function isCollectCaptureConfigured(configuration = runtimeConfig()) {
  try {
    collectCaptureBaseUrl(configuration);
    return true;
  } catch {
    return false;
  }
}

export function cardRecognitionMode(configuration = runtimeConfig()) {
  if (isCollectCaptureConfigured(configuration)) return 'collectcapture';
  if (configuration.ENABLE_LOCAL_SCAN_ROLLBACK === true) return 'local';
  return 'unavailable';
}

export class CollectCaptureLookupError extends Error {
  constructor(message, { status = 0, code = 'collectcapture_error' } = {}) {
    super(message);
    this.name = 'CollectCaptureLookupError';
    this.status = status;
    this.code = code;
  }
}

export async function lookupCardWithCollectCapture({
  imageDataUrl,
  query = '',
  category = 'all',
  limit = 12,
  textOnly = false
} = {}, {
  configuration = runtimeConfig(),
  session,
  fetchImpl = globalThis.fetch,
  timeout = REQUEST_TIMEOUT_MS,
  sleepImpl = defaultSleep
} = {}) {
  const normalizedQuery = String(query || '').trim().slice(0, 240);
  // PR #12: imageDataUrl is optional when the caller explicitly opts into a
  // text-only refinement AND supplies a non-empty query -- otherwise this is
  // the original image-carrying request shape, unchanged.
  const useTextOnly = Boolean(textOnly);
  if (useTextOnly && !normalizedQuery) {
    throw new CollectCaptureLookupError('Enter a name, set, or number to search without a new photo.', {
      code: 'missing_query'
    });
  }
  let image = '';
  if (!useTextOnly) {
    image = String(imageDataUrl || '');
    if (image.length > MAX_IMAGE_DATA_URL_LENGTH) {
      throw new CollectCaptureLookupError('The cropped card image is too large for CollectCapture.', {
        status: 413,
        code: 'media_too_large'
      });
    }
    if (!/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(image)) {
      throw new CollectCaptureLookupError('The cropped card image is not a supported JPEG, PNG, or WebP image.', {
        code: 'invalid_card_image'
      });
    }
  }
  let activeSession = session;
  if (!String(activeSession?.access_token || '').trim()) {
    try {
      activeSession = await validSession();
    } catch {
      throw new CollectCaptureLookupError('Sign in to identify cards with CollectCapture.', {
        status: 401,
        code: 'unauthorized'
      });
    }
  }
  const url = new URL('v1/card-lookups', collectCaptureBaseUrl(configuration));
  const accessToken = String(activeSession.access_token || '').trim();
  if (!accessToken || /\s/.test(accessToken)) {
    throw new CollectCaptureLookupError('Sign in again to identify cards with CollectCapture.', {
      status: 401,
      code: 'unauthorized'
    });
  }
  const normalizedCategory = ['all', 'pokemon', 'magic', 'yugioh', 'other'].includes(category) ? category : 'all';
  const normalizedLimit = Math.max(1, Math.min(24, Math.trunc(Number(limit)) || 12));
  const expectedContentSha256 = useTextOnly ? null : await imageContentSha256(image);
  const requestBody = {
    ...(useTextOnly ? {} : { imageDataUrl: image }),
    query: normalizedQuery,
    category: normalizedCategory,
    limit: normalizedLimit
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, Number(timeout) || REQUEST_TIMEOUT_MS));
  try {
    let response;
    let payload;
    let busyRetries = 0;
    while (true) {
      response = await fetchImpl(url, {
        method: 'POST',
        signal: controller.signal,
        cache: 'no-store',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify(requestBody)
      });
      const text = await readBoundedResponseText(response);
      try {
        payload = text ? JSON.parse(text) : {};
      } catch {
        throw new CollectCaptureLookupError('CollectCapture returned invalid JSON.', {
          status: 502,
          code: 'invalid_response'
        });
      }
      if (response.ok) break;
      const failure = responseError(response.status, payload, response.headers);
      if (response.status === 503 && failure.code === 'card_lookup_busy' && busyRetries < MAX_BUSY_RETRIES) {
        // Busy retries never burn a quota unit (see MAX_BUSY_RETRIES comment
        // above) -- retry silently before surfacing anything to the collector.
        busyRetries += 1;
        await sleepImpl(busyRetryDelayMs(response.headers.get('retry-after')));
        continue;
      }
      throw failure;
    }
    if (!String(response.headers.get('content-type') || '').toLowerCase().includes('application/json')) {
      throw invalidResponse();
    }
    const result = normalizeCollectCaptureLookup(payload?.lookup, { textOnly: useTextOnly });
    if (!useTextOnly && result.contentSha256 !== expectedContentSha256) throw invalidResponse();
    if (result.candidates.length > normalizedLimit) throw invalidResponse();
    if (normalizedQuery
      ? result.recognition.source !== 'user_query' || result.recognition.queries[0] !== normalizedQuery
      : result.recognition.source !== 'vision') throw invalidResponse();
    return { ...result, rateLimit: parseRateLimitHeaders(response.headers) };
  } catch (error) {
    if (error instanceof CollectCaptureLookupError) throw error;
    if (error?.name === 'AbortError') {
      throw new CollectCaptureLookupError('CollectCapture took too long to identify this card. Retry when the connection is stable.', {
        status: 408,
        code: 'timeout'
      });
    }
    throw new CollectCaptureLookupError('CollectCapture could not be reached. Check your connection and retry.', {
      code: 'network_error'
    });
  } finally {
    clearTimeout(timer);
  }
}

// Retry-After: default 5s when the header is absent or not a usable positive
// number, capped at 15s regardless of what the server asks for.
function busyRetryDelayMs(headerValue) {
  const parsed = Number(headerValue);
  const seconds = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_BUSY_RETRY_SECONDS;
  return Math.min(seconds, MAX_BUSY_RETRY_SECONDS) * 1000;
}

function parseRateLimitHeaderValue(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) && Number.isInteger(value) && value >= 0 ? value : null;
}

function parseRateLimitHeaders(headers) {
  return {
    limit: parseRateLimitHeaderValue(headers.get('x-ratelimit-limit')),
    remaining: parseRateLimitHeaderValue(headers.get('x-ratelimit-remaining')),
    reset: parseRateLimitHeaderValue(headers.get('x-ratelimit-reset'))
  };
}

async function imageContentSha256(dataUrl) {
  if (!globalThis.crypto?.subtle || typeof globalThis.atob !== 'function') {
    throw new CollectCaptureLookupError('This browser cannot securely verify CollectCapture responses.', {
      code: 'integrity_unavailable'
    });
  }
  try {
    const encoded = dataUrl.slice(dataUrl.indexOf(',') + 1);
    const binary = globalThis.atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  } catch (error) {
    if (error instanceof CollectCaptureLookupError) throw error;
    throw new CollectCaptureLookupError('This browser could not verify the CollectCapture request.', {
      code: 'integrity_unavailable'
    });
  }
}

export function normalizeCollectCaptureLookup(value, { textOnly = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidResponse();
  // Text-only refinements never submit an image, so the server returns
  // contentSha256: null exactly -- image-carrying responses keep the
  // original strict 64-hex requirement, byte-for-byte unchanged.
  const contentSha256Valid = textOnly
    ? value.contentSha256 === null
    : typeof value.contentSha256 === 'string' && /^[a-f0-9]{64}$/.test(value.contentSha256);
  if (value.imageRetained !== false || !contentSha256Valid) {
    throw invalidResponse();
  }
  const recognition = normalizeRecognition(value.recognition);
  if (!Array.isArray(value.candidates) || value.candidates.length > 24) throw invalidResponse();
  const candidates = value.candidates.map(normalizeCandidate);
  if (new Set(candidates.map((candidate) => candidate.externalId)).size !== candidates.length) throw invalidResponse();
  if (!Array.isArray(value.warnings) || value.warnings.length > 10) throw invalidResponse();
  const warnings = value.warnings.map((warning) => requiredString(warning, 1, 500));
  return {
    contentSha256: value.contentSha256,
    imageRetained: false,
    recognition,
    candidates,
    warnings
  };
}

function normalizeRecognition(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidResponse();
  if (!['vision', 'user_query'].includes(value.source)) throw invalidResponse();
  if (!['pokemon', 'magic', 'yugioh', 'other'].includes(value.category)) throw invalidResponse();
  if (!Array.isArray(value.queries) || !value.queries.length || value.queries.length > 6) throw invalidResponse();
  if (!Array.isArray(value.visibleText) || value.visibleText.length > 30) throw invalidResponse();
  return {
    source: value.source,
    category: value.category,
    name: nullableString(value.name, 160),
    setName: nullableString(value.setName, 160),
    collectorNumber: nullableString(value.collectorNumber, 80),
    language: requiredString(value.language, 2, 35),
    visibleText: value.visibleText.map((entry) => requiredString(entry, 1, 240)),
    queries: value.queries.map((query) => requiredString(query, 2, 240)),
    confidence: requiredConfidence(value.confidence),
    provider: requiredString(value.provider, 1, 80),
    model: requiredString(value.model, 1, 160)
  };
}

function normalizeCandidate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidResponse();
  const categoryId = positiveInteger(value.categoryId);
  const groupId = positiveInteger(value.groupId);
  const productId = positiveInteger(value.productId);
  const externalId = requiredString(value.externalId, 1, 160);
  if (
    value.provider !== 'tcgcsv'
    || value.matchBucket !== 'likely'
    || !categoryId
    || !groupId
    || !productId
    || externalId !== `${categoryId}:${groupId}:${productId}`
  ) {
    throw invalidResponse();
  }
  if (value.price !== null
    || !Array.isArray(value.priceOptions)
    || value.priceOptions.length
    || value.currency !== 'USD'
    || value.priceSource !== ''
    || value.priceUrl !== ''
    || value.priceUpdatedAt !== '') throw invalidResponse();
  requiredString(value.id, 1, 240);
  const image = safeRemoteImage(value.image);
  const imageSmall = safeRemoteImage(value.imageSmall) || image;
  return {
    id: `tcgcsv:${externalId}`,
    externalId,
    provider: 'tcgcsv',
    category: requiredString(value.category, 1, 80),
    game: requiredString(value.game, 1, 120),
    name: requiredString(value.name, 1, 240),
    setName: optionalString(value.setName, 240),
    setCode: optionalString(value.setCode, 80),
    number: optionalString(value.number, 80),
    variant: optionalString(value.variant, 160),
    rarity: optionalString(value.rarity, 160),
    year: optionalString(value.year, 20),
    image,
    imageSmall,
    price: null,
    priceOptions: [],
    currency: 'USD',
    priceSource: '',
    priceUrl: '',
    priceUpdatedAt: '',
    matchBucket: 'likely',
    matchScore: requiredConfidence(value.matchScore),
    categoryId,
    groupId,
    productId
  };
}

// Q4 ruling (Kevin, 2026-08-27): the 30/hour ceiling is sustained, so a
// binder session will genuinely hit 429 -- the copy must say when the
// window resets. x-ratelimit-reset may be epoch seconds or seconds-from-now
// depending on the server build; values above ~1e9 are clearly epochs.
function quotaResetPhrase(headers) {
  if (!headers || typeof headers.get !== 'function') return '';
  const reset = Number.parseInt(headers.get('x-ratelimit-reset') || '', 10);
  const retryAfter = Number.parseInt(headers.get('retry-after') || '', 10);
  let seconds = null;
  if (Number.isFinite(reset) && reset > 0) {
    seconds = reset > 1_000_000_000 ? Math.round(reset - (Date.now() / 1000)) : reset;
  } else if (Number.isFinite(retryAfter) && retryAfter > 0) {
    seconds = retryAfter;
  }
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 90) return ' Scans reset in about a minute.';
  return ` Scans reset in about ${Math.max(2, Math.round(seconds / 60))} minutes.`;
}

function responseError(status, payload, headers = null) {
  const code = boundedErrorString(payload?.error, 'request_failed', 80);
  if (status === 401) return new CollectCaptureLookupError('Sign in again to identify cards with CollectCapture.', { status, code });
  if (status === 413) return new CollectCaptureLookupError('The cropped card image is too large for CollectCapture.', { status, code });
  if (status === 429) return new CollectCaptureLookupError(`CollectCapture has reached its lookup limit.${quotaResetPhrase(headers) || ' Wait and retry.'}`, { status, code });
  if (status === 502) {
    // card_recognition_timeout / card_recognition_unavailable are retryable;
    // card_recognition_misconfigured / card_recognition_invalid_output are
    // not -- the collector should report those instead of retrying.
    if (code === 'card_recognition_timeout') {
      return new CollectCaptureLookupError('Card lookup took too long. Retry in a moment.', { status, code });
    }
    if (code === 'card_recognition_unavailable') {
      return new CollectCaptureLookupError('Card lookup is temporarily unavailable. Retry in a moment.', { status, code });
    }
    if (code === 'card_recognition_misconfigured' || code === 'card_recognition_invalid_output') {
      return new CollectCaptureLookupError('Card lookup needs attention on the scanner side. Report this if it keeps happening.', { status, code });
    }
    return new CollectCaptureLookupError(
      boundedErrorString(payload?.message, `CollectCapture lookup failed with HTTP ${status}.`, 500),
      { status, code }
    );
  }
  if (status === 503) {
    if (code === 'card_lookup_busy') {
      return new CollectCaptureLookupError('Scanner is busy — trying again shortly.', { status, code });
    }
    // The user's own session is fine here -- their box just can't reach
    // Supabase to verify it, so this must never suggest signing in again.
    if (code === 'authentication_unavailable') {
      return new CollectCaptureLookupError("Card lookup can't verify sign-ins right now. Your session is fine — try again in a moment.", { status, code });
    }
    return new CollectCaptureLookupError('CollectCapture card lookup is temporarily unavailable.', { status, code });
  }
  return new CollectCaptureLookupError(
    boundedErrorString(payload?.message, `CollectCapture lookup failed with HTTP ${status}.`, 500),
    { status, code }
  );
}

async function readBoundedResponseText(response) {
  const declared = Number.parseInt(response.headers.get('content-length') || '', 10);
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw oversizedResponse();
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) throw oversizedResponse();
    return text;
  }
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value || 0);
      total += chunk.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel('response_too_large').catch(() => {});
        throw oversizedResponse();
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock?.();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function oversizedResponse() {
  return new CollectCaptureLookupError('CollectCapture returned an oversized response.', {
    status: 502,
    code: 'response_too_large'
  });
}

function safeRemoteImage(value) {
  if (typeof value !== 'string') throw invalidResponse();
  if (!value) return '';
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : '';
  } catch {
    return '';
  }
}

function boundedErrorString(value, fallback, maximum) {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maximum) : fallback;
}

function positiveInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function requiredString(value, minimum, maximum) {
  if (typeof value !== 'string') throw invalidResponse();
  const normalized = value.trim();
  if (normalized.length < minimum || normalized.length > maximum) throw invalidResponse();
  return normalized;
}

function optionalString(value, maximum) {
  if (typeof value !== 'string') throw invalidResponse();
  const normalized = value.trim();
  if (normalized.length > maximum) throw invalidResponse();
  return normalized;
}

function nullableString(value, maximum) {
  return value === null ? null : requiredString(value, 1, maximum);
}

function requiredConfidence(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw invalidResponse();
  }
  return value;
}

function invalidResponse() {
  return new CollectCaptureLookupError('CollectCapture returned an invalid card lookup response.', {
    status: 502,
    code: 'invalid_response'
  });
}
