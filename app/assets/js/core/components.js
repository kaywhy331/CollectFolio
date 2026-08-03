import { escapeAttribute, escapeHTML, formatCurrency, safeImageUrl } from './utils.js';

export function pageHeader(eyebrow, title, description = '', action = '') {
  return `<header class="page-header"><div><p class="eyebrow">${escapeHTML(eyebrow)}</p><h1>${escapeHTML(title)}</h1>${description ? `<p class="lede">${escapeHTML(description)}</p>` : ''}</div>${action}</header>`;
}

export function externalImage(item, className = '') {
  const url = safeImageUrl(item?.userImage || item?.imageSmall || item?.image);
  const label = item?.name || 'Collectible';
  return url
    ? `<img class="${escapeAttribute(className)}" src="${escapeAttribute(url)}" alt="${escapeAttribute(label)}" loading="lazy" referrerpolicy="no-referrer">`
    : `<div class="image-placeholder ${escapeAttribute(className)}" aria-label="No image available"><span>CF</span></div>`;
}

export function emptyState(title, detail, action = '') {
  return `<section class="empty-state"><span class="empty-symbol" aria-hidden="true">◇</span><h2>${escapeHTML(title)}</h2><p>${escapeHTML(detail)}</p>${action}</section>`;
}

export function priceDisclosure(item, currency = 'USD') {
  if (!item?.priceSource) return '<span class="muted">No provider price</span>';
  return `<span class="price-source">${escapeHTML(formatCurrency(item.price, currency))} · ${escapeHTML(item.priceSource)} · ${escapeHTML(item.priceUpdatedAt ? new Date(item.priceUpdatedAt).toLocaleDateString() : 'date unavailable')}</span>`;
}
