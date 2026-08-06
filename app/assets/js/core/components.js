import { escapeAttribute, escapeHTML, formatCurrency, safeImageUrl } from './utils.js';
import { catalogPriceDisclosure, catalogPriceForValuation } from './pricing-policy.js';

export function pageHeader(eyebrow, title, description = '', action = '') {
  return `<header class="page-header"><div><p class="eyebrow">${escapeHTML(eyebrow)}</p><h1>${escapeHTML(title)}</h1>${description ? `<p class="lede">${escapeHTML(description)}</p>` : ''}</div>${action}</header>`;
}

export function externalImage(item, className = '', { loading = 'lazy' } = {}) {
  const sources = [...new Set([item?.userImage, item?.imageSmall, item?.image].map(safeImageUrl).filter(Boolean))];
  const [url, fallback = ''] = sources;
  const label = item?.name || 'Collectible';
  const loadingMode = loading === 'eager' ? 'eager' : 'lazy';
  return url
    ? `<img class="${escapeAttribute(className)}" src="${escapeAttribute(url)}"${fallback ? ` data-fallback-src="${escapeAttribute(fallback)}"` : ''} data-external-image alt="${escapeAttribute(label)}" loading="${loadingMode}" decoding="async" referrerpolicy="no-referrer">`
    : `<div class="image-placeholder ${escapeAttribute(className)}" aria-label="No image available"><span>CF</span></div>`;
}

export function emptyState(title, detail, action = '') {
  return `<section class="empty-state"><span class="empty-symbol" aria-hidden="true">◇</span><h2>${escapeHTML(title)}</h2><p>${escapeHTML(detail)}</p>${action}</section>`;
}

export function priceDisclosure(item, currency = 'USD') {
  const restricted = catalogPriceDisclosure(item);
  if (restricted) return `<span class="price-source">${escapeHTML(restricted)}</span>`;
  if (!item?.priceSource) return '<span class="muted">No provider price</span>';
  const price = catalogPriceForValuation(item);
  if (price === null) return '<span class="muted">No provider price</span>';
  return `<span class="price-source">${escapeHTML(formatCurrency(price, currency))} · ${escapeHTML(item.priceSource)} · ${escapeHTML(item.priceUpdatedAt ? new Date(item.priceUpdatedAt).toLocaleDateString() : 'date unavailable')}</span>`;
}
