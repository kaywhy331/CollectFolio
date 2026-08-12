import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogReferenceForItem } from '../app/assets/js/core/catalog-identity.js';
import { filterAndSortWatchlist, renderPortfolio, watchlistCardViewModel } from '../app/assets/js/views/portfolio.js';

const variantId = '123e4567-e89b-42d3-a456-426614174000';
const card = {
  provider: 'scryfall', externalId: 'card-1', category: 'magic', game: 'Magic', name: 'Future Card',
  setName: 'Evidence Set', number: '1', variant: 'foil', price: 100, currency: 'USD', priceSource: 'Scryfall'
};
const ref = catalogReferenceForItem(card, { canonicalVariantId: variantId });
const publication = {
  variantId, supportTier: 4, reasonCodes: [], sourceAttributions: [{ name: 'Approved source' }],
  publishedAt: '2026-08-10T00:00:00.000Z', payload: {
    observed: { price: 100, currency: 'USD', source: 'Approved source' },
    trend: { return7d: -0.02, return30d: -0.08, status: 'falling' },
    forecasts: { 30: { q10: 85, q25: 95, q50: 120, q75: 130, q90: 145, probabilityUp: 0.7, confidence: 70, modelVersion: 'approved-v1' } }
  }
};

const entry = { id: ref.watchKey, watchKey: ref.watchKey, canonicalVariantId: variantId, catalogRef: ref, targetPrice: 95, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-09T00:00:00.000Z' };

function state(overrides = {}) {
  return {
    holdings: [], watchlistItems: [], alerts: [], compare: [], settings: { currency: 'USD' },
    portfolio: { section: 'watchlist', query: '', category: 'all', sort: 'value-desc' },
    watchlist: { query: '', category: 'all', sort: 'opportunity-desc' },
    featureFlags: { watchlists: true, publicPriceIntelligence: true },
    intelligence: { byVariant: {}, loading: false, error: '' },
    ...overrides
  };
}

test('empty Watchlist is one focused action without zero metrics or filters', () => {
  const html = renderPortfolio(state());
  assert.match(html, /Track cards before you buy/);
  assert.match(html, /Watch prices, set targets, and follow future outlooks/);
  assert.match(html, />Find a card</);
  assert.doesNotMatch(html, /watchlist-controls|metric-card|0 results/);
});

test('best-opportunity scoring requires complete approved forecast evidence', () => {
  const supported = watchlistCardViewModel(entry, publication);
  const unsupportedRef = catalogReferenceForItem({ ...card, externalId: 'card-2', name: 'Unsupported Card' });
  const unsupported = { ...entry, id: unsupportedRef.watchKey, watchKey: unsupportedRef.watchKey, canonicalVariantId: '', catalogRef: unsupportedRef, targetPrice: 100 };
  assert.ok(supported.opportunityScore > 0);
  assert.equal(watchlistCardViewModel(unsupported).opportunityScore, null);
  const sorted = filterAndSortWatchlist([unsupported, entry], { [variantId]: publication }, { sort: 'opportunity-desc' });
  assert.equal(sorted[0].entry.watchKey, entry.watchKey);
  assert.equal(sorted[1].entry.watchKey, unsupported.watchKey);
});

test('populated Watchlist separates current value and future outlook with accessible alert state', () => {
  const html = renderPortfolio(state({
    watchlistItems: [entry], intelligence: { byVariant: { [variantId]: publication }, loading: false, error: '' },
    alerts: [{ id: 'signal', watchKey: entry.watchKey, message: 'Target is close', triggeredAt: '2026-08-10T00:00:00.000Z', readAt: '' }]
  }));
  assert.match(html, /Current market/);
  assert.match(html, /Future outlook/);
  assert.match(html, /\$95\.00–\$130\.00/);
  assert.match(html, /confidence 70\/100/);
  assert.match(html, /1 new alert/);
  assert.match(html, /Opportunity evidence/);
  assert.match(html, /data-action="remove-watch"/);
});
