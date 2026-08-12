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
  search: { query: '', category: 'all', provider: 'all', filters: {}, view: 'gallery', loading: false, results: [], warnings: [] },
  portfolio: { section: 'holdings', query: '', category: 'all', sort: 'value-desc', filters: {}, view: 'gallery', selected: [], limit: 100 },
  watchlist: { query: '', category: 'all', sort: 'opportunity-desc' },
  insights: { view: 'forecasts', horizon: 90, alertFilter: 'all' },
  compare: [],
  featureFlags: { watchlists: true, publicPriceIntelligence: false, loaded: false },
  intelligence: { byVariant: {}, history: [], loading: false, error: '', lastRefresh: '' },
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
