import { normalizeIntelligencePayload } from './intelligence-contract.js';

const finite = (value) => Number.isFinite(Number(value)) ? Number(value) : null;

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
  const fingerprint = [
    value.variantId, value.supportTier, value.observed?.price ?? '',
    value.trend.status, value.fairValue?.position || '', forecastSignature(value.forecasts),
    publication?.publishedAt || '', publication?.expiresAt || ''
  ].join('|');
  return {
    fingerprint: hashText(fingerprint),
    observedPrice: value.observed?.price ?? null,
    currency: value.observed?.currency || 'USD',
    trendStatus: value.trend.status,
    fairValuePosition: value.fairValue?.position || '',
    forecastSignature: forecastSignature(value.forecasts),
    capturedAt,
    publishedAt: publication?.publishedAt || ''
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
  if (!entry?.watchKey || !entry?.canonicalVariantId || !publication) {
    return { baseline: entry?.intelligenceBaseline || null, alerts: [] };
  }
  const value = normalizeIntelligencePayload(publication);
  if (value.variantId.toLowerCase() !== String(entry.canonicalVariantId).toLowerCase()) {
    return { baseline: entry.intelligenceBaseline || null, alerts: [] };
  }
  const baseline = intelligenceAlertBaseline(publication, now);
  const previous = entry.intelligenceBaseline || null;
  if (previous?.fingerprint === baseline.fingerprint) return { baseline: previous, alerts: [] };

  const alerts = [];
  const currentPrice = value.observed?.price ?? null;
  const previousPrice = finite(previous?.observedPrice);
  const targetPrice = finite(entry.targetPrice);
  if (currentPrice !== null && targetPrice !== null && currentPrice <= targetPrice && (previousPrice === null || previousPrice > targetPrice)) {
    alerts.push(event(
      entry, value, baseline, 'target_price',
      `${entry.catalogRef?.name || 'Watched card'} reached the target price.`,
      { currentPrice, targetPrice, currency: baseline.currency }, now
    ));
  }

  const percentThreshold = finite(entry.alertPercentChange);
  if (currentPrice !== null && previousPrice !== null && previousPrice > 0 && percentThreshold !== null && percentThreshold > 0) {
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
