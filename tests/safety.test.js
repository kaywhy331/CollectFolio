import test from 'node:test';
import assert from 'node:assert/strict';
import { externalImage } from '../app/assets/js/core/components.js';
import { eligibleApprovedCrops, recoverInterruptedIdentifications } from '../app/assets/js/services/scan-review.js';
import { csvCell, escapeHTML, formatCurrency, safeImageUrl, textSimilarity } from '../app/assets/js/core/utils.js';

test('batch eligibility excludes selected but unapproved and malformed crops', () => {
  const draft = { crops: [
    { id: 'approved', approved: true, selectedId: 'candidate', candidates: [{ id: 'candidate' }], customItem: null },
    { id: 'not-approved', approved: false, selectedId: 'candidate', candidates: [{ id: 'candidate' }], customItem: null },
    { id: 'missing-candidate', approved: true, selectedId: 'unknown', candidates: [], customItem: null },
    { id: 'custom', approved: true, selectedId: '', candidates: [], customItem: { id: 'custom-item' } }
  ] };
  assert.deepEqual(eligibleApprovedCrops(draft).map((crop) => crop.id), ['approved', 'custom']);
});

test('user-entered HTML is escaped and similarity is normalized', () => {
  assert.equal(escapeHTML('<img src=x onerror="alert(1)">&'), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;');
  assert.equal(textSimilarity('Black Lotus #233', 'black lotus 233'), 1);
  assert.ok(textSimilarity('Charizard Base 4', 'Charizard 4/102 Base Set') > 0.5);
});

test('CSV cells neutralize spreadsheet formulas before quoting', () => {
  assert.equal(csvCell('=HYPERLINK("https://evil.test")'), `"'=HYPERLINK(""https://evil.test"")"`);
  assert.equal(csvCell('  +SUM(1,2)'), `"'  +SUM(1,2)"`);
  assert.equal(csvCell('@cmd'), "'@cmd");
  assert.equal(csvCell('ordinary value'), 'ordinary value');
  assert.equal(csvCell(42), '42');
});

test('invalid imported currency codes cannot crash a rendered value or masquerade as USD', () => {
  const formatted = formatCurrency(12.5, 'not-a-currency');
  assert.match(formatted, /12[.,]50/);
  assert.match(formatted, /currency unavailable/);
  assert.doesNotMatch(formatted, /\$/);
});

test('empty image sources remain placeholders in the browser', () => {
  const previousLocation = globalThis.location;
  globalThis.location = { href: 'https://collectfolio.example/portfolio' };
  try {
    assert.equal(safeImageUrl(''), '');
    assert.equal(safeImageUrl('javascript:alert(1)'), '');
    assert.equal(safeImageUrl('data:image/svg+xml,<svg onload="alert(1)"/>'), '');
    assert.equal(safeImageUrl('data:image/jpeg;base64,YQ=='), 'data:image/jpeg;base64,YQ==');
  } finally {
    if (previousLocation === undefined) delete globalThis.location;
    else globalThis.location = previousLocation;
  }
});

test('external card images eagerly load visible candidates and retain a fallback URL', () => {
  const previousLocation = globalThis.location;
  globalThis.location = { href: 'https://collectfolio.example/search' };
  try {
    const html = externalImage({
      name: 'Pikachu',
      imageSmall: 'https://images.pokemontcg.io/basep/P-001.png',
      image: 'https://images.pokemontcg.io/basep/P-001_hires.png'
    }, 'candidate-image', { loading: 'eager' });
    assert.match(html, /data-external-image/);
    assert.match(html, /loading="eager"/);
    assert.match(html, /decoding="async"/);
    assert.match(html, /data-fallback-src="https:\/\/images\.pokemontcg\.io\/basep\/P-001_hires\.png"/);
  } finally {
    if (previousLocation === undefined) delete globalThis.location;
    else globalThis.location = previousLocation;
  }
});

test('queued and interrupted persisted identification restart automatically after reload', () => {
  const draft = { crops: [
    { id: 'stuck', status: 'identifying', error: '' },
    { id: 'queued', status: 'queued', error: '' },
    { id: 'ready', status: 'matched', error: '' }
  ] };
  assert.equal(recoverInterruptedIdentifications(draft), 1);
  assert.equal(draft.crops[0].status, 'queued');
  assert.equal(draft.crops[1].status, 'queued');
  assert.equal(draft.crops[2].status, 'matched');
});
