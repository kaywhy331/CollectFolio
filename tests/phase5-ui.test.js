import test from 'node:test';
import assert from 'node:assert/strict';
import { SETTINGS_DEFAULTS } from '../app/assets/js/core/settings.js';
import { shellViewModel } from '../app/assets/js/core/view-models.js';
import { renderHoldingForm } from '../app/assets/js/views/holding-form.js';
import { renderOnboarding } from '../app/assets/js/views/onboarding.js';
import { renderProfile } from '../app/assets/js/views/profile.js';

function state(overrides = {}) {
  const base = {
    holdings: [], watchlistItems: [], alerts: [],
    settings: { ...SETTINGS_DEFAULTS },
    auth: { session: null, syncing: false, refreshingPrices: false, online: true, pendingChanges: 0, error: '', status: 'local' },
    storage: { usage: 1536, quota: 1024 * 1024, estimating: false, error: '' }
  };
  return {
    ...base,
    ...overrides,
    settings: { ...base.settings, ...(overrides.settings || {}) },
    auth: { ...base.auth, ...(overrides.auth || {}) },
    storage: { ...base.storage, ...(overrides.storage || {}) }
  };
}

test('onboarding renders persistent storage, currency, and first-add steps', () => {
  const storage = renderOnboarding(state());
  assert.match(storage, /Step 1 of 3/);
  assert.match(storage, /Save on this device/);
  assert.match(storage, /Use cloud backup/);

  const currency = renderOnboarding(state({ settings: { onboardingStep: 'currency', currency: 'CAD' } }));
  assert.match(currency, /Step 2 of 3/);
  assert.match(currency, /value="CAD" selected/);

  const add = renderOnboarding(state({ settings: { onboardingStep: 'add', onboardingStorage: 'cloud' } }));
  assert.match(add, /Step 3 of 3/);
  assert.match(add, /Choose how to add/);
  assert.match(add, /Connect cloud backup/);
});

test('settings distinguish local, pending, synchronized, offline, and error states textually', () => {
  const scenarios = [
    [state(), 'Saved locally'],
    [state({ auth: { session: { user: { email: 'collector@example.test' } }, pendingChanges: 2 } }), 'Waiting to synchronize'],
    [state({ auth: { session: { user: {} }, pendingChanges: 0 }, settings: { lastSyncedAt: '2026-08-10T12:00:00.000Z' } }), 'Synchronized'],
    [state({ auth: { session: { user: {} }, online: false, pendingChanges: 1 } }), 'Offline'],
    [state({ auth: { session: { user: {} }, error: 'retry' }, settings: { lastSyncError: 'Local data is safe.' } }), 'Synchronization needs attention']
  ];
  for (const [value, label] of scenarios) assert.match(renderProfile(value), new RegExp(label));
});

test('ordinary settings copy contains no backend terminology and exposes required data controls', () => {
  const html = renderProfile(state());
  assert.doesNotMatch(html, /Supabase|public key|Tier 0|canonical|provider price|Demand analytics|Local mode/i);
  for (const action of ['export-json', 'import-json', 'export-csv', 'clear-data', 'remove-cloud-data', 'reopen-onboarding']) {
    assert.match(html, new RegExp(`data-action="${action}"`));
  }
  assert.match(html, /Private market insights/);
  assert.match(html, /at least 20 distinct collectors/);
  assert.match(html, /data-action="remove-cloud-data" disabled/);
  assert.match(html, /Unavailable until independently recoverable cloud removal/);
});

test('cloud removal is enabled only by its explicit hosted qualification flag', () => {
  const previousWindow = globalThis.window;
  globalThis.window = { COLLECTFOLIO_CONFIG: { ENABLE_CLOUD_DATA_REMOVAL: true } };
  try {
    const html = renderProfile(state({ auth: { session: { user: {} }, online: true } }));
    assert.match(html, /data-action="remove-cloud-data" >Remove cloud data/);
    assert.doesNotMatch(html, /data-action="remove-cloud-data" disabled/);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test('shell status reports all sync states without relying on color', () => {
  const session = { user: { email: 'collector@example.test' } };
  assert.equal(shellViewModel(state()).syncStatus, 'local');
  assert.equal(shellViewModel(state({ auth: { session, pendingChanges: 2 } })).syncStatus, 'pending');
  assert.equal(shellViewModel(state({ auth: { session, syncing: true } })).syncStatus, 'syncing');
  assert.equal(shellViewModel(state({ auth: { session }, settings: { lastSyncedAt: '2026-08-10T12:00:00.000Z' } })).syncStatus, 'synced');
  assert.equal(shellViewModel(state({ auth: { session, online: false } })).syncStatus, 'offline');
  assert.equal(shellViewModel(state({ auth: { session, error: 'retry' } })).syncStatus, 'error');
});

test('new holding forms honor condition and language defaults', () => {
  const html = renderHoldingForm(null, {
    item: { provider: 'custom', category: 'other', name: 'Collector item' },
    defaultCondition: 'Excellent',
    defaultLanguage: 'ja'
  });
  assert.match(html, /value="Excellent" selected/);
  assert.match(html, /value="ja" selected/);
});
