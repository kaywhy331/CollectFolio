import { expect, test } from '@playwright/test';
import { deflateSync } from 'node:zlib';

const singlePixelPNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl+X2kAAAAASUVORK5CYII=',
  'base64'
);

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

test('search by image starts in an invariant one-card crop workflow', async ({ page }) => {
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
  await workbench.getByRole('button', { name: 'Straighten and identify' }).click();

  await expect(page).toHaveURL(/\/scan\/review$/);
  await expect(page.locator('[data-crop-id]')).toHaveCount(1);
  await expect(page.getByText(/Identifying automatically on this device|Couldn’t read a reliable card name/)).toBeVisible();
});

test('unrecognizable capture shows explicit editable fallback and remains retryable', async ({ page }) => {
  await skipOnboarding(page);
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name: 'Discover' }).click();
  await page.getByRole('button', { name: 'Search from an image' }).click();
  await page.getByRole('dialog', { name: 'Search by card image' }).locator('input[data-scan-source]').last().setInputFiles({
    name: 'unrecognizable.png', mimeType: 'image/png', buffer: singlePixelPNG
  });
  const workbench = page.getByRole('dialog', { name: 'Frame this card' });
  await expect(workbench.getByText('Automatic corners were not reliable')).toBeVisible();
  await workbench.getByRole('button', { name: 'Straighten and identify' }).click();
  await expect(workbench.getByRole('button', { name: 'Straighten and identify' })).toBeEnabled();
});

test('low-quality native OCR falls through and never exposes random characters', async ({ page }) => {
  await page.addInitScript(() => {
    window.__tesseractRecognized = 0;
    window.TextDetector = class {
      async detect() { return [{ rawValue: '||| 1lI rrrr ???', confidence: 0.05 }]; }
    };
    window.Tesseract = {
      async createWorker() {
        return {
          async setParameters() {},
          async recognize() {
            window.__tesseractRecognized++;
            return { data: { text: '||| 1lI rrrr ???', confidence: 12 } };
          },
          async terminate() { window.__tesseractTerminated = true; }
        };
      }
    };
  });
  await page.route('**/runtime-config.js', (route) => route.fulfill({
    contentType: 'application/javascript',
    body: `window.COLLECTFOLIO_CONFIG = Object.freeze({
      SUPABASE_URL: '', SUPABASE_ANON_KEY: '', APP_VERSION: '0.8.0-test',
      ENABLE_TESSERACT: true, ENABLE_WATCHLISTS: true,
      ENABLE_PRICE_INTELLIGENCE: false, ENABLE_CLOUD_DATA_REMOVAL: false
    });`
  }));
  await page.route('**/assets/data/visual-index/pokemon-v1/manifest.json', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      format: 'collectfolio-visual-candidate-index', version: 1,
      fingerprintCount: 0, shards: []
    })
  }));
  await skipOnboarding(page);
  await openImageReview(page);

  await expect(page.locator('.review-card [role="status"]')).toContainText(/Text was unclear|tighter, well-lit crop/);
  await expect(page.locator('[data-crop-query]')).toHaveValue('');
  await expect(page.getByText('||| 1lI rrrr ???')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Retry text recognition' })).toBeEnabled();
  await expect.poll(() => page.evaluate(() => window.__tesseractRecognized)).toBe(7);
});

test('accepted OCR relaxes an over-specific query and recovers a catalog candidate', async ({ page }) => {
  // catalog-v2 B3: 'pokemon' search now goes exclusively through
  // /catalog/search (TCGCSV) -- see services/catalog.js's FLAGSHIP_GAMES --
  // so the relaxation flow (an over-specific query fails, a relaxed one
  // recovers a candidate) is exercised against that backend's raw `q` text
  // instead of pokemontcg.io's structured query syntax.
  const TCGCSV_ORIGIN = 'https://tcgcsv-e2e.example.test';
  const queries = [];
  await page.addInitScript(() => {
    window.TextDetector = class {
      async detect() {
        return [
          { rawValue: 'Synthetic Dragon ex', confidence: 0.98 },
          { rawValue: '223/197', confidence: 0.98 }
        ];
      }
    };
  });
  await page.route('**/runtime-config.js', (route) => route.fulfill({
    contentType: 'application/javascript',
    body: `window.COLLECTFOLIO_CONFIG = Object.freeze({
      SUPABASE_URL: '', SUPABASE_ANON_KEY: '', APP_VERSION: '0.8.0-test',
      TCGCSV_CATALOG_URL: '${TCGCSV_ORIGIN}/',
      ENABLE_TESSERACT: true, ENABLE_WATCHLISTS: true,
      ENABLE_PRICE_INTELLIGENCE: false, ENABLE_CLOUD_DATA_REMOVAL: false
    });`
  }));
  await page.route(`${TCGCSV_ORIGIN}/catalog/search**`, (route) => {
    const url = new URL(route.request().url());
    const q = url.searchParams.get('q') || '';
    queries.push(q);
    // Same relaxation contract as the old provider-query assertions below:
    // the over-specific "name + number" query still fails to match, and
    // only the relaxed "name only" query recovers the candidate.
    const matched = /synthetic dragon ex/i.test(q) && !/223/.test(q);
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        products: matched ? [{
          productId: 5001, categoryId: 3, groupId: 1102,
          categoryName: 'Pokemon', groupName: 'Synthetic Set',
          name: 'Synthetic Dragon ex', cleanName: 'Synthetic Dragon ex',
          cardNumber: '223', rarity: 'rare', prices: []
        }] : [],
        publicationId: 'e2e', sourceUpdatedAt: '2026-08-17'
      })
    });
  });

  await skipOnboarding(page);
  await openImageReview(page);

  await expect(page.getByRole('button', { name: /Synthetic Dragon ex/ })).toBeVisible();
  await expect(page.locator('[data-crop-query]')).toHaveValue('Synthetic Dragon ex 223/197');
  expect(queries.some((query) => /223/.test(query))).toBe(true);
  expect(queries.some((query) => /synthetic dragon ex/i.test(query) && !/223/.test(query))).toBe(true);
});
