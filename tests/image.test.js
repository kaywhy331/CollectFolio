import test from 'node:test';
import assert from 'node:assert/strict';
import {
  connectedComponents,
  detectBoundaries,
  differenceHash,
  gridBoxes,
  hashSimilarity,
  mergeBoxes,
  perspectiveTransform,
  projectPoint
} from '../app/assets/js/services/image-algorithms.js';
import {
  analyzeOCRText,
  analyzeOCRPasses,
  boundedImageDimensions,
  buildOCRQueryVariants,
  candidateEvidenceScore,
  extractCollectorNumber,
  extractOCRQuery,
  fileToImageDataURL,
  fileToScanImageDataURL,
  imageDimensionsFromBytes,
  MAX_IMAGE_FILE_BYTES,
  queryEvidenceFromText,
  rectifyCardPixels,
  validateImageFile,
  withTimeout
} from '../app/assets/js/services/image.js';
import { ScanWorkbench } from '../app/assets/js/services/scan-workbench.js';
import { visualCandidatesFromHash } from '../app/assets/js/services/visual-index.js';

function syntheticImage(width, height, background = [230, 230, 230]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < width * height; index++) {
    data[index * 4] = background[0];
    data[index * 4 + 1] = background[1];
    data[index * 4 + 2] = background[2];
    data[index * 4 + 3] = 255;
  }
  return { width, height, data };
}

function setPixel(image, x, y, color) {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return;
  const offset = (y * image.width + x) * 4;
  image.data[offset] = color[0];
  image.data[offset + 1] = color[1];
  image.data[offset + 2] = color[2];
  image.data[offset + 3] = 255;
}

function fillPolygon(image, points, color) {
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    let inside = false;
    for (let index = 0, previous = points.length - 1; index < points.length; previous = index++) {
      const current = points[index];
      const prior = points[previous];
      if ((current.y > y) !== (prior.y > y) && x < (prior.x - current.x) * (y - current.y) / (prior.y - current.y) + current.x) inside = !inside;
    }
    if (inside) setPixel(image, x, y, color);
  }
}

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
  assert.equal(blank.length, 1);
  assert.equal(blank[0].fallback, true);
  assert.equal(blank[0].method, 'manual-fallback');
  assert.equal(blank[0].confidence, 0);
  assert.equal(blank[0].corners.length, 4);
});

test('adaptive detection recovers rotated card corners on a textured surface', () => {
  const image = syntheticImage(600, 600, [170, 130, 90]);
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    const noise = ((x * 17 + y * 31 + (x * y) % 23) % 41) - 20;
    setPixel(image, x, y, [170 + noise, 130 + noise, 90 + noise]);
  }
  const expected = [
    { x: 203, y: 95 }, { x: 448, y: 139 }, { x: 387, y: 487 }, { x: 142, y: 443 }
  ];
  fillPolygon(image, expected, [35, 85, 145]);
  const [card] = detectBoundaries(image, { maximumCards: 1 });
  assert.equal(card.fallback, false);
  assert.equal(card.method, 'adaptive-quad');
  assert.equal(card.corners.length, 4);
  for (let index = 0; index < 4; index++) {
    assert.ok(Math.hypot(card.corners[index].x - expected[index].x, card.corners[index].y - expected[index].y) < 18);
  }
});

test('perspective transform and rectification map card corners into an upright image', () => {
  const source = syntheticImage(80, 80, [10, 10, 10]);
  const corners = [
    { x: 22, y: 8 }, { x: 62, y: 18 }, { x: 54, y: 72 }, { x: 14, y: 62 }
  ];
  fillPolygon(source, corners, [230, 230, 230]);
  const target = [{ x: 0, y: 0 }, { x: 39, y: 0 }, { x: 39, y: 55 }, { x: 0, y: 55 }];
  const matrix = perspectiveTransform(corners, target);
  corners.forEach((corner, index) => {
    const mapped = projectPoint(matrix, corner);
    assert.ok(Math.abs(mapped.x - target[index].x) < 0.001);
    assert.ok(Math.abs(mapped.y - target[index].y) < 0.001);
  });
  const rectified = rectifyCardPixels(source.data, source.width, source.height, corners, 40);
  assert.ok(rectified.height > rectified.width);
  const center = ((Math.floor(rectified.height / 2) * rectified.width) + Math.floor(rectified.width / 2)) * 4;
  assert.ok(rectified.data[center] > 200);
});

test('64-bit dHash and Hamming similarity are deterministic', () => {
  const descending = Uint8Array.from({ length: 72 }, (_, index) => 255 - (index % 9) * 20);
  const same = differenceHash(descending);
  const inverse = differenceHash(Uint8Array.from({ length: 72 }, (_, index) => (index % 9) * 20));
  assert.equal(same.length, 16);
  assert.equal(hashSimilarity(same, same), 1);
  assert.equal(hashSimilarity(same, inverse), 0);
});

test('versioned visual index hydrates nearest candidates without OCR evidence', async () => {
  const manifest = {
    format: 'collectfolio-visual-candidate-index', version: 1,
    shards: [{ name: '0' }]
  };
  const results = await visualCandidatesFromHash('8c8e96868631b286', {
    manifest,
    loadShard: async () => [
      ['base1-58', 'Pikachu', 'Base', '58', 'Common', 'https://images.pokemontcg.io/base1/58.png', '8c8e96868631b286'],
      ['other-1', 'Other', 'Other Set', '1', 'Common', 'https://images.pokemontcg.io/other/1.png', '0000000000000000']
    ],
    minimumScore: 0.9
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].id, 'pokemon:base1-58');
  assert.equal(results[0].matchScore, 1);
  assert.equal(results[0].price, null);
});

test('visual index scans independent shards concurrently with a bounded worker pool', async () => {
  const shards = Array.from({ length: 8 }, (_, index) => ({ name: String(index) }));
  let active = 0;
  let maximumActive = 0;
  const results = await visualCandidatesFromHash('8c8e96868631b286', {
    manifest: { format: 'collectfolio-visual-candidate-index', version: 1, shards },
    loadShard: async (name) => {
      active++;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, name === '0' ? 15 : 5));
      active--;
      return [[`card-${name}`, `Card ${name}`, 'Set', name, 'Common', '', '8c8e96868631b286']];
    },
    minimumScore: 0.9
  });
  assert.equal(maximumActive, 4);
  assert.deepEqual(results.map((entry) => entry.id), shards.map(({ name }) => `pokemon:card-${name}`));
});

test('OCR query extraction favors distinctive words and number tokens', () => {
  const query = extractOCRQuery('POKEMON\nCharizard VMAX\nBrilliant Stars\nTG20/TG30\nCopyright 2026');
  assert.equal(query, 'Charizard VMAX TG20/TG30');
});

test('OCR analysis rejects symbol soup and boilerplate instead of surfacing random queries', () => {
  for (const text of ['||| 1lI rrrr ???', 'Copyright 2026 Pokémon Illustration']) {
    const result = analyzeOCRText(text);
    assert.equal(result.accepted, false);
    assert.equal(result.query, '');
    assert.deepEqual(result.queries, []);
  }
  assert.equal(analyzeOCRText('Charizard ex\n223/197', { confidence: 20 }).accepted, false);
});

test('OCR analysis preserves names, punctuation, and collector-number search order', () => {
  const fixtures = [
    ['Charizard ex\n223/197', ['Charizard ex 223/197', '223/197', 'Charizard ex', 'Charizard']],
    ['Blue-Eyes White Dragon\nLOB-001', ['Blue-Eyes White Dragon LOB-001', 'LOB-001', 'Blue-Eyes White Dragon']],
    ['Fable of the Mirror-Breaker\n141', ['Fable of the Mirror-Breaker 141', '141', 'Fable of the Mirror-Breaker']]
  ];
  for (const [text, queries] of fixtures) {
    const result = analyzeOCRText(text, { confidence: 82 });
    assert.equal(result.accepted, true);
    assert.deepEqual(result.queries, queries);
  }
  assert.equal(extractCollectorNumber('Mewtwo GX 78/73'), '78/73');
  assert.equal(extractCollectorNumber("Fable of the Mirror-Breaker 141"), '141');
  assert.equal(extractCollectorNumber('Charizard ex\n330 HP\n223/197'), '223/197');
  assert.deepEqual(buildOCRQueryVariants({ title: "Farmer's Charm", number: 'RA01-EN001' }), ["Farmer's Charm RA01-EN001", 'RA01-EN001', "Farmer's Charm"]);
  assert.deepEqual(buildOCRQueryVariants({ title: 'Pikach PN', number: '58/102' }), ['Pikach PN 58/102', '58/102', 'Pikach PN', 'Pikach']);
  assert.deepEqual(buildOCRQueryVariants({ title: 'FABLE OF THE MIRROR-BREAKER', number: '141' }), ['FABLE OF THE MIRROR-BREAKER 141', '141', 'FABLE OF THE MIRROR-BREAKER']);
});

test('OCR pass fusion rejects short garbage titles and preserves repeated collector evidence', () => {
  const result = analyzeOCRPasses([
    { label: 'orientation', rotation: 0, text: 'ETH\n58/102', confidence: 78 },
    { label: 'title', rotation: 0, text: 'Pikach PN', confidence: 62 },
    { label: 'footer', rotation: 0, text: '58/102', confidence: 91 },
    { label: 'orientation', rotation: 180, text: '||| 1lI ???', confidence: 15 }
  ]);
  assert.equal(result.accepted, true);
  assert.equal(result.number, '58/102');
  assert.ok(result.queries.includes('58/102'));
  assert.notEqual(result.title, 'ETH');
});

test('typed-query evidence and candidate ranking reward an agreeing collector number', () => {
  const evidence = queryEvidenceFromText('Charizard ex 223/197');
  assert.equal(evidence.title, 'Charizard ex');
  assert.equal(evidence.number, '223/197');
  const exact = candidateEvidenceScore({ name: 'Charizard ex', number: '223' }, evidence);
  const wrongPrinting = candidateEvidenceScore({ name: 'Charizard ex', number: '125' }, evidence);
  const wrongName = candidateEvidenceScore({ name: 'Charmander', number: '223' }, evidence);
  assert.ok(exact > 0.9);
  assert.ok(exact > wrongPrinting);
  assert.ok(exact > wrongName);
  for (const score of [exact, wrongPrinting, wrongName]) assert.ok(Number.isFinite(score) && score >= 0 && score <= 1);
});

test('collector-number-only recovery survives missing or corrupted title OCR', () => {
  const candidate = { name: 'Pikachu', setName: 'Base', number: '58' };
  assert.ok(candidateEvidenceScore(candidate, { title: '', number: '58/102', query: '58/102' }) >= 0.8);
  assert.ok(candidateEvidenceScore(candidate, { title: 'Pikach PN', number: '58/102', query: 'Pikach PN 58/102' }) >= 0.6);
  assert.ok(candidateEvidenceScore({ ...candidate, number: '59' }, { title: '', number: '58/102', query: '58/102' }) < 0.28);
});

test('OCR deadlines resolve completed work and reject stalled work', async () => {
  assert.equal(await withTimeout(Promise.resolve('done'), 50), 'done');
  await assert.rejects(
    withTimeout(new Promise(() => {}), 5, 'OCR deadline reached.'),
    (error) => error.name === 'TimeoutError' && error.message === 'OCR deadline reached.'
  );
});

test('image files are bounded before FileReader allocates their payload', () => {
  const valid = { size: MAX_IMAGE_FILE_BYTES };
  assert.equal(validateImageFile(valid), valid);
  assert.throws(() => validateImageFile({ size: 0 }), /empty/i);
  assert.throws(() => validateImageFile({ size: MAX_IMAGE_FILE_BYTES + 1 }), /25 MB or smaller/i);
  assert.throws(() => validateImageFile({}), /valid image file/i);
  assert.throws(() => fileToImageDataURL({ size: MAX_IMAGE_FILE_BYTES + 1 }), /25 MB or smaller/i);
});

test('scan working images are bounded by both dimension and decoded pixel count', () => {
  assert.deepEqual(boundedImageDimensions(1200, 800), { width: 1200, height: 800, scale: 1 });
  const landscape = boundedImageDimensions(12_000, 9_000);
  assert.deepEqual({ width: landscape.width, height: landscape.height }, { width: 3200, height: 2400 });
  assert.ok(landscape.width * landscape.height <= 8_000_000);
  const square = boundedImageDimensions(4000, 4000);
  assert.ok(square.width <= 3200 && square.height <= 3200);
  assert.ok(square.width * square.height <= 8_000_000);
});

test('scan dimensions come from bounded JPEG, PNG, WebP, and GIF headers before decode', () => {
  const png = new Uint8Array(24);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  png.set([0x49, 0x48, 0x44, 0x52], 12);
  new DataView(png.buffer).setUint32(16, 12_000);
  new DataView(png.buffer).setUint32(20, 9_000);
  assert.deepEqual(imageDimensionsFromBytes(png), { width: 12_000, height: 9_000 });

  const jpeg = new Uint8Array(21);
  jpeg.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x23, 0x28, 0x2e, 0xe0], 0);
  assert.deepEqual(imageDimensionsFromBytes(jpeg), { width: 12_000, height: 9_000 });

  const webp = new Uint8Array(30);
  webp.set([...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBPVP8X')]);
  const width = 12_000 - 1;
  const height = 9_000 - 1;
  webp.set([width & 0xff, (width >> 8) & 0xff, (width >> 16) & 0xff], 24);
  webp.set([height & 0xff, (height >> 8) & 0xff, (height >> 16) & 0xff], 27);
  assert.deepEqual(imageDimensionsFromBytes(webp), { width: 12_000, height: 9_000 });

  const gif = new Uint8Array(10);
  gif.set(Buffer.from('GIF89a'));
  new DataView(gif.buffer).setUint16(6, 640, true);
  new DataView(gif.buffer).setUint16(8, 480, true);
  assert.deepEqual(imageDimensionsFromBytes(gif), { width: 640, height: 480 });
  assert.equal(imageDimensionsFromBytes(new Uint8Array([1, 2, 3, 4])), null);
});

test('scan upload performs one decoder-bounded bitmap allocation and closes it', async () => {
  const png = new Uint8Array(24);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  png.set([0x49, 0x48, 0x44, 0x52], 12);
  new DataView(png.buffer).setUint32(16, 12_000);
  new DataView(png.buffer).setUint32(20, 9_000);
  const file = {
    size: 1024,
    arrayBuffer() { throw new Error('the full file must not be read before decode'); },
    slice(start, end) {
      assert.equal(start, 0);
      assert.equal(end, 1024 * 1024);
      return { arrayBuffer: async () => png.buffer };
    }
  };
  const bitmapCalls = [];
  let closed = false;
  const originalBitmap = globalThis.createImageBitmap;
  const originalDocument = globalThis.document;
  globalThis.createImageBitmap = async (source, options) => {
    bitmapCalls.push({ source, options });
    return { width: options.resizeWidth, height: options.resizeHeight, close() { closed = true; } };
  };
  globalThis.document = {
    createElement(name) {
      assert.equal(name, 'canvas');
      return {
        width: 0,
        height: 0,
        getContext: () => ({ drawImage() {} }),
        toDataURL: () => 'data:image/jpeg;base64,bounded'
      };
    }
  };
  try {
    assert.equal(await fileToScanImageDataURL(file), 'data:image/jpeg;base64,bounded');
    assert.equal(bitmapCalls.length, 1);
    assert.equal(bitmapCalls[0].source, file);
    assert.deepEqual(bitmapCalls[0].options, {
      resizeWidth: 3200,
      resizeHeight: 2400,
      resizeQuality: 'high'
    });
    assert.equal(closed, true);
  } finally {
    if (originalBitmap === undefined) delete globalThis.createImageBitmap;
    else globalThis.createImageBitmap = originalBitmap;
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
});

test('scan boundaries support keyboard selection, movement, corner editing, and deletion', () => {
  const attributes = new Map();
  const listeners = new Map();
  const context = Object.fromEntries(['clearRect', 'drawImage', 'beginPath', 'moveTo', 'lineTo', 'closePath', 'fill', 'stroke', 'fillText', 'fillRect'].map((name) => [name, () => {}]));
  const canvas = {
    width: 0,
    height: 0,
    tabIndex: -1,
    getContext: () => context,
    setAttribute: (name, value) => attributes.set(name, value),
    addEventListener: (name, listener) => listeners.set(name, listener),
    removeEventListener: (name) => listeners.delete(name),
    focus: () => {}
  };
  const announcements = [];
  let changes = 0;
  const editor = new ScanWorkbench(canvas, { width: 100, height: 100 }, {
    onChange: () => { changes++; },
    onAnnounce: (message) => announcements.push(message)
  });
  editor.boxes = [{
    x: 10, y: 10, width: 40, height: 60,
    corners: [{ x: 10, y: 10 }, { x: 50, y: 10 }, { x: 50, y: 70 }, { x: 10, y: 70 }]
  }];
  editor.selected = 0;
  editor.render();
  const key = (value, shiftKey = false) => editor.onKeyDown({ key: value, shiftKey, preventDefault() {} });
  key('ArrowRight');
  assert.equal(editor.boxes[0].x, 11);
  key('1');
  key('ArrowDown', true);
  assert.equal(editor.boxes[0].corners[0].y, 20);
  assert.equal(changes, 2);
  assert.match(announcements.at(-1), /Corner 1 moved ten steps down/);
  assert.match(attributes.get('aria-label'), /corner 1 selected/i);
  key('Delete');
  assert.equal(editor.boxes.length, 0);
  assert.equal(canvas.tabIndex, 0);
  assert.ok(listeners.has('keydown'));
  editor.destroy();
  assert.equal(listeners.has('keydown'), false);
});
