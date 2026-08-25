import { externalImage } from '../core/components.js';
import { holdingCostBasis, holdingCostCurrency, holdingMarketCurrency, holdingMarketValue, holdingPricingStatus } from '../core/calculations.js';
import { normalizeIntelligencePayload, trendLabel } from '../core/intelligence-contract.js';
import { catalogPriceForValuation } from '../core/pricing-policy.js';
import { buildHoldingLocalScenario } from '../core/local-scenarios.js';
import { forecastProjectionChart } from '../core/ui.js';
import { HISTORY_CHART_RANGES, historyLineChart, normalizeHistoryPoints } from '../core/history-chart.js';
import { escapeAttribute, escapeHTML, formatCurrency, formatPercent } from '../core/utils.js';
import { methodologyDisclosure } from '../core/methodology.js';
import { CLARIFIERS, SUPPORT_BADGES } from '../core/copy.js';
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
  const trajectoryKey = trajectoryKeyForItem(trajectoryItem || {});
  const trajectoryEntry = trajectoryKey ? state.trajectoryForecasts?.byKey?.[trajectoryKey] : null;
  const localScenarioMarkup = localScenarioSection(holding, localScenario);

  // DCL-DET-01/RULE-2: trend, forecast, fair-value, scorecard, and driver
  // sections each render only with real data. When every one of them (and
  // history) is empty, a single absence line stands in for the whole
  // stack -- never a pile of individual "not supported" cards. The
  // unsupported branch (no approved publication at all) keeps its own
  // identity-status explanation, which is out of scope for this pass.
  let marketBlockMarkup;
  let marketTabRendered;
  let outlookTabRendered;
  if (intelligence) {
    const intelCurrency = intelligence.observed?.currency || currency;
    const trendMarkup = trendSection(intelligence);
    const forecastMarkup = forecastSection(intelligence, intelCurrency, Boolean(localScenario), trajectoryMarkup);
    const fairValueMarkup = fairValueSection(intelligence, intelCurrency);
    const scorecardMarkup = scorecardSection(intelligence);
    const driverMarkup = driverSection(intelligence);
    const stackMarkup = `${trendMarkup}${forecastMarkup}${fairValueMarkup}${scorecardMarkup}${driverMarkup}`;
    const anyMarketRendered = Boolean(stackMarkup) || Boolean(historyMarkup);
    marketBlockMarkup = anyMarketRendered ? stackMarkup : `<p class="detail-absence muted">More market data appears here as it's verified.</p>`;
    marketTabRendered = Boolean(trendMarkup);
    outlookTabRendered = Boolean(forecastMarkup) || Boolean(localScenarioMarkup);
  } else {
    marketBlockMarkup = unsupportedSection(ref, state, Boolean(localScenario), trajectoryMarkup);
    marketTabRendered = true;
    outlookTabRendered = true;
  }

  const navLinks = ['<a href="#detail-overview">Overview</a>'];
  if (marketTabRendered) navLinks.push('<a href="#detail-market">Market</a>');
  if (outlookTabRendered) navLinks.push('<a href="#detail-forecast">Outlook</a>');
  navLinks.push('<a href="#detail-data">Data</a>');

  return `<div class="detail-back"><button class="button ghost small" type="button" data-action="close-detail">← Back</button><span>Item detail</span></div>
    ${headerCard(detail, ref, intelligence, holding, Boolean(watchedEntry), currency, state, localScenario, watchedEntry?.watchKey)}
    ${ownershipActionBar(holding, Boolean(watchedEntry), watchedEntry?.watchKey)}
    <nav class="detail-tabs" aria-label="Item detail sections">${navLinks.join('')}</nav>
    <div class="detail-sections">${localScenarioMarkup}${marketBlockMarkup}
    ${historyMarkup}
    ${dataDetailsSection(ref, intelligence, trajectoryEntry)}
    ${allAttributesSection(detail.item, ref, currency)}
    ${methodologyDisclosure()}
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
    confidence: SUPPORT_BADGES[intelligence.supportTier] || 'Approved market evidence', tone: intelligence.supportTier >= 4 ? 'supported' : 'partial'
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
    ? `<section class="detail-holding"><div><span>Your collection</span><strong>${escapeHTML(String(holding.quantity || 0))} owned</strong></div><dl><div><dt>Current value</dt><dd>${pricingStatus === 'unpriced' ? 'Unpriced' : escapeHTML(formatCurrency(holdingValue, holdingValueCurrency))}${pricingStatus === 'manual' ? ' · Manual' : ''}</dd></div><div><dt>Cost basis</dt><dd>${recordedCost(holding) ? escapeHTML(formatCurrency(holdingCostBasis(holding), holdingCostCurrencyCode)) : 'Not recorded'}</dd></div></dl>${holdingValueCurrency !== holdingCostCurrencyCode ? `<p class="fine-print">${escapeHTML(holdingValueCurrency)} value and ${escapeHTML(holdingCostCurrencyCode)} cost are shown in their own currencies, kept separate.</p>` : ''}${holding.notes ? `<p>${escapeHTML(holding.notes)}</p>` : ''}</section>`
    : '<p class="detail-not-owned">Not in your collection yet. Add this exact item without leaving the page.</p>';
  return `<section class="detail-product" id="detail-overview"><div class="detail-media">${media}</div><div class="detail-identity"><p class="eyebrow">${escapeHTML(ref.setName || 'Collectible')}</p><h1>${escapeHTML(ref.name || 'Unnamed collectible')}</h1>${ref.enrichment ? `<p class="fine-print detail-enrichment-note">Image and details enriched from ${escapeHTML(ref.enrichment.provider)}${ref.enrichment.rarity && ref.enrichment.rarity !== ref.rarity ? ` &middot; ${escapeHTML(ref.enrichment.rarity)}` : ''}</p>` : ''}<p class="detail-subtitle">${escapeHTML([ref.setName, ref.number ? `#${ref.number}` : '', ref.rarity].filter(Boolean).join(' · ') || 'Custom catalog entry')}</p>${identityPills ? `<div class="detail-identity-pills">${identityPills}</div>` : ''}<button class="button ghost small" type="button" data-action="share-detail">Share item</button></div><aside class="detail-market-panel"><div><span>${escapeHTML(price.label)}</span><strong>${escapeHTML(price.display)}</strong><small>${escapeHTML(price.status)}</small><span class="support-badge ${escapeAttribute(price.tone)}">${escapeHTML(price.confidence)}</span></div>${movement}${outlookPanel}</aside><div class="detail-secondary"><dl class="detail-metadata">${metadata}</dl>${holdingSection}</div></section>`;
}

// DCL-DET-03: the action bar is buttons only -- the price already has a
// single owning element (the market panel in headerCard, RULE-4), so this
// bar no longer renders its own price <div>.
// DCL-DET-08: a single "Edit purchase" button -- "Update quantity" duplicated
// the same edit-holding action under a second label and is removed.
function ownershipActionBar(holding, watching, watchedKey = '') {
  const actions = holding
    ? `<button class="button" type="button" data-action="edit-holding" data-id="${escapeAttribute(holding.id)}">Edit purchase</button><button class="button ghost" type="button" data-action="view-detail-purchases">View purchases</button>`
    : '<button class="button" type="button" data-action="add-from-detail">Add to collection</button>';
  return `<section class="detail-action-bar" aria-label="Item actions"><div>${actions}<button class="button secondary" type="button" data-action="toggle-watch" data-detail-watch="1">${watching ? 'Watching' : 'Watch'}</button>${watching && watchedKey ? `<button class="button ghost" type="button" data-action="toggle-compare" data-watch-key="${escapeAttribute(watchedKey)}">Compare</button>` : ''}</div></section>`;
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
  if (intelligence.supportTier < 2) return '';
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
  if (intelligence.supportTier < 3 || !intelligence.fairValue) return '';
  const fair = intelligence.fairValue;
  return `<section class="card"><div class="section-heading"><div><p class="eyebrow">Typical market range</p><h2>${escapeHTML(POSITION_LABELS[fair.position] || 'Insufficient evidence')}</h2></div>${fair.confidence !== null ? `<span class="pill">Confidence ${Math.round(fair.confidence)}/100</span>` : ''}</div>
    <div class="forecast-grid">
      <div><span>Modeled range (10–90%)</span><strong>${escapeHTML(formatCurrency(fair.q10, currency))}–${escapeHTML(formatCurrency(fair.q90, currency))}</strong></div>
      <div><span>Modeled midpoint</span><strong>${escapeHTML(formatCurrency(fair.q50, currency))}</strong></div>
    </div>
    <p class="fine-print">A structural range describes what comparable cards usually trade around. It is not an appraisal and not a forecast.</p></section>`;
}

// DCL-DET-02: the per-horizon confidence explanation and the
// as-of/matures-at/model-version/immutability fine-print are gone from this
// visible card -- model version and forecast maturity now live once in
// dataDetailsSection, and "a forecast is never rewritten" is a Methodology
// guarantee (methodologyDisclosure), not a repeated per-card sentence.
function forecastSection(intelligence, currency, hasLocalScenario = false, trajectoryMarkup = '') {
  const sectionId = hasLocalScenario ? 'detail-published-forecast' : 'detail-forecast';
  const forecasts = Object.values(intelligence.forecasts).sort((left, right) => left.horizon - right.horizon);
  if (intelligence.supportTier < 4 || !forecasts.length) return trajectoryMarkup;
  const projection = forecastProjectionChart(intelligence.observed?.price, forecasts, currency, {
    history: intelligence.history,
    asOfDate: intelligence.publishedAt || intelligence.observed?.observedAt
  })
    || '<div class="empty-chart">An approved observed price is required before ranges can be anchored on a graph.</div>';
  const horizons = forecasts.map((forecast) => {
    const status = forecast.forecastStatus === 'limited' ? 'Limited' : 'Available';
    const confidence = forecast.confidence === null ? 'score not disclosed' : `${Math.round(forecast.confidence)}/100`;
    return `<section class="forecast-horizon"><div class="form-section-heading"><div><p class="eyebrow">${forecast.horizon}-day outlook</p><h3>${escapeHTML(formatCurrency(forecast.q50, currency))} median</h3></div><span class="pill">${status} · ${confidence}</span></div><div class="forecast-grid"><div><span>50% range</span><strong>${escapeHTML(formatCurrency(forecast.q25, currency))}–${escapeHTML(formatCurrency(forecast.q75, currency))}</strong></div><div><span>80% range</span><strong>${escapeHTML(formatCurrency(forecast.q10, currency))}–${escapeHTML(formatCurrency(forecast.q90, currency))}</strong></div><div><span>Probability of gain</span><strong>${forecast.probabilityUp === null ? '—' : `${Math.round(forecast.probabilityUp * 100)}%`}</strong></div></div></section>`;
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
    return `<section class="card trajectory-insufficient" id="${sectionId}"><p class="eyebrow">Published market forecast</p><h2>Insufficient evidence for a price forecast</h2><p class="muted">This printing does not yet have enough published price history to support a modeled trajectory.</p></section>`;
  }
  const packet = entry.packet;
  if (isTrajectoryStale(packet, entry.manifest?.asOf || entry.groupAsOf)) {
    return `<section class="card trajectory-insufficient" id="${sectionId}"><p class="eyebrow">Published market forecast</p><h2>A fresher market observation is required</h2><p class="muted">The last price behind this forecast is too old relative to its publication. CollectFolio withholds the modeled values instead of presenting a stale baseline as current.</p></section>`;
  }
  const bands = [30, 60, 90]
    .map((horizon) => [horizon, packet.horizons?.[String(horizon)]])
    .filter(([, band]) => band);
  const tiers = new Set(bands.map(([, band]) => band.evidenceTier || (packet.confidence === 'cold-start' ? 'attribute-reference' : 'range-only')));
  // DCL-DET-06: "Attribute-based reference range" heading renamed to
  // collector-facing wording.
  const heading = tiers.has('attribute-reference')
    ? 'Price range (reference only)'
    : tiers.has('range-only')
      ? 'Price ranges'
      : 'Estimated price checkpoints';
  const explainer = tiers.has('attribute-reference')
    ? 'No observed current-price anchor exists for this printing. These attribute-based ranges are reference information, not forecasts.'
    : tiers.has('range-only')
      ? 'Typical horizon movement ranges are shown without a directional price estimate.'
      : 'Each checkpoint is independently modeled from published price history for this exact printing.';
  const horizonBlock = (horizon, band) => {
    const tier = band.evidenceTier || 'range-only';
    const directional = ['category-validated', 'relative-validated'].includes(tier);
    const title = directional
      ? `${formatCurrency(band.q50, state.settings?.currency || 'USD')} estimated price`
      : `${formatCurrency(band.q10, state.settings?.currency || 'USD')}–${formatCurrency(band.q90, state.settings?.currency || 'USD')}`;
    const label = tier === 'category-validated'
      ? 'Held-out-set evidence'
      : tier === 'relative-validated'
        ? 'Trend estimate'
        : tier === 'attribute-reference'
          ? 'Reference only'
          : 'No directional estimate';
    return `<section class="forecast-horizon"><div class="form-section-heading"><div><p class="eyebrow">${horizon}-day ${directional ? 'checkpoint' : 'price range'}</p><h3>${escapeHTML(title)}</h3></div><span class="pill">${escapeHTML(label)}</span></div><div class="forecast-grid"><div><span>80% range</span><strong>${escapeHTML(formatCurrency(band.q10, state.settings?.currency || 'USD'))}–${escapeHTML(formatCurrency(band.q90, state.settings?.currency || 'USD'))}</strong></div></div></section>`;
  };
  return `<section class="card forecast-card product-outlook-card trajectory-section" id="${sectionId}"><div class="section-heading"><div><p class="eyebrow">Published market outlook</p><h2>${heading}</h2><p class="muted">${explainer}</p></div></div><div class="forecast-horizon-list">${bands.map(([horizon, band]) => horizonBlock(horizon, band)).join('')}</div><p class="fine-print">Last known price date ${escapeHTML(String(packet.lastKnownDate || 'not disclosed'))}.</p></section>`;
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
  // DCL-DET-07: the prose explainer paragraphs are deleted -- a compact
  // legend chip next to the toolbar replaces them (● observed markers,
  // plus ◇ outlook only when a forecast packet actually overlays the
  // chart).
  const legend = packet
    ? '<span class="chart-legend"><i class="legend-observed" aria-hidden="true"></i>Observed <i class="legend-outlook" aria-hidden="true"></i>Outlook</span>'
    : '<span class="chart-legend"><i class="legend-observed" aria-hidden="true"></i>Observed</span>';
  return `<section class="card history-chart-card" id="detail-history"><div class="section-heading history-chart-heading"><div><p class="eyebrow">Price timeline</p><h2>${packet ? 'Price history &amp; latest forecast' : 'Price history'}</h2></div></div><div class="history-chart-toolbar">${legend}<div><span class="history-chart-control-label">History range</span><div class="range-control history-range-control" role="group" aria-label="History range">${rangeControls}</div></div>${forecastControl}</div>${chart}</section>`;
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
    <p class="fine-print">${escapeHTML(scenario.confidence.detail)} Manual and catalog values never create cross-source returns. Model ${escapeHTML(scenario.modelVersion)}.</p><p class="forecast-warning">${escapeHTML(CLARIFIERS.scenario)}</p></section>`;
}

// DCL-DET-06: "Why this estimate? / Recorded drivers" collapses to one
// wayfinding eyebrow with a plain H2; the precise "model feature
// contributions" fine print moves into dataDetailsSection (RULE-1) instead
// of repeating here.
function driverSection(intelligence) {
  const { supporting, limiting } = intelligence.drivers;
  if (!supporting.length && !limiting.length) return '';
  const list = (title, entries, sign) => entries.length
    ? `<div><p class="metric-label">${title}</p><ul class="evidence-list">${entries.map((entry) => `<li>${sign} ${escapeHTML(entry)}</li>`).join('')}</ul></div>`
    : '';
  return `<section class="card"><p class="eyebrow">What's driving this price</p><h2>Drivers</h2>
    ${list('Supporting factors', supporting, '+')}
    ${list('Limiting factors', limiting, '−')}</section>`;
}

// DCL-DET-04: H2 drops its period ("No verified pricing yet"); the
// disclosure collapses to exactly one collector-facing reason (no-canonical
// vs. everything else, instead of three separately-worded branches); the
// "Nothing here is a fabricated estimate." line is deleted (Appendix A).
function unsupportedSection(ref, state, hasLocalScenario = false, trajectoryMarkup = '') {
  const reason = !ref.canonicalVariantId
    ? "This exact printing hasn't been price-verified yet."
    : "Pricing for this printing hasn't been verified yet.";
  const forecastBlock = trajectoryMarkup || `<section class="card" id="${hasLocalScenario ? 'detail-published-forecast' : 'detail-forecast'}"><p class="eyebrow">Published market forecast</p><h2>No forecast published</h2><p class="muted">${hasLocalScenario ? 'Your scenario above explains whether a modeled range is available; it remains separate from published forecasts.' : 'An unavailable published forecast never prevents collection tracking.'}</p></section>`;
  return `<section class="card pricing-unavailable" id="detail-market" role="status"><p class="eyebrow">Item identified</p><h2>No verified pricing yet</h2><p class="muted">You can add this item, enter a manual value, or watch it for pricing.</p><details><summary>Why there's no market data yet</summary><ul class="evidence-list"><li>${escapeHTML(reason)}</li></ul></details></section>${forecastBlock}`;
}

function dataDetailsSection(ref, intelligence, trajectoryEntry = null) {
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
  // DCL-DET-02: forecast provenance (maturity dates for a published
  // forecast, or the modeled horizon lengths behind a trajectory-v1
  // fallback) lives here now instead of repeating per-card. Trajectory
  // data only surfaces once it passed the same published+fresh gate
  // trajectorySection itself uses, so nothing here can show numbers for
  // an ineligible or stale packet that the visible card withheld.
  const maturities = forecasts
    .filter((forecast) => forecast.maturesAt)
    .map((forecast) => `${forecast.horizon}-day matures ${String(forecast.maturesAt).slice(0, 10)}`)
    .join(', ');
  const trajectoryPacket = trajectoryEntry?.eligibility === 'published' ? trajectoryEntry.packet : null;
  const trajectoryFresh = trajectoryPacket && !isTrajectoryStale(trajectoryPacket, trajectoryEntry.manifest?.asOf || trajectoryEntry.groupAsOf);
  const trajectoryHorizons = trajectoryFresh
    ? Object.entries(trajectoryPacket.horizons || {})
      .map(([horizon, band]) => `${horizon}-day tracks ${Number(band?.horizonDaysActual) || ({ 30: 28, 60: 63, 90: 91 }[Number(horizon)] || Number(horizon))} actual days`)
      .join(', ')
    : '';
  const forecastHorizonsText = maturities || trajectoryHorizons || 'No active forecast';
  return `<details class="data-details" id="detail-data"><summary><span>Data &amp; Methodology</span><span>Sources, checks, identifiers, and calculations</span></summary><div><span class="support-badge ${tone}">${escapeHTML(SUPPORT_BADGES[tier])}</span><dl><div><dt>Market source</dt><dd>${escapeHTML(ref.provider || 'Custom entry')}</dd></div><div><dt>Source reference</dt><dd>${escapeHTML(ref.externalId || 'Not available')}</dd></div><div><dt>Verification status</dt><dd>${escapeHTML(verification)}</dd></div><div><dt>Internal catalog reference</dt><dd>${escapeHTML(ref.canonicalVariantId || 'Not assigned')}</dd></div><div><dt>Model version</dt><dd>${escapeHTML(modelVersions.join(', ') || 'No model applied')}</dd></div><div><dt>Forecast horizons</dt><dd>${escapeHTML(forecastHorizonsText)}</dd></div><div><dt>Source checks</dt><dd>${sourceCount ? `${sourceCount} approved source${sourceCount === 1 ? '' : 's'}` : 'No approved modeled source coverage'}</dd></div><div><dt>Data quality</dt><dd>${observationCount} verified observation${observationCount === 1 ? '' : 's'}</dd></div><div><dt>Calculation time</dt><dd>${escapeHTML(intelligence?.publishedAt || 'No modeled calculation')}</dd></div><div><dt>Calculation method</dt><dd>Current values remain separate from manual scenarios and published forecasts. Ranges render only when their supporting evidence contract passes validation.</dd></div><div><dt>Price drivers</dt><dd>Drivers reflect recorded model feature contributions, shown in collector-friendly language.</dd></div></dl></div></details>`;
}

function attributionFootnote(intelligence) {
  const sources = intelligence.sourceAttributions.map((entry) => entry.attribution || entry.name).filter(Boolean);
  const published = intelligence.publishedAt ? `Published ${escapeHTML(intelligence.publishedAt.slice(0, 10))}` : '';
  if (!sources.length && !published) return '';
  return `<p class="fine-print">${[sources.length ? `Sources: ${sources.map((source) => escapeHTML(source)).join(' · ')}` : '', published].filter(Boolean).join(' · ')}</p>`;
}
