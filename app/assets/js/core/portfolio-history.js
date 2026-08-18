// 0.8.17: reconstructs a retroactive weekly portfolio market-value series
// from each holding's TCGCSV price-history points (Item 2's history
// service), for use on the overview and portfolio pages' value line
// graph. Deliberately pure/DOM-free and decoupled from the history
// fetch/cache layer -- callers resolve `historyPointsByHoldingId` (see
// services/history-trajectory.js's getPriceHistoryForItem, keyed here by
// holding.id rather than TCGCSV identity so this module never needs to
// know about TCGCSV specifically) and pass it in.
import { holdingCostBasis, holdingCostCurrency, holdingMarketCurrency, holdingMarketValue } from './calculations.js';

const currencyCode = (value, fallback = 'USD') => {
  const normalized = String(value || '').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(normalized) ? normalized : fallback;
};

// This app's holding record has no field literally named `acquiredAt` --
// `purchaseDate` (see core/db.js / views/holding-form.js) is the
// equivalent "when did you start owning this" field, so it is what this
// module treats as the acquisition cutoff. A holding with no recorded
// purchaseDate is included from the start of its history series (the
// series' own earliest observed date), per the documented "absent means
// don't guess a start date, but don't hide the value either" assumption.
function purchaseCutoffTime(holding) {
  const parsed = Date.parse(holding?.purchaseDate || '');
  return Number.isFinite(parsed) ? parsed : null;
}

// Reconstructs a weekly {date, marketValue, costBasis} series across all
// currency-matching holdings:
// - A holding with resolvable history points contributes
//   price-at-that-week x quantity (carrying the latest observed weekly
//   price forward within a week, never interpolating one that was never
//   observed).
// - A holding with no resolvable history (no TCGCSV identity, or its
//   group was never published) contributes its CURRENT value flat across
//   the whole reconstructed range -- a documented, non-fabricated choice:
//   this is honest about "we don't know its past price" while still
//   reflecting that the holding existed and had some value. Coverage of
//   how many holdings actually have real history (vs. flat fallback) is
//   returned alongside the series so callers can render a coverage note,
//   mirroring the overview's existing "% pricing coverage" convention.
// - Cost basis does not vary with price history, so every included
//   holding always contributes its fixed cost basis for any week it was
//   owned in, exactly as portfolioSummary does for the "now" snapshot.
export function reconstructPortfolioValueSeries(holdings = [], historyPointsByHoldingId = {}, { currency = 'USD', now = new Date() } = {}) {
  const selectedCurrency = currencyCode(currency);
  const eligible = (Array.isArray(holdings) ? holdings : [])
    .filter((holding) => holdingMarketCurrency(holding) === selectedCurrency && holdingCostCurrency(holding) === selectedCurrency);
  const emptyCoverage = { withHistory: 0, flatOnly: 0, total: eligible.length, percent: 0 };
  if (!eligible.length) return { points: [], coverage: emptyCoverage };

  const dateSet = new Set();
  const perHolding = eligible.map((holding) => {
    const rawPoints = historyPointsByHoldingId?.[holding.id];
    const quantity = Math.max(0, Number(holding.quantity) || 0);
    const cutoff = purchaseCutoffTime(holding);
    if (Array.isArray(rawPoints) && rawPoints.length) {
      const points = rawPoints
        .map((pair) => ({ date: String(pair?.[0] || ''), price: Number(pair?.[1]), time: Date.parse(pair?.[0] || '') }))
        .filter((point) => Number.isFinite(point.price) && point.price >= 0 && Number.isFinite(point.time))
        .filter((point) => cutoff === null || point.time >= cutoff)
        .sort((left, right) => left.time - right.time);
      if (points.length) {
        points.forEach((point) => dateSet.add(point.date));
        return { holding, quantity, cutoff, mode: 'history', points };
      }
    }
    return { holding, quantity, cutoff, mode: 'flat' };
  });

  const withHistory = perHolding.filter((entry) => entry.mode === 'history').length;
  const coverage = {
    withHistory,
    flatOnly: eligible.length - withHistory,
    total: eligible.length,
    percent: eligible.length ? Math.round((withHistory / eligible.length) * 100) : 0
  };

  if (!dateSet.size) return { points: [], coverage };

  const nowTime = now instanceof Date ? now.getTime() : Date.parse(now);
  const effectiveNow = Number.isFinite(nowTime) ? nowTime : Date.now();

  const points = [...dateSet].sort()
    .filter((date) => Date.parse(date) <= effectiveNow)
    .map((date) => {
      const time = Date.parse(date);
      let marketValue = 0;
      let costBasis = 0;
      perHolding.forEach((entry) => {
        if (entry.cutoff !== null && time < entry.cutoff) return; // not yet owned at this date
        if (entry.mode === 'history') {
          let price = null;
          for (let index = entry.points.length - 1; index >= 0; index -= 1) {
            if (entry.points[index].time <= time) { price = entry.points[index].price; break; }
          }
          if (price !== null) marketValue += price * entry.quantity;
        } else {
          marketValue += holdingMarketValue(entry.holding, selectedCurrency);
        }
        costBasis += holdingCostBasis(entry.holding, selectedCurrency);
      });
      return { date, marketValue, costBasis };
    });

  return { points, coverage };
}

// Merge strategy: retro weekly reconstruction for the past + existing
// locally-recorded daily snapshots -- snapshots WIN on any overlapping
// date, since they reflect actually-observed app state rather than a
// reconstruction. Both inputs are {date, marketValue, costBasis} shaped
// (retro points above / core/calculations.js's snapshotFor output).
export function mergeRetroSeriesWithSnapshots(retroPoints = [], snapshots = []) {
  const byDate = new Map();
  (Array.isArray(retroPoints) ? retroPoints : []).forEach((point) => {
    if (point?.date) byDate.set(point.date, { date: point.date, marketValue: point.marketValue, costBasis: point.costBasis });
  });
  (Array.isArray(snapshots) ? snapshots : []).forEach((point) => {
    if (point?.date) byDate.set(point.date, { date: point.date, marketValue: point.marketValue, costBasis: point.costBasis });
  });
  return [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date));
}
