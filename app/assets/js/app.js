import { clearApplicationCacheStorage, clearLocalData, exportBackup, exportHoldingsCSV, getAll, importBackup, putRecord, readBackupFile, recordDailySnapshot, recordLocalHoldingObservations, removeHolding, saveHolding } from './core/db.js';
import { portfolioSnapshotId } from './core/calculations.js';
import { evaluateWatchlistAlerts } from './core/intelligence-alerts.js';
import { INSIGHTS_HORIZONS, INSIGHTS_VIEWS } from './core/insights.js';
import {
  catalogPriceOptionsForDisplay,
  currentPricingSnapshots,
  isRestrictedCatalogPrice,
  PRICING_POLICY_VERSION
} from './core/pricing-policy.js';
import { appRouteForLegacyView, currentAppPath, parseAppRoute, primaryDestination, routeStatePatch } from './core/router.js';
import {
  appendSyncHistory,
  friendlyCloudError,
  migrateSettingsRecords,
  pendingSyncChanges,
  CURRENCIES,
  SETTINGS_DEFAULTS,
  syncDiagnosticReference
} from './core/settings.js';
import { getState, setState, subscribe } from './core/store.js';
import { closeModal, openModal, showToast } from './core/ui.js';
import { createId, downloadFile, escapeAttribute, escapeHTML, safeImageUrl } from './core/utils.js';
import { shellViewModel } from './core/view-models.js';
import { catalogRouteId, clearCatalogProviderCaches, getCatalogRouteItem, refreshCatalogItem, searchCatalog } from './services/catalog.js';
import { catalogGameRequiresSession, clearBrowseCatalogCache, loadCatalogGames, loadCatalogSetProducts, loadCatalogSets, mergeCatalogGames } from './services/catalog-browse.js';
import { cropsFromBoxes, cropToJPEG, fileToImageDataURL, loadImage, releaseOCRWorker } from './services/image.js';
import { intelligenceVariantIds, loadCachedIntelligence, loadIntelligenceHistory, mergePublicationHistory, refreshPublishedIntelligence } from './services/price-intelligence.js';
import { requestPriceRefresh } from './services/justtcg-refresh.js';
import { fetchTcgcsvRefreshStatus } from './services/tcgcsv-refresh-status.js';
import { mergeDemandOptOut, recordDemandEvent, syncDemandEvents } from './services/demand-events.js';
import { applyAcquisitionToAll, batchAddApproved, createScanDraft, deleteCrop, identifyCrop, identifyDraftCrops, maintainCompletedScans, recoverInterruptedIdentifications, saveScanDraft, selectCropCandidate, setCropAcquisition, setCropApproval, setCropCustomItem } from './services/scan-review.js';
import { ScanWorkbench } from './services/scan-workbench.js';
import { consumeAuthCallback, fetchDemandAnalyticsOptOut, fetchPublicFeatureFlags, isSupabaseConfigured, loadSession, pushDemandAnalyticsOptOut, removeCloudData, requestMagicLink, signIn, signOut, signUp, syncAll } from './services/supabase.js';
import { findWatchedItem, unwatchItem, watchItem } from './services/watchlist.js';
import { renderAdd } from './views/add.js';
import { OVERVIEW_RANGES, renderHome } from './views/home.js';
import { renderHoldingForm } from './views/holding-form.js';
import { renderInsights } from './views/insights.js';
import { renderOnboarding } from './views/onboarding.js';
import { PORTFOLIO_SET_PAGE_SIZE, PORTFOLIO_VIEWS, renderPortfolio } from './views/portfolio.js';
import { renderPriceIntelligenceDetail } from './views/price-intelligence-detail.js';
import { renderProfile } from './views/profile.js';
import { renderQuickInspector } from './views/quick-inspector.js';
import { BROWSE_PRODUCTS_PAGE_SIZE, BROWSE_SETS_PAGE_SIZE, DISCOVER_RESULTS_PAGE_SIZE, DISCOVER_VIEWS, renderSearch } from './views/search.js';
import { renderScanReview } from './views/scan.js';
import { catalogReferenceForItem } from './core/catalog-identity.js';
import { buildComparison, COMPARE_LIMIT, toggleCompareSelection } from './core/compare.js';

const root = document.querySelector('#main-content');
let activeDraft = null;
let activeDetail = null;
let activeRoute = parseAppRoute(location);
let inspectorReturnTarget = null;
let inspectorWasOpen = false;
let searchGeneration = 0;
let browseGeneration = 0;
let catalogGamesGeneration = 0;
let browseFilterTimer = null;
let routeHydrationId = 0;
let identificationRun = 0;

function startDraftIdentification(draft) {
  if (!draft?.id || !(draft.crops || []).some((crop) => crop.status === 'queued')) return;
  const run = ++identificationRun;
  identifyDraftCrops(draft, { concurrency: 1 }).catch(async (error) => {
    if (activeDraft?.id === draft.id) showToast(error?.message || 'Automatic identification stopped. Retry the unresolved card.', 'error');
  }).finally(async () => {
    if (run !== identificationRun || activeDraft?.id !== draft.id) return;
    await loadLocal();
    render();
  });
}

setState(routeStatePatch(activeRoute, getState()));

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
  const views = { home: renderHome, search: renderSearch, add: renderAdd, portfolio: renderPortfolio, insights: renderInsights, profile: renderProfile, scan: () => renderScanReview(activeDraft, state), detail: () => renderPriceIntelligenceDetail(activeDetail, state) };
  const inspectorOpen = Boolean(state.ready && state.activeView === 'detail' && history.state?.inspector && activeDetail);
  const onboardingVisible = state.ready
    && !state.settings.onboardingComplete
    && !state.settings.onboardingSkipped
    && !['add', 'scan'].includes(state.activeView);
  if (!state.ready) root.innerHTML = '<section class="empty-state"><h1>CollectFolio</h1><p>Opening your local portfolio…</p></section>';
  else if (onboardingVisible) root.innerHTML = renderOnboarding(state);
  else if (inspectorOpen) {
    const underlay = activeDetail.origin === 'search' ? renderSearch(state) : activeDetail.origin === 'insights' ? renderInsights(state) : renderPortfolio(state);
    root.innerHTML = `<div class="inspector-underlay" inert aria-hidden="true">${underlay}</div>${renderQuickInspector(activeDetail, state)}`;
  } else root.innerHTML = (views[state.activeView] || renderHome)(state);
  const destination = primaryDestination(state.route || activeRoute);
  document.querySelectorAll('.primary-nav [data-nav]').forEach((button) => {
    const selected = button.dataset.nav === destination;
    button.classList.toggle('active', selected);
    if (selected) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  });
  const shell = shellViewModel(state);
  document.querySelectorAll('[data-portfolio-label]').forEach((element) => { element.textContent = shell.portfolioLabel; });
  document.querySelectorAll('[data-sync-label]').forEach((element) => { element.textContent = shell.syncLabel; });
  document.querySelectorAll('[data-sync-status]').forEach((element) => { element.dataset.syncStatus = shell.syncStatus; });
  document.querySelectorAll('[data-account-label]').forEach((element) => { element.textContent = shell.accountLabel; });
  document.querySelectorAll('[data-search-label]').forEach((element) => { element.textContent = shell.searchQuery || 'Search cards'; });
  if (inspectorOpen && !inspectorWasOpen) {
    queueMicrotask(() => root.querySelector('.quick-inspector [data-action="close-detail"]')?.focus({ preventScroll: true }));
  } else if (!inspectorOpen && inspectorWasOpen && inspectorReturnTarget) {
    const target = inspectorReturnTarget;
    queueMicrotask(() => {
      const origin = [...root.querySelectorAll('[data-action="open-detail"]')].find((element) =>
        ['index', 'holdingId', 'watchKey', 'catalogScope'].every((key) => target[key] === undefined || element.dataset[key] === target[key]));
      origin?.focus({ preventScroll: true });
      inspectorReturnTarget = null;
    });
  }
  inspectorWasOpen = inspectorOpen;
}

function runtimeFlag(name, fallback = false) {
  const value = globalThis.window?.COLLECTFOLIO_CONFIG?.[name];
  if (value === undefined) return fallback;
  return /^(1|true|yes)$/i.test(String(value));
}

async function hydrateTcgcsvRefreshStatus() {
  const endpoint = String(globalThis.window?.COLLECTFOLIO_CONFIG?.TCGCSV_REFRESH_STATUS_URL ?? '').trim();
  if (!endpoint) return;
  setState({ tcgcsvRefresh: { ...getState().tcgcsvRefresh, status: 'loading', error: '' } });
  try {
    setState({ tcgcsvRefresh: await fetchTcgcsvRefreshStatus(endpoint) });
  } catch (error) {
    setState({ tcgcsvRefresh: {
      ...getState().tcgcsvRefresh,
      status: 'unavailable',
      error: error instanceof Error ? error.message : 'Refresh status is unavailable'
    } });
  }
}

async function loadLocal() {
  const [holdings, snapshots, initialLocalValueObservations, settingsRecords, scans, watchlistItems, alerts, deletions, watchlistDeletions, demandEvents] = await Promise.all([
    getAll('holdings'), getAll('snapshots'), getAll('localValueObservations'), getAll('settings'),
    getAll('scans'), getAll('watchlistItems'), getAll('alerts'), getAll('deletions'),
    getAll('watchlistDeletions'), getAll('demandEventsQueue')
  ]);
  // Covers a v5 database populated from an older portable fixture after the
  // upgrade already ran. Normal v4 upgrades are seeded atomically in db.js.
  let localValueObservations = initialLocalValueObservations;
  if (holdings.length && !localValueObservations.length) {
    await recordLocalHoldingObservations(holdings);
    localValueObservations = await getAll('localValueObservations');
  }
  const retainedScans = await maintainCompletedScans(scans);
  const migration = migrateSettingsRecords(settingsRecords, { hasHoldings: holdings.length > 0 });
  if (migration.updates.length) await Promise.all(migration.updates.map((record) => putRecord('settings', record)));
  const settings = migration.settings;
  const scanDrafts = retainedScans.filter((scan) => scan.status !== 'complete')
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  if (activeRoute.key === 'add-review') {
    activeDraft = scanDrafts[0] || null;
    if (activeDraft && recoverInterruptedIdentifications(activeDraft)) await saveScanDraft(activeDraft);
  }
  document.documentElement.dataset.theme = settings.theme;
  const pendingChanges = pendingSyncChanges(holdings, deletions, watchlistItems, watchlistDeletions, demandEvents);
  const auth = getState().auth;
  const nextState = {
    ...getState(),
    holdings,
    snapshots: currentPricingSnapshots(snapshots, settings.currency).sort((a, b) => a.date.localeCompare(b.date)),
    localValueObservations,
    scanDrafts,
    watchlistItems: watchlistItems.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))),
    compare: (getState().compare || []).filter((key) => watchlistItems.some((entry) => entry.watchKey === key)),
    alerts: alerts.sort((a, b) => String(b.triggeredAt).localeCompare(String(a.triggeredAt))),
    settings,
    search: {
      ...getState().search,
      provider: activeRoute.key === 'discover'
        ? getState().search.provider
        : settings.preferredMarketSource
    },
    insights: {
      ...getState().insights,
      horizon: activeRoute.key === 'insights'
        ? getState().insights.horizon
        : settings.defaultForecastHorizon
    },
    auth: {
      ...auth,
      online: navigator.onLine !== false,
      pendingChanges,
      status: navigator.onLine === false
        ? 'offline'
        : auth.syncing
          ? 'syncing'
          : auth.error
            ? 'error'
            : !auth.session
              ? 'local'
              : (pendingChanges || !settings.lastSyncedAt ? 'pending' : 'synced')
    },
    featureFlags: getState().featureFlags.loaded
      ? getState().featureFlags
      : { ...getState().featureFlags, watchlists: runtimeFlag('ENABLE_WATCHLISTS', true), setBrowsing: runtimeFlag('ENABLE_SET_BROWSING', true), publicPriceIntelligence: false },
    scanDraftCount: scanDrafts.length,
    ready: true
  };
  resolveRouteContext(activeRoute, nextState);
  setState(nextState);
  refreshStorageEstimate().catch(() => {});
}

async function persistSettings(patch, { notice = '' } = {}) {
  const settings = { ...getState().settings, ...patch };
  await Promise.all(Object.entries(patch).map(([key, value]) => putRecord('settings', { key, value })));
  setState({ settings });
  if (notice) showToast(notice);
  return settings;
}

async function refreshStorageEstimate() {
  if (!navigator.storage?.estimate) {
    setState({ storage: { usage: null, quota: null, estimating: false, error: 'Storage estimates are unavailable.' } });
    return;
  }
  setState({ storage: { ...getState().storage, estimating: true, error: '' } });
  try {
    const estimate = await navigator.storage.estimate();
    setState({ storage: {
      usage: Number.isFinite(estimate.usage) ? estimate.usage : null,
      quota: Number.isFinite(estimate.quota) ? estimate.quota : null,
      estimating: false,
      error: ''
    } });
  } catch (error) {
    setState({ storage: { usage: null, quota: null, estimating: false, error: error.message || 'Storage estimate failed.' } });
  }
}

function initializeAuth() {
  if (!isSupabaseConfigured()) return;
  try {
    const callback = consumeAuthCallback();
    const session = callback.session || loadSession();
    setState({ auth: { ...getState().auth, session, status: session ? 'pending' : 'local', error: '' } });
    if (callback.error) showToast(friendlyCloudError(callback.error, { online: navigator.onLine !== false }), 'error', 8000);
    else if (callback.session && location.hash) showToast('Cloud sign-in completed');
  } catch (error) {
    showToast(friendlyCloudError(error, { online: navigator.onLine !== false }), 'error');
  }
}

async function loadFeatureFlags() {
  const watchlistsEnabled = runtimeFlag('ENABLE_WATCHLISTS', true);
  const setBrowsingEnabled = runtimeFlag('ENABLE_SET_BROWSING', true);
  const publicIntelligenceEnabled = runtimeFlag('ENABLE_PRICE_INTELLIGENCE', false);
  let remote = {};
  if (watchlistsEnabled || publicIntelligenceEnabled) {
    try { remote = await fetchPublicFeatureFlags(); } catch { /* Foundation migration may not be deployed yet. */ }
  }
  setState({ featureFlags: {
    watchlists: watchlistsEnabled && (remote.watchlists ?? true),
    setBrowsing: setBrowsingEnabled,
    publicPriceIntelligence: publicIntelligenceEnabled && Boolean(remote.public_price_intelligence),
    loaded: true
  } });
}

let intelligenceHydrationId = 0;

async function hydrateIntelligence() {
  const hydrationId = ++intelligenceHydrationId;
  const state = getState();
  const variantIds = intelligenceVariantIds(
    state.holdings,
    state.watchlistItems,
    [...(state.search?.results || []), ...(state.discover?.products || [])]
  );
  if (!variantIds.length || !state.featureFlags.publicPriceIntelligence) {
    setState({ intelligence: { ...state.intelligence, byVariant: {}, history: [], loading: false, error: '' } });
    return;
  }
  const [cached, archived] = await Promise.all([
    loadCachedIntelligence(variantIds),
    loadIntelligenceHistory(variantIds)
  ]);
  if (hydrationId !== intelligenceHydrationId) return;
  setState({ intelligence: {
    ...getState().intelligence,
    byVariant: cached,
    history: mergePublicationHistory(archived, Object.values(cached).flat()),
    loading: true,
    error: ''
  } });
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
      history: mergePublicationHistory(current.intelligence?.history || archived, Object.values(fresh).flat(), now),
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

function routeItemIdentifiers(item = {}, options = {}) {
  const reference = catalogReferenceForItem(item, options);
  return new Set([catalogRouteId(item), reference.canonicalVariantId, reference.watchKey, reference.externalId, item.id].filter(Boolean));
}

function watchedItemForRoute(items = [], entityId = '') {
  const exact = items.filter((entry) => entry.watchKey === entityId || entry.id === entityId);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  const matches = items.filter((entry) => routeItemIdentifiers(entry.catalogRef, {
    canonicalVariantId: entry.canonicalVariantId,
    conditionClass: entry.catalogRef?.conditionClass,
    marketCondition: entry.marketCondition || entry.catalogRef?.marketCondition || ''
  }).has(entityId));
  return matches.length === 1 ? matches[0] : null;
}

async function hydrateCardRoute(route) {
  const hydrationId = ++routeHydrationId;
  if (route.key !== 'card-detail') return;
  resolveRouteContext(route, getState());
  if (activeDetail?.catalogRef) return;
  activeDetail = { origin: route.origin || 'search', loading: true, catalogRef: null };
  render();
  try {
    const item = await getCatalogRouteItem(route.entityId);
    if (hydrationId !== routeHydrationId || activeRoute.canonicalPath !== route.canonicalPath) return;
    const watched = watchedItemForRoute(getState().watchlistItems, route.entityId);
    activeDetail = {
      origin: route.origin || 'search',
      item,
      watched: watched || undefined,
      catalogRef: catalogReferenceForItem(item, {
        canonicalVariantId: watched?.canonicalVariantId,
        conditionClass: watched?.catalogRef?.conditionClass,
        marketCondition: watched?.marketCondition
      })
    };
    render();
  } catch (error) {
    if (hydrationId !== routeHydrationId || activeRoute.canonicalPath !== route.canonicalPath) return;
    activeDetail = { origin: route.origin || 'search', error: error.message || 'The shared card could not be loaded.', catalogRef: null };
    render();
  }
}

function resolveRouteContext(route, state = getState()) {
  if (route.key === 'holding-detail') {
    const holding = state.holdings.find((entry) => entry.id === route.entityId);
    activeDetail = holding ? { origin: route.origin || 'portfolio', item: holding.item, holding, catalogRef: catalogReferenceForItem(holding.item, {
      canonicalVariantId: holding.canonicalVariantId,
      conditionClass: holding.grade ? 'graded' : 'raw',
      marketCondition: watchMarketConditionForHolding(holding)
    }) } : null;
  } else if (route.key === 'card-detail') {
    const item = state.search.results.find((entry) => routeItemIdentifiers(entry).has(route.entityId));
    const watched = watchedItemForRoute(state.watchlistItems, route.entityId);
    const selected = item || (watched ? { ...watched.catalogRef, variant: watched.catalogRef.finish } : null);
    activeDetail = selected ? {
      origin: route.origin || 'search',
      item: selected,
      watched: watched || undefined,
      catalogRef: catalogReferenceForItem(selected, {
        canonicalVariantId: watched?.canonicalVariantId,
        conditionClass: watched?.catalogRef?.conditionClass,
        marketCondition: watched?.marketCondition
      })
    } : null;
  } else {
    activeDetail = null;
  }
  if (route.key === 'add-review') activeDraft = state.scanDrafts?.[0] || activeDraft;
}

async function hydrateBrowseRoute(route, { bypassCache = false } = {}) {
  if (route.key !== 'discover' || route.mode !== 'browse' || getState().featureFlags?.setBrowsing === false) return;
  const generation = ++browseGeneration;
  const requested = route.browse;
  setState({ discover: { ...getState().discover, loading: true, error: '', warnings: [] } });
  try {
    const response = await loadCatalogSets({ gameId: requested.game, bypassCache });
    if (generation !== browseGeneration || activeRoute.canonicalPath !== route.canonicalPath) return;
    const selectedSet = requested.setId
      ? response.sets.find((set) => set.gameId === requested.game && set.externalId === requested.setId)
      : null;
    if (requested.setId && !selectedSet) throw new Error('This set is not present in the current public catalog.');
    let products = [];
    if (selectedSet) {
      products = await loadCatalogSetProducts({ gameId: requested.game, setId: requested.setId, bypassCache });
      if (generation !== browseGeneration || activeRoute.canonicalPath !== route.canonicalPath) return;
    }
    setState({ discover: {
      ...getState().discover,
      loading: false,
      games: mergeCatalogGames(getState().discover.games, response.games),
      sets: response.sets,
      products,
      selectedSet,
      warnings: response.warnings || [],
      error: '',
      loadedGame: requested.game,
      loadedSetId: requested.setId || ''
    } });
    if (products.length) await hydrateIntelligence();
  } catch (error) {
    if (generation !== browseGeneration || activeRoute.canonicalPath !== route.canonicalPath) return;
    setState({ discover: {
      ...getState().discover,
      loading: false,
      error: error.message || 'The set catalog could not be loaded.',
      warnings: []
    } });
  }
}

async function hydrateCatalogGames({ bypassCache = false } = {}) {
  if (!getState().auth.session) return;
  const generation = ++catalogGamesGeneration;
  try {
    const games = await loadCatalogGames({ bypassCache });
    if (generation !== catalogGamesGeneration) return;
    setState({ discover: {
      ...getState().discover,
      games: mergeCatalogGames(getState().discover.games, games)
    } });
  } catch {
    // Browse requests surface actionable catalog warnings. Search keeps its
    // public options usable when private category metadata is unavailable.
  }
}

function applyAppRoute(route, { historyMode = 'push', focus = true, scroll = true } = {}) {
  activeRoute = route;
  if (route.key !== 'card-detail') routeHydrationId += 1;
  const state = getState();
  resolveRouteContext(route, state);
  const current = currentAppPath(location);
  const historyState = {
    collectfolio: true,
    routeKey: route.key,
    inspector: historyMode === 'push' && route.legacyView === 'detail'
  };
  if (historyMode === 'push' && current !== route.canonicalPath) {
    history.pushState(historyState, '', route.canonicalPath);
  } else if (historyMode === 'replace' || current !== route.canonicalPath || !history.state?.collectfolio) {
    history.replaceState(historyState, '', route.canonicalPath);
  }
  setState(routeStatePatch(route, state));
  document.title = `${({ overview: 'Overview', portfolio: 'Portfolio', discover: 'Discover', insights: 'Insights', add: 'Add', 'add-review': 'Add review', settings: 'Settings', 'card-detail': 'Card detail', 'holding-detail': 'Holding detail' })[route.key] || 'CollectFolio'} · CollectFolio`;
  if (focus) root.focus({ preventScroll: true });
  if (scroll) window.scrollTo({ top: 0, behavior: 'auto' });
  if (state.ready && route.key === 'card-detail' && !activeDetail) hydrateCardRoute(route);
  if (state.ready && route.key === 'discover' && route.mode === 'browse') hydrateBrowseRoute(route);
  if (state.ready && route.key === 'discover' && route.mode === 'search') hydrateCatalogGames();
}

function navigate(view, context = {}) {
  applyAppRoute(appRouteForLegacyView(view, getState(), { ...context, detail: context.detail || activeDetail }));
}

function navigateBrowse(patch = {}) {
  navigate('search', { discover: { ...getState().discover, ...patch, mode: 'browse' } });
}

function catalogActionItem(action) {
  const source = action.dataset.catalogScope === 'browse'
    ? getState().discover?.products || []
    : getState().search.results;
  return source[Number(action.dataset.index)];
}

function holdingForm(holding = null, { title = '', image = '', item: proposedItem = null } = {}) {
  const item = holding?.item || proposedItem || {};
  const modalTitle = title || (holding ? `Edit ${item.name || 'holding'}` : item.provider === 'custom' || !item.provider ? 'Add a custom collectible' : 'Add to portfolio');
  const content = renderHoldingForm(holding, {
    image,
    item: proposedItem,
    defaultCondition: getState().settings.defaultCondition,
    defaultLanguage: getState().settings.defaultLanguage,
    currency: getState().settings.currency
  });
  openModal({ title: modalTitle, content, actions: `<button class="button ghost" type="button" data-close-modal>Cancel</button><button class="button" type="submit" form="holding-form">${holding ? 'Save changes' : 'Add to portfolio'}</button>`, onOpen(layer) {
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
        const saved = await saveHolding({
          ...holding,
          item: { ...providerItem, id: providerItem.id || createId(), externalId: providerItem.externalId || '', provider: providerItem.provider || 'custom', category: data.category, game: data.game, name: data.name, setName: data.setName, number: data.number, variant: finish?.finish || data.variant, rarity: providerItem.rarity || '', year: data.year, language: data.language || providerItem.language || getState().settings.defaultLanguage, image: providerItem.image || '', imageSmall: providerItem.imageSmall || '', price: finish ? finish.price : providerItem.price ?? null, priceOptions: providerItem.priceOptions || [], currency: providerItem.currency || 'USD', priceSource: finish?.source || providerItem.priceSource || '', priceUrl: providerItem.priceUrl || '', priceUpdatedAt: providerItem.priceUpdatedAt || '' },
          quantity: data.quantity, condition: data.condition, marketCondition: data.marketCondition,
          gradeCompany: data.gradeCompany, grade: data.grade,
          purchasePrice: data.purchasePrice, purchaseCurrency: data.purchaseCurrency, purchaseDate: data.purchaseDate, fees: data.fees, seller: data.seller,
          manualMarketPrice: data.manualMarketPrice, manualMarketCurrency: data.manualMarketCurrency, folder: data.folder, tags: data.tags, notes: data.notes, userImage
        });
        if (!holding) recordDemandEvent(saved.canonicalVariantId, 'portfolio_add').catch(() => {});
        if (!holding && !getState().settings.onboardingComplete) {
          await persistSettings({ onboardingComplete: true, onboardingSkipped: false, onboardingStep: 'complete' });
        }
        closeModal();
        await loadLocal();
        await hydrateIntelligence();
        showToast(holding ? 'Holding updated' : `${data.name} added to your portfolio`);
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
    await importBackup(await readBackupFile(file));
    await loadLocal();
    await hydrateIntelligence();
    showToast('Backup merged into this device');
  } catch (error) {
    showToast(error.message || 'Backup import failed', 'error');
  }
}

async function exportCSV(holdingIds = null) {
  downloadFile(`collectfolio-holdings-${new Date().toISOString().slice(0, 10)}.csv`, await exportHoldingsCSV(holdingIds), 'text/csv;charset=utf-8');
  showToast(holdingIds?.length ? `${holdingIds.length} selected holdings exported` : 'Holdings CSV exported');
}

function confirmBulkDelete(ids) {
  const holdings = ids.map((id) => getState().holdings.find((entry) => entry.id === id)).filter(Boolean);
  if (!holdings.length) return;
  openModal({ title: `Delete ${holdings.length} selected holding${holdings.length === 1 ? '' : 's'}?`, content: '<p>Each selected holding will be removed and a deletion tombstone will be saved for optional sync. This cannot be undone on this device.</p>', actions: '<button class="button ghost" data-close-modal>Cancel</button><button class="button danger" data-confirm-bulk-delete>Delete selected</button>', onOpen(layer) {
    layer.querySelector('[data-confirm-bulk-delete]').addEventListener('click', async () => {
      closeModal();
      for (const holding of holdings) await removeHolding(holding.id);
      setState({ portfolio: { ...getState().portfolio, selected: [] } });
      await loadLocal();
      await hydrateIntelligence();
      showToast(`${holdings.length} holding${holdings.length === 1 ? '' : 's'} deleted`);
    });
  }});
}

function selectedHoldings(ids = getState().portfolio.selected || []) {
  const selected = new Set(ids);
  return getState().holdings.filter((holding) => selected.has(holding.id));
}

async function finishBulkHoldingUpdate(message) {
  setState({ portfolio: { ...getState().portfolio, selected: [] } });
  await loadLocal();
  await hydrateIntelligence();
  showToast(message);
}

function bulkMoveForm(ids) {
  const holdings = selectedHoldings(ids);
  if (!holdings.length) return;
  const folders = [...new Set(getState().holdings.map((holding) => holding.folder).filter(Boolean))].sort();
  openModal({
    title: `Move ${holdings.length} selected holding${holdings.length === 1 ? '' : 's'}`,
    content: `<form id="bulk-move-form"><label>Storage location<input name="folder" maxlength="80" list="holding-folders" required placeholder="Binder, box, shelf…"></label><datalist id="holding-folders">${folders.map((folder) => `<option value="${escapeAttribute(folder)}"></option>`).join('')}</datalist><p class="fine-print">This updates organization only. Each acquisition lot remains separate.</p></form>`,
    actions: '<button class="button ghost" type="button" data-close-modal>Cancel</button><button class="button" type="submit" form="bulk-move-form">Move selected</button>',
    onOpen(layer) {
      layer.querySelector('#bulk-move-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const folder = String(new FormData(event.currentTarget).get('folder') || '').trim();
        if (!folder) return;
        layer.querySelector('[type="submit"]').disabled = true;
        for (const holding of holdings) await saveHolding({ ...holding, folder });
        closeModal();
        await finishBulkHoldingUpdate(`${holdings.length} holding${holdings.length === 1 ? '' : 's'} moved`);
      });
    }
  });
}

function bulkTagForm(ids) {
  const holdings = selectedHoldings(ids);
  if (!holdings.length) return;
  openModal({
    title: `Tag ${holdings.length} selected holding${holdings.length === 1 ? '' : 's'}`,
    content: '<form id="bulk-tag-form"><label>Tags<input name="tags" maxlength="480" required placeholder="trade, favorite, rookie"></label><p class="fine-print">Comma-separated tags are added to each selected holding without removing existing tags.</p></form>',
    actions: '<button class="button ghost" type="button" data-close-modal>Cancel</button><button class="button" type="submit" form="bulk-tag-form">Add tags</button>',
    onOpen(layer) {
      layer.querySelector('#bulk-tag-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const tags = String(new FormData(event.currentTarget).get('tags') || '').split(',').map((tag) => tag.trim()).filter(Boolean);
        if (!tags.length) return;
        layer.querySelector('[type="submit"]').disabled = true;
        for (const holding of holdings) await saveHolding({ ...holding, tags: [...(holding.tags || []), ...tags] });
        closeModal();
        await finishBulkHoldingUpdate(`Tags added to ${holdings.length} holding${holdings.length === 1 ? '' : 's'}`);
      });
    }
  });
}

function confirmBulkDuplicate(ids) {
  const holdings = selectedHoldings(ids);
  if (!holdings.length) return;
  openModal({
    title: `Duplicate ${holdings.length} acquisition lot${holdings.length === 1 ? '' : 's'}?`,
    content: '<p>Each copy will be a separate holding with the same identity, quantity, acquisition details, tags, and local image.</p>',
    actions: '<button class="button ghost" type="button" data-close-modal>Cancel</button><button class="button" type="button" data-confirm-bulk-duplicate>Create copies</button>',
    onOpen(layer) {
      layer.querySelector('[data-confirm-bulk-duplicate]').addEventListener('click', async (event) => {
        event.currentTarget.disabled = true;
        for (const holding of holdings) await saveHolding({ ...holding, id: '', createdAt: '' });
        closeModal();
        await finishBulkHoldingUpdate(`${holdings.length} acquisition lot${holdings.length === 1 ? '' : 's'} duplicated`);
      });
    }
  });
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
    await putRecord('snapshots', { id: portfolioSnapshotId(date, 'USD'), date: date.toISOString().slice(0, 10), pricingPolicyVersion: PRICING_POLICY_VERSION, currency: 'USD', marketValue: 1332 * factor, costBasis: day > 2 ? 585 : 860, uniqueItems: day > 2 ? 3 : 4, totalQuantity: day > 2 ? 3 : 4, updatedAt: date.toISOString() });
  }
  await loadLocal();
  showToast('Demo collection loaded');
}

function filterCatalogResults(items, filters = {}) {
  const includes = (value, query) => !query || String(value || '').toLowerCase().includes(String(query).trim().toLowerCase());
  const sameNumber = (value, query) => !query || String(value || '').replace(/^#/, '').toLowerCase() === String(query).trim().replace(/^#/, '').toLowerCase();
  return items.filter((item) => includes(item.setName, filters.setName)
    && sameNumber(item.number, filters.number)
    && includes(item.variant || item.rarity, filters.variant)
    && includes(item.year, filters.year)
    && includes(item.name, filters.player));
}

async function runCatalogSearch(form) {
  const generation = ++searchGeneration;
  const data = Object.fromEntries(new FormData(form));
  const filters = Object.fromEntries(['setName', 'number', 'variant', 'player', 'year', 'grade']
    .map((key) => [key, String(data[key] || '').trim()]));
  if (catalogGameRequiresSession(data.category, getState().discover.games, getState().auth.session)) {
    const search = { ...getState().search, query: data.query, category: data.category, provider: data.provider, filters, limit: DISCOVER_RESULTS_PAGE_SIZE, loading: false, results: [], warnings: [], cached: false };
    setState({ search });
    navigate('search', { search });
    openAuth();
    return;
  }
  const search = { ...getState().search, query: data.query, category: data.category, provider: data.provider, filters, limit: DISCOVER_RESULTS_PAGE_SIZE, loading: true, results: [], warnings: [], cached: false };
  const recentSearches = [String(data.query || '').trim(), ...(getState().settings.recentSearches || [])]
    .filter(Boolean).filter((query, index, all) => all.findIndex((entry) => entry.toLowerCase() === query.toLowerCase()) === index).slice(0, 5);
  setState({ search });
  setState({ settings: { ...getState().settings, recentSearches } });
  await putRecord('settings', { key: 'recentSearches', value: recentSearches });
  navigate('search', { search });
  try {
    const response = await searchCatalog(data);
    if (generation !== searchGeneration) return;
    const results = filterCatalogResults(response.results || [], filters);
    setState({ search: { ...getState().search, loading: false, ...response, results } });
    await hydrateIntelligence();
    if (response.manual) showToast('This category uses custom entry so coverage is not overstated', 'warning');
    else if (!results.length) showToast('No catalog candidates found', 'warning');
  } catch (error) {
    if (generation !== searchGeneration) return;
    setState({ search: { ...getState().search, loading: false, warnings: [error.message || 'Search failed'], results: [] } });
  }
}

async function refreshPrices() {
  const holdings = getState().holdings.filter((holding) => holding.item?.provider && holding.item.provider !== 'custom');
  if (!holdings.length) { showToast('There are no market-linked holdings to refresh', 'warning'); return; }
  showToast(`Refreshing ${holdings.length} market-linked holding${holdings.length === 1 ? '' : 's'}…`, 'warning');
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
      button.disabled = true;
      clearCatalogProviderCaches();
      clearBrowseCatalogCache();
      catalogGamesGeneration += 1;
      browseGeneration += 1;
      searchGeneration += 1;
      setState({
        discover: { ...getState().discover, games: [], sets: [], products: [], selectedSet: null },
        search: { ...getState().search, results: [], warnings: [], cached: false }
      });
      await Promise.all([clearLocalData(), clearApplicationCacheStorage()]);
      closeModal();
      await loadLocal();
      await hydrateIntelligence();
      showToast('Local CollectFolio data and caches cleared');
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
          setState({ auth: { ...getState().auth, session, status: 'pending', error: '' } });
          closeModal();
          await hydrateCatalogGames({ bypassCache: true });
          if (activeRoute.key === 'discover' && activeRoute.mode === 'browse') {
            await hydrateBrowseRoute(activeRoute, { bypassCache: true });
          }
          showToast('Cloud account connected');
        } else {
          showToast('Check your email to finish creating the account', 'warning', 7000);
          buttons.forEach((button) => { button.disabled = false; });
        }
      } catch (error) {
        showToast(friendlyCloudError(error, { online: navigator.onLine !== false }), 'error');
        buttons.forEach((button) => { button.disabled = false; });
      }
    });
    layer.querySelector('[data-magic-link]').addEventListener('click', async () => {
      const email = form.elements.email.value;
      if (!email) { form.elements.email.reportValidity(); return; }
      try { await requestMagicLink(email); closeModal(); showToast('Magic link sent; check your email'); }
      catch (error) { showToast(friendlyCloudError(error, { online: navigator.onLine !== false }), 'error'); }
    });
  }});
}

// Privacy-safe cross-device reconciliation: adopt a remote opt-out locally,
// re-push a local opt-out the server lost, and never let a remote opt-IN
// silently re-enable recording on this device (see mergeDemandOptOut).
async function reconcileDemandOptOut() {
  const local = Boolean(getState().settings.demandAnalyticsOptOut);
  const remote = await fetchDemandAnalyticsOptOut();
  const decision = mergeDemandOptOut(local, remote);
  if (decision.adoptLocalOptOut) {
    await putRecord('settings', { key: 'demandAnalyticsOptOut', value: true });
    setState({ settings: { ...getState().settings, demandAnalyticsOptOut: true } });
  }
  if (decision.pushOptOut) await pushDemandAnalyticsOptOut(true).catch(() => {});
}

async function syncNow() {
  if (getState().auth.syncing) return;
  if (navigator.onLine === false) {
    setState({ auth: { ...getState().auth, online: false, status: 'offline' } });
    showToast('You are offline. Changes remain saved on this device.', 'warning');
    return;
  }
  setState({ auth: { ...getState().auth, syncing: true, status: 'syncing', error: '' } });
  try {
    const result = await syncAll();
    await reconcileDemandOptOut().catch(() => {});
    await syncDemandEvents().catch(() => {});
    const at = new Date().toISOString();
    const watchlistCount = result.watchlist?.items || 0;
    const deletionCount = result.deletions + (result.watchlist?.deletions || 0);
    if (result.watchlistError) {
      const reference = syncDiagnosticReference(at);
      const message = 'Holdings were synchronized, but the Watchlist still needs attention. Retry to finish.';
      await persistSettings({
        lastSyncedAt: at,
        lastSyncError: message,
        syncDiagnostic: reference,
        syncHistory: appendSyncHistory(getState().settings.syncHistory, {
          status: 'error', at, summary: message, reference,
          counts: { holdings: result.holdings, watchlist: watchlistCount, deletions: deletionCount }
        })
      });
      setState({ auth: { ...getState().auth, error: message, status: 'error' } });
    } else {
      await persistSettings({
        lastSyncedAt: at,
        lastSyncError: '',
        syncDiagnostic: '',
        syncHistory: appendSyncHistory(getState().settings.syncHistory, {
          status: 'success', at,
          summary: `Synchronized ${result.holdings} holding${result.holdings === 1 ? '' : 's'} and ${watchlistCount} watched card${watchlistCount === 1 ? '' : 's'}.`,
          counts: { holdings: result.holdings, watchlist: watchlistCount, deletions: deletionCount }
        })
      });
    }
    await loadLocal();
    await hydrateIntelligence();
    const watchlist = result.watchlist ? ` and ${result.watchlist.items} watched card${result.watchlist.items === 1 ? '' : 's'}` : '';
    showToast(`Synchronized ${result.holdings} holding${result.holdings === 1 ? '' : 's'}${watchlist}${result.omittedImages ? `; ${result.omittedImages} large images stayed on this device` : ''}`, result.watchlistError ? 'warning' : 'success');
  } catch (error) {
    const at = new Date().toISOString();
    const message = friendlyCloudError(error, { online: navigator.onLine !== false });
    const reference = syncDiagnosticReference(at);
    await persistSettings({
      lastSyncError: message,
      syncDiagnostic: reference,
      syncHistory: appendSyncHistory(getState().settings.syncHistory, {
        status: 'error', at, summary: message, reference
      })
    });
    setState({ auth: { ...getState().auth, error: message, status: 'error' } });
    if (getState().settings.syncIssueNotifications) showToast(message, 'error', 8000);
  } finally {
    const state = getState();
    setState({ auth: {
      ...state.auth,
      syncing: false,
      status: state.auth.error ? 'error' : (state.auth.pendingChanges ? 'pending' : 'synced')
    } });
  }
}

function confirmRemoveCloudData() {
  if (!runtimeFlag('ENABLE_CLOUD_DATA_REMOVAL', false)) {
    showToast('Cloud data removal is not available in this release.', 'warning');
    return;
  }
  openModal({
    title: 'Remove cloud data?',
    content: '<p>This removes cloud holdings, Watchlist items, scans, synchronization history, and private market activity. Your sign-in account and everything saved on this device remain. Cloud sync will disconnect.</p><p>Export a backup first if you may want another copy. Type <strong>REMOVE</strong> to continue.</p><label>Confirmation<input id="cloud-remove-confirm" autocomplete="off"></label>',
    actions: '<button class="button ghost" type="button" data-close-modal>Cancel</button><button class="button danger" type="button" data-cloud-remove-confirmed disabled>Remove cloud data</button>',
    onOpen(layer) {
      const input = layer.querySelector('#cloud-remove-confirm');
      const button = layer.querySelector('[data-cloud-remove-confirmed]');
      input.addEventListener('input', () => { button.disabled = input.value !== 'REMOVE'; });
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          await removeCloudData();
          await signOut();
          await persistSettings({
            demandAnalyticsOptOut: true,
            lastSyncedAt: '',
            lastSyncError: '',
            syncDiagnostic: '',
            syncHistory: []
          });
          closeModal();
          clearBrowseCatalogCache();
          catalogGamesGeneration += 1;
          browseGeneration += 1;
          searchGeneration += 1;
          setState({
            auth: { ...getState().auth, session: null, syncing: false, status: 'local', error: '' },
            discover: { ...getState().discover, games: [], sets: [], products: [], selectedSet: null },
            search: { ...getState().search, results: [], warnings: [], cached: false }
          });
          showToast('Cloud data removed; local data is unchanged');
        } catch (error) {
          button.disabled = false;
          showToast(friendlyCloudError(error, { online: navigator.onLine !== false }), 'error', 8000);
        }
      });
    }
  });
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

function watchMarketConditionForHolding(holding) {
  if (!holding) return '';
  return holding.grade
    ? `${holding.gradeCompany || 'unknown'}-${holding.grade || 'ungraded'}`
    : holding.marketCondition || '';
}

async function toggleWatchedItem(item, options = {}) {
  if (!item || getState().featureFlags.watchlists === false) return;
  const existing = findWatchedItem(getState().watchlistItems, item, options);
  if (existing) {
    confirmRemoveWatchedItem(existing.watchKey);
    return;
  } else {
    const saved = await watchItem(item, options);
    recordDemandEvent(saved.canonicalVariantId, 'watch_add').catch(() => {});
    showToast('Added to Watchlist');
  }
  await loadLocal();
  await hydrateIntelligence();
}

function confirmRemoveWatchedItem(watchKey) {
  const entry = getState().watchlistItems.find((item) => item.watchKey === watchKey);
  if (!entry) return;
  openModal({
    title: 'Remove from Watchlist?',
    content: `<p><strong>${escapeHTML(entry.catalogRef?.name || 'This exact variant')}</strong> and its local target and alert settings will be removed. A tombstone will be retained for optional sync.</p>`,
    actions: '<button class="button ghost" type="button" data-close-modal>Cancel</button><button class="button danger" type="button" data-confirm-remove-watch>Remove</button>',
    onOpen(layer) {
      layer.querySelector('[data-confirm-remove-watch]').addEventListener('click', async (event) => {
        event.currentTarget.disabled = true;
        await unwatchItem(entry.watchKey);
        recordDemandEvent(entry.canonicalVariantId, 'watch_remove').catch(() => {});
        closeModal();
        await loadLocal();
        await hydrateIntelligence();
        showToast('Removed from Watchlist');
      });
    }
  });
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
  const targetCurrency = entry.targetCurrency || entry.catalogRef?.currency || getState().settings.currency || 'USD';
  const rawMarket = (entry.catalogRef?.conditionClass || 'raw') === 'raw';
  const marketConditions = [['', 'Select condition'], ['near-mint', 'Near Mint'], ['lightly-played', 'Lightly Played'], ['moderately-played', 'Moderately Played'], ['heavily-played', 'Heavily Played'], ['damaged', 'Damaged']];
  const content = `<form id="watch-preferences-form"><div class="field-grid">
    ${rawMarket ? `<label>Market condition<select name="marketCondition">${marketConditions.map(([value, label]) => `<option value="${value}" ${value === (entry.marketCondition || '') ? 'selected' : ''}>${label}</option>`).join('')}</select></label>` : ''}
    <label>Target price<input name="targetPrice" type="number" min="0" step="0.01" value="${escapeAttribute(entry.targetPrice ?? '')}"></label>
    <label>Target currency<select name="targetCurrency">${CURRENCIES.map((value) => `<option value="${value}" ${value === targetCurrency ? 'selected' : ''}>${value}</option>`).join('')}</select></label>
    <label>Percent-change alert<input name="alertPercentChange" type="number" min="0" step="0.1" value="${escapeAttribute(entry.alertPercentChange ?? '')}"></label>
    <label class="checkbox"><input name="alertTrendChange" type="checkbox" ${entry.alertTrendChange ? 'checked' : ''}> Trend changes</label>
    <label class="checkbox"><input name="alertRangeChange" type="checkbox" ${entry.alertRangeChange ? 'checked' : ''}> Fair-value position changes</label>
    <label class="checkbox"><input name="alertForecastChange" type="checkbox" ${entry.alertForecastChange ? 'checked' : ''}> Forecast changes</label>
    <label class="span-all">Notes<textarea name="notes" maxlength="2000">${escapeHTML(entry.notes || '')}</textarea></label>
  </div><p class="fine-print">Preferences are saved now. Market alerts are evaluated only after approved data becomes available.</p></form>`;
  openModal({
    title: `Watch settings · ${entry.catalogRef?.name || 'Card'}`,
    content,
    actions: '<button class="button ghost" type="button" data-close-modal>Cancel</button><button class="button" type="submit" form="watch-preferences-form">Save preferences</button>',
    onOpen(layer) {
      layer.querySelector('#watch-preferences-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const data = Object.fromEntries(new FormData(form));
        const anyAlertEnabled = Boolean(data.targetPrice) || Boolean(data.alertPercentChange)
          || form.elements.alertTrendChange.checked || form.elements.alertRangeChange.checked
          || form.elements.alertForecastChange.checked;
        await watchItem({ ...entry.catalogRef, variant: entry.catalogRef.finish }, {
          canonicalVariantId: entry.canonicalVariantId,
          conditionClass: entry.catalogRef.conditionClass,
          marketCondition: data.marketCondition || entry.marketCondition || '',
          replacesWatchKey: entry.watchKey,
          targetPrice: data.targetPrice,
          targetCurrency: data.targetCurrency,
          alertPercentChange: data.alertPercentChange,
          alertTrendChange: form.elements.alertTrendChange.checked,
          alertRangeChange: form.elements.alertRangeChange.checked,
          alertForecastChange: form.elements.alertForecastChange.checked,
          notes: data.notes
        });
        if (anyAlertEnabled) recordDemandEvent(entry.canonicalVariantId, 'alert_create').catch(() => {});
        closeModal();
        await loadLocal();
        showToast('Watch preferences saved');
      });
    }
  });
}

// Opens the price-intelligence detail view for an item resolved from search,
// a holding, or a watchlist entry. card_view (and search_view when arriving
// from search) demand events are recorded here — both are no-ops for
// unmapped items, opted-out users, signed-out sessions, and model-mediated
// Insights opens that would create a recommendation feedback loop.
function openDetail(detail) {
  const catalogRef = catalogReferenceForItem(detail.item, {
    canonicalVariantId: detail.holding?.canonicalVariantId || detail.watched?.canonicalVariantId,
    conditionClass: detail.holding?.grade ? 'graded' : detail.watched?.catalogRef?.conditionClass,
    marketCondition: detail.holding
      ? watchMarketConditionForHolding(detail.holding)
      : detail.watched?.marketCondition
  });
  activeDetail = { ...detail, catalogRef };
  recordDemandEvent(
    catalogRef.canonicalVariantId, 'card_view', { origin: detail.origin }
  ).catch(() => {});
  if (detail.origin === 'search') recordDemandEvent(
    catalogRef.canonicalVariantId, 'search_view', { origin: detail.origin }
  ).catch(() => {});
  applyAppRoute(appRouteForLegacyView('detail', getState(), { detail: activeDetail }), { focus: false, scroll: false });
}

function closeActiveDetail() {
  const origin = activeDetail?.origin === 'search' ? 'search' : activeDetail?.origin === 'insights' ? 'insights' : 'portfolio';
  if (history.state?.inspector) history.back();
  else {
    activeDetail = null;
    navigate(origin, origin === 'portfolio' ? { portfolioSection: 'holdings' } : {});
  }
}

async function updateAlertRecord(id, patch) {
  const alert = getState().alerts.find((entry) => entry.id === id);
  if (!alert) return;
  const updated = { ...alert, ...patch, updatedAt: new Date().toISOString() };
  await putRecord('alerts', updated);
  setState({ alerts: getState().alerts.map((entry) => entry.id === id ? updated : entry) });
}

async function markAllAlertsRead() {
  const now = new Date().toISOString();
  const alerts = getState().alerts.map((alert) => alert.readAt ? alert : { ...alert, readAt: now, updatedAt: now });
  await Promise.all(alerts.filter((alert, index) => alert !== getState().alerts[index]).map((alert) => putRecord('alerts', alert)));
  setState({ alerts });
}

// PRD Sec 11.4: side-by-side comparison of up to four watched cards. The
// modal shows each column's evidence confidence and refuses to present
// mixed-confidence columns as like-for-like without saying so.
function openCompareModal() {
  const state = getState();
  const comparison = buildComparison(state.compare, state.watchlistItems, state.intelligence?.byVariant || {}, state.settings.currency);
  if (comparison.columns.length < 2) { showToast('Select at least two watched cards to compare', 'warning'); return; }
  const rows = [
    ['Current price', (column) => column.price],
    ['30-day return', (column) => column.return30d],
    ['90-day return', (column) => column.return90d],
    ['1-year return', (column) => column.return365d],
    ['Trend', (column) => column.trendStatus],
    ['Volatility', (column) => column.volatility],
    ['Fair-value position', (column) => column.fairValuePosition],
    ['30/90-day probability of gain', (column) => column.forecastHorizon ? `${column.forecastHorizon}D · ${column.probabilityUp}` : column.probabilityUp],
    ['Evidence confidence', (column) => column.confidenceLabel]
  ];
  const content = `<div class="compare-scroll"><table class="compare-table"><thead><tr><th scope="col"></th>${comparison.columns.map((column) => `<th scope="col">${escapeHTML(column.name)}<span class="fine-print">${escapeHTML(column.meta)}</span><span class="support-badge ${column.supportTier >= 4 ? 'supported' : column.supportTier >= 2 ? 'partial' : 'unsupported'}">Evidence level ${column.supportTier}</span></th>`).join('')}</tr></thead><tbody>${rows.map(([label, cell]) => `<tr><th scope="row">${escapeHTML(label)}</th>${comparison.columns.map((column) => `<td>${escapeHTML(cell(column))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
    ${comparison.confidenceDiffers ? '<p class="fine-print negative" role="status">Evidence confidence differs across these cards — the columns are not like-for-like comparisons.</p>' : ''}
    <p class="fine-print">Unavailable values show a dash instead of an invented number.</p>`;
  openModal({ title: 'Compare watched cards', content, actions: '<button class="button" type="button" data-close-modal>Close</button>' });
}

function chooseScanImage({ single = false } = {}) {
  const description = single
    ? 'Use the camera or choose one card image. CollectFolio detects its four corners, straightens it, and starts identification automatically.'
    : 'Use the camera or choose an existing image. CollectFolio detects one or several card boundaries.';
  openModal({ title: single ? 'Search by card image' : 'Scan or upload cards', content: `<p>${description}</p><div class="scan-source-options"><label><strong>Take photo</strong><span>Open the rear camera when this browser permits it.</span><input data-scan-source type="file" accept="image/*" capture="environment"></label><label><strong>Upload image</strong><span>Use this if camera permission is denied or the photo already exists.</span><input data-scan-source type="file" accept="image/*"></label></div><p class="fine-print">Images may be up to 25 MB. The full source photo is held only while you edit boundaries and is never uploaded.</p>`, actions: '<button class="button ghost" data-close-modal>Cancel</button>', onOpen(layer) {
    layer.querySelectorAll('[data-scan-source]').forEach((input) => input.addEventListener('change', async (event) => {
      const file = event.target.files[0];
      if (!file) return;
      try {
        const source = await fileToImageDataURL(file);
        const image = await loadImage(source);
        closeModal();
        openWorkbench(image, { single });
      } catch (error) {
        showToast(error.message || 'Could not open image', 'error');
      }
    }));
  }});
}

function openWorkbench(image, { single = false } = {}) {
  let editor;
  const tools = single
    ? '<div class="workbench-tools"><button class="button secondary small" type="button" data-workbench="retry">Retry corner detection</button></div>'
    : '<div class="workbench-tools"><button class="button secondary small" type="button" data-workbench="add">Draw new</button><button class="button secondary small" type="button" data-workbench="delete">Delete selected</button><button class="button secondary small" type="button" data-workbench="retry">Retry detection</button></div><div class="grid-controls"><label>Rows<input id="grid-rows" type="number" min="1" max="12" value="3"></label><label>Columns<input id="grid-columns" type="number" min="1" max="12" value="3"></label><button class="button secondary" type="button" data-workbench="grid">Apply grid</button></div>';
  openModal({ title: single ? 'Frame this card' : 'Edit crop boundaries', content: `<div class="workbench"><p class="muted">${single ? 'Drag the four corner handles to the card edges, or drag inside to move the outline. The saved crop is straightened automatically.' : 'Tap a card to select it. Drag its four corner handles to align perspective, or drag inside to move it.'}</p><div class="canvas-wrap"><canvas id="scan-canvas" aria-label="Editable crop boundary canvas"></canvas></div>${tools}<p id="boundary-count" class="fine-print"></p></div>`, actions: '<button class="button ghost" data-close-modal>Cancel</button><button class="button" type="button" data-workbench="continue">Straighten and identify</button>', onOpen(layer) {
    const count = layer.querySelector('#boundary-count');
    const updateCount = (boxes) => {
      const fallback = boxes.some((box) => box.fallback);
      count.textContent = fallback
        ? 'Automatic corners were not reliable. Adjust the four handles before continuing.'
        : `${boxes.length} detected ${boxes.length === 1 ? 'card outline' : 'card outlines'} · drag any corner to refine`;
      count.classList.toggle('negative', fallback);
    };
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
      if (action === 'grid' && !single) editor.applyGrid(layer.querySelector('#grid-rows').value, layer.querySelector('#grid-columns').value);
      if (action === 'continue') {
        if (!editor.boxes.length) { showToast('Add at least one crop boundary', 'warning'); return; }
        button.disabled = true;
        try {
          const draft = createScanDraft(
            cropsFromBoxes(image, editor.boxes),
            single ? 'single' : 'multi',
            {
              condition: getState().settings.defaultCondition,
              purchaseCurrency: getState().settings.currency,
              manualMarketCurrency: getState().settings.currency
            }
          );
          await saveScanDraft(draft);
          activeDraft = draft;
          editor.destroy();
          closeModal();
          await loadLocal();
          navigate('scan');
          render();
          showToast('Cards straightened; identification started locally');
          startDraftIdentification(draft);
        } catch (error) {
          button.disabled = false;
          showToast(error?.message || 'This outline could not be straightened. Adjust its four corners and retry.', 'error');
        }
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
  startDraftIdentification(activeDraft);
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
  const overviewRange = event.target.closest('[data-overview-range]');
  if (overviewRange && OVERVIEW_RANGES.includes(overviewRange.dataset.overviewRange)) {
    setState({ overview: { ...getState().overview, range: overviewRange.dataset.overviewRange } });
    return;
  }
  const discoverView = event.target.closest('[data-discover-view]');
  if (discoverView && DISCOVER_VIEWS.includes(discoverView.dataset.discoverView)) {
    const view = discoverView.dataset.discoverView;
    setState({ search: { ...getState().search, view }, settings: { ...getState().settings, discoverView: view } });
    await putRecord('settings', { key: 'discoverView', value: view });
    return;
  }
  const portfolioView = event.target.closest('[data-portfolio-view]');
  if (portfolioView && PORTFOLIO_VIEWS.includes(portfolioView.dataset.portfolioView)) {
    const view = portfolioView.dataset.portfolioView;
    setState({ portfolio: { ...getState().portfolio, view }, settings: { ...getState().settings, portfolioView: view } });
    await putRecord('settings', { key: 'portfolioView', value: view });
    return;
  }
  const insightsView = event.target.closest('[data-insights-view]');
  if (insightsView && INSIGHTS_VIEWS.includes(insightsView.dataset.insightsView)) {
    navigate('insights', { insights: { ...getState().insights, view: insightsView.dataset.insightsView } });
    return;
  }
  const insightsHorizon = event.target.closest('[data-insights-horizon]');
  if (insightsHorizon && INSIGHTS_HORIZONS.includes(Number(insightsHorizon.dataset.insightsHorizon))) {
    navigate('insights', { insights: { ...getState().insights, view: 'forecasts', horizon: Number(insightsHorizon.dataset.insightsHorizon) } });
    return;
  }
  const alertFilter = event.target.closest('[data-alert-filter]');
  if (alertFilter && ['all', 'unread', 'muted'].includes(alertFilter.dataset.alertFilter)) {
    setState({ insights: { ...getState().insights, alertFilter: alertFilter.dataset.alertFilter } });
    return;
  }
  const go = event.target.closest('[data-go]');
  if (go) {
    if (go.dataset.go === 'add' && activeDraft?.status === 'complete') activeDraft = null;
    navigate(go.dataset.go, {
      portfolioSection: go.dataset.portfolioTarget || (go.dataset.go === 'portfolio' ? 'holdings' : undefined)
    });
    return;
  }
  const section = event.target.closest('[data-portfolio-section]');
  if (section) {
    navigate('portfolio', { portfolioSection: section.dataset.portfolioSection });
    return;
  }
  const action = event.target.closest('[data-action]');
  if (!action) return;
  const id = action.dataset.id;
  if (action.dataset.action === 'set-discover-mode') {
    if (action.dataset.mode === 'browse' && getState().featureFlags?.setBrowsing !== false) navigateBrowse();
    else navigate('search', { search: getState().search, discover: { ...getState().discover, mode: 'search' } });
  }
  if (action.dataset.action === 'select-browse-game') {
    const game = action.dataset.game || 'all';
    const requiresSession = catalogGameRequiresSession(game, getState().discover.games, getState().auth.session);
    navigateBrowse({ game, setId: '' });
    if (requiresSession) openAuth();
    return;
  }
  if (action.dataset.action === 'browse-all-games') navigateBrowse({ game: 'all', setId: '' });
  if (action.dataset.action === 'open-browse-set') navigateBrowse({ game: action.dataset.game, setId: action.dataset.setId });
  if (action.dataset.action === 'browse-back-sets') navigateBrowse({ setId: '' });
  if (action.dataset.action === 'retry-browse') hydrateBrowseRoute(activeRoute, { bypassCache: true });
  if (action.dataset.action === 'clear-browse-filters') setState({ discover: { ...getState().discover, query: '', scope: 'all', sort: 'newest', setLimit: BROWSE_SETS_PAGE_SIZE } });
  if (action.dataset.action === 'load-more-browse-sets') setState({ discover: { ...getState().discover, setLimit: (Number(getState().discover.setLimit) || BROWSE_SETS_PAGE_SIZE) + BROWSE_SETS_PAGE_SIZE } });
  if (action.dataset.action === 'show-all-browse-sets') setState({ discover: { ...getState().discover, setLimit: getState().discover.sets.length } });
  if (action.dataset.action === 'clear-browse-product-query') setState({ discover: { ...getState().discover, productQuery: '', limit: BROWSE_PRODUCTS_PAGE_SIZE } });
  if (action.dataset.action === 'load-more-browse-products') setState({ discover: { ...getState().discover, limit: (Number(getState().discover.limit) || BROWSE_PRODUCTS_PAGE_SIZE) + BROWSE_PRODUCTS_PAGE_SIZE } });
  if (action.dataset.action === 'show-all-browse-products') setState({ discover: { ...getState().discover, limit: getState().discover.products.length } });
  if (action.dataset.action === 'view-set-holdings') {
    setState({ portfolio: {
      ...getState().portfolio,
      query: '',
      category: action.dataset.setCategory || 'all',
      filters: { setName: action.dataset.setName || '', setNameExact: true },
      limit: 100,
      selected: []
    } });
    navigate('portfolio', { portfolioSection: 'holdings' });
    return;
  }
  if (action.dataset.action === 'clear-portfolio-set-filters') setState({ portfolio: { ...getState().portfolio, setQuery: '', setCategory: 'all', setSort: 'recent-desc', setLimit: PORTFOLIO_SET_PAGE_SIZE } });
  if (action.dataset.action === 'load-more-portfolio-sets') setState({ portfolio: { ...getState().portfolio, setLimit: (Number(getState().portfolio.setLimit) || PORTFOLIO_SET_PAGE_SIZE) + PORTFOLIO_SET_PAGE_SIZE } });
  if (action.dataset.action === 'onboarding-storage') {
    await persistSettings({
      onboardingStorage: action.dataset.storage === 'cloud' ? 'cloud' : 'local',
      onboardingStep: 'currency'
    });
    return;
  }
  if (action.dataset.action === 'onboarding-back') {
    await persistSettings({ onboardingStep: getState().settings.onboardingStep === 'add' ? 'currency' : 'welcome' });
    return;
  }
  if (action.dataset.action === 'skip-onboarding') {
    await persistSettings({ onboardingComplete: true, onboardingSkipped: true, onboardingStep: 'complete' });
    showToast('Setup skipped; recommended local defaults are ready');
    return;
  }
  if (action.dataset.action === 'onboarding-add') {
    await persistSettings({ onboardingStep: 'add' });
    navigate('add');
    return;
  }
  if (action.dataset.action === 'reopen-onboarding') {
    await persistSettings({ onboardingComplete: false, onboardingSkipped: false, onboardingStep: 'welcome' });
    navigate('home');
    return;
  }
  if (action.dataset.action === 'custom-holding') {
    const category = action.dataset.category;
    const filters = getState().search.filters || {};
    holdingForm(null, category ? { item: {
      provider: 'custom', category, name: getState().search.query || filters.player || '',
      setName: filters.setName || '', number: filters.number || '', variant: filters.variant || '', year: filters.year || '',
      language: getState().settings.defaultLanguage
    } } : {});
  }
  if (action.dataset.action === 'clear-search') {
    const search = { ...getState().search, query: '', limit: DISCOVER_RESULTS_PAGE_SIZE, results: [], warnings: [], cached: false };
    setState({ search });
    navigate('search', { search });
  }
  if (action.dataset.action === 'load-more-results') {
    const search = getState().search;
    const limit = Math.min(search.results.length, (Number(search.limit) || DISCOVER_RESULTS_PAGE_SIZE) + DISCOVER_RESULTS_PAGE_SIZE);
    setState({ search: { ...search, limit } });
  }
  if (action.dataset.action === 'show-all-results') {
    const search = getState().search;
    setState({ search: { ...search, limit: search.results.length } });
  }
  if (action.dataset.action === 'clear-search-filters') {
    setState({ search: { ...getState().search, filters: {}, provider: 'all' } });
    if (getState().search.query.length >= 2) root.querySelector('#catalog-search')?.requestSubmit();
  }
  if (action.dataset.action === 'recent-search') {
    const form = root.querySelector('#catalog-search');
    if (form && action.dataset.query) {
      form.elements.query.value = action.dataset.query;
      form.requestSubmit();
    }
  }
  if (action.dataset.action === 'add-catalog') {
    const item = catalogActionItem(action);
    if (item) holdingForm(null, { item });
  }
  if (action.dataset.action === 'toggle-compare') {
    const before = getState().compare || [];
    const after = toggleCompareSelection(before, action.dataset.watchKey);
    if (after === before && !before.includes(action.dataset.watchKey)) {
      showToast(`Compare holds at most ${COMPARE_LIMIT} cards`, 'warning');
    } else {
      setState({ compare: after });
    }
  }
  if (action.dataset.action === 'clear-compare') setState({ compare: [] });
  if (action.dataset.action === 'open-compare') openCompareModal();
  if (action.dataset.action === 'open-detail') {
    inspectorReturnTarget = Object.fromEntries(['index', 'holdingId', 'watchKey', 'catalogScope']
      .filter((key) => action.dataset[key] !== undefined).map((key) => [key, action.dataset[key]]));
    if (action.dataset.index !== undefined) {
      const item = catalogActionItem(action);
      if (item) openDetail({ origin: 'search', item });
    } else if (action.dataset.holdingId) {
      const holding = getState().holdings.find((entry) => entry.id === action.dataset.holdingId);
      if (holding) openDetail({ origin: getState().activeView === 'insights' ? 'insights' : 'portfolio', item: holding.item, holding });
    } else if (action.dataset.watchKey) {
      const watched = getState().watchlistItems.find((entry) => entry.watchKey === action.dataset.watchKey);
      if (watched) openDetail({ origin: getState().activeView === 'insights' ? 'insights' : 'portfolio', item: { ...watched.catalogRef, variant: watched.catalogRef.finish }, watched });
    }
  }
  if (action.dataset.action === 'close-detail') closeActiveDetail();
  if (action.dataset.action === 'open-full-detail' && activeDetail) {
    history.replaceState({ ...history.state, inspector: false }, '', currentAppPath(location));
    inspectorReturnTarget = null;
    inspectorWasOpen = false;
    render();
    root.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: 'auto' });
  }
  if (action.dataset.action === 'add-from-detail' && activeDetail) {
    holdingForm(null, { title: 'Add card to portfolio', item: { ...activeDetail.item, canonicalVariantId: activeDetail.catalogRef.canonicalVariantId } });
  }
  if (action.dataset.action === 'zoom-detail-image' && activeDetail) {
    const imageUrl = safeImageUrl(activeDetail.holding?.userImage || activeDetail.item?.image || activeDetail.item?.imageSmall || activeDetail.catalogRef?.image || activeDetail.catalogRef?.imageSmall);
    if (!imageUrl) showToast('No card image is available to zoom', 'warning');
    else openModal({ title: activeDetail.item?.name || 'Card image', content: `<div class="detail-image-zoom"><img src="${escapeAttribute(imageUrl)}" alt="${escapeAttribute(activeDetail.item?.name || 'Collectible')}" referrerpolicy="no-referrer"></div>`, actions: '<button class="button" type="button" data-close-modal>Close</button>' });
  }
  if (action.dataset.action === 'share-detail' && activeDetail) {
    const share = { title: activeDetail.item?.name || 'CollectFolio card', text: [activeDetail.item?.name, activeDetail.item?.setName, activeDetail.item?.number].filter(Boolean).join(' · '), url: location.href };
    try {
      if (navigator.share) await navigator.share(share);
      else {
        await navigator.clipboard.writeText(location.href);
        showToast('Card link copied');
      }
    } catch (error) {
      if (error?.name !== 'AbortError') showToast('Could not share this card link', 'warning');
    }
  }
  if (action.dataset.action === 'toggle-watch') {
    let item = null;
    let options = {};
    let chooseFinish = false;
    if (action.dataset.index !== undefined) {
      item = catalogActionItem(action);
      chooseFinish = catalogPriceOptionsForDisplay(item).length > 1;
    }
    if (action.dataset.detailWatch && activeDetail) {
      item = activeDetail.item;
      options = {
        canonicalVariantId: activeDetail.catalogRef.canonicalVariantId,
        conditionClass: activeDetail.catalogRef.conditionClass,
        marketCondition: activeDetail.catalogRef.marketCondition
      };
    }
    if (action.dataset.holdingId) {
      const holding = getState().holdings.find((entry) => entry.id === action.dataset.holdingId);
      item = holding?.item;
      options = {
        canonicalVariantId: holding?.canonicalVariantId,
        conditionClass: holding?.grade ? 'graded' : 'raw',
        marketCondition: watchMarketConditionForHolding(holding)
      };
    }
    if (action.dataset.cropWatch && activeDraft) {
      const crop = activeDraft.crops.find((entry) => entry.id === action.dataset.cropWatch);
      item = crop?.customItem || crop?.candidates.find((candidate) => candidate.id === crop.selectedId);
      chooseFinish = catalogPriceOptionsForDisplay(item).length > 1;
    }
    if (chooseFinish) await chooseWatchVariant(item); else await toggleWatchedItem(item, options);
  }
  if (action.dataset.action === 'remove-watch') {
    confirmRemoveWatchedItem(action.dataset.watchKey);
  }
  if (action.dataset.action === 'edit-watch') {
    const watched = getState().watchlistItems.find((entry) => entry.watchKey === action.dataset.watchKey);
    if (watched) watchlistPreferencesForm(watched);
  }
  if (action.dataset.action === 'mark-alert-read') await updateAlertRecord(id, { readAt: new Date().toISOString() });
  if (action.dataset.action === 'mark-alert-unread') await updateAlertRecord(id, { readAt: '' });
  if (action.dataset.action === 'toggle-alert-mute') {
    const alert = getState().alerts.find((entry) => entry.id === id);
    if (alert) await updateAlertRecord(id, { mutedAt: alert.mutedAt ? '' : new Date().toISOString() });
  }
  if (action.dataset.action === 'mark-all-alerts-read') await markAllAlertsRead();
  if (action.dataset.action === 'add-watched') {
    const watched = getState().watchlistItems.find((entry) => entry.watchKey === action.dataset.watchKey);
    if (watched) holdingForm(null, { title: 'Add watched card to portfolio', item: { ...watched.catalogRef, variant: watched.catalogRef.finish, canonicalVariantId: watched.canonicalVariantId } });
  }
  if (action.dataset.action === 'edit-holding') holdingForm(getState().holdings.find((entry) => entry.id === id));
  if (action.dataset.action === 'delete-holding') confirmDelete(id);
  if (action.dataset.action === 'toggle-holding-selection') {
    const before = getState().portfolio.selected || [];
    const selected = before.includes(id) ? before.filter((entry) => entry !== id) : [...before, id];
    setState({ portfolio: { ...getState().portfolio, selected } });
  }
  if (action.dataset.action === 'clear-holding-selection') setState({ portfolio: { ...getState().portfolio, selected: [] } });
  if (action.dataset.action === 'bulk-edit-holdings') {
    const [selectedId] = getState().portfolio.selected || [];
    if (selectedId) holdingForm(getState().holdings.find((entry) => entry.id === selectedId));
  }
  if (action.dataset.action === 'bulk-move-holdings') bulkMoveForm(getState().portfolio.selected || []);
  if (action.dataset.action === 'bulk-tag-holdings') bulkTagForm(getState().portfolio.selected || []);
  if (action.dataset.action === 'bulk-duplicate-holdings') confirmBulkDuplicate(getState().portfolio.selected || []);
  if (action.dataset.action === 'bulk-export-holdings') exportCSV(getState().portfolio.selected || []);
  if (action.dataset.action === 'bulk-delete-holdings') confirmBulkDelete(getState().portfolio.selected || []);
  if (action.dataset.action === 'load-more-holdings') setState({ portfolio: { ...getState().portfolio, limit: (getState().portfolio.limit || 100) + 100 } });
  if (action.dataset.action === 'clear-watchlist-filters') setState({ watchlist: { query: '', category: 'all', sort: getState().watchlist?.sort || 'forecast-desc' } });
  if (action.dataset.action === 'clear-portfolio-filters') setState({ portfolio: { ...getState().portfolio, query: '', category: 'all', filters: {}, limit: 100 } });
  if (action.dataset.action === 'remove-portfolio-filter') {
    const filter = action.dataset.filter;
    const portfolio = { ...getState().portfolio, limit: 100 };
    if (filter === 'query') portfolio.query = '';
    else if (filter === 'category') portfolio.category = 'all';
    else {
      portfolio.filters = { ...portfolio.filters };
      delete portfolio.filters[filter];
      if (filter === 'setName') delete portfolio.filters.setNameExact;
    }
    setState({ portfolio });
  }
  if (action.dataset.action === 'export-json') exportJSON();
  if (action.dataset.action === 'import-json') document.querySelector('#backup-file')?.click();
  if (action.dataset.action === 'export-csv') exportCSV();
  if (action.dataset.action === 'load-demo') {
    openModal({ title: 'Add demo collection?', content: '<p>This will add four clearly labeled demonstration holdings. They use sample values, not appraisals.</p>', actions: '<button class="button ghost" data-close-modal>Cancel</button><button class="button" data-approve-demo>Approve demo holdings</button>', onOpen(layer) {
      layer.querySelector('[data-approve-demo]').addEventListener('click', async () => { closeModal(); await loadDemo(); });
    }});
  }
  if (action.dataset.action === 'clear-data') confirmClear();
  if (action.dataset.action === 'remove-cloud-data') confirmRemoveCloudData();
  if (action.dataset.action === 'refresh-storage') refreshStorageEstimate();
  if (action.dataset.action === 'open-auth') openAuth();
  if (action.dataset.action === 'sync-now') syncNow();
  if (action.dataset.action === 'request-price-refresh') requestPriceRefreshAction();
  if (action.dataset.action === 'sign-out') {
    await signOut();
    clearBrowseCatalogCache();
    catalogGamesGeneration += 1;
    browseGeneration += 1;
    searchGeneration += 1;
    setState({
      auth: { ...getState().auth, session: null, syncing: false, status: 'local', error: '' },
      discover: { ...getState().discover, games: [], sets: [], products: [], selectedSet: null },
      search: { ...getState().search, results: [], warnings: [], cached: false }
    });
    showToast('Signed out; local portfolio is unchanged');
  }
  if (action.dataset.action === 'refresh-prices') refreshPrices();
  if (action.dataset.action === 'start-multi-scan') chooseScanImage({ single: false });
  if (action.dataset.action === 'start-single-scan') chooseScanImage({ single: true });
  if (action.dataset.action === 'resume-scan') resumeScan();
  if (action.dataset.action === 'save-scan' && activeDraft) { await saveScanDraft(activeDraft); await loadLocal(); showToast('Scan saved on this device'); }
  if (action.dataset.action === 'apply-acquisition-all' && activeDraft) {
    const form = root.querySelector('#bulk-acquisition-form');
    if (form) {
      await applyAcquisitionToAll(activeDraft, Object.fromEntries(new FormData(form)));
      render();
      showToast(`Acquisition details applied to ${activeDraft.crops.length} items`);
    }
  }
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
    action.disabled = true;
    try {
      const completedDraft = activeDraft;
      const count = await batchAddApproved(completedDraft, getState().settings.currency);
      if (count && !getState().settings.onboardingComplete) {
        await persistSettings({ onboardingComplete: true, onboardingSkipped: false, onboardingStep: 'complete' });
      }
      await loadLocal();
      activeDraft = completedDraft;
      await hydrateIntelligence();
      render();
      showToast(`${count} explicitly approved item${count === 1 ? '' : 's'} added`);
    } catch (error) {
      render();
      showToast(error.message || 'Approved items could not all be added', 'error');
    }
  }
});

root.addEventListener('submit', async (event) => {
  if (event.target.matches('#catalog-search')) {
    event.preventDefault();
    runCatalogSearch(event.target);
  }
  if (event.target.matches('#onboarding-currency')) {
    event.preventDefault();
    const currency = new FormData(event.target).get('currency');
    await persistSettings({ currency, onboardingStep: 'add' }, { notice: 'Display currency saved' });
  }
});

root.addEventListener('input', (event) => {
  if (activeDraft && event.target.matches('[data-crop-query]')) {
    const cropId = event.target.closest('[data-crop-id]')?.dataset.cropId;
    const crop = activeDraft.crops.find((entry) => entry.id === cropId);
    if (crop) crop.query = event.target.value;
  }
  if (event.target.matches('[data-browse-game-query]')) {
    const tokens = String(event.target.value || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
    let visible = 0;
    root.querySelectorAll('[data-game-search-text]').forEach((button) => {
      const matches = tokens.every((token) => button.dataset.gameSearchText.includes(token));
      button.hidden = !matches;
      if (matches) visible += 1;
    });
    const empty = root.querySelector('[data-browse-game-empty]');
    if (empty) empty.hidden = visible > 0;
  }
  const browseField = event.target.matches('[data-browse-set-query]')
    ? ['query', '[data-browse-set-query]']
    : event.target.matches('[data-browse-product-query]')
      ? ['productQuery', '[data-browse-product-query]']
      : null;
  if (browseField) {
    const [key, selector] = browseField;
    const value = event.target.value;
    const caret = event.target.selectionStart;
    clearTimeout(browseFilterTimer);
    browseFilterTimer = setTimeout(() => {
      setState({ discover: { ...getState().discover, [key]: value, ...(key === 'query' ? { setLimit: BROWSE_SETS_PAGE_SIZE } : { limit: BROWSE_PRODUCTS_PAGE_SIZE }) } });
      queueMicrotask(() => {
        const input = root.querySelector(selector);
        input?.focus({ preventScroll: true });
        if (Number.isInteger(caret)) input?.setSelectionRange(caret, caret);
      });
    }, 120);
  }
  if (event.target.matches('[data-portfolio-set-query]')) {
    const value = event.target.value;
    const caret = event.target.selectionStart;
    clearTimeout(browseFilterTimer);
    browseFilterTimer = setTimeout(() => {
      setState({ portfolio: { ...getState().portfolio, setQuery: value, setLimit: PORTFOLIO_SET_PAGE_SIZE } });
      queueMicrotask(() => {
        const input = root.querySelector('[data-portfolio-set-query]');
        input?.focus({ preventScroll: true });
        if (Number.isInteger(caret)) input?.setSelectionRange(caret, caret);
      });
    }, 120);
  }
});

root.addEventListener('keydown', (event) => {
  const result = event.target.closest?.('.result-card[data-action="open-detail"], .portfolio-holding-card[data-action="open-detail"]');
  if (result && event.target === result && ['Enter', ' '].includes(event.key)) {
    event.preventDefault();
    result.click();
    return;
  }
  const inspector = root.querySelector('.quick-inspector');
  if (!inspector) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    closeActiveDetail();
    return;
  }
  if (event.key !== 'Tab') return;
  const focusable = [...inspector.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
    .filter((element) => !element.disabled && element.getAttribute('aria-hidden') !== 'true');
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});

root.addEventListener('change', async (event) => {
  if (activeDraft && event.target.matches('[data-crop-acquisition]')) {
    const cropId = event.target.closest('[data-crop-id]')?.dataset.cropId;
    const field = event.target.dataset.cropAcquisition;
    if (cropId && field) await setCropAcquisition(activeDraft, cropId, { [field]: event.target.value });
  }
  if (event.target.matches('#catalog-search [name="category"]')) {
    const form = event.target.form;
    const data = Object.fromEntries(new FormData(form));
    setState({ search: { ...getState().search, query: data.query || '', category: data.category || 'all', provider: data.provider || 'all', filters: {} } });
    if (catalogGameRequiresSession(data.category, getState().discover.games, getState().auth.session)) openAuth();
  }
  if (event.target.matches('[data-browse-set-sort]')) setState({ discover: { ...getState().discover, sort: event.target.value, setLimit: BROWSE_SETS_PAGE_SIZE } });
  if (event.target.matches('[data-browse-set-scope]')) setState({ discover: { ...getState().discover, scope: event.target.value, setLimit: BROWSE_SETS_PAGE_SIZE } });
  if (event.target.matches('[data-browse-product-sort]')) setState({ discover: { ...getState().discover, productSort: event.target.value, limit: BROWSE_PRODUCTS_PAGE_SIZE } });
  if (event.target.matches('[data-portfolio-query]')) setState({ portfolio: { ...getState().portfolio, query: event.target.value, limit: 100 } });
  if (event.target.matches('[data-portfolio-category]')) setState({ portfolio: { ...getState().portfolio, category: event.target.value, limit: 100 } });
  if (event.target.matches('[data-portfolio-sort]')) setState({ portfolio: { ...getState().portfolio, sort: event.target.value, limit: 100 } });
  if (event.target.matches('[data-portfolio-filter]')) {
    const key = event.target.dataset.portfolioFilter;
    const filters = { ...getState().portfolio.filters, [key]: event.target.value };
    if (key === 'setName') delete filters.setNameExact;
    setState({ portfolio: { ...getState().portfolio, filters, limit: 100 } });
  }
  if (event.target.matches('[data-portfolio-set-category]')) setState({ portfolio: { ...getState().portfolio, setCategory: event.target.value, setLimit: PORTFOLIO_SET_PAGE_SIZE } });
  if (event.target.matches('[data-portfolio-set-sort]')) setState({ portfolio: { ...getState().portfolio, setSort: event.target.value, setLimit: PORTFOLIO_SET_PAGE_SIZE } });
  if (event.target.matches('[data-watchlist-query]')) setState({ watchlist: { ...getState().watchlist, query: event.target.value } });
  if (event.target.matches('[data-watchlist-category]')) setState({ watchlist: { ...getState().watchlist, category: event.target.value } });
  if (event.target.matches('[data-watchlist-sort]')) setState({ watchlist: { ...getState().watchlist, sort: event.target.value } });
  if (event.target.matches('[data-setting]')) {
    const key = event.target.dataset.setting;
    const value = typeof SETTINGS_DEFAULTS[key] === 'number' ? Number(event.target.value) : event.target.value;
    await persistSettings({ [key]: value });
    if (key === 'currency') {
      await recordDailySnapshot();
      await loadLocal();
    }
    if (key === 'theme') document.documentElement.dataset.theme = value;
    if (key === 'defaultForecastHorizon') setState({ insights: { ...getState().insights, horizon: value } });
    if (key === 'preferredMarketSource') setState({ search: { ...getState().search, provider: value } });
    showToast('Setting saved');
  }
  if (event.target.matches('[data-setting-toggle]')) {
    const key = event.target.dataset.settingToggle;
    const value = event.target.checked;
    await persistSettings({ [key]: value });
    if (key === 'demandAnalyticsOptOut' && getState().auth.session) {
      // Best-effort immediate push so the server-side aggregation exclusion
      // takes effect without waiting for the next manual sync.
      pushDemandAnalyticsOptOut(value).catch(() => {});
    }
    showToast('Setting saved');
  }
  if (event.target.matches('[data-setting-toggle-inverse]')) {
    const key = event.target.dataset.settingToggleInverse;
    const value = !event.target.checked;
    await persistSettings({ [key]: value });
    if (key === 'demandAnalyticsOptOut' && getState().auth.session) pushDemandAnalyticsOptOut(value).catch(() => {});
    showToast('Privacy setting saved');
  }
  if (event.target.matches('#backup-file')) {
    await importJSON(event.target.files[0]);
    event.target.value = '';
  }
});

document.querySelector('.primary-nav').addEventListener('click', (event) => {
  const button = event.target.closest('[data-view]');
  if (button) navigate(button.dataset.view, {
    portfolioSection: button.dataset.portfolioTarget || (button.dataset.view === 'portfolio' ? 'holdings' : undefined)
  });
});

document.querySelector('.shell-topbar').addEventListener('click', (event) => {
  const control = event.target.closest('[data-shell-action]');
  if (!control) return;
  if (control.dataset.shellAction === 'settings') navigate('profile');
  if (control.dataset.shellAction === 'search') {
    navigate('search');
    document.querySelector('#catalog-query')?.focus({ preventScroll: true });
  }
});

addEventListener('keydown', (event) => {
  const target = event.target;
  const editing = target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName));
  if (event.key !== '/' || event.defaultPrevented || editing || event.metaKey || event.ctrlKey || event.altKey) return;
  event.preventDefault();
  navigate('search');
  document.querySelector('#catalog-query')?.focus({ preventScroll: true });
});

addEventListener('offline', () => {
  setState({ auth: { ...getState().auth, online: false, status: 'offline' } });
  if (getState().settings.syncIssueNotifications) {
    showToast('You are offline. Local changes will wait safely on this device.', 'warning', 6000);
  }
});

addEventListener('online', () => {
  const state = getState();
  setState({ auth: {
    ...state.auth,
    online: true,
    status: state.auth.session
      ? state.auth.pendingChanges || state.auth.error || !state.settings.lastSyncedAt ? 'pending' : 'synced'
      : 'local'
  } });
  if (state.settings.syncIssueNotifications) showToast('Back online. Cloud actions are available again.');
  if (state.auth.session && (state.auth.pendingChanges || state.auth.error)) syncNow();
});

addEventListener('pagehide', () => { releaseOCRWorker().catch(() => {}); });

initializeAuth();
applyAppRoute(activeRoute, { historyMode: 'replace', focus: false, scroll: false });
subscribe(render);
render();
hydrateTcgcsvRefreshStatus();
addEventListener('popstate', () => {
  applyAppRoute(parseAppRoute(location), { historyMode: 'none', focus: true, scroll: false });
});
loadLocal().then(() => {
  if (activeRoute.key === 'add-review') startDraftIdentification(activeDraft);
  return Promise.all([
    hydrateCardRoute(activeRoute),
    hydrateBrowseRoute(activeRoute),
    activeRoute.key === 'discover' ? hydrateCatalogGames() : Promise.resolve()
  ]);
}).then(loadFeatureFlags).then(hydrateIntelligence).catch((error) => {
  setState({ ready: true });
  showToast(error.message || 'Could not open local portfolio', 'error', 8000);
});

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
