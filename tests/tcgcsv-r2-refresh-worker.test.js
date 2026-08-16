import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import worker, {
  ARTIFACTS,
  artifactKey,
  claimRefresh,
  completeRefresh,
  downloadArtifact,
  evaluateRefresh,
  failRefresh,
  parseSourceUpdatedAt,
  publicRefreshStatus,
  slotForArchiveDate,
  uploadArtifact,
  verifyBearerToken
} from '../cloudflare/tcgcsv-refresh/src/index.js';

const SOURCE_TEXT = '2026-08-15T20:05:57+0000';
const SOURCE_ISO = '2026-08-15T20:05:57.000Z';
const TOKEN = 'test-coordinator-token-that-is-not-production';
const RUN_ID = '11111111-1111-4111-8111-111111111111';

function bytes(value) {
  return value instanceof Uint8Array ? value : new TextEncoder().encode(String(value));
}

async function bodyBytes(value) {
  if (value instanceof ReadableStream) return new Uint8Array(await new Response(value).arrayBuffer());
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  return bytes(value ?? '');
}

class MemoryR2 {
  constructor() {
    this.objects = new Map();
    this.sequence = 0;
  }

  record(key, stored, includeBody) {
    const metadata = {
      key,
      version: `v${stored.sequence}`,
      size: stored.value.byteLength,
      etag: stored.etag,
      httpEtag: `"${stored.etag}"`,
      uploaded: stored.uploaded,
      httpMetadata: stored.httpMetadata,
      customMetadata: stored.customMetadata,
      checksums: {},
      storageClass: 'Standard',
      writeHttpMetadata(headers) {
        if (stored.httpMetadata.contentType) headers.set('content-type', stored.httpMetadata.contentType);
        if (stored.httpMetadata.contentEncoding) headers.set('content-encoding', stored.httpMetadata.contentEncoding);
      }
    };
    if (!includeBody) return metadata;
    return {
      ...metadata,
      body: new Blob([stored.value]).stream(),
      bodyUsed: false,
      arrayBuffer: async () => stored.value.slice().buffer,
      text: async () => new TextDecoder().decode(stored.value),
      json: async () => JSON.parse(new TextDecoder().decode(stored.value)),
      blob: async () => new Blob([stored.value])
    };
  }

  async head(key) {
    const stored = this.objects.get(key);
    return stored ? this.record(key, stored, false) : null;
  }

  async get(key) {
    const stored = this.objects.get(key);
    return stored ? this.record(key, stored, true) : null;
  }

  async put(key, value, options = {}) {
    const existing = this.objects.get(key);
    if (options.onlyIf instanceof Headers) {
      if (options.onlyIf.get('if-none-match') === '*' && existing) return null;
    } else if (options.onlyIf?.etagMatches && existing?.etag !== options.onlyIf.etagMatches) {
      return null;
    } else if (options.onlyIf?.etagMatches && !existing) {
      return null;
    }
    const valueBytes = await bodyBytes(value);
    const sha256 = createHash('sha256').update(valueBytes).digest('hex');
    if (options.sha256 && options.sha256 !== sha256) throw new Error('SHA-256 mismatch');
    const stored = {
      sequence: ++this.sequence,
      value: valueBytes,
      etag: createHash('md5').update(valueBytes).update(String(this.sequence)).digest('hex'),
      uploaded: new Date(),
      httpMetadata: options.httpMetadata ?? {},
      customMetadata: options.customMetadata ?? {}
    };
    this.objects.set(key, stored);
    return this.record(key, stored, false);
  }

  async delete(keys) {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key);
  }
}

function sourceFetch(text = SOURCE_TEXT, status = 200) {
  return async () => new Response(text, {
    status,
    headers: { 'content-type': 'text/plain', 'content-length': String(Buffer.byteLength(text)) }
  });
}

function environment(bucket = new MemoryR2()) {
  return {
    TCGCSV_CURRENT: bucket,
    SOURCE_UPDATED_URL: 'https://tcgcsv.example/last-updated.txt',
    TCGCSV_USER_AGENT: 'CollectFolio/test',
    ALLOWED_ORIGIN: 'https://collectfolio.example',
    LEASE_MINUTES: '90',
    COORDINATOR_TOKEN: TOKEN
  };
}

function artifactRequest(method, artifactId, claim, content = null, hash = null) {
  const url = new URL(`https://refresh.example/v1/artifacts/${artifactId}`);
  url.searchParams.set('slot', String(claim.slot));
  url.searchParams.set('source_updated_at', claim.sourceUpdatedAt);
  url.searchParams.set('run_id', claim.runId);
  const headers = { authorization: `Bearer ${TOKEN}` };
  if (content !== null) {
    headers['content-length'] = String(content.byteLength);
    headers['x-content-sha256'] = hash;
  }
  return new Request(url, {
    method,
    headers,
    body: content,
    ...(content === null ? {} : { duplex: 'half' })
  });
}

async function uploadAll(env, claim) {
  const receipts = {};
  for (const artifactId of Object.keys(ARTIFACTS)) {
    const content = bytes(`deterministic-${artifactId}`);
    const sha256 = createHash('sha256').update(content).digest('hex');
    receipts[artifactId] = await uploadArtifact(
      artifactRequest('PUT', artifactId, claim, content, sha256),
      env,
      { now: new Date('2026-08-15T20:10:00Z') }
    );
  }
  return Object.fromEntries(Object.entries(receipts).map(([artifactId, receipt]) => [
    artifactId,
    { bytes: receipt.bytes, sha256: receipt.sha256 }
  ]));
}

function controlRequest(path, body) {
  const text = JSON.stringify(body);
  return new Request(`https://refresh.example${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-length': String(Buffer.byteLength(text)),
      'content-type': 'application/json'
    },
    body: text
  });
}

test('source timestamps, daily slots, and artifact keys are deterministic', () => {
  assert.deepEqual(parseSourceUpdatedAt(SOURCE_TEXT), {
    archiveDate: '2026-08-15',
    sourceUpdatedAt: SOURCE_ISO
  });
  assert.equal(slotForArchiveDate('2026-08-15'), slotForArchiveDate('2026-08-17'));
  assert.notEqual(slotForArchiveDate('2026-08-15'), slotForArchiveDate('2026-08-16'));
  assert.equal(
    artifactKey(1, 'raw_archive', RUN_ID),
    `runs/${RUN_ID}/slot-1/raw/prices.ppmd.7z`
  );
  assert.throws(() => parseSourceUpdatedAt('2026-08-15'));
  assert.throws(() => artifactKey(2, 'raw_archive', RUN_ID));
});

test('one source build receives one active lease and duplicates become no-ops', async () => {
  const env = environment();
  const now = new Date('2026-08-15T20:06:00Z');
  const first = await claimRefresh(env, {
    now,
    fetchImpl: sourceFetch(),
    idFactory: () => RUN_ID
  });
  assert.equal(first.action, 'run');
  assert.equal(first.started, true);
  assert.equal(first.sourceUpdatedAt, SOURCE_ISO);

  const duplicate = await claimRefresh(env, {
    now: new Date('2026-08-15T20:07:00Z'),
    fetchImpl: sourceFetch(),
    idFactory: () => '22222222-2222-4222-8222-222222222222'
  });
  assert.equal(duplicate.action, 'in_progress');
  assert.equal(duplicate.started, false);

  const retry = await claimRefresh(env, {
    now: new Date('2026-08-15T21:37:00Z'),
    fetchImpl: sourceFetch(),
    idFactory: () => '33333333-3333-4333-8333-333333333333'
  });
  assert.equal(retry.action, 'run');
  assert.equal(retry.started, true);
  assert.notEqual(retry.runId, first.runId);
});

test('verified artifacts seal one source build and all later checks no-op', async () => {
  const env = environment();
  const claim = await claimRefresh(env, {
    now: new Date('2026-08-15T20:06:00Z'),
    fetchImpl: sourceFetch(),
    idFactory: () => RUN_ID
  });
  const artifacts = await uploadAll(env, claim);
  const marker = await completeRefresh(controlRequest('/v1/complete', {
    runId: claim.runId,
    sourceUpdatedAt: claim.sourceUpdatedAt,
    slot: claim.slot,
    artifacts
  }), env, {
    now: new Date('2026-08-15T20:30:00Z'),
    fetchImpl: sourceFetch()
  });
  assert.equal(marker.sourceUpdatedAt, SOURCE_ISO);
  assert.equal(Object.keys(marker.artifacts).length, Object.keys(ARTIFACTS).length);

  const state = await evaluateRefresh(env, {
    now: new Date('2026-08-15T23:00:00Z'),
    fetchImpl: sourceFetch()
  });
  assert.equal(state.action, 'current');
  assert.deepEqual(publicRefreshStatus(state), {
    contractVersion: 'tcgcsv-r2-refresh-v1',
    status: 'current',
    sourceUpdatedAt: SOURCE_ISO,
    lastSuccessfulSourceBuild: SOURCE_ISO,
    lastSuccessfulAt: '2026-08-15T20:30:00.000Z'
  });
  assert.doesNotMatch(JSON.stringify(publicRefreshStatus(state)), /runId|key|artifacts/);
  const duplicate = await claimRefresh(env, {
    now: new Date('2026-08-15T23:00:00Z'),
    fetchImpl: sourceFetch(),
    idFactory: () => '44444444-4444-4444-8444-444444444444'
  });
  assert.equal(duplicate.started, false);
  assert.equal(duplicate.action, 'current');
});

test('completion fails closed when an artifact is missing or the source changed', async () => {
  const env = environment();
  const claim = await claimRefresh(env, {
    now: new Date('2026-08-15T20:06:00Z'),
    fetchImpl: sourceFetch(),
    idFactory: () => RUN_ID
  });
  const artifacts = await uploadAll(env, claim);
  env.TCGCSV_CURRENT.objects.delete(artifactKey(claim.slot, 'catalog_packet_gzip', claim.runId));
  await assert.rejects(
    completeRefresh(controlRequest('/v1/complete', {
      runId: claim.runId,
      sourceUpdatedAt: claim.sourceUpdatedAt,
      slot: claim.slot,
      artifacts
    }), env, { now: new Date('2026-08-15T20:30:00Z'), fetchImpl: sourceFetch() }),
    /catalog_packet_gzip/
  );

  const replacement = bytes('deterministic-catalog_packet_gzip');
  const replacementHash = createHash('sha256').update(replacement).digest('hex');
  await uploadArtifact(
    artifactRequest('PUT', 'catalog_packet_gzip', claim, replacement, replacementHash),
    env,
    { now: new Date('2026-08-15T20:31:00Z') }
  );
  artifacts.catalog_packet_gzip = { bytes: replacement.byteLength, sha256: replacementHash };
  await assert.rejects(
    completeRefresh(controlRequest('/v1/complete', {
      runId: claim.runId,
      sourceUpdatedAt: claim.sourceUpdatedAt,
      slot: claim.slot,
      artifacts
    }), env, {
      now: new Date('2026-08-15T20:32:00Z'),
      fetchImpl: sourceFetch('2026-08-16T20:05:57+0000')
    }),
    /changed before completion/
  );
});

test('an explicit failure releases the build for the next hourly retry', async () => {
  const env = environment();
  const claim = await claimRefresh(env, {
    now: new Date('2026-08-15T20:06:00Z'),
    fetchImpl: sourceFetch(),
    idFactory: () => RUN_ID
  });
  const failure = await failRefresh(controlRequest('/v1/fail', {
    runId: claim.runId,
    sourceUpdatedAt: claim.sourceUpdatedAt,
    slot: claim.slot,
    errorCode: 'catalog_failed'
  }), env, { now: new Date('2026-08-15T20:20:00Z') });
  assert.equal(failure.status, 'failed');

  const retry = await claimRefresh(env, {
    now: new Date('2026-08-15T21:00:00Z'),
    fetchImpl: sourceFetch(),
    idFactory: () => '55555555-5555-4555-8555-555555555555'
  });
  assert.equal(retry.started, true);
  assert.equal(retry.action, 'run');
});

test('artifact downloads are private streams with verified metadata', async () => {
  const env = environment();
  const claim = await claimRefresh(env, {
    now: new Date('2026-08-15T20:06:00Z'),
    fetchImpl: sourceFetch(),
    idFactory: () => RUN_ID
  });
  const artifacts = await uploadAll(env, claim);
  const sha256 = artifacts.prices_parquet.sha256;
  await completeRefresh(controlRequest('/v1/complete', {
    runId: claim.runId,
    sourceUpdatedAt: claim.sourceUpdatedAt,
    slot: claim.slot,
    artifacts
  }), env, {
    now: new Date('2026-08-15T20:30:00Z'),
    fetchImpl: sourceFetch()
  });
  const response = await downloadArtifact(artifactRequest('GET', 'prices_parquet', claim), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-content-sha256'), sha256);
  assert.equal(await response.text(), 'deterministic-prices_parquet');
});

test('bearer comparison and HTTP routing fail closed without exposing secrets', async () => {
  assert.equal(await verifyBearerToken(new Request('https://refresh.example', {
    headers: { authorization: `Bearer ${TOKEN}` }
  }), TOKEN), true);
  assert.equal(await verifyBearerToken(new Request('https://refresh.example', {
    headers: { authorization: 'Bearer incorrect' }
  }), TOKEN), false);

  const response = await worker.fetch(new Request('https://refresh.example/v1/claim', {
    method: 'POST',
    headers: { authorization: 'Bearer incorrect' }
  }), environment());
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'Unauthorized' });
});
