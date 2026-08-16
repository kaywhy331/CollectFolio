#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { ARTIFACTS, parseSourceUpdatedAt } from '../cloudflare/tcgcsv-refresh/src/index.js';

const MAX_CONTROL_BYTES = 64 * 1024;
const MAX_CATALOG_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_CATALOG_ASSET_BYTES = 24 * 1024 * 1024;
const CATALOG_ASSET_FILE = /^(catalog|routing|search)-\d{2,3}\.bin$/;

function requiredEnvironment(name) {
  const value = String(process.env[name] ?? '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function coordinatorUrl(pathname) {
  const base = new URL(requiredEnvironment('TCGCSV_COORDINATOR_URL'));
  if (base.protocol !== 'https:' && base.hostname !== 'localhost' && base.hostname !== '127.0.0.1') {
    throw new Error('TCGCSV_COORDINATOR_URL must use HTTPS');
  }
  return new URL(pathname, base);
}

function authorizationHeaders(extra = {}) {
  return {
    authorization: `Bearer ${requiredEnvironment('TCGCSV_COORDINATOR_TOKEN')}`,
    ...extra
  };
}

async function boundedResponseJson(response) {
  const declared = Number.parseInt(response.headers.get('content-length') ?? '', 10);
  if (Number.isFinite(declared) && declared > MAX_CONTROL_BYTES) {
    throw new Error('Coordinator response exceeds its size limit');
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_CONTROL_BYTES) {
    throw new Error('Coordinator response exceeds its size limit');
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`Coordinator returned invalid JSON with HTTP ${response.status}`);
  }
  if (!response.ok) throw new Error(`Coordinator failed with HTTP ${response.status}: ${value.error ?? 'unknown error'}`);
  return value;
}

async function writeJson(path, value) {
  const target = resolve(path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 });
}

async function readJson(path) {
  const text = await readFile(resolve(path), 'utf8');
  if (Buffer.byteLength(text) > MAX_CONTROL_BYTES) throw new Error(`${path} exceeds its size limit`);
  const value = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} is invalid`);
  return value;
}

async function readCatalogManifest(directory) {
  const path = resolve(directory, 'manifest.json');
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size <= 0 || metadata.size > MAX_CATALOG_MANIFEST_BYTES) {
    throw new Error('Catalog manifest is absent, empty, or exceeds its size limit');
  }
  const content = await readFile(path);
  const value = JSON.parse(content.toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || value.contractVersion !== 'collectfolio-tcgcsv-web-catalog-v2'
      || !Array.isArray(value.assets)
      || value.assets.length <= 0
      || value.assets.length > 512) {
    throw new Error('Catalog manifest is invalid');
  }
  return { content, metadata, path, value };
}

async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function artifactUrl(artifactId, slot, sourceUpdatedAt, runId) {
  if (!ARTIFACTS[artifactId]) throw new Error(`Unknown artifact ${artifactId}`);
  if (slot !== 0 && slot !== 1) throw new Error('Slot must be 0 or 1');
  const source = parseSourceUpdatedAt(sourceUpdatedAt);
  const url = coordinatorUrl(`/v1/artifacts/${encodeURIComponent(artifactId)}`);
  url.searchParams.set('slot', String(slot));
  url.searchParams.set('source_updated_at', source.sourceUpdatedAt);
  url.searchParams.set('run_id', runId);
  return url;
}

function catalogAssetUrl(file, plan) {
  if (file !== 'manifest.json' && !CATALOG_ASSET_FILE.test(file)) {
    throw new Error('Catalog asset filename is invalid');
  }
  const url = coordinatorUrl(`/v1/catalog/assets/${encodeURIComponent(file)}`);
  url.searchParams.set('publication_id', plan.publicationId);
  url.searchParams.set('source_updated_at', plan.sourceUpdatedAt);
  url.searchParams.set('run_id', plan.runId);
  return url;
}

async function claim(outputPath) {
  const response = await fetch(coordinatorUrl('/v1/claim'), {
    method: 'POST',
    headers: authorizationHeaders({ accept: 'application/json' }),
    signal: AbortSignal.timeout(30_000)
  });
  const result = await boundedResponseJson(response);
  await writeJson(outputPath, result);
  process.stdout.write(`${result.action}\n`);
}

async function catalogStatus(outputPath) {
  const response = await fetch(coordinatorUrl('/v1/catalog/status'), {
    headers: authorizationHeaders({ accept: 'application/json' }),
    signal: AbortSignal.timeout(30_000)
  });
  const result = await boundedResponseJson(response);
  await writeJson(outputPath, result);
  process.stdout.write(`${result.status}\n`);
}

async function catalogPlan(runId, sourceUpdatedAt, directory, outputPath) {
  const manifest = await readCatalogManifest(directory);
  const source = parseSourceUpdatedAt(sourceUpdatedAt).sourceUpdatedAt;
  if (manifest.value.sourceUpdatedAt !== source) {
    throw new Error('Catalog manifest does not match the sealed source build');
  }
  const publicationId = createHash('sha256').update(manifest.content).digest('hex');
  const body = JSON.stringify({
    runId,
    sourceUpdatedAt: source,
    publicationId,
    manifestSha256: publicationId,
    manifestBytes: manifest.metadata.size,
    assetCount: manifest.value.assets.length
  });
  const response = await fetch(coordinatorUrl('/v1/catalog/plan'), {
    method: 'POST',
    headers: authorizationHeaders({
      'content-length': String(Buffer.byteLength(body)),
      'content-type': 'application/json'
    }),
    body,
    signal: AbortSignal.timeout(30_000)
  });
  const result = await boundedResponseJson(response);
  await writeJson(outputPath, result);
  process.stdout.write(`${result.action} ${publicationId}\n`);
}

async function uploadCatalogFile(plan, file, path, expected = null) {
  const metadata = await stat(path);
  const maximumBytes = file === 'manifest.json'
    ? MAX_CATALOG_MANIFEST_BYTES
    : MAX_CATALOG_ASSET_BYTES;
  if (!metadata.isFile() || metadata.size <= 0 || metadata.size > maximumBytes) {
    throw new Error(`${file} is absent, empty, or exceeds ${maximumBytes} bytes`);
  }
  const digest = await sha256File(path);
  if (expected && (metadata.size !== expected.bytes || digest !== expected.sha256)) {
    throw new Error(`${file} does not match its local manifest receipt`);
  }
  const response = await fetch(catalogAssetUrl(file, plan), {
    method: 'PUT',
    headers: authorizationHeaders({
      'content-length': String(metadata.size),
      'content-type': file === 'manifest.json' ? 'application/json' : 'application/octet-stream',
      'x-content-sha256': digest
    }),
    body: Readable.toWeb(createReadStream(path)),
    duplex: 'half',
    signal: AbortSignal.timeout(20 * 60_000)
  });
  const receipt = await boundedResponseJson(response);
  if (receipt.file !== file || receipt.bytes !== metadata.size || receipt.sha256 !== digest) {
    throw new Error(`Coordinator receipt for ${file} does not match the local file`);
  }
  process.stdout.write(`${file} ${metadata.size} ${digest}\n`);
  return receipt;
}

async function mapConcurrent(values, concurrency, callback) {
  const results = new Array(values.length);
  let next = 0;
  async function consume() {
    while (next < values.length) {
      const index = next;
      next += 1;
      results[index] = await callback(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, consume));
  return results;
}

async function catalogUploadAll(planPath, directory, receiptPath) {
  const plan = await readJson(planPath);
  if (!plan.started || plan.action !== 'upload') {
    throw new Error('Catalog publication plan did not acquire an upload lease');
  }
  const manifest = await readCatalogManifest(directory);
  const manifestHash = createHash('sha256').update(manifest.content).digest('hex');
  if (manifestHash !== plan.publicationId
      || manifest.metadata.size !== plan.manifestBytes
      || manifest.value.sourceUpdatedAt !== plan.sourceUpdatedAt
      || manifest.value.assets.length !== plan.assetCount) {
    throw new Error('Local catalog publication does not match its upload plan');
  }
  const seen = new Set();
  const assets = manifest.value.assets.map((asset) => {
    if (!asset || typeof asset !== 'object' || Array.isArray(asset)
        || !CATALOG_ASSET_FILE.test(asset.file ?? '')
        || seen.has(asset.file)
        || !Number.isSafeInteger(asset.bytes)
        || asset.bytes <= 0
        || asset.bytes > MAX_CATALOG_ASSET_BYTES
        || !/^[0-9a-f]{64}$/.test(asset.sha256 ?? '')) {
      throw new Error('Catalog manifest contains an invalid upload receipt');
    }
    seen.add(asset.file);
    return asset;
  });
  const receipts = [await uploadCatalogFile(
    plan,
    'manifest.json',
    manifest.path,
    { bytes: plan.manifestBytes, sha256: plan.manifestSha256 }
  )];
  receipts.push(...await mapConcurrent(assets, 4, async (asset) =>
    uploadCatalogFile(plan, asset.file, resolve(directory, asset.file), asset)));
  await writeJson(receiptPath, {
    publicationId: plan.publicationId,
    sourceUpdatedAt: plan.sourceUpdatedAt,
    runId: plan.runId,
    assets: receipts
  });
}

async function catalogComplete(planPath) {
  const plan = await readJson(planPath);
  if (!plan.started || plan.action !== 'upload') {
    throw new Error('Catalog publication plan did not acquire an upload lease');
  }
  const body = JSON.stringify({
    runId: plan.runId,
    sourceUpdatedAt: plan.sourceUpdatedAt,
    publicationId: plan.publicationId,
    manifestSha256: plan.manifestSha256,
    manifestBytes: plan.manifestBytes,
    assetCount: plan.assetCount
  });
  const response = await fetch(coordinatorUrl('/v1/catalog/complete'), {
    method: 'POST',
    headers: authorizationHeaders({
      'content-length': String(Buffer.byteLength(body)),
      'content-type': 'application/json'
    }),
    body,
    signal: AbortSignal.timeout(5 * 60_000)
  });
  const result = await boundedResponseJson(response);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function catalogFail(planPath, errorCode = 'publication_workflow_failed') {
  const plan = await readJson(planPath);
  if (!plan.started || plan.action !== 'upload') return;
  const body = JSON.stringify({
    runId: plan.runId,
    sourceUpdatedAt: plan.sourceUpdatedAt,
    publicationId: plan.publicationId,
    errorCode
  });
  const response = await fetch(coordinatorUrl('/v1/catalog/fail'), {
    method: 'POST',
    headers: authorizationHeaders({
      'content-length': String(Buffer.byteLength(body)),
      'content-type': 'application/json'
    }),
    body,
    signal: AbortSignal.timeout(30_000)
  });
  await boundedResponseJson(response);
}

async function upload(artifactId, slotText, sourceUpdatedAt, runId, filePath, receiptPath) {
  const slot = Number.parseInt(slotText, 10);
  const path = resolve(filePath);
  const metadata = await stat(path);
  const artifact = ARTIFACTS[artifactId];
  if (!metadata.isFile() || metadata.size <= 0 || metadata.size > artifact.maximumBytes) {
    throw new Error(`${artifactId} is absent, empty, or exceeds ${artifact.maximumBytes} bytes`);
  }
  const sha256 = await sha256File(path);
  const response = await fetch(artifactUrl(artifactId, slot, sourceUpdatedAt, runId), {
    method: 'PUT',
    headers: authorizationHeaders({
      'content-length': String(metadata.size),
      'content-type': 'application/octet-stream',
      'x-content-sha256': sha256
    }),
    body: Readable.toWeb(createReadStream(path)),
    duplex: 'half',
    signal: AbortSignal.timeout(15 * 60_000)
  });
  const receipt = await boundedResponseJson(response);
  if (receipt.artifactId !== artifactId || receipt.bytes !== metadata.size || receipt.sha256 !== sha256) {
    throw new Error(`Coordinator receipt for ${artifactId} does not match the local file`);
  }
  await writeJson(receiptPath, receipt);
  process.stdout.write(`${artifactId} ${metadata.size} ${sha256}\n`);
}

class HashingTransform extends Transform {
  constructor(hash) {
    super();
    this.hash = hash;
  }

  _transform(chunk, encoding, callback) {
    this.hash.update(chunk);
    callback(null, chunk);
  }
}

async function downloadIfPresent(artifactId, slotText, sourceUpdatedAt, runId, outputPath) {
  const slot = Number.parseInt(slotText, 10);
  const response = await fetch(artifactUrl(artifactId, slot, sourceUpdatedAt, runId), {
    headers: authorizationHeaders(),
    signal: AbortSignal.timeout(15 * 60_000)
  });
  if (response.status === 404) {
    process.stdout.write(`missing ${artifactId} slot ${slot}\n`);
    return;
  }
  if (!response.ok || !response.body) {
    throw new Error(`Artifact download failed with HTTP ${response.status}`);
  }
  const expectedHash = response.headers.get('x-content-sha256') ?? '';
  if (!/^[0-9a-f]{64}$/.test(expectedHash)) throw new Error('Artifact download lacks a valid SHA-256');
  const declared = Number.parseInt(response.headers.get('content-length') ?? '', 10);
  const artifact = ARTIFACTS[artifactId];
  if (!Number.isSafeInteger(declared) || declared <= 0 || declared > artifact.maximumBytes) {
    throw new Error('Artifact download length is invalid');
  }
  const target = resolve(outputPath);
  const partial = `${target}.partial`;
  await mkdir(dirname(target), { recursive: true });
  const hash = createHash('sha256');
  try {
    await pipeline(
      Readable.fromWeb(response.body),
      new HashingTransform(hash),
      createWriteStream(partial, { mode: 0o600 })
    );
    const downloaded = await stat(partial);
    const actualHash = hash.digest('hex');
    if (downloaded.size !== declared || actualHash !== expectedHash) {
      throw new Error('Downloaded artifact failed size or SHA-256 verification');
    }
    await rename(partial, target);
  } catch (error) {
    await unlink(partial).catch(() => {});
    throw error;
  }
  process.stdout.write(`downloaded ${artifactId} slot ${slot}\n`);
}

async function complete(claimPath, receiptPaths) {
  const claimRecord = await readJson(claimPath);
  if (!claimRecord.started || claimRecord.action !== 'run') throw new Error('Claim did not start a refresh');
  const artifacts = {};
  for (const receiptPath of receiptPaths) {
    const receipt = await readJson(receiptPath);
    if (!ARTIFACTS[receipt.artifactId] || artifacts[receipt.artifactId]) {
      throw new Error(`Duplicate or unknown artifact receipt in ${receiptPath}`);
    }
    artifacts[receipt.artifactId] = {
      bytes: receipt.bytes,
      sha256: receipt.sha256
    };
  }
  const body = JSON.stringify({
    runId: claimRecord.runId,
    sourceUpdatedAt: claimRecord.sourceUpdatedAt,
    slot: claimRecord.slot,
    artifacts
  });
  const response = await fetch(coordinatorUrl('/v1/complete'), {
    method: 'POST',
    headers: authorizationHeaders({
      'content-length': String(Buffer.byteLength(body)),
      'content-type': 'application/json'
    }),
    body,
    signal: AbortSignal.timeout(60_000)
  });
  const result = await boundedResponseJson(response);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function fail(claimPath, errorCode = 'workflow_failed') {
  const claimRecord = await readJson(claimPath);
  if (!claimRecord.started || claimRecord.action !== 'run') return;
  const body = JSON.stringify({
    runId: claimRecord.runId,
    sourceUpdatedAt: claimRecord.sourceUpdatedAt,
    slot: claimRecord.slot,
    errorCode
  });
  const response = await fetch(coordinatorUrl('/v1/fail'), {
    method: 'POST',
    headers: authorizationHeaders({
      'content-length': String(Buffer.byteLength(body)),
      'content-type': 'application/json'
    }),
    body,
    signal: AbortSignal.timeout(30_000)
  });
  await boundedResponseJson(response);
}

async function main(argv) {
  const [command, ...args] = argv;
  if (command === 'claim' && args.length === 1) return claim(args[0]);
  if (command === 'catalog-status' && args.length === 1) return catalogStatus(args[0]);
  if (command === 'catalog-plan' && args.length === 4) return catalogPlan(...args);
  if (command === 'catalog-upload-all' && args.length === 3) return catalogUploadAll(...args);
  if (command === 'catalog-complete' && args.length === 1) return catalogComplete(args[0]);
  if (command === 'catalog-fail' && (args.length === 1 || args.length === 2)) return catalogFail(...args);
  if (command === 'upload' && args.length === 6) return upload(...args);
  if (command === 'download-if-present' && args.length === 5) return downloadIfPresent(...args);
  if (command === 'complete' && args.length >= 2) return complete(args[0], args.slice(1));
  if (command === 'fail' && (args.length === 1 || args.length === 2)) return fail(...args);
  throw new Error(
    'Usage: claim OUTPUT | catalog-status OUTPUT | catalog-plan RUN_ID SOURCE DIR OUTPUT | '
    + 'catalog-upload-all PLAN DIR RECEIPT | catalog-complete PLAN | catalog-fail PLAN [ERROR_CODE] | '
    + 'upload ARTIFACT SLOT SOURCE RUN_ID FILE RECEIPT | '
    + 'download-if-present ARTIFACT SLOT SOURCE RUN_ID OUTPUT | '
    + 'complete CLAIM RECEIPT... | fail CLAIM [ERROR_CODE]'
  );
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`tcgcsv-r2-refresh-client: ${error instanceof Error ? error.message : 'unknown error'}\n`);
  process.exitCode = 1;
});
