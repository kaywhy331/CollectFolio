export const SETTINGS_SCHEMA_VERSION = 1;

export const CURRENCIES = Object.freeze(['USD', 'CAD', 'EUR', 'GBP']);
export const THEMES = Object.freeze(['dark', 'light', 'system']);
export const DEFAULT_CONDITIONS = Object.freeze(['Mint', 'Near Mint', 'Excellent', 'Good', 'Played', 'Poor', 'Graded']);
export const DEFAULT_LANGUAGES = Object.freeze(['en', 'ja', 'fr', 'de', 'es', 'it', 'pt', 'ko', 'zh', 'other']);
export const DEFAULT_FORECAST_HORIZONS = Object.freeze([7, 30, 90, 180, 365]);
export const PREFERRED_MARKET_SOURCES = Object.freeze(['all', 'pokemon', 'scryfall', 'ygoprodeck']);
export const ONBOARDING_STEPS = Object.freeze(['welcome', 'currency', 'add', 'complete']);

export const SETTINGS_DEFAULTS = Object.freeze({
  settingsSchemaVersion: SETTINGS_SCHEMA_VERSION,
  currency: 'USD',
  theme: 'dark',
  defaultCondition: 'Near Mint',
  defaultLanguage: 'en',
  defaultForecastHorizon: 90,
  preferredMarketSource: 'all',
  demandAnalyticsOptOut: false,
  personalizedRecommendations: true,
  syncIssueNotifications: true,
  discoverView: 'gallery',
  portfolioView: 'gallery',
  recentSearches: [],
  onboardingComplete: false,
  onboardingSkipped: false,
  onboardingStep: 'welcome',
  onboardingStorage: 'local',
  lastSyncedAt: '',
  lastSyncError: '',
  syncDiagnostic: '',
  syncHistory: []
});

const string = (value, max = 240) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const allowed = (value, values, fallback) => values.includes(value) ? value : fallback;
const nonNegativeInteger = (value) => Number.isInteger(Number(value)) && Number(value) >= 0 ? Number(value) : 0;

function validISO(value) {
  const candidate = string(value, 40);
  const timestamp = Date.parse(candidate);
  return candidate && Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : '';
}

function recordObject(records = []) {
  if (!Array.isArray(records)) return records && typeof records === 'object' ? { ...records } : {};
  return Object.fromEntries(records
    .filter((record) => record && typeof record.key === 'string')
    .map((record) => [record.key, record.value]));
}

function normalizeSyncHistory(history = []) {
  if (!Array.isArray(history)) return [];
  return history.map((entry) => {
    const status = entry?.status === 'success' ? 'success' : entry?.status === 'error' ? 'error' : '';
    const at = validISO(entry?.at);
    if (!status || !at) return null;
    return {
      id: string(entry.id, 80) || `${status}:${at}`,
      status,
      at,
      summary: string(entry.summary, 240),
      reference: string(entry.reference, 80),
      counts: {
        holdings: nonNegativeInteger(entry.counts?.holdings),
        watchlist: nonNegativeInteger(entry.counts?.watchlist),
        deletions: nonNegativeInteger(entry.counts?.deletions)
      }
    };
  }).filter(Boolean).sort((left, right) => right.at.localeCompare(left.at)).slice(0, 12);
}

export function normalizeSettings(input = {}, { hasHoldings = false } = {}) {
  const source = recordObject(input);
  // Existing collectors should not be forced through first-run guidance when
  // this settings record migration first lands. Once the schema marker is
  // present, however, explicit progress (including reopened guidance) wins.
  const legacyPortfolio = hasHoldings && Number(source.settingsSchemaVersion) !== SETTINGS_SCHEMA_VERSION;
  const onboardingComplete = source.onboardingComplete === true || legacyPortfolio;
  return {
    ...SETTINGS_DEFAULTS,
    settingsSchemaVersion: SETTINGS_SCHEMA_VERSION,
    currency: allowed(source.currency, CURRENCIES, SETTINGS_DEFAULTS.currency),
    theme: allowed(source.theme, THEMES, SETTINGS_DEFAULTS.theme),
    defaultCondition: allowed(source.defaultCondition, DEFAULT_CONDITIONS, SETTINGS_DEFAULTS.defaultCondition),
    defaultLanguage: allowed(source.defaultLanguage, DEFAULT_LANGUAGES, SETTINGS_DEFAULTS.defaultLanguage),
    defaultForecastHorizon: allowed(Number(source.defaultForecastHorizon), DEFAULT_FORECAST_HORIZONS, SETTINGS_DEFAULTS.defaultForecastHorizon),
    preferredMarketSource: allowed(source.preferredMarketSource, PREFERRED_MARKET_SOURCES, SETTINGS_DEFAULTS.preferredMarketSource),
    demandAnalyticsOptOut: source.demandAnalyticsOptOut === true,
    personalizedRecommendations: source.personalizedRecommendations !== false,
    syncIssueNotifications: source.syncIssueNotifications !== false,
    discoverView: source.discoverView === 'list' ? 'list' : 'gallery',
    portfolioView: source.portfolioView === 'list' ? 'list' : 'gallery',
    recentSearches: Array.isArray(source.recentSearches)
      ? [...new Set(source.recentSearches.map((value) => string(value, 160)).filter(Boolean))].slice(0, 5)
      : [],
    onboardingComplete,
    onboardingSkipped: source.onboardingSkipped === true,
    onboardingStep: onboardingComplete
      ? 'complete'
      : allowed(source.onboardingStep, ONBOARDING_STEPS.slice(0, 3), 'welcome'),
    onboardingStorage: source.onboardingStorage === 'cloud' ? 'cloud' : 'local',
    lastSyncedAt: validISO(source.lastSyncedAt),
    lastSyncError: string(source.lastSyncError, 240),
    syncDiagnostic: string(source.syncDiagnostic, 80),
    syncHistory: normalizeSyncHistory(source.syncHistory)
  };
}

export function migrateSettingsRecords(records = [], options = {}) {
  const source = recordObject(records);
  const settings = normalizeSettings(source, options);
  const updates = Object.entries(settings)
    .filter(([key, value]) => !Object.hasOwn(source, key) || JSON.stringify(source[key]) !== JSON.stringify(value))
    .map(([key, value]) => ({ key, value }));
  return { settings, updates };
}

export function appendSyncHistory(history = [], entry = {}) {
  const at = validISO(entry.at) || new Date().toISOString();
  const status = entry.status === 'success' ? 'success' : 'error';
  return normalizeSyncHistory([{
    ...entry,
    id: string(entry.id, 80) || `${status}:${at}`,
    status,
    at
  }, ...(Array.isArray(history) ? history : [])]);
}

export function pendingSyncChanges(...collections) {
  return collections.flatMap((collection) => Array.isArray(collection) ? collection : [])
    .filter((entry) => entry?.dirty === true).length;
}

export function syncDiagnosticReference(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  const stamp = Number.isNaN(date.valueOf()) ? new Date().toISOString() : date.toISOString();
  return `SYNC-${stamp.replace(/\D/g, '').slice(0, 14)}`;
}

export function friendlyCloudError(error, { online = true } = {}) {
  const message = String(error?.message || error || '').toLowerCase();
  if (!online || /offline|network|failed to fetch|load failed/.test(message)) {
    return 'You are offline. Saved changes remain on this device and can sync after you reconnect.';
  }
  if (/session|sign in|token|unauthorized|401|403/.test(message)) {
    return 'Your cloud session needs attention. Sign in again, then retry synchronization.';
  }
  return 'Cloud backup could not finish. Your local portfolio is unchanged; retry when you are ready.';
}

export function formatStorageBytes(value) {
  if (value === null || value === undefined || value === '') return 'Unavailable';
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return 'Unavailable';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let amount = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && amount >= 1024; index++) {
    amount /= 1024;
    unit = units[index];
  }
  return `${amount >= 10 ? amount.toFixed(0) : amount.toFixed(1)} ${unit}`;
}
