import { holdingCostBasis, holdingCostCurrency, holdingMarketCurrency, holdingMarketValue, snapshotFor, unitMarketValue } from './calculations.js';
import { catalogReferenceForItem } from './catalog-identity.js';
import { catalogPriceDisclosure } from './pricing-policy.js';
import { appendOnlyLocalObservation, localObservationForHolding } from './local-scenarios.js';
import { createId, csvCell } from './utils.js';

const NAME = 'collectfolio';
const VERSION = 6;
const moneyCurrency = (value, fallback = 'USD') => {
  const normalized = String(value || '').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(normalized) ? normalized : fallback;
};
const STORE_CONFIG = {
  holdings: { keyPath: 'id' },
  snapshots: { keyPath: 'id' },
  settings: { keyPath: 'key' },
  scans: { keyPath: 'id' },
  catalogCache: { keyPath: 'key' },
  deletions: { keyPath: 'id' },
  watchlistItems: { keyPath: 'id' },
  watchlistDeletions: { keyPath: 'id' },
  intelligenceCache: { keyPath: 'key' },
  localValueObservations: { keyPath: 'id' },
  alerts: { keyPath: 'id' },
  // Private, limited-retention outbox for first-party demand signals
  // (PRD Sec 15.7). Entries are deleted locally once synced.
  demandEventsQueue: { keyPath: 'id' }
};
export const STORES = Object.keys(STORE_CONFIG);
let databasePromise;

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.addEventListener('success', () => resolve(request.result), { once: true });
    request.addEventListener('error', () => reject(request.error), { once: true });
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.addEventListener('complete', resolve, { once: true });
    transaction.addEventListener('abort', () => reject(transaction.error), { once: true });
    transaction.addEventListener('error', () => reject(transaction.error), { once: true });
  });
}

export function openDatabase() {
  if (!globalThis.indexedDB) return Promise.reject(new Error('IndexedDB is unavailable in this browser.'));
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(NAME, VERSION);
    request.addEventListener('upgradeneeded', (event) => {
      const db = request.result;
      if (!db.objectStoreNames.contains('holdings')) {
        const holdings = db.createObjectStore('holdings', { keyPath: 'id' });
        holdings.createIndex('catalogId', 'catalogId', { unique: false });
        holdings.createIndex('updatedAt', 'updatedAt', { unique: false });
      } else {
        const holdings = request.transaction.objectStore('holdings');
        if (!holdings.indexNames.contains('catalogId')) holdings.createIndex('catalogId', 'catalogId', { unique: false });
        if (!holdings.indexNames.contains('updatedAt')) holdings.createIndex('updatedAt', 'updatedAt', { unique: false });
      }
      for (const store of STORES.filter((name) => name !== 'holdings')) {
        if (!db.objectStoreNames.contains(store)) db.createObjectStore(store, STORE_CONFIG[store]);
      }
      if (event.oldVersion < 6 && db.objectStoreNames.contains('scans')) {
        const cursorRequest = request.transaction.objectStore('scans').openCursor();
        cursorRequest.addEventListener('success', () => {
          const cursor = cursorRequest.result;
          if (!cursor) return;
          const clean = scanWithoutSourcePhoto(cursor.value);
          cursor.update(clean);
          cursor.continue();
        });
      }
      const watchlist = request.transaction.objectStore('watchlistItems');
      if (!watchlist.indexNames.contains('watchKey')) watchlist.createIndex('watchKey', 'watchKey', { unique: true });
      if (!watchlist.indexNames.contains('updatedAt')) watchlist.createIndex('updatedAt', 'updatedAt', { unique: false });
      if (!watchlist.indexNames.contains('canonicalVariantId')) watchlist.createIndex('canonicalVariantId', 'canonicalVariantId', { unique: false });
      const alerts = request.transaction.objectStore('alerts');
      if (!alerts.indexNames.contains('triggeredAt')) alerts.createIndex('triggeredAt', 'triggeredAt', { unique: false });
      const localObservations = request.transaction.objectStore('localValueObservations');
      if (!localObservations.indexNames.contains('subjectId')) localObservations.createIndex('subjectId', 'subjectId', { unique: false });
      if (!localObservations.indexNames.contains('observedAt')) localObservations.createIndex('observedAt', 'observedAt', { unique: false });
      // Version 5 is additive. Seed one truthful current-value anchor for each
      // legacy holding inside the upgrade transaction; no historical values are
      // invented and every existing store remains untouched.
      if (event.oldVersion > 0 && event.oldVersion < 5) {
        const observedAt = new Date().toISOString();
        const holdings = request.transaction.objectStore('holdings');
        const cursorRequest = holdings.openCursor();
        cursorRequest.addEventListener('success', () => {
          const cursor = cursorRequest.result;
          if (!cursor) return;
          const observation = localObservationForHolding(cursor.value, observedAt);
          if (observation) localObservations.put(observation);
          cursor.continue();
        });
      }
    });
    request.addEventListener('success', () => resolve(request.result), { once: true });
    request.addEventListener('error', () => reject(request.error), { once: true });
  });
  return databasePromise;
}

export async function getAll(storeName) {
  const db = await openDatabase();
  return requestResult(db.transaction(storeName).objectStore(storeName).getAll());
}

export async function getRecord(storeName, key) {
  const db = await openDatabase();
  return requestResult(db.transaction(storeName).objectStore(storeName).get(key));
}

export async function putRecord(storeName, value) {
  const db = await openDatabase();
  const transaction = db.transaction(storeName, 'readwrite');
  transaction.objectStore(storeName).put(value);
  await transactionDone(transaction);
  return value;
}

// Atomically claims a single-device setting. Concurrent tabs cannot each
// observe an empty owner and bind the same local collection to different
// cloud accounts before either write commits.
export async function claimSettingValue(key, value) {
  const db = await openDatabase();
  const transaction = db.transaction('settings', 'readwrite');
  const done = transactionDone(transaction);
  const store = transaction.objectStore('settings');
  const existing = await requestResult(store.get(key));
  const claimed = existing?.value || value;
  if (!existing?.value) store.put({ key, value });
  await done;
  return claimed;
}

export async function putRecordClearingTombstone(storeName, tombstoneStoreName, value, obsoleteKey = null) {
  const db = await openDatabase();
  const transaction = db.transaction([storeName, tombstoneStoreName], 'readwrite');
  if (obsoleteKey && obsoleteKey !== value.id) transaction.objectStore(storeName).delete(obsoleteKey);
  transaction.objectStore(storeName).put(value);
  transaction.objectStore(tombstoneStoreName).delete(value.id);
  await transactionDone(transaction);
  return value;
}

export async function deleteRecord(storeName, key) {
  const db = await openDatabase();
  const transaction = db.transaction(storeName, 'readwrite');
  transaction.objectStore(storeName).delete(key);
  await transactionDone(transaction);
}

export async function deleteRecords(storeName, keys = []) {
  const unique = [...new Set((Array.isArray(keys) ? keys : []).filter((key) => key !== undefined && key !== null))];
  if (!unique.length) return 0;
  const db = await openDatabase();
  const transaction = db.transaction(storeName, 'readwrite');
  const store = transaction.objectStore(storeName);
  for (const key of unique) store.delete(key);
  await transactionDone(transaction);
  return unique.length;
}

export async function deleteRecordWithTombstone(storeName, tombstoneStoreName, key, deletedAt = new Date().toISOString(), tombstoneKey = key) {
  const db = await openDatabase();
  const transaction = db.transaction([storeName, tombstoneStoreName], 'readwrite');
  transaction.objectStore(storeName).delete(key);
  transaction.objectStore(tombstoneStoreName).put({ id: tombstoneKey, deletedAt, dirty: true });
  await transactionDone(transaction);
}

export async function saveHolding(input) {
  const now = new Date().toISOString();
  const conditionClass = input.grade ? 'graded' : 'raw';
  const confirmedMarketCondition = conditionClass === 'graded'
    ? `${input.gradeCompany || 'unknown'}-${input.grade || 'ungraded'}`
    : input.marketCondition || '';
  const catalogRef = catalogReferenceForItem(input.item, {
    canonicalVariantId: input.canonicalVariantId || input.catalogVariantId,
    conditionClass,
    marketCondition: confirmedMarketCondition
  });
  const holding = {
    id: input.id || createId(),
    catalogId: input.catalogId || `${input.item?.provider || 'custom'}:${input.item?.externalId || createId()}`,
    catalogKey: input.catalogKey || catalogRef.watchKey,
    canonicalVariantId: catalogRef.canonicalVariantId,
    item: { ...input.item },
    quantity: Math.max(1, Number(input.quantity) || 1),
    condition: input.condition || 'Near Mint',
    marketCondition: catalogRef.marketCondition,
    gradeCompany: input.gradeCompany || '',
    grade: input.grade || '',
    purchasePrice: input.purchasePrice === '' ? '' : Math.max(0, Number(input.purchasePrice) || 0),
    purchaseCurrency: moneyCurrency(input.purchaseCurrency || input.costCurrency || input.currency || input.item?.currency),
    purchaseDate: input.purchaseDate || '',
    fees: input.fees === '' ? '' : Math.max(0, Number(input.fees) || 0),
    manualMarketPrice: input.manualMarketPrice === '' || input.manualMarketPrice === undefined ? '' : Math.max(0, Number(input.manualMarketPrice) || 0),
    manualMarketCurrency: moneyCurrency(input.manualMarketCurrency || input.valueCurrency || input.currency || input.purchaseCurrency || input.item?.currency),
    seller: String(input.seller || '').trim().slice(0, 160),
    folder: input.folder || '',
    tags: [...new Set((Array.isArray(input.tags) ? input.tags : String(input.tags || '').split(','))
      .map((tag) => String(tag).trim().slice(0, 48)).filter(Boolean))].slice(0, 24),
    notes: input.notes || '',
    userImage: input.userImage || '',
    createdAt: input.createdAt || now,
    updatedAt: now,
    lastPriceRefresh: input.lastPriceRefresh || '',
    dirty: true
  };
  const observation = localObservationForHolding(holding, now);
  const db = await openDatabase();
  const stores = observation ? ['holdings', 'localValueObservations'] : ['holdings'];
  const transaction = db.transaction(stores, 'readwrite');
  const done = transactionDone(transaction);
  transaction.objectStore('holdings').put(holding);
  if (observation) await appendLocalObservation(transaction.objectStore('localValueObservations'), observation);
  await done;
  await recordDailySnapshot();
  return holding;
}

export async function recordLocalHoldingObservations(holdings = [], observedAt = new Date().toISOString()) {
  const observations = (Array.isArray(holdings) ? holdings : [])
    .map((holding) => localObservationForHolding(holding, observedAt))
    .filter(Boolean);
  if (!observations.length) return [];
  const db = await openDatabase();
  const transaction = db.transaction('localValueObservations', 'readwrite');
  const done = transactionDone(transaction);
  const store = transaction.objectStore('localValueObservations');
  const appended = [];
  for (const observation of observations) {
    const revision = await appendLocalObservation(store, observation);
    if (revision) appended.push(revision);
  }
  await done;
  return appended;
}

async function appendLocalObservation(store, observation) {
  const existing = await requestResult(store.index('subjectId').getAll(observation.subjectId));
  const revision = appendOnlyLocalObservation(existing, observation,
    `local-value:v1:${encodeURIComponent(observation.subjectId)}:${observation.source}:${observation.observedAt}:${createId()}`);
  if (revision) store.add(revision);
  return revision;
}

export async function removeHolding(id) {
  const now = new Date().toISOString();
  const db = await openDatabase();
  const transaction = db.transaction(['holdings', 'deletions'], 'readwrite');
  transaction.objectStore('holdings').delete(id);
  transaction.objectStore('deletions').put({ id, deletedAt: now, dirty: true });
  await transactionDone(transaction);
  await recordDailySnapshot();
}

export async function recordDailySnapshot(date = new Date()) {
  const [holdings, currencyRecord] = await Promise.all([
    getAll('holdings'),
    getRecord('settings', 'currency').catch(() => null)
  ]);
  return putRecord('snapshots', snapshotFor(holdings, date, { currency: currencyRecord?.value || 'USD' }));
}

// The demand outbox is a private, limited-retention telemetry queue tied to a
// signed-in user ID; a portable interchange file must not carry it between
// devices or users, and imports must not be able to inject events into it.
export const BACKUP_EXCLUDED_STORES = Object.freeze(['demandEventsQueue']);
export const MAX_BACKUP_FILE_BYTES = 128 * 1024 * 1024;
const BACKUP_VERSIONS = Object.freeze([1, 2]);
const BACKUP_RECORD_LIMIT = 100_000;

function plainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function scanWithoutSourcePhoto(record) {
  const clean = { ...(record || {}) };
  delete clean.sourceImage;
  delete clean.sourceImageRetainedAt;
  delete clean.sourceImageDeletedAt;
  return clean;
}

const optionalString = (value) => value === undefined || typeof value === 'string';
const optionalBoolean = (value) => value === undefined || typeof value === 'boolean';
const optionalFinite = (value) => value === undefined || value === null || value === ''
  || (typeof value === 'number' && Number.isFinite(value));
const optionalPlain = (value) => value === undefined || value === null || plainRecord(value);
const stringArray = (value) => Array.isArray(value) && value.every((entry) => typeof entry === 'string');
const plainArray = (value) => Array.isArray(value) && value.every(plainRecord);

function validCatalogItem(item) {
  if (!plainRecord(item)) return false;
  const stringFields = [
    'id', 'externalId', 'provider', 'category', 'game', 'name', 'setName', 'number',
    'variant', 'rarity', 'year', 'image', 'imageSmall', 'currency', 'priceSource',
    'priceUrl', 'priceUpdatedAt', 'language', 'edition', 'finish', 'conditionClass'
  ];
  if (!stringFields.every((field) => optionalString(item[field]))) return false;
  if (!optionalFinite(item.price) || !optionalFinite(item.marketPrice)) return false;
  if (item.priceOptions !== undefined && (!plainArray(item.priceOptions)
      || item.priceOptions.some((option) => !optionalFinite(option.price)))) return false;
  return true;
}

function validHoldingRecord(record) {
  return validCatalogItem(record.item)
    && (record.tags === undefined || stringArray(record.tags))
    && ['catalogId', 'catalogKey', 'canonicalVariantId', 'condition', 'marketCondition', 'gradeCompany', 'grade',
      'purchaseCurrency', 'purchaseDate', 'manualMarketCurrency', 'seller', 'folder', 'notes',
      'userImage', 'createdAt', 'updatedAt', 'lastPriceRefresh']
      .every((field) => optionalString(record[field]))
    && ['quantity', 'purchasePrice', 'fees', 'manualMarketPrice']
      .every((field) => optionalFinite(record[field]))
    && optionalBoolean(record.dirty);
}

function validSnapshotRecord(record) {
  return typeof record.date === 'string'
    && typeof record.pricingPolicyVersion === 'string'
    && optionalString(record.currency)
    && typeof record.marketValue === 'number' && Number.isFinite(record.marketValue)
    && typeof record.costBasis === 'number' && Number.isFinite(record.costBasis)
    && Number.isInteger(record.uniqueItems) && record.uniqueItems >= 0
    && Number.isInteger(record.totalQuantity) && record.totalQuantity >= 0
    && optionalString(record.updatedAt);
}

function validScanRecord(record) {
  if (!optionalString(record.mode) || typeof record.status !== 'string'
      || !optionalString(record.createdAt) || !optionalString(record.updatedAt)
      || !optionalString(record.completedAt) || !optionalString(record.submissionError)
      || !optionalString(record.sourceImage) || !optionalString(record.sourceImageRetainedAt)
      || !optionalString(record.sourceImageDeletedAt)
      || !optionalPlain(record.bulkAcquisition) || !optionalPlain(record.result)
      || !Array.isArray(record.crops)) return false;
  return record.crops.every((crop) => plainRecord(crop)
    && typeof crop.id === 'string'
    && optionalString(crop.image)
    && optionalString(crop.status)
    && optionalString(crop.query)
    && optionalString(crop.ocrText)
    && optionalString(crop.ocrEngine)
    && optionalString(crop.selectedId)
    && optionalString(crop.error)
    && optionalBoolean(crop.approved)
    && optionalPlain(crop.box)
    && optionalPlain(crop.customItem)
    && optionalPlain(crop.acquisition)
    && plainArray(crop.candidates)
    && crop.candidates.every(validCatalogItem)
    && (crop.customItem === undefined || crop.customItem === null || validCatalogItem(crop.customItem)));
}

function validCatalogCacheRecord(record) {
  if (typeof record.expiresAt !== 'number' || !Number.isFinite(record.expiresAt)
      || !plainRecord(record.value)) return false;
  if (record.value.results !== undefined && (!plainArray(record.value.results)
      || !record.value.results.every(validCatalogItem))) return false;
  return record.value.warnings === undefined || stringArray(record.value.warnings);
}

function validTombstoneRecord(record) {
  return typeof record.deletedAt === 'string' && optionalBoolean(record.dirty);
}

function validWatchlistRecord(record) {
  return typeof record.watchKey === 'string'
    && validCatalogItem(record.catalogRef)
    && ['canonicalVariantId', 'marketCondition', 'targetCurrency', 'notes', 'createdAt', 'updatedAt']
      .every((field) => optionalString(record[field]))
    && ['targetPrice', 'alertPercentChange'].every((field) => optionalFinite(record[field]))
    && ['alertTrendChange', 'alertRangeChange', 'alertForecastChange', 'dirty']
      .every((field) => optionalBoolean(record[field]))
    && optionalPlain(record.intelligenceBaseline);
}

function validIntelligenceCacheRecord(record) {
  return optionalString(record.variantId)
    && plainRecord(record.value)
    && (record.cachedAt === undefined || (typeof record.cachedAt === 'number' && Number.isFinite(record.cachedAt)))
    && (record.expiresAt === undefined || (typeof record.expiresAt === 'number' && Number.isFinite(record.expiresAt)))
    && optionalString(record.archivedAt)
    && optionalBoolean(record.immutable);
}

function validLocalValueObservation(record) {
  return typeof record.subjectId === 'string' && Boolean(record.subjectId.trim())
    && typeof record.observedAt === 'string'
    && typeof record.currency === 'string' && /^[A-Z]{3}$/.test(record.currency)
    && ['sourceLabel', 'sourceUpdatedAt', 'supersedes', 'createdAt'].every((field) => optionalString(record[field]))
    && ['manual', 'catalog'].includes(record.source)
    && typeof record.unitPrice === 'number' && Number.isFinite(record.unitPrice)
    && record.unitPrice > 0 && record.unitPrice <= 1_000_000_000_000
    && Number.isFinite(Date.parse(record.observedAt))
    && (record.sourceUpdatedAt === undefined || record.sourceUpdatedAt === '' || Number.isFinite(Date.parse(record.sourceUpdatedAt)))
    && (record.createdAt === undefined || Number.isFinite(Date.parse(record.createdAt)));
}

function validAlertRecord(record) {
  return ['watchKey', 'variantId', 'kind', 'message', 'triggeredAt', 'publicationFingerprint',
    'readAt', 'mutedAt', 'updatedAt'].every((field) => optionalString(record[field]))
    && optionalPlain(record.details);
}

const BACKUP_RECORD_VALIDATORS = Object.freeze({
  holdings: validHoldingRecord,
  snapshots: validSnapshotRecord,
  settings: () => true,
  scans: validScanRecord,
  catalogCache: validCatalogCacheRecord,
  deletions: validTombstoneRecord,
  watchlistItems: validWatchlistRecord,
  watchlistDeletions: validTombstoneRecord,
  intelligenceCache: validIntelligenceCacheRecord,
  localValueObservations: validLocalValueObservation,
  alerts: validAlertRecord
});

export function validateBackupFile(file, maximumBytes = MAX_BACKUP_FILE_BYTES) {
  if (!file || !Number.isFinite(Number(file.size)) || Number(file.size) < 0) {
    throw new Error('Choose a valid CollectFolio backup file.');
  }
  if (Number(file.size) === 0) throw new Error('The selected backup file is empty.');
  if (Number(file.size) > maximumBytes) throw new Error('Backup files must be 128 MB or smaller.');
  return file;
}

export async function readBackupFile(file) {
  validateBackupFile(file);
  return JSON.parse(await file.text());
}

export function validateBackup(backup) {
  if (!plainRecord(backup) || backup.format !== 'collectfolio-backup'
      || !BACKUP_VERSIONS.includes(backup.version) || !plainRecord(backup.stores)) {
    throw new Error('This is not a valid CollectFolio interchange backup.');
  }
  for (const name of Object.keys(backup.stores)) {
    if (BACKUP_EXCLUDED_STORES.includes(name)) {
      throw new Error('This backup contains private activity data that CollectFolio will not import.');
    }
    if (!STORES.includes(name)) throw new Error(`This backup contains an unsupported data section: ${name}.`);
  }
  const plan = [];
  for (const name of STORES.filter((store) => !BACKUP_EXCLUDED_STORES.includes(store))) {
    const records = backup.stores[name] ?? [];
    if (!Array.isArray(records)) throw new Error(`The ${name} data section is invalid.`);
    if (records.length > BACKUP_RECORD_LIMIT) throw new Error(`The ${name} data section is too large to import safely.`);
    const keyPath = STORE_CONFIG[name].keyPath;
    const validateRecord = BACKUP_RECORD_VALIDATORS[name];
    const keys = new Set();
    for (const record of records) {
      const key = record?.[keyPath];
      if (!plainRecord(record) || typeof key !== 'string' || !key.trim()
          || !validateRecord?.(record)) {
        throw new Error(`The ${name} data section contains an invalid record.`);
      }
      if (keys.has(key)) throw new Error(`The ${name} data section contains a duplicate record.`);
      keys.add(key);
    }
    if (records.length) plan.push([name, name === 'scans' ? records.map(scanWithoutSourcePhoto) : records]);
  }
  return plan;
}

export async function exportBackup() {
  const included = STORES.filter((name) => !BACKUP_EXCLUDED_STORES.includes(name));
  const stores = Object.fromEntries(await Promise.all(included.map(async (name) => {
    const records = await getAll(name);
    return [name, name === 'scans' ? records.map(scanWithoutSourcePhoto) : records];
  })));
  return { format: 'collectfolio-backup', version: 2, exportedAt: new Date().toISOString(), stores };
}

export async function importBackup(backup) {
  // Complete validation happens before IndexedDB is opened for writing. One
  // multi-store transaction then keeps a valid merge all-or-nothing.
  const plan = validateBackup(backup);
  if (!plan.length) return;
  const db = await openDatabase();
  const transaction = db.transaction(plan.map(([name]) => name), 'readwrite');
  for (const [name, records] of plan) {
    const store = transaction.objectStore(name);
    for (const record of records) {
      store.put(record);
    }
  }
  await transactionDone(transaction);
  // Version-1/2 portable backups predate local scenario observations. Give
  // every imported holding one current anchor without manufacturing history.
  await recordLocalHoldingObservations(await getAll('holdings'));
  await recordDailySnapshot();
}

export async function exportHoldingsCSV(holdingIds = null) {
  const selected = Array.isArray(holdingIds) && holdingIds.length ? new Set(holdingIds) : null;
  const holdings = (await getAll('holdings')).filter((holding) => !selected || selected.has(holding.id));
  const headers = ['Name', 'Category', 'Game', 'Set', 'Number', 'Quantity', 'Condition', 'Grade company', 'Grade', 'Purchase price', 'Purchase currency', 'Fees', 'Unit market value', 'Market currency', 'Market value', 'Cost basis', 'Cost currency', 'Seller or source', 'Folder', 'Tags', 'Notes', 'Price source', 'Updated'];
  const rows = holdings.map((holding) => {
    const unit = unitMarketValue(holding);
    const marketCurrency = holdingMarketCurrency(holding);
    const costCurrency = holdingCostCurrency(holding);
    const source = holding.manualMarketPrice !== '' && holding.manualMarketPrice != null
      ? 'Manual value'
      : catalogPriceDisclosure(holding.item) || holding.item?.priceSource;
    return [holding.item?.name, holding.item?.category, holding.item?.game, holding.item?.setName, holding.item?.number, holding.quantity, holding.condition, holding.gradeCompany, holding.grade, holding.purchasePrice, costCurrency, holding.fees, unit, marketCurrency, holdingMarketValue(holding), holdingCostBasis(holding), costCurrency, holding.seller, holding.folder, (holding.tags || []).join('|'), holding.notes, source, holding.updatedAt];
  });
  return [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\n');
}

export async function clearLocalData() {
  const db = await openDatabase();
  const transaction = db.transaction(STORES, 'readwrite');
  for (const store of STORES) transaction.objectStore(store).clear();
  await transactionDone(transaction);
}

export async function clearApplicationCacheStorage(cacheStorage = globalThis.caches) {
  if (!cacheStorage?.keys || !cacheStorage?.delete) return 0;
  const keys = await cacheStorage.keys();
  const owned = keys.filter((key) => String(key).startsWith('collectfolio-'));
  const deleted = await Promise.all(owned.map((key) => cacheStorage.delete(key)));
  return deleted.filter(Boolean).length;
}
