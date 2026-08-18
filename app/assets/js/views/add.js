import { pageHeader } from '../core/components.js';

export function renderAdd(state) {
  return `${pageHeader('Collection intake', 'Add collectibles', 'Start with a photo, catalog result, import, or custom record. Every item stays in review until you confirm it.')}
    ${state.scanDraftCount ? `<button class="draft-resume" type="button" data-action="resume-scan"><span aria-hidden="true">↥</span><span><strong>Continue saved review</strong><small>${state.scanDraftCount} local draft${state.scanDraftCount === 1 ? '' : 's'} ready on this device</small></span><span aria-hidden="true">→</span></button>` : ''}
    <section class="capture-hero"><div><p class="eyebrow">Recommended</p><h2>Scan or upload cards</h2><p>Choose one image. CollectFolio detects whether it contains one item or several, then lets you correct every crop and match.</p><button class="button" type="button" data-action="start-multi-scan">Choose camera or image</button></div><div class="capture-visual" aria-hidden="true"><span></span><span></span><span></span><span></span><i>+</i></div></section>
    <div class="section-heading compact"><div><p class="eyebrow">Other ways to start</p><h2>Use what you already have</h2></div></div>
    <div class="intake-grid unified">
      <button class="intake-card" type="button" data-go="search"><span class="symbol">⌕</span><span><h3>Search catalog</h3><p>Find an exact printing across every supported game and catalog.</p></span><span>→</span></button>
      <button class="intake-card" type="button" data-action="import-json"><span class="symbol">⇣</span><span><h3>Import backup</h3><p>Merge a validated CollectFolio JSON backup.</p></span><span>→</span></button>
      <button class="intake-card" type="button" data-action="export-json"><span class="symbol">⇡</span><span><h3>Export backup</h3><p>Download every portable local store before a move or bulk change.</p></span><span>→</span></button>
      <button class="intake-card" type="button" data-action="custom-holding"><span class="symbol">+</span><span><h3>Create custom item</h3><p>Add sports, comics, slabs, sealed products, or anything else.</p></span><span>→</span></button>
    </div>
    <input class="sr-only" id="backup-file" type="file" accept="application/json,.json">
    <p class="intake-privacy"><span aria-hidden="true">◇</span><span><strong>Private by default.</strong> Full source photos stay in this browser while you edit boundaries and are never uploaded.</span></p>`;
}
