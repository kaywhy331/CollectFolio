#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { ARTIFACTS, parseSourceUpdatedAt } from '../cloudflare/tcgcsv-refresh/src/index.js';

const MAX_CONTROL_BYTES = 64 * 1024;

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
  if (command === 'upload' && args.length === 6) return upload(...args);
  if (command === 'download-if-present' && args.length === 5) return downloadIfPresent(...args);
  if (command === 'complete' && args.length >= 2) return complete(args[0], args.slice(1));
  if (command === 'fail' && (args.length === 1 || args.length === 2)) return fail(...args);
  throw new Error(
    'Usage: claim OUTPUT | upload ARTIFACT SLOT SOURCE RUN_ID FILE RECEIPT | '
    + 'download-if-present ARTIFACT SLOT SOURCE RUN_ID OUTPUT | '
    + 'complete CLAIM RECEIPT... | fail CLAIM [ERROR_CODE]'
  );
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`tcgcsv-r2-refresh-client: ${error instanceof Error ? error.message : 'unknown error'}\n`);
  process.exitCode = 1;
});
