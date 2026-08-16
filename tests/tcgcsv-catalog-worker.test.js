import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import worker from '../cloudflare/tcgcsv-refresh/src/index.js';
import {
  authenticateCatalogUser,
  catalogPublicationKey,
  catalogPublicationStatus,
  completeCatalogPublication,
  planCatalogPublication,
  serveCatalogData,
  uploadCatalogAsset
} from '../cloudflare/tcgcsv-refresh/src/catalog.js';

const SOURCE = '2026-08-15T20:05:57.000Z';
const RUN_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';

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

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

class MemoryR2 {
  constructor() {
    this.objects = new Map();
    this.sequence = 0;
  }

  record(key, stored, bodyValue = null) {
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
      }
    };
    if (bodyValue === null) return metadata;
    return {
      ...metadata,
      body: new Blob([bodyValue]).stream(),
      bodyUsed: false,
      arrayBuffer: async () => bodyValue.slice().buffer,
      text: async () => new TextDecoder().decode(bodyValue),
      json: async () => JSON.parse(new TextDecoder().decode(bodyValue)),
      blob: async () => new Blob([bodyValue])
    };
  }

  async head(key) {
    const stored = this.objects.get(key);
    return stored ? this.record(key, stored) : null;
  }

  async get(key, options = {}) {
    const stored = this.objects.get(key);
    if (!stored) return null;
    const range = options.range;
    const bodyValue = range
      ? stored.value.slice(range.offset, range.offset + range.length)
      : stored.value.slice();
    return this.record(key, stored, bodyValue);
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
    const digest = sha256(valueBytes);
    if (options.sha256 && options.sha256 !== digest) throw new Error('SHA-256 mismatch');
    const stored = {
      sequence: ++this.sequence,
      value: valueBytes,
      etag: createHash('md5').update(valueBytes).update(String(this.sequence)).digest('hex'),
      uploaded: new Date(),
      httpMetadata: options.httpMetadata ?? {},
      customMetadata: options.customMetadata ?? {}
    };
    this.objects.set(key, stored);
    return this.record(key, stored);
  }

  async delete(keys) {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key);
  }

  async list(options = {}) {
    const keys = [...this.objects.keys()]
      .filter((key) => key.startsWith(options.prefix ?? ''))
      .sort();
    const start = Number.parseInt(options.cursor ?? '0', 10);
    const limit = options.limit ?? 1000;
    const selected = keys.slice(start, start + limit);
    const next = start + selected.length;
    return {
      objects: selected.map((key) => this.record(key, this.objects.get(key))),
      truncated: next < keys.length,
      cursor: next < keys.length ? String(next) : undefined,
      delimitedPrefixes: []
    };
  }
}

function environment(bucket = new MemoryR2()) {
  return {
    TCGCSV_CURRENT: bucket,
    ALLOWED_ORIGIN: 'https://collectfolio.example',
    CATALOG_LEASE_MINUTES: '180',
    CATALOG_ALLOWED_USER_IDS: USER_ID,
    CATALOG_AUTHENTICATED_TEST_ACCESS: 'false',
    SUPABASE_URL: 'https://supabase.example',
    SUPABASE_ANON_KEY: 'public-test-key'
  };
}

function controlRequest(path, value) {
  const body = JSON.stringify(value);
  return new Request(`https://refresh.example${path}`, {
    method: 'POST',
    headers: {
      'content-length': String(Buffer.byteLength(body)),
      'content-type': 'application/json'
    },
    body
  });
}

function uploadRequest(plan, file, value) {
  const url = new URL(`https://refresh.example/v1/catalog/assets/${file}`);
  url.searchParams.set('publication_id', plan.publicationId);
  url.searchParams.set('source_updated_at', plan.sourceUpdatedAt);
  url.searchParams.set('run_id', plan.runId);
  return new Request(url, {
    method: 'PUT',
    headers: {
      'content-length': String(value.byteLength),
      'x-content-sha256': sha256(value)
    },
    body: value,
    duplex: 'half'
  });
}

async function fixture() {
  const category = {
    categoryId: 3,
    name: 'Pokemon',
    displayName: 'Pokémon',
    isCardCategory: true,
    categorySha256: 'a'.repeat(64),
    metadata: {}
  };
  const group = {
    categoryId: 3,
    groupId: 10,
    name: 'Fixture Set',
    abbreviation: 'FIX',
    publishedOn: '2026-01-01',
    modifiedOn: '2026-08-15',
    supplemental: false,
    groupSha256: 'b'.repeat(64),
    metadata: {},
    productCount: 2
  };
  const products = [
    {
      categoryId: 3,
      groupId: 10,
      productId: 100,
      name: 'Alpha Card',
      cleanName: 'Alpha Card',
      cardNumber: '001',
      rarity: 'Rare',
      cardType: 'Pokémon',
      modifiedOn: '2026-08-15',
      productSha256: 'c'.repeat(64),
      extendedData: [{ name: 'Number', value: '001' }],
      prices: [{
        subtypeName: 'Normal',
        seriesSha256: 'd'.repeat(64),
        lowPrice: '1.00',
        midPrice: '2.00',
        highPrice: '3.00',
        marketPrice: '2.50',
        directLowPrice: null,
        priceTupleSha256: 'e'.repeat(64)
      }]
    },
    {
      categoryId: 3,
      groupId: 10,
      productId: 101,
      name: 'Beta Card',
      cleanName: 'Beta Card',
      cardNumber: '002',
      rarity: 'Common',
      cardType: 'Trainer',
      modifiedOn: '2026-08-15',
      productSha256: 'f'.repeat(64),
      extendedData: [],
      prices: []
    }
  ];
  const catalogPages = products.map((product) => bytes(JSON.stringify({
    contractVersion: 'collectfolio-tcgcsv-web-catalog-v2',
    sourceUpdatedAt: SOURCE,
    category,
    group,
    products: [product]
  })));
  const catalog = new Uint8Array(catalogPages.reduce((total, page) => total + page.byteLength, 0));
  let catalogOffset = 0;
  for (const page of catalogPages) {
    catalog.set(page, catalogOffset);
    catalogOffset += page.byteLength;
  }
  const alpha = bytes(JSON.stringify([[
    3, 10, 100, 'Alpha Card', 'Alpha Card', '001', 'Rare', 'Pokémon', 'Fixture Set',
    [['Normal', '1.00', '2.00', '3.00', '2.50', null]]
  ]]));
  const beta = bytes(JSON.stringify([[
    3, 10, 101, 'Beta Card', 'Beta Card', '002', 'Common', 'Trainer', 'Fixture Set', []
  ]]));
  const search = new Uint8Array(alpha.byteLength + beta.byteLength);
  search.set(alpha, 0);
  search.set(beta, alpha.byteLength);
  const productRouting = bytes(JSON.stringify({ groups: [{
    categoryId: 3,
    groupId: 10,
    pages: catalogPages.map((page, index) => ({
      shard: 0,
      offset: index === 0 ? 0 : catalogPages[0].byteLength,
      length: page.byteLength,
      start: index,
      count: 1,
      firstProductId: products[index].productId,
      lastProductId: products[index].productId
    })),
    productCount: 2,
    priceCount: 1,
    group
  }] }));
  const categoryRouting = bytes(JSON.stringify({
    categoryId: 3,
    groups: [group]
  }));
  const groupPage = bytes(JSON.stringify({ groups: [group] }));
  const searchRouting = bytes(JSON.stringify({
    prefixes: {
      alp: [{ shard: 0, offset: 0, length: alpha.byteLength, count: 1 }],
      bet: [{ shard: 0, offset: alpha.byteLength, length: beta.byteLength, count: 1 }]
    }
  }));
  const routing = new Uint8Array(
    productRouting.byteLength + categoryRouting.byteLength + groupPage.byteLength
      + searchRouting.byteLength
  );
  let routingOffset = 0;
  for (const block of [productRouting, categoryRouting, groupPage, searchRouting]) {
    routing.set(block, routingOffset);
    routingOffset += block.byteLength;
  }
  const manifest = {
    contractVersion: 'collectfolio-tcgcsv-web-catalog-v2',
    sourceContractVersion: 'tcgcsv-market-universe-v1',
    sourceUpdatedAt: SOURCE,
    generatedAt: SOURCE,
    shardCount: 1,
    counts: {
      categories: 1,
      groups: 1,
      products: 2,
      pricedProducts: 1,
      priceSeries: 1,
      searchPrefixes: 2
    },
    categories: [category],
    routing: {
      categoryRoutes: [{
        categoryId: 3,
        groupCount: 1,
        shard: 0,
        offset: productRouting.byteLength,
        length: categoryRouting.byteLength
      }],
      groupPages: [{
        start: 0,
        count: 1,
        shard: 0,
        offset: productRouting.byteLength + categoryRouting.byteLength,
        length: groupPage.byteLength
      }],
      productRoutes: [{
        shard: 0,
        groupCount: 1,
        offset: 0,
        length: productRouting.byteLength
      }],
      searchRoutes: [{
        shard: 0,
        prefixCount: 2,
        offset: productRouting.byteLength + categoryRouting.byteLength
          + groupPage.byteLength,
        length: searchRouting.byteLength
      }]
    },
    assets: [
      { file: 'catalog-00.bin', kind: 'catalog', shard: 0, bytes: catalog.byteLength, sha256: sha256(catalog) },
      { file: 'routing-00.bin', kind: 'routing', shard: 0, bytes: routing.byteLength, sha256: sha256(routing) },
      { file: 'search-00.bin', kind: 'search', shard: 0, bytes: search.byteLength, sha256: sha256(search) }
    ]
  };
  const manifestBytes = bytes(`${JSON.stringify(manifest)}\n`);
  const plan = {
    runId: RUN_ID,
    sourceUpdatedAt: SOURCE,
    publicationId: sha256(manifestBytes),
    manifestSha256: sha256(manifestBytes),
    manifestBytes: manifestBytes.byteLength,
    assetCount: 3
  };
  return { catalog, manifestBytes, plan, routing, search };
}

async function seedPublishedRun(env) {
  await env.TCGCSV_CURRENT.put('slots/0/complete.json', JSON.stringify({
    contractVersion: 'tcgcsv-r2-refresh-v1',
    archiveDate: '2026-08-15',
    sourceUpdatedAt: SOURCE,
    slot: 0,
    runId: RUN_ID,
    completedAt: '2026-08-15T20:30:00.000Z',
    artifacts: {}
  }), { httpMetadata: { contentType: 'application/json' } });
}

async function publishFixture(env) {
  const built = await fixture();
  const planned = await planCatalogPublication(
    controlRequest('/v1/catalog/plan', built.plan),
    env,
    { now: new Date('2026-08-15T20:31:00.000Z') }
  );
  assert.equal(planned.action, 'upload');
  await uploadCatalogAsset(uploadRequest(built.plan, 'manifest.json', built.manifestBytes), env, {
    now: new Date('2026-08-15T20:32:00.000Z')
  });
  await uploadCatalogAsset(uploadRequest(built.plan, 'catalog-00.bin', built.catalog), env, {
    now: new Date('2026-08-15T20:32:00.000Z')
  });
  await uploadCatalogAsset(uploadRequest(built.plan, 'routing-00.bin', built.routing), env, {
    now: new Date('2026-08-15T20:32:00.000Z')
  });
  await uploadCatalogAsset(uploadRequest(built.plan, 'search-00.bin', built.search), env, {
    now: new Date('2026-08-15T20:32:00.000Z')
  });
  const pointer = await completeCatalogPublication(
    controlRequest('/v1/catalog/complete', built.plan),
    env,
    { now: new Date('2026-08-15T20:33:00.000Z') }
  );
  return { ...built, pointer };
}

test('catalog publications are hash-bound, complete, and atomically promoted', async () => {
  const env = environment();
  await seedPublishedRun(env);
  const published = await publishFixture(env);
  assert.equal(published.pointer.current.publicationId, published.plan.publicationId);
  assert.equal(published.pointer.current.counts.products, 2);
  assert.equal(await env.TCGCSV_CURRENT.head(
    catalogPublicationKey(published.plan.publicationId, 'manifest.json')) !== null, true);

  const duplicate = await planCatalogPublication(
    controlRequest('/v1/catalog/plan', published.plan),
    env,
    { now: new Date('2026-08-15T20:40:00.000Z') }
  );
  assert.equal(duplicate.action, 'current');
  assert.equal(duplicate.started, false);
  const status = await catalogPublicationStatus(env);
  assert.equal(status.status, 'current');
  assert.equal(status.current.counts.priceSeries, 1);
});

test('catalog completion fails closed when a manifest asset is absent', async () => {
  const env = environment();
  await seedPublishedRun(env);
  const built = await fixture();
  await planCatalogPublication(controlRequest('/v1/catalog/plan', built.plan), env, {
    now: new Date('2026-08-15T20:31:00.000Z')
  });
  await uploadCatalogAsset(uploadRequest(built.plan, 'manifest.json', built.manifestBytes), env, {
    now: new Date('2026-08-15T20:32:00.000Z')
  });
  await uploadCatalogAsset(uploadRequest(built.plan, 'catalog-00.bin', built.catalog), env, {
    now: new Date('2026-08-15T20:32:00.000Z')
  });
  await assert.rejects(
    completeCatalogPublication(controlRequest('/v1/catalog/complete', built.plan), env, {
      now: new Date('2026-08-15T20:33:00.000Z')
    }),
    /object set/
  );
});

test('signed-in catalog APIs paginate groups/products and preserve every price field', async () => {
  const env = environment();
  await seedPublishedRun(env);
  const published = await publishFixture(env);

  const summary = await serveCatalogData(new Request('https://refresh.example/catalog/summary'), env);
  assert.equal(summary.counts.products, 2);
  assert.equal(summary.publicationId, published.plan.publicationId);

  const groups = await serveCatalogData(new Request(
    'https://refresh.example/catalog/categories/3/groups?limit=1'
  ), env);
  assert.equal(groups.groups[0].name, 'Fixture Set');

  const page = await serveCatalogData(new Request(
    'https://refresh.example/catalog/groups/3/10/products?limit=1'
  ), env);
  assert.equal(page.products.length, 1);
  assert.equal(page.products[0].prices[0].marketPrice, '2.50');
  assert.equal(page.nextCursor, '1');

  const nextPage = await serveCatalogData(new Request(
    'https://refresh.example/catalog/groups/3/10/products?limit=1&cursor=1'
  ), env);
  assert.equal(nextPage.products[0].name, 'Beta Card');
  assert.equal(nextPage.nextCursor, null);

  const detail = await serveCatalogData(new Request(
    'https://refresh.example/catalog/products/3/10/101'
  ), env);
  assert.equal(detail.product.name, 'Beta Card');
  assert.deepEqual(detail.product.prices, []);

  const search = await serveCatalogData(new Request(
    'https://refresh.example/catalog/search?q=alpha&limit=5'
  ), env);
  assert.equal(search.products[0].prices[0].directLowPrice, null);
  assert.equal(search.products[0].groupName, 'Fixture Set');
});

test('catalog authentication validates Supabase users and anonymous HTTP access stays closed', async () => {
  const env = environment();
  const request = new Request('https://refresh.example/catalog/summary', {
    headers: { authorization: 'Bearer signed-user-token' }
  });
  const user = await authenticateCatalogUser(request, env, async (_url, init) => {
    assert.equal(init.headers.apikey, env.SUPABASE_ANON_KEY);
    assert.equal(init.headers.authorization, 'Bearer signed-user-token');
    return Response.json({ id: USER_ID });
  });
  assert.deepEqual(user, { id: USER_ID });

  const anonymous = await worker.fetch(
    new Request('https://refresh.example/catalog/summary'),
    env
  );
  assert.equal(anonymous.status, 401);
  assert.deepEqual(await anonymous.json(), { error: 'Unauthorized' });
});
