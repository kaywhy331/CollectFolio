import test from 'node:test';
import assert from 'node:assert/strict';
import { connectedComponents, detectBoundaries, differenceHash, gridBoxes, hashSimilarity, mergeBoxes } from '../app/assets/js/services/image-algorithms.js';
import { extractOCRQuery } from '../app/assets/js/services/image.js';

test('four-neighbor components keep diagonally separated shapes distinct', () => {
  const mask = new Uint8Array([
    1, 1, 0, 0,
    1, 0, 1, 1,
    0, 0, 1, 1
  ]);
  const components = connectedComponents(mask, 4, 3).sort((a, b) => a.x - b.x);
  assert.equal(components.length, 2);
  assert.deepEqual(components.map(({ x, y, width, height, area }) => ({ x, y, width, height, area })), [
    { x: 0, y: 0, width: 2, height: 2, area: 3 },
    { x: 2, y: 1, width: 2, height: 2, area: 4 }
  ]);
});

test('nearby fragments merge while distant boxes remain distinct', () => {
  const boxes = mergeBoxes([{ x: 0, y: 0, width: 10, height: 10 }, { x: 12, y: 0, width: 8, height: 10 }, { x: 60, y: 60, width: 10, height: 10 }], 2);
  assert.equal(boxes.length, 2);
  assert.deepEqual(boxes[0], { x: 0, y: 0, width: 20, height: 10, area: 180 });
});

test('binder grid supports exact 1–12 row and column splits', () => {
  assert.deepEqual(gridBoxes(120, 80, 2, 3), [
    { x: 0, y: 0, width: 40, height: 40 }, { x: 40, y: 0, width: 40, height: 40 }, { x: 80, y: 0, width: 40, height: 40 },
    { x: 0, y: 40, width: 40, height: 40 }, { x: 40, y: 40, width: 40, height: 40 }, { x: 80, y: 40, width: 40, height: 40 }
  ]);
  assert.equal(gridBoxes(120, 120, 20, 20).length, 144);
});

test('synthetic pixels detect a foreground rectangle and always have a fallback', () => {
  const width = 40; const height = 30;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let y = 7; y < 24; y++) for (let x = 9; x < 31; x++) {
    const offset = (y * width + x) * 4;
    data[offset] = 20; data[offset + 1] = 30; data[offset + 2] = 40; data[offset + 3] = 255;
  }
  const boxes = detectBoundaries({ width, height, data }, { minArea: 25, dilateRadius: 1, erodeRadius: 1 });
  assert.ok(boxes.some((box) => box.x <= 9 && box.y <= 7 && box.width >= 20 && box.height >= 15));
  const blank = detectBoundaries({ width, height, data: new Uint8ClampedArray(width * height * 4).fill(255) });
  assert.deepEqual(blank, [{ x: 0, y: 0, width, height }]);
});

test('64-bit dHash and Hamming similarity are deterministic', () => {
  const descending = Uint8Array.from({ length: 72 }, (_, index) => 255 - (index % 9) * 20);
  const same = differenceHash(descending);
  const inverse = differenceHash(Uint8Array.from({ length: 72 }, (_, index) => (index % 9) * 20));
  assert.equal(same.length, 16);
  assert.equal(hashSimilarity(same, same), 1);
  assert.equal(hashSimilarity(same, inverse), 0);
});

test('OCR query extraction favors distinctive words and number tokens', () => {
  const query = extractOCRQuery('POKEMON\nCharizard VMAX\nBrilliant Stars\nTG20/TG30\nCopyright 2026');
  assert.match(query, /Charizard/);
  assert.match(query, /Brilliant/);
  assert.match(query, /TG20\/TG30/);
  assert.doesNotMatch(query, /Copyright/i);
});
