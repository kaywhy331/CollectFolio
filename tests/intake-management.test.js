import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyAcquisitionPatch,
  compactCompletedScanDraft,
  completedScanRetentionPlan,
  createScanDraft,
  cropHasApprovableIdentity,
  eligibleApprovedCrops,
  identifyCrop,
  identifyDraftCrops,
  normalizeAcquisition,
  searchCatalogCandidates,
  scanReviewSummary,
  scanReviewTotals,
  setCropApproval,
  stripPersistedSourcePhoto
} from '../app/assets/js/services/scan-review.js';
import { catalogReferenceForItem } from '../app/assets/js/core/catalog-identity.js';
import { renderScanReview } from '../app/assets/js/views/scan.js';

// A minimal in-memory IndexedDB shim covering only what core/db.js's
// putRecord needs against the single 'scans' store identifyCrop() writes to
// via saveScanDraft(). Node has no IndexedDB; without this shim putRecord
// rejects and the auto-select assertions below never get a chance to run.
// Test-local only, does not add a runtime dependency (mirrors the shim in
// forecast-trajectory.test.js).
function installFakeScansIndexedDB() {
  const scans = new Map();
  function requestFor(action) {
    const target = new EventTarget();
    target.result = undefined;
    target.error = undefined;
    queueMicrotask(() => {
      try {
        target.result = action();
        target.dispatchEvent(new Event('success'));
      } catch (error) {
        target.error = error;
        target.dispatchEvent(new Event('error'));
      }
    });
    return target;
  }
  const db = {
    objectStoreNames: { contains: () => true },
    transaction() {
      const txTarget = new EventTarget();
      queueMicrotask(() => txTarget.dispatchEvent(new Event('complete')));
      return {
        objectStore: () => ({ put: (value) => requestFor(() => { scans.set(value.id, value); return value; }) }),
        addEventListener: txTarget.addEventListener.bind(txTarget)
      };
    }
  };
  const original = globalThis.indexedDB;
  globalThis.indexedDB = { open: () => requestFor(() => db) };
  return () => { globalThis.indexedDB = original; };
}

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

test('scan review distinguishes queue state and totals only explicitly included items', () => {
  // Decision D-5: the exact/needsReview/approved split collapses to
  // included/needsIdentity/unmatched -- a selected identity is trusted the
  // moment it exists, so totals still only count the explicitly included crop.
  const draft = reviewDraft();
  assert.deepEqual(scanReviewSummary(draft), { total: 2, included: 1, needsIdentity: 1, unmatched: 0 });
  assert.deepEqual(scanReviewTotals(draft), { items: 1, quantity: 2, costBasis: 22, priced: 1 });
});

test('bulk acquisition applies normalized shared fields without approving any crop', () => {
  const draft = reviewDraft();
  const approvals = draft.crops.map((crop) => crop.approved);
  assert.equal(applyAcquisitionPatch(draft, {
    quantity: '3', condition: 'Good', marketCondition: 'lightly-played', purchaseCurrency: 'cad', manualMarketCurrency: 'eur',
    purchaseDate: '2026-08-10', seller: 'Local show'
  }), 2);
  assert.deepEqual(draft.crops.map((crop) => crop.acquisition.quantity), [3, 3]);
  assert.deepEqual(draft.crops.map((crop) => crop.acquisition.condition), ['Good', 'Good']);
  assert.deepEqual(draft.crops.map((crop) => crop.acquisition.marketCondition), ['lightly-played', 'lightly-played']);
  assert.deepEqual(draft.crops.map((crop) => crop.acquisition.purchaseCurrency), ['CAD', 'CAD']);
  assert.deepEqual(draft.crops.map((crop) => crop.acquisition.manualMarketCurrency), ['EUR', 'EUR']);
  assert.deepEqual(draft.crops.map((crop) => crop.acquisition.seller), ['Local show', 'Local show']);
  assert.deepEqual(draft.crops.map((crop) => crop.approved), approvals);
});

test('scan acquisition retains explicit currencies and excludes mismatched cost totals', () => {
  const acquisition = normalizeAcquisition({
    quantity: 2, purchasePrice: 10, fees: 2, purchaseCurrency: 'cad',
    manualMarketPrice: 15, manualMarketCurrency: 'eur', language: 'ja', retainPhoto: true
  });
  assert.equal(acquisition.purchaseCurrency, 'CAD');
  assert.equal(acquisition.manualMarketCurrency, 'EUR');
  assert.equal(acquisition.language, 'ja');
  assert.equal(acquisition.retainPhoto, true);

  const draft = reviewDraft();
  draft.crops[0].acquisition = acquisition;
  assert.deepEqual(scanReviewTotals(draft, 'CAD'), { items: 1, quantity: 2, costBasis: 22, priced: 1 });
  assert.deepEqual(scanReviewTotals(draft, 'USD'), {
    items: 1, quantity: 2, costBasis: 0, priced: 1, excludedCostItems: 1
  });
});

test('redesigned review exposes bulk editing, trusted identity, cost basis, and an include/skip toggle', () => {
  const draft = reviewDraft();
  const html = renderScanReview(draft, {
    settings: { currency: 'USD' }, watchlistItems: [], featureFlags: { watchlists: true },
    scanSourceAvailable: true, cardRecognitionMode: 'collectcapture'
  });
  assert.match(html, /Review queue summary/);
  assert.match(html, /Apply purchase details to all/);
  // Decision D-5: there is no confirm step -- a resolved crop is
  // "Included ✓" with a "Skip this item" ghost button next to it, both
  // wired through the same data-action="approve-crop"/data-approved
  // contract app.js already reads.
  assert.match(html, /approval-state" role="status">Included ✓</);
  assert.match(html, /data-action="approve-crop"[^>]*data-approved="true">Skip this item/);
  assert.doesNotMatch(html, /Confirm this item|Confirmed ✓|Confirmed printing|confirm-detail-identity|review-catalog-identity/);
  assert.match(html, /data-crop-acquisition="purchasePrice"/);
  assert.match(html, /data-crop-acquisition="purchaseCurrency"/);
  assert.match(html, /data-crop-acquisition="manualMarketCurrency"/);
  assert.match(html, /data-crop-acquisition="marketCondition"/);
  assert.match(html, /data-crop-acquisition="language"/);
  assert.match(html, /data-crop-acquisition="retainPhoto"/);
  assert.match(html, /\$22\.00 USD cost basis/);
  assert.match(html, /Add 1 items/);
  // Confirmation-bar small print reflects include/skip, not confirm/approve.
  assert.match(html, /Skipped and unmatched items aren't added\./);
  assert.doesNotMatch(html, /Unconfirmed and unmatched items are skipped|Only confirmed items are added/);
  // DCL-SCAN-02: the shared "How photos are handled" disclosure is the one
  // place pipeline/privacy prose lives now (data-integrity guarantee
  // preserved: the full source photo never leaves the browser / is never
  // saved -- only a cropped copy is used for identification).
  assert.match(html, /full source photo never leaves this browser and is never saved/i);
  assert.match(html, /only a cropped copy of each card is used for identification/i);
  assert.match(html, /<details class="photo-handling-disclosure"><summary>How photos are handled<\/summary>/);
  assert.match(html, /data-action="release-source-photo"/);
  assert.match(html, /data-action="discard-scan"/);
  assert.match(html, /data-action="edit-crop"/);
  assert.match(html, /Edit crop boundary/);
});

test('scan review recognizes a condition-aware mapped watch', () => {
  const variantId = '123e4567-e89b-42d3-a456-426614174000';
  const mappedCard = { ...card, canonicalVariantId: variantId };
  const catalogRef = catalogReferenceForItem(mappedCard, { marketCondition: 'Near Mint' });
  const draft = reviewDraft();
  draft.crops[0].candidates = [mappedCard];
  const html = renderScanReview(draft, {
    settings: { currency: 'USD' },
    featureFlags: { watchlists: true },
    watchlistItems: [{
      id: catalogRef.watchKey,
      watchKey: catalogRef.watchKey,
      canonicalVariantId: variantId,
      catalogRef,
      marketCondition: 'near-mint',
      updatedAt: '2026-08-10T00:00:00.000Z'
    }]
  });
  // DCL-VIS-01: the watch button's glyph is now an inline SVG icon; the
  // accessible/visible signal is the "Watching" text alongside it.
  assert.match(html, /Watching/);
  assert.match(html, /<svg[^>]*aria-hidden="true"/);
});

test('a skipped-but-identified crop shows the proposed match and an Include toggle, not a confirm gate', () => {
  const draft = reviewDraft();
  draft.crops[0].approved = false;
  const html = renderScanReview(draft, {
    settings: { currency: 'USD' }, watchlistItems: [], featureFlags: { watchlists: true }
  });
  assert.match(html, /Proposed match/);
  // Decision D-5: the selected identity is already trusted -- skipping it is
  // just an inclusion choice ("Include this item"), never a confirm gate.
  assert.match(html, /data-action="approve-crop"[^>]*data-approved="false">Include this item/);
  assert.doesNotMatch(html, /Confirm this item|Catalog printing required|lookup suggestion is never approved automatically/i);
  assert.match(html, /Strong lookup match/);
  assert.doesNotMatch(html, /100%/);
});

test('any selected candidate is a trusted, approvable identity regardless of match confidence (Decision D-5)', async () => {
  // Directive 1: extracted/matched information is assumed correct -- a
  // "likely" (non-exact) lookup match is just as approvable as an exact one.
  // There is no separate "exact catalog printing" bar left to clear.
  const draft = reviewDraft();
  const likely = { ...card, id: 'pokemon:possible', externalId: 'possible', matchBucket: 'likely', matchScore: 0.96 };
  draft.crops[0].candidates = [likely];
  draft.crops[0].selectedId = likely.id;
  draft.crops[0].approved = true;
  assert.equal(cropHasApprovableIdentity(draft.crops[0]), true);
  assert.equal(eligibleApprovedCrops(draft).length, 1);
  assert.deepEqual(scanReviewSummary(draft), { total: 2, included: 1, needsIdentity: 1, unmatched: 0 });
  const html = renderScanReview(draft, { settings: { currency: 'USD' }, watchlistItems: [], featureFlags: { watchlists: true } });
  assert.match(html, /approval-state" role="status">Included ✓</);
  assert.doesNotMatch(html, /Catalog printing required|Confirm this item/);
});

test('a crop with no selected candidate or custom item still cannot be included -- data-integrity gate remains', async () => {
  // The one gate that survives Decision D-5: something must actually be
  // selected (a candidate or a custom item) before a crop can be included --
  // trust replaces the confirm step, it does not remove the need for an identity.
  const draft = reviewDraft();
  draft.crops[0].candidates = [];
  draft.crops[0].selectedId = '';
  draft.crops[0].customItem = null;
  draft.crops[0].approved = false;
  assert.equal(cropHasApprovableIdentity(draft.crops[0]), false);
  assert.equal(eligibleApprovedCrops(draft).length, 0);
  await assert.rejects(() => setCropApproval(draft, draft.crops[0].id, true), /catalog printing/i);
});

test('successful identification auto-selects the strongest candidate and auto-includes the crop', async () => {
  // Decision D-5: identification success trusts the top match immediately --
  // the collector reviews and can Skip, but nothing sits gated behind an
  // extra confirm step. This exercises the real identifyCrop() (not a mock),
  // so it covers autoSelectTopCandidate wiring through the collectcapture path.
  const restoreIndexedDB = installFakeScansIndexedDB();
  try {
    const draft = createScanDraft([
      { box: { x: 0, y: 0, width: 10, height: 14 }, image: 'data:image/jpeg;base64,AA==' }
    ]);
    const weak = { ...card, id: 'pokemon:weak', externalId: 'weak', matchScore: 0.4 };
    const strong = { ...card, id: 'pokemon:strong', externalId: 'strong', matchScore: 0.93 };
    const fakeLookup = async () => ({
      recognition: { source: 'ocr', visibleText: ['Charizard ex'], queries: ['Charizard ex'] },
      candidates: [weak, strong],
      warnings: []
    });
    const crop = await identifyCrop(draft, draft.crops[0].id, '', { lookup: fakeLookup });
    assert.equal(crop.status, 'matched');
    assert.equal(crop.selectedId, strong.id);
    assert.equal(crop.approved, true);

    const noMatchLookup = async () => ({
      recognition: { source: 'ocr', visibleText: [], queries: [] },
      candidates: [],
      warnings: []
    });
    const unmatchedCrop = await identifyCrop(draft, draft.crops[0].id, '', { lookup: noMatchLookup });
    assert.equal(unmatchedCrop.status, 'unmatched');
    assert.equal(unmatchedCrop.approved, false);
    assert.equal(unmatchedCrop.selectedId, '');
  } finally {
    restoreIndexedDB();
  }
});

test('catalog candidate search relaxes in order, recovers, and deduplicates useful matches', async () => {
  const evidence = { title: 'Charizard ex', number: '223/197', query: 'Charizard ex 223/197' };
  const queries = ['Charizard ex 223/197', '223/197', 'Charizard ex', 'Charizard'];
  const calls = [];
  const recovered = await searchCatalogCandidates(queries, evidence, async ({ query }) => {
    calls.push(query);
    if (query.includes('223/197')) return { results: [], warnings: [], fulfilledProviders: 3 };
    return {
      results: [
        { ...card, id: 'pokemon:charizard-223', name: 'Charizard ex', number: '223' },
        { ...card, id: 'pokemon:charizard-223', name: 'Charizard ex', number: '223' }
      ],
      warnings: ['One provider was unavailable.'], fulfilledProviders: 2
    };
  });
  assert.deepEqual(calls, ['Charizard ex 223/197', '223/197', 'Charizard ex']);
  assert.equal(recovered.candidates.length, 1);
  assert.equal(recovered.allAttemptsFailed, false);
  assert.deepEqual(recovered.warnings, ['One provider was unavailable.']);
});

test('automatic identification processes every queued crop without user initiation', async () => {
  const draft = createScanDraft([
    { box: { x: 0, y: 0, width: 10, height: 14 }, image: 'data:image/jpeg;base64,AA==' },
    { box: { x: 10, y: 0, width: 10, height: 14 }, image: 'data:image/jpeg;base64,AA==' }
  ]);
  assert.deepEqual(draft.crops.map((crop) => crop.status), ['queued', 'queued']);
  const calls = [];
  await identifyDraftCrops(draft, {
    concurrency: 2,
    identify: async (_draft, cropId, query) => {
      calls.push([cropId, query]);
      const crop = draft.crops.find((entry) => entry.id === cropId);
      crop.status = 'unmatched';
    }
  });
  assert.equal(calls.length, 2);
  assert.ok(calls.every(([, query]) => query === ''));
});

test('automatic identification isolates one crop failure and continues the queue', async () => {
  const draft = createScanDraft([
    { box: { x: 0, y: 0, width: 10, height: 14 }, image: 'data:image/jpeg;base64,AA==' },
    { box: { x: 10, y: 0, width: 10, height: 14 }, image: 'data:image/jpeg;base64,AA==' }
  ]);
  const calls = [];
  await identifyDraftCrops(draft, {
    identify: async (_draft, cropId) => {
      calls.push(cropId);
      if (calls.length === 1) throw new Error('synthetic OCR failure');
      draft.crops.find((crop) => crop.id === cropId).status = 'unmatched';
    }
  });
  assert.equal(calls.length, 2);
  assert.equal(draft.crops[0].status, 'error');
  assert.match(draft.crops[0].error, /synthetic OCR failure/);
  assert.equal(draft.crops[1].status, 'unmatched');
});

test('catalog candidate search distinguishes a full provider outage from a valid no-match', async () => {
  const evidence = { title: 'Unknown Card', query: 'Unknown Card' };
  const outage = await searchCatalogCandidates(['Unknown Card'], evidence, async () => ({
    results: [], warnings: ['Catalog unavailable'], fulfilledProviders: 0
  }));
  const noMatch = await searchCatalogCandidates(['Unknown Card'], evidence, async () => ({
    results: [], warnings: [], fulfilledProviders: 3
  }));
  assert.equal(outage.allAttemptsFailed, true);
  assert.equal(noMatch.allAttemptsFailed, false);
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
  completed.sourceImage = 'data:image/jpeg;base64,raw-source';
  const compact = compactCompletedScanDraft(completed);
  assert.deepEqual(compact.crops, []);
  assert.equal(JSON.stringify(compact).includes('data:image'), false);
  assert.equal('sourceImage' in compact, false);
  assert.equal(compact.result.added, 1);

  const older = { ...completed, id: 'older', completedAt: '2026-08-09T00:00:00.000Z', updatedAt: '2026-08-09T00:00:00.000Z' };
  const stale = { ...completed, id: 'stale', completedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
  const active = { id: 'active', status: 'review', crops: [{ image: 'data:image/jpeg;base64,keep' }] };
  active.sourceImage = 'data:image/jpeg;base64,raw-active-source';
  active.sourceImageRetainedAt = '2026-08-10T00:00:00.000Z';
  const plan = completedScanRetentionPlan([older, stale, active, completed], Date.parse('2026-08-11T00:00:00.000Z'), {
    maxAgeDays: 30,
    maximumReceipts: 1
  });
  assert.deepEqual(plan.removedIds, ['older', 'stale']);
  assert.deepEqual(plan.records.map((scan) => scan.id), ['active', 'recent']);
  assert.equal(plan.records[0].crops[0].image, 'data:image/jpeg;base64,keep');
  assert.equal('sourceImage' in plan.records[0], false);
  assert.equal('sourceImageRetainedAt' in plan.records[0], false);
});

test('source photo fields are stripped from active drafts without removing compressed crops', () => {
  const draft = reviewDraft();
  draft.sourceImage = 'data:image/jpeg;base64,raw-source';
  draft.sourceImageDeletedAt = '2026-08-10T00:00:00.000Z';
  assert.equal(stripPersistedSourcePhoto(draft), true);
  assert.equal(stripPersistedSourcePhoto(draft), false);
  assert.equal('sourceImage' in draft, false);
  assert.equal('sourceImageDeletedAt' in draft, false);
  assert.equal(draft.crops.length, 2);
  assert.match(draft.crops[0].image, /^data:image\/jpeg/);
});
