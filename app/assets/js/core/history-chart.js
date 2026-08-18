// 0.8.17: dependency-free inline-SVG BAR chart for TCGCSV weekly price
// history plus (when published) trajectory-v1 forecast projection bars.
//
// Kept as a sibling module to core/ui.js rather than folded in directly
// so the pure, non-DOM pieces -- downsampling and served-horizon
// selection -- can be unit tested in isolation from SVG string assembly.
//
// Fail-closed conventions mirrored from ui.js's trajectoryProjectionChart:
// - No history points at all -> caller shouldn't call this (services
//   layer already fails closed), but historyBarChart also returns '' as
//   a defensive fallback.
// - Forecast projection bars are ONLY ever drawn for horizons the
//   published packet actually carries (30d and/or 90d) -- never
//   fabricated, never interpolated to another horizon.
import { escapeHTML, formatCurrency } from './utils.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function finiteNonNegative(value) {
  if (value === '' || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function niceCeiling(value) {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

function compactCurrency(value, currency) {
  return new Intl.NumberFormat(undefined, {
    style: 'currency', currency, notation: 'compact', maximumFractionDigits: 1
  }).format(value);
}

function shortDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!match) return '';
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) return '';
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
}

// Cleans + sorts raw [date, price] pairs into {date, price} objects,
// dropping anything malformed rather than fabricating a value.
export function normalizeHistoryPoints(points) {
  return (Array.isArray(points) ? points : [])
    .map((pair) => ({ date: String(pair?.[0] || ''), price: finiteNonNegative(pair?.[1]) }))
    .filter((point) => point.price !== null && shortDate(point.date))
    .sort((left, right) => left.date.localeCompare(right.date));
}

// Downsamples a (already date-sorted) points array to at most
// `targetBars` bars by averaging contiguous buckets -- keeps the chart
// legible at a fixed pixel width regardless of how many weekly points
// the published history object carries (up to 80 per variant). A
// point count already <= targetBars passes through unchanged.
export function downsampleHistoryPoints(points, targetBars = 32) {
  const clean = normalizeHistoryPoints(points);
  if (clean.length <= targetBars) return clean;
  const bucketSize = Math.ceil(clean.length / targetBars);
  const buckets = [];
  for (let index = 0; index < clean.length; index += bucketSize) {
    const slice = clean.slice(index, index + bucketSize);
    const average = slice.reduce((sum, point) => sum + point.price, 0) / slice.length;
    buckets.push({ date: slice[slice.length - 1].date, price: average });
  }
  return buckets;
}

// Selects the trajectory-v1 forecast horizons this specific packet
// actually published (30d and/or 90d, never both assumed) with a valid,
// ordered q10<=q50<=q90 band. Mirrors trajectoryProjectionChart's
// checkpoint filter in ui.js so the two charts never disagree about
// what counts as "served".
export function selectServedForecastBars(packet) {
  if (!packet?.horizons) return [];
  return [30, 90]
    .map((horizon) => ({ horizon, band: packet.horizons[String(horizon)] }))
    .filter(({ band }) => band
      && [band.q10, band.q50, band.q90].every((value) => finiteNonNegative(value) !== null)
      && Number(band.q10) <= Number(band.q50) && Number(band.q50) <= Number(band.q90))
    .map(({ horizon, band }) => ({
      horizon,
      q10: Number(band.q10),
      q50: Number(band.q50),
      q90: Number(band.q90)
    }));
}

// A dependency-free inline-SVG BAR chart: solid bars for downsampled
// historic weekly prices, plus (when a forecast packet with served
// horizons is supplied) visually distinct projected bars appended after
// "today" at each served horizon's q50, each with a q10-q90 whisker.
//
// `points` is the raw [[date, price], ...] shape getPriceHistory/
// getPriceHistoryForItem resolve. `packet` is a trajectory-v1 packet
// (or null/undefined -- forecast-less items simply render history bars
// with no projection overlay, never an error).
export function historyBarChart(points, packet, currency = 'USD', { compact = false, stale = false } = {}) {
  const historyBars = downsampleHistoryPoints(points, compact ? 16 : 32);
  if (!historyBars.length) return '';
  const forecastBars = selectServedForecastBars(packet);
  const isColdStart = packet?.confidence === 'cold-start';

  const width = 760;
  const height = compact ? 180 : 300;
  const left = compact ? 56 : 76;
  const right = 742;
  const chartTop = 18;
  const bottom = compact ? 140 : 252;

  const totalBars = historyBars.length + forecastBars.length;
  const values = [...historyBars.map((bar) => bar.price), ...forecastBars.map((bar) => bar.q90)];
  const top = niceCeiling(Math.max(...values, 1) * 1.05);
  const y = (value) => bottom - ((value / top) * (bottom - chartTop));
  const slotWidth = (right - left) / totalBars;
  const barWidth = Math.max(2, slotWidth * 0.62);
  const slotX = (index) => left + (index * slotWidth) + (slotWidth / 2);

  const historyMarkup = historyBars.map((bar, index) => {
    const cx = slotX(index);
    const barTop = y(bar.price);
    return `<rect x="${(cx - barWidth / 2).toFixed(1)}" y="${barTop.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${Math.max(0, bottom - barTop).toFixed(1)}" class="history-bar" />`;
  }).join('');

  const forecastMarkup = forecastBars.map((bar, index) => {
    const cx = slotX(historyBars.length + index);
    const barTop = y(bar.q50);
    const whiskerTop = y(bar.q90);
    const whiskerBottom = y(bar.q10);
    const label = `+${bar.horizon}d est.`;
    return `<rect x="${(cx - barWidth / 2).toFixed(1)}" y="${barTop.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${Math.max(0, bottom - barTop).toFixed(1)}" class="history-bar-forecast${isColdStart ? ' history-bar-forecast-cold-start' : ''}" />`
      + `<line x1="${cx.toFixed(1)}" y1="${whiskerTop.toFixed(1)}" x2="${cx.toFixed(1)}" y2="${whiskerBottom.toFixed(1)}" class="history-bar-whisker" />`
      + `<text x="${cx.toFixed(1)}" y="${(bottom + 14).toFixed(1)}" text-anchor="middle" class="chart-axis-label chart-date-label">${escapeHTML(label)}</text>`;
  }).join('');

  const gridTicks = [0, 0.5, 1].map((fraction) => {
    const value = top * fraction;
    const row = y(value);
    return `<line x1="${left}" y1="${row.toFixed(1)}" x2="${right}" y2="${row.toFixed(1)}" class="chart-grid"/><text x="${(left - 8).toFixed(1)}" y="${(row + 4).toFixed(1)}" text-anchor="end" class="chart-axis-label">${escapeHTML(compactCurrency(value, currency))}</text>`;
  }).join('');

  const dateLabelIndexes = [...new Set([0, Math.floor((historyBars.length - 1) / 2), historyBars.length - 1])]
    .filter((index) => index >= 0);
  const dateLabels = compact ? [] : dateLabelIndexes.map((index) => `<text x="${slotX(index).toFixed(1)}" y="${(bottom + 14).toFixed(1)}" text-anchor="middle" class="chart-axis-label chart-date-label">${escapeHTML(shortDate(historyBars[index].date))}</text>`).join('');

  const todayDivider = forecastBars.length
    ? `<line x1="${(left + historyBars.length * slotWidth).toFixed(1)}" y1="${chartTop}" x2="${(left + historyBars.length * slotWidth).toFixed(1)}" y2="${bottom}" class="forecast-present"/>`
    : '';

  const latestHistory = historyBars.at(-1);
  const ariaLabel = `Historic weekly prices${forecastBars.length ? ` with projected estimates at ${forecastBars.map((bar) => `${bar.horizon} days`).join(' and ')}` : ''}`;

  return `<div class="chart-wrap history-bar-chart${isColdStart ? ' trajectory-cold-start' : ''}">
    ${forecastBars.length ? `<div class="trajectory-chart-labels"><span class="support-badge ${isColdStart ? 'restricted' : 'partial'}">${isColdStart ? 'Cold start estimate' : `${escapeHTML(packet.confidence || 'standard')} confidence`}</span>${stale ? '<span class="support-badge unsupported">Price data may be out of date</span>' : ''}</div>` : ''}
    <svg class="trend-chart history-bars" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHTML(ariaLabel)}">
      <title>${escapeHTML(ariaLabel)}; latest observed ${escapeHTML(formatCurrency(latestHistory.price, currency))}</title>
      ${gridTicks}
      ${dateLabels}
      ${historyMarkup}
      ${todayDivider}
      ${forecastMarkup}
    </svg>
  </div><div class="chart-legend"><span><i class="chart-market-point"></i>Weekly observed price</span>${forecastBars.length ? '<span><i class="forecast-median-dot"></i>Projected estimate (q50)</span><span><i class="forecast-band-80-dot"></i>q10-q90 range</span>' : ''}</div>`;
}
