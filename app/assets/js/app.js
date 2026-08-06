import { clearLocalData, exportBackup, exportHoldingsCSV, getAll, importBackup, putRecord, removeHolding, saveHolding } from './core/db.js';
import { evaluateWatchlistAlerts } from './core/intelligence-alerts.js';
import {
  catalogPriceOptionsForDisplay,
  currentPricingSnapshots,
  isRestrictedCatalogPrice,
  PRICING_POLICY_VERSION
} from './core/pricing-policy.js';
import { getState, setState, subscribe } from './core/store.js';
import { closeModal, openModal, showToast } from './core/ui.js';
import { createId, downloadFile, escapeAttribute, escapeHTML, safeImageUrl } from './core/utils.js';
import { refreshCatalogItem, searchCatalog } from './services/catalog.js';
import { cropsFromBoxes, cropToJPEG, fileToImageDataURL, loadImage } from './services/image.js';
import { intelligenceVariantIds, loadCachedIntelligence, refreshPublishedIntelligence } from './services/price-intelligence.js';
import { requestPriceRefresh } from './services/justtcg-refresh.js';
import { batchAddApproved, createScanDraft, deleteCrop, identifyCrop, recoverInterruptedIdentifications, saveScanDraft, selectCropCandidate, setCropApproval, setCropCustomItem } from './services/scan-review.js';
import { ScanWorkbench } from './services/scan-workbench.js';
import { consumeAuthCallback, fetchPublicFeatureFlags, isSupabaseConfigured, loadSession, requestMagicLink, signIn, signOut, signUp, syncAll } from './services/supabase.js';
import { findWatchedItem, unwatchItem, watchItem } from './services/watchlist.js';
import { renderAdd } from './views/add.js';
import { renderHome } from './views/home.js';
import { renderPortfolio } from './views/portfolio.js';
import { renderProfile } from './views/profile.js';
import { renderSearch } from './views/search.js';
import { renderScanReview } from './views/scan.js';

const root = document.querySelector('#main-content');
const defaults = { currency: 'USD', theme: 'dark' };
let activeDraft = null;

root.addEventListener('error', (event) => {
  const image = event.target;
  if (!(image instanceof HTMLImageElement) || !image.matches('[data-external-image]')) return;
  const fallback = safeImageUrl(image.dataset.fallbackSrc);
  if (fallback && !image.dataset.fallbackAttempted && fallback !== image.src) {
    image.dataset.fallbackAttempted = 'true';
    image.src = fallback;
    return;
  }
  const placeholder = document.createElement('div');
  placeholder.className = image.className;
  placeholder.classList.add('image-placeholder');
  placeholder.setAttribute('aria-label', `${image.alt || 'Collectible'} image unavailable`);
  placeholder.innerHTML = '<span>CF</span>';
  image.replaceWith(placeholder);
}, true);

function render(state = getState()) {
  const views = { home: renderHome, search: renderSearch, add: renderAdd, portfolio: renderPortfolio, profile: renderProfile, scan: () => renderScanReview(activeDraft, state) };
  root.innerHTML = state.ready ? (views[state.activeView] || renderHome)(state) : '<section class="empty-state"><h1>CollectFolio</h1><p>Opening your local portfolio…</p></section>';
  document.querySelectorAll('.bottom-nav [data-view]').forEach((button) => {
    const selected = button.dataset.view === state.activeView;
    button.classList.toggle('active', selected);
    if (selected) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  });
}

function runtimePriceIntelligenceEnabled() {
  const value = globalThis.window?.COLLECTFOLIO_CONFIG?.ENABLE_PRICE_INTELLIGENCE;
  return value === undefined || !/^(0|false|no)$/i.test(String(value));
}

async function loadLocal() {
  const [holdings, snapshots, settingsRecords, scans, watchlistItems, alerts] = await Promise.all([
    getAll('holdings'), getAll('snapshots'), getAll('settings'), getAll('scans'),
    getAll('watchlistItems'), getAll('alerts')
  ]);
  const settings = { ...defaults, ...Object.fromEntries(settingsRecords.map((record) => [record.key, record.value])) };
  document.documentElement.dataset.theme = settings.theme;
  setState({
    holdings,
    snapshots: currentPricingSnapshots(snapshots).sort((a, b) => a.date.localeCompare(b.date)),
    watchlistItems: watchlistItems.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))),
    alerts: alerts.sort((a, b) => String(b.triggeredAt).localeCompare(String(a.triggeredAt))),
    settings,
    featureFlags: getState().featureFlags.loaded
      ? getState().featureFlags
      : { ...getState().featureFlags, watchlists: runtimePriceIntelligenceEnabled(), publicPriceIntelligence: false },
    scanDraftCount: scans.filter((scan) => scan.status !== 'complete').length,
    ready: true
  });
}

function initializeAuth() {
  if (!isSupabaseConfigured()) return;
  try {
    const callback = consumeAuthCallback();
    setState({ auth: { ...getState().auth, session: callback.session || loadSession() } });
    if (callback.error) showToast(callback.error, 'error', 8000);
    else if (callback.session && location.hash) showToast('Supabase sign-in completed');
  } catch (error) {
    showToast(error.message || 'Could not restore cloud session', 'error');
  }
}

async function loadFeatureFlags() {
  const runtimeEnabled = runtimePriceIntelligenceEnabled();
  let remote = {};
  if (runtimeEnabled) {
    try { remote = await fetchPublicFeatureFlags(); } catch { /* Foundation migration may not be deployed yet. */ }
  }
  setState({ featureFlags: {
    watchlists: runtimeEnabled && (remote.watchlists ?? true),
    publicPriceIntelligence: runtimeEnabled && Boolean(remote.public_price_intelligence),
    loaded: true
  } });
}

let intelligenceHydrationId = 0;

async function hydrateIntelligence() {
  const hydrationId = ++intelligenceHydrationId;
  const state = getState();
  const variantIds = intelligenceVariantIds(state.holdings, state.watchlistItems);
  if (!variantIds.length || !state.featureFlags.publicPriceIntelligence) {
    setState({ intelligence: { ...state.intelligence, byVariant: {}, loading: false, error: '' } });
    return;
  }
  const cached = await loadCachedIntelligence(variantIds);
  if (hydrationId !== intelligenceHydrationId) return;
  setState({ intelligence: { ...getState().intelligence, byVariant: cached, loading: true, error: '' } });
  try {
    const fresh = await refreshPublishedIntelligence(variantIds);
    if (hydrationId !== intelligenceHydrationId) return;
    const now = new Date().toISOString();
    const current = getState();
    const byVariant = { ...cached, ...fresh };
    const evaluated = evaluateWatchlistAlerts(current.watchlistItems, byVariant, now);
    const changedItems = evaluated.items.filter((entry, index) => entry !== current.watchlistItems[index]);
    await Promise.all([
      ...changedItems.map((entry) => putRecord('watchlistItems', entry)),
      ...evaluated.alerts.map((entry) => putRecord('alerts', entry))
    ]);
    const alerts = [...new Map([...current.alerts, ...evaluated.alerts].map((entry) => [entry.id, entry])).values()]
      .sort((left, right) => String(right.triggeredAt).localeCompare(String(left.triggeredAt)));
    setState({ intelligence: {
      byVariant,
      loading: false,
      error: '',
      lastRefresh: now
    }, watchlistItems: evaluated.items, alerts });
    if (evaluated.alerts.length) showToast(`${evaluated.alerts.length} Watchlist alert${evaluated.alerts.length === 1 ? '' : 's'} triggered`);
  } catch (error) {
    if (hydrationId !== intelligenceHydrationId) return;
    setState({ intelligence: {
      ...getState().intelligence,
      loading: false,
      error: error.message || 'Price intelligence could not be refreshed.'
    } });
  }
}

function navigate(view) {
  setState({ activeView: view });
  root.focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function option(value, selected, label = value) {
  return `<option value="${escapeAttribute(value)}" ${selected === value ? 'selected' : ''}>${escapeHTML(label)}</option>`;
}

function holdingForm(holding = null, { title = holding ? 'Edit holding' : 'Approve custom holding', image = '', item: proposedItem = null } = {}) {
  const item = holding?.item || proposedItem || {};
  const category = item.category || 'other';
  const visiblePriceOptions = catalogPriceOptionsForDisplay(item);
  const content = `<form id="holding-form">
    <div class="field-grid">
      <label class="span-all">Name<input name="name" required maxlength="160" value="${escapeAttribute(item.name || '')}" placeholder="e.g. 1989 Ken Griffey Jr. rookie"></label>
      <label>Category<select name="category">${[['pokemon','Pokémon'],['magic','Magic'],['yugioh','Yu-Gi-Oh!'],['sports','Sports'],['comics','Comics'],['slab','Graded slab'],['other','Other']].map(([value,label]) => option(value, category, label)).join('')}</select></label>
      <label>Game / type<input name="game" maxlength="80" value="${escapeAttribute(item.game || '')}" placeholder="Baseball, Marvel…"></label>
      <label>Set / series<input name="setName" maxlength="120" value="${escapeAttribute(item.setName || '')}"></label>
      <label>Number / issue<input name="number" maxlength="50" value="${escapeAttribute(item.number || '')}"></label>
      <label>Variant / rarity<input name="variant" maxlength="100" value="${escapeAttribute(item.variant || '')}"></label>
      <label>Year<input name="year" inputmode="numeric" maxlength="4" value="${escapeAttribute(item.year || '')}"></label>
      ${visiblePriceOptions.length ? `<label class="span-all">Variant / finish and provider price<select name="finish">${visiblePriceOptions.map((entry, index) => `<option value="${index}" ${entry.finish === item.variant ? 'selected' : ''}>${escapeHTML(entry.finish)} — ${escapeHTML(String(entry.price))} ${escapeHTML(item.currency || 'USD')}</option>`).join('')}</select><span class="fine-print">Changing finish snapshots that price; the full provider options remain stored.</span></label>` : ''}
      <label>Quantity<input name="quantity" type="number" min="1" step="1" value="${escapeAttribute(holding?.quantity || 1)}" required></label>
      <label>Condition<select name="condition">${['Mint','Near Mint','Excellent','Good','Played','Poor','Graded'].map((value) => option(value, holding?.condition || 'Near Mint')).join('')}</select></label>
      <label>Grade company<input name="gradeCompany" maxlength="40" value="${escapeAttribute(holding?.gradeCompany || '')}" placeholder="PSA, CGC, BGS"></label>
      <label>Grade<input name="grade" maxlength="20" value="${escapeAttribute(holding?.grade || '')}" placeholder="10"></label>
      <label>Purchase price (each)<input name="purchasePrice" type="number" min="0" step="0.01" value="${escapeAttribute(holding?.purchasePrice ?? '')}"></label>
      <label>Fees (total)<input name="fees" type="number" min="0" step="0.01" value="${escapeAttribute(holding?.fees ?? '')}"></label>
      <label>Purchase date<input name="purchaseDate" type="date" value="${escapeAttribute(holding?.purchaseDate || '')}"></label>
      <label>Manual unit value<input name="manualMarketPrice" type="number" min="0" step="0.01" value="${escapeAttribute(holding?.manualMarketPrice ?? '')}" placeholder="Overrides, but retains, provider price"></label>
      <label>Folder<input name="folder" maxlength="80" value="${escapeAttribute(holding?.folder || '')}"></label>
      <label class="span-all">Notes<textarea name="notes" maxlength="2000">${escapeHTML(holding?.notes || '')}</textarea></label>
      <label class="span-all">Your photo<input name="photo" type="file" accept="image/*"><span class="fine-print">Original source photos are never uploaded. This image stays in IndexedDB.</span></label>
    </div>
    <input type="hidden" name="existingImage" value="${escapeAttribute(image || holding?.userImage || '')}">
  </form>`;
  openModal({ title, content, actions: `<button class="button ghost" type="button" data-close-modal>Cancel</button><button class="button" type="submit" form="holding-form">${holding ? 'Save changes' : 'Approve and add'}</button>`, onOpen(layer) {
    layer.querySelector('#holding-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const submit = layer.querySelector('[type="submit"]');
      submit.disabled = true;
      try {
        const form = event.currentTarget;
        const data = Object.fromEntries(new FormData(form));
        const file = form.elements.photo.files[0];
        const userImage = file ? await fileToPortfolioImage(file) : data.existingImage;
        const providerItem = holding?.item || proposedItem || {};
        const finish = isRestrictedCatalogPrice(providerItem) ? null : providerItem.priceOptions?.[Number(data.finish)];
        await saveHolding({
          ...holding,
          item: { ...providerItem, id: providerItem.id || createId(), externalId: providerItem.externalId || '', provider: providerItem.provider || 'custom', category: data.category, game: data.game, name: data.name, setName: data.setName, number: data.number, variant: finish?.finish || data.variant, rarity: providerItem.rarity || '', year: data.year, image: providerItem.image || '', imageSmall: providerItem.imageSmall || '', price: finish?.price ?? providerItem.price ?? null, priceOptions: providerItem.priceOptions || [], currency: providerItem.currency || 'USD', priceSource: providerItem.priceSource || '', priceUrl: providerItem.priceUrl || '', priceUpdatedAt: providerItem.priceUpdatedAt || '' },
          quantity: data.quantity, condition: data.condition, gradeCompany: data.gradeCompany, grade: data.grade,
          purchasePrice: data.purchasePrice, purchaseDate: data.purchaseDate, fees: data.fees,
          manualMarketPrice: data.manualMarketPrice, folder: data.folder, notes: data.notes, userImage
        });
        closeModal();
        await loadLocal();
        await hydrateIntelligence();
        showToast(holding ? 'Holding updated' : `${data.name} added with your approval`);
      } catch (error) {
        showToast(error.message || 'Could not save holding', 'error');
        submit.disabled = false;
      }
    });
  }});
}

async function fileToPortfolioImage(file) {
  const source = await fileToImageDataURL(file);
  const image = await loadImage(source);
  return cropToJPEG(image, { x: 0, y: 0, width: image.naturalWidth || image.width, height: image.naturalHeight || image.height });
}

async function confirmDelete(id) {
  const holding = getState().holdings.find((entry) => entry.id === id);
  if (!holding) return;
  openModal({ title: 'Delete holding?', content: `<p><strong>${escapeHTML(holding.item?.name || 'This holding')}</strong> will be removed and a deletion tombstone will be saved for optional sync.</p>`, actions: '<button class="button ghost" data-close-modal>Cancel</button><button class="button danger" data-confirm-delete>Delete holding</button>', onOpen(layer) {
    layer.querySelector('[data-confirm-delete]').addEventListener('click', async () => {
      await removeHolding(id);
      closeModal();
      await loadLocal();
      await hydrateIntelligence();
      showToast('Holding deleted');
    });
  }});
}

async function exportJSON() {
  const backup = await exportBackup();
  downloadFile(`collectfolio-backup-${new Date().toISOString().slice(0, 10)}.json`, `${JSON.stringify(backup, null, 2)}\n`, 'application/json');
  showToast('Full JSON backup exported');
}

async function importJSON(file) {
  if (!file) return;
  try {
    await importBackup(JSON.parse(await file.text()));
    await loadLocal();
    await hydrateIntelligence();
    showToast('Backup merged into this device');
  } catch (error) {
    showToast(error.message || 'Backup import failed', 'error');
  }
}

async function exportCSV() {
  downloadFile(`collectfolio-holdings-${new Date().toISOString().slice(0, 10)}.csv`, await exportHoldingsCSV(), 'text/csv;charset=utf-8');
  showToast('Holdings CSV exported');
}

async function loadDemo() {
  const now = new Date();
  const demo = [
    { id: '00000000-0000-4000-8000-000000000001', catalogId: 'demo:black-lotus', item: { id: 'demo:black-lotus', externalId: 'demo-1', provider: 'custom', category: 'magic', game: 'Magic', name: 'Black Lotus — Proxy Demo', setName: 'Demo catalog', number: '#233', variant: 'Display only', rarity: 'Rare', year: '1993', image: '', imageSmall: '', price: 720, priceOptions: [{ finish: 'regular', price: 720 }], currency: 'USD', priceSource: 'Demo price', priceUrl: '', priceUpdatedAt: now.toISOString() }, quantity: 1, condition: 'Near Mint', purchasePrice: 500, fees: 0, folder: 'Main collection', notes: 'Demonstration record; not a genuine appraisal.' },
    { id: '00000000-0000-4000-8000-000000000002', catalogId: 'demo:charizard', item: { id: 'demo:charizard', externalId: 'demo-2', provider: 'custom', category: 'pokemon', game: 'Pokémon', name: 'Charizard — Base Set', setName: 'Base Set', number: '4/102', variant: 'Holo', rarity: 'Rare Holo', year: '1999', image: '', imageSmall: '', price: 385, priceOptions: [], currency: 'USD', priceSource: 'Demo price', priceUrl: '', priceUpdatedAt: now.toISOString() }, quantity: 1, condition: 'Good', purchasePrice: 250, fees: 20, folder: 'Main collection' },
    { id: '00000000-0000-4000-8000-000000000003', catalogId: 'demo:sports', item: { id: 'demo:sports', externalId: 'demo-3', provider: 'custom', category: 'sports', game: 'Basketball', name: 'Smoke Test Sports Card', setName: 'Rookie showcase', number: '23', variant: 'Base', rarity: '', year: '1996', image: '', imageSmall: '', price: null, priceOptions: [], currency: 'USD', priceSource: '', priceUrl: '', priceUpdatedAt: '' }, quantity: 1, condition: 'Graded', gradeCompany: 'PSA', grade: '9', purchasePrice: 75, fees: 5, manualMarketPrice: 142, folder: 'Slabs' },
    { id: '00000000-0000-4000-8000-000000000004', catalogId: 'demo:comic', item: { id: 'demo:comic', externalId: 'demo-4', provider: 'custom', category: 'comics', game: 'Comic', name: 'Demo Variant Comic', setName: 'Collector issue', number: '1', variant: 'Cover B', rarity: '', year: '2024', image: '', imageSmall: '', price: null, priceOptions: [], currency: 'USD', priceSource: '', priceUrl: '', priceUpdatedAt: '' }, quantity: 1, condition: 'Near Mint', purchasePrice: 10, fees: 0, manualMarketPrice: 85, folder: 'Comics' }
  ];
  for (const holding of demo) await saveHolding(holding);
  for (let day = 4; day >= 1; day--) {
    const date = new Date(now);
    date.setDate(date.getDate() - day * 20);
    const factor = 1 - day * 0.06;
    await putRecord('snapshots', { id: `portfolio:${date.toISOString().slice(0, 10)}`, date: date.toISOString().slice(0, 10), pricingPolicyVersion: PRICING_POLICY_VERSION, marketValue: 1332 * factor, costBasis: day > 2 ? 585 : 860, uniqueItems: day > 2 ? 3 : 4, totalQuantity: day > 2 ? 3 : 4, updatedAt: date.toISOString() });
  }
  await loadLocal();
  showToast('Demo collection loaded');
}

async function runCatalogSearch(form) {
  const data = Object.fromEntries(new FormData(form));
  setState({ search: { ...getState().search, query: data.query, category: data.category, provider: data.provider, loading: true, results: [], warnings: [], cached: false } });
  try {
    const response = await searchCatalog(data);
    setState({ search: { ...getState().search, loading: false, ...response } });
    if (response.manual) showToast('This category uses custom entry so coverage is not overstated', 'warning');
    else if (!response.results.length) showToast('No catalog candidates found', 'warning');
  } catch (error) {
    setState({ search: { ...getState().search, loading: false, warnings: [error.message || 'Search failed'], results: [] } });
  }
}

async function refreshPrices() {
  const holdings = getState().holdings.filter((holding) => holding.item?.provider && holding.item.provider !== 'custom');
  if (!holdings.length) { showToast('There are no provider-linked holdings to refresh', 'warning'); return; }
  showToast(`Refreshing ${holdings.length} provider-linked holding${holdings.length === 1 ? '' : 's'}…`, 'warning');
  let refreshed = 0;
  let failed = 0;
  for (const holding of holdings) {
    try {
      const item = await refreshCatalogItem(holding.item);
      await saveHolding({ ...holding, item, lastPriceRefresh: new Date().toISOString() });
      refreshed++;
    } catch {
      failed++;
    }
  }
  await loadLocal();
  showToast(`Refreshed ${refreshed}; ${failed} failed without losing saved prices`, failed ? 'warning' : 'success');
}

function confirmClear() {
  openModal({ title: 'Clear all local data?', content: '<p>This cannot be undone from this device unless you exported a backup. Type <strong>CLEAR</strong> to confirm.</p><label>Confirmation<input id="clear-confirm" autocomplete="off"></label>', actions: '<button class="button ghost" data-close-modal>Cancel</button><button class="button danger" data-clear-confirmed disabled>Clear this device</button>', onOpen(layer) {
    const input = layer.querySelector('#clear-confirm');
    const button = layer.querySelector('[data-clear-confirmed]');
    input.addEventListener('input', () => { button.disabled = input.value !== 'CLEAR'; });
    button.addEventListener('click', async () => {
      await clearLocalData();
      closeModal();
      await loadLocal();
      await hydrateIntelligence();
      showToast('Local CollectFolio data cleared');
    });
  }});
}

function openAuth() {
  openModal({ title: 'Optional cloud account', content: `<form id="auth-form"><div class="field-grid"><label class="span-all">Email<input name="email" type="email" autocomplete="email" required></label><label class="span-all">Password<input name="password" type="password" autocomplete="current-password" minlength="6"></label></div><p class="fine-print">Your local portfolio remains available if you cancel or sign out.</p></form>`, actions: '<button class="button ghost" data-close-modal>Cancel</button><button class="button secondary" type="button" data-magic-link>Send magic link</button><button class="button secondary" type="submit" name="authAction" value="signup" form="auth-form">Create account</button><button class="button" type="submit" name="authAction" value="signin" form="auth-form">Sign in</button>', onOpen(layer) {
    const form = layer.querySelector('#auth-form');
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(form));
      const buttons = layer.querySelectorAll('button');
      buttons.forEach((button) => { button.disabled = true; });
      try {
        const session = event.submitter.value === 'signup' ? await signUp(data.email, data.password) : await signIn(data.email, data.password);
        if (session) {
          setState({ auth: { ...getState().auth, session } });
          closeModal();
          showToast('Cloud account connected');
        } else {
          showToast('Check your email to finish creating the account', 'warning', 7000);
          buttons.forEach((button) => { button.disabled = false; });
        }
      } catch (error) {
        showToast(error.message || 'Authentication failed', 'error');
        buttons.forEach((button) => { button.disabled = false; });
      }
    });
    layer.querySelector('[data-magic-link]').addEventListener('click', async () => {
      const email = form.elements.email.value;
      if (!email) { form.elements.email.reportValidity(); return; }
      try { await requestMagicLink(email); closeModal(); showToast('Magic link sent; check your email'); }
      catch (error) { showToast(error.message || 'Could not send magic link', 'error'); }
    });
  }});
}

async function syncNow() {
  setState({ auth: { ...getState().auth, syncing: true } });
  try {
    const result = await syncAll();
    await loadLocal();
    await hydrateIntelligence();
    const watchlist = result.watchlist ? `, ${result.watchlist.items} watched cards, and ${result.watchlist.deletions} watch tombstones` : '';
    showToast(`Synced ${result.holdings} holdings and ${result.deletions} deletion tombstones${watchlist}${result.omittedImages ? `; ${result.omittedImages} large crops stayed local` : ''}`);
    if (result.watchlistError) showToast(`Portfolio synced; ${result.watchlistError}`, 'warning', 8000);
  } catch (error) {
    showToast(error.message || 'Cloud sync failed', 'error', 8000);
  } finally {
    setState({ auth: { ...getState().auth, syncing: false } });
  }
}

async function requestPriceRefreshAction() {
  setState({ auth: { ...getState().auth, refreshingPrices: true } });
  try {
    const result = await requestPriceRefresh();
    // Deliberately no loadLocal()/hydrateIntelligence() here: this request
    // never writes anything local, and nothing about a displayed price
    // changes — it only asks the private research collector to prioritize
    // these cards on its next pass.
    showToast(result.message, result.outcome === 'ok' ? 'success' : 'warning', 8000);
  } catch (error) {
    showToast(error.message || 'Price refresh request failed', 'error', 8000);
  } finally {
    setState({ auth: { ...getState().auth, refreshingPrices: false } });
  }
}

async function toggleWatchedItem(item, options = {}) {
  if (!item || getState().featureFlags.watchlists === false) return;
  const existing = findWatchedItem(getState().watchlistItems, item, options);
  if (existing) {
    await unwatchItem(existing.watchKey);
    showToast('Removed from Watchlist');
  } else {
    await watchItem(item, options);
    showToast('Added to Watchlist');
  }
  await loadLocal();
  await hydrateIntelligence();
}

async function chooseWatchVariant(item) {
  const finishes = catalogPriceOptionsForDisplay(item);
  if (finishes.length <= 1) {
    await toggleWatchedItem(item);
    return;
  }
  const options = finishes.map((finish, index) => {
    const candidate = { ...item, variant: finish.finish, finish: finish.finish, price: finish.price };
    const watching = Boolean(findWatchedItem(getState().watchlistItems, candidate));
    return `<option value="${index}">${escapeHTML(finish.finish)} — ${escapeHTML(String(finish.price))} ${escapeHTML(item.currency || 'USD')}${watching ? ' · Watching' : ''}</option>`;
  }).join('');
  openModal({
    title: 'Choose exact finish to watch',
    content: `<form id="watch-finish-form"><label>Variant / finish<select name="finish">${options}</select></label><p class="fine-print">Each finish is tracked independently. Selecting one already watched will remove it.</p></form>`,
    actions: '<button class="button ghost" type="button" data-close-modal>Cancel</button><button class="button" type="submit" form="watch-finish-form">Update Watchlist</button>',
    onOpen(layer) {
      layer.querySelector('#watch-finish-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const finish = finishes[Number(new FormData(event.currentTarget).get('finish'))];
        if (!finish) return;
        closeModal();
        await toggleWatchedItem({ ...item, variant: finish.finish, finish: finish.finish, price: finish.price, priceSource: finish.source || item.priceSource });
      });
    }
  });
}

function watchlistPreferencesForm(entry) {
  const content = `<form id="watch-preferences-form"><div class="field-grid">
    <label>Target price<input name="targetPrice" type="number" min="0" step="0.01" value="${escapeAttribute(entry.targetPrice ?? '')}"></label>
    <label>Percent-change alert<input name="alertPercentChange" type="number" min="0" step="0.1" value="${escapeAttribute(entry.alertPercentChange ?? '')}"></label>
    <label class="checkbox"><input name="alertTrendChange" type="checkbox" ${entry.alertTrendChange ? 'checked' : ''}> Trend changes</label>
    <label class="checkbox"><input name="alertRangeChange" type="checkbox" ${entry.alertRangeChange ? 'checked' : ''}> Fair-value position changes</label>
    <label class="checkbox"><input name="alertForecastChange" type="checkbox" ${entry.alertForecastChange ? 'checked' : ''}> Forecast changes</label>
    <label class="span-all">Notes<textarea name="notes" maxlength="2000">${escapeHTML(entry.notes || '')}</textarea></label>
  </div><p class="fine-print">Preferences are saved now. Signal alerts are evaluated only after approved intelligence data becomes available.</p></form>`;
  openModal({
    title: `Watch settings · ${entry.catalogRef?.name || 'Card'}`,
    content,
    actions: '<button class="button ghost" type="button" data-close-modal>Cancel</button><button class="button" type="submit" form="watch-preferences-form">Save preferences</button>',
    onOpen(layer) {
      layer.querySelector('#watch-preferences-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const data = Object.fromEntries(new FormData(form));
        await watchItem({ ...entry.catalogRef, variant: entry.catalogRef.finish }, {
          canonicalVariantId: entry.canonicalVariantId,
          conditionClass: entry.catalogRef.conditionClass,
          targetPrice: data.targetPrice,
          alertPercentChange: data.alertPercentChange,
          alertTrendChange: form.elements.alertTrendChange.checked,
          alertRangeChange: form.elements.alertRangeChange.checked,
          alertForecastChange: form.elements.alertForecastChange.checked,
          notes: data.notes
        });
        closeModal();
        await loadLocal();
        showToast('Watch preferences saved');
      });
    }
  });
}

function chooseScanImage(single) {
  openModal({ title: single ? 'Scan one item' : 'Scan multiple items', content: `<p>Choose a camera or library image. Detection, cropping, and OCR run in this browser.</p><label>Source photo<input id="scan-source" type="file" accept="image/*" capture="environment"></label><p class="fine-print">The full source photo is held only while you edit boundaries and is never uploaded.</p>`, actions: '<button class="button ghost" data-close-modal>Cancel</button>', onOpen(layer) {
    layer.querySelector('#scan-source').addEventListener('change', async (event) => {
      const file = event.target.files[0];
      if (!file) return;
      try {
        const source = await fileToImageDataURL(file);
        const image = await loadImage(source);
        closeModal();
        openWorkbench(image, single);
      } catch (error) {
        showToast(error.message || 'Could not open image', 'error');
      }
    });
  }});
}

function openWorkbench(image, single) {
  let editor;
  openModal({ title: 'Edit crop boundaries', content: `<div class="workbench"><p class="muted">Tap a box to select it, drag inside to move, or drag its lower-right handle to resize.</p><div class="canvas-wrap"><canvas id="scan-canvas" aria-label="Editable crop boundary canvas"></canvas></div><div class="workbench-tools"><button class="button secondary small" type="button" data-workbench="add">Draw new</button><button class="button secondary small" type="button" data-workbench="delete">Delete selected</button><button class="button secondary small" type="button" data-workbench="retry">Retry detection</button></div><div class="grid-controls"><label>Rows<input id="grid-rows" type="number" min="1" max="12" value="3"></label><label>Columns<input id="grid-columns" type="number" min="1" max="12" value="3"></label><button class="button secondary" type="button" data-workbench="grid">Apply grid</button></div><p id="boundary-count" class="fine-print"></p></div>`, actions: '<button class="button ghost" data-close-modal>Cancel</button><button class="button" type="button" data-workbench="continue">Create review crops</button>', onOpen(layer) {
    const count = layer.querySelector('#boundary-count');
    const updateCount = (boxes) => { count.textContent = `${boxes.length} editable ${boxes.length === 1 ? 'boundary' : 'boundaries'}`; };
    editor = new ScanWorkbench(layer.querySelector('#scan-canvas'), image, { single, onChange: updateCount });
    editor.detect();
    updateCount(editor.boxes);
    layer.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-workbench]');
      if (!button) return;
      const action = button.dataset.workbench;
      if (action === 'add') editor.setAddMode();
      if (action === 'delete') editor.deleteSelected();
      if (action === 'retry') editor.detect();
      if (action === 'grid') editor.applyGrid(layer.querySelector('#grid-rows').value, layer.querySelector('#grid-columns').value);
      if (action === 'continue') {
        if (!editor.boxes.length) { showToast('Add at least one crop boundary', 'warning'); return; }
        button.disabled = true;
        const draft = createScanDraft(cropsFromBoxes(image, editor.boxes), single ? 'single' : 'multi');
        await saveScanDraft(draft);
        activeDraft = draft;
        editor.destroy();
        closeModal();
        await loadLocal();
        navigate('scan');
        showToast('Review crops created on this device');
      }
    });
  }});
}

async function resumeScan() {
  const scans = (await getAll('scans')).filter((scan) => scan.status !== 'complete').sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  if (!scans.length) { showToast('No saved scan is waiting', 'warning'); return; }
  activeDraft = scans[0];
  const recovered = recoverInterruptedIdentifications(activeDraft);
  if (recovered) await saveScanDraft(activeDraft);
  navigate('scan');
  if (recovered) showToast('Interrupted identification was reset for retry', 'warning');
}

function customCropForm(cropId) {
  openModal({ title: 'Create custom match for crop', content: `<form id="crop-custom-form"><div class="field-grid"><label class="span-all">Name<input name="name" required maxlength="160"></label><label>Category<select name="category"><option value="sports">Sports</option><option value="comics">Comics</option><option value="slab">Graded slab</option><option value="other" selected>Other</option><option value="pokemon">Pokémon</option><option value="magic">Magic</option><option value="yugioh">Yu-Gi-Oh!</option></select></label><label>Game / type<input name="game" maxlength="80"></label><label>Set / series<input name="setName" maxlength="120"></label><label>Number / issue<input name="number" maxlength="50"></label><label>Variant / rarity<input name="variant" maxlength="100"></label><label>Manual unit value<input name="price" type="number" min="0" step="0.01"></label></div></form>`, actions: '<button class="button ghost" data-close-modal>Cancel</button><button class="button" type="submit" form="crop-custom-form">Select custom item</button>', onOpen(layer) {
    layer.querySelector('#crop-custom-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(event.currentTarget));
      await setCropCustomItem(activeDraft, cropId, { category: data.category, game: data.game, name: data.name, setName: data.setName, number: data.number, variant: data.variant, rarity: '', year: '', price: data.price === '' ? null : Number(data.price), priceSource: data.price === '' ? '' : 'Manual value', priceUrl: '', priceUpdatedAt: data.price === '' ? '' : new Date().toISOString() });
      closeModal();
      render();
      showToast('Custom item selected; approve it to include this crop');
    });
  }});
}

root.addEventListener('click', async (event) => {
  const go = event.target.closest('[data-go]');
  if (go) { navigate(go.dataset.go); return; }
  const section = event.target.closest('[data-portfolio-section]');
  if (section) {
    setState({ portfolio: { ...getState().portfolio, section: section.dataset.portfolioSection } });
    return;
  }
  const action = event.target.closest('[data-action]');
  if (!action) return;
  const id = action.dataset.id;
  if (action.dataset.action === 'custom-holding') {
    const category = action.dataset.category;
    holdingForm(null, category ? { item: { provider: 'custom', category } } : {});
  }
  if (action.dataset.action === 'add-catalog') {
    const item = getState().search.results[Number(action.dataset.index)];
    if (item) holdingForm(null, { title: 'Review catalog match', item });
  }
  if (action.dataset.action === 'toggle-watch') {
    let item = null;
    let options = {};
    let chooseFinish = false;
    if (action.dataset.index !== undefined) {
      item = getState().search.results[Number(action.dataset.index)];
      chooseFinish = catalogPriceOptionsForDisplay(item).length > 1;
    }
    if (action.dataset.holdingId) {
      const holding = getState().holdings.find((entry) => entry.id === action.dataset.holdingId);
      item = holding?.item;
      options = { canonicalVariantId: holding?.canonicalVariantId, conditionClass: holding?.grade ? 'graded' : 'raw' };
    }
    if (action.dataset.cropWatch && activeDraft) {
      const crop = activeDraft.crops.find((entry) => entry.id === action.dataset.cropWatch);
      item = crop?.customItem || crop?.candidates.find((candidate) => candidate.id === crop.selectedId);
      chooseFinish = catalogPriceOptionsForDisplay(item).length > 1;
    }
    if (chooseFinish) await chooseWatchVariant(item); else await toggleWatchedItem(item, options);
  }
  if (action.dataset.action === 'remove-watch') {
    await unwatchItem(action.dataset.watchKey);
    await loadLocal();
    await hydrateIntelligence();
    showToast('Removed from Watchlist');
  }
  if (action.dataset.action === 'edit-watch') {
    const watched = getState().watchlistItems.find((entry) => entry.watchKey === action.dataset.watchKey);
    if (watched) watchlistPreferencesForm(watched);
  }
  if (action.dataset.action === 'add-watched') {
    const watched = getState().watchlistItems.find((entry) => entry.watchKey === action.dataset.watchKey);
    if (watched) holdingForm(null, { title: 'Add watched card to portfolio', item: { ...watched.catalogRef, variant: watched.catalogRef.finish, canonicalVariantId: watched.canonicalVariantId } });
  }
  if (action.dataset.action === 'edit-holding') holdingForm(getState().holdings.find((entry) => entry.id === id));
  if (action.dataset.action === 'delete-holding') confirmDelete(id);
  if (action.dataset.action === 'export-json') exportJSON();
  if (action.dataset.action === 'import-json') document.querySelector('#backup-file')?.click();
  if (action.dataset.action === 'export-csv') exportCSV();
  if (action.dataset.action === 'load-demo') {
    openModal({ title: 'Add demo collection?', content: '<p>This will add four clearly labeled demonstration holdings. They use sample values, not appraisals.</p>', actions: '<button class="button ghost" data-close-modal>Cancel</button><button class="button" data-approve-demo>Approve demo holdings</button>', onOpen(layer) {
      layer.querySelector('[data-approve-demo]').addEventListener('click', async () => { closeModal(); await loadDemo(); });
    }});
  }
  if (action.dataset.action === 'clear-data') confirmClear();
  if (action.dataset.action === 'open-auth') openAuth();
  if (action.dataset.action === 'sync-now') syncNow();
  if (action.dataset.action === 'request-price-refresh') requestPriceRefreshAction();
  if (action.dataset.action === 'sign-out') { await signOut(); setState({ auth: { session: null, syncing: false } }); showToast('Signed out; local portfolio is unchanged'); }
  if (action.dataset.action === 'refresh-prices') refreshPrices();
  if (action.dataset.action === 'start-multi-scan') chooseScanImage(false);
  if (action.dataset.action === 'start-single-scan') chooseScanImage(true);
  if (action.dataset.action === 'resume-scan') resumeScan();
  if (action.dataset.action === 'save-scan' && activeDraft) { await saveScanDraft(activeDraft); await loadLocal(); showToast('Scan saved on this device'); }
  if (action.dataset.action === 'identify-crop' && activeDraft) {
    const card = action.closest('[data-crop-id]');
    const query = card.querySelector('[data-crop-query]').value;
    activeDraft.crops.find((crop) => crop.id === id).status = 'identifying';
    render();
    await identifyCrop(activeDraft, id, query);
    render();
  }
  if (action.dataset.action === 'select-candidate' && activeDraft) { await selectCropCandidate(activeDraft, id, action.dataset.candidate); render(); }
  if (action.dataset.action === 'approve-crop' && activeDraft) {
    try { await setCropApproval(activeDraft, id, action.dataset.approved !== 'true'); render(); }
    catch (error) { showToast(error.message, 'warning'); }
  }
  if (action.dataset.action === 'custom-crop' && activeDraft) customCropForm(id);
  if (action.dataset.action === 'delete-crop' && activeDraft) { await deleteCrop(activeDraft, id); render(); showToast('Crop removed from this review'); }
  if (action.dataset.action === 'batch-add' && activeDraft) {
    const count = await batchAddApproved(activeDraft);
    activeDraft = null;
    await loadLocal();
    await hydrateIntelligence();
    navigate('portfolio');
    showToast(`${count} explicitly approved crop${count === 1 ? '' : 's'} added`);
  }
});

root.addEventListener('submit', (event) => {
  if (event.target.matches('#catalog-search')) {
    event.preventDefault();
    runCatalogSearch(event.target);
  }
});

root.addEventListener('input', (event) => {
  if (activeDraft && event.target.matches('[data-crop-query]')) {
    const cropId = event.target.closest('[data-crop-id]')?.dataset.cropId;
    const crop = activeDraft.crops.find((entry) => entry.id === cropId);
    if (crop) crop.query = event.target.value;
  }
});

root.addEventListener('change', async (event) => {
  if (event.target.matches('[data-portfolio-query]')) setState({ portfolio: { ...getState().portfolio, query: event.target.value } });
  if (event.target.matches('[data-portfolio-category]')) setState({ portfolio: { ...getState().portfolio, category: event.target.value } });
  if (event.target.matches('[data-portfolio-sort]')) setState({ portfolio: { ...getState().portfolio, sort: event.target.value } });
  if (event.target.matches('[data-setting]')) {
    const key = event.target.dataset.setting;
    const value = event.target.value;
    await putRecord('settings', { key, value });
    if (key === 'theme') document.documentElement.dataset.theme = value;
    setState({ settings: { ...getState().settings, [key]: value } });
    showToast('Setting saved');
  }
  if (event.target.matches('#backup-file')) {
    await importJSON(event.target.files[0]);
    event.target.value = '';
  }
});

document.querySelector('.bottom-nav').addEventListener('click', (event) => {
  const button = event.target.closest('[data-view]');
  if (button) navigate(button.dataset.view);
});

subscribe(render);
render();
initializeAuth();
loadLocal().then(loadFeatureFlags).then(hydrateIntelligence).catch((error) => {
  setState({ ready: true });
  showToast(error.message || 'Could not open local portfolio', 'error', 8000);
});

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}
