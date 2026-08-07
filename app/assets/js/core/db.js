import { portfolioSummary, snapshotFor, unitMarketValue } from './calculations.js';
import { catalogReferenceForItem } from './catalog-identity.js';
import { catalogPriceDisclosure } from './pricing-policy.js';
import { createId, csvCell } from './utils.js';

const NAME = 'collectfolio';
const VERSION = 4;
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
    request.addEventListener('upgradeneeded', () => {
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
      const watchlist = request.transaction.objectStore('watchlistItems');
      if (!watchlist.indexNames.contains('watchKey')) watchlist.createIndex('watchKey', 'watchKey', { unique: true });
      if (!watchlist.indexNames.contains('updatedAt')) watchlist.createIndex('updatedAt', 'updatedAt', { unique: false });
      if (!watchlist.indexNames.contains('canonicalVariantId')) watchlist.createIndex('canonicalVariantId', 'canonicalVariantId', { unique: false });
      const alerts = request.transaction.objectStore('alerts');
      if (!alerts.indexNames.contains('triggeredAt')) alerts.createIndex('triggeredAt', 'triggeredAt', { unique: false });
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

export async function putRecordClearingTombstone(storeName, tombstoneStoreName, value) {
  const db = await openDatabase();
  const transaction = db.transaction([storeName, tombstoneStoreName], 'readwrite');
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

export async function deleteRecordWithTombstone(storeName, tombstoneStoreName, key, deletedAt = new Date().toISOString()) {
  const db = await openDatabase();
  const transaction = db.transaction([storeName, tombstoneStoreName], 'readwrite');
  transaction.objectStore(storeName).delete(key);
  transaction.objectStore(tombstoneStoreName).put({ id: key, deletedAt, dirty: true });
  await transactionDone(transaction);
}

export async function saveHolding(input) {
  const now = new Date().toISOString();
  const catalogRef = catalogReferenceForItem(input.item, {
    canonicalVariantId: input.canonicalVariantId || input.catalogVariantId,
    conditionClass: input.grade ? 'graded' : 'raw'
  });
  const holding = {
    id: input.id || createId(),
    catalogId: input.catalogId || `${input.item?.provider || 'custom'}:${input.item?.externalId || createId()}`,
    catalogKey: input.catalogKey || catalogRef.watchKey,
    canonicalVariantId: catalogRef.canonicalVariantId,
    item: { ...input.item },
    quantity: Math.max(1, Number(input.quantity) || 1),
    condition: input.condition || 'Near Mint',
    gradeCompany: input.gradeCompany || '',
    grade: input.grade || '',
    purchasePrice: input.purchasePrice === '' ? '' : Math.max(0, Number(input.purchasePrice) || 0),
    purchaseDate: input.purchaseDate || '',
    fees: input.fees === '' ? '' : Math.max(0, Number(input.fees) || 0),
    manualMarketPrice: input.manualMarketPrice === '' || input.manualMarketPrice === undefined ? '' : Math.max(0, Number(input.manualMarketPrice) || 0),
    folder: input.folder || '',
    notes: input.notes || '',
    userImage: input.userImage || '',
    createdAt: input.createdAt || now,
    updatedAt: now,
    lastPriceRefresh: input.lastPriceRefresh || '',
    dirty: true
  };
  await putRecord('holdings', holding);
  await recordDailySnapshot();
  return holding;
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
  const holdings = await getAll('holdings');
  return putRecord('snapshots', snapshotFor(holdings, date));
}

// The demand outbox is a private, limited-retention telemetry queue tied to a
// signed-in user ID; a portable interchange file must not carry it between
// devices or users, and imports must not be able to inject events into it.
export const BACKUP_EXCLUDED_STORES = Object.freeze(['demandEventsQueue']);

export async function exportBackup() {
  const included = STORES.filter((name) => !BACKUP_EXCLUDED_STORES.includes(name));
  const stores = Object.fromEntries(await Promise.all(included.map(async (name) => [name, await getAll(name)])));
  return { format: 'collectfolio-backup', version: 2, exportedAt: new Date().toISOString(), stores };
}

export async function importBackup(backup) {
  if (!backup || backup.format !== 'collectfolio-backup' || ![1, 2].includes(backup.version) || typeof backup.stores !== 'object') {
    throw new Error('This is not a valid CollectFolio interchange backup.');
  }
  const db = await openDatabase();
  for (const name of STORES.filter((store) => !BACKUP_EXCLUDED_STORES.includes(store))) {
    const records = Array.isArray(backup.stores[name]) ? backup.stores[name] : [];
    if (!records.length) continue;
    const transaction = db.transaction(name, 'readwrite');
    const store = transaction.objectStore(name);
    for (const record of records) {
      if (record && typeof record === 'object') store.put(record);
    }
    await transactionDone(transaction);
  }
  await recordDailySnapshot();
}

export async function exportHoldingsCSV() {
  const holdings = await getAll('holdings');
  const headers = ['Name', 'Category', 'Game', 'Set', 'Number', 'Quantity', 'Condition', 'Grade company', 'Grade', 'Purchase price', 'Fees', 'Unit market value', 'Market value', 'Cost basis', 'Folder', 'Notes', 'Price source', 'Updated'];
  const rows = holdings.map((holding) => {
    const summary = portfolioSummary([holding]);
    const unit = unitMarketValue(holding);
    const source = holding.manualMarketPrice !== '' && holding.manualMarketPrice != null
      ? 'Manual value'
      : catalogPriceDisclosure(holding.item) || holding.item?.priceSource;
    return [holding.item?.name, holding.item?.category, holding.item?.game, holding.item?.setName, holding.item?.number, holding.quantity, holding.condition, holding.gradeCompany, holding.grade, holding.purchasePrice, holding.fees, unit, summary.marketValue, summary.costBasis, holding.folder, holding.notes, source, holding.updatedAt];
  });
  return [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\n');
}

export async function clearLocalData() {
  const db = await openDatabase();
  const transaction = db.transaction(STORES, 'readwrite');
  for (const store of STORES) transaction.objectStore(store).clear();
  await transactionDone(transaction);
}
