import { externalImage, pageHeader } from '../core/components.js';
import { watchKeyForItem } from '../core/catalog-identity.js';
import { matchBucketFor } from '../core/view-models.js';
import { catalogPriceForValuation } from '../core/pricing-policy.js';
import { CURRENCIES } from '../core/settings.js';
import { escapeAttribute, escapeHTML, formatCurrency, safeImageUrl } from '../core/utils.js';
import { normalizeAcquisition, scanReviewSummary, scanReviewTotals, selectedCropItem } from '../services/scan-review.js';

const CONDITIONS = ['Mint', 'Near Mint', 'Excellent', 'Good', 'Played', 'Poor', 'Graded'];

function option(value, selected) {
  return `<option value="${escapeAttribute(value)}" ${value === selected ? 'selected' : ''}>${escapeHTML(value)}</option>`;
}

function acquisitionFields(acquisition, { bulk = false } = {}) {
  const value = normalizeAcquisition(acquisition);
  const marker = (field) => bulk ? '' : `data-crop-acquisition="${field}"`;
  return `<div class="acquisition-grid">
    <label>Quantity<input ${marker('quantity')} name="quantity" type="number" min="1" step="1" value="${escapeAttribute(value.quantity)}"></label>
    <label>Condition<select ${marker('condition')} name="condition">${CONDITIONS.map((condition) => option(condition, value.condition)).join('')}</select></label>
    <label>Purchase price / item<input ${marker('purchasePrice')} name="purchasePrice" type="number" min="0" step="0.01" value="${escapeAttribute(value.purchasePrice)}" placeholder="Optional"></label>
    <label>Purchase currency<select ${marker('purchaseCurrency')} name="purchaseCurrency">${CURRENCIES.map((entry) => option(entry, value.purchaseCurrency)).join('')}</select></label>
    <label>Fees (total, same currency)<input ${marker('fees')} name="fees" type="number" min="0" step="0.01" value="${escapeAttribute(value.fees)}" placeholder="Optional"></label>
    <label>Purchase date<input ${marker('purchaseDate')} name="purchaseDate" type="date" value="${escapeAttribute(value.purchaseDate)}"></label>
    <label>Seller / source<input ${marker('seller')} name="seller" maxlength="160" value="${escapeAttribute(value.seller)}" placeholder="Optional"></label>
    <label>Storage location<input ${marker('folder')} name="folder" maxlength="80" value="${escapeAttribute(value.folder)}" placeholder="Binder, box…"></label>
    <label>Manual current value<input ${marker('manualMarketPrice')} name="manualMarketPrice" type="number" min="0" step="0.01" value="${escapeAttribute(value.manualMarketPrice)}" placeholder="Optional"><span class="fine-print">Your private estimate starts a local scenario without waiting for published pricing.</span></label>
    <label>Manual-value currency<select ${marker('manualMarketCurrency')} name="manualMarketCurrency">${CURRENCIES.map((entry) => option(entry, value.manualMarketCurrency)).join('')}</select></label>
    <label>Grading company<input ${marker('gradeCompany')} name="gradeCompany" maxlength="40" value="${escapeAttribute(value.gradeCompany)}" placeholder="PSA, CGC, BGS"></label>
    <label>Grade<input ${marker('grade')} name="grade" maxlength="20" value="${escapeAttribute(value.grade)}" placeholder="10"></label>
    ${bulk ? '' : `<label class="span-all">Notes<textarea ${marker('notes')} name="notes" maxlength="2000" placeholder="Provenance or condition notes">${escapeHTML(value.notes)}</textarea></label>`}
  </div>`;
}

function queueSummary(summary) {
  return `<section class="review-summary" aria-label="Review queue summary">
    <div><span>Total detected</span><strong>${summary.total}</strong></div>
    <div><span>Exact matches</span><strong>${summary.exact}</strong></div>
    <div><span>Needs review</span><strong>${summary.needsReview}</strong></div>
    <div><span>Unmatched</span><strong>${summary.unmatched}</strong></div>
  </section>`;
}

function bulkAcquisition(draft) {
  return `<details class="bulk-acquisition" open>
    <summary><span><strong>Apply acquisition details to all</strong><small>Set shared purchase and storage details once, then refine any item below.</small></span><span aria-hidden="true">+</span></summary>
    <form id="bulk-acquisition-form" class="bulk-acquisition-body">
      ${acquisitionFields(draft.bulkAcquisition, { bulk: true })}
      <div class="bulk-acquisition-actions"><p>Filled values replace the same fields on every detected item. It never approves a match.</p><button class="button secondary" type="button" data-action="apply-acquisition-all">Apply to all ${draft.crops.length}</button></div>
    </form>
  </details>`;
}

function matchStatus(crop, selected) {
  if (!selected) return ['unmatched', 'Unmatched'];
  if (crop.customItem) return ['possible', 'Custom identity'];
  const bucket = matchBucketFor(selected);
  return [bucket, bucket === 'exact' ? 'Exact source identity' : bucket === 'likely' ? 'Likely match' : 'Possible match'];
}

function selectedMatch(crop, selected, state) {
  if (!selected) return '';
  const watching = state.watchlistItems?.some((entry) => entry.watchKey === watchKeyForItem(selected));
  const [bucket, label] = matchStatus(crop, selected);
  return `<section class="selected-match">
    <div><p class="eyebrow">Selected catalog candidate</p><h3>${escapeHTML(selected.name)}</h3><p class="item-meta">${escapeHTML([selected.game, selected.setName, selected.number, selected.variant || selected.finish].filter(Boolean).join(' · '))}</p><span class="match-state ${escapeAttribute(bucket)}">${escapeHTML(label)}</span></div>
    <div class="button-row"><button class="button ${crop.approved ? 'secondary' : ''}" type="button" data-action="approve-crop" data-id="${escapeAttribute(crop.id)}" data-approved="${crop.approved}">${crop.approved ? 'Approved · remove approval' : 'Use this card'}</button>${state.featureFlags?.watchlists !== false ? `<button class="button ghost" type="button" data-action="toggle-watch" data-crop-watch="${escapeAttribute(crop.id)}">${watching ? '★ Watching' : '☆ Watch'}</button>` : ''}</div>
  </section>`;
}

function candidateList(crop) {
  if (!crop.candidates.length) return '';
  return `<details class="candidate-disclosure" ${crop.selectedId ? '' : 'open'}><summary>Choose or replace match <span>${crop.candidates.length} candidates</span></summary><div class="candidate-list">${crop.candidates.slice(0, 9).map((candidate) => {
    const price = catalogPriceForValuation(candidate);
    const similarity = candidate.matchScore >= 0.72 ? 'Strong similarity' : candidate.matchScore >= 0.45 ? 'Moderate similarity' : 'Possible candidate';
    return `<button class="candidate ${candidate.id === crop.selectedId ? 'selected' : ''}" type="button" data-action="select-candidate" data-id="${escapeAttribute(crop.id)}" data-candidate="${escapeAttribute(candidate.id)}">${externalImage(candidate, 'candidate-image', { loading: 'eager' })}<strong>${escapeHTML(candidate.name)}</strong><span>${escapeHTML([candidate.setName, candidate.number, candidate.variant].filter(Boolean).join(' · '))}</span><span>${price === null ? 'Current value unavailable' : escapeHTML(formatCurrency(price, candidate.currency || 'USD'))} · ${similarity}</span></button>`;
  }).join('')}</div></details>`;
}

function cropCard(crop, index, state) {
  const selected = selectedCropItem(crop);
  const [bucket, label] = matchStatus(crop, selected);
  return `<article class="review-card ${crop.approved ? 'approved' : ''}" data-crop-id="${escapeAttribute(crop.id)}">
    <div class="review-head"><img src="${escapeAttribute(safeImageUrl(crop.image))}" alt="Crop ${index + 1}" referrerpolicy="no-referrer"><div><div class="review-item-kicker"><span>Item ${index + 1}</span><span class="match-state ${escapeAttribute(bucket)}">${escapeHTML(label)}</span>${crop.approved ? '<span class="approval-state">Approved</span>' : ''}</div><h2>${escapeHTML(selected?.name || 'Identify this crop')}</h2><p class="muted">${crop.approved ? 'This item will be included with the acquisition details below.' : selected ? 'Confirm the identity, fill acquisition details, then approve it.' : 'Search with OCR or a typed query, or create a custom identity.'}</p></div></div>
    <div class="match-workspace"><label>OCR or catalog query<input data-crop-query value="${escapeAttribute(crop.query)}" placeholder="Type a name, set, or number"></label>
      ${crop.ocrEngine ? `<p class="fine-print">OCR: ${escapeHTML(crop.ocrEngine)}${crop.query ? ' · reliable card text selected locally' : ''}</p>` : ''}
      ${crop.status === 'identifying' ? '<p class="fine-print" role="status">Identifying locally. First-use OCR may take a few seconds.</p>' : ''}
      ${crop.error ? `<p class="fine-print negative" role="status">${escapeHTML(crop.error)}</p>` : ''}
      <div class="button-row"><button class="button secondary small" type="button" data-action="identify-crop" data-id="${escapeAttribute(crop.id)}" ${crop.status === 'identifying' ? 'disabled' : ''}>${crop.status === 'identifying' ? 'Identifying…' : crop.query ? 'Search / retry' : 'Run OCR'}</button><button class="button ghost small" type="button" data-action="custom-crop" data-id="${escapeAttribute(crop.id)}">Create custom</button><button class="button ghost small" type="button" data-action="delete-crop" data-id="${escapeAttribute(crop.id)}">Exclude item</button></div>
    </div>
    ${candidateList(crop)}
    ${selectedMatch(crop, selected, state)}
    ${selected ? `<details class="crop-acquisition" ${crop.approved ? 'open' : ''}><summary><span><strong>Acquisition details</strong><small>Quantity, cost, grading, and storage for this item.</small></span><span aria-hidden="true">+</span></summary><div>${acquisitionFields(crop.acquisition)}</div></details>` : ''}
  </article>`;
}

function confirmationBar(draft, summary, totals, currency) {
  const coverage = totals.items ? Math.round((totals.priced / totals.items) * 100) : 0;
  return `<section class="review-confirmation" aria-label="Approved intake summary">
    <div><p class="eyebrow">Ready to add</p><strong>${summary.approved} of ${summary.total} approved</strong><span>${totals.quantity} total quantity · ${escapeHTML(formatCurrency(totals.costBasis, currency))} ${escapeHTML(currency)} cost basis · ${coverage}% pricing coverage</span><small>Destination: Local portfolio. Unapproved and unmatched items are skipped.${totals.excludedCostItems ? ` ${totals.excludedCostItems} other-currency cost entr${totals.excludedCostItems === 1 ? 'y is' : 'ies are'} kept separate.` : ''}</small></div>
    <button class="button" type="button" data-action="batch-add" ${summary.approved && draft.status !== 'adding' ? '' : 'disabled'}>${draft.status === 'adding' ? 'Adding…' : `Add ${summary.approved} approved`}</button>
  </section>`;
}

function successView(draft, state) {
  const result = draft.result || { added: draft.addedCount || 0, skipped: 0, unresolved: 0, quantity: draft.addedCount || 0, costBasis: 0 };
  const currency = result.currency || state.settings?.currency || 'USD';
  return `${pageHeader('Collection intake', 'Items added', 'Your approved items are saved locally and the portfolio snapshot has been updated.')}
    <section class="intake-success" role="status">
      <span class="success-mark" aria-hidden="true">✓</span><h2>${result.added} item${result.added === 1 ? '' : 's'} added</h2>
      <p>${result.quantity} total quantity · ${escapeHTML(formatCurrency(result.costBasis, currency))} recorded ${escapeHTML(currency)} cost basis${result.excludedCostItems ? ` · ${result.excludedCostItems} other-currency entr${result.excludedCostItems === 1 ? 'y' : 'ies'} kept separate` : ''}</p>
      <dl><div><dt>Added</dt><dd>${result.added}</dd></div><div><dt>Skipped</dt><dd>${result.skipped}</dd></div><div><dt>Still unresolved</dt><dd>${result.unresolved}</dd></div></dl>
      <div class="button-row"><button class="button" type="button" data-go="portfolio" data-portfolio-target="holdings">View portfolio</button><button class="button secondary" type="button" data-go="add">Continue adding</button></div>
    </section>`;
}

export function renderScanReview(draft, state = {}) {
  if (!draft) return `${pageHeader('Collection intake', 'No saved review selected', 'Return to Add to begin a scan or resume a local draft.')}<section class="empty-state"><h2>Nothing is waiting for review</h2><p>Choose one image and CollectFolio will detect one or several items automatically.</p><button class="button" type="button" data-go="add">Back to Add</button></section>`;
  if (draft.status === 'complete') return successView(draft, state);
  const summary = scanReviewSummary(draft);
  const currency = state.settings?.currency || 'USD';
  const totals = scanReviewTotals(draft, currency);
  return `${pageHeader('Collection intake', `Review ${draft.crops.length} detected item${draft.crops.length === 1 ? '' : 's'}`, 'Resolve each identity, add shared acquisition details, then explicitly approve only the items you want.', '<button class="button secondary small" type="button" data-action="save-scan">Save draft</button>')}
    <nav class="intake-steps" aria-label="Intake progress"><span class="complete">1 · Capture</span><span class="complete">2 · Detect</span><span aria-current="step">3 · Review</span><span>4 · Add</span></nav>
    ${queueSummary(summary)}
    ${draft.submissionError ? `<p class="inline-warning" role="status">${escapeHTML(draft.submissionError)}</p>` : ''}
    <p class="intake-privacy"><span aria-hidden="true">◇</span><span><strong>Local review.</strong> Crops and decisions persist in IndexedDB. The full source photo is never uploaded or saved in this draft.</span></p>
    ${bulkAcquisition(draft)}
    <div class="review-list">${draft.crops.map((crop, index) => cropCard(crop, index, state)).join('')}</div>
    ${confirmationBar(draft, summary, totals, currency)}`;
}
