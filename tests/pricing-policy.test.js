import test from 'node:test';
import assert from 'node:assert/strict';
import {
  catalogPriceOptionsForDisplay,
  catalogPriceDisclosure,
  catalogPriceForValuation,
  currentPricingSnapshots,
  isRestrictedCatalogPrice,
  PRICING_POLICY_VERSION
} from '../app/assets/js/core/pricing-policy.js';

test('Pokémon and TCGplayer catalog prices fail closed until a licensed publication exists', () => {
  const pokemon = {
    provider: 'pokemon', price: 350.25,
    priceSource: 'Pokémon TCG API · TCGplayer market'
  };
  assert.equal(isRestrictedCatalogPrice(pokemon), true);
  assert.equal(catalogPriceForValuation(pokemon), null);
  assert.match(catalogPriceDisclosure(pokemon), /excluded pending licensed source rights/);

  assert.equal(isRestrictedCatalogPrice({ provider: 'legacy', price: 20, priceSource: 'TCGplayer market' }), true);
  assert.equal(isRestrictedCatalogPrice({
    provider: 'legacy', price: null,
    priceOptions: [{ finish: 'holofoil', price: 20, source: 'TCGplayer market' }]
  }), true);
  assert.deepEqual(catalogPriceOptionsForDisplay({
    provider: 'pokemon', price: 20,
    priceOptions: [{ finish: 'holofoil', price: 20 }]
  }), []);
  assert.equal(isRestrictedCatalogPrice({ provider: 'cardmarket', price: 20 }), true);
});

test('first-party custom values and unrelated reviewed catalog behavior remain distinct', () => {
  assert.equal(catalogPriceForValuation({ provider: 'custom', category: 'pokemon', price: 12.5 }), 12.5);
  assert.equal(catalogPriceForValuation({ provider: 'scryfall', price: '2.50' }), 2.5);
  assert.equal(catalogPriceForValuation({ provider: 'custom', price: null }), null);
  assert.equal(catalogPriceForValuation(null), null);
  assert.deepEqual(catalogPriceOptionsForDisplay(null), []);
  assert.equal(catalogPriceDisclosure({ provider: 'custom', price: 12.5 }), '');
  assert.deepEqual(catalogPriceOptionsForDisplay({
    provider: 'scryfall', priceOptions: [{ finish: 'foil', price: 3 }]
  }), [{ finish: 'foil', price: 3 }]);
});

test('TCGCSV values display under the free-access or legacy private-test entitlement', () => {
  const restricted = {
    provider: 'tcgcsv', price: 12,
    priceSource: 'TCGCSV authenticated private test · market'
  };
  assert.equal(isRestrictedCatalogPrice(restricted), true);
  const entitled = {
    ...restricted,
    pricingEntitlement: 'authenticated-private-test',
    priceOptions: [
      { finish: 'Normal', price: 12, source: restricted.priceSource },
      { finish: 'Foil', price: null, source: 'TCGCSV authenticated private test · price unavailable' }
    ]
  };
  assert.equal(isRestrictedCatalogPrice(entitled), false);
  assert.equal(catalogPriceForValuation(entitled), 12);
  assert.deepEqual(catalogPriceOptionsForDisplay(entitled), entitled.priceOptions);

  const freeAccess = {
    provider: 'tcgcsv', price: 8,
    pricingEntitlement: 'community-free-access',
    priceSource: 'TCGCSV community catalog · market'
  };
  assert.equal(isRestrictedCatalogPrice(freeAccess), false);
  assert.equal(catalogPriceForValuation(freeAccess), 8);
  assert.equal(isRestrictedCatalogPrice({ ...freeAccess, pricingEntitlement: 'commercial-tier' }), true);
});

test('only rights-aware portfolio snapshots remain eligible for trend display', () => {
  const legacy = { id: 'legacy', marketValue: 999 };
  const prior = {
    id: 'prior', marketValue: 10,
    pricingPolicyVersion: 'rights-aware-v1'
  };
  const current = {
    id: 'current', marketValue: 12,
    pricingPolicyVersion: PRICING_POLICY_VERSION
  };
  assert.deepEqual(currentPricingSnapshots([legacy, prior, current]), [prior, current]);
  assert.deepEqual(currentPricingSnapshots(null), []);
});

test('trend snapshots keep currencies separate and deduplicate legacy daily identities', () => {
  const legacyUsd = {
    id: 'portfolio:2026-08-11', date: '2026-08-11', currency: 'USD', marketValue: 10,
    pricingPolicyVersion: PRICING_POLICY_VERSION, updatedAt: '2026-08-11T10:00:00.000Z'
  };
  const currentUsd = {
    ...legacyUsd, id: 'portfolio:USD:2026-08-11', marketValue: 12,
    updatedAt: '2026-08-11T11:00:00.000Z'
  };
  const currentCad = {
    ...legacyUsd, id: 'portfolio:CAD:2026-08-11', currency: 'CAD', marketValue: 14,
    updatedAt: '2026-08-11T12:00:00.000Z'
  };
  assert.deepEqual(currentPricingSnapshots([legacyUsd, currentUsd, currentCad], 'USD'), [currentUsd]);
  assert.deepEqual(currentPricingSnapshots([legacyUsd, currentUsd, currentCad], 'CAD'), [currentCad]);
});
