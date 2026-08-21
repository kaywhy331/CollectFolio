import { SETTINGS_DEFAULTS } from './settings.js';

const listeners = new Set();

let state = {
  activeView: 'home',
  route: { key: 'overview', legacyView: 'home', canonicalPath: '/' },
  holdings: [],
  snapshots: [],
  localValueObservations: [],
  scanDrafts: [],
  watchlistItems: [],
  alerts: [],
  settings: { ...SETTINGS_DEFAULTS },
  overview: { range: '3M' },
  search: { query: '', category: 'all', provider: 'all', filters: {}, view: 'gallery', limit: 200, loading: false, results: [], warnings: [] },
  discover: { mode: 'search', game: 'all', setId: '', query: '', sort: 'newest', scope: 'all', setLimit: 24, productQuery: '', productSort: 'number', limit: 24, loading: false, productsLoadingMore: false, productNextCursor: '', productTotal: 0, games: [], sets: [], products: [], selectedSet: null, warnings: [], error: '', loadedGame: '', loadedSetId: '' },
  portfolio: {
    section: 'holdings', query: '', category: 'all', sort: 'value-desc', filters: {}, view: 'gallery', groupMode: 'grouped', selectionMode: false, selected: [], limit: 100,
    setQuery: '', setCategory: 'all', setSort: 'recent-desc', setLimit: 60
  },
  watchlist: { query: '', category: 'all', sort: 'forecast-desc' },
  insights: {
    view: 'performance', horizon: 90, alertFilter: 'all', scenarioSort: 'upside', expandedScenarioId: '', expandedPublishedId: '',
    scenarioAssumptions: { marketDirection: 'unchanged', category: '', categoryDirection: 'unchanged', itemId: '', itemDirection: 'unchanged', volatility: 'typical', manualValues: 'steady' }
  },
  compare: [],
  // trajectoryForecasts (CollectFolio's own derived trajectory-v1 stats,
  // served anonymously from our own worker under the community-free-access
  // SourceTerms record) defaults ENABLED -- it is not the Supabase
  // publicPriceIntelligence rights gate, and is disabled only if a remote
  // product_feature_flags row explicitly sets it enabled:false.
  featureFlags: { watchlists: true, setBrowsing: true, publicPriceIntelligence: false, trajectoryForecasts: true, loaded: false },
  intelligence: { byVariant: {}, history: [], loading: false, error: '', lastRefresh: '' },
  // Trajectory-v1 (T6): TCGCSV-identity-keyed forecast packets, keyed by
  // `trajectoryKeyForItem(item)` (see services/forecast-trajectory.js).
  // Separate from `intelligence` because trajectory-v1 identity
  // (categoryId/groupId/productId/subTypeName) is TCGCSV's own, not the
  // app's canonical variant UUID.
  trajectoryForecasts: { byKey: {}, loading: false, error: '' },
  // 0.8.17: TCGCSV weekly price-HISTORY objects, keyed by
  // `historyKeyForItem(item)` (see services/history-trajectory.js). Same
  // TCGCSV identity keying as trajectoryForecasts, but observed data with
  // no eligibility gate -- an absent key simply means no history object
  // was ever published for that item, never "excluded".
  priceHistory: { byKey: {}, loading: false, error: '', range: '1Y', showForecast: true },
  tcgcsvRefresh: {
    status: 'disabled', sourceUpdatedAt: '', lastSuccessfulSourceBuild: null,
    lastSuccessfulAt: null, error: ''
  },
  auth: {
    session: null,
    syncing: false,
    refreshingPrices: false,
    online: globalThis.navigator?.onLine !== false,
    status: 'local',
    pendingChanges: 0,
    error: ''
  },
  storage: { usage: null, quota: null, estimating: false, error: '' },
  scanDraftCount: 0,
  ready: false
};

export function getState() {
  return state;
}

export function setState(update) {
  const patch = typeof update === 'function' ? update(state) : update;
  state = { ...state, ...patch };
  for (const listener of listeners) listener(state);
  return state;
}

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
