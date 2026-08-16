import { validSession } from '../supabase.js';

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_SEARCH_RESULTS = 200;
const PRIVATE_TEST_ENTITLEMENT = 'authenticated-private-test';
const PRICE_FIELDS = Object.freeze([
  ['marketPrice', 'market'],
  ['midPrice', 'mid'],
  ['lowPrice', 'low'],
  ['directLowPrice', 'direct low'],
  ['highPrice', 'high']
]);

function config() {
  return globalThis.window?.COLLECTFOLIO_CONFIG || {};
}

function catalogBaseUrl() {
  const configured = String(config().TCGCSV_CATALOG_URL ?? '').trim();
  if (!configured) throw new Error('The full TCGCSV test catalog is not configured on this site.');
  let url;
  try {
    url = new URL(configured);
  } catch {
    throw new Error('The full TCGCSV test catalog URL is invalid.');
  }
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) {
    throw new Error('The full TCGCSV test catalog must use HTTPS.');
  }
  return url;
}

async function catalogSession() {
  try {
    return await validSession();
  } catch {
    throw new Error('Sign in to use the full TCGCSV test catalog.');
  }
}

async function boundedJson(response) {
  const declared = Number.parseInt(response.headers.get('content-length') ?? '', 10);
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new Error('The full catalog response exceeded its browser limit.');
  }
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
    throw new Error('The full catalog response exceeded its browser limit.');
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`The full catalog returned invalid JSON with HTTP ${response.status}.`);
  }
  if (!response.ok) {
    const message = response.status === 401
      ? 'Sign in to use the full TCGCSV test catalog.'
      : value?.error || `The full catalog request failed with HTTP ${response.status}.`;
    throw new Error(message);
  }
  return value;
}

export async function requestTCGCSVCatalog(path, {
  params = {},
  session,
  fetchImpl = globalThis.fetch
} = {}) {
  const activeSession = session || await catalogSession();
  if (!activeSession?.access_token) throw new Error('Sign in to use the full TCGCSV test catalog.');
  const url = new URL(path, catalogBaseUrl());
  Object.entries(params).forEach(([key, value]) => {
    if (value !== '' && value !== null && value !== undefined) url.searchParams.set(key, String(value));
  });
  const response = await fetchImpl(url, {
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${activeSession.access_token}`
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  return boundedJson(response);
}

function finitePrice(value) {
  if (value === '' || value === null || value === undefined || !Number.isFinite(Number(value))) return null;
  return Math.max(0, Number(value));
}

export function preferredTCGCSVPrice(price = {}) {
  for (const [field, label] of PRICE_FIELDS) {
    const value = finitePrice(price?.[field]);
    if (value !== null) return { field, label, value };
  }
  return { field: '', label: '', value: null };
}

export function tcgcsvCategory(categoryId, categoryName = '') {
  const id = Number(categoryId);
  if (id === 1) return { category: 'magic', game: 'Magic: The Gathering' };
  if (id === 2) return { category: 'yugioh', game: 'Yu-Gi-Oh!' };
  if (id === 3 || id === 85) return { category: 'pokemon', game: 'Pokémon' };
  return { category: 'full-catalog', game: String(categoryName || `TCGCSV category ${id}`) };
}

function extendedValue(product, names) {
  const expected = new Set(names.map((name) => name.toLowerCase()));
  return (Array.isArray(product?.extendedData) ? product.extendedData : [])
    .find((entry) => expected.has(String(entry?.name || entry?.displayName || '').toLowerCase()))?.value || '';
}

function imageFromExtendedData(product) {
  const value = String(extendedValue(product, ['image', 'image url', 'imageurl', 'photo', 'front image']));
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
}

function normalizedPriceOption(row = {}) {
  const preferred = preferredTCGCSVPrice(row);
  return {
    finish: String(row.subtypeName || 'Unspecified'),
    price: preferred.value,
    source: preferred.value === null
      ? 'TCGCSV authenticated private test · price unavailable'
      : `TCGCSV authenticated private test · ${preferred.label}`,
    selectedField: preferred.field,
    lowPrice: finitePrice(row.lowPrice),
    midPrice: finitePrice(row.midPrice),
    highPrice: finitePrice(row.highPrice),
    marketPrice: finitePrice(row.marketPrice),
    directLowPrice: finitePrice(row.directLowPrice),
    seriesSha256: String(row.seriesSha256 || ''),
    priceTupleSha256: String(row.priceTupleSha256 || '')
  };
}

export function normalizeTCGCSVProduct(product = {}, {
  category = {},
  group = {},
  publicationId = '',
  sourceUpdatedAt = ''
} = {}) {
  const categoryId = Number(product.categoryId ?? category.categoryId);
  const groupId = Number(product.groupId ?? group.groupId);
  const productId = Number(product.productId);
  if (![categoryId, groupId, productId].every((value) => Number.isSafeInteger(value) && value > 0)) {
    return null;
  }
  const categoryName = category.displayName || category.name || product.categoryName || '';
  const mapped = tcgcsvCategory(categoryId, categoryName);
  const rawPrices = Array.isArray(product.prices) ? product.prices : [];
  const priceOptions = rawPrices.map(normalizedPriceOption);
  const preferred = priceOptions.find((option) => option.price !== null) || null;
  const image = imageFromExtendedData(product);
  const setName = group.name || product.groupName || '';
  const releasedAt = group.publishedOn || '';
  const externalId = `${categoryId}:${groupId}:${productId}`;
  return {
    id: `tcgcsv:${externalId}`,
    externalId,
    provider: 'tcgcsv',
    pricingEntitlement: PRIVATE_TEST_ENTITLEMENT,
    category: mapped.category,
    game: mapped.game,
    name: product.name || product.cleanName || `TCGCSV product ${productId}`,
    cleanName: product.cleanName || product.name || '',
    setName,
    setCode: group.abbreviation || '',
    number: product.cardNumber || extendedValue(product, ['number', 'card number']),
    variant: preferred?.finish || priceOptions[0]?.finish || '',
    rarity: product.rarity || extendedValue(product, ['rarity']),
    cardType: product.cardType || extendedValue(product, ['card type']),
    year: String(releasedAt).slice(0, 4),
    image,
    imageSmall: image,
    price: preferred?.price ?? null,
    priceOptions,
    currency: 'USD',
    priceSource: preferred?.source || '',
    priceUrl: '',
    priceUpdatedAt: sourceUpdatedAt || product.modifiedOn || '',
    pricingStatus: preferred ? 'delayed' : 'unavailable',
    categoryId,
    groupId,
    productId,
    publicationId,
    sourceUpdatedAt,
    modifiedOn: product.modifiedOn || '',
    productSha256: product.productSha256 || '',
    extendedData: Array.isArray(product.extendedData) ? product.extendedData : [],
    tcgcsvPrices: rawPrices,
    tcgcsvGroup: group,
    tcgcsvCategory: category
  };
}

export function normalizeTCGCSVGroup(group = {}, categories = []) {
  const categoryId = Number(group.categoryId);
  const groupId = Number(group.groupId);
  if (![categoryId, groupId].every((value) => Number.isSafeInteger(value) && value > 0)) return null;
  const category = categories.find((row) => Number(row.categoryId) === categoryId) || {};
  const categoryName = category.displayName || category.name || `Category ${categoryId}`;
  const externalId = `${categoryId}:${groupId}`;
  const cardCount = Number(group.productCount);
  return {
    id: `tcgcsv:${externalId}`,
    externalId,
    provider: 'tcgcsv',
    gameId: 'tcgcsv',
    game: categoryName,
    name: group.name || `TCGCSV group ${groupId}`,
    code: group.abbreviation || String(groupId),
    series: categoryName,
    releasedAt: group.publishedOn || '',
    year: String(group.publishedOn || '').slice(0, 4),
    productCount: Number.isFinite(cardCount) ? cardCount : null,
    cardCount: Number.isFinite(cardCount) ? cardCount : null,
    setType: group.supplemental ? 'supplemental' : 'catalog group',
    supplemental: Boolean(group.supplemental),
    categoryId,
    groupId,
    groupSha256: group.groupSha256 || '',
    modifiedOn: group.modifiedOn || '',
    metadata: group.metadata || {}
  };
}

async function collectPages(path, params, {
  session,
  itemKey,
  maximum = 100_000
} = {}) {
  const rows = [];
  const seenCursors = new Set();
  let cursor = '';
  let last = null;
  while (rows.length < maximum) {
    const payload = await requestTCGCSVCatalog(path, {
      params: { ...params, cursor },
      session
    });
    last = payload;
    const page = Array.isArray(payload?.[itemKey]) ? payload[itemKey] : [];
    rows.push(...page.slice(0, maximum - rows.length));
    const next = String(payload?.nextCursor || '');
    if (!next || seenCursors.has(next)) break;
    seenCursors.add(next);
    cursor = next;
  }
  return { payload: last, rows };
}

export async function listTCGCSVGroups() {
  const session = await catalogSession();
  const { payload, rows } = await collectPages('/catalog/groups', { limit: 500 }, {
    session,
    itemKey: 'groups'
  });
  const categories = Array.isArray(payload?.categories) ? payload.categories : [];
  return rows.map((group) => normalizeTCGCSVGroup(group, categories)).filter(Boolean);
}

function groupIdentity(setId) {
  const match = /^(\d+):(\d+)$/.exec(String(setId || ''));
  const categoryId = Number.parseInt(match?.[1] ?? '', 10);
  const groupId = Number.parseInt(match?.[2] ?? '', 10);
  if (!match || !Number.isSafeInteger(categoryId) || !Number.isSafeInteger(groupId)) {
    throw new Error('This TCGCSV catalog group identifier is invalid.');
  }
  return { categoryId, groupId };
}

export async function getTCGCSVGroupProducts(setId) {
  const { categoryId, groupId } = groupIdentity(setId);
  const session = await catalogSession();
  const { payload, rows } = await collectPages(
    `/catalog/groups/${categoryId}/${groupId}/products`,
    { limit: 100 },
    { session, itemKey: 'products' }
  );
  return rows.map((product) => normalizeTCGCSVProduct(product, {
    category: payload?.category,
    group: payload?.group,
    publicationId: payload?.publicationId,
    sourceUpdatedAt: payload?.sourceUpdatedAt
  })).filter(Boolean);
}

function searchCategoryIds(category) {
  if (category === 'magic') return [1];
  if (category === 'yugioh') return [2];
  if (category === 'pokemon') return [3, 85];
  return [null];
}

async function searchCategory(query, categoryId, session) {
  const { payload, rows } = await collectPages('/catalog/search', {
    q: query,
    limit: 50,
    category_id: categoryId
  }, {
    session,
    itemKey: 'products',
    maximum: MAX_SEARCH_RESULTS
  });
  return rows.map((product) => normalizeTCGCSVProduct(product, {
    category: {
      categoryId: product.categoryId,
      displayName: product.categoryName
    },
    group: {
      categoryId: product.categoryId,
      groupId: product.groupId,
      name: product.groupName
    },
    publicationId: payload?.publicationId,
    sourceUpdatedAt: payload?.sourceUpdatedAt
  })).filter(Boolean);
}

export async function searchTCGCSV(query, { category = 'all' } = {}) {
  if (String(query || '').trim().length < 3) return [];
  const session = await catalogSession();
  const results = (await Promise.all(searchCategoryIds(category).map((categoryId) =>
    searchCategory(String(query || '').trim(), categoryId, session)))).flat();
  return [...new Map(results.map((item) => [item.externalId, item])).values()]
    .slice(0, MAX_SEARCH_RESULTS);
}

export async function getTCGCSVProduct(externalId) {
  const match = /^(\d+):(\d+):(\d+)$/.exec(String(externalId || ''));
  if (!match) throw new Error('This TCGCSV product identifier is invalid.');
  const [categoryId, groupId, productId] = match.slice(1).map(Number);
  const payload = await requestTCGCSVCatalog(
    `/catalog/products/${categoryId}/${groupId}/${productId}`
  );
  return normalizeTCGCSVProduct(payload.product, {
    category: payload.category,
    group: payload.group,
    publicationId: payload.publicationId,
    sourceUpdatedAt: payload.sourceUpdatedAt
  });
}

export const TCGCSV_PRIVATE_TEST_ENTITLEMENT = PRIVATE_TEST_ENTITLEMENT;
