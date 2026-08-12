import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  holdingMarketValue, portfolioSummary, unitMarketValue
} from '../app/assets/js/core/calculations.js';
import { normalizeIntelligencePayload } from '../app/assets/js/core/intelligence-contract.js';
import { currentPricingSnapshots } from '../app/assets/js/core/pricing-policy.js';
import { BACKUP_EXCLUDED_STORES, STORES, validateBackup } from '../app/assets/js/core/db.js';
import {
  mergeHoldings, mergePortfolioSnapshots, mergeTombstones, remotePortfolioSnapshot
} from '../app/assets/js/services/supabase.js';

const fixture = async (name) => JSON.parse(await readFile(
  new URL(`./fixtures/redesign/${name}`, import.meta.url), 'utf8'
));

test('version-4 IndexedDB fixture remains a version-2 portable backup shape', async () => {
  const baseline = await fixture('indexeddb-v4-backup-v2.json');
  assert.equal(baseline.format, 'collectfolio-backup');
  assert.equal(baseline.version, 2);
  assert.equal(baseline.databaseName, 'collectfolio');
  assert.equal(baseline.databaseVersion, 4);
  assert.deepEqual(
    Object.keys(baseline.stores).sort(),
    STORES.filter((name) => !BACKUP_EXCLUDED_STORES.includes(name) && name !== 'localValueObservations').sort()
  );
  assert.ok(STORES.includes('localValueObservations'));
  assert.deepEqual(BACKUP_EXCLUDED_STORES, ['demandEventsQueue']);
  assert.doesNotThrow(() => validateBackup(baseline));
});

test('representative legacy holdings preserve valuation, cost, and snapshot expectations', async () => {
  const baseline = await fixture('indexeddb-v4-backup-v2.json');
  const [permitted, restricted, unpriced] = baseline.stores.holdings;
  assert.equal(unitMarketValue(permitted), 12);
  assert.equal(holdingMarketValue(permitted), 24);
  assert.equal(unitMarketValue(restricted), baseline.expected.restrictedManualValue);
  assert.equal(unitMarketValue({ ...restricted, manualMarketPrice: '' }), baseline.expected.restrictedCatalogValue);
  assert.equal(unitMarketValue(unpriced), 0);
  const summary = portfolioSummary(baseline.stores.holdings);
  assert.deepEqual(
    Object.fromEntries(Object.keys(baseline.expected.summary).filter((key) => key !== 'returnPercent').map((key) => [key, summary[key]])),
    Object.fromEntries(Object.entries(baseline.expected.summary).filter(([key]) => key !== 'returnPercent'))
  );
  assert.ok(Math.abs(summary.returnPercent - baseline.expected.summary.returnPercent) < 1e-12);
  assert.deepEqual(
    currentPricingSnapshots(baseline.stores.snapshots).map((entry) => entry.id),
    baseline.expected.currentSnapshotIds
  );
});

test('representative local fixture retains exact watch identity and recoverable scan state', async () => {
  const baseline = await fixture('indexeddb-v4-backup-v2.json');
  const [watched] = baseline.stores.watchlistItems;
  assert.equal(watched.watchKey, `variant:${watched.canonicalVariantId}`);
  assert.equal(watched.catalogRef.mappingStatus, 'mapped');
  const drafts = baseline.stores.scans.filter((entry) => entry.status !== 'complete');
  assert.equal(drafts.length, baseline.expected.scanDraftCount);
  assert.equal(drafts[0].crops.length, 2);
  assert.equal(drafts[0].crops.filter((crop) => crop.approved).length, 1);
});

test('cloud fixture preserves tombstone-first LWW and local-only images', async () => {
  const cloud = await fixture('cloud-sync.json');
  const tombstones = mergeTombstones(cloud.localTombstones, cloud.remoteTombstones);
  assert.equal(tombstones[0].deletedAt, cloud.expected.tombstoneDeletedAt);
  const merged = mergeHoldings(
    cloud.localHoldings,
    cloud.remoteHoldings,
    new Set(tombstones.map((entry) => entry.id))
  ).sort((left, right) => left.id.localeCompare(right.id));
  assert.deepEqual(merged.map((entry) => entry.id), cloud.expected.holdingIds);
  assert.equal(merged[0].quantity, cloud.expected.winningQuantity);
  assert.equal(Boolean(merged[0].userImage), cloud.expected.preserveLocalImage);
});

test('cloud fixture rejects old-policy rows and keeps the newest valid daily snapshot', async () => {
  const cloud = await fixture('cloud-sync.json');
  const remote = cloud.remoteSnapshotRows.map(remotePortfolioSnapshot).filter(Boolean);
  assert.equal(remote.length, 1);
  const [merged] = mergePortfolioSnapshots(cloud.localSnapshots, remote);
  assert.equal(merged.marketValue, cloud.expected.snapshotMarketValue);
  assert.equal(merged.updatedAt, cloud.expected.snapshotUpdatedAt);
});

test('cached publication cannot expose forecast layers above its approved support tier', async () => {
  const baseline = await fixture('indexeddb-v4-backup-v2.json');
  const publication = baseline.stores.intelligenceCache[0].value;
  const normalized = normalizeIntelligencePayload(publication);
  assert.equal(normalized.supportTier, 1);
  assert.equal(normalized.observed.price, 12);
  assert.deepEqual(normalized.forecasts, {});
  assert.equal(normalized.fairValue, null);
  assert.equal(normalized.trend.status, 'insufficient');
});

test('legacy route fixture maps every current view without exposing deferred capabilities', async () => {
  const routes = await fixture('legacy-routes.json');
  const keys = routes.mappings.map((entry) => [entry.legacyView, entry.legacySection, entry.origin].join(':'));
  assert.equal(new Set(keys).size, routes.mappings.length);
  assert.deepEqual(new Set(routes.mappings.map((entry) => entry.legacyView)), new Set([
    'home', 'search', 'add', 'scan', 'portfolio', 'insights', 'profile', 'detail'
  ]));
  assert.ok(routes.mappings.every((entry) => entry.path.startsWith('/')));
  assert.ok(routes.hiddenUntilSupported.includes('portfolio-sets'));
  assert.ok(routes.hiddenUntilSupported.includes('portfolio-sold'));
  assert.ok(!routes.hiddenUntilSupported.includes('insights-alerts'));
  assert.ok(!routes.hiddenUntilSupported.includes('insights-track-record'));
  assert.ok(routes.hiddenUntilSupported.includes('portfolio-selector'));
});
