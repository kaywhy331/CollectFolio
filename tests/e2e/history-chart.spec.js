import { expect, test } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

const TCGCSV_ORIGIN = 'https://tcgcsv-history-e2e.example.test';

async function skipOnboarding(page) {
  await page.goto('/');
  const onboarding = page.getByRole('heading', { name: 'Set up CollectFolio' });
  const overview = page.getByRole('heading', { name: 'Overview', exact: true });
  await expect(onboarding.or(overview).first()).toBeVisible();
  if (await onboarding.isVisible()) {
    await page.getByRole('button', { name: /Skip setup and use recommended defaults/ }).click();
    await expect(onboarding).toBeHidden();
  }
}

// 100 = history + forecast (bars + projection overlay); 101 = history
// only, no published forecast (bars-only, no projection overlay); 102 =
// no history object at all (no chart, fail-closed).
const PRODUCTS = [
  { categoryId: 3, groupId: 100, productId: 5001, name: 'History And Forecast Card', subtypeName: 'Holofoil', marketPrice: 120 },
  { categoryId: 3, groupId: 101, productId: 5002, name: 'History Only Card', subtypeName: 'Holofoil', marketPrice: 40 },
  { categoryId: 3, groupId: 102, productId: 5003, name: 'No History Card', subtypeName: 'Holofoil', marketPrice: 20 }
];

function weeklyPoints(count, startPrice) {
  const points = [];
  for (let week = 0; week < count; week += 1) {
    const day = String(1 + (week % 28)).padStart(2, '0');
    const month = String(1 + Math.floor(week / 28)).padStart(2, '0');
    points.push([`2026-${month}-${day}`, startPrice + week]);
  }
  return points;
}

function tcgcsvSearchProduct(product) {
  return {
    productId: product.productId,
    categoryId: product.categoryId,
    groupId: product.groupId,
    categoryName: 'Pokemon',
    groupName: `Group ${product.groupId}`,
    name: product.name,
    cleanName: product.name,
    prices: [{ subtypeName: product.subtypeName, marketPrice: product.marketPrice }]
  };
}

function forecastManifestPayload() {
  return {
    asOf: '2026-08-10',
    categories: { 3: { groups: {
      100: { status: 'published', parts: [{ part: 1, partsTotal: 1, objectKey: 'forecasts/3/100.json.gz' }] }
    } } }
  };
}

function forecastGroupPayload() {
  return {
    asOf: '2026-08-10',
    modelVersion: 'trajectory-v1',
    part: 1,
    partsTotal: 1,
    variants: [{
      productId: 5001,
      subTypeName: 'Holofoil',
      confidence: 'standard',
      lastKnownPrice: 120,
      lastKnownDate: '2026-08-10',
      medianPath: [{ date: '2026-08-10', price: 120 }, { date: '2026-09-09', price: 128 }],
      horizons: {
        30: { q10: 108, q25: 115, q50: 128, q75: 138, q90: 148 },
        90: { q10: 100, q25: 118, q50: 140, q75: 160, q90: 180 }
      }
    }]
  };
}

function historyManifestPayload() {
  return {
    modelVersion: 'tcgcsv-history-v1',
    asOf: '2026-08-10',
    categories: { 3: { groups: {
      100: { status: 'published', parts: [{ part: 1, partsTotal: 1, objectKey: 'history/3/100.json.gz' }] },
      101: { status: 'published', parts: [{ part: 1, partsTotal: 1, objectKey: 'history/3/101.json.gz' }] }
      // 102 intentionally absent -- "no history object" fail-closed state.
    } } }
  };
}

function historyGroupPayload(groupId, productId, startPrice) {
  return {
    modelVersion: 'tcgcsv-history-v1',
    categoryId: 3,
    groupId,
    part: 1,
    partsTotal: 1,
    variants: [{ productId, subTypeName: 'Holofoil', points: weeklyPoints(20, startPrice) }]
  };
}

async function configureStubs(page) {
  await page.route('**/runtime-config.js', (route) => route.fulfill({
    contentType: 'application/javascript',
    body: `window.COLLECTFOLIO_CONFIG = Object.freeze({
      SUPABASE_URL: window.location.origin + '/__history-cloud',
      SUPABASE_ANON_KEY: 'synthetic-browser-key',
      APP_VERSION: '0.8.0-test',
      TCGCSV_CATALOG_URL: '${TCGCSV_ORIGIN}/',
      ENABLE_TESSERACT: false,
      ENABLE_PRICE_INTELLIGENCE: false,
      ENABLE_CLOUD_DATA_REMOVAL: false
    });`
  }));
  await page.route('**/__history-cloud/**', (route) => route.fulfill({ contentType: 'application/json', body: '[]' }));

  await page.route(`${TCGCSV_ORIGIN}/catalog/search**`, (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ products: PRODUCTS.map(tcgcsvSearchProduct), publicationId: 'e2e', sourceUpdatedAt: '2026-08-10' })
  }));

  await page.route(`${TCGCSV_ORIGIN}/catalog/forecasts/manifest**`, (route) => route.fulfill({
    contentType: 'application/json', body: JSON.stringify(forecastManifestPayload())
  }));
  await page.route(`${TCGCSV_ORIGIN}/catalog/forecasts/3/100**`, (route) => route.fulfill({
    contentType: 'application/json', body: JSON.stringify(forecastGroupPayload())
  }));

  await page.route(`${TCGCSV_ORIGIN}/catalog/history/manifest**`, (route) => route.fulfill({
    contentType: 'application/json', body: JSON.stringify(historyManifestPayload())
  }));
  await page.route(`${TCGCSV_ORIGIN}/catalog/history/3/100**`, (route) => route.fulfill({
    contentType: 'application/json', body: JSON.stringify(historyGroupPayload(100, 5001, 100))
  }));
  await page.route(`${TCGCSV_ORIGIN}/catalog/history/3/101**`, (route) => route.fulfill({
    contentType: 'application/json', body: JSON.stringify(historyGroupPayload(101, 5002, 30))
  }));
}

async function runSearch(page) {
  await page.goto('/discover?category=tcgcsv-category-3&provider=tcgcsv');
  await page.getByPlaceholder('Card, set, number, character, or player').fill('Card');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  const withForecast = page.locator('.result-card', { hasText: 'History And Forecast Card' });
  const historyOnly = page.locator('.result-card', { hasText: 'History Only Card' });
  const noHistory = page.locator('.result-card', { hasText: 'No History Card' });
  await expect(withForecast).toBeVisible();
  await expect(historyOnly).toBeVisible();
  await expect(noHistory).toBeVisible();
  return { withForecast, historyOnly, noHistory };
}

test('history line chart renders on the full detail page with forecast projection marks for a served item', async ({ page }) => {
  await configureStubs(page);
  await skipOnboarding(page);
  const { withForecast } = await runSearch(page);
  await withForecast.click();
  await page.getByRole('button', { name: 'Open full details' }).click();
  await expect(page.getByRole('heading', { name: 'Observed prices with rolling forecast' })).toBeVisible();
  const chart = page.locator('.history-chart-card svg.history-bars');
  await expect(chart).toBeVisible();
  await expect(chart.locator('polyline.history-line')).toBeVisible();
  await expect(chart.locator('polyline.history-forecast-line').first()).toBeVisible();
  await expect(chart.locator('line.history-bar-whisker')).toHaveCount(2);
  await expect(page.getByText('+30d est.')).toBeVisible();
  await expect(page.getByText('+90d est.')).toBeVisible();
});

test('history line chart renders a history-only line with no projection overlay when no forecast is published', async ({ page }) => {
  await configureStubs(page);
  await skipOnboarding(page);
  const { historyOnly } = await runSearch(page);
  await historyOnly.click();
  await page.getByRole('button', { name: 'Open full details' }).click();
  await expect(page.getByRole('heading', { name: 'Observed prices', exact: true })).toBeVisible();
  const chart = page.locator('.history-chart-card svg.history-bars');
  await expect(chart).toBeVisible();
  await expect(chart.locator('polyline.history-line')).toBeVisible();
  await expect(chart.locator('polyline.history-forecast-line')).toHaveCount(0);
  await expect(page.getByText('+30d est.')).toHaveCount(0);
});

test('history line chart fails closed (no chart at all) when no history object was ever published', async ({ page }) => {
  await configureStubs(page);
  await skipOnboarding(page);
  const { noHistory } = await runSearch(page);
  await noHistory.click();
  await page.getByRole('button', { name: 'Open full details' }).click();
  await expect(page.locator('.history-chart-card')).toHaveCount(0);
});

test('history line chart renders a compact variant in the Quick Inspector drawer', async ({ page }) => {
  await configureStubs(page);
  await skipOnboarding(page);
  const { withForecast } = await runSearch(page);
  await withForecast.click();
  await expect(page.locator('.quick-inspector')).toBeVisible();
  const chart = page.locator('.inspector-history svg.history-bars');
  await expect(chart).toBeVisible();
  await expect(chart.locator('polyline.history-line')).toBeVisible();
});
