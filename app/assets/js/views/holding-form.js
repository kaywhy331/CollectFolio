import { externalImage, priceDisclosure } from '../core/components.js';
import { catalogPriceForValuation, catalogPriceOptionsForDisplay } from '../core/pricing-policy.js';
import { CURRENCIES } from '../core/settings.js';
import { RAW_MARKET_CONDITIONS } from '../core/market-series.js';
import { escapeAttribute, escapeHTML, formatCurrency } from '../core/utils.js';

const CATEGORIES = [
  ['pokemon', 'Pokémon'], ['magic', 'Magic'], ['yugioh', 'Yu-Gi-Oh!'],
  ['sports', 'Sports'], ['comics', 'Comics'], ['slab', 'Graded slab'], ['other', 'Other']
];
const CONDITIONS = ['Mint', 'Near Mint', 'Excellent', 'Good', 'Played', 'Poor', 'Graded'];
const LANGUAGES = [
  ['en', 'English'], ['ja', 'Japanese'], ['fr', 'French'], ['de', 'German'],
  ['es', 'Spanish'], ['it', 'Italian'], ['pt', 'Portuguese'], ['ko', 'Korean'],
  ['zh', 'Chinese'], ['other', 'Other']
];

function option(value, selected, label = value) {
  return `<option value="${escapeAttribute(value)}" ${selected === value ? 'selected' : ''}>${escapeHTML(label)}</option>`;
}

function hiddenIdentity(item, defaultLanguage) {
  return ['name', 'category', 'game', 'setName', 'number', 'variant', 'year', 'language']
    .map((name) => `<input type="hidden" name="${name}" value="${escapeAttribute(item[name] || (name === 'language' ? defaultLanguage : ''))}">`)
    .join('');
}

function customIdentity(item, defaultLanguage) {
  const category = item.category || 'other';
  return `<section class="form-section"><div class="form-section-heading"><div><p class="eyebrow">Collectible identity</p><h3>What are you adding?</h3></div><span class="fine-print">Required for custom items</span></div><div class="field-grid identity-fields">
    <label class="span-all">Name<input name="name" required maxlength="160" value="${escapeAttribute(item.name || '')}" placeholder="e.g. 1989 Ken Griffey Jr. rookie"></label>
    <label>Category<select name="category">${CATEGORIES.map(([value, label]) => option(value, category, label)).join('')}</select></label>
    <label>Game / type<input name="game" maxlength="80" value="${escapeAttribute(item.game || '')}" placeholder="Baseball, Marvel…"></label>
    <label>Set / series<input name="setName" maxlength="120" value="${escapeAttribute(item.setName || '')}"></label>
    <label>Number / issue<input name="number" maxlength="50" value="${escapeAttribute(item.number || '')}"></label>
    <label>Variant / rarity<input name="variant" maxlength="100" value="${escapeAttribute(item.variant || '')}"></label>
    <label>Year<input name="year" inputmode="numeric" maxlength="4" value="${escapeAttribute(item.year || '')}"></label>
    <label>Language<select name="language">${LANGUAGES.map(([value, label]) => option(value, item.language || defaultLanguage, label)).join('')}</select></label>
  </div></section>`;
}

function catalogSelection(item, holding, image, defaultLanguage) {
  const price = catalogPriceForValuation(item);
  const metadata = [item.setName, item.number ? `#${item.number}` : '', item.rarity || item.variant].filter(Boolean).join(' · ');
  const pills = [item.game, item.variant, item.year, item.provider].filter(Boolean)
    .map((value) => `<span class="pill">${escapeHTML(value)}</span>`).join('');
  return `<section class="selection-summary">
    ${externalImage({ ...item, userImage: image || holding?.userImage || '' }, 'holding-form-image', { loading: 'eager' })}
    <div class="selection-copy"><p class="eyebrow">Selected printing</p><h3>${escapeHTML(item.name || 'Unnamed collectible')}</h3><p class="item-meta">${escapeHTML(metadata || 'Catalog details linked')}</p><p class="item-price">${price === null ? 'Price unavailable' : escapeHTML(formatCurrency(price, item.currency || 'USD'))}</p>${priceDisclosure(item, item.currency || 'USD')}<div class="pill-row">${pills}</div></div>
  </section><p class="prefill-note"><span aria-hidden="true">✓</span><span><strong>Printing details are already filled in.</strong> Set, number, rarity, artwork, and source stay linked to the catalog result you chose.</span></p>${hiddenIdentity(item, defaultLanguage)}`;
}

export function renderHoldingForm(holding = null, {
  image = '', item: proposedItem = null, defaultCondition = 'Near Mint', defaultLanguage = 'en', currency = 'USD'
} = {}) {
  const item = holding?.item || proposedItem || {};
  const isCatalogItem = Boolean(item.provider && item.provider !== 'custom');
  const visiblePriceOptions = catalogPriceOptionsForDisplay(item);
  const chosenFinish = visiblePriceOptions.findIndex((entry) => entry.finish === (item.variant || item.finish));
  const ownershipOpen = Boolean(holding?.purchaseDate || holding?.fees || holding?.seller || holding?.folder || holding?.tags?.length);
  const hasManualValue = holding?.manualMarketPrice !== '' && holding?.manualMarketPrice !== null && holding?.manualMarketPrice !== undefined;
  const purchaseCurrency = holding?.purchaseCurrency || holding?.costCurrency || currency;
  const manualMarketCurrency = holding?.manualMarketCurrency || holding?.valueCurrency || currency;
  const detailOpen = Boolean(holding?.gradeCompany || holding?.grade || hasManualValue || holding?.notes || holding?.userImage);
  const marketCondition = holding?.marketCondition || item.marketCondition || '';
  return `<form id="holding-form" class="holding-form">
    ${isCatalogItem ? catalogSelection(item, holding, image, defaultLanguage) : customIdentity(item, defaultLanguage)}
    <section class="form-section"><div class="form-section-heading"><div><p class="eyebrow">Ownership</p><h3>Just the essentials</h3></div><span class="fine-print">You can edit these later</span></div><div class="field-grid essentials-grid">
      ${visiblePriceOptions.length ? `<label class="span-all">Printing / finish<select name="finish">${visiblePriceOptions.map((entry, index) => `<option value="${index}" ${index === (chosenFinish < 0 ? 0 : chosenFinish) ? 'selected' : ''}>${escapeHTML(entry.finish)} · ${entry.price === null || entry.price === undefined ? 'Price unavailable' : escapeHTML(formatCurrency(entry.price, item.currency || 'USD'))}</option>`).join('')}</select><span class="fine-print">The selected finish and available market price are saved together.</span></label>` : ''}
      <label>Quantity<input name="quantity" type="number" min="1" step="1" value="${escapeAttribute(holding?.quantity || 1)}" required></label>
      <label>Collection condition<select name="condition">${CONDITIONS.map((value) => option(value, holding?.condition || defaultCondition)).join('')}</select></label>
      <label>Marketplace condition <span class="optional-label">For forecasting</span><select name="marketCondition"><option value="">Not confirmed</option>${RAW_MARKET_CONDITIONS.map((entry) => option(entry.value, marketCondition, entry.label)).join('')}</select><span class="fine-print">Choose the exact marketplace condition. CollectFolio will not infer it from your collection condition.</span></label>
      <label>Purchase price per item <span class="optional-label">Optional</span><input name="purchasePrice" type="number" min="0" step="0.01" value="${escapeAttribute(holding?.purchasePrice ?? '')}" placeholder="What you paid"></label>
      <label>Purchase currency<select name="purchaseCurrency">${CURRENCIES.map((value) => option(value, purchaseCurrency)).join('')}</select></label>
    </div></section>
    <details class="form-disclosure" ${ownershipOpen ? 'open' : ''}><summary><span><strong>Purchase &amp; organization</strong><small>Date, fees, and folder</small></span><span aria-hidden="true">+</span></summary><div class="form-disclosure-body field-grid">
      <label>Purchase date<input name="purchaseDate" type="date" value="${escapeAttribute(holding?.purchaseDate || '')}"></label>
      <label>Fees (total, same currency)<input name="fees" type="number" min="0" step="0.01" value="${escapeAttribute(holding?.fees ?? '')}"></label>
      <label class="span-all">Seller / source<input name="seller" maxlength="160" value="${escapeAttribute(holding?.seller || '')}" placeholder="Shop, show, trade partner…"></label>
      <label class="span-all">Folder / collection<input name="folder" maxlength="80" value="${escapeAttribute(holding?.folder || '')}" placeholder="e.g. Trade binder"></label>
      <label class="span-all">Tags<input name="tags" maxlength="480" value="${escapeAttribute((holding?.tags || []).join(', '))}" placeholder="rookie, trade, favorite"><span class="fine-print">Separate tags with commas.</span></label>
    </div></details>
    <details class="form-disclosure" ${detailOpen ? 'open' : ''}><summary><span><strong>Grading, value &amp; notes</strong><small>Only when you need them</small></span><span aria-hidden="true">+</span></summary><div class="form-disclosure-body field-grid">
      <label>Grade company<input name="gradeCompany" maxlength="40" value="${escapeAttribute(holding?.gradeCompany || '')}" placeholder="PSA, CGC, BGS"></label>
      <label>Grade<input name="grade" maxlength="20" value="${escapeAttribute(holding?.grade || '')}" placeholder="10"></label>
      <label>Manual market value per item<input name="manualMarketPrice" type="number" min="0" step="0.01" value="${escapeAttribute(holding?.manualMarketPrice ?? '')}" placeholder="Leave blank to use a permitted catalog value"><span class="fine-print">A manual value overrides, but does not erase, the catalog reference.</span></label>
      <label>Manual-value currency<select name="manualMarketCurrency">${CURRENCIES.map((value) => option(value, manualMarketCurrency)).join('')}</select></label>
      <label class="span-all">Notes<textarea name="notes" maxlength="2000" placeholder="Provenance, defects, storage notes…">${escapeHTML(holding?.notes || '')}</textarea></label>
      <label class="span-all">Your photo<input name="photo" type="file" accept="image/*"><span class="fine-print">Images may be up to 25 MB. The original source photo is never uploaded. This portfolio image stays in IndexedDB.</span></label>
    </div></details>
    <input type="hidden" name="existingImage" value="${escapeAttribute(image || holding?.userImage || '')}">
  </form>`;
}
