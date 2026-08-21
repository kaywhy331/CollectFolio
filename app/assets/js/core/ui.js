import { clamp, escapeAttribute, escapeHTML, formatCurrency } from './utils.js';

let closeCurrent = null;

export function showToast(message, tone = 'success', duration = 3600) {
  const region = document.querySelector('#toast-region');
  if (!region) return;
  const toast = document.createElement('div');
  toast.className = `toast toast-${tone}`;
  toast.innerHTML = `<span aria-hidden="true">${tone === 'error' ? '!' : '✓'}</span><span>${escapeHTML(message)}</span>`;
  region.append(toast);
  setTimeout(() => toast.remove(), duration);
}

export function openModal({ title, content, actions = '', onOpen, onClose } = {}) {
  closeCurrent?.();
  const root = document.querySelector('#modal-root');
  const app = document.querySelector('#app');
  const lastFocus = document.activeElement;
  const appWasInert = Boolean(app?.inert);
  const appAriaHidden = app?.getAttribute('aria-hidden');
  const wrapper = document.createElement('div');
  wrapper.className = 'modal-layer';
  wrapper.innerHTML = `<div class="modal-backdrop" data-close-modal></div>
    <section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" tabindex="-1">
      <header><h2 id="modal-title">${escapeHTML(title || '')}</h2><button class="icon-button" data-close-modal aria-label="Close">×</button></header>
      <div class="modal-content">${content || ''}</div>
      ${actions ? `<footer class="modal-actions">${actions}</footer>` : ''}
    </section>`;
  root.append(wrapper);
  if (app) {
    app.inert = true;
    app.setAttribute('aria-hidden', 'true');
  }
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    onClose?.();
    wrapper.remove();
    if (app) {
      app.inert = appWasInert;
      if (appAriaHidden === null) app.removeAttribute('aria-hidden');
      else app.setAttribute('aria-hidden', appAriaHidden);
    }
    closeCurrent = null;
    if (lastFocus?.isConnected) lastFocus.focus?.({ preventScroll: true });
  };
  closeCurrent = close;
  wrapper.addEventListener('click', (event) => {
    if (event.target.closest('[data-close-modal]')) close();
  });
  wrapper.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [...wrapper.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
      .filter((element) => !element.disabled && !element.hidden && element.getAttribute('aria-hidden') !== 'true');
    if (!focusable.length) {
      event.preventDefault();
      wrapper.querySelector('.modal')?.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  wrapper.querySelector('[autofocus], input, select, textarea, button')?.focus({ preventScroll: true });
  onOpen?.(wrapper, close);
  return close;
}

export function closeModal() {
  closeCurrent?.();
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function finiteNonNegative(value) {
  if (value === '' || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function meaningfulScale(values = []) {
  const finite = values.map(Number).filter(Number.isFinite);
  if (!finite.length) return { lower: 0, upper: 1 };
  const minimum = Math.min(...finite);
  const maximum = Math.max(...finite);
  const observedSpan = maximum - minimum;
  const padding = Math.max(observedSpan * 0.12, maximum * 0.035, 1);
  const lower = Math.max(0, minimum - padding);
  const upper = Math.max(lower + 1, maximum + padding);
  return { lower, upper };
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

function axisMarkup({ lower = 0, upper, currency, left, right, y, xLabels }) {
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  const horizontal = ticks.map((fraction) => {
    const value = lower + ((upper - lower) * fraction);
    const row = y(value);
    return `<line x1="${left}" y1="${row.toFixed(1)}" x2="${right}" y2="${row.toFixed(1)}" class="chart-grid"/><text x="${left - 10}" y="${(row + 4).toFixed(1)}" text-anchor="end" class="chart-axis-label">${escapeHTML(compactCurrency(value, currency))}</text>`;
  }).join('');
  const dates = xLabels.map(({ x, label, anchor = 'middle' }) => `<text x="${x.toFixed(1)}" y="286" text-anchor="${anchor}" class="chart-axis-label chart-date-label">${escapeHTML(label)}</text>`).join('');
  return `${horizontal}${dates}`;
}

export function trendChart(snapshots = [], currency = 'USD') {
  const normalized = (Array.isArray(snapshots) ? snapshots : [])
    .map((point) => ({
      date: String(point?.date || ''),
      marketValue: finiteNonNegative(point?.marketValue),
      costBasis: finiteNonNegative(point?.costBasis)
    }))
    .filter((point) => point.marketValue !== null && shortDate(point.date))
    .sort((left, right) => left.date.localeCompare(right.date));
  const points = [...new Map(normalized.map((point) => [point.date, point])).values()].slice(-90);
  if (points.length < 2) return '<div class="empty-chart"><strong>Collection history starts here</strong><span>We will chart changes after another verified value is recorded.</span></div>';
  const width = 760;
  const height = 300;
  // Leave enough room for the mobile axis treatment. SVG text otherwise
  // scales with this fixed desktop viewBox and becomes unreadably small at
  // the narrowest supported viewport.
  const left = 96;
  const right = 744;
  const chartTop = 18;
  const bottom = 252;
  const showCost = points.every((point) => point.costBasis !== null);
  const values = points.flatMap((point) => [point.marketValue, ...(showCost ? [point.costBasis] : [])]);
  const { lower, upper } = meaningfulScale(values);
  const y = (value) => bottom - (((value - lower) / (upper - lower)) * (bottom - chartTop));
  const x = (index) => left + ((index * (right - left)) / (points.length - 1));
  const coords = (field) => points.map((point, index) => {
    return `${x(index).toFixed(1)},${y(point[field]).toFixed(1)}`;
  }).join(' ');
  const labelIndexes = [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])];
  const xLabels = labelIndexes.map((index) => ({
    x: x(index),
    label: shortDate(points[index].date),
    anchor: index === 0 && points.length > 1 ? 'start' : index === points.length - 1 ? 'end' : 'middle'
  }));
  const latest = points.at(-1);
  const latestX = x(points.length - 1);
  const hoverPoints = points.map((point, index) => ({
    x: Number(x(index).toFixed(1)), y: Number(y(point.marketValue).toFixed(1)),
    l: `${shortDate(point.date)} — ${formatCurrency(point.marketValue, currency)}`
  }));
  const costTitle = showCost ? `; latest cost ${formatCurrency(latest.costBasis, currency)}` : '';
  return `<div class="chart-wrap collection-trend-chart"><svg class="trend-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Collection market value${showCost ? ' and cost basis' : ''} with currency scale and dates" data-chart-points="${escapeAttribute(JSON.stringify(hoverPoints))}">
    <title>Latest market ${escapeHTML(formatCurrency(latest.marketValue, currency))}${escapeHTML(costTitle)}</title>
    ${axisMarkup({ lower, upper, currency, left, right, y, xLabels })}
    <polyline points="${coords('marketValue')}" class="chart-line chart-market"/>
    ${showCost ? `<polyline points="${coords('costBasis')}" class="chart-line chart-cost"/>` : ''}
    <circle cx="${latestX.toFixed(1)}" cy="${y(latest.marketValue).toFixed(1)}" r="5" class="chart-point chart-market-point"/>
    ${showCost ? `<circle cx="${latestX.toFixed(1)}" cy="${y(latest.costBasis).toFixed(1)}" r="5" class="chart-point chart-cost-point"/>` : ''}
  </svg></div><div class="chart-footer"><div class="chart-legend"><span><i class="market-dot"></i>Market value</span>${showCost ? '<span><i class="cost-dot"></i>Cost basis</span>' : ''}</div><div class="chart-latest"><span>Latest market <strong>${escapeHTML(formatCurrency(latest.marketValue, currency))}</strong></span>${showCost ? `<span>Cost <strong>${escapeHTML(formatCurrency(latest.costBasis, currency))}</strong></span>` : ''}</div></div>`;
}

export function forecastProjectionChart(observedPrice, forecasts = [], currency = 'USD', options = {}) {
  const localMode = options.mode === 'local-scenario';
  const sourcePrefix = localMode ? 'locally recorded' : 'approved';
  const ariaLabel = localMode
    ? 'Your scenario projection with recorded values and a marked present-date boundary'
    : 'Approved forecast projection with observed history and a marked present-date boundary';
  const observed = finiteNonNegative(observedPrice);
  const candidates = (Array.isArray(forecasts) ? forecasts : Object.values(forecasts || []))
    .map((forecast) => ({
      horizon: Number(forecast?.horizon),
      q10: finiteNonNegative(forecast?.q10),
      q25: finiteNonNegative(forecast?.q25),
      q50: finiteNonNegative(forecast?.q50),
      q75: finiteNonNegative(forecast?.q75),
      q90: finiteNonNegative(forecast?.q90)
    }))
    .filter((forecast) => Number.isInteger(forecast.horizon) && forecast.horizon > 0
      && [forecast.q10, forecast.q25, forecast.q50, forecast.q75, forecast.q90].every((value) => value !== null)
      && forecast.q10 <= forecast.q25 && forecast.q25 <= forecast.q50
      && forecast.q50 <= forecast.q75 && forecast.q75 <= forecast.q90)
    .sort((left, right) => left.horizon - right.horizon);
  if (observed === null || !candidates.length) return '';
  const unique = [...new Map(candidates.map((forecast) => [forecast.horizon, forecast])).values()];
  const asOfCandidate = Date.parse(options.asOfDate || options.observedAt || '');
  const historyInput = (Array.isArray(options.history) ? options.history : []).map((point) => ({
    observedAt: String(point?.observedAt || point?.date || ''),
    time: Date.parse(point?.observedAt || point?.date || ''),
    price: finiteNonNegative(point?.price)
  })).filter((point) => Number.isFinite(point.time) && point.price !== null);
  const asOfTime = Number.isFinite(asOfCandidate)
    ? asOfCandidate
    : historyInput.at(-1)?.time || Date.now();
  const historical = [...new Map(historyInput
    .filter((point) => point.time < asOfTime)
    .map((point) => [Math.round((point.time - asOfTime) / 86_400_000), point]))
    .entries()].map(([day, point]) => ({ day, value: point.price, observedAt: point.observedAt }))
    .sort((left, right) => left.day - right.day).slice(-90);
  const present = { day: 0, q10: observed, q25: observed, q50: observed, q75: observed, q90: observed };
  const future = unique.map((forecast) => ({ ...forecast, day: forecast.horizon }));
  const width = 760;
  const height = 300;
  const left = 76;
  const right = 742;
  const chartTop = 18;
  const bottom = 252;
  const scaleValues = [observed, ...historical.map((point) => point.value), ...unique.flatMap((forecast) => [forecast.q10, forecast.q25, forecast.q50, forecast.q75, forecast.q90])];
  const { lower, upper } = meaningfulScale(scaleValues);
  const minimumDay = Math.min(0, ...historical.map((point) => point.day));
  const maximumDay = Math.max(...future.map((point) => point.day));
  const span = Math.max(1, maximumDay - minimumDay);
  const x = (day) => left + (((day - minimumDay) / span) * (right - left));
  const y = (value) => bottom - (((value - lower) / (upper - lower)) * (bottom - chartTop));
  const forecastPoints = [present, ...future];
  const coords = (field) => forecastPoints.map((point) => `${x(point.day).toFixed(1)},${y(point[field]).toFixed(1)}`);
  const band = (high, low) => [...coords(high), ...coords(low).reverse()].join(' ');
  const latest = future.at(-1);
  const change = observed > 0 ? ((latest.q50 - observed) / observed) * 100 : null;
  const unchanged = change !== null && Math.abs(change) < 0.05;
  const changeLabel = change === null ? '—' : unchanged ? `Unchanged ${localMode ? 'scenario' : 'outlook'}` : `${change >= 0 ? '+' : ''}${change.toFixed(1)}%`;
  const earliest = historical[0];
  const xLabels = [
    ...(earliest ? [{ x: x(earliest.day), label: shortDate(earliest.observedAt.slice(0, 10)), anchor: 'start' }] : []),
    { x: x(0), label: 'Today', anchor: earliest ? 'middle' : 'start' },
    ...future.map((point, index) => ({ x: x(point.day), label: `${point.horizon}D`, anchor: index === future.length - 1 ? 'end' : 'middle' }))
  ];
  const historyCoordinates = [...historical.map((point) => `${x(point.day).toFixed(1)},${y(point.value).toFixed(1)}`), `${x(0).toFixed(1)},${y(observed).toFixed(1)}`];
  const historySummary = historical.length
    ? `${historical.length} ${sourcePrefix} historical observation${historical.length === 1 ? '' : 's'} precede the present marker.`
    : localMode
      ? 'No earlier local value check exists; the scenario begins at the current saved value.'
      : 'No approved historical series was published; the ribbon begins at the current observation.';
  const hoverPoints = [
    ...historical.map((point) => ({ x: Number(x(point.day).toFixed(1)), y: Number(y(point.value).toFixed(1)), l: `${shortDate(point.observedAt.slice(0, 10))} — ${formatCurrency(point.value, currency)}` })),
    { x: Number(x(0).toFixed(1)), y: Number(y(observed).toFixed(1)), l: `Today — ${formatCurrency(observed, currency)}` },
    ...future.map((point) => ({ x: Number(x(point.day).toFixed(1)), y: Number(y(point.q50).toFixed(1)), l: `${point.horizon} days — median ${formatCurrency(point.q50, currency)}` }))
  ];
  return `<div class="projection-chart ${localMode ? 'local-scenario-chart' : ''}"><p class="sr-only">${escapeHTML(historySummary)} ${localMode ? 'Scenario' : 'Forecast'} values are modeled ranges, not observed history.</p><div class="chart-wrap"><svg class="trend-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${ariaLabel}" data-chart-points="${escapeAttribute(JSON.stringify(hoverPoints))}">
    <title>Observed ${escapeHTML(formatCurrency(observed, currency))}; ${latest.horizon}-day median ${escapeHTML(formatCurrency(latest.q50, currency))}; 80% interval ${escapeHTML(formatCurrency(latest.q10, currency))} to ${escapeHTML(formatCurrency(latest.q90, currency))}</title>
    ${axisMarkup({ lower, upper, currency, left, right, y, xLabels })}
    ${historical.length ? `<polyline points="${historyCoordinates.join(' ')}" class="chart-line forecast-history"/>` : ''}
    <line x1="${x(0).toFixed(1)}" y1="${chartTop}" x2="${x(0).toFixed(1)}" y2="${bottom}" class="forecast-present"/>
    <polygon points="${band('q90', 'q10')}" class="forecast-band forecast-band-80"/>
    <polygon points="${band('q75', 'q25')}" class="forecast-band forecast-band-50"/>
    <polyline points="${coords('q50').join(' ')}" class="chart-line forecast-median"/>
    ${forecastPoints.map((point) => `<circle cx="${x(point.day).toFixed(1)}" cy="${y(point.q50).toFixed(1)}" r="4.5" class="chart-point forecast-point"/>`).join('')}
  </svg></div><div class="projection-summary"><span>${localMode ? 'Saved value now' : 'Observed now'} <strong>${escapeHTML(formatCurrency(observed, currency))}</strong></span><span>${latest.horizon}D modeled${localMode ? ' scenario' : ''} median <strong>${escapeHTML(formatCurrency(latest.q50, currency))}</strong></span><strong class="${change === null ? '' : change >= 0 ? 'positive' : 'negative'}">${escapeHTML(changeLabel)}</strong></div><div class="chart-legend">${historical.length ? `<span><i class="forecast-history-dot"></i>${localMode ? 'Local value checks' : 'Observed history'}</span>` : ''}<span><i class="forecast-present-dot"></i>Present boundary</span><span><i class="forecast-median-dot"></i>Modeled${localMode ? ' scenario' : ''} median</span><span><i class="forecast-band-50-dot"></i>50% range</span><span><i class="forecast-band-80-dot"></i>80% range</span></div></div>`;
}

export function allocationChart(allocation = {}) {
  const entries = Object.entries(allocation).filter(([, value]) => value > 0);
  const total = entries.reduce((sum, [, value]) => sum + value, 0);
  if (!total) return '<p class="muted">Add a valued item to see allocation.</p>';
  let offset = 0;
  const colors = ['#82e8ad', '#78b9ff', '#ffca6d', '#c997ff', '#ff8297', '#72ded5'];
  const segments = entries.map(([label, value], index) => {
    const percent = value / total;
    const start = offset;
    offset += percent;
    return `<circle r="54" cx="64" cy="64" pathLength="1" stroke="${colors[index % colors.length]}" stroke-dasharray="${percent} ${1 - percent}" stroke-dashoffset="${-start}"/>`;
  }).join('');
  const legend = entries.map(([label, value], index) => `<li><i style="--swatch:${colors[index % colors.length]}"></i><span>${escapeHTML(label)}</span><strong>${clamp((value / total) * 100, 0, 100).toFixed(0)}%</strong></li>`).join('');
  return `<div class="allocation"><svg viewBox="0 0 128 128" role="img" aria-label="Portfolio allocation">${segments}</svg><ul>${legend}</ul></div>`;
}

// Trajectory-v1 (T6, PRD Sec4): a dependency-free inline SVG of a published
// forecast packet's medianPath, with q10-q90 / q25-q75 whisker bands at the
// two horizons trajectory-v1 actually publishes (30d, 90d -- there is no
// continuous quantile surface between them, so the band is drawn only at
// those two checkpoints rather than interpolated). Cold-start packets and
// stale source data are called out explicitly in the returned markup
// rather than silently rendered like a standard-confidence forecast.
export function trajectoryProjectionChart(packet, currency = 'USD', { stale = false } = {}) {
  const lastKnownPrice = finiteNonNegative(packet?.lastKnownPrice);
  const lastKnownDate = String(packet?.lastKnownDate || '');
  const lastKnownTime = Date.parse(lastKnownDate);
  const path = (Array.isArray(packet?.medianPath) ? packet.medianPath : [])
    .map((point) => ({ date: String(point?.date || ''), price: finiteNonNegative(point?.price), time: Date.parse(point?.date || '') }))
    .filter((point) => point.price !== null && Number.isFinite(point.time))
    .sort((left, right) => left.time - right.time);
  if (lastKnownPrice === null || !Number.isFinite(lastKnownTime) || !path.length) {
    return '<div class="empty-chart">Not enough published data to draw a trajectory.</div>';
  }
  const isColdStart = packet.confidence === 'cold-start';
  const dayOf = (time) => Math.round((time - lastKnownTime) / 86_400_000);
  const checkpoints = [30, 90]
    .map((horizon) => ({ horizon, band: packet.horizons?.[String(horizon)] }))
    .filter(({ band }) => band && [band.q10, band.q25, band.q50, band.q75, band.q90].every((value) => finiteNonNegative(value) !== null));
  const width = 760;
  const height = 300;
  const left = 76;
  const right = 742;
  const chartTop = 18;
  const bottom = 252;
  const allValues = [
    lastKnownPrice,
    ...path.map((point) => point.price),
    ...checkpoints.flatMap(({ band }) => [band.q10, band.q90].map(Number))
  ];
  const { lower, upper } = meaningfulScale(allValues);
  const maximumDay = Math.max(0, ...path.map((point) => dayOf(point.time)), ...checkpoints.map((point) => point.horizon));
  const span = Math.max(1, maximumDay);
  const x = (day) => left + ((Math.max(0, day) / span) * (right - left));
  const y = (value) => bottom - (((value - lower) / (upper - lower)) * (bottom - chartTop));
  const pathCoordinates = [`${x(0).toFixed(1)},${y(lastKnownPrice).toFixed(1)}`, ...path.map((point) => `${x(dayOf(point.time)).toFixed(1)},${y(point.price).toFixed(1)}`)].join(' ');
  const bandMarkup = checkpoints.map(({ horizon, band }) => {
    const cx = x(horizon).toFixed(1);
    const wideTop = y(Number(band.q90)).toFixed(1);
    const wideBottom = y(Number(band.q10)).toFixed(1);
    const narrowTop = y(Number(band.q75)).toFixed(1);
    const narrowBottom = y(Number(band.q25)).toFixed(1);
    return `<line x1="${cx}" y1="${wideTop}" x2="${cx}" y2="${wideBottom}" class="trajectory-band trajectory-band-80"/><line x1="${cx}" y1="${narrowTop}" x2="${cx}" y2="${narrowBottom}" class="trajectory-band trajectory-band-50"/><circle cx="${cx}" cy="${y(Number(band.q50)).toFixed(1)}" r="4.5" class="chart-point forecast-point"/>`;
  }).join('');
  const labelIndexes = [...new Set([0, Math.floor((path.length - 1) / 2), path.length - 1])].filter((index) => index >= 0);
  const xLabels = [
    { x: x(0), label: shortDate(lastKnownDate) || 'Last known', anchor: 'start' },
    ...labelIndexes.map((index) => ({ x: x(dayOf(path[index].time)), label: shortDate(path[index].date), anchor: index === path.length - 1 ? 'end' : 'middle' }))
  ];
  const ninetyDay = checkpoints.find((point) => point.horizon === 90) || checkpoints.at(-1);
  const confidenceLabel = isColdStart ? 'Cold start estimate' : `${escapeHTML(packet.confidence || 'standard')} confidence`;
  const ariaLabel = `${isColdStart ? 'Cold start estimate' : 'Trajectory forecast'} from ${escapeHTML(formatCurrency(lastKnownPrice, currency))}${ninetyDay ? ` to a ${escapeHTML(formatCurrency(Number(ninetyDay.band.q50), currency))} 90-day median` : ''}, with a shaded uncertainty range`;
  return `<div class="projection-chart trajectory-chart ${isColdStart ? 'trajectory-cold-start' : ''}">
    <div class="trajectory-chart-labels"><span class="support-badge ${isColdStart ? 'restricted' : 'partial'}">${confidenceLabel}</span>${stale ? '<span class="support-badge unsupported">Price data may be out of date</span>' : ''}</div>
    <p class="sr-only">${isColdStart ? 'This is a cold-start estimate built without enough observed price history for this printing. Treat the range as wider and less certain than a standard forecast.' : 'Modeled trajectory, not observed history.'}</p>
    <div class="chart-wrap"><svg class="trend-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${ariaLabel}">
      <title>${ariaLabel}</title>
      ${axisMarkup({ lower, upper, currency, left, right, y, xLabels })}
      <polyline points="${pathCoordinates}" class="chart-line forecast-median"/>
      ${bandMarkup}
      <circle cx="${x(0).toFixed(1)}" cy="${y(lastKnownPrice).toFixed(1)}" r="5" class="chart-point chart-market-point"/>
    </svg></div>
    <div class="chart-legend"><span><i class="forecast-median-dot"></i>Median path</span><span><i class="forecast-band-80-dot"></i>80% range</span><span><i class="forecast-band-50-dot"></i>50% range</span></div>
  </div>`;
}
