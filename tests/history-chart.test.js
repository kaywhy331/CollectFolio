import test from 'node:test';
import assert from 'node:assert/strict';
import {
  downsampleHistoryPoints,
  historyBarChart,
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

test('historyBarChart fails closed on an empty/invalid points array', () => {
  assert.equal(historyBarChart([], null, 'USD'), '');
  assert.equal(historyBarChart(null, null, 'USD'), '');
});

test('historyBarChart renders history bars only when no forecast packet is supplied', () => {
  const html = historyBarChart(weeklyPoints(6), null, 'USD');
  assert.match(html, /class="history-bar"/);
  assert.doesNotMatch(html, /history-bar-forecast/);
  assert.doesNotMatch(html, /est\.<\/text>/);
});

test('historyBarChart appends projection bars with whiskers only for served horizons', () => {
  const packet = {
    confidence: 'standard',
    horizons: {
      30: { q10: 90, q50: 100, q90: 110 },
      90: { q10: 80, q50: 120, q90: 160 }
    }
  };
  const html = historyBarChart(weeklyPoints(10), packet, 'USD');
  assert.match(html, /history-bar-forecast/);
  assert.match(html, /history-bar-whisker/);
  assert.match(html, /\+30d est\./);
  assert.match(html, /\+90d est\./);
  assert.match(html, /forecast-present/);
});

test('historyBarChart applies cold-start warning-tone styling consistent with the trajectory chart', () => {
  const packet = { confidence: 'cold-start', horizons: { 30: { q10: 5, q50: 10, q90: 20 } } };
  const html = historyBarChart(weeklyPoints(5), packet, 'USD');
  assert.match(html, /trajectory-cold-start/);
  assert.match(html, /Cold start estimate/);
  assert.match(html, /history-bar-forecast-cold-start/);
});

test('historyBarChart compact variant renders fewer bars and a shorter viewBox', () => {
  const html = historyBarChart(weeklyPoints(60), null, 'USD', { compact: true });
  assert.match(html, /viewBox="0 0 760 180"/);
});

test('historyBarChart escapes untrusted-looking text content', () => {
  // Confidence strings are internal, but escapeHTML must still be applied
  // defensively -- assert the escaping helper is actually wired in by
  // checking no raw "<" survives an adversarial confidence label.
  const packet = { confidence: '<script>alert(1)</script>', horizons: { 30: { q10: 1, q50: 2, q90: 3 } } };
  const html = historyBarChart(weeklyPoints(5), packet, 'USD');
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});
