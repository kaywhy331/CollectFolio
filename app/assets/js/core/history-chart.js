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
//   published packet actually carries (30d, 60d, and/or 90d) -- never
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

// SVG text has no layout pass while this string is assembled, so price
// labels use a small deterministic collision solver. Exact currency values
// remain beside their points while nearby labels can move to another side of
// the same point instead of overlapping or clipping outside the viewBox.
function placePriceLabels(labels, bounds) {
  const occupied = [];
  const variants = [
    { dx: 8, dy: 4, anchor: 'start' },
    { dx: -8, dy: 4, anchor: 'end' },
    { dx: 0, dy: -9, anchor: 'middle' },
    { dx: 0, dy: 16, anchor: 'middle' },
    { dx: 8, dy: -10, anchor: 'start' },
    { dx: -8, dy: -10, anchor: 'end' },
    { dx: 8, dy: 18, anchor: 'start' },
    { dx: -8, dy: 18, anchor: 'end' },
    { dx: 0, dy: -23, anchor: 'middle' },
    { dx: 8, dy: -24, anchor: 'start' },
    { dx: -8, dy: -24, anchor: 'end' },
    { dx: 0, dy: 30, anchor: 'middle' },
    { dx: 8, dy: 32, anchor: 'start' },
    { dx: -8, dy: 32, anchor: 'end' }
  ];
  const boxFor = (candidate, labelWidth) => {
    const x1 = candidate.anchor === 'end'
      ? candidate.x - labelWidth
      : candidate.anchor === 'middle'
        ? candidate.x - (labelWidth / 2)
        : candidate.x;
    return { x1, x2: x1 + labelWidth, y1: candidate.y - 12, y2: candidate.y + 4 };
  };
  const overlaps = (leftBox, rightBox) => !(
    leftBox.x2 + 3 <= rightBox.x1
    || leftBox.x1 >= rightBox.x2 + 3
    || leftBox.y2 + 2 <= rightBox.y1
    || leftBox.y1 >= rightBox.y2 + 2
  );
  const overlapArea = (leftBox, rightBox) => Math.max(0, Math.min(leftBox.x2, rightBox.x2) - Math.max(leftBox.x1, rightBox.x1))
    * Math.max(0, Math.min(leftBox.y2, rightBox.y2) - Math.max(leftBox.y1, rightBox.y1));

  return labels.map((label) => {
    const labelWidth = Math.min(bounds.maxX - bounds.minX, Math.max(30, [...label.text].length * 6.25));
    const preferredVariants = label.role === 'high'
      ? [variants[2], variants[0], variants[1], variants[4], variants[5], variants[8], variants[9], variants[10], variants[3], variants[6], variants[7], variants[11], variants[12], variants[13]]
      : label.role === 'low'
        ? [variants[3], variants[0], variants[1], variants[6], variants[7], variants[11], variants[12], variants[13], variants[2], variants[4], variants[5], variants[8], variants[9], variants[10]]
        : variants;
    const candidates = preferredVariants
      .map((variant) => ({
        x: label.targetX + variant.dx,
        y: label.targetY + variant.dy,
        anchor: variant.anchor
      }))
      .map((candidate) => ({ ...candidate, box: boxFor(candidate, labelWidth) }))
      .filter(({ box }) => box.x1 >= bounds.minX && box.x2 <= bounds.maxX && box.y1 >= bounds.minY && box.y2 <= bounds.maxY);
    const clearCandidate = candidates.find(({ box }) => occupied.every((used) => !overlaps(box, used)));
    const chosen = clearCandidate || candidates
      .map((candidate) => ({
        ...candidate,
        collisionScore: occupied.reduce((score, used) => score + overlapArea(candidate.box, used), 0)
      }))
      .sort((left, right) => left.collisionScore - right.collisionScore)[0] || {
        x: Math.min(Math.max(label.targetX + 8, bounds.minX), bounds.maxX - labelWidth),
        y: Math.min(Math.max(label.targetY + 4, bounds.minY + 10), bounds.maxY - 3),
        anchor: 'start'
      };
    const box = chosen.box || boxFor(chosen, labelWidth);
    occupied.push(box);
    return { ...label, x: chosen.x, y: chosen.y, anchor: chosen.anchor };
  });
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

// Selects the independently modeled horizons this specific packet
// actually published (30/60/90, never assumed) with a valid,
// ordered q10<=q50<=q90 band. Mirrors trajectoryProjectionChart's
// checkpoint filter in ui.js so the two charts never disagree about
// what counts as "served".
export function selectServedForecastBars(packet) {
  if (!packet?.horizons) return [];
  return [30, 60, 90]
    .map((horizon) => ({ horizon, band: packet.horizons[String(horizon)] }))
    .filter(({ band }) => band
      && [band.q10, band.q50, band.q90].every((value) => finiteNonNegative(value) !== null)
      && Number(band.q10) <= Number(band.q50) && Number(band.q50) <= Number(band.q90))
    .map(({ horizon, band }) => ({
      horizon,
      actualDays: Number(band.horizonDaysActual) || ({ 30: 28, 60: 63, 90: 91 }[horizon]),
      evidenceTier: String(band.evidenceTier || (packet.confidence === 'cold-start' ? 'attribute-reference' : 'range-only')),
      q10: Number(band.q10),
      q50: Number(band.q50),
      q90: Number(band.q90)
    }));
}

// Compatibility reader for a published `medianPath`. trajectory-v1.1 emits
// only the anchor and independently modeled checkpoints. Points
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

// Retained as a pure compatibility utility for callers that explicitly need
// resampling. The production forecast chart does not call it: daily points
// would imply model evidence that exists only at independent checkpoints.
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
// packet with validated horizons is supplied, a light dashed connector joins
// only its independent point checkpoints. Range-only/reference horizons have
// whiskers but no directional point or connector.
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
  const isColdStart = visiblePacket?.confidence === 'cold-start';
  const latestHistory = history.at(-1);

  // A packet's checkpoint dates and prices are inseparable from its own
  // observed anchor. Never slide an older packet forward to newer history:
  // that would silently change the forecast's maturity dates. The service
  // normally withholds this mismatch; the chart also fails closed.
  const packetAnchor = Date.parse(`${String(visiblePacket?.lastKnownDate || '')}T00:00:00.000Z`);
  const packetAnchorPrice = finiteNonNegative(visiblePacket?.lastKnownPrice);
  const publishedForecastMarks = selectServedForecastBars(visiblePacket);
  const packetCanAnchor = publishedForecastMarks.length
    && Number.isFinite(packetAnchor)
    && packetAnchor >= latestHistory.time
    && packetAnchorPrice !== null
    && packetAnchorPrice > 0;
  const forecastMarks = packetCanAnchor ? publishedForecastMarks : [];
  const anchorTime = packetCanAnchor ? packetAnchor : latestHistory.time;
  const anchorPrice = packetCanAnchor ? packetAnchorPrice : latestHistory.price;

  // Only independent model checkpoints are plotted.  The light connector
  // is presentation interpolation; no daily or weekly forecast values are
  // manufactured between them.
  const projection = forecastMarks.length
    ? [
        { time: anchorTime, price: anchorPrice, horizon: 0 },
        ...forecastMarks.map((mark) => ({
          time: anchorTime + (mark.actualDays * DAY),
          price: mark.q50,
          horizon: mark.horizon,
          evidenceTier: mark.evidenceTier
        }))
      ]
    : [];
  const directionalProjection = [
    ...(projection.length ? [projection[0]] : []),
    ...projection.slice(1).filter((point) => ['category-validated', 'relative-validated'].includes(point.evidenceTier))
  ];
  const projectionEnd = directionalProjection.length > 1 ? directionalProjection.at(-1) : null;
  const trendClass = projectionEnd
    ? (projectionEnd.price >= anchorPrice ? ' history-forecast-up' : ' history-forecast-down')
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
    ...forecastMarks.map((mark) => anchorTime + (mark.actualDays * DAY)),
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

  const projectionCoords = directionalProjection.map((point) => `${x(point.time).toFixed(1)},${y(point.price).toFixed(1)}`).join(' ');
  const projectionLine = directionalProjection.length > 1
    ? `<polyline points="${projectionCoords}" class="history-forecast-line${trendClass}${isColdStart ? ' history-forecast-line-cold-start' : ''}"/>`
    : '';

  const whiskerMarkup = forecastMarks.map((mark) => {
    const cx = x(anchorTime + (mark.actualDays * DAY));
    const directional = ['category-validated', 'relative-validated'].includes(mark.evidenceTier);
    const label = directional ? `+${mark.horizon}d est.` : `+${mark.horizon}d range`;
    const horizonLabelAtRightEdge = cx >= right - 1;
    return `<line x1="${cx.toFixed(1)}" y1="${y(mark.q90).toFixed(1)}" x2="${cx.toFixed(1)}" y2="${y(mark.q10).toFixed(1)}" class="history-bar-whisker" />`
      + (directional ? `<circle cx="${cx.toFixed(1)}" cy="${y(mark.q50).toFixed(1)}" r="4" class="history-forecast-point${trendClass}" />` : '')
      + `<text x="${(horizonLabelAtRightEdge ? cx - 2 : cx).toFixed(1)}" y="${(bottom + 14).toFixed(1)}" text-anchor="${horizonLabelAtRightEdge ? 'end' : 'middle'}" class="chart-axis-label chart-date-label history-forecast-horizon-label">${escapeHTML(label)}</text>`;
  }).join('');

  const forecastMidpointLabels = forecastMarks.map((mark) => {
    const directional = ['category-validated', 'relative-validated'].includes(mark.evidenceTier);
    const text = formatCurrency(mark.q50, currency);
    return {
      targetX: x(anchorTime + (mark.actualDays * DAY)),
      targetY: y(mark.q50),
      text,
      className: `history-price-label history-forecast-midpoint-label${directional ? ` history-forecast-estimate-label${trendClass}` : ''}`,
      role: 'midpoint',
      horizon: mark.horizon,
      ariaLabel: directional
        ? `${mark.horizon}-day estimated price ${text}`
        : `${mark.horizon}-day range midpoint ${text}; no directional forecast`
    };
  });
  const forecastBoundLabels = forecastMarks.flatMap((mark) => ([
    {
      targetX: x(anchorTime + (mark.actualDays * DAY)),
      targetY: y(mark.q90),
      text: formatCurrency(mark.q90, currency),
      className: 'history-price-label history-forecast-bound-label history-forecast-high-label',
      role: 'high',
      horizon: mark.horizon,
      ariaLabel: `${mark.horizon}-day upper forecast range ${formatCurrency(mark.q90, currency)}`
    },
    {
      targetX: x(anchorTime + (mark.actualDays * DAY)),
      targetY: y(mark.q10),
      text: formatCurrency(mark.q10, currency),
      className: 'history-price-label history-forecast-bound-label history-forecast-low-label',
      role: 'low',
      horizon: mark.horizon,
      ariaLabel: `${mark.horizon}-day lower forecast range ${formatCurrency(mark.q10, currency)}`
    }
  ]));
  const latestPriceText = formatCurrency(latestHistory.price, currency);
  const priceLabels = placePriceLabels([
    {
      targetX: x(latestHistory.time),
      targetY: y(latestHistory.price),
      text: latestPriceText,
      className: 'history-price-label history-latest-price-label',
      role: 'observed',
      horizon: null,
      ariaLabel: `Last observed price ${latestPriceText} on ${datedLabel(latestHistory.date, true)}`
    },
    ...forecastMidpointLabels,
    ...forecastBoundLabels
  ], { minX: left + 3, maxX: width - 5, minY: chartTop + 1, maxY: bottom - 1 });
  const priceLabelMarkup = priceLabels.map((label) => `<text x="${label.x.toFixed(1)}" y="${label.y.toFixed(1)}" text-anchor="${label.anchor}" class="${label.className}" data-price-role="${label.role}"${label.horizon ? ` data-forecast-horizon="${label.horizon}"` : ''} aria-label="${escapeAttribute(label.ariaLabel)}">${escapeHTML(label.text)}</text>`).join('');

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

  const evidenceTiers = new Set(forecastMarks.map((mark) => mark.evidenceTier));
  const confidenceBadge = evidenceTiers.has('attribute-reference')
    ? '<span class="support-badge restricted">Attribute-based reference range</span>'
    : evidenceTiers.has('range-only')
      ? '<span class="support-badge partial">Price range · no direction</span>'
      : evidenceTiers.has('relative-validated')
        ? '<span class="support-badge partial">Estimated price · assumes flat market</span>'
        : '';
  const forecastPriceSummary = forecastMarks.map((mark) => {
    const directional = ['category-validated', 'relative-validated'].includes(mark.evidenceTier);
    return `${mark.horizon}-day ${directional ? 'estimated price' : 'range midpoint'} ${formatCurrency(mark.q50, currency)}, low ${formatCurrency(mark.q10, currency)}, high ${formatCurrency(mark.q90, currency)}`;
  }).join('; ');
  const ariaLabel = `Historic weekly prices for the ${selectedRange} range; last observed ${latestPriceText}${forecastPriceSummary ? `; ${forecastPriceSummary}` : ''}`;

  // Hover payload: observed dates and independent forecast checkpoints only.
  // (core/chart-hover.js reads this attribute; no framework, no listeners
  // in the markup itself).
  const hoverLabel = (date, price, projected) => `${datedLabel(date, true)} — ${formatCurrency(price, currency)}${projected ? ' (projected)' : ''}`;
  const hoverPoints = [
    ...history.map((point) => ({ x: Number(x(point.time).toFixed(1)), y: Number(y(point.price).toFixed(1)), l: hoverLabel(point.date, point.price, false) })),
    ...projection
      .filter((point) => point.time > anchorTime)
      .map((point) => ({
        x: Number(x(point.time).toFixed(1)),
        y: Number(y(point.price).toFixed(1)),
        l: `${datedLabel(isoDate(point.time), true)} — ${point.evidenceTier === 'range-only' || point.evidenceTier === 'attribute-reference' ? 'price range checkpoint' : formatCurrency(point.price, currency) + ' (estimated)'}`
      }))
  ];

  return `<div class="chart-wrap history-line-chart${isColdStart ? ' trajectory-cold-start' : ''}" data-history-range="${escapeAttribute(selectedRange)}" data-forecast-visible="${forecastMarks.length ? 'true' : 'false'}">
    ${(confidenceBadge || stale) && forecastMarks.length ? `<div class="trajectory-chart-labels">${confidenceBadge}${stale ? '<span class="support-badge unsupported">Price data may be out of date</span>' : ''}</div>` : ''}
    <svg class="trend-chart history-bars" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeAttribute(ariaLabel)}" data-chart-points="${escapeAttribute(JSON.stringify(hoverPoints))}">
      <title>${escapeHTML(ariaLabel)}</title>
      ${gridTicks}
      ${dateLabels}
      <polyline points="${lineCoords}" class="chart-line chart-market history-line"/>
      ${pointMarkup}
      ${latestMarker}
      ${todayDivider}
      ${projectionLine}
      ${whiskerMarkup}
      ${priceLabelMarkup}
    </svg>
  </div><div class="chart-legend"><span><i class="history-line-dot"></i>Observed price</span>${forecastMarks.length ? `${directionalProjection.length > 1 ? `<span><i class="history-forecast-dot${trendClass}"></i>Interpolated checkpoint connector</span>` : ''}<span><i class="forecast-band-80-dot"></i>Independent q10–q90 checkpoints</span>` : ''}</div>`;
}
