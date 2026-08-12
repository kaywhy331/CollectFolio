import test from 'node:test';
import assert from 'node:assert/strict';
import { renderHoldingForm } from '../app/assets/js/views/holding-form.js';

const catalogItem = {
  provider: 'scryfall', category: 'magic', game: 'Magic', name: 'Sol Ring',
  setName: 'Commander Masters', number: '396', rarity: 'Uncommon', variant: 'foil',
  year: '2023', image: '', imageSmall: '', currency: 'USD', price: 8,
  priceSource: 'Scryfall daily price', priceOptions: [
    { finish: 'regular', price: 3 }, { finish: 'foil', price: 8 }
  ]
};

test('catalog add form carries exact printing metadata and asks only for ownership essentials', () => {
  const html = renderHoldingForm(null, { item: catalogItem });
  assert.match(html, /Selected printing/);
  assert.match(html, /Commander Masters/);
  assert.match(html, /#396/);
  assert.match(html, /Printing details are already filled in/);
  assert.match(html, /type="hidden" name="setName" value="Commander Masters"/);
  assert.match(html, /name="quantity"[^>]*value="1"/);
  assert.match(html, /Near Mint/);
  assert.match(html, /Purchase price per item/);
  assert.match(html, /Purchase currency/);
  assert.match(html, /Manual-value currency/);
  assert.match(html, /Printing \/ finish/);
  assert.match(html, /foil · \$8\.00/);
  assert.doesNotMatch(html, /<label class="span-all">Name<input/);
});

test('advanced holding fields use progressive disclosure and preserve saved values', () => {
  const html = renderHoldingForm({
    item: catalogItem, quantity: 2, condition: 'Graded', purchasePrice: 6,
    purchaseDate: '2026-08-01', fees: 1.5, folder: 'Vault', gradeCompany: 'PSA',
    grade: '10', manualMarketPrice: 12, purchaseCurrency: 'EUR', manualMarketCurrency: 'GBP', notes: 'Centered copy', userImage: ''
  }, { currency: 'CAD' });
  assert.match(html, /Purchase &amp; organization/);
  assert.match(html, /Grading, value &amp; notes/);
  assert.match(html, /value="Vault"/);
  assert.match(html, /name="seller"/);
  assert.match(html, /name="tags"/);
  assert.match(html, /value="PSA"/);
  assert.match(html, /value="12"/);
  assert.match(html, /<option value="EUR" selected>EUR<\/option>/);
  assert.match(html, /<option value="GBP" selected>GBP<\/option>/);
  assert.match(html, /Centered copy/);
  assert.equal((html.match(/<details class="form-disclosure" open>/g) || []).length, 2);
});

test('custom holdings retain editable identity fields and escape user content', () => {
  const html = renderHoldingForm(null, { item: { provider: 'custom', category: 'sports', name: '<script>bad</script>', setName: '1989 Upper Deck' } });
  assert.match(html, /What are you adding/);
  assert.match(html, /<label class="span-all">Name<input/);
  assert.match(html, /value="&lt;script&gt;bad&lt;\/script&gt;"/);
  assert.doesNotMatch(html, /<script>bad<\/script>/);
});
