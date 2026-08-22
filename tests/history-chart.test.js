import test from 'node:test';
import assert from 'node:assert/strict';
import {
  downsampleHistoryPoints,
  filterHistoryPointsByRange,
  HISTORY_CHART_RANGES,
  historyLineChart,
  interpolateDailyPath,
  normalizeHistoryPoints,
  selectForecastMedianPath,
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

test('history ranges are explicit and filter relative to the latest observation', () => {
  assert.deepEqual(HISTORY_CHART_RANGES, ['1M', '3M', '6M', '1Y', 'All']);
  const points = [
    ['2025-07-01', 10],
    ['2026-01-01', 20],
    ['2026-05-01', 30],
    ['2026-07-15', 40],
    ['2026-08-01', 50],
    ['2026-08-20', 60]
  ];
  assert.deepEqual(filterHistoryPointsByRange(points, '1M').map((point) => point.date), ['2026-08-01', '2026-08-20']);
  assert.deepEqual(filterHistoryPointsByRange(points, '3M').map((point) => point.date), ['2026-07-15', '2026-08-01', '2026-08-20']);
  assert.equal(filterHistoryPointsByRange(points, '6M').length, 4);
  assert.equal(filterHistoryPointsByRange(points, '1Y').length, 5);
  assert.equal(filterHistoryPointsByRange(points, 'All').length, 6);
  assert.equal(filterHistoryPointsByRange(points, 'invalid').length, 6);
});

test('selectServedForecastBars only returns horizons the packet actually carries, never fabricated', () => {
  const packet = {
    confidence: 'standard',
    lastKnownDate: '2026-01-10',
    lastKnownPrice: 19,
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
  assert.match(html, /data-price-role="observed"[^>]*>\$15\.00<\/text>/);
  assert.doesNotMatch(html, /history-forecast-line/);
  assert.doesNotMatch(html, /est\.<\/text>/);
});

test('historyLineChart appends projection marks with whiskers only for served horizons', () => {
  const packet = {
    confidence: 'standard',
    lastKnownDate: '2026-01-10',
    lastKnownPrice: 19,
    horizons: {
      30: { q10: 90, q50: 100, q90: 110, evidenceTier: 'category-validated' },
      60: { q10: 85, q50: 110, q90: 140, evidenceTier: 'category-validated' },
      90: { q10: 80, q50: 120, q90: 160, evidenceTier: 'category-validated' }
    }
  };
  const html = historyLineChart(weeklyPoints(10), packet, 'USD');
  assert.match(html, /history-forecast-line/);
  assert.match(html, /history-forecast-point/);
  assert.match(html, /history-bar-whisker/);
  assert.match(html, /\+30d est\./);
  assert.match(html, /\+60d est\./);
  assert.match(html, /\+90d est\./);
  assert.match(html, /forecast-present/);
  assert.doesNotMatch(html, /class="history-forecast-band"/);
  assert.match(html, /Independent q10–q90 checkpoints/);
  assert.match(html, /data-price-role="observed"[^>]*>\$19\.00<\/text>/);
  assert.equal((html.match(/data-price-role="midpoint"/g) || []).length, 3);
  assert.equal((html.match(/data-price-role="high"/g) || []).length, 3);
  assert.equal((html.match(/data-price-role="low"/g) || []).length, 3);
  assert.match(html, /data-price-role="midpoint" data-forecast-horizon="30"[^>]*>\$100\.00<\/text>/);
  assert.match(html, /data-price-role="high" data-forecast-horizon="60"[^>]*>\$140\.00<\/text>/);
  assert.match(html, /data-price-role="low" data-forecast-horizon="90"[^>]*>\$80\.00<\/text>/);
  assert.match(html, /30-day estimated price \$100\.00, low \$90\.00, high \$110\.00/);
});

test('historyLineChart labels range-only values without implying a directional point', () => {
  const packet = {
    confidence: 'standard',
    lastKnownDate: '2026-01-06',
    lastKnownPrice: 15,
    horizons: {
      30: { q10: 12, q50: 15, q90: 19, evidenceTier: 'range-only' }
    }
  };
  const html = historyLineChart(weeklyPoints(6), packet, 'USD');
  assert.match(html, /history-bar-whisker/);
  assert.match(html, /data-price-role="midpoint" data-forecast-horizon="30"[^>]*>\$15\.00<\/text>/);
  assert.match(html, /30-day range midpoint \$15\.00, low \$12\.00, high \$19\.00/);
  assert.match(html, /30-day range midpoint \$15\.00; no directional forecast/);
  assert.doesNotMatch(html, /history-forecast-estimate-label/);
  assert.doesNotMatch(html, /history-forecast-point/);
  assert.doesNotMatch(html, /history-forecast-line/);
});

test('historyLineChart can hide the forecast without removing its observed history', () => {
  const packet = {
    confidence: 'standard',
    horizons: {
      30: { q10: 90, q50: 100, q90: 110 },
      90: { q10: 80, q50: 120, q90: 160 }
    }
  };
  const html = historyLineChart(weeklyPoints(10), packet, 'USD', { showForecast: false });
  assert.match(html, /class="chart-line chart-market history-line"/);
  assert.match(html, /data-forecast-visible="false"/);
  assert.doesNotMatch(html, /history-forecast-line/);
  assert.doesNotMatch(html, /history-forecast-band/);
  assert.doesNotMatch(html, /history-bar-whisker/);
  assert.doesNotMatch(html, /Latest forecast/);
});

test('historyLineChart applies the selected history range before plotting', () => {
  const points = [
    ['2025-08-01', 10],
    ['2026-01-01', 20],
    ['2026-07-01', 30],
    ['2026-08-01', 40],
    ['2026-08-20', 50]
  ];
  const html = historyLineChart(points, null, 'USD', { range: '1M' });
  const coords = /polyline points="([^"]+)"/.exec(html)[1].split(' ');
  assert.equal(coords.length, 2);
  assert.match(html, /data-history-range="1M"/);
});

test('historyLineChart does not attach an unanchored cold-start reference to observed history', () => {
  const packet = { confidence: 'cold-start', horizons: { 30: { q10: 5, q50: 10, q90: 20 } } };
  const html = historyLineChart(weeklyPoints(5), packet, 'USD');
  assert.match(html, /trajectory-cold-start/);
  assert.match(html, /data-forecast-visible="false"/);
  assert.doesNotMatch(html, /history-bar-whisker/);
  assert.doesNotMatch(html, /history-forecast-line/);
  assert.doesNotMatch(html, /history-forecast-point/);
});

test('historyLineChart suppresses a forecast whose anchor predates newer history', () => {
  const points = [['2026-08-01', 10], ['2026-08-08', 11]];
  const packet = {
    confidence: 'standard',
    lastKnownDate: '2026-08-01',
    lastKnownPrice: 10,
    horizons: {
      30: { q10: 8, q50: 12, q90: 16, evidenceTier: 'category-validated' }
    }
  };
  const html = historyLineChart(points, packet, 'USD');
  assert.match(html, /data-forecast-visible="false"/);
  assert.doesNotMatch(html, /history-bar-whisker/);
  assert.doesNotMatch(html, /history-forecast-line/);
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

test('selectForecastMedianPath cleans, sorts, and timestamps the published path', () => {
  const path = selectForecastMedianPath({ medianPath: [
    { date: '2026-08-15', price: 12 },
    { date: '2026-08-08', price: 10 },
    { date: 'nope', price: 11 },
    { date: '2026-08-22', price: -1 }
  ] });
  assert.deepEqual(path.map((point) => point.date), ['2026-08-08', '2026-08-15']);
  assert.ok(path.every((point) => Number.isFinite(point.time)));
  assert.deepEqual(selectForecastMedianPath(null), []);
});

test('interpolateDailyPath fills every calendar day between weekly checkpoints', () => {
  const DAY = 86_400_000;
  const start = Date.parse('2026-08-08T00:00:00.000Z');
  const daily = interpolateDailyPath([
    { time: start, price: 100 },
    { time: start + (7 * DAY), price: 107 }
  ]);
  assert.equal(daily.length, 8); // 7 days inclusive of both endpoints
  assert.equal(daily[3].price, 103); // straight-line resampling, no invented levels
});

test('historyLineChart connects only independently validated checkpoints', () => {
  const packet = {
    confidence: 'standard',
    lastKnownDate: '2026-02-24',
    lastKnownPrice: 19,
    medianPath: [
      { date: '2026-02-24', price: 19 },
      { date: '2026-03-03', price: 21 },
      { date: '2026-03-26', price: 24 }
    ],
    horizons: { 30: { q10: 18, q50: 22, q90: 26, horizonDaysActual: 28, evidenceTier: 'category-validated' } }
  };
  const html = historyLineChart(weeklyPoints(8), packet, 'USD');
  assert.match(html, /polyline points="[^"]+" class="history-forecast-line/);
  assert.match(html, /history-forecast-up/); // 24 >= last observed -> green trend
  assert.match(html, /history-bar-whisker/);
  assert.match(html, /\+30d est\./);
});

test('historyLineChart marks a declining projection as a downward trend', () => {
  const packet = {
    confidence: 'standard',
    lastKnownDate: '2026-02-24',
    lastKnownPrice: 17,
    medianPath: [{ date: '2026-03-26', price: 5 }],
    horizons: { 30: { q10: 3, q50: 5, q90: 8, evidenceTier: 'category-validated' } }
  };
  const html = historyLineChart(weeklyPoints(8), packet, 'USD'); // last observed 17
  assert.match(html, /history-forecast-down/);
  assert.doesNotMatch(html, /history-forecast-up/);
});

test('historyLineChart x-axis is proportional to calendar days across history and forecast', () => {
  // Two observed points 7 days apart, then the 30d model's actual 28-day
  // weekly target: the axis spans 35 days, so the divider sits at 7/35.
  const points = [['2026-02-17', 10], ['2026-02-24', 12]];
  const packet = { confidence: 'standard', lastKnownDate: '2026-02-24', lastKnownPrice: 12, horizons: { 30: { q10: 9, q50: 12, q90: 15 } } };
  const html = historyLineChart(points, packet, 'USD');
  const divider = /class="forecast-present"/.exec(html) && /x1="([\d.]+)" y1="18" x2="[\d.]+" y2="\d+" class="forecast-present"/.exec(html);
  assert.ok(divider, 'today divider rendered');
  const left = 76;
  const right = 742;
  const expected = left + ((7 / 35) * (right - left));
  assert.ok(Math.abs(Number(divider[1]) - expected) < 1.5, `divider at ${divider[1]}, expected ~${expected.toFixed(1)}`);
});

test('historyLineChart hover payload contains history plus modeled checkpoints, never interpolated days', () => {
  const packet = {
    confidence: 'standard',
    lastKnownDate: '2026-02-24',
    lastKnownPrice: 19,
    medianPath: [{ date: '2026-03-03', price: 20 }],
    horizons: {
      30: { q10: 15, q50: 20, q90: 25, evidenceTier: 'category-validated' },
      60: { q10: 14, q50: 22, q90: 29, evidenceTier: 'category-validated' },
      90: { q10: 13, q50: 24, q90: 34, evidenceTier: 'category-validated' }
    }
  };
  const html = historyLineChart(weeklyPoints(4), packet, 'USD');
  const attr = /data-chart-points="([^"]+)"/.exec(html);
  assert.ok(attr, 'hover payload attribute present');
  const points = JSON.parse(attr[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
  // Four observations plus exactly three independent forecast checkpoints.
  assert.equal(points.length, 7);
  assert.ok(points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y) && point.l.includes('$')));
  assert.equal(points.filter((point) => point.l.includes('(estimated)')).length, 3);
  assert.ok(points.some((point) => point.l.startsWith('Jan 1')));
});

test('historyLineChart hover payload omits projection entries when no forecast is served', () => {
  const html = historyLineChart(weeklyPoints(3), null, 'USD');
  const attr = /data-chart-points="([^"]+)"/.exec(html);
  const points = JSON.parse(attr[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
  assert.equal(points.length, 3);
  assert.ok(points.every((point) => !point.l.includes('(projected)')));
});
