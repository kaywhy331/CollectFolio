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
  discover: { mode: 'search', game: 'all', setId: '', query: '', sort: 'newest', scope: 'all', setLimit: 120, productQuery: '', productSort: 'number', limit: 120, loading: false, games: [], sets: [], products: [], selectedSet: null, warnings: [], error: '', loadedGame: '', loadedSetId: '' },
  portfolio: {
    section: 'holdings', query: '', category: 'all', sort: 'value-desc', filters: {}, view: 'gallery', selected: [], limit: 100,
    setQuery: '', setCategory: 'all', setSort: 'recent-desc', setLimit: 60
  },
  watchlist: { query: '', category: 'all', sort: 'forecast-desc' },
  insights: { view: 'forecasts', horizon: 90, alertFilter: 'all' },
  compare: [],
  featureFlags: { watchlists: true, setBrowsing: true, publicPriceIntelligence: false, loaded: false },
  intelligence: { byVariant: {}, history: [], loading: false, error: '', lastRefresh: '' },
  // Trajectory-v1 (T6): TCGCSV-identity-keyed forecast packets, keyed by
  // `trajectoryKeyForItem(item)` (see services/forecast-trajectory.js).
  // Separate from `intelligence` because trajectory-v1 identity
  // (categoryId/groupId/productId/subTypeName) is TCGCSV's own, not the
  // app's canonical variant UUID.
  trajectoryForecasts: { byKey: {}, loading: false, error: '' },
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
