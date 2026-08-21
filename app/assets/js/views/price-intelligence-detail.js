import { externalImage } from '../core/components.js';
import { holdingCostBasis, holdingCostCurrency, holdingMarketCurrency, holdingMarketValue, holdingPricingStatus } from '../core/calculations.js';
import { normalizeIntelligencePayload, trendLabel } from '../core/intelligence-contract.js';
import { catalogPriceForValuation } from '../core/pricing-policy.js';
import { buildHoldingLocalScenario } from '../core/local-scenarios.js';
import { forecastProjectionChart } from '../core/ui.js';
import { HISTORY_CHART_RANGES, historyLineChart, normalizeHistoryPoints } from '../core/history-chart.js';
import { escapeAttribute, escapeHTML, formatCurrency, formatPercent } from '../core/utils.js';
import { isTrajectoryStale, trajectoryKeyForItem } from '../services/forecast-trajectory.js';
import { historyKeyForItem } from '../services/history-trajectory.js';
import {
  expectedMarketSeriesKey,
  holdingMarketSeriesIdentity,
  selectPublicationForCatalogItem,
  selectPublicationForHolding,
  selectPublicationForWatchlist
} from '../core/market-series.js';
import { findWatchedItem } from '../services/watchlist.js';

const COVERAGE_NAMES = ['Card identified; pricing pending', 'Current market price', 'Market history available', 'Modeled value available', 'Forecast available', 'Forecast fully evaluated'];
const POSITION_LABELS = {
  below_range: 'Below modeled range',
  within_range: 'Within modeled range',
  above_range: 'Above modeled range',
  insufficient: 'Insufficient evidence'
};

// ---------------------------------------------------------------------------
// Full-attribute surfacing (catalog-v2 B4)
//
// normalizeTCGCSVProduct() (services/providers/tcgcsv.js) preserves the
// *complete* upstream TCGCSV record on every catalog item: every
// extendedData attribute the category carries (number, rarity, card text,
// HP, stage, attacks, ...), every price subtype with all five TCGPlayer
// price fields (market/mid/low/high/directLow), and group/category
// identity (categoryId/groupId/productId, category + set names). None of
// that is ever discarded on the way here -- it rides on `detail.item`
// (the raw normalized item) right alongside the narrower `catalogRef`
// (core/catalog-identity.js) that this view otherwise renders from, which
// intentionally curates its return shape for watch-key identity and does
// not carry the full record. `allAttributesSection()` below reads from
// `detail.item`, never `catalogRef`, so nothing here can regress if
// catalogRef's shape changes.
//
// B2 enrichment (applyEnrichmentToItem, services/catalog-enrichment.js)
// only ever overwrites `image`/`imageSmall` and adds a separate
// `enrichment` object -- it never touches extendedData, priceOptions, or
// group/category identity. So every field this section renders is native
// TCGCSV data; there is no collision with provider-sourced enrichment,
// which stays confined to its own "Image and details enriched from ..."
// note in the header above.
//
// ATTRIBUTE_VISIBILITY is a *display* decision only, never a data one:
// every attribute the dataset carries is always present on the item and
// always rendered somewhere on this page. Attribute names already
// surfaced by the curated header/metadata UI (see headerCard() below) are
// keyed here as 'shown' so the "All attributes" disclosure does not
// repeat them; every other extendedData attribute name defaults to
// 'collapsed' and appears only inside that disclosure, closed by default.
// To promote an attribute into the always-visible curated set, add its
// normalized name here as 'shown' -- the underlying data never changes.
const ATTRIBUTE_VISIBILITY = Object.freeze({
  number: 'shown',
  'card number': 'shown',
  rarity: 'shown'
});

function attributeVisibility(name) {
  const key = String(name || '').trim().toLowerCase();
  return ATTRIBUTE_VISIBILITY[key] === 'shown' ? 'shown' : 'collapsed';
}

const TCGCSV_PRICE_FIELDS = Object.freeze([
  ['marketPrice', 'Market'],
  ['midPrice', 'Mid'],
  ['lowPrice', 'Low'],
  ['highPrice', 'High'],
  ['directLowPrice', 'Direct low']
]);

function priceSubtypeRows(priceOptions, currency) {
  return priceOptions.flatMap((option) => TCGCSV_PRICE_FIELDS.map(([field, label]) => {
    const value = option?.[field];
    if (value === null || value === undefined) return '';
    return `<div><dt>${escapeHTML(option.finish || 'Unspecified')} &middot; ${escapeHTML(label)}</dt><dd>${escapeHTML(formatCurrency(value, currency))}</dd></div>`;
  })).filter(Boolean).join('');
}

// Renders the complete TCGCSV record (every extendedData attribute not
// already promoted into the curated UI, every price subtype/field, and
// group/category identity) in a collapsed-by-default disclosure. See the
// comment block above for the data-flow and visibility-config rationale.
function allAttributesSection(item, ref, currency) {
  if (!item || item.provider !== 'tcgcsv') return '';
  const extendedData = Array.isArray(item.extendedData) ? item.extendedData : [];
  const collapsedAttributes = extendedData.filter((entry) => {
    const value = entry?.value;
    return value !== null && value !== undefined && String(value) !== ''
      && attributeVisibility(entry?.displayName || entry?.name) === 'collapsed';
  });
  const priceOptions = Array.isArray(item.priceOptions) ? item.priceOptions : [];
  const identityRows = [
    ['Category', item.tcgcsvCategory?.displayName || item.tcgcsvCategory?.name || ref.game],
    ['Set / group', item.tcgcsvGroup?.name || ref.setName],
    ['Category ID', item.categoryId],
    ['Group ID', item.groupId],
    ['Product ID', item.productId]
  ].filter(([, value]) => value !== null && value !== undefined && value !== '');
  const attributeMarkup = collapsedAttributes
    .map((entry) => `<div><dt>${escapeHTML(entry.displayName || entry.name || 'Attribute')}</dt><dd>${escapeHTML(String(entry.value))}</dd></div>`)
    .join('');
  const priceMarkup = priceSubtypeRows(priceOptions, currency);
  const identityMarkup = identityRows
    .map(([label, value]) => `<div><dt>${escapeHTML(label)}</dt><dd>${escapeHTML(String(value))}</dd></div>`)
    .join('');
  if (!attributeMarkup && !priceMarkup && !identityMarkup) return '';
  return `<details class="data-details" id="detail-attributes"><summary><span>All attributes</span><span>Full catalog record for this printing</span></summary><div>${identityMarkup ? `<p class="fine-print">Group &amp; category identity</p><dl>${identityMarkup}</dl>` : ''}${attributeMarkup ? `<p class="fine-print">Card attributes</p><dl>${attributeMarkup}</dl>` : ''}${priceMarkup ? `<p class="fine-print">Price subtypes (all fields)</p><dl>${priceMarkup}</dl>` : ''}</div></details>`;
}

function updatedAgo(iso) {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return '';
  const hours = Math.max(0, Math.floor((Date.now() - time) / 3_600_000));
  if (hours < 1) return 'Updated within the hour';
  if (hours < 48) return `Updated ${hours}h ago`;
  return `Updated ${Math.floor(hours / 24)}d ago`;
}

function uniqueHoldingForReference(holdings = [], ref = {}, currency = 'USD') {
  const candidates = holdings.filter((entry) => entry.canonicalVariantId
    && String(entry.canonicalVariantId).toLowerCase() === String(ref.canonicalVariantId || '').toLowerCase());
  if (!ref.marketCondition) return candidates.length === 1 ? candidates[0] : null;
  const expected = expectedMarketSeriesKey(ref.canonicalVariantId, {
    currency,
    language: ref.language,
    finish: ref.finish,
    conditionClass: ref.conditionClass,
    marketCondition: ref.marketCondition
  });
  const exact = candidates.filter((entry) => expected
    && expectedMarketSeriesKey(entry.canonicalVariantId, holdingMarketSeriesIdentity(entry, currency)) === expected);
  return exact.length === 1 ? exact[0] : null;
}

export function renderPriceIntelligenceDetail(detail, state) {
  if (!detail?.catalogRef) {
    if (detail?.loading) return '<section class="empty-state" role="status"><span class="empty-symbol">◇</span><h2>Opening shared card…</h2><p>Checking the linked catalog provider.</p></section>';
    const message = detail?.error || 'Open an item from Discover, Collection, or Watchlist.';
    return `<section class="empty-state"><span class="empty-symbol">◇</span><h2>${detail?.error ? 'Shared item unavailable' : 'No item selected'}</h2><p>${escapeHTML(message)}</p><button class="button" type="button" data-go="${detail?.error ? 'search' : 'portfolio'}">${detail?.error ? 'Find an item' : 'Back to Collection'}</button></section>`;
  }
  const ref = detail.catalogRef;
  const currency = ref.currency || state.settings.currency || 'USD';
  const rawPublication = ref.canonicalVariantId ? state.intelligence?.byVariant?.[ref.canonicalVariantId] : null;
  const holding = detail.holding || uniqueHoldingForReference(state.holdings, ref, currency);
  const watchedEntry = findWatchedItem(state.watchlistItems, ref, {
    canonicalVariantId: ref.canonicalVariantId,
    conditionClass: ref.conditionClass,
    marketCondition: ref.marketCondition || detail.watched?.marketCondition
  });
  const publication = holding
    ? selectPublicationForHolding(rawPublication, holding, currency)
    : watchedEntry
      ? selectPublicationForWatchlist(rawPublication, watchedEntry, currency)
      : selectPublicationForCatalogItem(rawPublication, ref, currency);
  const intelligence = publication ? normalizeIntelligencePayload(publication) : null;
  const scenarioHorizon = [7, 30, 90, 180, 365].includes(Number(state.settings?.defaultForecastHorizon))
    ? Number(state.settings.defaultForecastHorizon)
    : 90;
  const localScenario = holding
    ? buildHoldingLocalScenario(holding, state.localValueObservations || [], scenarioHorizon)
    : null;
  // Trajectory-v1 (T6): only ever a fallback when there is no cloud-$
  // published forecast to defer to (see forecastSection/unsupportedSection
  // above, which only use this when their own "no forecast" branch fires).
  const trajectoryItem = holding?.item || detail.item || null;
  const trajectorySectionId = localScenario && ['early', 'limited', 'available'].includes(localScenario.status)
    ? 'detail-published-forecast'
    : 'detail-forecast';
  const trajectoryMarkup = trajectorySection(trajectoryItem, state, trajectorySectionId);
  const historyMarkup = historySection(trajectoryItem, state);

  return `<div class="detail-back"><button class="button ghost small" type="button" data-action="close-detail">← Back</button><span>Item detail</span></div>
    ${headerCard(detail, ref, intelligence, holding, Boolean(watchedEntry), currency, state, localScenario, watchedEntry?.watchKey)}
    ${ownershipActionBar(ref, intelligence, holding, Boolean(watchedEntry), currency, watchedEntry?.watchKey)}
    <nav class="detail-tabs" aria-label="Item detail sections"><a href="#detail-overview">Overview</a><a href="#detail-market">Market</a><a href="#detail-forecast">Outlook</a><a href="#detail-sales">Sales</a><a href="#detail-data">Data</a></nav>
    <div class="detail-sections">${localScenarioSection(holding, localScenario)}${intelligence ? intelligenceSections(intelligence, currency, Boolean(localScenario), trajectoryMarkup) : unsupportedSection(ref, state, Boolean(localScenario), trajectoryMarkup)}
    ${historyMarkup || priceHistoryPendingSection()}
    ${salesSection(ref)}
    ${dataDetailsSection(ref, intelligence)}
    ${allAttributesSection(detail.item, ref, currency)}
    ${intelligence ? attributionFootnote(intelligence) : ''}</div>`;
}

function recordedCost(holding) {
  return holding && [holding.purchasePrice, holding.fees].some((value) => value !== '' && value !== null && value !== undefined && Number.isFinite(Number(value)));
}

function humanizeType(value, fallback = 'Not specified') {
  const text = String(value || '').trim().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ');
  return text ? text.replace(/\b\w/g, (letter) => letter.toUpperCase()) : fallback;
}

function typeAwareMetadata(item, ref, holding) {
  const rawFormat = item?.productFormat || item?.format || item?.subTypeName || ref.productFormat || ref.finish || '';
  const sealed = ref.conditionClass === 'sealed' || /\b(pack|box|case|bundle|display|sealed|tin)\b/i.test(rawFormat);
  const graded = Boolean(holding?.grade) || ref.conditionClass === 'graded';
  const type = sealed ? 'Sealed product' : graded ? 'Graded collectible' : /comic/i.test(item?.category || ref.category) ? 'Comic' : 'Trading card';
  const format = sealed ? humanizeType(rawFormat, 'Sealed product') : humanizeType(item?.productFormat || item?.format, 'Single card');
  const condition = sealed
    ? (/sealed/i.test(holding?.condition || item?.condition || '') ? 'Factory sealed' : 'Unconfirmed')
    : graded ? (holding?.grade ? `${holding.gradeCompany || 'Graded'} ${holding.grade}` : 'Graded')
      : holding?.condition || ref.marketCondition || 'Unconfirmed';
  return [
    ['Type', type], ['Format', format], ['Condition', condition], ['Language', item?.language || holding?.item?.language || 'Not specified'],
    ['Edition', humanizeType(ref.edition, 'Standard')], ['Set', ref.setName || 'Not specified']
  ];
}

function detailPriceModel(ref, intelligence, holding, currency) {
  const manual = holding?.manualMarketPrice !== '' && holding?.manualMarketPrice !== null && holding?.manualMarketPrice !== undefined
    && Number.isFinite(Number(holding.manualMarketPrice));
  if (manual) return {
    label: 'Manual current value', display: formatCurrency(Number(holding.manualMarketPrice), holdingMarketCurrency(holding)),
    status: `Your saved value${updatedAgo(holding.updatedAt || holding.createdAt) ? ` · ${updatedAgo(holding.updatedAt || holding.createdAt)}` : ''}`,
    confidence: 'Manual value · not a market observation', tone: 'partial'
  };
  const observed = intelligence?.observed || null;
  if (observed) return {
    label: 'Current market value', display: formatCurrency(observed.price, observed.currency),
    status: `${observed.source || 'Approved source'}${updatedAgo(observed.observedAt) ? ` · ${updatedAgo(observed.observedAt)}` : ''}`,
    confidence: COVERAGE_NAMES[intelligence.supportTier] || 'Approved market evidence', tone: intelligence.supportTier >= 4 ? 'supported' : 'partial'
  };
  const catalogPrice = catalogPriceForValuation(ref);
  if (catalogPrice !== null) return {
    label: 'Current catalog value', display: formatCurrency(catalogPrice, currency),
    status: `${ref.priceSource || 'Permitted catalog value'}${ref.priceUpdatedAt && updatedAgo(ref.priceUpdatedAt) ? ` · ${updatedAgo(ref.priceUpdatedAt)}` : ''}`,
    confidence: 'Catalog price · market history pending', tone: 'partial'
  };
  return { label: 'Current value', display: 'Unpriced', status: 'No verified current value is available.', confidence: 'No verified market price', tone: 'unsupported' };
}

function headerCard(detail, ref, intelligence, holding, watching, currency, state, localScenario) {
  const price = detailPriceModel(ref, intelligence, holding, currency);
  const identityPills = [ref.finish, (detail.item?.language || holding?.item?.language) ? ref.language?.toUpperCase() : '', ref.edition !== 'standard' ? ref.edition : '']
    .filter((value) => value && value !== 'unspecified')
    .map((value) => `<span class="pill">${escapeHTML(value)}</span>`).join('');
  const holdingValue = holding ? holdingMarketValue(holding) : 0;
  const holdingValueCurrency = holding ? holdingMarketCurrency(holding) : currency;
  const holdingCostCurrencyCode = holding ? holdingCostCurrency(holding) : currency;
  const imageAvailable = Boolean(ref.image || ref.imageSmall || holding?.userImage);
  const imageMarkup = externalImage({ ...ref, userImage: holding?.userImage || '' }, 'detail-image', { loading: 'eager' });
  const media = imageAvailable
    ? `<button class="detail-image-frame" type="button" data-action="zoom-detail-image" aria-label="Enlarge image of ${escapeAttribute(ref.name || 'collectible')}">${imageMarkup}<span class="sr-only">Open image zoom</span></button>`
    : `<div class="detail-image-frame">${imageMarkup}</div><span class="fine-print">No verified artwork is available.</span>`;
  const localAvailable = ['early', 'limited', 'available'].includes(localScenario?.status);
  const outlookPanel = localAvailable
    ? `<div class="scenario"><span>Your scenario</span><strong>${escapeHTML(formatCurrency(localScenario.q25, localScenario.currency))}–${escapeHTML(formatCurrency(localScenario.q75, localScenario.currency))}</strong><small>${localScenario.horizon}-day range · ${localScenario.status === 'available' ? 'Moderate' : 'Limited'} evidence</small></div>`
    : intelligence?.supportTier >= 4 && Object.keys(intelligence.forecasts).length
      ? `<div class="forecast"><span>Published forecast</span><strong>${Object.keys(intelligence.forecasts).length} horizon${Object.keys(intelligence.forecasts).length === 1 ? '' : 's'}</strong><small>Approved ranges below</small></div>`
      : '';
  const movement = intelligence?.supportTier >= 2 && intelligence.trend.return30d !== null
    ? `<div><span>30-day movement</span><strong class="${intelligence.trend.return30d >= 0 ? 'positive' : 'negative'}"><span aria-hidden="true">${intelligence.trend.return30d >= 0 ? '↗' : '↘'}</span> ${escapeHTML(formatPercent(Math.abs(intelligence.trend.return30d) * 100))}</strong><small>${escapeHTML(trendLabel(intelligence.trend.status))}</small></div>`
    : '<p class="detail-market-unavailable">30-day movement will appear after additional verified updates.</p>';
  const metadata = typeAwareMetadata(detail.item || ref, ref, holding)
    .map(([label, value]) => `<div><dt>${escapeHTML(label)}</dt><dd>${escapeHTML(value)}</dd></div>`).join('');
  const pricingStatus = holding ? holdingPricingStatus(holding) : 'unpriced';
  const holdingSection = holding
    ? `<section class="detail-holding"><div><span>Your collection</span><strong>${escapeHTML(String(holding.quantity || 0))} owned</strong></div><dl><div><dt>Current value</dt><dd>${pricingStatus === 'unpriced' ? 'Unpriced' : escapeHTML(formatCurrency(holdingValue, holdingValueCurrency))}${pricingStatus === 'manual' ? ' · Manual' : ''}</dd></div><div><dt>Cost basis</dt><dd>${recordedCost(holding) ? escapeHTML(formatCurrency(holdingCostBasis(holding), holdingCostCurrencyCode)) : 'Not recorded'}</dd></div></dl>${holdingValueCurrency !== holdingCostCurrencyCode ? `<p class="fine-print">${escapeHTML(holdingValueCurrency)} value and ${escapeHTML(holdingCostCurrencyCode)} cost are kept separate; no exchange rate was guessed.</p>` : ''}${holding.notes ? `<p>${escapeHTML(holding.notes)}</p>` : ''}</section>`
    : '<p class="detail-not-owned">Not in your collection yet. Add this exact item without leaving the page.</p>';
  return `<section class="detail-product" id="detail-overview"><div class="detail-media">${media}</div><div class="detail-identity"><p class="eyebrow">${escapeHTML(ref.setName || 'Collectible')}</p><h1>${escapeHTML(ref.name || 'Unnamed collectible')}</h1>${ref.enrichment ? `<p class="fine-print detail-enrichment-note">Image and details enriched from ${escapeHTML(ref.enrichment.provider)}${ref.enrichment.rarity && ref.enrichment.rarity !== ref.rarity ? ` &middot; ${escapeHTML(ref.enrichment.rarity)}` : ''}</p>` : ''}<p class="detail-subtitle">${escapeHTML([ref.setName, ref.number ? `#${ref.number}` : '', ref.rarity].filter(Boolean).join(' · ') || 'Custom catalog entry')}</p><div class="detail-identity-pills">${identityPills || '<span>Variant not specified</span>'}</div><button class="button ghost small" type="button" data-action="share-detail">Share item</button></div><aside class="detail-market-panel"><div><span>${escapeHTML(price.label)}</span><strong>${escapeHTML(price.display)}</strong><small>${escapeHTML(price.status)}</small><span class="support-badge ${escapeAttribute(price.tone)}">${escapeHTML(price.confidence)}</span></div>${movement}${outlookPanel}</aside><div class="detail-secondary"><dl class="detail-metadata">${metadata}</dl>${holdingSection}</div></section>`;
}

function ownershipActionBar(ref, intelligence, holding, watching, currency, watchedKey = '') {
  const price = detailPriceModel(ref, intelligence, holding, currency);
  const actions = holding
    ? `<button class="button" type="button" data-action="edit-holding" data-id="${escapeAttribute(holding.id)}">Update quantity</button><button class="button secondary" type="button" data-action="edit-holding" data-id="${escapeAttribute(holding.id)}">Edit purchase</button><button class="button ghost" type="button" data-action="view-detail-purchases">View purchases</button>`
    : '<button class="button" type="button" data-action="add-from-detail">Add to collection</button>';
  return `<section class="detail-action-bar" aria-label="Item actions"><div><span>${escapeHTML(price.label)}</span><strong>${escapeHTML(price.display)}</strong></div><div>${actions}<button class="button secondary" type="button" data-action="toggle-watch" data-detail-watch="1">${watching ? 'Watching' : 'Watch'}</button>${watching && watchedKey ? `<button class="button ghost" type="button" data-action="toggle-compare" data-watch-key="${escapeAttribute(watchedKey)}">Compare</button>` : ''}</div></section>`;
}

function intelligenceSections(intelligence, fallbackCurrency, hasLocalScenario = false, trajectoryMarkup = '') {
  const currency = intelligence.observed?.currency || fallbackCurrency;
  return `${trendSection(intelligence)}
    ${forecastSection(intelligence, currency, hasLocalScenario, trajectoryMarkup)}
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
    return '<section class="card" id="detail-market"><p class="eyebrow">Market movement</p><h2>Trend not supported</h2><p class="muted">This card has an approved price but not enough permitted history for trend metrics.</p></section>';
  }
  const trend = intelligence.trend;
  const horizons = [['7D', trend.return7d], ['30D', trend.return30d], ['90D', trend.return90d], ['180D', trend.return180d], ['1Y', trend.return365d]];
  const cells = horizons.map(([label, value]) => `<div><span>${label}</span><strong class="${value === null ? '' : value >= 0 ? 'positive' : 'negative'}">${value === null ? '—' : escapeHTML(formatPercent(value * 100))}</strong></div>`).join('');
  const historySummary = intelligence.history.length
    ? `${intelligence.history.length} final approved price point${intelligence.history.length === 1 ? '' : 's'} are available for this exact market series.`
    : 'Raw chart history was not published for this source; derived returns may still be permitted.';
  return `<section class="card" id="detail-market"><div class="section-heading"><div><p class="eyebrow">Market movement</p><h2>${escapeHTML(trendLabel(trend.status))}</h2></div>${trend.confidence !== null ? `<span class="pill">Confidence ${Math.round(trend.confidence)}/100</span>` : ''}</div>
    <div class="forecast-grid">${cells}</div>
    <p class="fine-print">${trend.volatility !== null ? `Volatility ${escapeHTML(formatPercent(trend.volatility * 100))} · ` : ''}${trend.historyDensity !== null ? `History completeness ${Math.round(trend.historyDensity * 100)}% · ` : ''}Returns are historical movement, not a prediction. ${escapeHTML(historySummary)}</p></section>`;
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

function forecastSection(intelligence, currency, hasLocalScenario = false, trajectoryMarkup = '') {
  const sectionId = hasLocalScenario ? 'detail-published-forecast' : 'detail-forecast';
  const forecasts = Object.values(intelligence.forecasts).sort((left, right) => left.horizon - right.horizon);
  if (intelligence.supportTier < 4 || !forecasts.length) {
    if (trajectoryMarkup) return trajectoryMarkup;
    return `<section class="card" id="${sectionId}"><p class="eyebrow">Published market forecast</p><h2>No forecast published</h2><p class="muted">Published forecasts appear only after a rights-cleared model run passes horizon-specific evidence checks. Your scenario remains separate above.</p></section>`;
  }
  const projection = forecastProjectionChart(intelligence.observed?.price, forecasts, currency, {
    history: intelligence.history,
    asOfDate: intelligence.publishedAt || intelligence.observed?.observedAt
  })
    || '<div class="empty-chart">An approved observed price is required before ranges can be anchored on a graph.</div>';
  const horizons = forecasts.map((forecast) => {
    const status = forecast.forecastStatus === 'limited' ? 'Limited' : 'Available';
    const confidence = forecast.confidence === null ? 'score not disclosed' : `${Math.round(forecast.confidence)}/100`;
    const reason = forecast.confidenceReason || 'No additional confidence explanation was included in the approved publication.';
    return `<section class="forecast-horizon"><div class="form-section-heading"><div><p class="eyebrow">${forecast.horizon}-day outlook</p><h3>${escapeHTML(formatCurrency(forecast.q50, currency))} median</h3></div><span class="pill">${status} · ${confidence}</span></div><div class="forecast-grid"><div><span>50% range</span><strong>${escapeHTML(formatCurrency(forecast.q25, currency))}–${escapeHTML(formatCurrency(forecast.q75, currency))}</strong></div><div><span>80% range</span><strong>${escapeHTML(formatCurrency(forecast.q10, currency))}–${escapeHTML(formatCurrency(forecast.q90, currency))}</strong></div><div><span>Probability of gain</span><strong>${forecast.probabilityUp === null ? '—' : `${Math.round(forecast.probabilityUp * 100)}%`}</strong></div></div><p class="fine-print">Confidence: ${escapeHTML(reason)}</p><p class="fine-print">As of ${escapeHTML(intelligence.publishedAt || 'not disclosed')} · Matures ${escapeHTML(forecast.maturesAt || 'not disclosed')} · Model ${escapeHTML(forecast.modelVersion || 'not disclosed')} · An existing forecast is never rewritten.</p></section>`;
  }).join('');
  return `<section class="card forecast-card product-outlook-card" id="${sectionId}"><div class="section-heading"><div><p class="eyebrow">Approved outlook</p><h2>Observed price to modeled range</h2><p class="muted">Historical trend evidence and approved forecasts stay separate; this graph connects only published observations and model outputs.</p></div></div>${projection}<div class="forecast-horizon-list">${horizons}</div></section>`;
}

// Trajectory-v1 (T6): the detail-page analog of forecastSection, but for
// TCGCSV-identity items with no cloud-published forecast. Fail-closed
// per the manifest eligibility map -- only an explicit "published" entry
// with a resolved packet ever produces the full chart; "excluded" and
// "unknown" both collapse to the same honest "insufficient evidence"
// state (never a fabricated band, never local-scenario-v1 standing in).
function trajectorySection(item, state, sectionId) {
  const key = trajectoryKeyForItem(item || {});
  if (!key) return '';
  const entry = state.trajectoryForecasts?.byKey?.[key];
  if (!entry) return '';
  if (entry.eligibility !== 'published' || !entry.packet) {
    return `<section class="card trajectory-insufficient" id="${sectionId}"><p class="eyebrow">Published market forecast</p><h2>Insufficient evidence for a price forecast</h2><p class="muted">This printing does not yet have enough published price history to support a modeled trajectory. This is not a fabricated estimate.</p></section>`;
  }
  const packet = entry.packet;
  if (isTrajectoryStale(packet, entry.manifest?.asOf || entry.groupAsOf)) {
    return `<section class="card trajectory-insufficient" id="${sectionId}"><p class="eyebrow">Published market forecast</p><h2>A fresher market observation is required</h2><p class="muted">The last price behind this forecast is too old relative to its publication. CollectFolio withholds the modeled values instead of presenting a stale baseline as current.</p></section>`;
  }
  const isColdStart = packet.confidence === 'cold-start';
  // Serve-all-cohorts mode (Kevin 2026-08-18): low-history and
  // insufficient-history packets are served everywhere, labeled as early
  // estimates rather than presented as fully modeled trajectories.
  const isEarly = !isColdStart && ['low-history', 'insufficient-history'].includes(packet.confidence);
  const ninety = packet.horizons?.['90'];
  const thirty = packet.horizons?.['30'];
  const heading = isColdStart ? 'Cold start estimate' : isEarly ? 'Early estimate' : 'Modeled trajectory';
  const explainer = isColdStart
    ? 'Built without enough observed price history for this printing; treat the range as wider and less certain than a standard forecast.'
    : isEarly
      ? 'Built from a short observed price history for this printing; treat the range as wider and less certain than a standard forecast.'
      : 'Modeled from published price history for this exact printing.';
  const pill = isColdStart ? 'Cold start' : isEarly ? 'Early estimate' : 'Modeled';
  const horizonBlock = (horizon, band) => band ? `<section class="forecast-horizon"><div class="form-section-heading"><div><p class="eyebrow">${horizon}-day outlook</p><h3>${escapeHTML(formatCurrency(band.q50, state.settings?.currency || 'USD'))} median</h3></div><span class="pill">${pill}</span></div><div class="forecast-grid"><div><span>Range</span><strong>${escapeHTML(formatCurrency(band.q10, state.settings?.currency || 'USD'))}–${escapeHTML(formatCurrency(band.q90, state.settings?.currency || 'USD'))}</strong></div></div></section>` : '';
  return `<section class="card forecast-card product-outlook-card trajectory-section" id="${sectionId}"><div class="section-heading"><div><p class="eyebrow">Published market forecast</p><h2>${heading}</h2><p class="muted">${explainer}</p></div></div><div class="forecast-horizon-list">${horizonBlock(30, thirty)}${horizonBlock(90, ninety)}</div><p class="fine-print">Last known price date ${escapeHTML(String(packet.lastKnownDate || 'not disclosed'))}.</p></section>`;
}

// Observed weekly price history, with the latest published trajectory-v1
// estimates overlaid at their served horizons when
// available. Fail-closed and independent of trajectorySection above --
// an item with no published history object renders nothing here even if
// it has a forecast, and an item with history but no forecast still gets
// its bar chart (history-bars-only, no projection overlay).
function historySection(item, state) {
  const historyKey = historyKeyForItem(item || {});
  if (!historyKey) return '';
  const historyEntry = state.priceHistory?.byKey?.[historyKey];
  if (!historyEntry?.available || !Array.isArray(historyEntry.points)) return '';
  const validPoints = normalizeHistoryPoints(historyEntry.points);
  if (new Set(validPoints.map((point) => point.date)).size < 2) return '';
  const trajectoryKey = trajectoryKeyForItem(item || {});
  const trajectoryEntry = trajectoryKey ? state.trajectoryForecasts?.byKey?.[trajectoryKey] : null;
  const packet = trajectoryEntry?.eligibility === 'published' ? trajectoryEntry.packet : null;
  const stale = packet ? isTrajectoryStale(packet, trajectoryEntry.manifest?.asOf || trajectoryEntry.groupAsOf) : false;
  const selectedRange = HISTORY_CHART_RANGES.includes(state.priceHistory?.range) ? state.priceHistory.range : '1Y';
  const showForecast = state.priceHistory?.showForecast !== false;
  const chart = historyLineChart(
    validPoints.map((point) => [point.date, point.price]),
    packet,
    state.settings?.currency || 'USD',
    { stale, range: selectedRange, showForecast }
  );
  if (!chart) return '';
  const rangeControls = HISTORY_CHART_RANGES.map((range) => `<button type="button" data-history-range="${escapeAttribute(range)}" aria-pressed="${range === selectedRange}">${escapeHTML(range)}</button>`).join('');
  const forecastControl = packet
    ? `<button type="button" class="history-forecast-toggle" data-history-forecast aria-label="Show forecast" aria-pressed="${showForecast}"><span class="history-forecast-toggle-dot" aria-hidden="true"></span><span>Forecast</span><small aria-hidden="true">${showForecast ? 'On' : 'Off'}</small></button>`
    : '';
  const explainer = packet
    ? 'Observed weekly prices for this exact printing. Forecast shows one latest as-of path; daily hover values interpolate between weekly model checkpoints, while uncertainty is calibrated at 30 and 90 days.'
    : 'Observed weekly market prices for this exact printing, positioned on a calendar-time axis.';
  return `<section class="card history-chart-card" id="detail-history"><div class="section-heading history-chart-heading"><div><p class="eyebrow">Price timeline</p><h2>${packet ? 'Price history &amp; latest forecast' : 'Price history'}</h2><p class="muted">${explainer}</p></div></div><div class="history-chart-toolbar"><div><span class="history-chart-control-label">History range</span><div class="range-control history-range-control" role="group" aria-label="History range">${rangeControls}</div></div>${forecastControl}</div>${chart}</section>`;
}

function priceHistoryPendingSection() {
  return '<section class="card price-history-pending" id="detail-history"><p class="eyebrow">Price history</p><h2>Additional updates needed</h2><p class="muted">Price history will appear after additional verified updates.</p></section>';
}

function localScenarioSection(holding, scenario) {
  if (!holding || !scenario) return '';
  const usable = ['early', 'limited', 'available'].includes(scenario.status);
  if (!usable) return `<section class="card forecast-card local-scenario-card" id="detail-forecast"><div class="section-heading"><div><p class="eyebrow">Your scenario</p><h2>${scenario.status === 'stale' ? 'Update the saved value' : 'Add a value to start'}</h2><p class="muted">${escapeHTML(scenario.reason || 'No usable value is saved for this item.')}</p></div><span class="support-badge unsupported">Unavailable</span></div><p>${escapeHTML(scenario.nextAction || 'Edit this item to add a catalog or manual unit value.')}</p></section>`;
  const history = (scenario.history || []).filter((entry) => entry.source === scenario.source && entry.currency === scenario.currency);
  const projection = forecastProjectionChart(scenario.observed, [scenario], scenario.currency, {
    mode: 'local-scenario', history, asOfDate: scenario.observedAt
  });
  return `<section class="card forecast-card product-outlook-card local-scenario-card" id="detail-forecast"><div class="section-heading"><div><p class="eyebrow">Your scenario</p><h2>${scenario.horizon}-day range from your saved value</h2><p class="muted">Available without a published market forecast. This is a modeled scenario, not an appraisal.</p></div><span class="support-badge modeled">${scenario.status === 'available' ? 'Moderate evidence' : 'Limited evidence'}</span></div>
    <div class="actual-forecast-split"><div class="actual"><span>Saved unit value</span><strong>${escapeHTML(formatCurrency(scenario.observed, scenario.currency))}</strong><small>${escapeHTML(scenario.source === 'manual' ? 'Your estimate' : scenario.sourceLabel || 'Catalog price')} · value date ${escapeHTML((scenario.valueAsOf || scenario.observedAt).slice(0, 10))}</small></div><div class="forecast"><span>Middle 50% scenario</span><strong>${escapeHTML(formatCurrency(scenario.q25, scenario.currency))}–${escapeHTML(formatCurrency(scenario.q75, scenario.currency))}</strong><small>Midpoint ${escapeHTML(formatCurrency(scenario.q50, scenario.currency))}</small></div></div>${projection}
    <div class="forecast-grid"><div><span>Broad 80% range</span><strong>${escapeHTML(formatCurrency(scenario.q10, scenario.currency))}–${escapeHTML(formatCurrency(scenario.q90, scenario.currency))}</strong></div><div><span>Local history</span><strong>${scenario.observationCount} same-source check${scenario.observationCount === 1 ? '' : 's'}</strong></div></div>
    <p class="fine-print">${escapeHTML(scenario.confidence.detail)} Manual and catalog values never create cross-source returns. Model ${escapeHTML(scenario.modelVersion)}.</p><p class="forecast-warning">Scenario only; not a market observation, appraisal, recommendation, or guaranteed return.</p></section>`;
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

function unsupportedSection(ref, state, hasLocalScenario = false, trajectoryMarkup = '') {
  const reasons = [];
  if (!ref.canonicalVariantId) {
    reasons.push(ref.mappingStatus === 'source_exact'
      ? 'The source card is known, but exact card verification has not been approved yet.'
      : 'This card has identity information only; exact card verification is required first.');
  } else if (!state.featureFlags?.publicPriceIntelligence) {
    reasons.push('Public price intelligence is disabled until source rights, mapping, and model validation gates pass.');
  } else {
    reasons.push('No approved intelligence publication exists for this exact variant yet.');
  }
  const forecastBlock = trajectoryMarkup || `<section class="card" id="${hasLocalScenario ? 'detail-published-forecast' : 'detail-forecast'}"><p class="eyebrow">Published market forecast</p><h2>No forecast published</h2><p class="muted">${hasLocalScenario ? 'Your scenario above explains whether a modeled range is available; it remains separate from published forecasts.' : 'An unavailable published forecast never prevents collection tracking.'}</p></section>`;
  return `<section class="card pricing-unavailable" id="detail-market" role="status"><p class="eyebrow">Item identified</p><h2>Market pricing has not been verified yet.</h2><p class="muted">You can still add this item, enter a manual collection value, or watch it for future pricing.</p><details><summary>Why intelligence is unavailable</summary><ul class="evidence-list">${reasons.map((reason) => `<li>${escapeHTML(reason)}</li>`).join('')}</ul><p class="fine-print">Nothing here is a fabricated estimate.</p></details></section>${forecastBlock}`;
}

function salesSection(ref) {
  const hint = [ref.productKind, ref.productFormat, ref.conditionClass, ref.category].filter(Boolean).join(' ').toLowerCase();
  const type = /sealed|booster|box|pack|bundle|deck|tin/.test(hint)
    ? 'sealed product' : /comic|issue/.test(hint) ? 'comic issue' : /slab|graded/.test(hint) ? 'graded item' : 'raw item';
  return `<section class="card" id="detail-sales"><p class="eyebrow">Verified sales</p><h2>No exact-variant sales published</h2><p class="muted">Sales will appear only when each transaction identifies the exact collectible type and variant. This ${escapeHTML(type)} has no approved sales feed.</p></section>`;
}

function dataDetailsSection(ref, intelligence) {
  const tier = intelligence?.supportTier || 0;
  const tone = tier >= 4 ? 'supported' : tier >= 2 ? 'partial' : 'unsupported';
  const verification = ref.canonicalVariantId
    ? 'Exact card verified'
    : ref.mappingStatus === 'source_exact'
      ? 'Source card known; exact verification pending'
      : 'Exact verification pending';
  const forecasts = intelligence ? Object.values(intelligence.forecasts || {}) : [];
  const modelVersions = [...new Set([
    ...forecasts.map((forecast) => forecast.modelVersion),
    ...(intelligence?.scorecards || []).map((scorecard) => scorecard.modelVersion)
  ].filter(Boolean))];
  const observationCount = (intelligence?.history?.length || 0) + (intelligence?.observed ? 1 : 0);
  const sourceCount = new Set((intelligence?.sourceAttributions || []).map((source) => source.name || source.attribution).filter(Boolean)).size;
  return `<details class="data-details" id="detail-data"><summary><span>Data &amp; Methodology</span><span>Sources, checks, identifiers, and calculations</span></summary><div><span class="support-badge ${tone}">${escapeHTML(COVERAGE_NAMES[tier])}</span><dl><div><dt>Market source</dt><dd>${escapeHTML(ref.provider || 'Custom entry')}</dd></div><div><dt>Source reference</dt><dd>${escapeHTML(ref.externalId || 'Not available')}</dd></div><div><dt>Verification status</dt><dd>${escapeHTML(verification)}</dd></div><div><dt>Internal catalog reference</dt><dd>${escapeHTML(ref.canonicalVariantId || 'Not assigned')}</dd></div><div><dt>Model version</dt><dd>${escapeHTML(modelVersions.join(', ') || 'No model applied')}</dd></div><div><dt>Source checks</dt><dd>${sourceCount ? `${sourceCount} approved source${sourceCount === 1 ? '' : 's'}` : 'No approved modeled source coverage'}</dd></div><div><dt>Data quality</dt><dd>${observationCount} verified observation${observationCount === 1 ? '' : 's'}</dd></div><div><dt>Calculation time</dt><dd>${escapeHTML(intelligence?.publishedAt || 'No modeled calculation')}</dd></div><div><dt>Calculation method</dt><dd>Current values remain separate from manual scenarios and published forecasts. Ranges render only when their supporting evidence contract passes validation.</dd></div></dl></div></details>`;
}

function attributionFootnote(intelligence) {
  const sources = intelligence.sourceAttributions.map((entry) => entry.attribution || entry.name).filter(Boolean);
  const published = intelligence.publishedAt ? `Published ${escapeHTML(intelligence.publishedAt.slice(0, 10))}` : '';
  if (!sources.length && !published) return '';
  return `<p class="fine-print">${[sources.length ? `Sources: ${sources.map((source) => escapeHTML(source)).join(' · ')}` : '', published].filter(Boolean).join(' · ')}</p>`;
}
