import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCollectionScenario, sortScenarioRows } from '../app/assets/js/core/scenario-lab.js';

const holdings = [
  {
    id: 'market', quantity: 2, manualMarketPrice: '',
    item: { provider: 'scryfall', category: 'magic', name: 'Market Card', price: 50, currency: 'USD', priceSource: 'Licensed catalog' }
  },
  {
    id: 'manual', quantity: 1, manualMarketPrice: 40, manualMarketCurrency: 'USD',
    item: { provider: 'custom', category: 'sports', name: 'Manual Card', currency: 'USD' }
  },
  {
    id: 'restricted', quantity: 1, manualMarketPrice: '',
    item: { provider: 'pokemon', category: 'pokemon', name: 'Restricted Card', price: 999, currency: 'USD', priceSource: 'Pokémon TCG API' }
  }
];

test('neutral Scenario Lab output is unchanged and excludes unsupported prices', () => {
  const result = buildCollectionScenario(holdings, [], 90, { currency: 'USD', now: '2026-08-20T00:00:00.000Z' });
  assert.equal(result.currentValue, 140);
  assert.equal(result.median, 140);
  assert.equal(result.differenceLabel, 'Unchanged scenario');
  assert.equal(result.coveredHoldings, 2);
  assert.equal(result.totalHoldings, 3);
  assert.equal(result.rows.some((row) => row.holding.id === 'restricted'), false);
});

test('explicit market, category, item, volatility, and manual assumptions change only scenario output', () => {
  const result = buildCollectionScenario(holdings, [], 180, {
    currency: 'USD', now: '2026-08-20T00:00:00.000Z',
    assumptions: {
      marketDirection: 'up', category: 'magic', categoryDirection: 'up',
      itemId: 'market', itemDirection: 'up', volatility: 'high', manualValues: 'steady'
    }
  });
  const market = result.rows.find((row) => row.holding.id === 'market');
  const manual = result.rows.find((row) => row.holding.id === 'manual');
  assert.ok(market.median > market.currentValue);
  assert.equal(manual.median, manual.currentValue);
  assert.ok(market.q90 - market.q10 > 0);
  assert.equal(holdings[0].item.price, 50);
});

test('Scenario Lab evidence uses plain-language levels and item rows support every required sort', () => {
  const observations = [
    { id: 'a', subjectId: 'market', observedAt: '2026-08-01T00:00:00.000Z', unitPrice: 45, currency: 'USD', source: 'catalog', sourceLabel: 'Source A' },
    { id: 'b', subjectId: 'market', observedAt: '2026-08-08T00:00:00.000Z', unitPrice: 48, currency: 'USD', source: 'catalog', sourceLabel: 'Source B' },
    { id: 'c', subjectId: 'market', observedAt: '2026-08-15T00:00:00.000Z', unitPrice: 50, currency: 'USD', source: 'catalog', sourceLabel: 'Source B' }
  ];
  const result = buildCollectionScenario(holdings, observations, 90, { currency: 'USD', now: '2026-08-20T00:00:00.000Z' });
  assert.match(result.rows[0].evidence.level, /Limited|Moderate|Strong evidence/);
  assert.match(result.rows[0].evidence.detail, /Based on 3 observations from/);
  for (const sort of ['upside', 'downside', 'uncertainty', 'evidence', 'value']) {
    assert.equal(sortScenarioRows(result.rows, sort).length, result.rows.length);
  }
});
