import { pageHeader } from '../core/components.js';

export function renderAdd(state) {
  return `${pageHeader('Collection intake', 'Add collectibles', 'Choose the fastest path and review every item before it enters your portfolio.')}
    ${state.scanDraftCount ? `<button class="button secondary" type="button" data-action="resume-scan">Resume saved scan (${state.scanDraftCount})</button>` : ''}
    <div class="intake-grid">
      <button class="intake-card" type="button" data-action="start-multi-scan"><span class="symbol">▦</span><span><h2>Scan multiple items</h2><p>Detect and edit several crop boundaries.</p></span><span>→</span></button>
      <button class="intake-card" type="button" data-action="start-single-scan"><span class="symbol">□</span><span><h2>Scan one item</h2><p>Use the same OCR and approval queue.</p></span><span>→</span></button>
      <button class="intake-card" type="button" data-go="search"><span class="symbol">⌕</span><span><h2>Search catalogs</h2><p>Pokémon, Magic, and Yu-Gi-Oh! metadata.</p></span><span>→</span></button>
      <button class="intake-card" type="button" data-action="custom-holding"><span class="symbol">+</span><span><h2>Create custom item</h2><p>Sports, comics, slabs, and anything else.</p></span><span>→</span></button>
    </div>`;
}
