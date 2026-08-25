import { pageHeader } from '../core/components.js';
import { escapeAttribute, escapeHTML } from '../core/utils.js';
import { cardRecognitionMode } from '../services/collectcapture.js';

// DCL-SCAN-02: the one shared "How photos are handled" disclosure. Written
// once here and rendered from both Add (below) and Review (scan.js) per
// RULE-1 -- the full recognition-mode explanation has exactly one home.
export function photoHandlingDisclosure() {
  const mode = cardRecognitionMode();
  const recognition = mode === 'local'
    ? 'Recognition runs locally on this device; nothing is uploaded.'
    : mode === 'unavailable'
      ? "Automatic recognition isn't available yet; you can still search by name or create a custom item."
      : 'Each card crop is sent once to CollectCapture, our recognition service, to suggest a match. It is not retained there, and sign-in is required.';
  return `<details class="photo-handling-disclosure"><summary>How photos are handled</summary><p class="fine-print">The full source photo never leaves this browser and is never saved; only a cropped copy of each card is used for identification. Saved drafts keep the crops and your review decisions on this device. ${recognition}</p></details>`;
}

function scanDraftControls(state = {}) {
  const drafts = Array.isArray(state.scanDrafts) ? state.scanDrafts : [];
  if (!drafts.length && !state.scanDraftCount) return '';
  if (!drafts.length) {
    return `<button class="draft-resume" type="button" data-action="resume-scan"><span aria-hidden="true">↥</span><span><strong>Continue saved review</strong><small>${state.scanDraftCount} local draft${state.scanDraftCount === 1 ? '' : 's'} ready on this device</small></span><span aria-hidden="true">→</span></button>`;
  }
  return `<section class="draft-manager" aria-labelledby="saved-scan-drafts"><div class="section-heading compact"><div><p class="eyebrow">Saved locally</p><h2 id="saved-scan-drafts">Scan drafts</h2></div><span>${drafts.length}</span></div><div class="draft-list">${drafts.map((draft, index) => {
    const cropCount = Array.isArray(draft.crops) ? draft.crops.length : 0;
    const updated = String(draft.updatedAt || draft.createdAt || '').slice(0, 10);
    const label = `Draft ${index + 1}`;
    return `<div class="draft-resume-row"><button class="draft-resume" type="button" data-action="resume-scan" data-draft-id="${escapeAttribute(draft.id)}"><span aria-hidden="true">↥</span><span><strong>${escapeHTML(label)}</strong><small>${cropCount} cropped ${cropCount === 1 ? 'item' : 'items'}${updated ? ` · updated ${escapeHTML(updated)}` : ''}</small></span><span aria-hidden="true">→</span></button><button class="button danger small" type="button" data-action="discard-scan" data-draft-id="${escapeAttribute(draft.id)}" aria-label="Discard ${escapeAttribute(label)}">Discard</button></div>`;
  }).join('')}</div></section>`;
}

export function renderAdd(state) {
  return `${pageHeader('Add items', 'Scan')}
    ${scanDraftControls(state)}
    <nav class="scan-flow-preview" aria-label="Scan workflow"><span><strong>1</strong> Scan or upload</span><span><strong>2</strong> Review detected items</span><span><strong>3</strong> Confirm and add</span></nav>
    <section class="capture-hero" data-scan-dropzone tabindex="0" aria-labelledby="scan-capture-title"><div><p class="eyebrow">Start here</p><h2 id="scan-capture-title">Add from a photo</h2><div class="capture-actions"><button class="button" type="button" data-action="open-camera-scan">Open Camera</button><button class="button secondary" type="button" data-action="upload-scan">Upload Photo</button></div><p class="capture-help">Drop or paste an image anywhere.</p></div><div class="capture-visual" aria-hidden="true"><span></span><span></span><span></span><span></span><i>+</i></div></section>
    <div class="section-heading compact"><div><p class="eyebrow">Other ways to start</p><h2>Use what you already have</h2></div></div>
    <div class="intake-grid unified">
      <button class="intake-card" type="button" data-go="search"><span class="symbol">⌕</span><span><h3>Search catalog</h3><p>Find an exact printing across every supported game and catalog.</p></span><span>→</span></button>
      <button class="intake-card" type="button" data-action="import-json"><span class="symbol">⇣</span><span><h3>Import collection</h3><p>Merge a CollectFolio backup file.</p></span><span>→</span></button>
      <button class="intake-card" type="button" data-action="custom-holding"><span class="symbol">+</span><span><h3>Create custom item</h3><p>Add sports, comics, slabs, sealed products, or anything else.</p></span><span>→</span></button>
    </div>
    <input class="sr-only" id="scan-camera-input" data-scan-input="camera" type="file" accept="image/*" capture="environment" aria-label="Take a photo for scanning">
    <input class="sr-only" id="scan-upload-input" data-scan-input="upload" type="file" accept="image/*" aria-label="Choose a photo for scanning">
    <input class="sr-only" id="backup-file" type="file" accept="application/json,.json" aria-label="Choose CollectFolio backup, up to 128 MB">
    <p class="intake-privacy"><span aria-hidden="true">◇</span><span><strong>Private by default.</strong> Photos stay on this device; only the card crop is sent for identification.</span></p>
    ${photoHandlingDisclosure()}`;
}
