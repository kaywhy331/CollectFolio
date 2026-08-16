const CONTRACT_VERSION = 'tcgcsv-r2-refresh-v1';
const STATUSES = new Set(['current', 'in_progress', 'update_required']);
const MAX_STATUS_BYTES = 16 * 1024;

function timestamp(value, name, { nullable = false } = {}) {
  if (nullable && (value === null || value === '')) return null;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${name} is not a valid timestamp`);
  }
  return new Date(value).toISOString();
}

export function normalizeTcgcsvRefreshStatus(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || value.contractVersion !== CONTRACT_VERSION || !STATUSES.has(value.status)) {
    throw new Error('TCGCSV refresh status is invalid');
  }
  const sourceUpdatedAt = timestamp(value.sourceUpdatedAt, 'sourceUpdatedAt');
  const lastSuccessfulSourceBuild = timestamp(
    value.lastSuccessfulSourceBuild,
    'lastSuccessfulSourceBuild',
    { nullable: true }
  );
  const lastSuccessfulAt = timestamp(value.lastSuccessfulAt, 'lastSuccessfulAt', { nullable: true });
  if (Boolean(lastSuccessfulSourceBuild) !== Boolean(lastSuccessfulAt)) {
    throw new Error('TCGCSV successful build timestamps are incomplete');
  }
  if (value.status === 'current' && lastSuccessfulSourceBuild !== sourceUpdatedAt) {
    throw new Error('TCGCSV current status does not match its successful build');
  }
  return {
    status: value.status,
    sourceUpdatedAt,
    lastSuccessfulSourceBuild,
    lastSuccessfulAt,
    error: ''
  };
}

export async function fetchTcgcsvRefreshStatus(endpoint, fetchImpl = globalThis.fetch) {
  const url = new URL(String(endpoint ?? ''));
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) {
    throw new Error('TCGCSV refresh status endpoint must use HTTPS');
  }
  const response = await fetchImpl(url, {
    headers: { accept: 'application/json' },
    cache: 'no-store',
    signal: typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(8_000) : undefined
  });
  const declared = Number.parseInt(response.headers.get('content-length') ?? '', 10);
  if (Number.isFinite(declared) && declared > MAX_STATUS_BYTES) {
    throw new Error('TCGCSV refresh status response is too large');
  }
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_STATUS_BYTES) {
    throw new Error('TCGCSV refresh status response is too large');
  }
  if (!response.ok) throw new Error(`TCGCSV refresh status failed with HTTP ${response.status}`);
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('TCGCSV refresh status returned invalid JSON');
  }
  return normalizeTcgcsvRefreshStatus(value);
}
