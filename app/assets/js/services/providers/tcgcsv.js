import { validSession } from '../supabase.js';
import { tcgcsvProductImageUrl } from '../../core/catalog-images.js';

export { tcgcsvProductImageUrl } from '../../core/catalog-images.js';

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_SEARCH_RESULTS = 200;
const PRIVATE_TEST_ENTITLEMENT = 'authenticated-private-test';
const FREE_ACCESS_ENTITLEMENT = 'community-free-access';
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
  if (!configured) throw new Error('The card catalog is not configured on this site.');
  let url;
  try {
    url = new URL(configured);
  } catch {
    throw new Error('The card catalog URL is invalid.');
  }
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) {
    throw new Error('The card catalog must use HTTPS.');
  }
  return url;
}

// Free community access: a signed-in session is attached when present so
// deployments that still gate the catalog keep working, but browsing never
// requires one.
async function catalogSession() {
  try {
    return await validSession();
  } catch {
    return null;
  }
}

async function boundedJson(response) {
  const declared = Number.parseInt(response.headers.get('content-length') ?? '', 10);
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new Error('The card catalog response exceeded its browser limit.');
  }
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
    throw new Error('The card catalog response exceeded its browser limit.');
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`The card catalog returned invalid JSON with HTTP ${response.status}.`);
  }
  if (!response.ok) {
    const message = response.status === 401
      ? 'This catalog deployment still requires sign-in.'
      : value?.error || `The card catalog request failed with HTTP ${response.status}.`;
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
  const url = new URL(path, catalogBaseUrl());
  Object.entries(params).forEach(([key, value]) => {
    if (value !== '' && value !== null && value !== undefined) url.searchParams.set(key, String(value));
  });
  const headers = { accept: 'application/json' };
  if (activeSession?.access_token) headers.authorization = `Bearer ${activeSession.access_token}`;
  const response = await fetchImpl(url, {
    headers,
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

const TCGCSV_GAME_PATTERN = /^tcgcsv-category-(\d+)$/;
const KNOWN_CATEGORY_NAMES = Object.freeze({
  1: 'Magic: The Gathering',
  2: 'YuGiOh',
  3: 'Pokemon',
  85: 'Pokemon Japan'
});

export function tcgcsvGameId(categoryId) {
  const id = Number(categoryId);
  return Number.isSafeInteger(id) && id > 0 ? `tcgcsv-category-${id}` : '';
}

export function tcgcsvCategoryId(gameId) {
  const match = TCGCSV_GAME_PATTERN.exec(String(gameId || ''));
  const categoryId = Number.parseInt(match?.[1] ?? '', 10);
  return match && Number.isSafeInteger(categoryId) && categoryId > 0 ? categoryId : null;
}

export function tcgcsvCategory(categoryId, categoryName = '') {
  const id = Number(categoryId);
  const category = tcgcsvGameId(id);
  return {
    category,
    game: String(categoryName || KNOWN_CATEGORY_NAMES[id] || `Game category ${id}`)
  };
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
      ? 'Market pricing unavailable'
      : `Market price · ${preferred.label}`,
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
  const extendedImage = imageFromExtendedData(product);
  const image = extendedImage || tcgcsvProductImageUrl(productId, 1000);
  const imageSmall = extendedImage || tcgcsvProductImageUrl(productId, 400);
  const setName = group.name || product.groupName || '';
  const releasedAt = group.publishedOn || '';
  const externalId = `${categoryId}:${groupId}:${productId}`;
  return {
    id: `tcgcsv:${externalId}`,
    externalId,
    provider: 'tcgcsv',
    pricingEntitlement: FREE_ACCESS_ENTITLEMENT,
    category: mapped.category,
    game: mapped.game,
    name: product.name || product.cleanName || `Product ${productId}`,
    cleanName: product.cleanName || product.name || '',
    setName,
    setCode: group.abbreviation || '',
    number: product.cardNumber || extendedValue(product, ['number', 'card number']),
    variant: preferred?.finish || priceOptions[0]?.finish || '',
    rarity: product.rarity || extendedValue(product, ['rarity']),
    cardType: product.cardType || extendedValue(product, ['card type']),
    year: String(releasedAt).slice(0, 4),
    image,
    imageSmall,
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
    gameId: tcgcsvGameId(categoryId),
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
  fetchImpl,
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
      session,
      fetchImpl
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

export async function listTCGCSVCategories({ session, fetchImpl } = {}) {
  const payload = await requestTCGCSVCatalog('/catalog/summary', { session, fetchImpl });
  return Array.isArray(payload?.categories) ? payload.categories : [];
}

export async function listTCGCSVGroups({ categoryId = null, session, fetchImpl } = {}) {
  const activeSession = session || await catalogSession();
  const scopedCategoryId = categoryId === null ? null : Number(categoryId);
  if (scopedCategoryId !== null && (!Number.isSafeInteger(scopedCategoryId) || scopedCategoryId <= 0)) {
    throw new Error('This catalog category identifier is invalid.');
  }
  const path = scopedCategoryId === null
    ? '/catalog/groups'
    : `/catalog/categories/${scopedCategoryId}/groups`;
  const { payload, rows } = await collectPages(path, { limit: scopedCategoryId === null ? 500 : 200 }, {
    session: activeSession,
    fetchImpl,
    itemKey: 'groups'
  });
  const categories = scopedCategoryId === null
    ? (Array.isArray(payload?.categories) ? payload.categories : [])
    : (payload?.category ? [payload.category] : []);
  const groups = rows.map((group) => normalizeTCGCSVGroup(group, categories))
    .filter((group) => group && (scopedCategoryId === null || group.categoryId === scopedCategoryId));
  return {
    categories,
    groups,
    publicationId: payload?.publicationId || '',
    sourceUpdatedAt: payload?.sourceUpdatedAt || ''
  };
}

function groupIdentity(setId) {
  const match = /^(\d+):(\d+)$/.exec(String(setId || ''));
  const categoryId = Number.parseInt(match?.[1] ?? '', 10);
  const groupId = Number.parseInt(match?.[2] ?? '', 10);
  if (!match || !Number.isSafeInteger(categoryId) || !Number.isSafeInteger(groupId)) {
    throw new Error('This catalog group identifier is invalid.');
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

// Fetch exactly one catalog page so set browsing can become interactive
// without downloading and enriching every product in a large group first.
export async function getTCGCSVGroupProductsPage(setId, {
  cursor = '',
  limit = 24,
  session,
  fetchImpl
} = {}) {
  const { categoryId, groupId } = groupIdentity(setId);
  const pageLimit = Math.max(1, Math.min(100, Number.parseInt(limit, 10) || 24));
  const payload = await requestTCGCSVCatalog(
    `/catalog/groups/${categoryId}/${groupId}/products`,
    { params: { limit: pageLimit, cursor }, session, fetchImpl }
  );
  const rows = Array.isArray(payload?.products) ? payload.products : [];
  const products = rows.map((product) => normalizeTCGCSVProduct(product, {
    category: payload?.category,
    group: payload?.group,
    publicationId: payload?.publicationId,
    sourceUpdatedAt: payload?.sourceUpdatedAt
  })).filter(Boolean);
  const declaredTotal = Number(payload?.total);
  return {
    products,
    total: Number.isSafeInteger(declaredTotal) && declaredTotal >= 0 ? declaredTotal : products.length,
    nextCursor: payload?.nextCursor === null || payload?.nextCursor === undefined
      ? ''
      : String(payload.nextCursor)
  };
}

// One bounded request (no pagination) — enough to choose a set cover image
// without paying the full multi-page product download per set.
export async function getTCGCSVGroupProductsSample(setId, { limit = 100, session, fetchImpl } = {}) {
  const { categoryId, groupId } = groupIdentity(setId);
  const payload = await requestTCGCSVCatalog(
    `/catalog/groups/${categoryId}/${groupId}/products`,
    { params: { limit }, session, fetchImpl }
  );
  const rows = Array.isArray(payload?.products) ? payload.products : [];
  return rows.map((product) => normalizeTCGCSVProduct(product, {
    category: payload?.category,
    group: payload?.group,
    publicationId: payload?.publicationId,
    sourceUpdatedAt: payload?.sourceUpdatedAt
  })).filter(Boolean);
}

export function searchTCGCSVCategoryIds(category) {
  const scopedCategoryId = tcgcsvCategoryId(category);
  if (scopedCategoryId !== null) return [scopedCategoryId];
  if (category === 'magic') return [1];
  if (category === 'yugioh') return [2];
  if (category === 'pokemon') return [3, 85];
  return [null];
}

async function searchCategory(query, categoryId, session, fetchImpl) {
  const { payload, rows } = await collectPages('/catalog/search', {
    q: query,
    limit: 50,
    category_id: categoryId
  }, {
    session,
    fetchImpl,
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

export async function searchTCGCSV(query, { category = 'all', session, fetchImpl } = {}) {
  if (String(query || '').trim().length < 3) return [];
  const activeSession = session || await catalogSession();
  const results = (await Promise.all(searchTCGCSVCategoryIds(category).map((categoryId) =>
    searchCategory(String(query || '').trim(), categoryId, activeSession, fetchImpl)))).flat();
  return [...new Map(results.map((item) => [item.externalId, item])).values()]
    .slice(0, MAX_SEARCH_RESULTS);
}

export async function getTCGCSVProduct(externalId) {
  const match = /^(\d+):(\d+):(\d+)$/.exec(String(externalId || ''));
  if (!match) throw new Error('This catalog product identifier is invalid.');
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
export const TCGCSV_FREE_ACCESS_ENTITLEMENT = FREE_ACCESS_ENTITLEMENT;
