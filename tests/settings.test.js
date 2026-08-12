import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendSyncHistory,
  friendlyCloudError,
  formatStorageBytes,
  migrateSettingsRecords,
  normalizeSettings,
  pendingSyncChanges,
  SETTINGS_DEFAULTS
} from '../app/assets/js/core/settings.js';

test('settings normalization resolves invalid values without retaining unknown keys', () => {
  const settings = normalizeSettings({
    currency: 'BTC', theme: 'neon', defaultCondition: 'Dusty',
    recentSearches: ['  Charizard ', 'Charizard', '', 'Lotus'],
    defaultForecastHorizon: '30', unknownBackendValue: 'hidden'
  });
  assert.equal(settings.currency, SETTINGS_DEFAULTS.currency);
  assert.equal(settings.theme, SETTINGS_DEFAULTS.theme);
  assert.equal(settings.defaultCondition, SETTINGS_DEFAULTS.defaultCondition);
  assert.equal(settings.defaultForecastHorizon, 30);
  assert.deepEqual(settings.recentSearches, ['Charizard', 'Lotus']);
  assert.equal('unknownBackendValue' in settings, false);
});

test('settings-record migration is complete, idempotent, and preserves existing collectors', () => {
  const legacy = [{ key: 'currency', value: 'CAD' }];
  const first = migrateSettingsRecords(legacy, { hasHoldings: true });
  assert.equal(first.settings.currency, 'CAD');
  assert.equal(first.settings.onboardingComplete, true);
  assert.equal(first.settings.onboardingStep, 'complete');
  const migratedRecords = Object.entries(first.settings).map(([key, value]) => ({ key, value }));
  assert.deepEqual(migrateSettingsRecords(migratedRecords, { hasHoldings: true }).updates, []);
});

test('current-schema onboarding progress survives refresh even when holdings exist', () => {
  const settings = normalizeSettings({
    ...SETTINGS_DEFAULTS,
    settingsSchemaVersion: 1,
    onboardingComplete: false,
    onboardingStep: 'currency'
  }, { hasHoldings: true });
  assert.equal(settings.onboardingComplete, false);
  assert.equal(settings.onboardingStep, 'currency');
});

test('sync history is newest-first, bounded, and normalizes counts', () => {
  let history = [];
  for (let index = 0; index < 15; index++) {
    history = appendSyncHistory(history, {
      status: index % 2 ? 'success' : 'error',
      at: new Date(Date.UTC(2026, 7, 1, index)).toISOString(),
      summary: `Run ${index}`,
      counts: { holdings: index, watchlist: -1, deletions: '2' }
    });
  }
  assert.equal(history.length, 12);
  assert.equal(history[0].summary, 'Run 14');
  assert.deepEqual(history[0].counts, { holdings: 14, watchlist: 0, deletions: 2 });
});

test('pending changes count only dirty local records', () => {
  assert.equal(pendingSyncChanges(
    [{ id: 'one', dirty: true }, { id: 'two', dirty: false }],
    [{ id: 'three', dirty: true }], null
  ), 2);
});

test('cloud errors and storage sizes use collector-facing language', () => {
  assert.match(friendlyCloudError(new Error('Failed to fetch')), /offline/i);
  assert.match(friendlyCloudError(new Error('401 unauthorized')), /sign in again/i);
  assert.doesNotMatch(friendlyCloudError(new Error('database exploded')), /database|supabase/i);
  assert.equal(formatStorageBytes(0), '0 B');
  assert.equal(formatStorageBytes(1536), '1.5 KB');
  assert.equal(formatStorageBytes(-1), 'Unavailable');
});
