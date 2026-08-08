import { externalImage, priceDisclosure } from '../core/components.js';
import { normalizeIntelligencePayload, trendLabel } from '../core/intelligence-contract.js';
import { catalogPriceForValuation } from '../core/pricing-policy.js';
import { forecastProjectionChart } from '../core/ui.js';
import { escapeAttribute, escapeHTML, formatCurrency, formatPercent } from '../core/utils.js';

const TIER_NAMES = ['Identity only', 'Price only', 'Trend supported', 'Fair value supported', 'Forecast supported', 'Fully evaluated'];
const POSITION_LABELS = {
  below_range: 'Below modeled range',
  within_range: 'Within modeled range',
  above_range: 'Above modeled range',
  insufficient: 'Insufficient evidence'
};

function updatedAgo(iso) {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return '';
  const hours = Math.max(0, Math.floor((Date.now() - time) / 3_600_000));
  if (hours < 1) return 'Updated within the hour';
  if (hours < 48) return `Updated ${hours}h ago`;
  return `Updated ${Math.floor(hours / 24)}d ago`;
}

export function renderPriceIntelligenceDetail(detail, state) {
  if (!detail?.catalogRef) {
    return '<section class="empty-state"><span class="empty-symbol">◇</span><h2>No card selected</h2><p>Open a card from Search, your holdings, or your watchlist.</p><button class="button" type="button" data-go="portfolio">Back to portfolio</button></section>';
  }
  const ref = detail.catalogRef;
  const currency = ref.currency || state.settings.currency || 'USD';
  const publication = ref.canonicalVariantId ? state.intelligence?.byVariant?.[ref.canonicalVariantId] : null;
  const intelligence = publication ? normalizeIntelligencePayload(publication) : null;
  const watching = state.watchlistItems.some((entry) => entry.watchKey === ref.watchKey);
  const holding = detail.holding || state.holdings.find((entry) => entry.canonicalVariantId && entry.canonicalVariantId === ref.canonicalVariantId) || null;

  return `<header class="page-header"><div><p class="eyebrow">Card detail</p><h1>${escapeHTML(ref.name)}</h1><p class="lede">${escapeHTML([ref.setName, ref.number, ref.rarity].filter(Boolean).join(' · ') || 'Custom catalog entry')}</p></div><button class="button ghost" type="button" data-action="close-detail">← Back</button></header>
    ${headerCard(detail, ref, intelligence, holding, watching, currency, state)}
    ${intelligence ? intelligenceSections(intelligence, currency) : unsupportedSection(ref, state)}
    ${predictionHistorySection()}
    ${intelligence ? attributionFootnote(intelligence) : ''}`;
}

function headerCard(detail, ref, intelligence, holding, watching, currency, state) {
  const observed = intelligence?.observed || null;
  const catalogPrice = catalogPriceForValuation(ref);
  const price = observed
    ? `${formatCurrency(observed.price, observed.currency)}`
    : catalogPrice === null ? 'Price unavailable' : formatCurrency(catalogPrice, currency);
  const tier = intelligence ? intelligence.supportTier : 0;
  const tone = tier >= 4 ? 'supported' : tier >= 2 ? 'partial' : 'unsupported';
  const freshness = observed ? updatedAgo(observed.observedAt) : '';
  const identityPills = [ref.finish, ref.language?.toUpperCase(), ref.conditionClass, ref.edition !== 'standard' ? ref.edition : '']
    .filter((value) => value && value !== 'unspecified')
    .map((value) => `<span class="pill">${escapeHTML(value)}</span>`).join('');
  return `<section class="card status-card">${externalImage({ ...ref, userImage: holding?.userImage || '' }, 'holding-image', { loading: 'eager' })}<div>
      <div class="pill-row">${identityPills}<span class="pill">${escapeHTML(ref.provider)}</span></div>
      <p class="item-price">${escapeHTML(price)}</p>
      ${observed ? `<p class="price-source">${escapeHTML(observed.source || 'Approved source')}${observed.quality !== null ? ` · quality ${Math.round(observed.quality * 100)}%` : ''}${freshness ? ` · ${escapeHTML(freshness)}` : ''}</p>` : priceDisclosure(ref, currency)}
      <span class="support-badge ${tone}">Tier ${tier} · ${escapeHTML(TIER_NAMES[tier])}</span>
      ${holding ? `<p class="fine-print">In your portfolio · Qty ${holding.quantity}</p>` : ''}
      <div class="item-actions">
        <button class="button ghost small" type="button" data-action="toggle-watch" data-detail-watch="1">${watching ? '★ Watching' : '☆ Watch'}</button>
        ${holding ? '' : '<button class="button secondary small" type="button" data-action="add-from-detail">Add to portfolio</button>'}
      </div>
    </div></section>`;
}

function intelligenceSections(intelligence, fallbackCurrency) {
  const currency = intelligence.observed?.currency || fallbackCurrency;
  return `${trendSection(intelligence)}
    ${forecastSection(intelligence, currency)}
    ${fairValueSection(intelligence, currency)}
    ${scorecardSection(intelligence)}
    ${driverSection(intelligence)}`;
}

// PRD Sec 14.6. Rendered only from tier-5 publications — the contract strips
// scorecards below "Fully evaluated", so this section simply disappears for
// cards without matured, held-out prediction history.
function scorecardSection(intelligence) {
  if (!intelligence.scorecards.length) return '';
  return intelligence.scorecards.map((card) => `<section class="card"><div class="section-heading"><div><p class="eyebrow">${card.horizonDays}-day model · ${escapeHTML(card.cohort)}</p><h2>Model scorecard</h2></div></div>
    <div class="forecast-grid">
      <div><span>Matured forecasts</span><strong>${card.maturedForecasts}</strong></div>
      <div><span>Median absolute error</span><strong>${escapeHTML(formatPercent(card.medianAbsoluteErrorPct))}</strong></div>
      <div><span>Direction accuracy</span><strong>${escapeHTML(formatPercent(card.directionAccuracy * 100))}</strong></div>
      <div><span>80% interval coverage</span><strong>${escapeHTML(formatPercent(card.interval80Coverage * 100))}</strong></div>
      <div><span>No-change baseline error</span><strong>${escapeHTML(formatPercent(card.baselineErrorPct))}</strong></div>
    </div>
    <p class="fine-print">Model ${escapeHTML(card.modelVersion)}${card.lastTrained ? ` · Last trained ${escapeHTML(card.lastTrained.slice(0, 10))}` : ''} · Held-out or prospective results only.</p></section>`).join('');
}

function trendSection(intelligence) {
  if (intelligence.supportTier < 2) {
    return '<section class="card"><p class="eyebrow">Trend</p><h2>Trend not supported</h2><p class="muted">This card has an approved price but not enough permitted history for trend metrics.</p></section>';
  }
  const trend = intelligence.trend;
  const horizons = [['7D', trend.return7d], ['30D', trend.return30d], ['90D', trend.return90d], ['180D', trend.return180d], ['1Y', trend.return365d]];
  const cells = horizons.map(([label, value]) => `<div><span>${label}</span><strong class="${value === null ? '' : value >= 0 ? 'positive' : 'negative'}">${value === null ? '—' : escapeHTML(formatPercent(value * 100))}</strong></div>`).join('');
  return `<section class="card"><div class="section-heading"><div><p class="eyebrow">Trend</p><h2>${escapeHTML(trendLabel(trend.status))}</h2></div>${trend.confidence !== null ? `<span class="pill">Confidence ${Math.round(trend.confidence)}/100</span>` : ''}</div>
    <div class="forecast-grid">${cells}</div>
    <p class="fine-print">${trend.volatility !== null ? `Volatility ${escapeHTML(formatPercent(trend.volatility * 100))} · ` : ''}${trend.historyDensity !== null ? `History completeness ${Math.round(trend.historyDensity * 100)}% · ` : ''}Returns are historical movement, not a prediction. A charted price series ships once historical series enter the publication contract.</p></section>`;
}

function fairValueSection(intelligence, currency) {
  if (intelligence.supportTier < 3 || !intelligence.fairValue) {
    return '<section class="card"><p class="eyebrow">Structural fair value</p><h2>Fair value not supported</h2><p class="muted">A modeled range requires a validated cohort model and sufficient comparable-card evidence for this exact variant.</p></section>';
  }
  const fair = intelligence.fairValue;
  return `<section class="card"><div class="section-heading"><div><p class="eyebrow">Structural fair value</p><h2>${escapeHTML(POSITION_LABELS[fair.position] || 'Insufficient evidence')}</h2></div>${fair.confidence !== null ? `<span class="pill">Confidence ${Math.round(fair.confidence)}/100</span>` : ''}</div>
    <div class="forecast-grid">
      <div><span>Modeled range (10–90%)</span><strong>${escapeHTML(formatCurrency(fair.q10, currency))}–${escapeHTML(formatCurrency(fair.q90, currency))}</strong></div>
      <div><span>Modeled midpoint</span><strong>${escapeHTML(formatCurrency(fair.q50, currency))}</strong></div>
    </div>
    <p class="fine-print">A structural range describes what comparable cards usually trade around. It is not an appraisal and not a forecast.</p></section>`;
}

function forecastSection(intelligence, currency) {
  const forecasts = Object.values(intelligence.forecasts).sort((left, right) => left.horizon - right.horizon);
  if (intelligence.supportTier < 4 || !forecasts.length) {
    return '<section class="card"><p class="eyebrow">Forecast</p><h2>No forecast published</h2><p class="muted">Forecasts appear only after a rights-cleared model run passes horizon-specific baseline, leakage, and calibration gates. Unsupported cards never show a fabricated estimate.</p></section>';
  }
  const projection = forecastProjectionChart(intelligence.observed?.price, forecasts, currency)
    || '<div class="empty-chart">An approved observed price is required before ranges can be anchored on a graph.</div>';
  return `<section class="card forecast-card product-outlook-card"><div class="section-heading"><div><p class="eyebrow">Approved outlook</p><h2>Observed price to modeled range</h2><p class="muted">Historical trend evidence and approved forecasts stay separate; this graph connects only published observations and model outputs.</p></div><span class="support-badge supported">Tier ${intelligence.supportTier}</span></div>${projection}<div class="forecast-horizon-list">${forecasts.map((forecast) => `<section class="forecast-horizon"><div class="form-section-heading"><div><p class="eyebrow">${forecast.horizon}-day outlook</p><h3>${escapeHTML(formatCurrency(forecast.q50, currency))} median</h3></div>${forecast.confidence !== null ? `<span class="pill">Confidence ${Math.round(forecast.confidence)}/100</span>` : ''}</div><div class="forecast-grid"><div><span>50% range</span><strong>${escapeHTML(formatCurrency(forecast.q25, currency))}–${escapeHTML(formatCurrency(forecast.q75, currency))}</strong></div><div><span>80% range</span><strong>${escapeHTML(formatCurrency(forecast.q10, currency))}–${escapeHTML(formatCurrency(forecast.q90, currency))}</strong></div><div><span>Probability of gain</span><strong>${forecast.probabilityUp === null ? '—' : `${Math.round(forecast.probabilityUp * 100)}%`}</strong></div></div><p class="fine-print">Origin ${escapeHTML(forecast.origin || 'not disclosed')} · Matures ${escapeHTML(forecast.maturesAt || 'not disclosed')} · Model ${escapeHTML(forecast.modelVersion || 'not disclosed')} · An existing forecast is never rewritten.</p></section>`).join('')}</div></section>`;
}

function driverSection(intelligence) {
  const { supporting, limiting } = intelligence.drivers;
  if (!supporting.length && !limiting.length) {
    return '<section class="card"><p class="eyebrow">Why this estimate?</p><h2>No recorded driver evidence</h2><p class="muted">Driver explanations are generated only from recorded feature contributions or declared rules — never invented. None were published with this card.</p></section>';
  }
  const list = (title, entries, sign) => entries.length
    ? `<div><p class="metric-label">${title}</p><ul class="evidence-list">${entries.map((entry) => `<li>${sign} ${escapeHTML(entry)}</li>`).join('')}</ul></div>`
    : '';
  return `<section class="card"><p class="eyebrow">Why this estimate?</p><h2>Recorded drivers</h2>
    ${list('Supporting factors', supporting, '+')}
    ${list('Limiting factors', limiting, '−')}
    <p class="fine-print">Drivers reflect recorded model feature contributions, shown in collector-friendly language.</p></section>`;
}

function unsupportedSection(ref, state) {
  const reasons = [];
  if (!ref.canonicalVariantId) {
    reasons.push(ref.mappingStatus === 'source_exact'
      ? 'Exact source identity known, but the canonical catalog mapping has not been operator-approved yet.'
      : 'This card has identity information only; an exact catalog mapping is required first.');
  } else if (!state.featureFlags?.publicPriceIntelligence) {
    reasons.push('Public price intelligence is disabled until source rights, mapping, and model validation gates pass.');
  } else {
    reasons.push('No approved intelligence publication exists for this exact variant yet.');
  }
  return `<section class="card intelligence-gate" role="status"><span class="support-badge unsupported">Tier 0 · Identity only</span>
    <h2>Why intelligence is unavailable</h2>
    <ul class="evidence-list">${reasons.map((reason) => `<li>${escapeHTML(reason)}</li>`).join('')}</ul>
    <p class="muted">You can still watch this exact printing and record a manual value on a holding. Nothing here is a fabricated estimate.</p></section>`;
}

function predictionHistorySection() {
  return '<section class="card"><p class="eyebrow">Prediction history</p><h2>Not yet available</h2><p class="muted">Once forecasting launches, every forecast becomes an immutable record evaluated automatically at maturity, and its history appears here.</p></section>';
}

function attributionFootnote(intelligence) {
  const sources = intelligence.sourceAttributions.map((entry) => entry.attribution || entry.name).filter(Boolean);
  const published = intelligence.publishedAt ? `Published ${escapeHTML(intelligence.publishedAt.slice(0, 10))}` : '';
  if (!sources.length && !published) return '';
  return `<p class="fine-print">${[sources.length ? `Sources: ${sources.map((source) => escapeHTML(source)).join(' · ')}` : '', published].filter(Boolean).join(' · ')}</p>`;
}
