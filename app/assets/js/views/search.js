import { externalImage, pageHeader, priceDisclosure } from '../core/components.js';
import { escapeAttribute, escapeHTML, formatCurrency } from '../core/utils.js';

export function renderSearch(state) {
  const search = state.search;
  const manualCategory = ['sports', 'comics', 'slab', 'other'].includes(search.category);
  return `${pageHeader('Catalog discovery', 'Search collectibles', 'Free TCG catalogs are searched concurrently; sports, comics, slabs, and unsupported items use custom entry.', '<button class="button secondary" type="button" data-action="start-single-scan">Search by image</button>')}
    <form id="catalog-search" class="card">
      <div class="search-bar"><label class="sr-only" for="catalog-query">Search catalog</label><input id="catalog-query" name="query" type="search" required minlength="2" value="${escapeAttribute(search.query)}" placeholder="Name, set, number, character, or player"><button class="button" ${search.loading ? 'disabled' : ''}>${search.loading ? 'Searching…' : 'Search'}</button></div>
      <div class="filter-grid"><label>Category<select name="category">${categoryOptions(search.category)}</select></label><label>Provider<select name="provider"><option value="all" ${search.provider === 'all' ? 'selected' : ''}>All enabled providers</option><option value="pokemon" ${search.provider === 'pokemon' ? 'selected' : ''}>Pokémon TCG API</option><option value="scryfall" ${search.provider === 'scryfall' ? 'selected' : ''}>Scryfall</option><option value="ygoprodeck" ${search.provider === 'ygoprodeck' ? 'selected' : ''}>YGOPRODeck</option></select></label></div>
    </form>
    ${search.cached ? '<p class="fine-print">Showing the local 30-minute query cache.</p>' : ''}
    ${search.warnings.length ? `<div class="card" role="status"><p class="eyebrow">Partial results</p>${search.warnings.map((warning) => `<p class="muted">${escapeHTML(warning)}</p>`).join('')}</div>` : ''}
    ${manualCategory ? `<section class="empty-state"><span class="empty-symbol">+</span><h2>Use a custom holding</h2><p>${escapeHTML(search.category)} catalogs do not have universal free pricing in this MVP. Your photo can be the canonical image.</p><button class="button" type="button" data-action="custom-holding" data-category="${escapeAttribute(search.category)}">Create ${escapeHTML(search.category)} item</button></section>` : results(search.results, state.settings.currency)}`;
}

function categoryOptions(selected) {
  return [['all','All supported TCGs'],['pokemon','Pokémon'],['magic','Magic'],['yugioh','Yu-Gi-Oh!'],['sports','Sports — custom'],['comics','Comics — custom'],['slab','Graded slab — custom'],['other','Other — custom']]
    .map(([value, label]) => `<option value="${value}" ${selected === value ? 'selected' : ''}>${escapeHTML(label)}</option>`).join('');
}

function results(items, currency) {
  if (!items.length) return '<section class="empty-state"><span class="empty-symbol">⌕</span><h2>Find an exact printing</h2><p>Results include image, set, number, rarity or variant, selectable finish prices, source, and match score.</p></section>';
  return `<div class="section-heading"><div><p class="eyebrow">${items.length} results</p><h2>Catalog candidates</h2></div></div><div class="result-list">${items.map((item, index) => `<article class="result-card">${externalImage(item, 'result-image')}<div><h3>${escapeHTML(item.name)}</h3><p class="item-meta">${escapeHTML([item.game, item.setName, item.number, item.rarity || item.variant].filter(Boolean).join(' · '))}</p><p class="item-price">${item.price == null ? 'Price unavailable' : escapeHTML(formatCurrency(item.price, item.currency || currency))}</p>${priceDisclosure(item, item.currency || currency)}<div class="pill-row"><span class="pill">${escapeHTML(item.provider)}</span><span class="pill">${Math.round((item.matchScore || 0) * 100)}% text match</span>${item.priceOptions?.length > 1 ? `<span class="pill">${item.priceOptions.length} finishes</span>` : ''}</div><div class="item-actions"><button class="button small" type="button" data-action="add-catalog" data-index="${index}">Review and add</button></div></div></article>`).join('')}</div>`;
}
