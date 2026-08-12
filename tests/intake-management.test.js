import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyAcquisitionPatch,
  compactCompletedScanDraft,
  completedScanRetentionPlan,
  createScanDraft,
  normalizeAcquisition,
  scanReviewSummary,
  scanReviewTotals
} from '../app/assets/js/services/scan-review.js';
import { renderScanReview } from '../app/assets/js/views/scan.js';

const card = {
  id: 'pokemon:sv3-223', provider: 'pokemon', externalId: 'sv3-223', category: 'pokemon',
  game: 'Pokémon', name: 'Charizard ex', setName: 'Obsidian Flames', number: '223',
  variant: 'holofoil', rarity: 'Special Illustration Rare', image: '', imageSmall: '',
  price: 90, currency: 'USD', matchBucket: 'exact', matchScore: 1
};

function reviewDraft() {
  const draft = createScanDraft([
    { box: { x: 0, y: 0, width: 10, height: 14 }, image: 'data:image/jpeg;base64,AA==' },
    { box: { x: 10, y: 0, width: 10, height: 14 }, image: 'data:image/jpeg;base64,AA==' }
  ]);
  draft.crops[0] = {
    ...draft.crops[0], status: 'matched', candidates: [card], selectedId: card.id, approved: true,
    acquisition: { quantity: 2, condition: 'Near Mint', purchasePrice: 10, fees: 2, manualMarketPrice: 15 }
  };
  return draft;
}

test('scan review distinguishes queue state and totals only explicitly approved items', () => {
  const draft = reviewDraft();
  assert.deepEqual(scanReviewSummary(draft), { total: 2, exact: 1, needsReview: 0, unmatched: 1, approved: 1 });
  assert.deepEqual(scanReviewTotals(draft), { items: 1, quantity: 2, costBasis: 22, priced: 1 });
});

test('bulk acquisition applies normalized shared fields without approving any crop', () => {
  const draft = reviewDraft();
  const approvals = draft.crops.map((crop) => crop.approved);
  assert.equal(applyAcquisitionPatch(draft, {
    quantity: '3', condition: 'Good', purchaseCurrency: 'cad', manualMarketCurrency: 'eur',
    purchaseDate: '2026-08-10', seller: 'Local show'
  }), 2);
  assert.deepEqual(draft.crops.map((crop) => crop.acquisition.quantity), [3, 3]);
  assert.deepEqual(draft.crops.map((crop) => crop.acquisition.condition), ['Good', 'Good']);
  assert.deepEqual(draft.crops.map((crop) => crop.acquisition.purchaseCurrency), ['CAD', 'CAD']);
  assert.deepEqual(draft.crops.map((crop) => crop.acquisition.manualMarketCurrency), ['EUR', 'EUR']);
  assert.deepEqual(draft.crops.map((crop) => crop.acquisition.seller), ['Local show', 'Local show']);
  assert.deepEqual(draft.crops.map((crop) => crop.approved), approvals);
});

test('scan acquisition retains explicit currencies and excludes mismatched cost totals', () => {
  const acquisition = normalizeAcquisition({
    quantity: 2, purchasePrice: 10, fees: 2, purchaseCurrency: 'cad',
    manualMarketPrice: 15, manualMarketCurrency: 'eur'
  });
  assert.equal(acquisition.purchaseCurrency, 'CAD');
  assert.equal(acquisition.manualMarketCurrency, 'EUR');

  const draft = reviewDraft();
  draft.crops[0].acquisition = acquisition;
  assert.deepEqual(scanReviewTotals(draft, 'CAD'), { items: 1, quantity: 2, costBasis: 22, priced: 1 });
  assert.deepEqual(scanReviewTotals(draft, 'USD'), {
    items: 1, quantity: 2, costBasis: 0, priced: 1, excludedCostItems: 1
  });
});

test('redesigned review exposes bulk editing, exact identity, cost basis, and explicit confirmation', () => {
  const html = renderScanReview(reviewDraft(), {
    settings: { currency: 'USD' }, watchlistItems: [], featureFlags: { watchlists: true }
  });
  assert.match(html, /Review queue summary/);
  assert.match(html, /Apply acquisition details to all/);
  assert.match(html, /Exact source identity/);
  assert.match(html, /data-crop-acquisition="purchasePrice"/);
  assert.match(html, /data-crop-acquisition="purchaseCurrency"/);
  assert.match(html, /data-crop-acquisition="manualMarketCurrency"/);
  assert.match(html, /\$22\.00 USD cost basis/);
  assert.match(html, /Add 1 approved/);
  assert.match(html, /Unapproved and unmatched items are skipped/);
});

test('completed intake reports added, skipped, and unresolved counts before navigation', () => {
  const draft = reviewDraft();
  draft.status = 'complete';
  draft.result = { added: 1, skipped: 1, unresolved: 1, quantity: 2, costBasis: 22 };
  const html = renderScanReview(draft, { settings: { currency: 'USD' } });
  assert.match(html, /Items added/);
  assert.match(html, /1 item added/);
  assert.match(html, /<dt>Skipped<\/dt><dd>1<\/dd>/);
  assert.match(html, /<dt>Still unresolved<\/dt><dd>1<\/dd>/);
  assert.match(html, /data-portfolio-target="holdings"/);
});

test('completed scan receipts discard images and obey count and age retention', () => {
  const completed = reviewDraft();
  completed.id = 'recent';
  completed.status = 'complete';
  completed.completedAt = '2026-08-10T00:00:00.000Z';
  completed.updatedAt = completed.completedAt;
  completed.result = { added: 1 };
  const compact = compactCompletedScanDraft(completed);
  assert.deepEqual(compact.crops, []);
  assert.equal(JSON.stringify(compact).includes('data:image'), false);
  assert.equal(compact.result.added, 1);

  const older = { ...completed, id: 'older', completedAt: '2026-08-09T00:00:00.000Z', updatedAt: '2026-08-09T00:00:00.000Z' };
  const stale = { ...completed, id: 'stale', completedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
  const active = { id: 'active', status: 'review', crops: [{ image: 'data:image/jpeg;base64,keep' }] };
  const plan = completedScanRetentionPlan([older, stale, active, completed], Date.parse('2026-08-11T00:00:00.000Z'), {
    maxAgeDays: 30,
    maximumReceipts: 1
  });
  assert.deepEqual(plan.removedIds, ['older', 'stale']);
  assert.deepEqual(plan.records.map((scan) => scan.id), ['active', 'recent']);
  assert.equal(plan.records[0].crops[0].image, 'data:image/jpeg;base64,keep');
});
