import { createId } from '../core/utils.js';
import { putRecord, saveHolding } from '../core/db.js';
import { searchCatalog } from './catalog.js';
import { recognizeText, rerankCandidates } from './image.js';

export function createScanDraft(crops, mode = 'multi') {
  const now = new Date().toISOString();
  return {
    id: createId(), mode, status: 'review', createdAt: now, updatedAt: now,
    crops: crops.map((crop, index) => ({ id: createId(), index, box: crop.box, image: crop.image, status: 'unmatched', query: '', ocrText: '', ocrEngine: '', candidates: [], selectedId: '', customItem: null, approved: false, error: '' }))
  };
}

export async function saveScanDraft(draft) {
  draft.updatedAt = new Date().toISOString();
  await putRecord('scans', structuredClone(draft));
  return draft;
}

export async function identifyCrop(draft, cropId, editedQuery = '') {
  const crop = draft.crops.find((entry) => entry.id === cropId);
  if (!crop) throw new Error('Crop not found.');
  crop.status = 'identifying'; crop.error = ''; crop.approved = false;
  await saveScanDraft(draft);
  try {
    if (!editedQuery.trim()) {
      const ocr = await recognizeText(crop.image);
      crop.ocrText = ocr.text;
      crop.ocrEngine = ocr.engine;
      crop.query = ocr.query;
    } else {
      crop.query = editedQuery.trim();
    }
    if (!crop.query) {
      crop.status = 'unmatched';
      crop.error = 'OCR found no useful query. Enter one manually.';
      await saveScanDraft(draft);
      return crop;
    }
    const response = await searchCatalog({ query: crop.query });
    crop.candidates = await rerankCandidates(crop.image, response.results.slice(0, 18), crop.query);
    crop.status = crop.candidates.length ? 'matched' : 'unmatched';
    crop.error = response.warnings.join(' ');
  } catch (error) {
    crop.status = 'error';
    crop.error = error.message || 'Identification failed. Enter a query or create a custom item.';
  }
  await saveScanDraft(draft);
  return crop;
}

export async function selectCropCandidate(draft, cropId, candidateId) {
  const crop = draft.crops.find((entry) => entry.id === cropId);
  if (!crop || !crop.candidates.some((candidate) => candidate.id === candidateId)) throw new Error('Candidate not found.');
  crop.selectedId = candidateId; crop.customItem = null; crop.status = 'matched'; crop.approved = false;
  await saveScanDraft(draft);
  return crop;
}

export async function setCropCustomItem(draft, cropId, item) {
  const crop = draft.crops.find((entry) => entry.id === cropId);
  if (!crop) throw new Error('Crop not found.');
  crop.customItem = { ...item, id: item.id || createId(), externalId: item.externalId || '', provider: 'custom', image: '', imageSmall: '', priceOptions: item.priceOptions || [], currency: item.currency || 'USD' };
  crop.selectedId = ''; crop.status = 'matched'; crop.approved = false;
  await saveScanDraft(draft);
  return crop;
}

export async function setCropApproval(draft, cropId, approved) {
  const crop = draft.crops.find((entry) => entry.id === cropId);
  if (!crop) throw new Error('Crop not found.');
  if (approved && !crop.customItem && !crop.candidates.some((candidate) => candidate.id === crop.selectedId)) throw new Error('Select an exact match or custom item first.');
  crop.approved = Boolean(approved);
  await saveScanDraft(draft);
  return crop;
}

export async function deleteCrop(draft, cropId) {
  draft.crops = draft.crops.filter((entry) => entry.id !== cropId);
  await saveScanDraft(draft);
  return draft;
}

export async function batchAddApproved(draft) {
  const approved = draft.crops.filter((crop) => crop.approved && (crop.customItem || crop.selectedId));
  for (const crop of approved) {
    const item = crop.customItem || crop.candidates.find((candidate) => candidate.id === crop.selectedId);
    if (!item) continue;
    await saveHolding({ catalogId: item.provider === 'custom' ? `custom:${item.id}` : item.id, item, quantity: 1, condition: 'Near Mint', purchasePrice: '', fees: '', manualMarketPrice: '', userImage: crop.image, folder: '', notes: `Added from scan ${draft.id}` });
  }
  draft.status = 'complete';
  draft.completedAt = new Date().toISOString();
  draft.addedCount = approved.length;
  await saveScanDraft(draft);
  return approved.length;
}
