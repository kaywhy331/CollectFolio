// Low-level JustTCG HTTP helpers shared by the scheduled catalog crawl
// (justtcg-collector.mjs) and the on-demand lookup adapter
// (justtcg-lookup.mjs). This module has no knowledge of storage, quota, or
// either caller's contract semantics — it only parses HTTP-level provider
// responses safely.

export function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export class JustTcgRequestError extends Error {
  constructor(code, message, { status = 0, providerCode = '', retryAfterMs = 0, retryable = false } = {}) {
    super(message);
    this.name = 'JustTcgRequestError';
    this.code = code;
    this.status = status;
    this.providerCode = providerCode;
    this.retryAfterMs = retryAfterMs;
    this.retryable = retryable;
  }
}

export function parseRetryAfter(value, nowMs) {
  const raw = cleanString(value);
  if (!raw) return 0;
  if (/^\d+(?:\.\d+)?$/.test(raw)) return Math.max(0, Math.ceil(Number(raw) * 1_000));
  const instant = Date.parse(raw);
  return Number.isFinite(instant) ? Math.max(0, instant - nowMs) : 0;
}

// Shared so both the crawl's plan-mismatch check and the on-demand lookup's
// plan-mismatch check normalize a provider-reported plan name identically.
export function normalizePlan(value) {
  return cleanString(value).toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function safeProviderCode(payload) {
  const candidate = cleanString(payload?.code || payload?.error?.code || payload?.errorCode);
  return /^[A-Z0-9_-]{1,80}$/i.test(candidate) ? candidate : '';
}

// maxBytes is caller-supplied (rather than a module constant) so both the
// crawl and the lookup adapter can share this reader with their own bounds.
export async function readBoundedResponse(response, maxBytes) {
  const declared = cleanString(response.headers?.get?.('content-length'));
  if (declared) {
    const declaredSize = Number(declared);
    if (!Number.isSafeInteger(declaredSize) || declaredSize < 0) {
      throw new JustTcgRequestError('invalid_content_length', 'JustTCG returned an invalid content length');
    }
    if (declaredSize > maxBytes) {
      throw new JustTcgRequestError('response_too_large', 'JustTCG response exceeded the size limit');
    }
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) {
    throw new JustTcgRequestError('response_too_large', 'JustTCG response exceeded the size limit');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new JustTcgRequestError('invalid_utf8', 'JustTCG response was not valid UTF-8');
  }
}
