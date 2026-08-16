import test from 'node:test';
import assert from 'node:assert/strict';
import {
  selectExactPublication,
  selectPublicationForCatalogItem,
  selectPublicationForWatchlist
} from '../app/assets/js/core/market-series.js';

const item = {
  language: 'en',
  finish: 'foil',
  conditionClass: 'raw',
  marketCondition: 'near-mint'
};

const identity = {
  sourceId: 'licensed-source',
  currency: 'USD',
  language: 'en',
  finish: 'foil',
  conditionClass: 'raw',
  marketCondition: 'near-mint',
  priceSemantics: 'market'
};

function publication(overrides = {}) {
  return {
    publicationId: overrides.publicationId || 'publication',
    publishedAt: overrides.publishedAt || '2026-08-01T00:00:00.000Z',
    seriesIdentity: { ...identity, ...overrides.seriesIdentity }
  };
}

test('catalog selection abstains when otherwise exact candidates disagree on provider', () => {
  const candidates = [
    publication({ seriesIdentity: { sourceId: 'provider-a' } }),
    publication({ seriesIdentity: { sourceId: 'provider-b' } })
  ];
  assert.equal(selectPublicationForCatalogItem(candidates, item, 'USD'), null);
});

test('catalog selection abstains when otherwise exact candidates disagree on price semantics', () => {
  const candidates = [
    publication({ seriesIdentity: { priceSemantics: 'market' } }),
    publication({ seriesIdentity: { priceSemantics: 'completed-sale' } })
  ];
  assert.equal(selectPublicationForCatalogItem(candidates, item, 'USD'), null);
});

test('catalog selection abstains on a currency mismatch', () => {
  assert.equal(selectPublicationForCatalogItem(
    publication({ seriesIdentity: { currency: 'CAD' } }),
    item,
    'USD'
  ), null);
});

test('catalog and legacy-watch selection abstain without an explicit market condition', () => {
  const unconditioned = { ...item, marketCondition: '', condition: '' };
  const candidate = publication();
  assert.equal(selectPublicationForCatalogItem(candidate, unconditioned, 'USD'), null);
  assert.equal(selectPublicationForWatchlist(candidate, {
    catalogRef: unconditioned,
    marketCondition: ''
  }, 'USD'), null);
});

test('duplicate revisions of one exact series choose the newest deterministically', () => {
  const older = publication({ publicationId: 'older', publishedAt: '2026-08-01T00:00:00.000Z' });
  const newer = publication({ publicationId: 'newer', publishedAt: '2026-08-02T00:00:00.000Z' });
  assert.equal(selectExactPublication([older, newer], identity, {
    requireMarketCondition: true
  }), newer);
  assert.equal(selectExactPublication([newer, older], identity, {
    requireMarketCondition: true
  }), newer);
});
