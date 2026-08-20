// 0.8.18: dependency-free inline-SVG LINE chart for weekly price
// history plus (when published) trajectory-v1 forecast projection bars.
//
// Kept as a sibling module to core/ui.js rather than folded in directly
// so the pure, non-DOM pieces -- downsampling and served-horizon
// selection -- can be unit tested in isolation from SVG string assembly.
//
// Fail-closed conventions mirrored from ui.js's trajectoryProjectionChart:
// - No history points at all -> caller shouldn't call this (services
//   layer already fails closed), but historyLineChart also returns '' as
//   a defensive fallback.
// - Forecast projection bars are ONLY ever drawn for horizons the
//   published packet actually carries (30d and/or 90d) -- never
//   fabricated, never interpolated to another horizon.
import { escapeAttribute, escapeHTML, formatCurrency } from './utils.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY = 86_400_000;

export const HISTORY_CHART_RANGES = Object.freeze(['1M', '3M', '6M', '1Y', 'All']);

const HISTORY_CHART_RANGE_DAYS = Object.freeze({
  '1M': 30,
  '3M': 90,
  '6M': 180,
  '1Y': 365
});

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

function datedLabel(value, includeYear = false) {
  const label = shortDate(value);
  return label && includeYear ? `${label}, ${String(value).slice(0, 4)}` : label;
}

// Cleans + sorts raw [date, price] pairs into {date, price} objects,
// dropping anything malformed rather than fabricating a value.
export function normalizeHistoryPoints(points) {
  return (Array.isArray(points) ? points : [])
    .map((pair) => ({ date: String(pair?.[0] || ''), price: finiteNonNegative(pair?.[1]) }))
    .filter((point) => point.price !== null && shortDate(point.date))
    .sort((left, right) => left.date.localeCompare(right.date));
}

// Range controls are anchored to the latest observed price date, not the
// wall clock. That keeps archived or temporarily stale series useful and
// prevents a sparse publication from becoming an empty chart.
export function filterHistoryPointsByRange(points, range = 'All') {
  const clean = normalizeHistoryPoints(points);
  const selectedRange = HISTORY_CHART_RANGES.includes(range) ? range : 'All';
  const days = HISTORY_CHART_RANGE_DAYS[selectedRange];
  if (!days || clean.length < 2) return clean;
  const latestTime = Date.parse(`${clean.at(-1).date}T00:00:00.000Z`);
  const cutoff = latestTime - (days * DAY);
  return clean.filter((point) => Date.parse(`${point.date}T00:00:00.000Z`) >= cutoff);
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

// The published rolling forecast path: trajectory-v1 packets carry a
// weekly `medianPath` (lastKnownDate through the furthest horizon). Points
// are cleaned, sorted, and returned with a parsed UTC timestamp; anything
// malformed is dropped rather than repaired. Never fabricated -- packets
// without a medianPath return [].
export function selectForecastMedianPath(packet) {
  return (Array.isArray(packet?.medianPath) ? packet.medianPath : [])
    .map((point) => ({
      date: String(point?.date || ''),
      price: finiteNonNegative(point?.price),
      time: Date.parse(`${String(point?.date || '')}T00:00:00.000Z`)
    }))
    .filter((point) => point.price !== null && Number.isFinite(point.time))
    .sort((left, right) => left.time - right.time);
}

function isoDate(time) {
  return new Date(time).toISOString().slice(0, 10);
}

// Linear day-by-day interpolation between published weekly path checkpoints.
// This is presentation-level resampling of one latest forecast path, not a
// separately refitted forecast vintage for every future calendar date.
export function interpolateDailyPath(checkpoints) {
  const clean = (Array.isArray(checkpoints) ? checkpoints : [])
    .filter((point) => Number.isFinite(point?.time) && finiteNonNegative(point?.price) !== null)
    .sort((left, right) => left.time - right.time);
  if (clean.length < 2) return clean;
  const daily = [];
  for (let index = 0; index < clean.length - 1; index += 1) {
    const from = clean[index];
    const to = clean[index + 1];
    const span = to.time - from.time;
    daily.push(from);
    if (span <= DAY) continue;
    for (let time = from.time + DAY; time < to.time; time += DAY) {
      const fraction = (time - from.time) / span;
      daily.push({ time, price: from.price + ((to.price - from.price) * fraction) });
    }
  }
  daily.push(clean.at(-1));
  return daily;
}

// A dependency-free inline-SVG LINE chart on a REAL-TIME x-axis: a blue
// polyline through every published weekly price point (no downsampling
// below 240 points), positioned proportionally by date. When a forecast
// packet with served horizons is supplied, the published latest median path
// continues past the "today" divider as a dashed daily projection --
// 30 days of forecast occupy 30 days of axis (Kevin 2026-08-18) -- colored
// green when the projected trend is up and red when it is down, with
// q10-q90 whiskers at each served horizon checkpoint.
//
// The y-domain is ZOOMED to the observed range (min..max, padded) rather
// than anchored at $0 -- a $50 card moving by a few dollars must render as
// visible movement, not a flat line (Kevin 2026-08-18).
//
// `points` is the raw [[date, price], ...] shape getPriceHistory/
// getPriceHistoryForItem resolve. `packet` is a trajectory-v1 packet
// (or null/undefined -- forecast-less items simply render the history
// line with no projection overlay, never an error).
export function historyLineChart(
  points,
  packet,
  currency = 'USD',
  { compact = false, stale = false, range = 'All', showForecast = true } = {}
) {
  const selectedRange = HISTORY_CHART_RANGES.includes(range) ? range : 'All';
  const rangedPoints = filterHistoryPointsByRange(points, selectedRange);
  const history = downsampleHistoryPoints(rangedPoints.map((point) => [point.date, point.price]), 240)
    .map((point) => ({ ...point, time: Date.parse(`${point.date}T00:00:00.000Z`) }));
  if (!history.length) return '';
  const visiblePacket = showForecast ? packet : null;
  const forecastMarks = selectServedForecastBars(visiblePacket);
  const isColdStart = visiblePacket?.confidence === 'cold-start';
  const latestHistory = history.at(-1);

  // "Today" anchor: the packet's own lastKnownDate when it is at or past
  // the last observed history point, else the last observed point itself.
  const packetAnchor = Date.parse(`${String(visiblePacket?.lastKnownDate || '')}T00:00:00.000Z`);
  const anchorTime = forecastMarks.length && Number.isFinite(packetAnchor)
    ? Math.max(packetAnchor, latestHistory.time)
    : latestHistory.time;

  // Latest projection: the published weekly median path after the anchor,
  // resampled to daily display steps. Packets without a medianPath fall back
  // to the served horizon q50 checkpoints.
  const publishedPath = forecastMarks.length
    ? selectForecastMedianPath(visiblePacket).filter((point) => point.time > anchorTime)
    : [];
  const pathCheckpoints = forecastMarks.length
    ? [
        { time: anchorTime, price: latestHistory.price },
        ...(publishedPath.length
          ? publishedPath
          : forecastMarks.map((mark) => ({ time: anchorTime + (mark.horizon * DAY), price: mark.q50 })))
      ]
    : [];
  const projection = interpolateDailyPath(pathCheckpoints);
  const projectionEnd = projection.at(-1) || null;
  const trendClass = projectionEnd
    ? (projectionEnd.price >= latestHistory.price ? ' history-forecast-up' : ' history-forecast-down')
    : '';

  const width = 760;
  const height = compact ? 180 : 340;
  const left = compact ? 56 : 76;
  const right = 742;
  const chartTop = 18;
  const bottom = compact ? 140 : 290;

  // Zoomed y-domain: observed min..max (forecast q10/q90 and the projected
  // path included so the projection never clips), padded so the extremes
  // don't sit on the frame.
  const values = [
    ...history.map((point) => point.price),
    ...forecastMarks.flatMap((mark) => [mark.q10, mark.q90]),
    ...projection.map((point) => point.price)
  ];
  const rawLo = Math.min(...values);
  const rawHi = Math.max(...values);
  const pad = rawHi > rawLo ? (rawHi - rawLo) * 0.08 : Math.max(rawHi * 0.03, 0.25);
  const lo = Math.max(0, rawLo - pad);
  const hi = rawHi + pad;
  const y = (value) => bottom - (((value - lo) / (hi - lo)) * (bottom - chartTop));

  // REAL-TIME x-axis: pixels are proportional to calendar days across
  // history AND forecast, so a 30-day horizon occupies 30 days of space.
  const timeStart = history[0].time;
  const timeEnd = Math.max(
    anchorTime,
    ...forecastMarks.map((mark) => anchorTime + (mark.horizon * DAY)),
    ...(projectionEnd ? [projectionEnd.time] : [])
  );
  const timeSpan = Math.max(timeEnd - timeStart, DAY);
  const x = (time) => left + (((time - timeStart) / timeSpan) * (right - left));

  const tickCurrency = (value) => new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
    notation: hi >= 10000 ? 'compact' : 'standard',
    maximumFractionDigits: hi - lo < 20 ? 2 : 0
  }).format(value);

  const lineCoords = history.map((point) => `${x(point.time).toFixed(1)},${y(point.price).toFixed(1)}`).join(' ');
  const pointMarkup = history.length <= 90
    ? history.map((point) => `<circle cx="${x(point.time).toFixed(1)}" cy="${y(point.price).toFixed(1)}" r="2.5" class="history-point" />`).join('')
    : '';
  const latestMarker = `<circle cx="${x(latestHistory.time).toFixed(1)}" cy="${y(latestHistory.price).toFixed(1)}" r="4.5" class="chart-point history-latest-point" />`;

  const projectionCoords = projection.map((point) => `${x(point.time).toFixed(1)},${y(point.price).toFixed(1)}`).join(' ');
  const projectionLine = projection.length > 1
    ? `<polyline points="${projectionCoords}" class="history-forecast-line${trendClass}${isColdStart ? ' history-forecast-line-cold-start' : ''}"/>`
    : '';
  // Markers on the PUBLISHED weekly path points (not every interpolated
  // day), plus a larger marker at the projection's end.
  const projectionMarkers = publishedPath
    .map((point) => `<circle cx="${x(point.time).toFixed(1)}" cy="${y(point.price).toFixed(1)}" r="2.5" class="history-forecast-point${trendClass}${isColdStart ? ' history-forecast-point-cold-start' : ''}" />`)
    .join('')
    + (projectionEnd && projectionEnd.time > anchorTime
      ? `<circle cx="${x(projectionEnd.time).toFixed(1)}" cy="${y(projectionEnd.price).toFixed(1)}" r="4" class="history-forecast-point${trendClass}${isColdStart ? ' history-forecast-point-cold-start' : ''}" />`
      : '');

  // The shaded fan joins only the uncertainty checkpoints the model serves.
  // Intermediate fill is a visual connection between calibrated q10/q90
  // endpoints; the whiskers remain the authoritative 30d/90d readings.
  const forecastBandPoints = forecastMarks.length
    ? [
        { time: anchorTime, q10: latestHistory.price, q90: latestHistory.price },
        ...forecastMarks.map((mark) => ({
          time: anchorTime + (mark.horizon * DAY),
          q10: mark.q10,
          q90: mark.q90
        }))
      ]
    : [];
  const forecastBand = forecastBandPoints.length > 1
    ? `<polygon points="${[
        ...forecastBandPoints.map((point) => `${x(point.time).toFixed(1)},${y(point.q90).toFixed(1)}`),
        ...[...forecastBandPoints].reverse().map((point) => `${x(point.time).toFixed(1)},${y(point.q10).toFixed(1)}`)
      ].join(' ')}" class="history-forecast-band" />`
    : '';

  const whiskerMarkup = forecastMarks.map((mark) => {
    const cx = x(anchorTime + (mark.horizon * DAY));
    return `<line x1="${cx.toFixed(1)}" y1="${y(mark.q90).toFixed(1)}" x2="${cx.toFixed(1)}" y2="${y(mark.q10).toFixed(1)}" class="history-bar-whisker" />`
      + `<circle cx="${cx.toFixed(1)}" cy="${y(mark.q50).toFixed(1)}" r="4" class="history-forecast-point${trendClass}${isColdStart ? ' history-forecast-point-cold-start' : ''}" />`
      + `<text x="${cx.toFixed(1)}" y="${(bottom + 14).toFixed(1)}" text-anchor="middle" class="chart-axis-label chart-date-label">${escapeHTML(`+${mark.horizon}d est.`)}</text>`;
  }).join('');

  const gridTicks = [0, 0.5, 1].map((fraction) => {
    const value = lo + ((hi - lo) * fraction);
    const row = y(value);
    return `<line x1="${left}" y1="${row.toFixed(1)}" x2="${right}" y2="${row.toFixed(1)}" class="chart-grid"/><text x="${(left - 8).toFixed(1)}" y="${(row + 4).toFixed(1)}" text-anchor="end" class="chart-axis-label">${escapeHTML(tickCurrency(value))}</text>`;
  }).join('');

  // History date labels: first and midpoint always; the last observed date
  // only when no forecast follows it (the today divider marks it otherwise,
  // and the +30d label would collide with it on a day-scaled axis).
  const dateLabelIndexes = [...new Set(forecastMarks.length
    ? [0, Math.floor((history.length - 1) / 2)]
    : [0, Math.floor((history.length - 1) / 2), history.length - 1])]
    .filter((index) => index >= 0 && index < history.length);
  const spansMultipleYears = history[0].date.slice(0, 4) !== latestHistory.date.slice(0, 4);
  const dateLabels = compact ? '' : dateLabelIndexes.map((index) => `<text x="${x(history[index].time).toFixed(1)}" y="${(bottom + 14).toFixed(1)}" text-anchor="${index === 0 ? 'start' : 'middle'}" class="chart-axis-label chart-date-label">${escapeHTML(datedLabel(history[index].date, spansMultipleYears))}</text>`).join('');

  const todayDivider = forecastMarks.length
    ? `<line x1="${x(anchorTime).toFixed(1)}" y1="${chartTop}" x2="${x(anchorTime).toFixed(1)}" y2="${bottom}" class="forecast-present"/><text x="${(x(anchorTime) - 6).toFixed(1)}" y="${(chartTop + 13).toFixed(1)}" text-anchor="end" class="chart-axis-label forecast-anchor-label">Last observed</text>`
    : '';

  const confidenceBadge = isColdStart
    ? '<span class="support-badge restricted">Cold start estimate</span>'
    : ['low-history', 'insufficient-history'].includes(visiblePacket?.confidence)
      ? '<span class="support-badge partial">Early estimate</span>'
      : '';
  const ariaLabel = `Historic weekly prices for the ${selectedRange} range${forecastMarks.length ? ` with the latest forecast to ${forecastMarks.map((mark) => `${mark.horizon} days`).join(' and ')}` : ''}`;

  // Hover payload (Kevin 2026-08-18): every plotted x-position -- observed
  // weekly points and every projected day -- carries its date + price so a
  // pointer over the line surfaces "date -- price" as a tooltip
  // (core/chart-hover.js reads this attribute; no framework, no listeners
  // in the markup itself).
  const hoverLabel = (date, price, projected) => `${datedLabel(date, true)} — ${formatCurrency(price, currency)}${projected ? ' (projected)' : ''}`;
  const hoverPoints = [
    ...history.map((point) => ({ x: Number(x(point.time).toFixed(1)), y: Number(y(point.price).toFixed(1)), l: hoverLabel(point.date, point.price, false) })),
    ...projection
      .filter((point) => point.time > anchorTime)
      .map((point) => ({ x: Number(x(point.time).toFixed(1)), y: Number(y(point.price).toFixed(1)), l: hoverLabel(point.date || isoDate(point.time), point.price, true) }))
  ];

  return `<div class="chart-wrap history-line-chart${isColdStart ? ' trajectory-cold-start' : ''}" data-history-range="${escapeAttribute(selectedRange)}" data-forecast-visible="${forecastMarks.length ? 'true' : 'false'}">
    ${(confidenceBadge || stale) && forecastMarks.length ? `<div class="trajectory-chart-labels">${confidenceBadge}${stale ? '<span class="support-badge unsupported">Price data may be out of date</span>' : ''}</div>` : ''}
    <svg class="trend-chart history-bars" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHTML(ariaLabel)}" data-chart-points="${escapeAttribute(JSON.stringify(hoverPoints))}">
      <title>${escapeHTML(ariaLabel)}; latest observed ${escapeHTML(formatCurrency(latestHistory.price, currency))}</title>
      ${gridTicks}
      ${forecastBand}
      ${dateLabels}
      <polyline points="${lineCoords}" class="chart-line chart-market history-line"/>
      ${pointMarkup}
      ${latestMarker}
      ${todayDivider}
      ${projectionLine}
      ${projectionMarkers}
      ${whiskerMarkup}
    </svg>
  </div><div class="chart-legend"><span><i class="history-line-dot"></i>Observed price</span>${forecastMarks.length ? `<span><i class="history-forecast-dot${trendClass}"></i>Latest forecast</span><span><i class="forecast-band-80-dot"></i>Calibrated q10–q90 checkpoints</span>` : ''}</div>`;
}
