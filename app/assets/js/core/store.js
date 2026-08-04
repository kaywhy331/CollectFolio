const listeners = new Set();

let state = {
  activeView: 'home',
  holdings: [],
  snapshots: [],
  settings: { currency: 'USD', theme: 'dark' },
  search: { query: '', category: 'all', provider: 'all', loading: false, results: [], warnings: [] },
  portfolio: { query: '', category: 'all', sort: 'value-desc' },
  auth: { session: null, syncing: false },
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
