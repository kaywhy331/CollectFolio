import { expect, test } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

const TCGCSV_ORIGIN = 'https://tcgcsv-portfolio-history-e2e.example.test';

async function skipOnboarding(page) {
  await page.goto('/');
  const onboarding = page.getByRole('heading', { name: 'Set up CollectFolio' });
  const overview = page.getByRole('heading', { name: 'Home', exact: true });
  await expect(onboarding.or(overview).first()).toBeVisible();
  if (await onboarding.isVisible()) {
    await page.getByRole('button', { name: /Skip setup and use recommended defaults/ }).click();
    await expect(onboarding).toBeHidden();
  }
}

const PRODUCT = { categoryId: 3, groupId: 200, productId: 6001, name: 'Retro History Portfolio Card', subtypeName: 'Holofoil', marketPrice: 150 };

// Ten weekly points, all in the past relative to any plausible test-run
// clock, so reconstructPortfolioValueSeries has real history to weight
// by quantity -- this is the retro data the portfolio/overview line
// graph must render even though no local daily snapshot was ever
// recorded for this device (the exact gap Kevin reported).
function weeklyPoints() {
  return [
    ['2026-06-01', 100], ['2026-06-08', 104], ['2026-06-15', 108], ['2026-06-22', 112],
    ['2026-06-29', 116], ['2026-07-06', 120], ['2026-07-13', 124], ['2026-07-20', 128],
    ['2026-07-27', 132], ['2026-08-03', 136]
  ];
}

function historyManifestPayload() {
  return {
    modelVersion: 'tcgcsv-history-v1',
    asOf: '2026-08-10',
    categories: { 3: { groups: {
      200: { status: 'published', parts: [{ part: 1, partsTotal: 1, objectKey: 'history/3/200.json.gz' }] }
    } } }
  };
}

function historyGroupPayload() {
  return {
    modelVersion: 'tcgcsv-history-v1',
    categoryId: 3,
    groupId: 200,
    part: 1,
    partsTotal: 1,
    variants: [{ productId: PRODUCT.productId, subTypeName: PRODUCT.subtypeName, points: weeklyPoints() }]
  };
}

async function configureStubs(page) {
  await page.route('**/runtime-config.js', (route) => route.fulfill({
    contentType: 'application/javascript',
    body: `window.COLLECTFOLIO_CONFIG = Object.freeze({
      SUPABASE_URL: window.location.origin + '/__portfolio-history-cloud',
      SUPABASE_ANON_KEY: 'synthetic-browser-key',
      APP_VERSION: '0.8.0-test',
      TCGCSV_CATALOG_URL: '${TCGCSV_ORIGIN}/',
      ENABLE_TESSERACT: false,
      ENABLE_PRICE_INTELLIGENCE: false,
      ENABLE_CLOUD_DATA_REMOVAL: false
    });`
  }));
  await page.route('**/__portfolio-history-cloud/**', (route) => route.fulfill({ contentType: 'application/json', body: '[]' }));

  await page.route(`${TCGCSV_ORIGIN}/catalog/search**`, (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      products: [{
        productId: PRODUCT.productId,
        categoryId: PRODUCT.categoryId,
        groupId: PRODUCT.groupId,
        categoryName: 'Pokemon',
        groupName: `Group ${PRODUCT.groupId}`,
        name: PRODUCT.name,
        cleanName: PRODUCT.name,
        prices: [{ subtypeName: PRODUCT.subtypeName, marketPrice: PRODUCT.marketPrice }]
      }],
      publicationId: 'e2e', sourceUpdatedAt: '2026-08-10'
    })
  }));

  await page.route(`${TCGCSV_ORIGIN}/catalog/history/manifest**`, (route) => route.fulfill({
    contentType: 'application/json', body: JSON.stringify(historyManifestPayload())
  }));
  await page.route(`${TCGCSV_ORIGIN}/catalog/history/3/200**`, (route) => route.fulfill({
    contentType: 'application/json', body: JSON.stringify(historyGroupPayload())
  }));
}

async function addProductToCollection(page) {
  await page.goto('/discover/search?category=tcgcsv-category-3&provider=tcgcsv');
  await page.getByPlaceholder('Search cards, sets, players, products, or set codes').fill('Retro History');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  const result = page.locator('.result-card', { hasText: PRODUCT.name });
  await expect(result).toBeVisible();
  await result.getByRole('button', { name: 'Confirm exact item', exact: true }).click();
  const inspector = page.getByRole('dialog', { name: PRODUCT.name });
  await inspector.getByRole('button', { name: 'Confirm exact item', exact: true }).click();
  await inspector.getByRole('button', { name: 'Add to collection', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add item to collection' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Add to collection' }).click();
  await expect(dialog).toHaveCount(0);
  await inspector.getByRole('button', { name: 'Close item inspector' }).click();
  await expect(inspector).toHaveCount(0);
}

test('the overview line graph renders from retro-reconstructed TCGCSV history when no local snapshot exists', async ({ page }) => {
  await configureStubs(page);
  await skipOnboarding(page);
  await addProductToCollection(page);

  await page.goto('/home');
  await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible();
  const chart = page.locator('.overview-performance svg.trend-chart');
  await expect(chart).toBeVisible();
  // A real reconstructed series has many points; a bare single "today"
  // snapshot (the pre-fix behavior) would produce a polyline with only
  // one coordinate pair, which is functionally invisible as a line.
  const marketPoints = await chart.locator('polyline.chart-market').getAttribute('points');
  expect(marketPoints.trim().split(/\s+/).length).toBeGreaterThan(2);
  await expect(page.getByText(/history coverage/)).toBeVisible();
});

test('Collection keeps reconstructed history compact instead of duplicating the Home chart', async ({ page }) => {
  await configureStubs(page);
  await skipOnboarding(page);
  await addProductToCollection(page);

  await page.goto('/collection/items');
  await expect(page.getByRole('heading', { name: 'Collection', exact: true })).toBeVisible();
  await expect(page.locator('.portfolio-value-trend')).toHaveCount(0);
  const chart = page.locator('svg.collection-sparkline');
  await expect(chart).toBeVisible();
  const marketPoints = await chart.locator('polyline').getAttribute('points');
  expect(marketPoints.trim().split(/\s+/).length).toBeGreaterThan(2);
  await expect(chart).toHaveAttribute('aria-label', /Collection value/);
});
