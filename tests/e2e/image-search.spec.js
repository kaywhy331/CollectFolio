import { expect, test } from '@playwright/test';

const singlePixelPNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl+X2kAAAAASUVORK5CYII=',
  'base64'
);

async function skipOnboarding(page) {
  await page.goto('/');
  const onboarding = page.getByRole('heading', { name: 'Set up CollectFolio' });
  const overview = page.getByRole('heading', { name: 'Overview' });
  await expect(onboarding.or(overview).first()).toBeVisible();
  if (await onboarding.isVisible()) {
    await page.getByRole('button', { name: /Skip setup and use recommended defaults/ }).click();
  }
  await expect(overview).toBeVisible();
}

test('search by image starts in an invariant one-card crop workflow', async ({ page }) => {
  await skipOnboarding(page);
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name: 'Discover' }).click();
  await page.getByRole('button', { name: 'Search from an image' }).click();
  const source = page.getByRole('dialog', { name: 'Search by card image' });
  await expect(source).toContainText('whole image starts as one editable card boundary');
  await source.locator('input[data-scan-source]').last().setInputFiles({
    name: 'card.png', mimeType: 'image/png', buffer: singlePixelPNG
  });

  const workbench = page.getByRole('dialog', { name: 'Frame this card' });
  await expect(workbench.getByText('1 editable boundary')).toBeVisible();
  await expect(workbench.getByRole('button', { name: 'Draw new' })).toHaveCount(0);
  await expect(workbench.getByRole('button', { name: 'Delete selected' })).toHaveCount(0);
  await expect(workbench.getByRole('button', { name: 'Apply grid' })).toHaveCount(0);
  await workbench.getByRole('button', { name: 'Reset full-card boundary' }).click();
  await expect(workbench.getByText('1 editable boundary')).toBeVisible();
  await workbench.getByRole('button', { name: 'Create review crops' }).click();

  await expect(page).toHaveURL(/\/add\?step=review$/);
  await expect(page.locator('[data-crop-id]')).toHaveCount(1);
  await expect(page.getByText('1 editable boundary')).toHaveCount(0);
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
  await skipOnboarding(page);
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name: 'Discover' }).click();
  await page.getByRole('button', { name: 'Search from an image' }).click();
  await page.getByRole('dialog', { name: 'Search by card image' }).locator('input[data-scan-source]').last().setInputFiles({
    name: 'blank.png', mimeType: 'image/png', buffer: singlePixelPNG
  });
  await page.getByRole('dialog', { name: 'Frame this card' }).getByRole('button', { name: 'Create review crops' }).click();
  await page.getByRole('button', { name: 'Run OCR' }).click();

  await expect(page.locator('.review-card [role="status"]')).toContainText(/tighter, well-lit crop/);
  await expect(page.locator('[data-crop-query]')).toHaveValue('');
  await expect(page.getByText('||| 1lI rrrr ???')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.__tesseractRecognized)).toBe(5);
  expect(await page.evaluate(() => window.__tesseractTerminated)).toBe(true);
});

test('accepted OCR relaxes an over-specific query and recovers a catalog candidate', async ({ page }) => {
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
  await page.route('https://api.pokemontcg.io/v2/**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/sets')) {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: [], totalCount: 0 }) });
    }
    const providerQuery = url.searchParams.get('q') || '';
    queries.push(providerQuery);
    const matched = providerQuery.includes('name:"synthetic dragon ex"') && !providerQuery.includes('number:223');
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: matched ? [{
          id: 'synthetic-223', name: 'Synthetic Dragon ex', number: '223', rarity: 'rare',
          set: { name: 'Synthetic Set' }, images: {}
        }] : [],
        totalCount: matched ? 1 : 0
      })
    });
  });
  await page.route('https://api.tcgdex.net/**', (route) => {
    const url = new URL(route.request().url());
    return route.fulfill({ contentType: 'application/json', body: url.pathname.endsWith('/sets') ? '[]' : '[]' });
  });
  await page.route('https://api.scryfall.com/**', (route) => route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ object: 'error', code: 'not_found' }) }));
  await page.route('https://db.ygoprodeck.com/**', (route) => route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'No card matching your query was found in the database.' }) }));

  await skipOnboarding(page);
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name: 'Discover' }).click();
  await page.getByRole('button', { name: 'Search from an image' }).click();
  await page.getByRole('dialog', { name: 'Search by card image' }).locator('input[data-scan-source]').last().setInputFiles({
    name: 'synthetic.png', mimeType: 'image/png', buffer: singlePixelPNG
  });
  await page.getByRole('dialog', { name: 'Frame this card' }).getByRole('button', { name: 'Create review crops' }).click();
  await page.getByRole('button', { name: 'Run OCR' }).click();

  await expect(page.getByRole('button', { name: /Synthetic Dragon ex/ })).toBeVisible();
  await expect(page.locator('[data-crop-query]')).toHaveValue('Synthetic Dragon ex 223/197');
  expect(queries.some((query) => query.includes('number:223'))).toBe(true);
  expect(queries.some((query) => query.includes('name:"synthetic dragon ex"') && !query.includes('number:223'))).toBe(true);
});
