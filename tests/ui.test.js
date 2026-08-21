import test from 'node:test';
import assert from 'node:assert/strict';
import { forecastProjectionChart, trendChart } from '../app/assets/js/core/ui.js';

test('collection chart renders a fitted currency scale, dates, series, and exact latest values', () => {
  const html = trendChart([
    { date: '2026-07-01', marketValue: 1000, costBasis: 800 },
    { date: '2026-07-15', marketValue: 1200, costBasis: 900 },
    { date: '2026-07-31', marketValue: 1500, costBasis: 1000 }
  ], 'USD');
  assert.match(html, /chart-axis-label/);
  assert.match(html, /Jul 1/);
  assert.match(html, /Jul 31/);
  assert.match(html, /Market value/);
  assert.match(html, /Latest market/);
  assert.match(html, /\$1,500\.00/);
  assert.match(html, /\$1,000\.00/);
  assert.match(html, /data-chart-points=/);
});

test('collection chart requires two distinct valid observations', () => {
  const html = trendChart([{ date: '2026-07-01', marketValue: 1000, costBasis: null }], 'USD');
  assert.match(html, /Collection history starts here/);
  assert.doesNotMatch(html, /<svg/);
  assert.doesNotMatch(html, /chart-axis-label/);
});

test('forecast chart relates an approved observation to ordered horizon bands', () => {
  const html = forecastProjectionChart(100, [
    { horizon: 30, q10: 80, q25: 90, q50: 105, q75: 120, q90: 140 },
    { horizon: 90, q10: 70, q25: 92, q50: 115, q75: 135, q90: 160 }
  ], 'USD');
  assert.match(html, /Approved forecast projection/);
  assert.match(html, /Today/);
  assert.match(html, /30D/);
  assert.match(html, /90D/);
  assert.match(html, /forecast-band-80/);
  assert.match(html, /90D modeled median/);
  assert.match(html, /\+15\.0%/);
  assert.match(html, /data-chart-points=/);
});

test('forecast chart fails closed without an observation or with unordered ranges', () => {
  assert.equal(forecastProjectionChart(null, [{ horizon: 30, q10: 1, q25: 2, q50: 3, q75: 4, q90: 5 }]), '');
  assert.equal(forecastProjectionChart(10, [{ horizon: 30, q10: 5, q25: 4, q50: 3, q75: 2, q90: 1 }]), '');
});

test('forecast chart has an honestly labeled local-scenario mode', () => {
  const html = forecastProjectionChart(100, [
    { horizon: 30, q10: 70, q25: 85, q50: 100, q75: 118, q90: 142 }
  ], 'USD', {
    mode: 'local-scenario',
    history: [{ price: 95, observedAt: '2026-07-01T00:00:00.000Z' }],
    asOfDate: '2026-08-01T00:00:00.000Z'
  });
  assert.match(html, /Your scenario projection/);
  assert.match(html, /Saved value now/);
  assert.match(html, /30D modeled scenario median/);
  assert.match(html, /Local value checks/);
  assert.doesNotMatch(html, /Approved forecast projection/);
});

test('neutral local scenarios use words instead of a misleading positive zero return', () => {
  const html = forecastProjectionChart(100, [
    { horizon: 30, q10: 90, q25: 95, q50: 100, q75: 105, q90: 110 }
  ], 'USD', { mode: 'local-scenario' });
  assert.match(html, /Unchanged scenario/);
  assert.doesNotMatch(html, /\+0\.0%/);
});
