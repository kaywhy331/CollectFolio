import { externalImage, pageHeader } from '../core/components.js';
import { matchBucketFor } from '../core/view-models.js';
import { catalogPriceForValuation } from '../core/pricing-policy.js';
import { CURRENCIES, DEFAULT_LANGUAGES } from '../core/settings.js';
import { RAW_MARKET_CONDITIONS } from '../core/market-series.js';
import { escapeAttribute, escapeHTML, formatCurrency, safeImageUrl } from '../core/utils.js';
import { cropHasApprovableIdentity, normalizeAcquisition, scanReviewSummary, scanReviewTotals, selectedCropItem } from '../services/scan-review.js';
import { cardRecognitionMode } from '../services/collectcapture.js';
import { findWatchedItem } from '../services/watchlist.js';

const CONDITIONS = ['Mint', 'Near Mint', 'Excellent', 'Good', 'Played', 'Poor', 'Graded'];
const LANGUAGE_LABELS = Object.freeze({ en: 'English', ja: 'Japanese', fr: 'French', de: 'German', es: 'Spanish', it: 'Italian', pt: 'Portuguese', ko: 'Korean', zh: 'Chinese', other: 'Other' });

function option(value, selected, label = value) {
  return `<option value="${escapeAttribute(value)}" ${value === selected ? 'selected' : ''}>${escapeHTML(label)}</option>`;
}

function acquisitionFields(acquisition, { bulk = false } = {}) {
  const value = normalizeAcquisition(acquisition);
  const marker = (field) => bulk ? '' : `data-crop-acquisition="${field}"`;
  return `<div class="acquisition-grid">
    <label>Quantity<input ${marker('quantity')} name="quantity" type="number" min="1" step="1" value="${escapeAttribute(value.quantity)}"></label>
    <label>Collection condition<select ${marker('condition')} name="condition">${CONDITIONS.map((condition) => option(condition, value.condition)).join('')}</select></label>
    <label>Language<select ${marker('language')} name="language">${DEFAULT_LANGUAGES.map((language) => option(language, value.language, LANGUAGE_LABELS[language] || language.toUpperCase())).join('')}</select></label>
    <label>Marketplace condition<select ${marker('marketCondition')} name="marketCondition"><option value="">Not confirmed</option>${RAW_MARKET_CONDITIONS.map((entry) => option(entry.value, value.marketCondition, entry.label)).join('')}</select><span class="fine-print">Required for an exact-condition market forecast; never inferred from collection condition.</span></label>
    <label>Purchase price / item<input ${marker('purchasePrice')} name="purchasePrice" type="number" min="0" step="0.01" value="${escapeAttribute(value.purchasePrice)}" placeholder="Optional"></label>
    <label>Purchase currency<select ${marker('purchaseCurrency')} name="purchaseCurrency">${CURRENCIES.map((entry) => option(entry, value.purchaseCurrency)).join('')}</select></label>
    <label>Fees (total, same currency)<input ${marker('fees')} name="fees" type="number" min="0" step="0.01" value="${escapeAttribute(value.fees)}" placeholder="Optional"></label>
    <label>Purchase date<input ${marker('purchaseDate')} name="purchaseDate" type="date" value="${escapeAttribute(value.purchaseDate)}"></label>
    <label>Seller / source<input ${marker('seller')} name="seller" maxlength="160" value="${escapeAttribute(value.seller)}" placeholder="Optional"></label>
    <label>Storage location<input ${marker('folder')} name="folder" maxlength="80" value="${escapeAttribute(value.folder)}" placeholder="Binder, box…"></label>
    <label>Manual current value<input ${marker('manualMarketPrice')} name="manualMarketPrice" type="number" min="0" step="0.01" value="${escapeAttribute(value.manualMarketPrice)}" placeholder="Optional"><span class="fine-print">Your private estimate starts your scenario without waiting for published pricing.</span></label>
    <label>Manual-value currency<select ${marker('manualMarketCurrency')} name="manualMarketCurrency">${CURRENCIES.map((entry) => option(entry, value.manualMarketCurrency)).join('')}</select></label>
    <label>Grading company<input ${marker('gradeCompany')} name="gradeCompany" maxlength="40" value="${escapeAttribute(value.gradeCompany)}" placeholder="PSA, CGC, BGS"></label>
    <label>Grade<input ${marker('grade')} name="grade" maxlength="20" value="${escapeAttribute(value.grade)}" placeholder="10"></label>
    <label class="scan-photo-retention span-all"><input type="hidden" name="retainPhoto" value="false"><input ${marker('retainPhoto')} name="retainPhoto" type="checkbox" value="true" ${value.retainPhoto ? 'checked' : ''}><span><strong>Keep this cropped photo with the collection item</strong><small>Optional. Leave off to discard scan imagery after the item is added.</small></span></label>
    ${bulk ? '' : `<label class="span-all">Notes<textarea ${marker('notes')} name="notes" maxlength="2000" placeholder="Provenance or condition notes">${escapeHTML(value.notes)}</textarea></label>`}
  </div>`;
}

function queueSummary(summary) {
  return `<section class="review-summary" aria-label="Review queue summary">
    <div><span>Total detected</span><strong>${summary.total}</strong></div>
    <div><span>Catalog selections</span><strong>${summary.exact}</strong></div>
    <div><span>Needs review</span><strong>${summary.needsReview}</strong></div>
    <div><span>Unmatched</span><strong>${summary.unmatched}</strong></div>
  </section>`;
}

function bulkAcquisition(draft) {
  return `<details class="bulk-acquisition" open>
    <summary><span><strong>Apply purchase details to all</strong><small>Set shared purchase and storage details once, then refine any item below.</small></span><span aria-hidden="true">+</span></summary>
    <form id="bulk-acquisition-form" class="bulk-acquisition-body">
      ${acquisitionFields(draft.bulkAcquisition, { bulk: true })}
      <div class="bulk-acquisition-actions"><p>Filled values replace the same fields on every detected item. It never approves a match.</p><button class="button secondary" type="button" data-action="apply-acquisition-all">Apply to all ${draft.crops.length}</button></div>
    </form>
  </details>`;
}

function matchStatus(crop, selected) {
  if (!selected && ['queued', 'identifying'].includes(crop.status)) return ['possible', crop.status === 'queued' ? 'Queued' : 'Identifying'];
  if (!selected) return ['unmatched', 'Unmatched'];
  if (crop.customItem) return ['possible', 'Custom identity'];
  if (cropHasApprovableIdentity(crop)) return ['exact', crop.approved ? 'Confirmed printing' : 'Catalog printing selected'];
  const bucket = matchBucketFor(selected);
  return [bucket, bucket === 'exact' ? 'Catalog printing selected' : bucket === 'likely' ? 'Likely match' : 'Possible match'];
}

function selectedMatch(crop, selected, state) {
  if (!selected) return '';
  const watching = Boolean(findWatchedItem(state.watchlistItems, selected));
  const [bucket, label] = matchStatus(crop, selected);
  const approvable = cropHasApprovableIdentity(crop);
  const approved = crop.approved && approvable;
  const helpId = `exact-match-help-${crop.id}`;
  const confirmationLabel = crop.customItem ? 'Confirm custom item' : approvable ? 'Confirm this printing' : 'Catalog printing required';
  return `<section class="selected-match">
    <div><p class="eyebrow">Proposed match</p><h3>${escapeHTML(selected.name)}</h3><p class="item-meta">${escapeHTML([selected.game, selected.setName, selected.number, selected.variant || selected.finish].filter(Boolean).join(' · '))}</p><span class="match-state ${escapeAttribute(bucket)}">${escapeHTML(label)}</span></div>
    <div class="button-row"><button class="button ${approved ? 'secondary' : ''}" type="button" data-action="approve-crop" data-id="${escapeAttribute(crop.id)}" data-approved="${approved}" ${approvable ? '' : `disabled aria-describedby="${escapeAttribute(helpId)}"`}>${approved ? 'Confirmed · remove confirmation' : confirmationLabel}</button>${state.featureFlags?.watchlists !== false ? `<button class="button ghost" type="button" data-action="toggle-watch" data-crop-watch="${escapeAttribute(crop.id)}">${watching ? '★ Watching' : '☆ Watch'}</button>` : ''}</div>
    ${approvable ? '' : `<p id="${escapeAttribute(helpId)}" class="fine-print">Choose a catalog printing or create a custom item. A lookup suggestion is never approved automatically.</p>`}
  </section>`;
}

function candidateList(crop, recognitionMode) {
  if (!crop.candidates.length) return '';
  return `<details class="candidate-disclosure" ${crop.selectedId ? '' : 'open'}><summary>Choose or replace match <span>${crop.candidates.length} candidates</span></summary><div class="candidate-list">${crop.candidates.slice(0, 9).map((candidate) => {
    const price = catalogPriceForValuation(candidate);
    const relevance = recognitionMode === 'local'
      ? candidate.matchScore >= 0.72 ? 'Strong similarity' : candidate.matchScore >= 0.45 ? 'Moderate similarity' : 'Possible candidate'
      : candidate.matchScore >= 0.72 ? 'Strong lookup match' : candidate.matchScore >= 0.45 ? 'Moderate lookup match' : 'Possible candidate';
    const mapped = candidate.tcgcsvMappingStatus === 'mapped' ? ' · TCGCSV linked' : '';
    return `<button class="candidate ${candidate.id === crop.selectedId ? 'selected' : ''}" type="button" data-action="select-candidate" data-id="${escapeAttribute(crop.id)}" data-candidate="${escapeAttribute(candidate.id)}">${externalImage(candidate, 'candidate-image', { loading: 'lazy' })}<strong>${escapeHTML(candidate.name)}</strong><span>${escapeHTML([candidate.setName, candidate.number, candidate.variant].filter(Boolean).join(' · '))}</span><span>${price === null ? 'Current value unavailable' : escapeHTML(formatCurrency(price, candidate.currency || 'USD'))} · ${relevance}${mapped}</span></button>`;
  }).join('')}</div></details>`;
}

function cropCard(crop, index, state, canEditBoundary = false, recognitionMode = 'unavailable') {
  const selected = selectedCropItem(crop);
  const [bucket, label] = matchStatus(crop, selected);
  const collectCapture = recognitionMode === 'collectcapture';
  const localRollback = recognitionMode === 'local';
  const pendingCopy = collectCapture
    ? 'Sending this bounded crop to CollectCapture for recognition and catalog suggestions.'
    : localRollback
      ? 'Reading this bounded crop with the explicit local scanner rollback.'
      : 'Automatic identification is unavailable until CollectCapture is configured.';
  const retryCopy = collectCapture ? 'Retry card lookup' : localRollback ? 'Retry text recognition' : 'Retry unavailable';
  return `<article class="review-card ${crop.approved ? 'approved' : ''}" data-crop-id="${escapeAttribute(crop.id)}">
    <div class="review-head"><img src="${escapeAttribute(safeImageUrl(crop.image))}" alt="Straightened item ${index + 1}" width="350" height="490" loading="lazy" decoding="async" referrerpolicy="no-referrer"><div><div class="review-item-kicker"><span>Item ${index + 1}</span><span class="match-state ${escapeAttribute(bucket)}">${escapeHTML(label)}</span>${crop.approved ? '<span class="approval-state">Approved</span>' : ''}</div><h2>${escapeHTML(selected?.name || (['queued', 'identifying'].includes(crop.status) ? 'Identifying this item' : 'Identify this item'))}</h2><p class="muted">${crop.approved ? 'This item will be included with the purchase details below.' : selected ? 'Confirm the identity, fill purchase details, then approve it.' : ['queued', 'identifying'].includes(crop.status) ? pendingCopy : collectCapture ? 'Retry card lookup, enter a query, or create a custom identity.' : localRollback ? 'Retry text recognition, enter a query, or create a custom identity.' : 'Create a custom identity now, or retry after CollectCapture is configured.'}</p></div></div>
    <div class="match-workspace"><label>Item name, set, or number<input data-crop-query value="${escapeAttribute(crop.query)}" placeholder="Type a name, set, or number"></label>
      ${crop.ocrEngine ? `<details class="recognition-details"><summary>Recognition details</summary><p class="fine-print">${escapeHTML(crop.ocrEngine)}${crop.query ? (collectCapture ? ' · based on the crop or query you sent' : ' · reliable item text selected locally') : ''}</p></details>` : ''}
      ${['queued', 'identifying'].includes(crop.status) ? `<p class="fine-print" role="status">${collectCapture ? 'CollectCapture is checking this crop. You will choose and confirm any suggested printing.' : localRollback ? 'Local rollback recognition is checking this crop.' : 'Automatic identification is unavailable in this build.'}</p>` : ''}
      ${crop.error ? `<p class="fine-print negative" role="status">${escapeHTML(crop.error)}</p>` : ''}
      <div class="button-row"><button class="button secondary small" type="button" data-action="identify-crop" data-id="${escapeAttribute(crop.id)}" ${['queued', 'identifying'].includes(crop.status) || recognitionMode === 'unavailable' ? 'disabled' : ''}>${['queued', 'identifying'].includes(crop.status) ? 'Identifying…' : crop.query ? (collectCapture ? 'Search CollectCapture' : 'Search locally') : retryCopy}</button>${canEditBoundary ? `<button class="button secondary small" type="button" data-action="edit-crop" data-id="${escapeAttribute(crop.id)}">Edit crop boundary</button>` : ''}<button class="button ghost small" type="button" data-action="custom-crop" data-id="${escapeAttribute(crop.id)}">Create custom item</button><button class="button ghost small" type="button" data-action="delete-crop" data-id="${escapeAttribute(crop.id)}">Delete crop</button></div>
    </div>
    ${candidateList(crop, recognitionMode)}
    ${selectedMatch(crop, selected, state)}
    ${selected ? `<details class="crop-acquisition" ${crop.approved ? 'open' : ''}><summary><span><strong>Purchase details</strong><small>Quantity, cost, grading, and storage for this item.</small></span><span aria-hidden="true">+</span></summary><div>${acquisitionFields(crop.acquisition)}</div></details>` : ''}
  </article>`;
}

function confirmationBar(draft, summary, totals, currency) {
  const coverage = totals.items ? Math.round((totals.priced / totals.items) * 100) : 0;
  return `<section class="review-confirmation" aria-label="Approved intake summary">
    <div><p class="eyebrow">Ready to add</p><strong>${summary.approved} of ${summary.total} confirmed</strong><span>${totals.quantity} total quantity · ${escapeHTML(formatCurrency(totals.costBasis, currency))} ${escapeHTML(currency)} cost basis · ${coverage}% pricing coverage</span><small>Destination: Local collection. Unconfirmed and unmatched items are skipped.${totals.excludedCostItems ? ` ${totals.excludedCostItems} other-currency cost entr${totals.excludedCostItems === 1 ? 'y is' : 'ies are'} kept separate.` : ''}</small></div>
    <button class="button" type="button" data-action="batch-add" ${summary.approved && draft.status !== 'adding' ? '' : 'disabled'}>${draft.status === 'adding' ? 'Adding…' : `Add ${summary.approved} confirmed`}</button>
  </section>`;
}

function successView(draft, state) {
  const result = draft.result || { added: draft.addedCount || 0, skipped: 0, unresolved: 0, quantity: draft.addedCount || 0, costBasis: 0 };
  const currency = result.currency || state.settings?.currency || 'USD';
  return `${pageHeader('Collection intake', 'Items added', 'Your confirmed items are saved locally and the collection snapshot has been updated.')}
    <section class="intake-success" role="status">
      <span class="success-mark" aria-hidden="true">✓</span><h2>${result.added} item${result.added === 1 ? '' : 's'} added</h2>
      <p>${result.quantity} total quantity · ${escapeHTML(formatCurrency(result.costBasis, currency))} recorded ${escapeHTML(currency)} cost basis${result.excludedCostItems ? ` · ${result.excludedCostItems} other-currency entr${result.excludedCostItems === 1 ? 'y' : 'ies'} kept separate` : ''}</p>
      <dl><div><dt>Added</dt><dd>${result.added}</dd></div><div><dt>Skipped</dt><dd>${result.skipped}</dd></div><div><dt>Still unresolved</dt><dd>${result.unresolved}</dd></div></dl>
      <div class="button-row"><button class="button" type="button" data-go="portfolio" data-portfolio-target="holdings">View collection</button><button class="button secondary" type="button" data-go="add">Scan more</button></div>
    </section>`;
}

export function renderScanReview(draft, state = {}) {
  if (!draft) return `${pageHeader('Collection intake', 'No saved review selected', 'Return to Scan to capture a photo or resume a local draft.')}<section class="empty-state"><h2>Nothing is waiting for review</h2><p>Choose one image and CollectFolio will detect one or several items automatically.</p><button class="button" type="button" data-go="add">Back to Scan</button></section>`;
  if (draft.status === 'complete') return successView(draft, state);
  const summary = scanReviewSummary(draft);
  const currency = state.settings?.currency || 'USD';
  const totals = scanReviewTotals(draft, currency);
  const sourceAvailable = Boolean(state.scanSourceAvailable);
  const recognitionMode = state.cardRecognitionMode || cardRecognitionMode();
  const recognitionPrivacy = recognitionMode === 'collectcapture'
    ? 'For each lookup, one bounded, metadata-free card crop is sent transiently to CollectCapture over an authenticated connection. CollectCapture verifies the crop but does not retain it; its recognition provider processes it under the configured provider controls. Saved crops and review decisions remain in local browser storage.'
    : recognitionMode === 'local'
      ? 'Saved crops and review decisions remain in local browser storage. Recognition runs locally because the explicit scanner rollback is active; photos are not uploaded.'
      : 'Saved crops and review decisions remain in local browser storage. Automatic identification is unavailable until CollectCapture is configured; there is no silent local fallback.';
  const headerActions = `<div class="button-row"><button class="button secondary small" type="button" data-action="save-scan">Save draft</button><button class="button danger small" type="button" data-action="discard-scan" data-draft-id="${escapeAttribute(draft.id)}">Discard draft</button></div>`;
  return `${pageHeader('Collection intake', `Review ${draft.crops.length} detected item${draft.crops.length === 1 ? '' : 's'}`, 'Resolve each identity, add shared purchase details, then explicitly approve only the items you want.', headerActions)}
    <nav class="intake-steps" aria-label="Intake progress"><span class="complete">1 · Scan or upload</span><span aria-current="step">2 · Review detected items</span><span>3 · Confirm and add</span></nav>
    ${queueSummary(summary)}
    ${draft.submissionError ? `<p class="inline-warning" role="status">${escapeHTML(draft.submissionError)}</p>` : ''}
    <section class="scan-source-privacy"><div><span aria-hidden="true">◇</span><p><strong>${sourceAvailable ? 'The full source photo stays only in browser memory for this open review.' : 'The full source photo is not stored with this draft.'}</strong> ${escapeHTML(recognitionPrivacy)}</p></div>${sourceAvailable ? '<button class="button ghost small" type="button" data-action="release-source-photo">Release source copy now</button>' : ''}</section>
    ${bulkAcquisition(draft)}
    <div class="review-list">${draft.crops.map((crop, index) => cropCard(crop, index, state, sourceAvailable, recognitionMode)).join('')}</div>
    ${confirmationBar(draft, summary, totals, currency)}`;
}
