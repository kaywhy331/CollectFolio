import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';

function pngChunk(type, data) {
  const table = pngChunk.table ||= Array.from({ length: 256 }, (_, value) => {
    let result = value;
    for (let bit = 0; bit < 8; bit++) result = (result & 1) ? 0xedb88320 ^ (result >>> 1) : result >>> 1;
    return result >>> 0;
  });
  const name = Buffer.from(type);
  const payload = Buffer.concat([name, data]);
  let crc = 0xffffffff;
  for (const byte of payload) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, payload, checksum]);
}

function solidPNG(width = 64, height = 64) {
  const rows = Array.from({ length: height }, () => {
    const row = Buffer.alloc(1 + width * 4); row[0] = 0;
    for (let x = 0; x < width; x++) {
      const offset = 1 + x * 4;
      row[offset] = 128; row[offset + 1] = 128; row[offset + 2] = 128; row[offset + 3] = 255;
    }
    return row;
  });
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'), pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(Buffer.concat(rows))), pngChunk('IEND', Buffer.alloc(0))
  ]);
}

function rotatedTexturedCardPNG(width = 360, height = 440) {
  const rows = [];
  const corners = [{ x: 90, y: 45 }, { x: 290, y: 75 }, { x: 255, y: 390 }, { x: 55, y: 360 }];
  const inside = (x, y) => {
    let hit = false;
    for (let current = 0, previous = corners.length - 1; current < corners.length; previous = current++) {
      const a = corners[current]; const b = corners[previous];
      if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) hit = !hit;
    }
    return hit;
  };
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 4); row[0] = 0;
    for (let x = 0; x < width; x++) {
      const offset = 1 + x * 4;
      const texture = ((x * 17 + y * 31 + x * y) % 39) - 19;
      const color = inside(x, y) ? [40, 90, 160] : [170 + texture, 130 + texture, 90 + texture];
      row[offset] = color[0]; row[offset + 1] = color[1]; row[offset + 2] = color[2]; row[offset + 3] = 255;
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'), pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(Buffer.concat(rows))), pngChunk('IEND', Buffer.alloc(0))
  ]);
}

const rotatedCardPNG = rotatedTexturedCardPNG();
const unrecognizablePNG = solidPNG();

async function skipOnboarding(page) {
  await page.goto('/');
  const onboarding = page.getByRole('heading', { name: 'Set up CollectFolio' });
  const overview = page.getByRole('heading', { name: 'Home' });
  await expect(onboarding.or(overview).first()).toBeVisible();
  if (await onboarding.isVisible()) {
    await page.getByRole('button', { name: /Skip setup and use recommended defaults/ }).click();
  }
  await expect(overview).toBeVisible();
}

async function openImageReview(page, buffer = rotatedCardPNG) {
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name: 'Discover' }).click();
  await page.getByRole('button', { name: 'Search from an image' }).click();
  await page.getByRole('dialog', { name: 'Search by card image' }).locator('input[data-scan-source]').last().setInputFiles({
    name: 'card.png', mimeType: 'image/png', buffer
  });
  const workbench = page.getByRole('dialog', { name: 'Frame this card' });
  await workbench.getByRole('button', { name: 'Straighten and identify' }).click();
  await expect(page).toHaveURL(/\/scan\/review$/);
}

const COLLECTCAPTURE_ORIGIN = 'https://collectcapture-e2e.example.test';

function collectCaptureCandidate(overrides = {}) {
  return {
    id: 'tcgcsv:3:1102:5001', externalId: '3:1102:5001', provider: 'tcgcsv',
    category: 'tcgcsv-category-3', game: 'Pokemon', name: 'CollectCapture Identity Card',
    setName: 'Synthetic Set', setCode: 'SYN', number: '007', variant: 'Holofoil', rarity: 'Rare', year: '2026',
    image: '', imageSmall: '', price: null, priceOptions: [], currency: 'USD',
    priceSource: '', priceUrl: '', priceUpdatedAt: '', matchBucket: 'likely', matchScore: 0.98,
    categoryId: 3, groupId: 1102, productId: 5001,
    ...overrides
  };
}

function collectCaptureLookup(request, candidates = []) {
  const query = String(request.query || '').trim();
  const imageBytes = Buffer.from(String(request.imageDataUrl || '').split(',')[1] || '', 'base64');
  return {
    contentSha256: createHash('sha256').update(imageBytes).digest('hex'),
    imageRetained: false,
    recognition: {
      source: query ? 'user_query' : 'vision', category: 'pokemon',
      name: query || 'CollectCapture Identity Card', setName: query ? null : 'Synthetic Set',
      collectorNumber: query ? null : '007', language: 'en',
      visibleText: query ? [] : ['CollectCapture Identity Card', '007'],
      queries: [query || 'CollectCapture Identity Card 007'], confidence: query ? 1 : 0.94,
      provider: query ? 'collector' : 'openai', model: query ? 'manual-query' : 'e2e-vision'
    },
    candidates,
    warnings: []
  };
}

async function configureCollectCaptureStub(page, { respond } = {}) {
  const requests = [];
  await page.addInitScript(() => {
    localStorage.setItem('collectfolio:supabase-session', JSON.stringify({
      access_token: 'collectfolio-e2e-token', refresh_token: 'unused', expires_at: 4102444800,
      user: { id: 'collectfolio-e2e-user', email: 'collector@example.test' }
    }));
  });
  await page.route('**/runtime-config.js', (route) => route.fulfill({
    contentType: 'application/javascript',
    body: `window.COLLECTFOLIO_CONFIG = Object.freeze({
      SUPABASE_URL: '', SUPABASE_ANON_KEY: '', APP_VERSION: '0.8.32-test',
      COLLECTCAPTURE_API_URL: '${COLLECTCAPTURE_ORIGIN}/', ENABLE_COLLECTCAPTURE: true,
      ENABLE_TESSERACT: false, ENABLE_WATCHLISTS: true,
      ENABLE_PRICE_INTELLIGENCE: false, ENABLE_CLOUD_DATA_REMOVAL: false
    });`
  }));
  await page.route(`${COLLECTCAPTURE_ORIGIN}/v1/card-lookups`, async (route) => {
    const request = {
      authorization: route.request().headers().authorization,
      body: route.request().postDataJSON()
    };
    requests.push(request);
    const lookup = respond ? await respond(request.body, requests.length) : collectCaptureLookup(request.body);
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ lookup }) });
  });
  return requests;
}

async function configureDisabledCollectCapture(page, { localRollback = false } = {}) {
  await page.route('**/runtime-config.js', (route) => route.fulfill({
    contentType: 'application/javascript',
    body: `window.COLLECTFOLIO_CONFIG = Object.freeze({
      SUPABASE_URL: '', SUPABASE_ANON_KEY: '', APP_VERSION: '0.8.32-test',
      COLLECTCAPTURE_API_URL: '', ENABLE_COLLECTCAPTURE: false,
      ENABLE_LOCAL_SCAN_ROLLBACK: ${localRollback},
      ENABLE_TESSERACT: false, ENABLE_WATCHLISTS: true,
      ENABLE_PRICE_INTELLIGENCE: false, ENABLE_CLOUD_DATA_REMOVAL: false
    });`
  }));
}

test('search by image starts in an invariant one-card crop workflow', async ({ page }) => {
  await configureCollectCaptureStub(page);
  await skipOnboarding(page);
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name: 'Discover' }).click();
  await page.getByRole('button', { name: 'Search from an image' }).click();
  const source = page.getByRole('dialog', { name: 'Search by card image' });
  await expect(source).toContainText('detects its four corners, straightens it, and starts identification automatically');
  await source.locator('input[data-scan-source]').last().setInputFiles({
    name: 'card.png', mimeType: 'image/png', buffer: rotatedCardPNG
  });

  const workbench = page.getByRole('dialog', { name: 'Frame this card' });
  await expect(workbench).toContainText('saved crop is straightened automatically');
  await expect(workbench.getByText(/1 detected item outline/)).toBeVisible();
  await expect(workbench.getByRole('button', { name: 'Draw new' })).toHaveCount(0);
  await expect(workbench.getByRole('button', { name: 'Delete selected' })).toHaveCount(0);
  await expect(workbench.getByRole('button', { name: 'Apply grid' })).toHaveCount(0);
  await workbench.getByRole('button', { name: 'Retry corner detection' }).click();
  await expect(workbench.getByText(/1 detected item outline/)).toBeVisible();
  const canvas = workbench.locator('#scan-canvas');
  await canvas.focus();
  await page.keyboard.press('1');
  await expect(workbench.locator('#boundary-count')).toContainText('Corner 1 selected');
  await page.keyboard.press('ArrowRight');
  await expect(workbench.locator('#boundary-count')).toContainText('Corner 1 moved one step right');
  await workbench.getByRole('button', { name: 'Straighten and identify' }).click();

  await expect(page).toHaveURL(/\/scan\/review$/);
  await expect(page.locator('[data-crop-id]')).toHaveCount(1);
  await expect(page.locator('.review-card [role="status"]')).toContainText(/CollectCapture found no catalog match/);
  await expect(page.getByText(/bounded, metadata-free card crop is sent transiently to CollectCapture/i)).toBeVisible();
  const persisted = await page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('collectfolio');
      request.addEventListener('success', () => resolve(request.result), { once: true });
      request.addEventListener('error', () => reject(request.error), { once: true });
    });
    const records = await new Promise((resolve, reject) => {
      const request = database.transaction('scans').objectStore('scans').getAll();
      request.addEventListener('success', () => resolve(request.result), { once: true });
      request.addEventListener('error', () => reject(request.error), { once: true });
    });
    database.close();
    return records;
  });
  expect(persisted).toHaveLength(1);
  expect(persisted[0]).not.toHaveProperty('sourceImage');
  expect(persisted[0]).not.toHaveProperty('sourceImageRetainedAt');
  await page.reload();
  await expect(page.getByText(/full source photo is not stored with this draft/i)).toBeVisible();
  await expect(page.getByText(/CollectCapture.*does not retain it/i)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit crop boundary' })).toHaveCount(0);
});

test('unrecognizable capture shows explicit editable fallback and remains retryable', async ({ page }) => {
  await configureCollectCaptureStub(page);
  await skipOnboarding(page);
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name: 'Discover' }).click();
  await page.getByRole('button', { name: 'Search from an image' }).click();
  await page.getByRole('dialog', { name: 'Search by card image' }).locator('input[data-scan-source]').last().setInputFiles({
    name: 'unrecognizable.png', mimeType: 'image/png', buffer: unrecognizablePNG
  });
  const workbench = page.getByRole('dialog', { name: 'Frame this card' });
  await expect(workbench.getByText('Automatic corners were not reliable')).toBeVisible();
  await workbench.getByRole('button', { name: 'Straighten and identify' }).click();
  await expect(page).toHaveURL(/\/scan\/review$/);
  await expect(page.getByRole('button', { name: 'Search CollectCapture' })).toBeEnabled();
  await expect(page.locator('.review-card [role="status"]')).toContainText(/CollectCapture found no catalog match/);
});

test('scanner sends only the bounded crop to CollectCapture and does not invoke local OCR', async ({ page }) => {
  await page.addInitScript(() => {
    window.__localRecognitionCalls = 0;
    window.TextDetector = class {
      constructor() { window.__localRecognitionCalls++; }
      async detect() { window.__localRecognitionCalls++; return []; }
    };
    window.Tesseract = {
      async createWorker() {
        window.__localRecognitionCalls++;
        throw new Error('Local OCR must not run');
      }
    };
  });
  const requests = await configureCollectCaptureStub(page);
  await skipOnboarding(page);
  await openImageReview(page);

  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0].authorization).toBe('Bearer collectfolio-e2e-token');
  expect(requests[0].body.imageDataUrl).toMatch(/^data:image\/jpeg;base64,/);
  expect(requests[0].body).toMatchObject({ query: '', category: 'all', limit: 24 });
  await expect.poll(() => page.evaluate(() => window.__localRecognitionCalls)).toBe(0);
});

test('a collector-selected CollectCapture catalog printing is approvable without a browser-side catalog request', async ({ page }) => {
  const browserCatalogRequests = [];
  page.on('request', (request) => {
    if (/\/catalog\//.test(new URL(request.url()).pathname)) browserCatalogRequests.push(request.url());
  });
  await configureCollectCaptureStub(page, {
    respond: (request) => collectCaptureLookup(request, [collectCaptureCandidate()])
  });
  await skipOnboarding(page);
  await openImageReview(page, unrecognizablePNG);

  const candidate = page.getByRole('button', { name: /CollectCapture Identity Card/ });
  await candidate.click();
  await expect(page.locator('.selected-match .match-state')).toHaveText('Catalog printing selected');
  expect(browserCatalogRequests).toEqual([]);
  const confirm = page.getByRole('button', { name: 'Confirm this printing', exact: true });
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await page.getByRole('button', { name: 'Add 1 confirmed', exact: true }).click();
  await expect(page.getByRole('heading', { name: '1 item added' })).toBeVisible();
  expect(browserCatalogRequests).toEqual([]);
});

test('manual scanner query retries through CollectCapture without invoking browser catalogs', async ({ page }) => {
  const browserCatalogRequests = [];
  page.on('request', (request) => {
    if (/\/catalog\//.test(new URL(request.url()).pathname)) browserCatalogRequests.push(request.url());
  });
  const requests = await configureCollectCaptureStub(page, {
    respond: (request) => collectCaptureLookup(
      request,
      request.query ? [collectCaptureCandidate({ name: 'Synthetic Dragon ex', number: '223/197' })] : []
    )
  });
  await skipOnboarding(page);
  await openImageReview(page);

  await expect(page.locator('.review-card [role="status"]')).toContainText(/CollectCapture found no catalog match/);
  await page.locator('[data-crop-query]').fill('Synthetic Dragon ex 223/197');
  await page.getByRole('button', { name: 'Search CollectCapture' }).click();
  await expect(page.getByRole('button', { name: /Synthetic Dragon ex/ })).toBeVisible();
  await expect(page.locator('[data-crop-query]')).toHaveValue('Synthetic Dragon ex 223/197');
  expect(requests).toHaveLength(2);
  expect(requests[1].body.query).toBe('Synthetic Dragon ex 223/197');
  expect(requests[1].body.imageDataUrl).toBe(requests[0].body.imageDataUrl);
  expect(browserCatalogRequests).toEqual([]);
});

test('disabled CollectCapture fails explicitly without invoking a local scanner fallback', async ({ page }) => {
  const remoteRequests = [];
  page.on('request', (request) => {
    if (/\/v1\/card-lookups$/.test(new URL(request.url()).pathname)) remoteRequests.push(request.url());
  });
  await page.addInitScript(() => {
    window.__localRecognitionCalls = 0;
    window.TextDetector = class {
      constructor() { window.__localRecognitionCalls++; }
      async detect() { window.__localRecognitionCalls++; return []; }
    };
    window.Tesseract = {
      async createWorker() {
        window.__localRecognitionCalls++;
        throw new Error('Local OCR must not run');
      }
    };
  });
  await configureDisabledCollectCapture(page);
  await skipOnboarding(page);
  await openImageReview(page, unrecognizablePNG);

  await expect(page.locator('.review-card [role="status"]')).toContainText(/identification is unavailable until CollectCapture is configured/i);
  await expect.poll(() => page.evaluate(() => window.__localRecognitionCalls)).toBe(0);
  expect(remoteRequests).toEqual([]);
});

test('explicit rollback mode keeps browser-native recognition available without contacting CollectCapture', async ({ page }) => {
  const remoteRequests = [];
  page.on('request', (request) => {
    if (/\/v1\/card-lookups$/.test(new URL(request.url()).pathname)) remoteRequests.push(request.url());
  });
  await configureDisabledCollectCapture(page, { localRollback: true });
  await page.route('**/assets/data/visual-index/pokemon-v1/manifest.json', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ format: 'collectfolio-visual-candidate-index', version: 1, fingerprintCount: 0, shards: [] })
  }));
  await skipOnboarding(page);
  await openImageReview(page, unrecognizablePNG);

  await expect(page.getByRole('button', { name: 'Retry text recognition' })).toBeEnabled();
  await expect(page.getByText(/explicit scanner rollback is active/i)).toBeVisible();
  expect(remoteRequests).toEqual([]);
});
