import { createId } from '../core/utils.js';
import { canonicalRawMarketCondition } from '../core/market-series.js';
import { deleteRecord, deleteRecords, getAll, putRecord, saveHolding } from '../core/db.js';
import { catalogPriceForValuation } from '../core/pricing-policy.js';
import { searchCatalog } from './catalog.js';
import { cardRecognitionMode, lookupCardWithCollectCapture } from './collectcapture.js';
import { candidateEvidenceScore, queryEvidenceFromText, recognizeText, rerankCandidates } from './image.js';
import { recordDemandEvent } from './demand-events.js';
import { discoverVisualCandidates } from './visual-index.js';
import { hydrateMappedVisualCandidate, mapProviderCandidatesToTCGCSV } from './catalog-enrichment.js';

export const ACQUISITION_FIELDS = Object.freeze([
  'quantity', 'condition', 'marketCondition', 'gradeCompany', 'grade', 'purchasePrice', 'purchaseCurrency', 'fees',
  'purchaseDate', 'seller', 'folder', 'manualMarketPrice', 'manualMarketCurrency', 'language', 'retainPhoto', 'notes'
]);
export const COMPLETED_SCAN_RETENTION_DAYS = 30;
export const COMPLETED_SCAN_RECEIPT_LIMIT = 20;
const discardedScanDraftIds = new Set();

const text = (value, max) => String(value ?? '').trim().slice(0, max);
const moneyOrBlank = (value) => value === '' || value === null || value === undefined
  ? ''
  : Math.max(0, Number(value) || 0);
const currency = (value, fallback = 'USD') => {
  const normalized = String(value || '').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(normalized) ? normalized : fallback;
};

export async function searchCatalogCandidates(queries = [], evidence = {}, search = searchCatalog) {
  const candidates = new Map();
  const warnings = new Set();
  let allAttemptsFailed = true;
  for (const query of queries.slice(0, 6)) {
    const response = await search({ query });
    (response.warnings || []).forEach((warning) => warnings.add(warning));
    if ((response.fulfilledProviders ?? 1) > 0 || response.manual) allAttemptsFailed = false;
    const useful = (response.results || []).filter((candidate) => candidateEvidenceScore(candidate, evidence) >= 0.28);
    useful.slice(0, 24).forEach((candidate) => candidates.set(candidate.id, candidate));
    const strong = useful.some((candidate) => candidateEvidenceScore(candidate, evidence) >= (evidence.number ? 0.8 : 0.72));
    if (strong || candidates.size >= 18) break;
  }
  return { candidates: [...candidates.values()], warnings: [...warnings], allAttemptsFailed };
}

export async function identifyDraftCrops(draft, { concurrency = 1, identify = identifyCrop } = {}) {
  const crops = (draft?.crops || []).filter((crop) => crop.status === 'queued');
  if (!crops.length) return draft;
  const maximum = Math.max(1, Math.min(2, Math.trunc(Number(concurrency)) || 1));
  let index = 0;
  const worker = async () => {
    while (index < crops.length) {
      const crop = crops[index++];
      try {
        await identify(draft, crop.id, '');
      } catch (error) {
        crop.status = 'error';
        crop.error = error?.message || 'Identification failed. Enter a query or retry.';
        await saveScanDraft(draft).catch(() => {});
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(maximum, crops.length) }, () => worker()));
  return draft;
}

export function normalizeAcquisition(value = {}) {
  return {
    quantity: Math.max(1, Math.trunc(Number(value.quantity) || 1)),
    condition: text(value.condition || 'Near Mint', 80),
    marketCondition: canonicalRawMarketCondition(value.marketCondition),
    gradeCompany: text(value.gradeCompany, 40),
    grade: text(value.grade, 20),
    purchasePrice: moneyOrBlank(value.purchasePrice),
    purchaseCurrency: currency(value.purchaseCurrency || value.currency),
    fees: moneyOrBlank(value.fees),
    purchaseDate: text(value.purchaseDate, 40),
    seller: text(value.seller, 160),
    folder: text(value.folder, 80),
    manualMarketPrice: moneyOrBlank(value.manualMarketPrice),
    manualMarketCurrency: currency(value.manualMarketCurrency || value.currency || value.purchaseCurrency),
    language: /^[a-z]{2,8}(?:-[a-z0-9]{2,8})*$/i.test(String(value.language || '')) ? String(value.language).toLowerCase() : 'en',
    retainPhoto: value.retainPhoto === true || value.retainPhoto === 'true' || value.retainPhoto === 'on',
    notes: text(value.notes, 2000)
  };
}

export function selectedCropItem(crop = {}) {
  return crop.customItem || crop.candidates?.find((candidate) => candidate.id === crop.selectedId) || null;
}

// Decision D-5: an extracted/matched identity is trusted -- any crop with a
// selected candidate or a custom item is includable. There is no separate
// "exact catalog printing" bar to clear first.
export function cropHasApprovableIdentity(crop = {}) {
  return Boolean(selectedCropItem(crop));
}

// Decision D-5: identification success auto-selects the strongest candidate
// and marks the crop included -- the collector reviews and can Skip, but
// nothing sits gated behind an extra confirm step.
function autoSelectTopCandidate(crop) {
  if (!crop.candidates?.length) return;
  const top = crop.candidates.reduce((best, candidate) =>
    (Number(candidate.matchScore) || 0) > (Number(best.matchScore) || 0) ? candidate : best,
  crop.candidates[0]);
  crop.selectedId = top.id;
  crop.approved = true;
}

export function createScanDraft(crops, mode = 'multi', acquisitionDefaults = {}) {
  const now = new Date().toISOString();
  const acquisition = normalizeAcquisition(acquisitionDefaults);
  return {
    id: createId(), mode, status: 'review', createdAt: now, updatedAt: now,
    bulkAcquisition: acquisition,
    crops: crops.map((crop, index) => ({
      id: createId(), index, box: crop.box, image: crop.image, status: 'queued',
      query: '', ocrText: '', ocrEngine: '', candidates: [], selectedId: '',
      customItem: null, approved: false, error: '', acquisition: { ...acquisition }
    }))
  };
}

export function stripPersistedSourcePhoto(draft) {
  if (!draft || typeof draft !== 'object') return false;
  let removed = false;
  for (const key of ['sourceImage', 'sourceImageRetainedAt', 'sourceImageDeletedAt']) {
    if (Object.prototype.hasOwnProperty.call(draft, key)) {
      delete draft[key];
      removed = true;
    }
  }
  return removed;
}

export async function saveScanDraft(draft) {
  if (discardedScanDraftIds.has(draft?.id)) {
    const error = new Error('This scan draft was discarded.');
    error.name = 'AbortError';
    throw error;
  }
  stripPersistedSourcePhoto(draft);
  draft.updatedAt = new Date().toISOString();
  await putRecord('scans', structuredClone(draft));
  return draft;
}

export async function discardScanDraft(draftId) {
  const id = String(draftId || '');
  if (!id) throw new Error('Scan draft not found.');
  discardedScanDraftIds.add(id);
  try {
    await deleteRecord('scans', id);
  } catch (error) {
    discardedScanDraftIds.delete(id);
    throw error;
  }
  return id;
}

export function compactCompletedScanDraft(draft) {
  if (!draft || draft.status !== 'complete') return draft;
  const compact = {
    id: draft.id,
    mode: draft.mode || 'multi',
    status: 'complete',
    createdAt: draft.createdAt || '',
    updatedAt: draft.updatedAt || '',
    completedAt: draft.completedAt || draft.updatedAt || '',
    addedCount: Math.max(0, Number(draft.addedCount) || 0),
    result: draft.result && typeof draft.result === 'object' && !Array.isArray(draft.result)
      ? structuredClone(draft.result)
      : {},
    crops: []
  };
  return compact;
}

export function completedScanRetentionPlan(scans = [], now = Date.now(), {
  maxAgeDays = COMPLETED_SCAN_RETENTION_DAYS,
  maximumReceipts = COMPLETED_SCAN_RECEIPT_LIMIT
} = {}) {
  const cutoff = now - Math.max(0, Number(maxAgeDays) || 0) * 86_400_000;
  const limit = Math.max(0, Math.trunc(Number(maximumReceipts) || 0));
  const active = (Array.isArray(scans) ? scans : []).filter((scan) => scan?.status !== 'complete').map((scan) => {
    const clean = structuredClone(scan);
    stripPersistedSourcePhoto(clean);
    return clean;
  });
  const completed = (Array.isArray(scans) ? scans : []).filter((scan) => scan?.status === 'complete')
    .sort((left, right) => String(right.completedAt || right.updatedAt || '').localeCompare(String(left.completedAt || left.updatedAt || '')));
  const retained = [];
  const removedIds = [];
  for (const scan of completed) {
    const timestamp = Date.parse(scan.completedAt || scan.updatedAt || '');
    if (!scan.id || !Number.isFinite(timestamp) || timestamp <= cutoff || retained.length >= limit) {
      if (scan.id) removedIds.push(scan.id);
      continue;
    }
    retained.push(compactCompletedScanDraft(scan));
  }
  return { records: [...active, ...retained], compacted: retained, removedIds };
}

export async function maintainCompletedScans(scans = null, now = Date.now(), options = {}) {
  const source = Array.isArray(scans) ? scans : await getAll('scans');
  const plan = completedScanRetentionPlan(source, now, options);
  const changed = plan.records.filter((record) => {
    const current = source.find((entry) => entry.id === record.id);
    return record.status === 'complete'
      ? current?.crops?.length || current?.bulkAcquisition || current?.submissionError
      : ['sourceImage', 'sourceImageRetainedAt', 'sourceImageDeletedAt'].some((key) => Object.prototype.hasOwnProperty.call(current || {}, key));
  });
  await Promise.all([
    ...changed.map((record) => putRecord('scans', record)),
    deleteRecords('scans', plan.removedIds)
  ]);
  return plan.records;
}

export function recoverInterruptedIdentifications(draft) {
  let recovered = 0;
  if (draft?.status === 'adding') {
    draft.status = 'review';
    draft.submissionError = 'The previous add was interrupted. Review and retry; existing crop IDs prevent duplicate holdings.';
    recovered++;
  }
  for (const crop of draft?.crops || []) {
    if (crop.status !== 'identifying') continue;
    crop.status = 'queued';
    crop.error = 'The previous identification was interrupted and will retry automatically.';
    recovered++;
  }
  return recovered;
}

// Decision D-5: the exact/needs-review split is gone -- any selected identity
// is trusted, so crops resolve to included (will be added), needsIdentity
// (still queued/identifying/errored, no identity yet), or unmatched
// (identification finished with no candidates). A crop with an identity the
// collector explicitly skipped counts toward none of these three -- it isn't
// waiting on anything, it just isn't included.
export function scanReviewSummary(draft = {}) {
  const crops = Array.isArray(draft.crops) ? draft.crops : [];
  const result = { total: crops.length, included: 0, needsIdentity: 0, unmatched: 0 };
  for (const crop of crops) {
    const selected = selectedCropItem(crop);
    if (crop.approved && cropHasApprovableIdentity(crop)) { result.included++; continue; }
    if (selected) continue;
    if (crop.status === 'unmatched') result.unmatched++;
    else result.needsIdentity++;
  }
  return result;
}

export function scanReviewTotals(draft = {}, selectedCurrency = '') {
  const approved = eligibleApprovedCrops(draft);
  return approved.reduce((result, crop) => {
    const acquisition = normalizeAcquisition(crop.acquisition);
    const selected = selectedCropItem(crop);
    result.quantity += acquisition.quantity;
    const cost = (Number(acquisition.purchasePrice || 0) * acquisition.quantity) + Number(acquisition.fees || 0);
    if (!selectedCurrency || acquisition.purchaseCurrency === selectedCurrency) result.costBasis += cost;
    else result.excludedCostItems = (result.excludedCostItems || 0) + 1;
    if (acquisition.manualMarketPrice !== '' || catalogPriceForValuation(selected) !== null) result.priced++;
    return result;
  }, { items: approved.length, quantity: 0, costBasis: 0, priced: 0 });
}

export async function setCropAcquisition(draft, cropId, patch = {}) {
  const crop = draft?.crops?.find((entry) => entry.id === cropId);
  if (!crop) throw new Error('Crop not found.');
  crop.acquisition = normalizeAcquisition({ ...crop.acquisition, ...patch });
  await saveScanDraft(draft);
  return crop.acquisition;
}

export function applyAcquisitionPatch(draft, patch = {}) {
  if (!draft?.crops?.length) return 0;
  const allowed = Object.fromEntries(ACQUISITION_FIELDS
    .filter((key) => patch[key] !== undefined && patch[key] !== null && patch[key] !== '')
    .map((key) => [key, patch[key]]));
  draft.bulkAcquisition = normalizeAcquisition({ ...draft.bulkAcquisition, ...allowed });
  for (const crop of draft.crops) crop.acquisition = normalizeAcquisition({ ...crop.acquisition, ...allowed });
  return draft.crops.length;
}

export async function applyAcquisitionToAll(draft, patch = {}) {
  const count = applyAcquisitionPatch(draft, patch);
  if (!count) return 0;
  await saveScanDraft(draft);
  return count;
}

export async function identifyCrop(draft, cropId, editedQuery = '', options = {}) {
  const lookup = options.lookup || lookupCardWithCollectCapture;
  const mode = options.mode || (options.lookup ? 'collectcapture' : cardRecognitionMode());
  const visualSearch = options.visualSearch || discoverVisualCandidates;
  const mapVisualCandidates = options.mapVisualCandidates || mapProviderCandidatesToTCGCSV;
  const crop = draft.crops.find((entry) => entry.id === cropId);
  if (!crop) throw new Error('Crop not found.');
  crop.status = 'identifying'; crop.error = ''; crop.approved = false;
  crop.candidates = []; crop.selectedId = ''; crop.customItem = null;
  await saveScanDraft(draft);
  try {
    if (mode === 'collectcapture') {
      const result = await lookup({
        imageDataUrl: crop.image,
        query: editedQuery.trim(),
        category: 'all',
        limit: 24
      });
      crop.ocrEngine = result.recognition.source === 'user_query'
        ? 'CollectCapture manual search'
        : 'CollectCapture image recognition';
      crop.ocrText = result.recognition.visibleText.join('\n');
      crop.query = editedQuery.trim() || result.recognition.queries[0] || '';
      crop.candidates = result.candidates;
      autoSelectTopCandidate(crop);
      crop.status = crop.candidates.length ? 'matched' : 'unmatched';
      crop.error = crop.candidates.length
        ? result.warnings.join(' ')
        : ['CollectCapture found no catalog match. Try the card name or collector number, or create a custom item.', ...result.warnings].join(' ');
    } else if (mode === 'local') {
      await identifyCropLocally(crop, editedQuery, { visualSearch, mapVisualCandidates });
    } else {
      throw new Error('Card identification is unavailable until CollectCapture is configured. You can still create a custom item.');
    }
  } catch (error) {
    crop.status = 'error';
    crop.error = error.message || 'Identification failed. Enter a query or create a custom item.';
  }
  await saveScanDraft(draft);
  return crop;
}

async function identifyCropLocally(crop, editedQuery, { visualSearch, mapVisualCandidates }) {
  let evidence;
  let recognitionWarning = '';
  if (!editedQuery.trim()) {
    try {
      const ocr = await recognizeText(crop.image);
      crop.ocrEngine = ocr.engine;
      crop.ocrText = ocr.accepted ? ocr.text : '';
      crop.query = ocr.accepted ? ocr.query : '';
      evidence = ocr;
    } catch (error) {
      crop.ocrEngine = '';
      crop.ocrText = '';
      crop.query = '';
      evidence = { queries: [] };
      recognitionWarning = error?.message || 'Text recognition was unavailable.';
    }
  } else {
    crop.query = editedQuery.trim();
    crop.ocrText = '';
    crop.ocrEngine = '';
    evidence = queryEvidenceFromText(crop.query);
  }
  const queries = evidence?.queries?.length ? evidence.queries : crop.query ? [crop.query] : [];
  if (!queries.length) {
    try {
      crop.candidates = await mapVisualCandidates(await visualSearch(crop.image));
    } catch {
      crop.candidates = [];
    }
    autoSelectTopCandidate(crop);
    crop.status = crop.candidates.length ? 'matched' : 'unmatched';
    crop.error = crop.candidates.length
      ? `${recognitionWarning ? `${recognitionWarning} ` : ''}These Pokémon candidates were recovered by image similarity.`
      : `${recognitionWarning ? `${recognitionWarning} ` : ''}Couldn’t read a reliable card name. Try a tighter, well-lit crop or enter the name or collector number.`;
    return;
  }
  const recovered = await searchCatalogCandidates(queries, evidence);
  if (recovered.allAttemptsFailed && recovered.warnings.length) {
    throw new Error('Card catalogs are temporarily unavailable. Check your connection and retry.');
  }
  crop.candidates = await rerankCandidates(crop.image, recovered.candidates.slice(0, 24), evidence);
  if (!crop.candidates.length) {
    try {
      crop.candidates = await mapVisualCandidates(await visualSearch(crop.image));
    } catch {
      // Manual query remains available.
    }
  }
  autoSelectTopCandidate(crop);
  crop.status = crop.candidates.length ? 'matched' : 'unmatched';
  crop.error = crop.candidates.length
    ? (recovered.candidates.length
      ? recovered.warnings.join(' ')
      : 'No reliable text match was found, so these Pokémon candidates were recovered by image similarity.')
    : ['No catalog match found. Try the card name or collector number, or create a custom item.', ...recovered.warnings].join(' ');
}

export async function selectCropCandidate(draft, cropId, candidateId, { hydrate = hydrateMappedVisualCandidate } = {}) {
  const crop = draft.crops.find((entry) => entry.id === cropId);
  const candidateIndex = crop?.candidates.findIndex((candidate) => candidate.id === candidateId) ?? -1;
  if (!crop || candidateIndex < 0) throw new Error('Candidate not found.');
  const candidate = await hydrate(crop.candidates[candidateIndex]);
  crop.candidates[candidateIndex] = candidate;
  // Decision D-5: picking a different candidate is still a trusted identity
  // -- it keeps the crop included, it never re-gates it behind a confirm step.
  crop.selectedId = candidate.id; crop.customItem = null; crop.status = 'matched'; crop.approved = true;
  await saveScanDraft(draft);
  return crop;
}

export async function setCropCustomItem(draft, cropId, item) {
  const crop = draft.crops.find((entry) => entry.id === cropId);
  if (!crop) throw new Error('Crop not found.');
  crop.customItem = { ...item, id: item.id || createId(), externalId: item.externalId || '', provider: 'custom', image: '', imageSmall: '', priceOptions: item.priceOptions || [], currency: item.currency || 'USD' };
  // Decision D-5: a custom item the collector just described is trusted
  // the moment it's created -- no separate confirm step.
  crop.selectedId = ''; crop.status = 'matched'; crop.approved = true;
  await saveScanDraft(draft);
  return crop;
}

export async function setCropApproval(draft, cropId, approved) {
  const crop = draft.crops.find((entry) => entry.id === cropId);
  if (!crop) throw new Error('Crop not found.');
  if (approved && !cropHasApprovableIdentity(crop)) throw new Error('Select a catalog printing or create a custom item first.');
  crop.approved = Boolean(approved);
  await saveScanDraft(draft);
  return crop;
}

export async function deleteCrop(draft, cropId) {
  draft.crops = draft.crops.filter((entry) => entry.id !== cropId);
  await saveScanDraft(draft);
  return draft;
}

export function eligibleApprovedCrops(draft) {
  return draft.crops.filter((crop) => crop.approved && cropHasApprovableIdentity(crop));
}

export async function batchAddApproved(draft, currency = 'USD') {
  if (draft?.status === 'complete') return Number(draft.result?.added || draft.addedCount || 0);
  const approved = eligibleApprovedCrops(draft);
  if (!approved.length) return 0;
  for (const crop of approved) crop.holdingId ||= createId();
  draft.status = 'adding';
  draft.submissionError = '';
  await saveScanDraft(draft);
  try {
    for (const crop of approved) {
      const item = selectedCropItem(crop);
      if (!item) continue;
      const acquisition = normalizeAcquisition(crop.acquisition);
      const { language, retainPhoto, ...ownership } = acquisition;
      const holding = await saveHolding({
        id: crop.holdingId,
        catalogId: item.provider === 'custom' ? `custom:${item.id}` : item.id,
        item: { ...item, language: language || item.language || 'en' },
        ...ownership,
        userImage: retainPhoto ? crop.image : '',
        notes: [acquisition.notes, 'Added from Scan'].filter(Boolean).join('\n')
      });
      crop.addedHoldingId = holding.id;
      await saveScanDraft(draft);
      recordDemandEvent(holding.canonicalVariantId, 'portfolio_add').catch(() => {});
      recordDemandEvent(holding.canonicalVariantId, 'scan_confirm').catch(() => {});
    }
  } catch (error) {
    draft.status = 'review';
    draft.submissionError = error.message || 'The approved items could not all be added. Retry is safe.';
    await saveScanDraft(draft);
    throw error;
  }
  draft.status = 'complete';
  draft.completedAt = new Date().toISOString();
  draft.addedCount = approved.length;
  const summary = scanReviewSummary(draft);
  const totals = scanReviewTotals(draft, currency);
  draft.result = {
    added: approved.length,
    skipped: Math.max(0, summary.total - approved.length),
    unresolved: summary.unmatched + summary.needsIdentity,
    quantity: totals.quantity,
    costBasis: totals.costBasis,
    currency,
    excludedCostItems: totals.excludedCostItems || 0
  };
  Object.assign(draft, compactCompletedScanDraft(draft));
  for (const key of ['bulkAcquisition', 'submissionError']) delete draft[key];
  await saveScanDraft(draft);
  return approved.length;
}
