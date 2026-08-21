import { escapeAttribute, escapeHTML, formatCurrency } from './utils.js';
import { catalogImageSources } from './catalog-images.js';
import { catalogPriceDisclosure, catalogPriceForValuation } from './pricing-policy.js';

export function pageHeader(eyebrow, title, description = '', action = '') {
  return `<header class="page-header"><div><p class="eyebrow">${escapeHTML(eyebrow)}</p><h1>${escapeHTML(title)}</h1>${description ? `<p class="lede">${escapeHTML(description)}</p>` : ''}</div>${action}</header>`;
}

function collectibleMediaKind(item = {}) {
  const hint = [item.productKind, item.productFormat, item.ownershipType, item.type, item.category]
    .filter(Boolean).join(' ').toLowerCase();
  if (/sealed|booster|box|pack|bundle|deck|tin/.test(hint)) return 'sealed';
  if (/comic|issue/.test(hint)) return 'comic';
  if (/slab|graded/.test(hint) || item.grade || item.gradeCompany) return 'slab';
  return 'card';
}

function mediaDimensions(kind) {
  return {
    sealed: [600, 600], comic: [350, 525], slab: [400, 600], card: [350, 490]
  }[kind] || [350, 490];
}

function placeholderMark(item = {}, kind = 'card') {
  if (kind === 'sealed') return 'BOX';
  if (kind === 'comic') return 'ISSUE';
  if (kind === 'slab') return 'SLAB';
  const source = String(item.game || item.category || item.name || 'Card').replace(/[^a-z0-9]+/gi, ' ').trim();
  const words = source.split(/\s+/).filter(Boolean);
  return (words.length > 1 ? `${words[0][0]}${words[1][0]}` : source.slice(0, 2)).toUpperCase() || 'CARD';
}

export function externalImage(item, className = '', { loading = 'lazy' } = {}) {
  const { sources, small, large } = catalogImageSources(item);
  const [url, fallback = ''] = sources;
  const label = item?.name || 'Collectible';
  const loadingMode = loading === 'eager' ? 'eager' : 'lazy';
  const kind = collectibleMediaKind(item);
  const [width, height] = mediaDimensions(kind);
  const mark = placeholderMark(item, kind);
  const classes = [className, `media-${kind}`].filter(Boolean).join(' ');
  const srcset = !item?.userImage && small && large && small !== large
    ? ` srcset="${escapeAttribute(small)} ${Math.min(width, 350)}w, ${escapeAttribute(large)} ${Math.max(width * 2, 700)}w"`
    : '';
  return url
    ? `<img class="${escapeAttribute(classes)}" src="${escapeAttribute(url)}"${srcset}${fallback ? ` data-fallback-src="${escapeAttribute(fallback)}"` : ''} data-retry-src="${escapeAttribute(url)}" data-image-label="${escapeAttribute(label)}" data-placeholder-mark="${escapeAttribute(mark)}" data-external-image alt="${escapeAttribute(label)}" width="${width}" height="${height}" sizes="(max-width: 479px) 44vw, (max-width: 919px) 30vw, 220px" loading="${loadingMode}" decoding="async" referrerpolicy="no-referrer">`
    : `<div class="image-placeholder ${escapeAttribute(classes)}" role="img" aria-label="No image available for ${escapeAttribute(label)}"><span aria-hidden="true">${escapeHTML(mark)}</span></div>`;
}

export function emptyState(title, detail, action = '') {
  return `<section class="empty-state"><span class="empty-symbol" aria-hidden="true">◇</span><h2>${escapeHTML(title)}</h2><p>${escapeHTML(detail)}</p>${action}</section>`;
}

export function priceDisclosure(item, currency = 'USD') {
  const restricted = catalogPriceDisclosure(item);
  if (restricted) return `<span class="price-source">${escapeHTML(restricted)}</span>`;
  if (!item?.priceSource) return '<span class="muted">No verified market price</span>';
  const price = catalogPriceForValuation(item);
  if (price === null) return '<span class="muted">No verified market price</span>';
  return `<span class="price-source">${escapeHTML(formatCurrency(price, currency))} · ${escapeHTML(item.priceSource)} · ${escapeHTML(item.priceUpdatedAt ? new Date(item.priceUpdatedAt).toLocaleDateString() : 'date unavailable')}</span>`;
}
