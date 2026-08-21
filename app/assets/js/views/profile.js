import { pageHeader } from '../core/components.js';
import { formatStorageBytes } from '../core/settings.js';
import { shellViewModel } from '../core/view-models.js';
import { escapeAttribute, escapeHTML } from '../core/utils.js';

const CONDITION_OPTIONS = ['Mint', 'Near Mint', 'Excellent', 'Good', 'Played', 'Poor', 'Graded'];
const LANGUAGE_OPTIONS = [
  ['en', 'English'], ['ja', 'Japanese'], ['fr', 'French'], ['de', 'German'],
  ['es', 'Spanish'], ['it', 'Italian'], ['pt', 'Portuguese'], ['ko', 'Korean'],
  ['zh', 'Chinese'], ['other', 'Other']
];

function option(value, selected, label = value) {
  return `<option value="${escapeAttribute(value)}" ${value === selected ? 'selected' : ''}>${escapeHTML(label)}</option>`;
}

function dateTime(value, fallback = 'Not yet synchronized') {
  const date = new Date(value || '');
  return Number.isNaN(date.valueOf())
    ? fallback
    : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function accountCopy(state, status) {
  const pending = Math.max(0, Number(state.auth.pendingChanges) || 0);
  const copies = {
    local: ['Saved locally', `${state.holdings.length} purchase${state.holdings.length === 1 ? '' : 's'} stays available on this device without an account.`],
    pending: ['Waiting to synchronize', pending
      ? `${pending} saved change${pending === 1 ? '' : 's'} will be backed up the next time synchronization succeeds.`
      : 'Your cloud account is connected and ready for its first synchronization.'],
    syncing: ['Synchronizing now', 'Local changes remain usable while cloud backup is updated in the background.'],
    synced: ['Synchronized', `This device last finished synchronization ${dateTime(state.settings.lastSyncedAt).toLowerCase()}.`],
    offline: ['Offline', pending
      ? `${pending} change${pending === 1 ? '' : 's'} is safely stored here and will retry after this device reconnects.`
      : 'Local items remain available. Cloud actions will resume after this device reconnects.'],
    error: ['Synchronization needs attention', state.settings.lastSyncError || state.auth.error || 'Your local collection is unchanged. Retry synchronization when you are ready.']
  };
  return copies[status] || copies.local;
}

function syncHistory(history = []) {
  if (!history.length) return '<p class="muted">No synchronization attempts have been recorded on this device.</p>';
  return `<ol class="sync-history">${history.map((entry) => `<li><span class="history-state ${entry.status}">${entry.status === 'success' ? 'Completed' : 'Needs attention'}</span><div><strong>${escapeHTML(entry.summary || (entry.status === 'success' ? 'Synchronization completed' : 'Synchronization did not finish'))}</strong><small>${escapeHTML(dateTime(entry.at, 'Date unavailable'))}${entry.reference ? ` · Reference ${escapeHTML(entry.reference)}` : ''}</small></div></li>`).join('')}</ol>`;
}

export function renderProfile(state) {
  const configured = Boolean(globalThis.window?.COLLECTFOLIO_CONFIG?.SUPABASE_URL
    && globalThis.window?.COLLECTFOLIO_CONFIG?.SUPABASE_ANON_KEY);
  const cloudDataRemovalEnabled = globalThis.window?.COLLECTFOLIO_CONFIG?.ENABLE_CLOUD_DATA_REMOVAL === true;
  const session = state.auth.session;
  const shell = shellViewModel(state);
  const [statusTitle, statusDetail] = accountCopy(state, shell.syncStatus);
  const email = session?.user?.email || 'Connected collector';
  const usage = formatStorageBytes(state.storage?.usage);
  const quota = formatStorageBytes(state.storage?.quota);
  const diagnostic = state.settings.syncDiagnostic;
  return `${pageHeader('Account, preferences, and data', 'Settings', 'Control what stays on this device, what is backed up, and how CollectFolio works for you.')}
    <section class="card account-status-card" data-account-status="${escapeAttribute(shell.syncStatus)}">
      <div class="account-status-icon" aria-hidden="true">${session ? 'CF' : '●'}</div>
      <div><p class="eyebrow">${session ? `Cloud backup &amp; sync · ${escapeHTML(email)}` : 'Local collection'}</p><h2>${escapeHTML(statusTitle)}</h2><p>${escapeHTML(statusDetail)}</p><div class="status-facts"><span>${state.holdings.length} purchase${state.holdings.length === 1 ? '' : 's'} on device</span>${session ? `<span>${state.auth.pendingChanges || 0} waiting</span><span>Last synchronized: ${escapeHTML(dateTime(state.settings.lastSyncedAt))}</span>` : ''}</div></div>
    </section>
    <section class="settings-grid account-settings-grid">
      <article class="card settings-panel"><p class="eyebrow">Account &amp; sync</p><h2>${session ? 'Cloud backup is connected' : 'Optional cloud backup'}</h2><p class="muted">${session ? 'Synchronization merges collection purchases and Watchlist items across signed-in devices. Local changes remain available even if a sync is interrupted.' : configured ? 'Sign in to back up collection purchases and Watchlist items across devices. CollectFolio remains fully usable without an account.' : 'Cloud backup is unavailable in this build. Everything you save remains usable on this device.'}</p>
        ${state.auth.error && diagnostic ? `<details class="diagnostic-details"><summary>Recovery details</summary><p>${escapeHTML(state.settings.lastSyncError)}</p><code>${escapeHTML(diagnostic)}</code></details>` : ''}
        <div class="button-row">${session
          ? `<button class="button" type="button" data-action="sync-now" ${state.auth.syncing || !state.auth.online ? 'disabled' : ''}>${state.auth.syncing ? 'Synchronizing…' : 'Synchronize now'}</button><button class="button ghost" type="button" data-action="sign-out">Sign out</button>`
          : `<button class="button secondary" type="button" data-action="open-auth" ${configured ? '' : 'disabled'}>Sign in or create account</button>`}</div>
      </article>
      ${session ? `<article class="card settings-panel"><p class="eyebrow">Market data</p><h2>Prioritize my cards</h2><p class="muted">Ask the private research queue to check your held and watched cards sooner. This request never changes a displayed value until reviewed market data is published.</p><button class="button secondary" type="button" data-action="request-price-refresh" ${state.auth.refreshingPrices || !state.auth.online ? 'disabled' : ''}>${state.auth.refreshingPrices ? 'Requesting…' : 'Prioritize my cards'}</button></article>` : ''}
    </section>

    <section class="card settings-section"><div class="settings-section-heading"><div><p class="eyebrow">Preferences</p><h2>Collection defaults</h2></div><span class="saved-hint" role="status">Changes save on this device</span></div><div class="settings-form-grid">
      <label>Collection name<input data-setting="collectionName" maxlength="80" value="${escapeAttribute(state.settings.collectionName)}" autocomplete="organization" aria-describedby="collection-name-help"><span class="fine-print" id="collection-name-help">Shown in the application header. Your inventory remains private and local-first.</span></label>
      <label>Collection currency<select data-setting="currency">${[['USD', 'USD — US Dollar'], ['CAD', 'CAD — Canadian Dollar'], ['EUR', 'EUR — Euro'], ['GBP', 'GBP — Pound sterling']].map(([value, label]) => option(value, state.settings.currency, label)).join('')}</select><span class="fine-print">Totals include matching amounts only; other currencies remain separate without guessed conversion.</span></label>
      <label>Appearance<select data-setting="theme">${[['dark', 'Dark'], ['light', 'Light'], ['system', 'Use device setting']].map(([value, label]) => option(value, state.settings.theme, label)).join('')}</select></label>
      <label>Default condition<select data-setting="defaultCondition">${CONDITION_OPTIONS.map((value) => option(value, state.settings.defaultCondition)).join('')}</select></label>
      <label>Default language<select data-setting="defaultLanguage">${LANGUAGE_OPTIONS.map(([value, label]) => option(value, state.settings.defaultLanguage, label)).join('')}</select></label>
      <label>Default forecast horizon<select data-setting="defaultForecastHorizon">${[[7, '7 days'], [30, '30 days'], [90, '90 days'], [180, '180 days'], [365, '365 days']].map(([value, label]) => option(value, state.settings.defaultForecastHorizon, label)).join('')}</select></label>
      <label>Preferred market source<select data-setting="preferredMarketSource">${[['all', 'Automatic'], ['tcgcsv', 'Trading card games'], ['pokemon', 'Pokémon market'], ['scryfall', 'Magic market'], ['ygoprodeck', 'Yu-Gi-Oh! market']].map(([value, label]) => option(value, state.settings.preferredMarketSource, label)).join('')}</select></label>
    </div></section>

    <section class="card settings-section"><p class="eyebrow">Privacy</p><h2>Private market insights</h2><p class="muted">When you are signed in, exact-card activity can help prioritize future market coverage. Raw activity remains private to your account, and aggregate trends stay hidden until at least 20 distinct collectors contribute. You can opt out at any time.</p><div class="preference-toggles">
      <label class="setting-toggle"><span><strong>Contribute private market activity</strong><small>Turning this off also excludes your past activity from future aggregate rebuilds.</small></span><input type="checkbox" data-setting-toggle-inverse="demandAnalyticsOptOut" ${state.settings.demandAnalyticsOptOut ? '' : 'checked'}></label>
      <label class="setting-toggle"><span><strong>Personalized recommendations</strong><small>Use only your local collection and Watchlist to tailor suggestions on this device.</small></span><input type="checkbox" data-setting-toggle="personalizedRecommendations" ${state.settings.personalizedRecommendations ? 'checked' : ''}></label>
      <label class="setting-toggle"><span><strong>Synchronization issue notices</strong><small>Show an in-app notice when cloud backup needs attention.</small></span><input type="checkbox" data-setting-toggle="syncIssueNotifications" ${state.settings.syncIssueNotifications ? 'checked' : ''}></label>
    </div><p class="fine-print">Diagnostic references contain a timestamp-based support code, not collection contents. No public profile is created.</p></section>

    <section class="settings-grid data-settings-grid">
      <article class="card settings-panel"><p class="eyebrow">Data portability</p><h2>Backups and exports</h2><p class="muted">A full JSON backup can restore local records. Imports up to 128 MB are size-checked before reading, then validated completely before anything is merged. CSV is a portable collection list.</p><div class="button-row"><button class="button secondary" type="button" data-action="export-json">Export full backup</button><button class="button secondary" type="button" data-action="import-json">Import backup</button><button class="button ghost" type="button" data-action="export-csv">Export collection CSV</button><input class="sr-only" id="backup-file" type="file" accept="application/json,.json" aria-label="Choose CollectFolio backup, up to 128 MB"></div></article>
      <article class="card settings-panel"><p class="eyebrow">Device storage</p><h2>${state.storage?.usage === null ? 'Usage unavailable' : `${escapeHTML(usage)} used`}</h2><p class="muted">${state.storage?.usage === null ? 'Storage usage is unavailable in this browser.' : `${escapeHTML(usage)} of an estimated ${escapeHTML(quota)} browser allowance is in use by site data.`}</p><button class="button ghost" type="button" data-action="refresh-storage">Refresh estimate</button></article>
    </section>

    <section class="card settings-section"><div class="settings-section-heading"><div><p class="eyebrow">Activity</p><h2>Synchronization history</h2></div><button class="button ghost small" type="button" data-action="reopen-onboarding">Revisit setup guide</button></div>${syncHistory(state.settings.syncHistory)}</section>

    <section class="card danger-zone settings-section"><p class="eyebrow">Data controls</p><h2>Remove saved data</h2><div class="danger-actions"><div><strong>Clear this device</strong><p>Removes local collection purchases, scans, settings, catalog details, cached images and app files, and sync history. Cloud copies are not changed.</p><button class="button danger" type="button" data-action="clear-data">Clear local data</button></div><div><strong>Remove cloud data</strong><p>${cloudDataRemovalEnabled ? 'Removes your cloud collection purchases, Watchlist, scans, private market activity, artwork votes, and history while retaining the sign-in account. Local data stays here and cloud sync disconnects.' : 'Unavailable until independently recoverable cloud removal has passed hosted isolation and rollback checks. Local data and normal synchronization remain available.'}</p><button class="button danger" type="button" data-action="remove-cloud-data" ${session && state.auth.online && cloudDataRemovalEnabled ? '' : 'disabled'}>Remove cloud data</button></div></div></section>
    <p class="fine-print settings-version">CollectFolio ${escapeHTML(globalThis.window?.COLLECTFOLIO_CONFIG?.APP_VERSION || '0.8.17')}</p>`;
}
