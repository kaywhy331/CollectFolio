const listeners = new Set();

let state = {
  activeView: 'home',
  route: { key: 'overview', legacyView: 'home', canonicalPath: '/' },
  holdings: [],
  snapshots: [],
  scanDrafts: [],
  watchlistItems: [],
  alerts: [],
  settings: { currency: 'USD', theme: 'dark', demandAnalyticsOptOut: false },
  search: { query: '', category: 'all', provider: 'all', loading: false, results: [], warnings: [] },
  portfolio: { section: 'holdings', query: '', category: 'all', sort: 'value-desc' },
  compare: [],
  featureFlags: { watchlists: true, publicPriceIntelligence: false, loaded: false },
  intelligence: { byVariant: {}, loading: false, error: '', lastRefresh: '' },
  auth: { session: null, syncing: false, refreshingPrices: false },
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
