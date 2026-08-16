import { normalizeIntelligencePayload, trendLabel } from './intelligence-contract.js';
import { catalogPriceForValuation } from './pricing-policy.js';
import { formatCurrency, formatPercent } from './utils.js';
import { selectPublicationForWatchlist } from './market-series.js';

export const COMPARE_LIMIT = 4;

const POSITION_LABELS = {
  below_range: 'Below range',
  within_range: 'Within range',
  above_range: 'Above range',
  insufficient: 'Insufficient evidence'
};

/** Toggles a watch key in the compare selection, capped at COMPARE_LIMIT.
 * Returns the new selection; adding beyond the cap returns the input
 * unchanged so callers can tell the user why nothing happened. */
export function toggleCompareSelection(selection = [], watchKey) {
  if (!watchKey) return selection;
  if (selection.includes(watchKey)) return selection.filter((key) => key !== watchKey);
  if (selection.length >= COMPARE_LIMIT) return selection;
  return [...selection, watchKey];
}

function confidenceLabel(value) {
  if (value === null || value === undefined) return 'Unknown';
  if (value >= 80) return 'High';
  if (value >= 60) return 'Medium';
  if (value >= 40) return 'Medium-low';
  if (value >= 20) return 'Low';
  return 'Insufficient';
}

/** Builds one comparison column per selected watchlist entry (PRD Sec 11.4).
 *
 * Every column carries an overall confidence label, and the result flags
 * when confidence differs across columns so the UI can refuse to present
 * a low-confidence estimate as directly comparable to a high-confidence
 * one without saying so.
 */
export function buildComparison(selection = [], watchlistItems = [], byVariant = {}, currency = 'USD') {
  const columns = selection
    .map((watchKey) => watchlistItems.find((entry) => entry.watchKey === watchKey))
    .filter(Boolean)
    .map((entry) => {
      const ref = entry.catalogRef || {};
      const rawPublication = entry.canonicalVariantId ? byVariant[entry.canonicalVariantId] : null;
      const publication = selectPublicationForWatchlist(rawPublication, entry, currency);
      const intelligence = publication ? normalizeIntelligencePayload(publication) : null;
      const observed = intelligence?.observed || null;
      const catalogPrice = catalogPriceForValuation(ref);
      const pilotForecast = intelligence?.forecasts?.[30] || intelligence?.forecasts?.[90] || null;
      const confidences = [
        intelligence?.trend?.confidence,
        intelligence?.fairValue?.confidence,
        pilotForecast?.confidence
      ].filter((value) => value !== null && value !== undefined);
      const confidence = confidences.length ? Math.min(...confidences) : null;
      const percentOrNone = (value) => value === null || value === undefined ? '—' : formatPercent(value * 100);
      return {
        watchKey: entry.watchKey,
        name: ref.name || 'Unnamed card',
        meta: [ref.setName, ref.number, ref.finish].filter(Boolean).join(' · '),
        supportTier: intelligence?.supportTier ?? 0,
        price: observed
          ? formatCurrency(observed.price, observed.currency)
          : catalogPrice === null ? 'Unavailable' : formatCurrency(catalogPrice, ref.currency || currency),
        return30d: percentOrNone(intelligence?.trend?.return30d),
        return90d: percentOrNone(intelligence?.trend?.return90d),
        return365d: percentOrNone(intelligence?.trend?.return365d),
        trendStatus: intelligence ? trendLabel(intelligence.trend.status) : 'Insufficient data',
        volatility: percentOrNone(intelligence?.trend?.volatility),
        fairValuePosition: intelligence?.fairValue ? (POSITION_LABELS[intelligence.fairValue.position] || 'Insufficient evidence') : '—',
        forecastHorizon: pilotForecast?.horizon || null,
        probabilityUp: pilotForecast?.probabilityUp === null || pilotForecast?.probabilityUp === undefined
          ? '—'
          : `${Math.round(pilotForecast.probabilityUp * 100)}%`,
        confidence,
        confidenceLabel: confidenceLabel(confidence)
      };
    });
  const labels = new Set(columns.map((column) => column.confidenceLabel));
  return {
    columns,
    confidenceDiffers: columns.length > 1 && labels.size > 1
  };
}
