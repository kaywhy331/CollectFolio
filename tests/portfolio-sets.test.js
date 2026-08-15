import test from 'node:test';
import assert from 'node:assert/strict';
import { filterAndSortPortfolioSets, groupPortfolioSets } from '../app/assets/js/core/portfolio-sets.js';

function holding(id, overrides = {}) {
  const { item: itemOverrides = {}, ...holdingOverrides } = overrides;
  return {
    id,
    item: {
      provider: 'pokemon', externalId: id, category: 'pokemon', game: 'Pokémon',
      name: `Card ${id}`, setName: 'Base Set', number: id, variant: 'holo',
      price: 10, currency: 'USD', priceSource: 'Approved test source',
      ...itemOverrides
    },
    quantity: 1,
    manualMarketPrice: '',
    updatedAt: '2026-08-10T00:00:00.000Z',
    ...holdingOverrides
  };
}

test('Portfolio sets separate games, deduplicate exact printings, and retain truthful value gaps', () => {
  const firstPrinting = holding('base-4', { quantity: 2, manualMarketPrice: 10 });
  const secondLot = holding('base-4-lot', {
    item: { externalId: 'base-4' }, quantity: 1, manualMarketPrice: 12
  });
  const unpriced = holding('base-5', { item: { price: null, priceSource: '' } });
  const euros = holding('base-6', { item: { currency: 'EUR' }, manualMarketPrice: 7, manualMarketCurrency: 'EUR' });
  const magic = holding('magic-1', {
    item: { provider: 'scryfall', category: 'magic', game: 'Magic: The Gathering', externalId: 'magic-1' }
  });
  const unassigned = holding('unknown', { item: { setName: '' }, quantity: 3 });
  const grouped = groupPortfolioSets([firstPrinting, secondLot, unpriced, euros, magic, unassigned], { currency: 'USD' });

  assert.equal(grouped.totalSets, 2);
  assert.equal(grouped.unassignedHoldings, 1);
  assert.equal(grouped.unassignedCopies, 3);
  const pokemon = grouped.sets.find((group) => group.game === 'Pokémon');
  assert.equal(pokemon.holdingCount, 4);
  assert.equal(pokemon.copyCount, 5);
  assert.equal(pokemon.uniquePrintingCount, 3);
  assert.equal(pokemon.marketValue, 32);
  assert.equal(pokemon.pricedHoldingCount, 2);
  assert.equal(pokemon.unpricedHoldingCount, 1);
  assert.equal(pokemon.excludedCurrencyCount, 1);
  assert.equal(Object.hasOwn(pokemon, 'completionPercent'), false);
  assert.equal(Object.hasOwn(pokemon, 'catalogCardCount'), false);
});

test('Portfolio set filters and explicit sorts only narrow or reorder complete local groups', () => {
  const groups = groupPortfolioSets([
    holding('z-1', { item: { setName: 'Zeta' }, updatedAt: '2026-08-11T00:00:00.000Z' }),
    holding('a-1', { item: { setName: 'Alpha' }, updatedAt: '2026-08-09T00:00:00.000Z' }),
    holding('a-2', { item: { setName: 'Alpha' }, updatedAt: '2026-08-10T00:00:00.000Z' }),
    holding('m-1', { item: { provider: 'scryfall', category: 'magic', game: 'Magic: The Gathering', setName: 'Middle', externalId: 'm-1' } })
  ]).sets;

  assert.deepEqual(filterAndSortPortfolioSets(groups, { sort: 'alpha' }).map((group) => group.setName), ['Alpha', 'Middle', 'Zeta']);
  assert.deepEqual(filterAndSortPortfolioSets(groups, { sort: 'printings-desc' }).map((group) => group.setName), ['Alpha', 'Middle', 'Zeta']);
  assert.deepEqual(filterAndSortPortfolioSets(groups, { query: 'mid', category: 'magic' }).map((group) => group.setName), ['Middle']);
  assert.equal(groups.length, 3);
});
