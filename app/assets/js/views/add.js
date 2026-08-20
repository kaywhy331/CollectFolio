import { pageHeader } from '../core/components.js';

export function renderAdd(state) {
  return `${pageHeader('Collection intake', 'Scan', 'Capture one collectible or a whole layout, then review every boundary and identity before anything is added.')}
    ${state.scanDraftCount ? `<button class="draft-resume" type="button" data-action="resume-scan"><span aria-hidden="true">↥</span><span><strong>Continue saved review</strong><small>${state.scanDraftCount} local draft${state.scanDraftCount === 1 ? '' : 's'} ready on this device</small></span><span aria-hidden="true">→</span></button>` : ''}
    <nav class="scan-flow-preview" aria-label="Scan workflow"><span><strong>1</strong> Scan or upload</span><span><strong>2</strong> Review detected items</span><span><strong>3</strong> Confirm and add</span></nav>
    <section class="capture-hero" data-scan-dropzone tabindex="0" aria-labelledby="scan-capture-title"><div><p class="eyebrow">Start here</p><h2 id="scan-capture-title">Add from a photo</h2><p>Use one item or several. You can move, resize, delete, and retry every detected boundary before identification starts.</p><div class="capture-actions"><button class="button" type="button" data-action="open-camera-scan">Open Camera</button><button class="button secondary" type="button" data-action="upload-scan">Upload Photo</button></div><p class="capture-help">On desktop, drop an image here or paste one from the clipboard. If camera permission is denied, Upload Photo still works.</p></div><div class="capture-visual" aria-hidden="true"><span></span><span></span><span></span><span></span><i>+</i></div></section>
    <div class="section-heading compact"><div><p class="eyebrow">Other ways to start</p><h2>Use what you already have</h2></div></div>
    <div class="intake-grid unified">
      <button class="intake-card" type="button" data-go="search"><span class="symbol">⌕</span><span><h3>Search catalog</h3><p>Find an exact printing across every supported game and catalog.</p></span><span>→</span></button>
      <button class="intake-card" type="button" data-action="import-json"><span class="symbol">⇣</span><span><h3>Import collection</h3><p>Merge a validated CollectFolio JSON backup. Export is available in Settings → Data &amp; Backups.</p></span><span>→</span></button>
      <button class="intake-card" type="button" data-action="custom-holding"><span class="symbol">+</span><span><h3>Create custom item</h3><p>Add sports, comics, slabs, sealed products, or anything else.</p></span><span>→</span></button>
    </div>
    <input class="sr-only" id="scan-camera-input" data-scan-input="camera" type="file" accept="image/*" capture="environment" aria-label="Take a photo for scanning">
    <input class="sr-only" id="scan-upload-input" data-scan-input="upload" type="file" accept="image/*" aria-label="Choose a photo for scanning">
    <input class="sr-only" id="backup-file" type="file" accept="application/json,.json" aria-label="Choose CollectFolio backup, up to 128 MB">
    <p class="intake-privacy"><span aria-hidden="true">◇</span><span><strong>Private by default.</strong> The full source photo is saved only on this device while the review is active, and you can delete it at any time. Cropping and text recognition run locally; only text queries and catalog identifiers may be sent to enabled catalog sources. Photos are never uploaded.</span></p>`;
}
