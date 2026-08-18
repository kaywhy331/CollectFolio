import test from 'node:test';
import assert from 'node:assert/strict';
import {
  downsampleHistoryPoints,
  historyLineChart,
  normalizeHistoryPoints,
  selectServedForecastBars
} from '../app/assets/js/core/history-chart.js';

function weeklyPoints(count, startPrice = 10) {
  const points = [];
  for (let week = 0; week < count; week += 1) {
    const day = String(1 + (week % 28)).padStart(2, '0');
    const month = String(1 + Math.floor(week / 28)).padStart(2, '0');
    points.push([`2026-${month}-${day}`, startPrice + week]);
  }
  return points;
}

test('normalizeHistoryPoints sorts, drops malformed pairs, keeps valid ones', () => {
  const clean = normalizeHistoryPoints([
    ['2026-06-13', 101],
    ['2026-06-06', 100],
    ['not-a-date', 50],
    ['2026-06-20', -5],
    ['2026-06-27', null]
  ]);
  assert.deepEqual(clean, [
    { date: '2026-06-06', price: 100 },
    { date: '2026-06-13', price: 101 }
  ]);
});

test('downsampleHistoryPoints passes through when already under the target bar count', () => {
  const points = weeklyPoints(10);
  const bars = downsampleHistoryPoints(points, 32);
  assert.equal(bars.length, 10);
  assert.equal(bars[0].price, 10);
});

test('downsampleHistoryPoints buckets down to at most targetBars, never drops a data point silently', () => {
  const points = weeklyPoints(80);
  const bars = downsampleHistoryPoints(points, 32);
  assert.ok(bars.length <= 32);
  assert.ok(bars.length > 0);
  // Last bucket's date is the most recent observed date.
  assert.equal(bars.at(-1).date, points.at(-1)[0]);
});

test('selectServedForecastBars only returns horizons the packet actually carries, never fabricated', () => {
  const packet = {
    confidence: 'standard',
    horizons: {
      30: { q10: 90, q50: 100, q90: 110 }
      // 90d intentionally absent.
    }
  };
  const bars = selectServedForecastBars(packet);
  assert.equal(bars.length, 1);
  assert.equal(bars[0].horizon, 30);
});

test('selectServedForecastBars rejects an unordered or incomplete band', () => {
  assert.deepEqual(selectServedForecastBars({ horizons: { 30: { q10: 10, q50: 5, q90: 1 } } }), []);
  assert.deepEqual(selectServedForecastBars({ horizons: { 30: { q10: 1, q50: 5 } } }), []);
  assert.deepEqual(selectServedForecastBars(null), []);
});

test('historyLineChart fails closed on an empty/invalid points array', () => {
  assert.equal(historyLineChart([], null, 'USD'), '');
  assert.equal(historyLineChart(null, null, 'USD'), '');
});

test('historyLineChart renders a history line only when no forecast packet is supplied', () => {
  const html = historyLineChart(weeklyPoints(6), null, 'USD');
  assert.match(html, /class="chart-line chart-market history-line"/);
  assert.doesNotMatch(html, /history-forecast-line/);
  assert.doesNotMatch(html, /est\.<\/text>/);
});

test('historyLineChart appends projection marks with whiskers only for served horizons', () => {
  const packet = {
    confidence: 'standard',
    horizons: {
      30: { q10: 90, q50: 100, q90: 110 },
      90: { q10: 80, q50: 120, q90: 160 }
    }
  };
  const html = historyLineChart(weeklyPoints(10), packet, 'USD');
  assert.match(html, /history-forecast-line/);
  assert.match(html, /history-forecast-point/);
  assert.match(html, /history-bar-whisker/);
  assert.match(html, /\+30d est\./);
  assert.match(html, /\+90d est\./);
  assert.match(html, /forecast-present/);
});

test('historyLineChart applies cold-start warning-tone styling consistent with the trajectory chart', () => {
  const packet = { confidence: 'cold-start', horizons: { 30: { q10: 5, q50: 10, q90: 20 } } };
  const html = historyLineChart(weeklyPoints(5), packet, 'USD');
  assert.match(html, /trajectory-cold-start/);
  assert.match(html, /Cold start estimate/);
  assert.match(html, /history-forecast-line-cold-start/);
  assert.match(html, /history-forecast-point-cold-start/);
});

test('historyLineChart compact variant renders fewer bars and a shorter viewBox', () => {
  const html = historyLineChart(weeklyPoints(60), null, 'USD', { compact: true });
  assert.match(html, /viewBox="0 0 760 180"/);
});

test('historyLineChart escapes untrusted-looking text content', () => {
  // The line chart never echoes the packet's confidence string at all --
  // only fixed badge labels for recognized tiers -- so an adversarial
  // confidence value must simply not appear in the markup.
  const packet = { confidence: '<script>alert(1)</script>', horizons: { 30: { q10: 1, q50: 2, q90: 3 } } };
  const html = historyLineChart(weeklyPoints(5), packet, 'USD');
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /alert\(1\)/);
});

test('historyLineChart zooms the y-domain to the observed range instead of anchoring at zero', () => {
  // A $50 card moving by a couple of dollars: with a zero-anchored axis the
  // line is flat; the zoomed domain must place min near the bottom and max
  // near the top, and tick labels must span [~min..~max], not [$0..].
  const points = [['2026-06-06', 49], ['2026-06-13', 50], ['2026-06-20', 51], ['2026-06-27', 50.5]];
  const html = historyLineChart(points, null, 'USD');
  assert.doesNotMatch(html, /\$0(?:\.00)?</);
  const ys = [...html.matchAll(/history-point" \/>/g)];
  assert.equal(ys.length, 4);
  // min and max tick labels reflect the padded observed range (2-decimal
  // formatting because the range is narrow).
  assert.match(html, /48\.\d{2}/);
  assert.match(html, /51\.\d{2}/);
});

test('historyLineChart plots every published point instead of downsampling to 32 bars', () => {
  const html = historyLineChart(weeklyPoints(80), null, 'USD');
  const coords = /polyline points="([^"]+)"/.exec(html)[1].split(' ');
  assert.equal(coords.length, 80);
});
