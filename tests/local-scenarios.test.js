import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendOnlyLocalObservation,
  buildHoldingLocalScenario,
  buildLocalScenario,
  localObservationForHolding,
  localPortfolioInsights,
  localPortfolioScenario,
  normalizeLocalObservations
} from '../app/assets/js/core/local-scenarios.js';

const asOf = new Date('2026-08-12T12:00:00.000Z');
const holding = {
  id: 'holding-1', quantity: 2, purchasePrice: 60, fees: 4, purchaseCurrency: 'USD',
  manualMarketPrice: '', item: { name: 'Pikachu ex', category: 'pokemon', price: 100, currency: 'USD', priceSource: 'Catalog fixture', priceUpdatedAt: '2026-08-11' }
};

function record(day, price, source = 'catalog', id = `${source}-${day}`) {
  return { id, subjectId: holding.id, observedAt: `${day}T12:00:00.000Z`, unitPrice: price, currency: 'USD', source };
}

test('holding values become explicit same-day local observations without inventing history', () => {
  const catalog = localObservationForHolding(holding, '2026-08-12T12:00:00.000Z');
  assert.deepEqual({ source: catalog.source, unitPrice: catalog.unitPrice, sourceLabel: catalog.sourceLabel }, {
    source: 'catalog', unitPrice: 100, sourceLabel: 'Catalog fixture'
  });
  assert.equal(catalog.sourceUpdatedAt, '2026-08-11T00:00:00.000Z');
  const manual = localObservationForHolding({ ...holding, manualMarketPrice: 125, manualMarketCurrency: 'CAD' }, '2026-08-12T13:00:00.000Z');
  assert.equal(manual.source, 'manual');
  assert.equal(manual.currency, 'CAD');
  assert.equal(manual.sourceLabel, 'Your estimate');
  assert.equal(manual.sourceUpdatedAt, '');
});

test('same-day corrections append immutable revisions and supersede only the active source record', () => {
  const first = localObservationForHolding(holding, '2026-08-12T12:00:00.000Z');
  const corrected = localObservationForHolding({ ...holding, item: { ...holding.item, price: 105 } }, '2026-08-12T13:00:00.000Z');
  const revision = appendOnlyLocalObservation([first], corrected, 'revision-1');
  assert.equal(revision.id, 'revision-1');
  assert.equal(revision.supersedes, first.id);
  assert.equal(first.supersedes, '');
  const afterRevision = new Date('2026-08-12T14:00:00.000Z');
  assert.equal(normalizeLocalObservations([first, revision], { asOf: afterRevision })[0].unitPrice, 105);
  assert.equal(appendOnlyLocalObservation([first, revision], { ...corrected, observedAt: '2026-08-12T14:00:00.000Z' }, 'duplicate'), null);
});

test('normalization is deterministic, filters future records, resolves supersession, and deduplicates a UTC day', () => {
  const records = [
    record('2026-08-10', 90, 'catalog', 'old'),
    { ...record('2026-08-10', 95, 'catalog', 'replacement'), supersedes: 'old', createdAt: '2026-08-10T13:00:00.000Z' },
    { ...record('2026-08-10', 97, 'catalog', 'latest'), createdAt: '2026-08-10T14:00:00.000Z' },
    record('2026-08-13', 500, 'catalog', 'future'),
    { ...record('2026-08-11', 0), id: 'invalid' }
  ];
  const first = normalizeLocalObservations(records, { asOf });
  const second = normalizeLocalObservations([...records].reverse(), { asOf });
  assert.deepEqual(first, second);
  assert.equal(first.length, 1);
  assert.equal(first[0].unitPrice, 97);
});

test('one local value yields a broad scenario immediately without claiming a price trend', () => {
  const scenario = buildLocalScenario([record('2026-08-12', 100)], 90, { asOf });
  assert.equal(scenario.kind, 'local-scenario');
  assert.equal(scenario.status, 'early');
  assert.equal(scenario.observationCount, 1);
  assert.equal(scenario.q50, 100);
  assert.equal(scenario.valueAsOf, '2026-08-12T12:00:00.000Z');
  assert.ok(scenario.q10 < scenario.q25 && scenario.q25 < scenario.q50);
  assert.ok(scenario.q50 < scenario.q75 && scenario.q75 < scenario.q90);
  assert.match(scenario.reason, /broad volatility prior/i);
});

test('a valued holding gets an immediate one-anchor scenario before persistence catches up', () => {
  const scenario = buildHoldingLocalScenario(holding, [], 30, { asOf });
  assert.equal(scenario.status, 'early');
  assert.equal(scenario.observed, 100);
  assert.equal(scenario.sourceLabel, 'Catalog fixture');
  assert.equal(scenario.valueAsOf, '2026-08-11T00:00:00.000Z');
});

test('irregular gaps use sqrt-time volatility scaling and span-shrunk drift', () => {
  const records = [record('2026-05-14', 80), record('2026-06-13', 90), record('2026-07-13', 95), record('2026-08-12', 100)];
  const scenario = buildLocalScenario(records, 365, { asOf });
  assert.equal(scenario.status, 'limited');
  assert.ok(scenario.dailyVolatility >= 0.015 && scenario.dailyVolatility <= 0.06);
  assert.ok(Math.abs(scenario.dailyDrift) < Math.log(100 / 80) / 90);
  assert.ok(scenario.q90 / scenario.q10 <= 6 + 1e-12);
});

test('manual and catalog transitions never create a return and large jumps are quarantined from model inputs', () => {
  const mixed = buildLocalScenario([
    record('2026-08-01', 100, 'catalog'), record('2026-08-02', 200, 'manual'),
    record('2026-08-03', 1000, 'manual'), record('2026-08-04', 105, 'catalog')
  ], 30, { asOf });
  assert.equal(mixed.observationCount, 2, 'only the latest catalog series informs this catalog-anchored scenario');
  assert.ok(Math.abs(mixed.dailyDrift) < Math.log(105 / 100), 'the valid catalog change is heavily span-shrunk');
  assert.equal(mixed.excludedChangeCount, 0, 'manual jumps never enter the catalog return series');
  assert.ok(Number.isFinite(mixed.q10) && Number.isFinite(mixed.q90));
});

test('stale values refuse a point scenario instead of projecting from an obsolete anchor', () => {
  const scenario = buildLocalScenario([record('2025-01-01', 100)], 90, { asOf });
  assert.equal(scenario.status, 'stale');
  assert.equal(scenario.q50, undefined);
  assert.match(scenario.nextAction, /update/i);
});

test('catalog source freshness remains distinct from the device capture time', () => {
  const capturedNow = {
    ...record('2026-08-12', 100),
    sourceUpdatedAt: '2025-01-01T00:00:00.000Z'
  };
  const scenario = buildLocalScenario([capturedNow], 90, { asOf });
  assert.equal(scenario.observedAt, '2026-08-12T12:00:00.000Z');
  assert.equal(scenario.valueAsOf, '2025-01-01T00:00:00.000Z');
  assert.equal(scenario.status, 'stale');
});

test('future observations cannot leak into an earlier as-of scenario', () => {
  const records = [record('2026-08-01', 100), record('2026-08-10', 120)];
  const historical = buildLocalScenario(records, 30, { asOf: new Date('2026-08-05T12:00:00.000Z') });
  assert.equal(historical.observationCount, 1);
  assert.equal(historical.observed, 100);
});

test('portfolio scenario aggregates only usable same-currency holding ranges', () => {
  const second = { ...holding, id: 'holding-2', quantity: 1, item: { ...holding.item, name: 'Second card', price: 50 } };
  const observations = [record('2026-08-12', 100), { ...record('2026-08-12', 50), id: 'second', subjectId: second.id }];
  const summary = localPortfolioScenario([holding, second], observations, 90, { asOf });
  assert.equal(summary.coveredHoldings, 2);
  assert.equal(summary.currentValue, 250);
  assert.ok(summary.q10 < summary.q50 && summary.q50 < summary.q90);
  assert.equal(buildHoldingLocalScenario(holding, observations, 90, { asOf }).observed, 100);

  const cad = { ...second, id: 'holding-cad', manualMarketPrice: 75, manualMarketCurrency: 'CAD' };
  const mixed = localPortfolioScenario([holding, cad], observations, 90, { asOf, currency: 'USD' });
  assert.equal(mixed.coveredHoldings, 1);
  assert.equal(mixed.excludedCurrencyHoldings, 1);
  assert.equal(mixed.currency, 'USD');
});

test('portfolio insights expose concentration and cost-basis facts without a forecast source', () => {
  const result = localPortfolioInsights([
    holding,
    { ...holding, id: 'small', quantity: 1, purchasePrice: 10, fees: 0, item: { ...holding.item, name: 'Small card', price: 10 } }
  ]);
  assert.equal(result.totalValue, 210);
  assert.equal(result.totalCost, 134);
  assert.equal(result.topHolding.name, 'Pikachu ex');
  assert.equal(result.concentration, 'high');
  assert.ok(result.topFiveShare <= 1);
});

test('malformed and adversarial inputs never emit NaN or inverted quantiles', () => {
  const values = [NaN, Infinity, -5, 0, '', null, undefined, 1e300];
  for (const value of values) {
    const scenario = buildLocalScenario([{ id: 'x', subjectId: 'h', observedAt: '2026-08-12T00:00:00Z', unitPrice: value, source: 'manual' }], 365, { asOf });
    if (scenario.status === 'unavailable') continue;
    for (const key of ['q10', 'q25', 'q50', 'q75', 'q90']) assert.ok(Number.isFinite(scenario[key]));
    assert.ok(scenario.q10 <= scenario.q25 && scenario.q25 <= scenario.q50 && scenario.q50 <= scenario.q75 && scenario.q75 <= scenario.q90);
  }
});
