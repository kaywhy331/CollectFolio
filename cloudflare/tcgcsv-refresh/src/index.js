import {
  catalogPublicationStatus,
  cleanupStaleCatalogPublications,
  completeCatalogPublication,
  failCatalogPublication,
  handleCatalogRequest,
  planCatalogPublication,
  uploadCatalogAsset
} from './catalog.js';

const CONTRACT_VERSION = 'tcgcsv-r2-refresh-v1';
const CLAIM_KEY = 'coordination/claim.json';
const MARKER_NAME = 'complete.json';
const DEFAULT_LEASE_MINUTES = 90;
const MAX_CONTROL_BYTES = 64 * 1024;
const SOURCE_TIMESTAMP = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;
const SHA256 = /^[0-9a-f]{64}$/;
const RUN_ID = /^[0-9a-f-]{16,64}$/i;

export const ARTIFACTS = Object.freeze({
  raw_archive: Object.freeze({
    path: 'raw/prices.ppmd.7z',
    maximumBytes: 64 * 1024 * 1024,
    contentType: 'application/x-7z-compressed'
  }),
  prices_parquet: Object.freeze({
    path: 'history/prices.parquet',
    maximumBytes: 96 * 1024 * 1024,
    contentType: 'application/vnd.apache.parquet'
  }),
  market_features_gzip: Object.freeze({
    path: 'features/market-features.csv.gz',
    maximumBytes: 96 * 1024 * 1024,
    contentType: 'text/csv; charset=utf-8',
    contentEncoding: 'gzip'
  }),
  set_features: Object.freeze({
    path: 'features/set-features.csv',
    maximumBytes: 8 * 1024 * 1024,
    contentType: 'text/csv; charset=utf-8'
  }),
  archive_packet: Object.freeze({
    path: 'receipts/archive-packet.json',
    maximumBytes: 8 * 1024 * 1024,
    contentType: 'application/json'
  }),
  catalog_packet_gzip: Object.freeze({
    path: 'catalog/catalog-packet.json.gz',
    maximumBytes: 96 * 1024 * 1024,
    contentType: 'application/json',
    contentEncoding: 'gzip'
  })
});

const REQUIRED_ARTIFACT_IDS = Object.freeze(Object.keys(ARTIFACTS));

function jsonResponse(value, init = {}) {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store');
  headers.set('x-content-type-options', 'nosniff');
  return Response.json(value, { ...init, headers });
}

function errorMessage(error) {
  return error instanceof Error ? error.message : 'Unknown error';
}

function parsePositiveInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}

export function parseSourceUpdatedAt(value) {
  const source = String(value ?? '').trim();
  const match = SOURCE_TIMESTAMP.exec(source);
  if (!match) throw new Error('TCGCSV source timestamp is invalid');
  const normalizedOffset = /[+-]\d{4}$/.test(source)
    ? `${source.slice(0, -2)}:${source.slice(-2)}`
    : source;
  const epoch = Date.parse(normalizedOffset);
  if (!Number.isFinite(epoch)) throw new Error('TCGCSV source timestamp is invalid');
  return {
    archiveDate: match[1],
    sourceUpdatedAt: new Date(epoch).toISOString()
  };
}

export function slotForArchiveDate(archiveDate) {
  const epoch = Date.parse(`${archiveDate}T00:00:00.000Z`);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString().slice(0, 10) !== archiveDate) {
    throw new Error('Archive date is invalid');
  }
  return Math.floor(epoch / 86_400_000) % 2;
}

export function artifactKey(slot, artifactId, runId) {
  const artifact = ARTIFACTS[artifactId];
  if ((slot !== 0 && slot !== 1) || !artifact || !RUN_ID.test(runId ?? '')) {
    throw new Error('Artifact identity is invalid');
  }
  return `runs/${runId}/slot-${slot}/${artifact.path}`;
}

function markerKey(slot) {
  if (slot !== 0 && slot !== 1) throw new Error('Slot is invalid');
  return `slots/${slot}/${MARKER_NAME}`;
}

async function boundedText(response, maximumBytes) {
  const declared = Number.parseInt(response.headers.get('content-length') ?? '', 10);
  if (Number.isFinite(declared) && declared > maximumBytes) {
    throw new Error('Response exceeds its size limit');
  }
  const value = await response.text();
  if (new TextEncoder().encode(value).byteLength > maximumBytes) {
    throw new Error('Response exceeds its size limit');
  }
  return value;
}

export async function fetchSourceBuild(env, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(env.SOURCE_UPDATED_URL, {
    headers: {
      accept: 'text/plain',
      'user-agent': env.TCGCSV_USER_AGENT
    },
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error(`TCGCSV source check failed with HTTP ${response.status}`);
  return parseSourceUpdatedAt(await boundedText(response, 256));
}

async function readJsonObject(bucket, key) {
  const object = await bucket.get(key);
  if (!object) return null;
  if (object.size > MAX_CONTROL_BYTES) throw new Error(`Control object ${key} exceeds its size limit`);
  const text = await object.text();
  const value = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Control object ${key} is invalid`);
  }
  return { object, value };
}

async function readMarkers(bucket) {
  const records = await Promise.all([0, 1].map(async (slot) => {
    const record = await readJsonObject(bucket, markerKey(slot));
    return record ? { slot, ...record.value } : null;
  }));
  return records.filter(Boolean);
}

function latestMarker(markers) {
  return [...markers].sort((left, right) => {
    const sourceDifference = Date.parse(right.sourceUpdatedAt) - Date.parse(left.sourceUpdatedAt);
    if (sourceDifference) return sourceDifference;
    return Date.parse(right.completedAt) - Date.parse(left.completedAt);
  })[0] ?? null;
}

function claimIsActive(claim, sourceUpdatedAt, now) {
  return claim?.contractVersion === CONTRACT_VERSION
    && ['running', 'sealing'].includes(claim?.status)
    && claim?.sourceUpdatedAt === sourceUpdatedAt
    && Number.isFinite(Date.parse(claim?.expiresAt))
    && Date.parse(claim.expiresAt) > now.getTime();
}

export async function evaluateRefresh(env, options = {}) {
  const now = options.now ?? new Date();
  const source = await fetchSourceBuild(env, options.fetchImpl);
  const [markers, claimRecord] = await Promise.all([
    readMarkers(env.TCGCSV_CURRENT),
    readJsonObject(env.TCGCSV_CURRENT, CLAIM_KEY)
  ]);
  const matchingMarker = markers.find((marker) => marker.sourceUpdatedAt === source.sourceUpdatedAt) ?? null;
  const latest = latestMarker(markers);
  const activeClaim = claimIsActive(claimRecord?.value, source.sourceUpdatedAt, now)
    ? claimRecord.value
    : null;
  return {
    contractVersion: CONTRACT_VERSION,
    action: matchingMarker ? 'current' : activeClaim ? 'in_progress' : 'update_required',
    archiveDate: source.archiveDate,
    sourceUpdatedAt: source.sourceUpdatedAt,
    slot: slotForArchiveDate(source.archiveDate),
    lastSuccess: latest ? {
      archiveDate: latest.archiveDate,
      sourceUpdatedAt: latest.sourceUpdatedAt,
      completedAt: latest.completedAt
    } : null,
    activeRun: activeClaim ? {
      runId: activeClaim.runId,
      claimedAt: activeClaim.claimedAt,
      expiresAt: activeClaim.expiresAt
    } : null
  };
}

function claimPutCondition(record) {
  if (record) return { etagMatches: record.object.etag };
  return new Headers({ 'if-none-match': '*' });
}

export async function claimRefresh(env, options = {}) {
  const now = options.now ?? new Date();
  const state = await evaluateRefresh(env, { ...options, now });
  if (state.action !== 'update_required') return { ...state, started: false };

  const existing = await readJsonObject(env.TCGCSV_CURRENT, CLAIM_KEY);
  if (claimIsActive(existing?.value, state.sourceUpdatedAt, now)) {
    return { ...state, action: 'in_progress', started: false };
  }
  const leaseMinutes = parsePositiveInteger(
    env.LEASE_MINUTES,
    DEFAULT_LEASE_MINUTES,
    15,
    180
  );
  const runId = options.idFactory ? options.idFactory() : crypto.randomUUID();
  const claim = {
    contractVersion: CONTRACT_VERSION,
    status: 'running',
    runId,
    archiveDate: state.archiveDate,
    sourceUpdatedAt: state.sourceUpdatedAt,
    slot: state.slot,
    claimedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + leaseMinutes * 60_000).toISOString()
  };
  const stored = await env.TCGCSV_CURRENT.put(CLAIM_KEY, JSON.stringify(claim), {
    onlyIf: claimPutCondition(existing),
    httpMetadata: { contentType: 'application/json' },
    customMetadata: { contractVersion: CONTRACT_VERSION, sourceUpdatedAt: state.sourceUpdatedAt }
  });
  if (!stored) {
    const refreshed = await evaluateRefresh(env, { ...options, now });
    return { ...refreshed, action: 'in_progress', started: false };
  }
  return {
    ...state,
    action: 'run',
    started: true,
    runId,
    expiresAt: claim.expiresAt,
    artifacts: Object.fromEntries(REQUIRED_ARTIFACT_IDS.map((artifactId) => [
      artifactId,
      { maximumBytes: ARTIFACTS[artifactId].maximumBytes }
    ]))
  };
}

async function sha256Bytes(value) {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
}

export async function verifyBearerToken(request, expected) {
  const authorization = request.headers.get('authorization') ?? '';
  const provided = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  const [providedHash, expectedHash] = await Promise.all([
    sha256Bytes(provided),
    sha256Bytes(String(expected ?? ''))
  ]);
  if (typeof crypto.subtle.timingSafeEqual === 'function') {
    return crypto.subtle.timingSafeEqual(providedHash, expectedHash);
  }
  const left = new Uint8Array(providedHash);
  const right = new Uint8Array(expectedHash);
  let difference = left.length ^ right.length;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

async function requireActiveClaim(env, runId, sourceUpdatedAt, slot, now = new Date()) {
  const claimRecord = await readJsonObject(env.TCGCSV_CURRENT, CLAIM_KEY);
  const claim = claimRecord?.value;
  if (!claimIsActive(claim, sourceUpdatedAt, now)
      || claim.runId !== runId
      || claim.slot !== slot) {
    throw new Error('Refresh claim is absent, expired, or does not match');
  }
  return claimRecord;
}

function artifactRequestIdentity(request) {
  const url = new URL(request.url);
  const artifactId = decodeURIComponent(url.pathname.slice('/v1/artifacts/'.length));
  const artifact = ARTIFACTS[artifactId];
  const slot = Number.parseInt(url.searchParams.get('slot') ?? '', 10);
  const sourceUpdatedAt = url.searchParams.get('source_updated_at') ?? '';
  const runId = url.searchParams.get('run_id') ?? '';
  if (!artifact || (slot !== 0 && slot !== 1) || !SOURCE_TIMESTAMP.test(sourceUpdatedAt)
      || !RUN_ID.test(runId)) {
    throw new Error('Artifact request identity is invalid');
  }
  return {
    artifact,
    artifactId,
    slot,
    sourceUpdatedAt: parseSourceUpdatedAt(sourceUpdatedAt).sourceUpdatedAt,
    runId,
    key: artifactKey(slot, artifactId, runId)
  };
}

export async function uploadArtifact(request, env, options = {}) {
  const identity = artifactRequestIdentity(request);
  await requireActiveClaim(
    env,
    identity.runId,
    identity.sourceUpdatedAt,
    identity.slot,
    options.now
  );
  const declaredBytes = Number.parseInt(request.headers.get('content-length') ?? '', 10);
  if (!Number.isSafeInteger(declaredBytes) || declaredBytes <= 0
      || declaredBytes > identity.artifact.maximumBytes) {
    throw new Error('Artifact content length is absent or outside its limit');
  }
  const sha256 = (request.headers.get('x-content-sha256') ?? '').toLowerCase();
  if (!SHA256.test(sha256) || !request.body) throw new Error('Artifact SHA-256 or body is invalid');
  const stored = await env.TCGCSV_CURRENT.put(identity.key, request.body, {
    sha256,
    httpMetadata: {
      contentType: identity.artifact.contentType,
      ...(identity.artifact.contentEncoding
        ? { contentEncoding: identity.artifact.contentEncoding }
        : {})
    },
    customMetadata: {
      contractVersion: CONTRACT_VERSION,
      artifactId: identity.artifactId,
      runId: identity.runId,
      sourceUpdatedAt: identity.sourceUpdatedAt,
      sha256
    }
  });
  if (!stored || stored.size !== declaredBytes) throw new Error('R2 artifact size verification failed');
  return {
    artifactId: identity.artifactId,
    bytes: stored.size,
    sha256
  };
}

export async function downloadArtifact(request, env) {
  const identity = artifactRequestIdentity(request);
  const markerRecord = await readJsonObject(env.TCGCSV_CURRENT, markerKey(identity.slot));
  const marker = markerRecord?.value;
  const receipt = marker?.artifacts?.[identity.artifactId];
  if (!marker || !RUN_ID.test(marker.runId ?? '') || !receipt) {
    return new Response(null, { status: 404 });
  }
  const key = artifactKey(identity.slot, identity.artifactId, marker.runId);
  if (receipt.key !== key || !SHA256.test(receipt.sha256 ?? '')) {
    throw new Error('Published artifact marker is invalid');
  }
  const object = await env.TCGCSV_CURRENT.get(key);
  if (!object) return new Response(null, { status: 404 });
  if (object.size !== receipt.bytes
      || object.customMetadata?.sha256 !== receipt.sha256
      || object.customMetadata?.runId !== marker.runId
      || object.customMetadata?.sourceUpdatedAt !== marker.sourceUpdatedAt) {
    throw new Error('Published artifact does not match its marker');
  }
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  // Coordinator downloads must preserve the stored bytes for SHA-256 checks;
  // describing a .gz object as HTTP content-encoded would make clients decode it.
  headers.delete('content-encoding');
  headers.set('content-length', String(object.size));
  headers.set('cache-control', 'private, no-store');
  headers.set('x-content-type-options', 'nosniff');
  if (object.customMetadata?.sha256) headers.set('x-content-sha256', object.customMetadata.sha256);
  return new Response(object.body, { headers });
}

async function boundedJsonRequest(request) {
  const declared = Number.parseInt(request.headers.get('content-length') ?? '', 10);
  if (Number.isFinite(declared) && declared > MAX_CONTROL_BYTES) {
    throw new Error('Control request exceeds its size limit');
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_CONTROL_BYTES) {
    throw new Error('Control request exceeds its size limit');
  }
  const value = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Control request must be an object');
  }
  return value;
}

function validateCompletionPayload(payload) {
  const slot = payload.slot;
  const source = parseSourceUpdatedAt(payload.sourceUpdatedAt);
  if ((slot !== 0 && slot !== 1) || slotForArchiveDate(source.archiveDate) !== slot
      || !RUN_ID.test(payload.runId ?? '')
      || !payload.artifacts || typeof payload.artifacts !== 'object'
      || Array.isArray(payload.artifacts)) {
    throw new Error('Completion identity is invalid');
  }
  for (const artifactId of REQUIRED_ARTIFACT_IDS) {
    const artifact = payload.artifacts[artifactId];
    if (!artifact || !SHA256.test(artifact.sha256 ?? '')
        || !Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0) {
      throw new Error(`Completion receipt for ${artifactId} is invalid`);
    }
  }
  if (Object.keys(payload.artifacts).sort().join(',') !== [...REQUIRED_ARTIFACT_IDS].sort().join(',')) {
    throw new Error('Completion receipt contains an unexpected artifact');
  }
  return { ...payload, sourceUpdatedAt: source.sourceUpdatedAt };
}

export async function completeRefresh(request, env, options = {}) {
  const now = options.now ?? new Date();
  const payload = validateCompletionPayload(await boundedJsonRequest(request));
  const claimRecord = await requireActiveClaim(
    env,
    payload.runId,
    payload.sourceUpdatedAt,
    payload.slot,
    now
  );
  if (claimRecord.value.status !== 'running') throw new Error('Refresh claim is already sealing');
  const currentSource = await fetchSourceBuild(env, options.fetchImpl);
  if (currentSource.sourceUpdatedAt !== payload.sourceUpdatedAt) {
    throw new Error('TCGCSV changed before completion; the run cannot be sealed');
  }
  const verifiedArtifacts = {};
  for (const artifactId of REQUIRED_ARTIFACT_IDS) {
    const expected = payload.artifacts[artifactId];
    const key = artifactKey(payload.slot, artifactId, payload.runId);
    const object = await env.TCGCSV_CURRENT.head(key);
    if (!object || object.size !== expected.bytes
        || object.customMetadata?.sha256 !== expected.sha256
        || object.customMetadata?.runId !== payload.runId
        || object.customMetadata?.sourceUpdatedAt !== payload.sourceUpdatedAt) {
      throw new Error(`R2 artifact ${artifactId} does not match its completion receipt`);
    }
    verifiedArtifacts[artifactId] = {
      key,
      bytes: object.size,
      sha256: expected.sha256
    };
  }
  const minimumSealingExpiry = now.getTime() + 15 * 60_000;
  const sealingClaim = {
    ...claimRecord.value,
    status: 'sealing',
    sealingAt: now.toISOString(),
    expiresAt: new Date(Math.max(
      Date.parse(claimRecord.value.expiresAt),
      minimumSealingExpiry
    )).toISOString()
  };
  const sealingObject = await env.TCGCSV_CURRENT.put(CLAIM_KEY, JSON.stringify(sealingClaim), {
    onlyIf: { etagMatches: claimRecord.object.etag },
    httpMetadata: { contentType: 'application/json' },
    customMetadata: { contractVersion: CONTRACT_VERSION, sourceUpdatedAt: payload.sourceUpdatedAt }
  });
  if (!sealingObject) throw new Error('Refresh claim changed before sealing');

  const previousMarker = await readJsonObject(env.TCGCSV_CURRENT, markerKey(payload.slot));
  const marker = {
    contractVersion: CONTRACT_VERSION,
    archiveDate: currentSource.archiveDate,
    sourceUpdatedAt: payload.sourceUpdatedAt,
    slot: payload.slot,
    runId: payload.runId,
    completedAt: now.toISOString(),
    artifacts: verifiedArtifacts
  };
  await env.TCGCSV_CURRENT.put(markerKey(payload.slot), JSON.stringify(marker), {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: {
      contractVersion: CONTRACT_VERSION,
      sourceUpdatedAt: payload.sourceUpdatedAt,
      runId: payload.runId
    }
  });
  const completedClaim = await env.TCGCSV_CURRENT.put(CLAIM_KEY, JSON.stringify({
    ...sealingClaim,
    status: 'complete',
    completedAt: marker.completedAt,
    expiresAt: marker.completedAt
  }), {
    onlyIf: { etagMatches: sealingObject.etag },
    httpMetadata: { contentType: 'application/json' },
    customMetadata: { contractVersion: CONTRACT_VERSION, sourceUpdatedAt: payload.sourceUpdatedAt }
  });
  if (!completedClaim) throw new Error('Refresh claim changed before completion');

  if (previousMarker?.value?.runId && previousMarker.value.runId !== marker.runId) {
    try {
      await env.TCGCSV_CURRENT.delete(REQUIRED_ARTIFACT_IDS.map((artifactId) =>
        artifactKey(payload.slot, artifactId, previousMarker.value.runId)));
    } catch (error) {
      console.error(JSON.stringify({
        event: 'tcgcsv_refresh_prior_slot_cleanup_failed',
        slot: payload.slot,
        error: errorMessage(error)
      }));
    }
  }
  return {
    ...marker,
    artifacts: Object.fromEntries(Object.entries(marker.artifacts).map(([artifactId, artifact]) => [
      artifactId,
      { bytes: artifact.bytes, sha256: artifact.sha256 }
    ]))
  };
}

export async function failRefresh(request, env, options = {}) {
  const now = options.now ?? new Date();
  const payload = await boundedJsonRequest(request);
  const source = parseSourceUpdatedAt(payload.sourceUpdatedAt);
  const claimRecord = await requireActiveClaim(env, payload.runId, source.sourceUpdatedAt, payload.slot, now);
  const failure = {
    ...claimRecord.value,
    status: 'failed',
    failedAt: now.toISOString(),
    expiresAt: now.toISOString(),
    errorCode: String(payload.errorCode ?? 'workflow_failed').slice(0, 80)
  };
  const stored = await env.TCGCSV_CURRENT.put(CLAIM_KEY, JSON.stringify(failure), {
    onlyIf: { etagMatches: claimRecord.object.etag },
    httpMetadata: { contentType: 'application/json' },
    customMetadata: { contractVersion: CONTRACT_VERSION, sourceUpdatedAt: source.sourceUpdatedAt }
  });
  if (!stored) throw new Error('Refresh claim changed before failure release');
  try {
    await env.TCGCSV_CURRENT.delete(REQUIRED_ARTIFACT_IDS.map((artifactId) =>
      artifactKey(payload.slot, artifactId, payload.runId)));
  } catch (error) {
    console.error(JSON.stringify({
      event: 'tcgcsv_refresh_failed_run_cleanup_failed',
      runId: payload.runId,
      error: errorMessage(error)
    }));
  }
  return failure;
}

async function cleanupStaleRunArtifacts(env, now = new Date()) {
  const [markers, claimRecord] = await Promise.all([
    readMarkers(env.TCGCSV_CURRENT),
    readJsonObject(env.TCGCSV_CURRENT, CLAIM_KEY)
  ]);
  const retained = new Set();
  for (const marker of markers) {
    if (!RUN_ID.test(marker.runId ?? '') || (marker.slot !== 0 && marker.slot !== 1)) continue;
    for (const artifactId of REQUIRED_ARTIFACT_IDS) {
      retained.add(artifactKey(marker.slot, artifactId, marker.runId));
    }
  }
  const claim = claimRecord?.value;
  if (claimIsActive(claim, claim?.sourceUpdatedAt, now)
      && RUN_ID.test(claim.runId ?? '') && (claim.slot === 0 || claim.slot === 1)) {
    for (const artifactId of REQUIRED_ARTIFACT_IDS) {
      retained.add(artifactKey(claim.slot, artifactId, claim.runId));
    }
  }

  const cutoff = now.getTime() - 4 * 60 * 60_000;
  const stale = [];
  let cursor;
  do {
    const page = await env.TCGCSV_CURRENT.list({ prefix: 'runs/', limit: 1000, cursor });
    stale.push(...page.objects
      .filter((object) => !retained.has(object.key) && object.uploaded.getTime() < cutoff)
      .map((object) => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  for (let start = 0; start < stale.length; start += 1000) {
    await env.TCGCSV_CURRENT.delete(stale.slice(start, start + 1000));
  }
  return stale.length;
}

export function publicRefreshStatus(state) {
  return {
    contractVersion: state.contractVersion,
    status: state.action,
    sourceUpdatedAt: state.sourceUpdatedAt,
    lastSuccessfulSourceBuild: state.lastSuccess?.sourceUpdatedAt ?? null,
    lastSuccessfulAt: state.lastSuccess?.completedAt ?? null
  };
}

function corsHeaders(request, env) {
  const origin = request.headers.get('origin');
  return origin && origin === env.ALLOWED_ORIGIN
    ? { 'access-control-allow-origin': origin, vary: 'Origin' }
    : {};
}

async function authenticated(request, env) {
  return Boolean(env.COORDINATOR_TOKEN)
    && await verifyBearerToken(request, env.COORDINATOR_TOKEN);
}

async function handleRequest(request, env) {
  const url = new URL(request.url);
  if (request.method === 'GET' && url.pathname === '/health') {
    return jsonResponse({ status: 'ok', contractVersion: CONTRACT_VERSION });
  }
  if (request.method === 'GET' && url.pathname === '/status') {
    return jsonResponse(publicRefreshStatus(await evaluateRefresh(env)), {
      headers: corsHeaders(request, env)
    });
  }
  if (url.pathname.startsWith('/catalog/')) {
    return handleCatalogRequest(request, env);
  }
  if (!url.pathname.startsWith('/v1/') || !await authenticated(request, env)) {
    return jsonResponse({ error: 'Unauthorized' }, { status: 401 });
  }
  if (request.method === 'POST' && url.pathname === '/v1/claim') {
    const result = await claimRefresh(env);
    return jsonResponse(result, { status: result.started ? 201 : 200 });
  }
  if (request.method === 'GET' && url.pathname === '/v1/catalog/status') {
    return jsonResponse(await catalogPublicationStatus(env));
  }
  if (request.method === 'POST' && url.pathname === '/v1/catalog/plan') {
    const result = await planCatalogPublication(request, env);
    return jsonResponse(result, { status: result.started ? 201 : 200 });
  }
  if (url.pathname.startsWith('/v1/catalog/assets/') && request.method === 'PUT') {
    return jsonResponse(await uploadCatalogAsset(request, env), { status: 201 });
  }
  if (request.method === 'POST' && url.pathname === '/v1/catalog/complete') {
    return jsonResponse(await completeCatalogPublication(request, env));
  }
  if (request.method === 'POST' && url.pathname === '/v1/catalog/fail') {
    return jsonResponse(await failCatalogPublication(request, env));
  }
  if (url.pathname.startsWith('/v1/artifacts/')) {
    if (request.method === 'PUT') return jsonResponse(await uploadArtifact(request, env), { status: 201 });
    if (request.method === 'GET') return downloadArtifact(request, env);
  }
  if (request.method === 'POST' && url.pathname === '/v1/complete') {
    return jsonResponse(await completeRefresh(request, env));
  }
  if (request.method === 'POST' && url.pathname === '/v1/fail') {
    return jsonResponse(await failRefresh(request, env));
  }
  return jsonResponse({ error: 'Not found' }, { status: 404 });
}

export default {
  async fetch(request, env) {
    try {
      return await handleRequest(request, env);
    } catch (error) {
      console.error(JSON.stringify({
        event: 'tcgcsv_refresh_request_failed',
        path: new URL(request.url).pathname,
        error: errorMessage(error)
      }));
      return jsonResponse({ error: 'Request failed' }, { status: 400 });
    }
  },

  async scheduled(controller, env) {
    try {
      const state = await evaluateRefresh(env, { now: new Date(controller.scheduledTime) });
      const cleanedArtifacts = await cleanupStaleRunArtifacts(
        env,
        new Date(controller.scheduledTime)
      );
      const cleanedCatalogAssets = await cleanupStaleCatalogPublications(
        env,
        new Date(controller.scheduledTime)
      );
      console.log(JSON.stringify({
        event: 'tcgcsv_refresh_cron_check',
        cron: controller.cron,
        action: state.action,
        archiveDate: state.archiveDate,
        sourceUpdatedAt: state.sourceUpdatedAt,
        cleanedArtifacts,
        cleanedCatalogAssets
      }));
      controller.noRetry();
    } catch (error) {
      console.error(JSON.stringify({
        event: 'tcgcsv_refresh_cron_failed',
        cron: controller.cron,
        error: errorMessage(error)
      }));
      throw error;
    }
  }
};
