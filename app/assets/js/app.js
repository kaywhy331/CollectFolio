import { pageHeader } from './core/components.js';
import { clearLocalData, exportBackup, exportHoldingsCSV, getAll, importBackup, putRecord, removeHolding, saveHolding } from './core/db.js';
import { getState, setState, subscribe } from './core/store.js';
import { closeModal, openModal, showToast } from './core/ui.js';
import { createId, downloadFile, escapeAttribute, escapeHTML } from './core/utils.js';
import { renderAdd } from './views/add.js';
import { renderHome } from './views/home.js';
import { renderPortfolio } from './views/portfolio.js';
import { renderProfile } from './views/profile.js';

const root = document.querySelector('#main-content');
const defaults = { currency: 'USD', theme: 'dark' };

function renderSearchShell() {
  return `${pageHeader('Catalog discovery', 'Search collectibles', 'Search Pokémon, Magic, and Yu-Gi-Oh! catalogs together.')}
    <section class="empty-state"><span class="empty-symbol">⌕</span><h2>Catalog search is warming up</h2><p>You can add a custom holding now or continue to the provider search.</p><div class="button-row"><button class="button" data-action="custom-holding">Create custom item</button><button class="button secondary" disabled>Search providers</button></div></section>`;
}

function render(state = getState()) {
  const views = { home: renderHome, search: renderSearchShell, add: renderAdd, portfolio: renderPortfolio, profile: renderProfile };
  root.innerHTML = state.ready ? (views[state.activeView] || renderHome)(state) : '<section class="empty-state"><h1>CollectFolio</h1><p>Opening your local portfolio…</p></section>';
  document.querySelectorAll('.bottom-nav [data-view]').forEach((button) => {
    const selected = button.dataset.view === state.activeView;
    button.classList.toggle('active', selected);
    if (selected) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  });
}

async function loadLocal() {
  const [holdings, snapshots, settingsRecords, scans] = await Promise.all([
    getAll('holdings'), getAll('snapshots'), getAll('settings'), getAll('scans')
  ]);
  const settings = { ...defaults, ...Object.fromEntries(settingsRecords.map((record) => [record.key, record.value])) };
  document.documentElement.dataset.theme = settings.theme;
  setState({ holdings, snapshots: snapshots.sort((a, b) => a.date.localeCompare(b.date)), settings, scanDraftCount: scans.filter((scan) => scan.status !== 'complete').length, ready: true });
}

function navigate(view) {
  setState({ activeView: view });
  root.focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function option(value, selected, label = value) {
  return `<option value="${escapeAttribute(value)}" ${selected === value ? 'selected' : ''}>${escapeHTML(label)}</option>`;
}

function holdingForm(holding = null, { title = holding ? 'Edit holding' : 'Approve custom holding', image = '' } = {}) {
  const item = holding?.item || {};
  const category = item.category || 'other';
  const content = `<form id="holding-form">
    <div class="field-grid">
      <label class="span-all">Name<input name="name" required maxlength="160" value="${escapeAttribute(item.name || '')}" placeholder="e.g. 1989 Ken Griffey Jr. rookie"></label>
      <label>Category<select name="category">${[['pokemon','Pokémon'],['magic','Magic'],['yugioh','Yu-Gi-Oh!'],['sports','Sports'],['comics','Comics'],['slab','Graded slab'],['other','Other']].map(([value,label]) => option(value, category, label)).join('')}</select></label>
      <label>Game / type<input name="game" maxlength="80" value="${escapeAttribute(item.game || '')}" placeholder="Baseball, Marvel…"></label>
      <label>Set / series<input name="setName" maxlength="120" value="${escapeAttribute(item.setName || '')}"></label>
      <label>Number / issue<input name="number" maxlength="50" value="${escapeAttribute(item.number || '')}"></label>
      <label>Variant / rarity<input name="variant" maxlength="100" value="${escapeAttribute(item.variant || '')}"></label>
      <label>Year<input name="year" inputmode="numeric" maxlength="4" value="${escapeAttribute(item.year || '')}"></label>
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
        const userImage = file ? await fileToDataURL(file) : data.existingImage;
        const providerItem = holding?.item || {};
        await saveHolding({
          ...holding,
          item: { ...providerItem, id: providerItem.id || createId(), externalId: providerItem.externalId || '', provider: providerItem.provider || 'custom', category: data.category, game: data.game, name: data.name, setName: data.setName, number: data.number, variant: data.variant, rarity: providerItem.rarity || '', year: data.year, image: providerItem.image || '', imageSmall: providerItem.imageSmall || '', price: providerItem.price ?? null, priceOptions: providerItem.priceOptions || [], currency: providerItem.currency || 'USD', priceSource: providerItem.priceSource || '', priceUrl: providerItem.priceUrl || '', priceUpdatedAt: providerItem.priceUpdatedAt || '' },
          quantity: data.quantity, condition: data.condition, gradeCompany: data.gradeCompany, grade: data.grade,
          purchasePrice: data.purchasePrice, purchaseDate: data.purchaseDate, fees: data.fees,
          manualMarketPrice: data.manualMarketPrice, folder: data.folder, notes: data.notes, userImage
        });
        closeModal();
        await loadLocal();
        showToast(holding ? 'Holding updated' : `${data.name} added with your approval`);
      } catch (error) {
        showToast(error.message || 'Could not save holding', 'error');
        submit.disabled = false;
      }
    });
  }});
}

function fileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(reader.result));
    reader.addEventListener('error', () => reject(reader.error));
    reader.readAsDataURL(file);
  });
}

async function confirmDelete(id) {
  const holding = getState().holdings.find((entry) => entry.id === id);
  if (!holding) return;
  openModal({ title: 'Delete holding?', content: `<p><strong>${escapeHTML(holding.item?.name || 'This holding')}</strong> will be removed and a deletion tombstone will be saved for optional sync.</p>`, actions: '<button class="button ghost" data-close-modal>Cancel</button><button class="button danger" data-confirm-delete>Delete holding</button>', onOpen(layer) {
    layer.querySelector('[data-confirm-delete]').addEventListener('click', async () => {
      await removeHolding(id);
      closeModal();
      await loadLocal();
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
    { id: 'demo-black-lotus', catalogId: 'demo:black-lotus', item: { id: 'demo:black-lotus', externalId: 'demo-1', provider: 'custom', category: 'magic', game: 'Magic', name: 'Black Lotus — Proxy Demo', setName: 'Demo catalog', number: '#233', variant: 'Display only', rarity: 'Rare', year: '1993', image: '', imageSmall: '', price: 720, priceOptions: [{ finish: 'regular', price: 720 }], currency: 'USD', priceSource: 'Demo price', priceUrl: '', priceUpdatedAt: now.toISOString() }, quantity: 1, condition: 'Near Mint', purchasePrice: 500, fees: 0, folder: 'Main collection', notes: 'Demonstration record; not a genuine appraisal.' },
    { id: 'demo-charizard', catalogId: 'demo:charizard', item: { id: 'demo:charizard', externalId: 'demo-2', provider: 'custom', category: 'pokemon', game: 'Pokémon', name: 'Charizard — Base Set', setName: 'Base Set', number: '4/102', variant: 'Holo', rarity: 'Rare Holo', year: '1999', image: '', imageSmall: '', price: 385, priceOptions: [], currency: 'USD', priceSource: 'Demo price', priceUrl: '', priceUpdatedAt: now.toISOString() }, quantity: 1, condition: 'Good', purchasePrice: 250, fees: 20, folder: 'Main collection' },
    { id: 'demo-sports', catalogId: 'demo:sports', item: { id: 'demo:sports', externalId: 'demo-3', provider: 'custom', category: 'sports', game: 'Basketball', name: 'Smoke Test Sports Card', setName: 'Rookie showcase', number: '23', variant: 'Base', rarity: '', year: '1996', image: '', imageSmall: '', price: null, priceOptions: [], currency: 'USD', priceSource: '', priceUrl: '', priceUpdatedAt: '' }, quantity: 1, condition: 'Graded', gradeCompany: 'PSA', grade: '9', purchasePrice: 75, fees: 5, manualMarketPrice: 142, folder: 'Slabs' },
    { id: 'demo-comic', catalogId: 'demo:comic', item: { id: 'demo:comic', externalId: 'demo-4', provider: 'custom', category: 'comics', game: 'Comic', name: 'Demo Variant Comic', setName: 'Collector issue', number: '1', variant: 'Cover B', rarity: '', year: '2024', image: '', imageSmall: '', price: null, priceOptions: [], currency: 'USD', priceSource: '', priceUrl: '', priceUpdatedAt: '' }, quantity: 1, condition: 'Near Mint', purchasePrice: 10, fees: 0, manualMarketPrice: 85, folder: 'Comics' }
  ];
  for (const holding of demo) await saveHolding(holding);
  for (let day = 4; day >= 1; day--) {
    const date = new Date(now);
    date.setDate(date.getDate() - day * 20);
    const factor = 1 - day * 0.06;
    await putRecord('snapshots', { id: `portfolio:${date.toISOString().slice(0, 10)}`, date: date.toISOString().slice(0, 10), marketValue: 1332 * factor, costBasis: day > 2 ? 585 : 860, uniqueItems: day > 2 ? 3 : 4, totalQuantity: day > 2 ? 3 : 4, updatedAt: date.toISOString() });
  }
  await loadLocal();
  showToast('Demo collection loaded');
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
      showToast('Local CollectFolio data cleared');
    });
  }});
}

root.addEventListener('click', async (event) => {
  const go = event.target.closest('[data-go]');
  if (go) { navigate(go.dataset.go); return; }
  const action = event.target.closest('[data-action]');
  if (!action) return;
  const id = action.dataset.id;
  if (action.dataset.action === 'custom-holding') holdingForm();
  if (action.dataset.action === 'edit-holding') holdingForm(getState().holdings.find((entry) => entry.id === id));
  if (action.dataset.action === 'delete-holding') confirmDelete(id);
  if (action.dataset.action === 'export-json') exportJSON();
  if (action.dataset.action === 'import-json') document.querySelector('#backup-file')?.click();
  if (action.dataset.action === 'export-csv') exportCSV();
  if (action.dataset.action === 'load-demo') loadDemo();
  if (action.dataset.action === 'clear-data') confirmClear();
  if (action.dataset.action === 'refresh-prices') showToast('Provider refresh is available after catalog search is enabled', 'warning');
  if (['start-multi-scan','start-single-scan','resume-scan'].includes(action.dataset.action)) showToast('The local scan workbench opens in the image-ingestion milestone', 'warning');
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
loadLocal().catch((error) => {
  setState({ ready: true });
  showToast(error.message || 'Could not open local portfolio', 'error', 8000);
});

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}
