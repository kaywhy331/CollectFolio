import test from 'node:test';
import assert from 'node:assert/strict';
import { eligibleApprovedCrops } from '../app/assets/js/services/scan-review.js';
import { escapeHTML, textSimilarity } from '../app/assets/js/core/utils.js';

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
