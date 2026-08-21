import { normalizeIntelligencePayload } from './intelligence-contract.js';
import { marketSeriesIdentity, selectPublicationForWatchlist } from './market-series.js';

const finite = (value) => value !== '' && value !== null && value !== undefined && Number.isFinite(Number(value)) ? Number(value) : null;

function hashText(value) {
  let hash = 0x811c9dc5;
  for (const character of String(value)) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function forecastSignature(forecasts = {}) {
  return Object.values(forecasts).sort((left, right) => left.horizon - right.horizon).map((value) => [
    value.horizon, value.q10, value.q25, value.q50, value.q75, value.q90,
    value.probabilityUp, value.modelVersion
  ].join(':')).join('|');
}

export function intelligenceAlertBaseline(publication, capturedAt = new Date().toISOString()) {
  const value = normalizeIntelligencePayload(publication);
  const series = marketSeriesIdentity(value.seriesIdentity);
  const seriesKey = [
    series.sourceId, series.currency, series.language, series.finish,
    series.conditionClass, series.marketCondition, series.priceSemantics
  ].join('|');
  const fingerprint = [
    value.variantId, seriesKey, value.supportTier, value.observed?.price ?? '',
    value.observed?.currency || '',
    value.trend.status, value.fairValue?.position || '', forecastSignature(value.forecasts),
    publication?.publishedAt || '', publication?.expiresAt || ''
  ].join('|');
  const expiryTime = Date.parse(value.expiresAt || '');
  const capturedTime = Date.parse(capturedAt);
  return {
    fingerprint: hashText(fingerprint),
    seriesKey,
    observedPrice: value.observed?.price ?? null,
    observedAt: value.observed?.observedAt || '',
    currency: value.observed?.currency || 'USD',
    trendStatus: value.trend.status,
    fairValuePosition: value.fairValue?.position || '',
    forecastSignature: forecastSignature(value.forecasts),
    capturedAt,
    publishedAt: value.publishedAt,
    expiresAt: value.expiresAt,
    stale: Number.isFinite(expiryTime) && Number.isFinite(capturedTime) && expiryTime <= capturedTime
  };
}

function event(entry, publication, baseline, kind, message, details, triggeredAt) {
  const seed = [entry.watchKey, publication.variantId, kind, baseline.fingerprint].join('|');
  return {
    id: `intelligence:${hashText(seed)}`,
    watchKey: entry.watchKey,
    variantId: publication.variantId,
    kind,
    message,
    details,
    triggeredAt,
    publicationFingerprint: baseline.fingerprint,
    readAt: ''
  };
}

export function evaluateWatchlistItemAlerts(entry, publication, now = new Date().toISOString()) {
  const selected = selectPublicationForWatchlist(
    publication,
    entry,
    entry.catalogRef?.currency || 'USD'
  );
  if (!entry?.watchKey || !entry?.canonicalVariantId || !selected) {
    return { baseline: entry?.intelligenceBaseline || null, alerts: [] };
  }
  publication = selected;
  const value = normalizeIntelligencePayload(publication);
  if (value.variantId.toLowerCase() !== String(entry.canonicalVariantId).toLowerCase()) {
    return { baseline: entry.intelligenceBaseline || null, alerts: [] };
  }
  const baseline = intelligenceAlertBaseline(publication, now);
  const previous = entry.intelligenceBaseline || null;
  if (previous?.fingerprint === baseline.fingerprint && Boolean(previous.stale) === baseline.stale) return { baseline: previous, alerts: [] };

  const alerts = [];
  const currentPrice = value.observed?.price ?? null;
  const previousPrice = finite(previous?.observedPrice);
  const previousCurrency = String(previous?.currency || '').toUpperCase();
  const previousPriceComparable = previousPrice !== null && previousCurrency === baseline.currency;
  const targetPrice = finite(entry.targetPrice);
  const targetCurrency = String(entry.targetCurrency || entry.catalogRef?.currency || 'USD').toUpperCase();
  const targetComparable = targetCurrency === baseline.currency;
  if (previous && previousPrice === null && currentPrice !== null) {
    alerts.push(event(
      entry, value, baseline, 'new_catalog_price',
      `${entry.catalogRef?.name || 'Watched item'} received a new catalog price.`,
      { currentPrice, currency: baseline.currency, observedAt: baseline.observedAt }, now
    ));
  }
  if (previousPrice !== null && currentPrice === null) {
    alerts.push(event(
      entry, value, baseline, 'became_unpriced',
      `${entry.catalogRef?.name || 'Watched item'} no longer has an approved catalog price.`,
      { previousPrice, currency: previousCurrency }, now
    ));
  }
  if (previous && !previous.stale && baseline.stale) {
    alerts.push(event(
      entry, value, baseline, 'price_stale',
      `${entry.catalogRef?.name || 'Watched item'} price became stale.`,
      { observedAt: baseline.observedAt, expiresAt: baseline.expiresAt }, now
    ));
  }
  if (targetComparable && currentPrice !== null && targetPrice !== null && currentPrice <= targetPrice && (!previousPriceComparable || previousPrice > targetPrice)) {
    alerts.push(event(
      entry, value, baseline, 'target_price',
      `${entry.catalogRef?.name || 'Watched card'} reached the target price.`,
      { currentPrice, targetPrice, currency: baseline.currency, targetCurrency }, now
    ));
  }

  const percentThreshold = finite(entry.alertPercentChange);
  if (currentPrice !== null && previousPriceComparable && previousPrice > 0 && percentThreshold !== null && percentThreshold > 0) {
    const percentChange = (currentPrice / previousPrice - 1) * 100;
    if (Math.abs(percentChange) >= percentThreshold) {
      alerts.push(event(
        entry, value, baseline, 'percent_change',
        `${entry.catalogRef?.name || 'Watched card'} moved ${Math.abs(percentChange).toFixed(1)}%.`,
        { currentPrice, previousPrice, percentChange, threshold: percentThreshold, currency: baseline.currency }, now
      ));
    }
  }

  if (entry.alertTrendChange && previous?.trendStatus && previous.trendStatus !== baseline.trendStatus) {
    alerts.push(event(
      entry, value, baseline, 'trend_change',
      `${entry.catalogRef?.name || 'Watched card'} trend changed to ${baseline.trendStatus.replaceAll('_', ' ')}.`,
      { previous: previous.trendStatus, current: baseline.trendStatus }, now
    ));
  }
  if (entry.alertRangeChange && previous?.fairValuePosition && baseline.fairValuePosition && previous.fairValuePosition !== baseline.fairValuePosition) {
    alerts.push(event(
      entry, value, baseline, 'range_change',
      `${entry.catalogRef?.name || 'Watched card'} changed fair-value position.`,
      { previous: previous.fairValuePosition, current: baseline.fairValuePosition }, now
    ));
  }
  if (entry.alertForecastChange && previous?.forecastSignature && baseline.forecastSignature && previous.forecastSignature !== baseline.forecastSignature) {
    alerts.push(event(
      entry, value, baseline, 'forecast_change',
      `${entry.catalogRef?.name || 'Watched card'} received a revised approved forecast.`,
      { previous: previous.forecastSignature, current: baseline.forecastSignature }, now
    ));
  }
  return { baseline, alerts };
}

export function evaluateWatchlistAlerts(entries = [], publications = {}, now = new Date().toISOString()) {
  const alerts = [];
  const items = entries.map((entry) => {
    const publication = publications[String(entry.canonicalVariantId || '').toLowerCase()];
    if (!publication) return entry;
    const evaluated = evaluateWatchlistItemAlerts(entry, publication, now);
    alerts.push(...evaluated.alerts);
    return evaluated.baseline === entry.intelligenceBaseline ? entry : { ...entry, intelligenceBaseline: evaluated.baseline };
  });
  return { items, alerts };
}
