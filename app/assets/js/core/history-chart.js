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

const DAY = 86_400_000;

// Linear day-by-day interpolation between published path checkpoints so the
// projection reads as a rolling daily forecast: every calendar day between
// today and the furthest horizon gets a plotted value on the day-scaled
// axis. This is presentation-level resampling OF the published median path
// (straight lines between its own points) -- no new price levels are invented.
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
// packet with served horizons is supplied, the published rolling median
// path continues past the "today" divider as a dashed daily projection --
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
export function historyLineChart(points, packet, currency = 'USD', { compact = false, stale = false } = {}) {
  const history = downsampleHistoryPoints(points, 240)
    .map((point) => ({ ...point, time: Date.parse(`${point.date}T00:00:00.000Z`) }));
  if (!history.length) return '';
  const forecastMarks = selectServedForecastBars(packet);
  const isColdStart = packet?.confidence === 'cold-start';
  const latestHistory = history.at(-1);

  // "Today" anchor: the packet's own lastKnownDate when it is at or past
  // the last observed history point, else the last observed point itself.
  const packetAnchor = Date.parse(`${String(packet?.lastKnownDate || '')}T00:00:00.000Z`);
  const anchorTime = forecastMarks.length && Number.isFinite(packetAnchor)
    ? Math.max(packetAnchor, latestHistory.time)
    : latestHistory.time;

  // Rolling projection: the published weekly median path after the anchor,
  // resampled to daily steps; packets without a medianPath fall back to the
  // served horizon q50 checkpoints (still day-positioned, still rolling).
  const publishedPath = forecastMarks.length
    ? selectForecastMedianPath(packet).filter((point) => point.time > anchorTime)
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
  const dateLabels = compact ? '' : dateLabelIndexes.map((index) => `<text x="${x(history[index].time).toFixed(1)}" y="${(bottom + 14).toFixed(1)}" text-anchor="${index === 0 ? 'start' : 'middle'}" class="chart-axis-label chart-date-label">${escapeHTML(shortDate(history[index].date))}</text>`).join('');

  const todayDivider = forecastMarks.length
    ? `<line x1="${x(anchorTime).toFixed(1)}" y1="${chartTop}" x2="${x(anchorTime).toFixed(1)}" y2="${bottom}" class="forecast-present"/>`
    : '';

  const confidenceBadge = isColdStart
    ? '<span class="support-badge restricted">Cold start estimate</span>'
    : ['low-history', 'insufficient-history'].includes(packet?.confidence)
      ? '<span class="support-badge partial">Early estimate</span>'
      : '';
  const ariaLabel = `Historic weekly prices${forecastMarks.length ? ` with a rolling daily projection to ${forecastMarks.map((mark) => `${mark.horizon} days`).join(' and ')}` : ''}`;

  return `<div class="chart-wrap history-line-chart${isColdStart ? ' trajectory-cold-start' : ''}">
    ${(confidenceBadge || stale) && forecastMarks.length ? `<div class="trajectory-chart-labels">${confidenceBadge}${stale ? '<span class="support-badge unsupported">Price data may be out of date</span>' : ''}</div>` : ''}
    <svg class="trend-chart history-bars" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHTML(ariaLabel)}">
      <title>${escapeHTML(ariaLabel)}; latest observed ${escapeHTML(formatCurrency(latestHistory.price, currency))}</title>
      ${gridTicks}
      ${dateLabels}
      <polyline points="${lineCoords}" class="chart-line chart-market history-line"/>
      ${pointMarkup}
      ${latestMarker}
      ${todayDivider}
      ${projectionLine}
      ${projectionMarkers}
      ${whiskerMarkup}
    </svg>
  </div><div class="chart-legend"><span><i class="history-line-dot"></i>Observed price</span>${forecastMarks.length ? `<span><i class="history-forecast-dot${trendClass}"></i>Rolling daily projection</span><span><i class="forecast-band-80-dot"></i>q10–q90 range</span>` : ''}</div>`;
}
