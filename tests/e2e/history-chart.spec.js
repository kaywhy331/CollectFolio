import { expect, test } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

const TCGCSV_ORIGIN = 'https://tcgcsv-history-e2e.example.test';

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
  const end = Date.parse('2026-08-10T00:00:00.000Z');
  for (let week = 0; week < count; week += 1) {
    const time = end - ((count - 1 - week) * 7 * 86_400_000);
    points.push([new Date(time).toISOString().slice(0, 10), startPrice + week]);
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
    modelVersion: 'trajectory-v1.1',
    asOf: '2026-08-10',
    categories: { 3: { groups: {
      100: { status: 'published', parts: [{ part: 1, partsTotal: 1, objectKey: 'forecasts/3/100.json.gz' }] }
    } } }
  };
}

function forecastGroupPayload() {
  return {
    categoryId: 3,
    groupId: 100,
    asOf: '2026-08-10',
    modelVersion: 'trajectory-v1.1',
    part: 1,
    partsTotal: 1,
    variants: [{
      productId: 5001,
      subTypeName: 'Holofoil',
      confidence: 'standard',
      lastKnownPrice: 120,
      lastKnownDate: '2026-08-10',
      medianPath: [
        { date: '2026-08-10', price: 120 },
        { date: '2026-09-07', price: 128 },
        { date: '2026-10-12', price: 134 },
        { date: '2026-11-09', price: 140 }
      ],
      horizons: {
        30: { q10: 108, q25: 115, q50: 128, q75: 138, q90: 148, horizonDaysActual: 28, evidenceTier: 'category-validated' },
        60: { q10: 104, q25: 118, q50: 134, q75: 150, q90: 166, horizonDaysActual: 63, evidenceTier: 'category-validated' },
        90: { q10: 100, q25: 118, q50: 140, q75: 160, q90: 180, horizonDaysActual: 91, evidenceTier: 'category-validated' }
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
  await page.goto('/discover/search?category=tcgcsv-category-3&provider=tcgcsv');
  await page.getByPlaceholder('Search the catalog').fill('Card');
  await page.locator('#catalog-search').getByRole('button', { name: 'Search', exact: true }).click();
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
  await expect(page.getByRole('heading', { name: 'Price history & latest forecast' })).toBeVisible();
  const chart = page.locator('.history-chart-card svg.history-bars');
  await expect(chart).toBeVisible();
  await expect(chart.locator('polyline.history-line')).toBeVisible();
  await expect(chart.locator('polyline.history-forecast-line').first()).toBeVisible();
  await expect(chart.locator('line.history-bar-whisker')).toHaveCount(3);
  await expect(page.getByText('+30d est.')).toBeVisible();
  await expect(page.getByText('+60d est.')).toBeVisible();
  await expect(page.getByText('+90d est.')).toBeVisible();
  await expect(chart.locator('text[data-price-role="observed"]')).toHaveText('$119.00');
  const expectedForecastPrices = {
    30: { low: '$108.00', midpoint: '$128.00', high: '$148.00' },
    60: { low: '$104.00', midpoint: '$134.00', high: '$166.00' },
    90: { low: '$100.00', midpoint: '$140.00', high: '$180.00' }
  };
  for (const [horizon, prices] of Object.entries(expectedForecastPrices)) {
    for (const [role, price] of Object.entries(prices)) {
      const priceLabel = chart.locator(`text[data-forecast-horizon="${horizon}"][data-price-role="${role}"]`);
      await expect(priceLabel).toBeVisible();
      await expect(priceLabel).toHaveText(price);
    }
  }
  const priceLabelBoxes = await chart.locator('text.history-price-label').evaluateAll((labels) => labels.map((label) => {
    const box = label.getBBox();
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  }));
  expect(priceLabelBoxes).toHaveLength(10);
  for (const box of priceLabelBoxes) {
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(760);
    expect(box.y + box.height).toBeLessThanOrEqual(340);
  }
  const horizonLabelBoxes = await chart.locator('text.history-forecast-horizon-label').evaluateAll((labels) => labels.map((label) => {
    const box = label.getBBox();
    return { x: box.x, width: box.width };
  }));
  expect(horizonLabelBoxes).toHaveLength(3);
  for (const box of horizonLabelBoxes) {
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(760);
  }
  for (let leftIndex = 0; leftIndex < priceLabelBoxes.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < priceLabelBoxes.length; rightIndex += 1) {
      const leftBox = priceLabelBoxes[leftIndex];
      const rightBox = priceLabelBoxes[rightIndex];
      const overlapWidth = Math.min(leftBox.x + leftBox.width, rightBox.x + rightBox.width) - Math.max(leftBox.x, rightBox.x);
      const overlapHeight = Math.min(leftBox.y + leftBox.height, rightBox.y + rightBox.height) - Math.max(leftBox.y, rightBox.y);
      expect(
        overlapWidth > 0 && overlapHeight > 0,
        `price labels ${leftIndex} and ${rightIndex} overlap: ${JSON.stringify({ leftBox, rightBox })}`
      ).toBe(false);
    }
  }
  await expect(chart.locator('polygon.history-forecast-band')).toHaveCount(0);

  // Forecast is an independent overlay, while range controls affect only
  // the observed history window.
  const forecastToggle = page.getByRole('button', { name: 'Show forecast' });
  await expect(forecastToggle).toHaveAttribute('aria-pressed', 'true');
  await forecastToggle.click();
  await expect(forecastToggle).toHaveAttribute('aria-pressed', 'false');
  await expect(chart.locator('polyline.history-forecast-line')).toHaveCount(0);
  await expect(chart.locator('polygon.history-forecast-band')).toHaveCount(0);
  await expect(chart.locator('line.history-bar-whisker')).toHaveCount(0);
  await forecastToggle.click();
  await expect(chart.locator('polyline.history-forecast-line')).toBeVisible();

  await page.getByRole('button', { name: '1M', exact: true }).click();
  await expect(page.locator('.history-line-chart')).toHaveAttribute('data-history-range', '1M');
  await expect(chart.locator('circle.history-point')).toHaveCount(5);
  await page.getByRole('button', { name: 'All', exact: true }).click();
  await expect(chart.locator('circle.history-point')).toHaveCount(20);

  // Full-width card (Kevin 2026-08-18): the chart card spans the whole
  // detail grid, not one of the two columns.
  const cardBox = await page.locator('.history-chart-card').boundingBox();
  const gridBox = await page.locator('.detail-sections').boundingBox();
  expect(cardBox.width).toBeGreaterThan(gridBox.width * 0.9);

  // Hover tooltips (Kevin 2026-08-18): pointing at any x-position on the
  // chart surfaces the date it represents and the plotted price.
  await chart.scrollIntoViewIfNeeded();
  const box = await chart.boundingBox();
  await page.mouse.move(box.x + (box.width * 0.4), box.y + (box.height * 0.5));
  const tooltip = page.locator('.chart-tooltip');
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toHaveText(/[A-Z][a-z]{2} \d{1,2}, 2026 — \$\d/);
  // Pointing into the projection region (right of the today divider)
  // surfaces the nearest independent modeled checkpoint.
  await page.mouse.move(box.x + (box.width * 0.97), box.y + (box.height * 0.5));
  await expect(tooltip).toHaveText(/\(estimated\)/);
  // Leaving the chart hides the tooltip.
  await page.mouse.move(box.x + (box.width / 2), box.y + box.height + 120);
  await expect(tooltip).toBeHidden();
});

test('history line chart renders a history-only line with no projection overlay when no forecast is published', async ({ page }) => {
  await configureStubs(page);
  await skipOnboarding(page);
  const { historyOnly } = await runSearch(page);
  await historyOnly.click();
  await page.getByRole('button', { name: 'Open full details' }).click();
  await expect(page.getByRole('heading', { name: 'Price history', exact: true })).toBeVisible();
  const chart = page.locator('.history-chart-card svg.history-bars');
  await expect(chart).toBeVisible();
  await expect(chart.locator('polyline.history-line')).toBeVisible();
  await expect(chart.locator('polyline.history-forecast-line')).toHaveCount(0);
  await expect(page.getByText('+30d est.')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Show forecast' })).toHaveCount(0);
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
