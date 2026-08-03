import { externalImage, pageHeader } from '../core/components.js';
import { escapeAttribute, escapeHTML, formatCurrency } from '../core/utils.js';

export function renderScanReview(draft) {
  if (!draft) return `${pageHeader('Batch review', 'No saved scan selected', 'Return to Add to begin or resume a scan.')}<button class="button" data-go="add">Back to Add</button>`;
  const approved = draft.crops.filter((crop) => crop.approved).length;
  return `${pageHeader('Batch review', `Review ${draft.crops.length} crop${draft.crops.length === 1 ? '' : 's'}`, 'Identification proposes; you select the exact item and explicitly approve each crop.')}
    <div class="button-row"><button class="button secondary" type="button" data-action="save-scan">Save scan on this device</button><button class="button" type="button" data-action="batch-add" ${approved ? '' : 'disabled'}>Add ${approved} approved</button></div>
    <p class="fine-print">Unapproved crops are always excluded. Crops and decisions persist locally; the full source photo is not uploaded or saved in the draft.</p>
    <div class="review-list">${draft.crops.map((crop, index) => cropCard(crop, index)).join('')}</div>`;
}

function cropCard(crop, index) {
  const selected = crop.customItem || crop.candidates.find((candidate) => candidate.id === crop.selectedId);
  return `<article class="review-card ${crop.approved ? 'approved' : ''}" data-crop-id="${escapeAttribute(crop.id)}">
    <div class="review-head"><img src="${escapeAttribute(crop.image)}" alt="Crop ${index + 1}" referrerpolicy="no-referrer"><div><p class="eyebrow">Crop ${index + 1} · ${escapeHTML(crop.status)}</p><h2>${escapeHTML(selected?.name || 'Unmatched crop')}</h2><p class="muted">${crop.approved ? 'Explicitly approved for batch add.' : selected ? 'Selected, but not approved.' : 'Run OCR, type a query, or create a custom item.'}</p></div></div>
    <label>Editable OCR / search query<input data-crop-query value="${escapeAttribute(crop.query)}" placeholder="Type a name, set, or number"></label>
    ${crop.ocrEngine ? `<p class="fine-print">OCR: ${escapeHTML(crop.ocrEngine)}${crop.ocrText ? ` · ${escapeHTML(crop.ocrText.slice(0, 120))}` : ''}</p>` : ''}
    ${crop.error ? `<p class="fine-print negative" role="status">${escapeHTML(crop.error)}</p>` : ''}
    <div class="button-row"><button class="button secondary small" type="button" data-action="identify-crop" data-id="${escapeAttribute(crop.id)}">${crop.status === 'identifying' ? 'Identifying…' : crop.query ? 'Search / retry' : 'Run OCR'}</button><button class="button ghost small" type="button" data-action="custom-crop" data-id="${escapeAttribute(crop.id)}">Create custom</button><button class="button ghost small" type="button" data-action="delete-crop" data-id="${escapeAttribute(crop.id)}">Delete crop</button></div>
    ${crop.candidates.length ? `<div class="candidate-list">${crop.candidates.slice(0, 9).map((candidate) => `<button class="candidate ${candidate.id === crop.selectedId ? 'selected' : ''}" type="button" data-action="select-candidate" data-id="${escapeAttribute(crop.id)}" data-candidate="${escapeAttribute(candidate.id)}">${externalImage(candidate, 'candidate-image')}<strong>${escapeHTML(candidate.name)}</strong><span>${escapeHTML([candidate.setName, candidate.number].filter(Boolean).join(' · '))}</span><span>${candidate.price == null ? 'No price' : escapeHTML(formatCurrency(candidate.price, candidate.currency || 'USD'))} · ${Math.round((candidate.matchScore || 0) * 100)}%</span></button>`).join('')}</div>` : ''}
    ${selected ? `<div class="card"><p class="eyebrow">Selected match</p><h3>${escapeHTML(selected.name)}</h3><p class="item-meta">${escapeHTML([selected.game, selected.setName, selected.number, selected.variant].filter(Boolean).join(' · '))}</p><button class="button ${crop.approved ? 'secondary' : ''}" type="button" data-action="approve-crop" data-id="${escapeAttribute(crop.id)}" data-approved="${crop.approved}">${crop.approved ? 'Remove approval' : 'Approve this exact match'}</button></div>` : ''}
  </article>`;
}
