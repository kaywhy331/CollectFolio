const WEB_CATALOG_CONTRACT_VERSION = 'collectfolio-tcgcsv-web-catalog-v2';
const POINTER_CONTRACT_VERSION = 'collectfolio-tcgcsv-catalog-pointer-v1';
const PUBLICATION_CLAIM_CONTRACT_VERSION = 'collectfolio-tcgcsv-catalog-claim-v1';
const POINTER_KEY = 'catalog/pointer.json';
const PUBLICATION_CLAIM_KEY = 'coordination/catalog-publication-claim.json';
const MAX_CONTROL_BYTES = 64 * 1024;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_ASSET_BYTES = 24 * 1024 * 1024;
const MAX_CATALOG_PAGE_BYTES = 128 * 1024;
const MAX_SEARCH_PAGE_BYTES = 128 * 1024;
const DEFAULT_PUBLICATION_LEASE_MINUTES = 180;
const MAX_SEARCH_PAGES_PER_REQUEST = 1;
const PUBLICATION_ID = /^[0-9a-f]{64}$/;
const RUN_ID = /^[0-9a-f-]{16,64}$/i;
const ASSET_FILE = /^(catalog|routing|search)-(\d{2,3})\.bin$/;
const SOURCE_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;

class CatalogRequestError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'CatalogRequestError';
    this.status = status;
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : 'Unknown error';
}

function normalizedSourceTimestamp(value) {
  const source = String(value ?? '').trim();
  if (!SOURCE_TIMESTAMP.test(source)) throw new Error('Catalog source timestamp is invalid');
  const normalizedOffset = /[+-]\d{4}$/.test(source)
    ? `${source.slice(0, -2)}:${source.slice(-2)}`
    : source;
  const epoch = Date.parse(normalizedOffset);
  if (!Number.isFinite(epoch)) throw new Error('Catalog source timestamp is invalid');
  return new Date(epoch).toISOString();
}

function parseInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}

function jsonResponse(value, init = {}) {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'private, no-store');
  headers.set('x-content-type-options', 'nosniff');
  return Response.json(value, { ...init, headers });
}

async function boundedRequestObject(request, maximumBytes = MAX_CONTROL_BYTES) {
  const declared = Number.parseInt(request.headers.get('content-length') ?? '', 10);
  if (Number.isFinite(declared) && declared > maximumBytes) {
    throw new Error('Catalog control request exceeds its size limit');
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maximumBytes) {
    throw new Error('Catalog control request exceeds its size limit');
  }
  const value = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Catalog control request must be an object');
  }
  return value;
}

async function boundedObjectJson(bucket, key, maximumBytes = MAX_CONTROL_BYTES) {
  const object = await bucket.get(key);
  if (!object) return null;
  if (object.size <= 0 || object.size > maximumBytes) {
    throw new Error(`Catalog object ${key} exceeds its size limit`);
  }
  const text = await object.text();
  if (new TextEncoder().encode(text).byteLength !== object.size) {
    throw new Error(`Catalog object ${key} size is inconsistent`);
  }
  const value = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Catalog object ${key} is invalid`);
  }
  return { object, text, value };
}

function conditionalPut(record) {
  return record
    ? { etagMatches: record.object.etag }
    : new Headers({ 'if-none-match': '*' });
}

function markerKey(slot) {
  return `slots/${slot}/complete.json`;
}

async function publishedRuns(bucket) {
  const markers = await Promise.all([0, 1].map(async (slot) => {
    const record = await boundedObjectJson(bucket, markerKey(slot));
    if (!record) return null;
    const marker = record.value;
    if (!RUN_ID.test(marker.runId ?? '') || marker.slot !== slot) return null;
    try {
      return { ...marker, sourceUpdatedAt: normalizedSourceTimestamp(marker.sourceUpdatedAt) };
    } catch {
      return null;
    }
  }));
  return markers.filter(Boolean).sort((left, right) =>
    Date.parse(right.sourceUpdatedAt) - Date.parse(left.sourceUpdatedAt));
}

async function requirePublishedRun(bucket, runId, sourceUpdatedAt) {
  const normalized = normalizedSourceTimestamp(sourceUpdatedAt);
  const marker = (await publishedRuns(bucket)).find((candidate) =>
    candidate.runId === runId && candidate.sourceUpdatedAt === normalized);
  if (!marker) throw new Error('Catalog publication does not match a sealed source run');
  return marker;
}

export function catalogPublicationKey(publicationId, file) {
  if (!PUBLICATION_ID.test(publicationId ?? '')
      || (file !== 'manifest.json' && !ASSET_FILE.test(file ?? ''))) {
    throw new Error('Catalog publication asset identity is invalid');
  }
  return `catalog/publications/${publicationId}/${file}`;
}

function publicationClaimIsActive(claim, now) {
  return claim?.contractVersion === PUBLICATION_CLAIM_CONTRACT_VERSION
    && ['running', 'sealing'].includes(claim.status)
    && PUBLICATION_ID.test(claim.publicationId ?? '')
    && RUN_ID.test(claim.runId ?? '')
    && Number.isFinite(Date.parse(claim.expiresAt))
    && Date.parse(claim.expiresAt) > now.getTime();
}

function validatePublicationPlan(payload) {
  const sourceUpdatedAt = normalizedSourceTimestamp(payload.sourceUpdatedAt);
  if (!RUN_ID.test(payload.runId ?? '')
      || !PUBLICATION_ID.test(payload.publicationId ?? '')
      || payload.manifestSha256 !== payload.publicationId
      || !Number.isSafeInteger(payload.manifestBytes)
      || payload.manifestBytes <= 0
      || payload.manifestBytes > MAX_MANIFEST_BYTES
      || !Number.isSafeInteger(payload.assetCount)
      || payload.assetCount <= 0
      || payload.assetCount > 512) {
    throw new Error('Catalog publication plan is invalid');
  }
  return {
    runId: payload.runId,
    sourceUpdatedAt,
    publicationId: payload.publicationId,
    manifestSha256: payload.manifestSha256,
    manifestBytes: payload.manifestBytes,
    assetCount: payload.assetCount
  };
}

async function currentPointer(bucket) {
  const record = await boundedObjectJson(bucket, POINTER_KEY);
  if (!record) return null;
  if (record.value.contractVersion !== POINTER_CONTRACT_VERSION) {
    throw new Error('Catalog publication pointer has an unsupported contract');
  }
  return record;
}

async function pointerPublicationIsComplete(bucket, pointer, plan) {
  const current = pointer?.value?.current;
  if (current?.publicationId !== plan.publicationId
      || current?.sourceUpdatedAt !== plan.sourceUpdatedAt
      || current?.runId !== plan.runId
      || current?.manifestBytes !== plan.manifestBytes
      || current?.manifestSha256 !== plan.manifestSha256) {
    return false;
  }
  const object = await bucket.head(catalogPublicationKey(plan.publicationId, 'manifest.json'));
  return Boolean(object
    && object.size === plan.manifestBytes
    && object.customMetadata?.sha256 === plan.manifestSha256
    && object.customMetadata?.publicationId === plan.publicationId);
}

export async function planCatalogPublication(request, env, options = {}) {
  const now = options.now ?? new Date();
  const plan = validatePublicationPlan(await boundedRequestObject(request));
  await requirePublishedRun(env.TCGCSV_CURRENT, plan.runId, plan.sourceUpdatedAt);
  const [pointer, claimRecord] = await Promise.all([
    currentPointer(env.TCGCSV_CURRENT),
    boundedObjectJson(env.TCGCSV_CURRENT, PUBLICATION_CLAIM_KEY)
  ]);
  if (await pointerPublicationIsComplete(env.TCGCSV_CURRENT, pointer, plan)) {
    return { ...plan, action: 'current', started: false };
  }
  if (publicationClaimIsActive(claimRecord?.value, now)) {
    const claim = claimRecord.value;
    return {
      action: 'in_progress',
      started: false,
      publicationId: claim.publicationId,
      runId: claim.runId,
      sourceUpdatedAt: claim.sourceUpdatedAt,
      expiresAt: claim.expiresAt
    };
  }
  const leaseMinutes = parseInteger(
    env.CATALOG_LEASE_MINUTES,
    DEFAULT_PUBLICATION_LEASE_MINUTES,
    30,
    360
  );
  const claim = {
    contractVersion: PUBLICATION_CLAIM_CONTRACT_VERSION,
    status: 'running',
    ...plan,
    claimedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + leaseMinutes * 60_000).toISOString()
  };
  const stored = await env.TCGCSV_CURRENT.put(PUBLICATION_CLAIM_KEY, JSON.stringify(claim), {
    onlyIf: conditionalPut(claimRecord),
    httpMetadata: { contentType: 'application/json' },
    customMetadata: {
      contractVersion: PUBLICATION_CLAIM_CONTRACT_VERSION,
      publicationId: plan.publicationId,
      sourceUpdatedAt: plan.sourceUpdatedAt
    }
  });
  if (!stored) {
    return { ...plan, action: 'in_progress', started: false };
  }
  return { ...plan, action: 'upload', started: true, expiresAt: claim.expiresAt };
}

function publicationAssetIdentity(request) {
  const url = new URL(request.url);
  const file = decodeURIComponent(url.pathname.slice('/v1/catalog/assets/'.length));
  const publicationId = (url.searchParams.get('publication_id') ?? '').toLowerCase();
  const runId = url.searchParams.get('run_id') ?? '';
  const sourceUpdatedAt = normalizedSourceTimestamp(url.searchParams.get('source_updated_at'));
  const maximumBytes = file === 'manifest.json' ? MAX_MANIFEST_BYTES : MAX_ASSET_BYTES;
  if (!PUBLICATION_ID.test(publicationId)
      || !RUN_ID.test(runId)
      || (file !== 'manifest.json' && !ASSET_FILE.test(file))) {
    throw new Error('Catalog publication asset request is invalid');
  }
  return {
    file,
    maximumBytes,
    publicationId,
    runId,
    sourceUpdatedAt,
    key: catalogPublicationKey(publicationId, file)
  };
}

async function requirePublicationClaim(env, identity, now = new Date()) {
  const record = await boundedObjectJson(env.TCGCSV_CURRENT, PUBLICATION_CLAIM_KEY);
  const claim = record?.value;
  if (!publicationClaimIsActive(claim, now)
      || claim.publicationId !== identity.publicationId
      || claim.runId !== identity.runId
      || claim.sourceUpdatedAt !== identity.sourceUpdatedAt) {
    throw new Error('Catalog publication claim is absent, expired, or does not match');
  }
  return record;
}

export async function uploadCatalogAsset(request, env, options = {}) {
  const identity = publicationAssetIdentity(request);
  const claimRecord = await requirePublicationClaim(env, identity, options.now);
  if (claimRecord.value.status !== 'running') {
    throw new Error('Catalog publication is already sealing');
  }
  const declaredBytes = Number.parseInt(request.headers.get('content-length') ?? '', 10);
  const sha256 = (request.headers.get('x-content-sha256') ?? '').toLowerCase();
  if (!Number.isSafeInteger(declaredBytes)
      || declaredBytes <= 0
      || declaredBytes > identity.maximumBytes
      || !PUBLICATION_ID.test(sha256)
      || !request.body) {
    throw new Error('Catalog publication asset length, SHA-256, or body is invalid');
  }
  if (identity.file === 'manifest.json'
      && (declaredBytes !== claimRecord.value.manifestBytes
        || sha256 !== claimRecord.value.manifestSha256)) {
    throw new Error('Catalog manifest does not match its publication plan');
  }
  const stored = await env.TCGCSV_CURRENT.put(identity.key, request.body, {
    sha256,
    httpMetadata: {
      contentType: identity.file === 'manifest.json'
        ? 'application/json; charset=utf-8'
        : 'application/octet-stream'
    },
    customMetadata: {
      contractVersion: WEB_CATALOG_CONTRACT_VERSION,
      publicationId: identity.publicationId,
      runId: identity.runId,
      sourceUpdatedAt: identity.sourceUpdatedAt,
      sha256
    }
  });
  if (!stored || stored.size !== declaredBytes) {
    throw new Error('Catalog publication asset failed R2 size verification');
  }
  return { file: identity.file, bytes: stored.size, sha256 };
}

function positiveInteger(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`Catalog manifest ${name} is invalid`);
  }
  return value;
}

function manifestAssetMap(manifest) {
  const shardCount = positiveInteger(manifest.shardCount, 'shardCount', 256);
  if (!Array.isArray(manifest.assets) || manifest.assets.length <= 0 || manifest.assets.length > 512) {
    throw new Error('Catalog manifest assets are invalid');
  }
  const assets = new Map();
  for (const asset of manifest.assets) {
    if (!asset || typeof asset !== 'object' || Array.isArray(asset)) {
      throw new Error('Catalog manifest contains an invalid asset');
    }
    const match = ASSET_FILE.exec(asset.file ?? '');
    const shard = Number(asset.shard);
    if (!match
        || match[1] !== asset.kind
        || !Number.isSafeInteger(shard)
        || shard < 0
        || shard >= shardCount
        || Number.parseInt(match[2], 10) !== shard
        || assets.has(asset.file)
        || !PUBLICATION_ID.test(asset.sha256 ?? '')) {
      throw new Error('Catalog manifest asset identity is invalid');
    }
    positiveInteger(asset.bytes, `asset ${asset.file} bytes`, MAX_ASSET_BYTES);
    assets.set(asset.file, asset);
  }
  return assets;
}

function manifestRangeAsset(assets, kind, range, label) {
  const file = `${kind}-${String(range?.shard).padStart(2, '0')}.bin`;
  const asset = assets.get(file);
  if (!asset
      || asset.kind !== kind
      || !Number.isSafeInteger(range?.shard)
      || !Number.isSafeInteger(range?.offset)
      || range.offset < 0
      || !Number.isSafeInteger(range?.length)
      || range.length <= 0
      || range.offset + range.length > asset.bytes) {
    throw new Error(`Catalog manifest ${label} range is invalid`);
  }
  return asset;
}

function validateManifestIndexes(manifest, assets) {
  const counts = manifest.counts;
  if (!counts || typeof counts !== 'object' || Array.isArray(counts)) {
    throw new Error('Catalog manifest counts are invalid');
  }
  const categoryCount = positiveInteger(counts.categories, 'category count');
  const groupCount = positiveInteger(counts.groups, 'group count');
  positiveInteger(counts.products, 'product count');
  positiveInteger(counts.priceSeries, 'price series count');
  positiveInteger(counts.searchPrefixes, 'search prefix count');
  const routing = manifest.routing;
  if (!Number.isSafeInteger(counts.pricedProducts)
      || counts.pricedProducts < 0
      || counts.pricedProducts > counts.products
      || !Array.isArray(manifest.categories)
      || manifest.categories.length !== categoryCount
      || !routing
      || typeof routing !== 'object'
      || Array.isArray(routing)
      || !Array.isArray(routing.categoryRoutes)
      || !Array.isArray(routing.groupPages)
      || !Array.isArray(routing.productRoutes)
      || !Array.isArray(routing.searchRoutes)
      ) {
    throw new Error('Catalog manifest counts do not match its indexes');
  }
  const categoryIds = new Set(manifest.categories.map((row) => row?.categoryId));
  if (categoryIds.size !== categoryCount
      || [...categoryIds].some((value) => !Number.isSafeInteger(value) || value <= 0)) {
    throw new Error('Catalog manifest category identities are invalid');
  }
  if (routing.categoryRoutes.length !== categoryCount) {
    throw new Error('Catalog manifest category routing count is invalid');
  }
  const routedCategories = new Set();
  let routedGroups = 0;
  for (const route of routing.categoryRoutes) {
    if (!categoryIds.has(route?.categoryId)
        || routedCategories.has(route.categoryId)
        || !Number.isSafeInteger(route.groupCount)
        || route.groupCount < 0) {
      throw new Error('Catalog manifest category routing is invalid');
    }
    manifestRangeAsset(assets, 'routing', route, 'category');
    routedCategories.add(route.categoryId);
    routedGroups += route.groupCount;
  }
  if (routedGroups !== groupCount) throw new Error('Catalog category routing is incomplete');

  const productRouteShards = new Set();
  let productRouteGroups = 0;
  for (const route of routing.productRoutes) {
    if (!Number.isSafeInteger(route?.groupCount)
        || route.groupCount <= 0
        || productRouteShards.has(route.shard)) {
      throw new Error('Catalog manifest product routing is invalid');
    }
    manifestRangeAsset(assets, 'routing', route, 'product');
    productRouteShards.add(route.shard);
    productRouteGroups += route.groupCount;
  }
  if (productRouteGroups !== groupCount) {
    throw new Error('Catalog manifest product routing is incomplete');
  }

  let nextGroup = 0;
  for (const page of routing.groupPages) {
    if (page?.start !== nextGroup
        || !Number.isSafeInteger(page.count)
        || page.count <= 0
        || page.count > 1000) {
      throw new Error('Catalog manifest group-page routing is invalid');
    }
    manifestRangeAsset(assets, 'routing', page, 'group page');
    nextGroup += page.count;
  }
  if (nextGroup !== groupCount) {
    throw new Error('Catalog manifest global group routing is incomplete');
  }

  const searchShards = new Set();
  let routedPrefixes = 0;
  for (const route of routing.searchRoutes) {
    if (!Number.isSafeInteger(route?.prefixCount)
        || route.prefixCount <= 0
        || searchShards.has(route.shard)) {
      throw new Error('Catalog manifest search routing is invalid');
    }
    manifestRangeAsset(assets, 'routing', route, 'search');
    searchShards.add(route.shard);
    routedPrefixes += route.prefixCount;
  }
  if (routedPrefixes !== counts.searchPrefixes) {
    throw new Error('Catalog manifest search routing is incomplete');
  }
  const kinds = new Set([...assets.values()].map((asset) => asset.kind));
  if (!['catalog', 'routing', 'search'].every((kind) => kinds.has(kind))) {
    throw new Error('Catalog manifest is missing a required asset kind');
  }
  return counts;
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function loadAndValidatePlannedManifest(env, claim) {
  const key = catalogPublicationKey(claim.publicationId, 'manifest.json');
  const record = await boundedObjectJson(env.TCGCSV_CURRENT, key, MAX_MANIFEST_BYTES);
  if (!record
      || record.object.size !== claim.manifestBytes
      || record.object.customMetadata?.sha256 !== claim.manifestSha256
      || record.object.customMetadata?.publicationId !== claim.publicationId
      || await sha256Hex(record.text) !== claim.publicationId) {
    throw new Error('Catalog manifest does not match its hash-addressed plan');
  }
  const manifest = record.value;
  if (manifest.contractVersion !== WEB_CATALOG_CONTRACT_VERSION
      || normalizedSourceTimestamp(manifest.sourceUpdatedAt) !== claim.sourceUpdatedAt) {
    throw new Error('Catalog manifest source contract is invalid');
  }
  const assets = manifestAssetMap(manifest);
  if (assets.size !== claim.assetCount) {
    throw new Error('Catalog manifest asset count does not match its plan');
  }
  const counts = validateManifestIndexes(manifest, assets);
  return { assets, counts, manifest, record };
}

async function verifyPublicationAssets(bucket, claim, assets) {
  const entries = [...assets.values()];
  for (let start = 0; start < entries.length; start += 16) {
    const batch = entries.slice(start, start + 16);
    const objects = await Promise.all(batch.map((asset) =>
      bucket.head(catalogPublicationKey(claim.publicationId, asset.file))));
    objects.forEach((object, index) => {
      const asset = batch[index];
      if (!object
          || object.size !== asset.bytes
          || object.customMetadata?.sha256 !== asset.sha256
          || object.customMetadata?.publicationId !== claim.publicationId
          || object.customMetadata?.runId !== claim.runId
          || object.customMetadata?.sourceUpdatedAt !== claim.sourceUpdatedAt) {
        throw new Error(`Catalog publication asset ${asset.file} failed verification`);
      }
    });
  }
}

async function verifyPublicationObjectSet(bucket, claim, assets) {
  const expected = new Set([
    catalogPublicationKey(claim.publicationId, 'manifest.json'),
    ...[...assets.values()].map((asset) =>
      catalogPublicationKey(claim.publicationId, asset.file))
  ]);
  const found = new Set();
  let cursor;
  do {
    const page = await bucket.list({
      prefix: `catalog/publications/${claim.publicationId}/`,
      limit: 1000,
      cursor
    });
    page.objects.forEach((object) => found.add(object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  if (found.size !== expected.size || [...found].some((key) => !expected.has(key))) {
    throw new Error('Catalog publication object set does not exactly match its manifest');
  }
}

export async function completeCatalogPublication(request, env, options = {}) {
  const now = options.now ?? new Date();
  const plan = validatePublicationPlan(await boundedRequestObject(request));
  const claimRecord = await requirePublicationClaim(env, plan, now);
  if (claimRecord.value.status !== 'running') {
    throw new Error('Catalog publication is already sealing');
  }
  await requirePublishedRun(env.TCGCSV_CURRENT, plan.runId, plan.sourceUpdatedAt);
  const sealingClaim = {
    ...claimRecord.value,
    status: 'sealing',
    sealingAt: now.toISOString(),
    expiresAt: new Date(Math.max(
      Date.parse(claimRecord.value.expiresAt),
      now.getTime() + 15 * 60_000
    )).toISOString()
  };
  const sealingObject = await env.TCGCSV_CURRENT.put(
    PUBLICATION_CLAIM_KEY,
    JSON.stringify(sealingClaim),
    {
      onlyIf: { etagMatches: claimRecord.object.etag },
      httpMetadata: { contentType: 'application/json' },
      customMetadata: {
        contractVersion: PUBLICATION_CLAIM_CONTRACT_VERSION,
        publicationId: plan.publicationId,
        sourceUpdatedAt: plan.sourceUpdatedAt
      }
    }
  );
  if (!sealingObject) throw new Error('Catalog publication claim changed before sealing');

  const { assets, counts } = await loadAndValidatePlannedManifest(env, sealingClaim);
  await verifyPublicationObjectSet(env.TCGCSV_CURRENT, sealingClaim, assets);
  await verifyPublicationAssets(env.TCGCSV_CURRENT, sealingClaim, assets);
  const pointerRecord = await currentPointer(env.TCGCSV_CURRENT);
  const publishedAt = now.toISOString();
  const current = {
    publicationId: plan.publicationId,
    runId: plan.runId,
    sourceUpdatedAt: plan.sourceUpdatedAt,
    publishedAt,
    manifestKey: catalogPublicationKey(plan.publicationId, 'manifest.json'),
    manifestBytes: plan.manifestBytes,
    manifestSha256: plan.manifestSha256,
    assetCount: plan.assetCount,
    counts
  };
  const priorCurrent = pointerRecord?.value?.current ?? null;
  const pointer = {
    contractVersion: POINTER_CONTRACT_VERSION,
    updatedAt: publishedAt,
    current,
    previous: priorCurrent?.publicationId && priorCurrent.publicationId !== current.publicationId
      ? priorCurrent
      : pointerRecord?.value?.previous ?? null
  };
  const storedPointer = await env.TCGCSV_CURRENT.put(POINTER_KEY, JSON.stringify(pointer), {
    onlyIf: conditionalPut(pointerRecord),
    httpMetadata: { contentType: 'application/json' },
    customMetadata: {
      contractVersion: POINTER_CONTRACT_VERSION,
      publicationId: plan.publicationId,
      sourceUpdatedAt: plan.sourceUpdatedAt
    }
  });
  if (!storedPointer) throw new Error('Catalog publication pointer changed before promotion');
  const completedClaim = await env.TCGCSV_CURRENT.put(PUBLICATION_CLAIM_KEY, JSON.stringify({
    ...sealingClaim,
    status: 'complete',
    completedAt: publishedAt,
    expiresAt: publishedAt
  }), {
    onlyIf: { etagMatches: sealingObject.etag },
    httpMetadata: { contentType: 'application/json' },
    customMetadata: {
      contractVersion: PUBLICATION_CLAIM_CONTRACT_VERSION,
      publicationId: plan.publicationId,
      sourceUpdatedAt: plan.sourceUpdatedAt
    }
  });
  if (!completedClaim) throw new Error('Catalog publication claim changed after promotion');
  return pointer;
}

export async function failCatalogPublication(request, env, options = {}) {
  const now = options.now ?? new Date();
  const payload = await boundedRequestObject(request);
  const identity = {
    publicationId: String(payload.publicationId ?? '').toLowerCase(),
    runId: payload.runId,
    sourceUpdatedAt: normalizedSourceTimestamp(payload.sourceUpdatedAt)
  };
  const claimRecord = await requirePublicationClaim(env, identity, now);
  const failure = {
    ...claimRecord.value,
    status: 'failed',
    failedAt: now.toISOString(),
    expiresAt: now.toISOString(),
    errorCode: String(payload.errorCode ?? 'publication_failed').slice(0, 80)
  };
  const stored = await env.TCGCSV_CURRENT.put(PUBLICATION_CLAIM_KEY, JSON.stringify(failure), {
    onlyIf: { etagMatches: claimRecord.object.etag },
    httpMetadata: { contentType: 'application/json' },
    customMetadata: {
      contractVersion: PUBLICATION_CLAIM_CONTRACT_VERSION,
      publicationId: identity.publicationId,
      sourceUpdatedAt: identity.sourceUpdatedAt
    }
  });
  if (!stored) throw new Error('Catalog publication claim changed before failure release');
  return failure;
}

export async function catalogPublicationStatus(env) {
  const [runs, pointer, claimRecord] = await Promise.all([
    publishedRuns(env.TCGCSV_CURRENT),
    currentPointer(env.TCGCSV_CURRENT),
    boundedObjectJson(env.TCGCSV_CURRENT, PUBLICATION_CLAIM_KEY)
  ]);
  const latestRun = runs[0] ?? null;
  const current = pointer?.value?.current ?? null;
  const activeClaim = publicationClaimIsActive(claimRecord?.value, new Date())
    ? claimRecord.value
    : null;
  return {
    contractVersion: POINTER_CONTRACT_VERSION,
    status: latestRun && current?.sourceUpdatedAt === latestRun.sourceUpdatedAt
      && current?.runId === latestRun.runId
      ? 'current'
      : activeClaim
        ? 'in_progress'
        : 'publication_required',
    latestRun: latestRun ? {
      runId: latestRun.runId,
      sourceUpdatedAt: latestRun.sourceUpdatedAt,
      slot: latestRun.slot
    } : null,
    current: current ? {
      publicationId: current.publicationId,
      runId: current.runId,
      sourceUpdatedAt: current.sourceUpdatedAt,
      publishedAt: current.publishedAt,
      counts: current.counts
    } : null,
    activePublication: activeClaim ? {
      publicationId: activeClaim.publicationId,
      runId: activeClaim.runId,
      sourceUpdatedAt: activeClaim.sourceUpdatedAt,
      expiresAt: activeClaim.expiresAt
    } : null
  };
}

export async function cleanupStaleCatalogPublications(env, now = new Date()) {
  const [pointer, claimRecord] = await Promise.all([
    currentPointer(env.TCGCSV_CURRENT),
    boundedObjectJson(env.TCGCSV_CURRENT, PUBLICATION_CLAIM_KEY)
  ]);
  const retained = new Set([
    pointer?.value?.current?.publicationId,
    pointer?.value?.previous?.publicationId
  ].filter((value) => PUBLICATION_ID.test(value ?? '')));
  if (publicationClaimIsActive(claimRecord?.value, now)) {
    retained.add(claimRecord.value.publicationId);
  }
  const stale = [];
  let cursor;
  do {
    const page = await env.TCGCSV_CURRENT.list({
      prefix: 'catalog/publications/',
      limit: 1000,
      cursor
    });
    for (const object of page.objects) {
      const publicationId = object.key.split('/')[2] ?? '';
      if (PUBLICATION_ID.test(publicationId) && !retained.has(publicationId)) {
        stale.push(object.key);
      }
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  for (let start = 0; start < stale.length; start += 1000) {
    await env.TCGCSV_CURRENT.delete(stale.slice(start, start + 1000));
  }
  return stale.length;
}

function catalogCorsHeaders(request, env) {
  const origin = request.headers.get('origin');
  return origin && origin === env.ALLOWED_ORIGIN
    ? {
        'access-control-allow-origin': origin,
        'access-control-allow-headers': 'authorization, content-type',
        'access-control-allow-methods': 'GET, OPTIONS',
        'access-control-max-age': '600',
        vary: 'Origin'
      }
    : {};
}

async function boundedResponseObject(response) {
  const declared = Number.parseInt(response.headers.get('content-length') ?? '', 10);
  if (Number.isFinite(declared) && declared > MAX_CONTROL_BYTES) {
    throw new Error('Supabase authentication response exceeds its size limit');
  }
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_CONTROL_BYTES) {
    throw new Error('Supabase authentication response exceeds its size limit');
  }
  const value = JSON.parse(text);
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

export async function authenticateCatalogUser(request, env, fetchImpl = globalThis.fetch) {
  // Community free access: when enabled, catalog reads are open to everyone —
  // no Supabase session required. Control-plane (/v1/*) routes are unaffected.
  if (env.CATALOG_PUBLIC_ACCESS === 'true') return { id: 'community-public-access' };
  const authorization = request.headers.get('authorization') ?? '';
  if (!authorization.startsWith('Bearer ') || authorization.length > 16 * 1024) return null;
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return null;
  let supabaseUrl;
  try {
    supabaseUrl = new URL(String(env.SUPABASE_URL));
  } catch {
    return null;
  }
  if (supabaseUrl.protocol !== 'https:') return null;
  const response = await fetchImpl(new URL('/auth/v1/user', supabaseUrl), {
    headers: {
      accept: 'application/json',
      apikey: env.SUPABASE_ANON_KEY,
      authorization
    },
    signal: AbortSignal.timeout(10_000)
  });
  if (response.status === 401 || response.status === 403) return null;
  if (!response.ok) throw new Error(`Supabase authentication failed with HTTP ${response.status}`);
  const user = await boundedResponseObject(response);
  const allowed = new Set(String(env.CATALOG_ALLOWED_USER_IDS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean));
  if (!user?.id) return null;
  if (allowed.size) return allowed.has(user.id) ? { id: user.id } : null;
  return env.CATALOG_AUTHENTICATED_TEST_ACCESS === 'true' ? { id: user.id } : null;
}

async function currentManifest(env) {
  const pointerRecord = await currentPointer(env.TCGCSV_CURRENT);
  const current = pointerRecord?.value?.current;
  if (!current || !PUBLICATION_ID.test(current.publicationId ?? '')) {
    throw new CatalogRequestError('Full catalog is not published yet', 503);
  }
  const record = await boundedObjectJson(
    env.TCGCSV_CURRENT,
    current.manifestKey,
    MAX_MANIFEST_BYTES
  );
  if (!record
      || record.object.size !== current.manifestBytes
      || record.object.customMetadata?.sha256 !== current.manifestSha256
      || record.object.customMetadata?.publicationId !== current.publicationId
      || record.value.contractVersion !== WEB_CATALOG_CONTRACT_VERSION
      || record.value.sourceUpdatedAt !== current.sourceUpdatedAt) {
    throw new Error('Current catalog manifest does not match its atomic pointer');
  }
  return { current, manifest: record.value };
}

function manifestAsset(manifest, kind, shard) {
  return manifest.assets.find((asset) => asset.kind === kind && asset.shard === shard) ?? null;
}

async function readRangeJson(env, current, manifest, kind, range) {
  const asset = manifestAsset(manifest, kind, range.shard);
  if (!asset
      || !Number.isSafeInteger(range.offset)
      || range.offset < 0
      || !Number.isSafeInteger(range.length)
      || range.length <= 0
      || range.offset + range.length > asset.bytes) {
    throw new Error('Catalog range is outside its verified asset');
  }
  const object = await env.TCGCSV_CURRENT.get(
    catalogPublicationKey(current.publicationId, asset.file),
    { range: { offset: range.offset, length: range.length } }
  );
  if (!object
      || object.size !== asset.bytes
      || object.customMetadata?.sha256 !== asset.sha256
      || object.customMetadata?.publicationId !== current.publicationId) {
    throw new Error('Catalog range asset does not match its manifest');
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.byteLength !== range.length) throw new Error('Catalog range length is inconsistent');
  return JSON.parse(new TextDecoder().decode(bytes));
}

function boundedOffset(url, maximum) {
  const cursor = url.searchParams.get('cursor');
  if (cursor === null || cursor === '') return 0;
  const offset = Number.parseInt(cursor, 10);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > maximum) {
    throw new CatalogRequestError('Catalog cursor is invalid');
  }
  return offset;
}

function groupIdentity(pathname, pattern) {
  const match = pattern.exec(pathname);
  if (!match) return null;
  return match.slice(1).map((value) => Number.parseInt(value, 10));
}

function normalizeSearchText(...values) {
  return values.join(' ')
    .normalize('NFKD')
    .replace(/[^\x00-\x7f]/g, '')
    .toLowerCase()
    .match(/[a-z0-9]+/g)?.join(' ') ?? '';
}

async function routingShard(value, shardCount) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return new DataView(digest).getUint32(0, false) % shardCount;
}

function searchCursor(value, pageCount) {
  if (!value) return { page: 0, record: 0 };
  const match = /^(\d+):(\d+)$/.exec(value);
  const page = Number.parseInt(match?.[1] ?? '', 10);
  const record = Number.parseInt(match?.[2] ?? '', 10);
  if (!match || !Number.isSafeInteger(page) || page < 0 || page > pageCount
      || !Number.isSafeInteger(record) || record < 0 || record > 100_000) {
    throw new CatalogRequestError('Search cursor is invalid');
  }
  return { page, record };
}

function searchProduct(tuple, manifest) {
  if (!Array.isArray(tuple) || tuple.length !== 10) throw new Error('Search record is invalid');
  const [categoryId, groupId, productId, name, cleanName, cardNumber, rarity, cardType, groupName, prices] = tuple;
  const category = manifest.categories.find((row) => row.categoryId === categoryId);
  return {
    categoryId,
    categoryName: category?.displayName || category?.name || '',
    groupId,
    groupName: String(groupName || ''),
    productId,
    name,
    cleanName,
    cardNumber,
    rarity,
    cardType,
    prices: Array.isArray(prices) ? prices.map((price) => ({
      subtypeName: price?.[0] ?? '',
      lowPrice: price?.[1] ?? null,
      midPrice: price?.[2] ?? null,
      highPrice: price?.[3] ?? null,
      marketPrice: price?.[4] ?? null,
      directLowPrice: price?.[5] ?? null
    })) : []
  };
}

async function catalogSummary(env) {
  const { current, manifest } = await currentManifest(env);
  return {
    contractVersion: manifest.contractVersion,
    publicationId: current.publicationId,
    sourceUpdatedAt: current.sourceUpdatedAt,
    publishedAt: current.publishedAt,
    counts: manifest.counts,
    categories: manifest.categories
  };
}

async function categoryRoutingBlock(env, current, manifest, categoryId) {
  const route = manifest.routing.categoryRoutes.find((row) => row.categoryId === categoryId);
  if (!route) return null;
  const block = await readRangeJson(env, current, manifest, 'routing', route);
  if (block?.categoryId !== categoryId
      || !Array.isArray(block.groups)
      || block.groups.length !== route.groupCount) {
    throw new Error('Catalog category routing block is invalid');
  }
  return { block, route };
}

async function routedGroups(env, current, manifest, offset, limit) {
  const end = Math.min(manifest.counts.groups, offset + limit);
  const groups = [];
  for (const route of manifest.routing.groupPages) {
    const routeEnd = route.start + route.count;
    if (routeEnd <= offset || route.start >= end) continue;
    const block = await readRangeJson(env, current, manifest, 'routing', route);
    if (!Array.isArray(block?.groups) || block.groups.length !== route.count) {
      throw new Error('Catalog group-page routing block is invalid');
    }
    const localStart = Math.max(0, offset - route.start);
    const localEnd = Math.min(route.count, end - route.start);
    groups.push(...block.groups.slice(localStart, localEnd));
  }
  if (groups.length !== end - offset) throw new Error('Catalog group-page routing is incomplete');
  return groups;
}

async function productRoutingEntry(env, current, manifest, categoryId, groupId) {
  const shard = await routingShard(`group:${categoryId}:${groupId}`, manifest.shardCount);
  const route = manifest.routing.productRoutes.find((row) => row.shard === shard);
  if (!route) return null;
  const block = await readRangeJson(env, current, manifest, 'routing', route);
  if (!Array.isArray(block?.groups) || block.groups.length !== route.groupCount) {
    throw new Error('Catalog product routing block is invalid');
  }
  const entry = block.groups.find((row) =>
    row.categoryId === categoryId && row.groupId === groupId);
  if (!entry) return null;
  if (!entry.group || entry.group.categoryId !== categoryId || entry.group.groupId !== groupId
      || !Number.isSafeInteger(entry.productCount) || entry.productCount < 0
      || !Number.isSafeInteger(entry.priceCount) || entry.priceCount < 0
      || !Array.isArray(entry.pages)) {
    throw new Error('Catalog product routing entry is invalid');
  }
  let nextProduct = 0;
  for (const page of entry.pages) {
    const asset = manifestAsset(manifest, 'catalog', page?.shard);
    if (page?.start !== nextProduct
        || !Number.isSafeInteger(page.count)
        || page.count <= 0
        || page.count > 100
        || !Number.isSafeInteger(page.firstProductId)
        || !Number.isSafeInteger(page.lastProductId)
        || page.firstProductId <= 0
        || page.lastProductId < page.firstProductId
        || !asset
        || !Number.isSafeInteger(page.offset)
        || page.offset < 0
        || !Number.isSafeInteger(page.length)
        || page.length <= 0
        || page.length > MAX_CATALOG_PAGE_BYTES
        || page.offset + page.length > asset.bytes) {
      throw new Error('Catalog product page routing is invalid');
    }
    nextProduct += page.count;
  }
  if (nextProduct !== entry.productCount) {
    throw new Error('Catalog product page routing is incomplete');
  }
  return entry;
}

async function categoryGroups(request, env, categoryId) {
  const { current, manifest } = await currentManifest(env);
  const category = manifest.categories.find((row) => row.categoryId === categoryId);
  if (!category) throw new CatalogRequestError('Catalog category was not found', 404);
  const routed = await categoryRoutingBlock(env, current, manifest, categoryId);
  if (!routed) throw new Error('Catalog category routing is absent');
  const url = new URL(request.url);
  const offset = boundedOffset(url, routed.block.groups.length);
  const limit = parseInteger(url.searchParams.get('limit'), 100, 1, 200);
  const page = routed.block.groups.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  return {
    publicationId: current.publicationId,
    sourceUpdatedAt: current.sourceUpdatedAt,
    category,
    groups: page,
    total: routed.block.groups.length,
    nextCursor: nextOffset < routed.block.groups.length ? String(nextOffset) : null
  };
}

async function allGroups(request, env) {
  const { current, manifest } = await currentManifest(env);
  const url = new URL(request.url);
  const offset = boundedOffset(url, manifest.counts.groups);
  const limit = parseInteger(url.searchParams.get('limit'), 500, 1, 1000);
  const groups = await routedGroups(env, current, manifest, offset, limit);
  const nextOffset = offset + groups.length;
  return {
    publicationId: current.publicationId,
    sourceUpdatedAt: current.sourceUpdatedAt,
    categories: manifest.categories,
    groups,
    total: manifest.counts.groups,
    nextCursor: nextOffset < manifest.counts.groups ? String(nextOffset) : null
  };
}

async function groupProducts(request, env, categoryId, groupId) {
  const { current, manifest } = await currentManifest(env);
  const route = await productRoutingEntry(env, current, manifest, categoryId, groupId);
  if (!route) throw new CatalogRequestError('Catalog group was not found', 404);
  const url = new URL(request.url);
  const offset = boundedOffset(url, route.productCount);
  const limit = parseInteger(url.searchParams.get('limit'), 50, 1, 100);
  const end = Math.min(route.productCount, offset + limit);
  const products = [];
  for (const page of route.pages) {
    const pageEnd = page.start + page.count;
    if (pageEnd <= offset || page.start >= end) continue;
    const block = await readRangeJson(env, current, manifest, 'catalog', page);
    if (block?.contractVersion !== WEB_CATALOG_CONTRACT_VERSION
        || block.sourceUpdatedAt !== current.sourceUpdatedAt
        || block.category?.categoryId !== categoryId
        || block.group?.groupId !== groupId
        || !Array.isArray(block.products)
        || block.products.length !== page.count) {
      throw new Error('Catalog product page is invalid');
    }
    const localStart = Math.max(0, offset - page.start);
    const localEnd = Math.min(page.count, end - page.start);
    products.push(...block.products.slice(localStart, localEnd));
  }
  if (products.length !== end - offset) throw new Error('Catalog product pages are incomplete');
  const nextOffset = offset + products.length;
  return {
    publicationId: current.publicationId,
    sourceUpdatedAt: current.sourceUpdatedAt,
    category: manifest.categories.find((row) => row.categoryId === categoryId) || {},
    group: route.group,
    products,
    total: route.productCount,
    nextCursor: nextOffset < route.productCount ? String(nextOffset) : null
  };
}

async function productDetail(env, categoryId, groupId, productId) {
  const { current, manifest } = await currentManifest(env);
  const route = await productRoutingEntry(env, current, manifest, categoryId, groupId);
  if (!route) throw new CatalogRequestError('Catalog group was not found', 404);
  const page = route.pages.find((row) =>
    productId >= row.firstProductId && productId <= row.lastProductId);
  if (!page) throw new CatalogRequestError('Catalog product was not found', 404);
  const block = await readRangeJson(env, current, manifest, 'catalog', page);
  if (block?.contractVersion !== WEB_CATALOG_CONTRACT_VERSION
      || block.sourceUpdatedAt !== current.sourceUpdatedAt
      || block.category?.categoryId !== categoryId
      || block.group?.groupId !== groupId
      || !Array.isArray(block.products)
      || block.products.length !== page.count) {
    throw new Error('Catalog product page is invalid');
  }
  const product = block.products?.find((row) => row.productId === productId);
  if (!product) throw new CatalogRequestError('Catalog product was not found', 404);
  return {
    publicationId: current.publicationId,
    sourceUpdatedAt: current.sourceUpdatedAt,
    category: block.category,
    group: route.group,
    product
  };
}

async function catalogSearch(request, env) {
  const { current, manifest } = await currentManifest(env);
  const url = new URL(request.url);
  const query = normalizeSearchText(url.searchParams.get('q') ?? '');
  if (query.length < 3 || query.length > 120) {
    throw new CatalogRequestError('Search query must contain 3 to 120 normalized characters');
  }
  const prefix = query.split(' ').find((token) => token.length >= 3)?.slice(0, 3) || '___';
  const routeShard = await routingShard(prefix, manifest.shardCount);
  const searchRoute = manifest.routing.searchRoutes.find((route) => route.shard === routeShard);
  let pages = [];
  if (searchRoute) {
    const routing = await readRangeJson(env, current, manifest, 'routing', searchRoute);
    if (!routing?.prefixes || typeof routing.prefixes !== 'object'
        || Array.isArray(routing.prefixes)
        || Object.keys(routing.prefixes).length !== searchRoute.prefixCount) {
      throw new Error('Catalog search routing block is invalid');
    }
    pages = routing.prefixes[prefix] ?? [];
    if (!Array.isArray(pages) || pages.some((page) =>
      !Number.isSafeInteger(page?.count)
      || page.count <= 0
      || !Number.isSafeInteger(page?.length)
      || page.length <= 0
      || page.length > MAX_SEARCH_PAGE_BYTES)) {
      throw new Error('Catalog search page routing is invalid');
    }
  }
  const cursor = searchCursor(url.searchParams.get('cursor'), pages.length);
  const limit = parseInteger(url.searchParams.get('limit'), 25, 1, 50);
  const categoryId = url.searchParams.has('category_id')
    ? Number.parseInt(url.searchParams.get('category_id'), 10)
    : null;
  if (categoryId !== null && (!Number.isSafeInteger(categoryId) || categoryId <= 0)) {
    throw new CatalogRequestError('Search category is invalid');
  }
  const matchedTuples = [];
  let next = null;
  let scannedPages = 0;
  for (let pageIndex = cursor.page;
    pageIndex < pages.length && scannedPages < MAX_SEARCH_PAGES_PER_REQUEST;
    pageIndex += 1, scannedPages += 1) {
    const tuples = await readRangeJson(env, current, manifest, 'search', pages[pageIndex]);
    if (!Array.isArray(tuples)) throw new Error('Catalog search page is invalid');
    const startingRecord = pageIndex === cursor.page ? cursor.record : 0;
    for (let recordIndex = startingRecord; recordIndex < tuples.length; recordIndex += 1) {
      const tuple = tuples[recordIndex];
      const matchesCategory = categoryId === null || tuple?.[0] === categoryId;
      const searchable = normalizeSearchText(tuple?.[3], tuple?.[4], tuple?.[5]);
      if (matchesCategory && searchable.includes(query)) {
        matchedTuples.push(tuple);
      }
      if (matchedTuples.length >= limit) {
        next = recordIndex + 1 < tuples.length
          ? `${pageIndex}:${recordIndex + 1}`
          : pageIndex + 1 < pages.length
            ? `${pageIndex + 1}:0`
            : null;
        break;
      }
    }
    if (matchedTuples.length >= limit) break;
    if (pageIndex + 1 < pages.length) next = `${pageIndex + 1}:0`;
    else next = null;
  }
  const products = matchedTuples.map((tuple) => searchProduct(tuple, manifest));
  return {
    publicationId: current.publicationId,
    sourceUpdatedAt: current.sourceUpdatedAt,
    query,
    products,
    nextCursor: next
  };
}

// T5: trajectory-v1 derived-forecast publication (community-free-access,
// see analytics/manifests/tcgcsv-community-free-access-derived-forecasts.json).
// Objects under forecasts/ are pre-filtered by the analytics publisher to
// exactly the eligible (categoryId, groupId[, part]) set -- an excluded
// cohort or an unknown product was simply never uploaded, so a plain R2
// miss already gives the required "404 for non-eligible/unknown" behavior
// with no extra eligibility bookkeeping needed here.
const FORECAST_MANIFEST_KEY = 'forecasts/manifest.json';
const MAX_FORECAST_MANIFEST_BYTES = 8 * 1024 * 1024;
// T5's publisher targets <=128KiB gzip objects per part; this leaves
// headroom for the documented (flagged, never-truncated) single-variant
// oversized-part case without inviting an unbounded read.
const MAX_FORECAST_OBJECT_BYTES = 256 * 1024;
const FORECAST_ROUTE = /^\/catalog\/forecasts\/(\d+)\/(\d+(?:\.part\d+)?)$/;

function forecastRouteIdentity(pathname) {
  const match = FORECAST_ROUTE.exec(pathname);
  if (!match) return null;
  const categoryId = Number.parseInt(match[1], 10);
  if (!Number.isSafeInteger(categoryId) || categoryId <= 0) return null;
  return { categoryId, objectId: match[2] };
}

function forecastCacheHeaders(cors) {
  const headers = new Headers(cors);
  // Forecast objects are batch-published (T5 publisher runs), not
  // continuously updated -- an hour of edge freshness plus a generous
  // stale-while-revalidate window is sane for a public, immutable-per-run
  // artifact set.
  headers.set('cache-control', 'public, max-age=3600, stale-while-revalidate=86400');
  headers.set('x-content-type-options', 'nosniff');
  return headers;
}

export async function serveForecastManifest(env, cors) {
  const object = await env.TCGCSV_CURRENT.get(FORECAST_MANIFEST_KEY);
  if (!object || object.size <= 0 || object.size > MAX_FORECAST_MANIFEST_BYTES) {
    return jsonResponse({ error: 'Forecast manifest was not found' }, { status: 404, headers: cors });
  }
  const headers = forecastCacheHeaders(cors);
  headers.set('content-type', 'application/json; charset=utf-8');
  if (object.httpEtag) headers.set('etag', object.httpEtag);
  return new Response(object.body, { status: 200, headers });
}

export async function serveForecastObject(env, identity, cors) {
  const key = `forecasts/${identity.categoryId}/${identity.objectId}.json.gz`;
  const object = await env.TCGCSV_CURRENT.get(key);
  if (!object || object.size <= 0 || object.size > MAX_FORECAST_OBJECT_BYTES) {
    return jsonResponse({ error: 'Forecast object was not found' }, { status: 404, headers: cors });
  }
  const headers = forecastCacheHeaders(cors);
  headers.set('content-type', 'application/json; charset=utf-8');
  // The object is stored gzip-compressed; declaring it here (independent
  // of whatever httpMetadata the T7 uploader set) lets fetch()/browsers
  // transparently decompress it -- response.json() just works.
  headers.set('content-encoding', 'gzip');
  if (object.httpEtag) headers.set('etag', object.httpEtag);
  // encodeBody: 'manual' tells the Workers runtime the body is ALREADY
  // gzip-encoded to match the content-encoding header. Without it the
  // edge treats the body as plain, rewrites/strips content-encoding, and
  // browsers receive raw gzip bytes that response.json() cannot parse
  // (live incident 2026-08-18: every forecast/history/bridge fetch
  // failed client-side with "invalid JSON with HTTP 200").
  return new Response(object.body, { status: 200, headers, encodeBody: 'manual' });
}

// 0.8.17: TCGCSV weekly price-history publication (community-free-access,
// see analytics/manifests/tcgcsv-community-free-access-history.json -- a
// SEPARATE, explicitly-reviewed SourceTerms record from the derived-
// forecast one above: history objects republish raw TCGCSV historical
// prices, which the forecast record's community-free-access review does
// NOT cover). Objects under history/ are pre-published for every variant
// (history is observed data, no eligibility gate) -- an unknown product is
// simply absent from the manifest, mirroring the forecast route's 404
// behavior for a plain R2 miss.
const HISTORY_MANIFEST_KEY = 'history/manifest.json';
const MAX_HISTORY_MANIFEST_BYTES = 8 * 1024 * 1024;
// T5-style publisher targets <=128KiB gzip objects per part; same
// generous-but-bounded headroom as the forecast route.
const MAX_HISTORY_OBJECT_BYTES = 256 * 1024;
const HISTORY_ROUTE = /^\/catalog\/history\/(\d+)\/(\d+(?:\.part\d+)?)$/;

function historyRouteIdentity(pathname) {
  const match = HISTORY_ROUTE.exec(pathname);
  if (!match) return null;
  const categoryId = Number.parseInt(match[1], 10);
  if (!Number.isSafeInteger(categoryId) || categoryId <= 0) return null;
  return { categoryId, objectId: match[2] };
}

export async function serveHistoryManifest(env, cors) {
  const object = await env.TCGCSV_CURRENT.get(HISTORY_MANIFEST_KEY);
  if (!object || object.size <= 0 || object.size > MAX_HISTORY_MANIFEST_BYTES) {
    return jsonResponse({ error: 'History manifest was not found' }, { status: 404, headers: cors });
  }
  const headers = forecastCacheHeaders(cors);
  headers.set('content-type', 'application/json; charset=utf-8');
  if (object.httpEtag) headers.set('etag', object.httpEtag);
  return new Response(object.body, { status: 200, headers });
}

export async function serveHistoryObject(env, identity, cors) {
  const key = `history/${identity.categoryId}/${identity.objectId}.json.gz`;
  const object = await env.TCGCSV_CURRENT.get(key);
  if (!object || object.size <= 0 || object.size > MAX_HISTORY_OBJECT_BYTES) {
    return jsonResponse({ error: 'History object was not found' }, { status: 404, headers: cors });
  }
  const headers = forecastCacheHeaders(cors);
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('content-encoding', 'gzip');
  if (object.httpEtag) headers.set('etag', object.httpEtag);
  // encodeBody: 'manual' tells the Workers runtime the body is ALREADY
  // gzip-encoded to match the content-encoding header. Without it the
  // edge treats the body as plain, rewrites/strips content-encoding, and
  // browsers receive raw gzip bytes that response.json() cannot parse
  // (live incident 2026-08-18: every forecast/history/bridge fetch
  // failed client-side with "invalid JSON with HTTP 200").
  return new Response(object.body, { status: 200, headers, encodeBody: 'manual' });
}

// B2: catalog-v2 enrichment bridge (analytics/src/collectfolio_analytics/
// catalog_bridge.py). Published exactly like a forecast object -- one
// gzip JSON object per flagship categoryId, community-free-access,
// "absent == no enrichment for that category yet" (fail-closed; the app
// must never guess at a join the bridge builder didn't publish).
const MAX_BRIDGE_OBJECT_BYTES = 4 * 1024 * 1024;
const BRIDGE_ROUTE = /^\/catalog\/bridge\/(\d+)$/;

function bridgeRouteIdentity(pathname) {
  const match = BRIDGE_ROUTE.exec(pathname);
  if (!match) return null;
  const categoryId = Number.parseInt(match[1], 10);
  if (!Number.isSafeInteger(categoryId) || categoryId <= 0) return null;
  return { categoryId };
}

export async function serveBridgeObject(env, identity, cors) {
  const key = `bridge/${identity.categoryId}.json.gz`;
  const object = await env.TCGCSV_CURRENT.get(key);
  if (!object || object.size <= 0 || object.size > MAX_BRIDGE_OBJECT_BYTES) {
    return jsonResponse({ error: 'Bridge object was not found' }, { status: 404, headers: cors });
  }
  // Same batch-published, hourly-fresh cache posture as forecast objects
  // (forecastCacheHeaders) -- the bridge table is rebuilt by an analytics
  // run, not continuously updated.
  const headers = forecastCacheHeaders(cors);
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('content-encoding', 'gzip');
  if (object.httpEtag) headers.set('etag', object.httpEtag);
  // encodeBody: 'manual' tells the Workers runtime the body is ALREADY
  // gzip-encoded to match the content-encoding header. Without it the
  // edge treats the body as plain, rewrites/strips content-encoding, and
  // browsers receive raw gzip bytes that response.json() cannot parse
  // (live incident 2026-08-18: every forecast/history/bridge fetch
  // failed client-side with "invalid JSON with HTTP 200").
  return new Response(object.body, { status: 200, headers, encodeBody: 'manual' });
}

export async function serveCatalogData(request, env) {
  const url = new URL(request.url);
  if (request.method !== 'GET') throw new CatalogRequestError('Method not allowed', 405);
  if (url.pathname === '/catalog/summary') return catalogSummary(env);
  if (url.pathname === '/catalog/search') return catalogSearch(request, env);
  if (url.pathname === '/catalog/groups') return allGroups(request, env);
  const groups = groupIdentity(url.pathname, /^\/catalog\/categories\/(\d+)\/groups$/);
  if (groups) return categoryGroups(request, env, groups[0]);
  const products = groupIdentity(url.pathname, /^\/catalog\/groups\/(\d+)\/(\d+)\/products$/);
  if (products) return groupProducts(request, env, products[0], products[1]);
  const detail = groupIdentity(url.pathname, /^\/catalog\/products\/(\d+)\/(\d+)\/(\d+)$/);
  if (detail) return productDetail(env, detail[0], detail[1], detail[2]);
  throw new CatalogRequestError('Not found', 404);
}

export async function handleCatalogRequest(request, env) {
  const cors = catalogCorsHeaders(request, env);
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }
  try {
    const user = await authenticateCatalogUser(request, env);
    if (!user) return jsonResponse({ error: 'Unauthorized' }, { status: 401, headers: cors });

    // Forecast routes return raw gzip/JSON bytes with their own cache
    // headers -- they must bypass the generic jsonResponse(...) wrapping
    // that every other /catalog/* route goes through.
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/catalog/forecasts/manifest') {
      return serveForecastManifest(env, cors);
    }
    const forecastIdentity = forecastRouteIdentity(url.pathname);
    if (request.method === 'GET' && forecastIdentity) {
      return serveForecastObject(env, forecastIdentity, cors);
    }
    const bridgeIdentity = bridgeRouteIdentity(url.pathname);
    if (request.method === 'GET' && bridgeIdentity) {
      return serveBridgeObject(env, bridgeIdentity, cors);
    }

    if (request.method === 'GET' && url.pathname === '/catalog/history/manifest') {
      return serveHistoryManifest(env, cors);
    }
    const historyIdentity = historyRouteIdentity(url.pathname);
    if (request.method === 'GET' && historyIdentity) {
      return serveHistoryObject(env, historyIdentity, cors);
    }

    return jsonResponse(await serveCatalogData(request, env), { headers: cors });
  } catch (error) {
    const status = error instanceof CatalogRequestError ? error.status : 500;
    console.error(JSON.stringify({
      event: 'tcgcsv_catalog_request_failed',
      path: new URL(request.url).pathname,
      error: errorMessage(error)
    }));
    return jsonResponse({ error: status === 500 ? 'Catalog request failed' : error.message }, {
      status,
      headers: cors
    });
  }
}

export const CATALOG_CONTRACTS = Object.freeze({
  pointer: POINTER_CONTRACT_VERSION,
  publicationClaim: PUBLICATION_CLAIM_CONTRACT_VERSION,
  webCatalog: WEB_CATALOG_CONTRACT_VERSION
});
