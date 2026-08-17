import { expect, test } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

const TCGCSV_ORIGIN = 'https://tcgcsv-e2e.example.test';

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

// Three TCGCSV products in the same category (3 = Pokemon) but three
// different groups, one per T6 display state: 100 = published/standard,
// 101 = published/cold-start, 102 = excluded (collapses to the same
// "insufficient evidence" honest state as an unrecognized/unknown group).
const PRODUCTS = [
  { categoryId: 3, groupId: 100, productId: 5001, name: 'Trajectory Eligible Card', subtypeName: 'Holofoil', marketPrice: 120 },
  { categoryId: 3, groupId: 101, productId: 5002, name: 'Trajectory Cold Start Card', subtypeName: 'Holofoil', marketPrice: 80 },
  { categoryId: 3, groupId: 102, productId: 5003, name: 'Trajectory Excluded Card', subtypeName: 'Holofoil', marketPrice: 40 }
];

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

function manifestPayload() {
  return {
    asOf: '2026-08-10',
    categories: {
      3: {
        groups: {
          100: { status: 'published', parts: [{ part: 1, partsTotal: 1, objectKey: 'forecasts/3/100.json.gz' }] },
          101: { status: 'published', parts: [{ part: 1, partsTotal: 1, objectKey: 'forecasts/3/101.json.gz' }] },
          102: { status: 'excluded', reason: 'insufficient variants' }
        }
      }
    }
  };
}

function groupPayload(groupId) {
  if (groupId === 100) {
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
  if (groupId === 101) {
    return {
      asOf: '2026-08-10',
      modelVersion: 'trajectory-v1',
      part: 1,
      partsTotal: 1,
      variants: [{
        productId: 5002,
        subTypeName: 'Holofoil',
        confidence: 'cold-start',
        lastKnownPrice: 80,
        lastKnownDate: '2026-08-05',
        medianPath: [{ date: '2026-08-05', price: 80 }],
        horizons: {
          30: { q10: 50, q25: 65, q50: 85, q75: 105, q90: 130 },
          90: { q10: 40, q25: 60, q50: 95, q75: 130, q90: 170 }
        }
      }]
    };
  }
  return { asOf: '2026-08-10', modelVersion: 'trajectory-v1', part: 1, partsTotal: 1, variants: [] };
}

async function configureTrajectoryStubs(page) {
  await page.route('**/runtime-config.js', (route) => route.fulfill({
    contentType: 'application/javascript',
    body: `window.COLLECTFOLIO_CONFIG = Object.freeze({
      SUPABASE_URL: window.location.origin + '/__trajectory-cloud',
      SUPABASE_ANON_KEY: 'synthetic-browser-key',
      APP_VERSION: '0.8.0-test',
      TCGCSV_CATALOG_URL: '${TCGCSV_ORIGIN}/',
      ENABLE_TESSERACT: false,
      ENABLE_PRICE_INTELLIGENCE: true,
      ENABLE_CLOUD_DATA_REMOVAL: false
    });`
  }));

  // Supabase stub: only used here to flip on the publicPriceIntelligence
  // feature flag (product_feature_flags) and return no other published
  // intelligence -- the trajectory-v1 packets below are what drive display.
  await page.route('**/__trajectory-cloud/**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/product_feature_flags')) {
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify([{ key: 'public_price_intelligence', enabled: true, updated_at: '2026-08-01T00:00:00Z' }])
      });
    }
    return route.fulfill({ contentType: 'application/json', body: '[]' });
  });

  // TCGCSV catalog stub: a single search response carrying all three
  // demo products, plus the trajectory-v1 manifest and per-group forecast
  // object routes T5 built on the worker.
  await page.route(`${TCGCSV_ORIGIN}/catalog/search**`, (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ products: PRODUCTS.map(tcgcsvSearchProduct), publicationId: 'e2e', sourceUpdatedAt: '2026-08-10' })
  }));
  await page.route(`${TCGCSV_ORIGIN}/catalog/forecasts/manifest**`, (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(manifestPayload())
  }));
  await page.route(`${TCGCSV_ORIGIN}/catalog/forecasts/3/100**`, (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(groupPayload(100))
  }));
  await page.route(`${TCGCSV_ORIGIN}/catalog/forecasts/3/101**`, (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(groupPayload(101))
  }));
}

async function runSearch(page) {
  await page.goto('/discover?category=tcgcsv-category-3&provider=tcgcsv');
  await page.getByPlaceholder('Card, set, number, character, or player').fill('Trajectory');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  const eligibleCard = page.locator('.result-card', { hasText: 'Trajectory Eligible Card' });
  const coldStartCard = page.locator('.result-card', { hasText: 'Trajectory Cold Start Card' });
  const excludedCard = page.locator('.result-card', { hasText: 'Trajectory Excluded Card' });
  await expect(eligibleCard).toBeVisible();
  await expect(coldStartCard).toBeVisible();
  await expect(excludedCard).toBeVisible();
  return { eligibleCard, coldStartCard, excludedCard };
}

test('trajectory-v1 forecasts render the three fail-closed display states from a stubbed worker response', async ({ page }) => {
  await configureTrajectoryStubs(page);
  await skipOnboarding(page);

  const { eligibleCard, coldStartCard, excludedCard } = await runSearch(page);

  // State 1 -- published/standard: a modeled outlook with no cold-start
  // labeling, presented as the normal published forecast.
  await expect(eligibleCard.locator('.result-market-outlook')).toBeVisible();
  await expect(eligibleCard.getByText('Published outlook', { exact: true })).toBeVisible();
  await expect(eligibleCard.getByText('cold start estimate')).toHaveCount(0);

  // State 2 -- published/cold-start: explicitly labeled, never presented
  // as a standard-confidence forecast.
  await expect(coldStartCard.getByText(/cold start estimate/).first()).toBeVisible();
  await expect(coldStartCard.locator('.result-outlook-note')).toContainText('Cold start estimate');

  // State 3 -- excluded (collapses with "unknown" per the fail-closed
  // manifest map): no fabricated band, no local-scenario-v1 standing in.
  await expect(excludedCard.getByText('No published outlook', { exact: true })).toBeVisible();
  await expect(excludedCard.locator('.result-market-outlook')).toHaveCount(0);

  // Drill into the eligible card's detail view for the full trajectory
  // chart + q50 horizon display.
  await eligibleCard.click();
  await page.getByRole('button', { name: 'Open full details' }).click();
  await expect(page.getByRole('heading', { name: 'Modeled trajectory' })).toBeVisible();
  await expect(page.locator('.trajectory-chart svg')).toBeVisible();
  await expect(page.getByText('Insufficient evidence for a price forecast')).toHaveCount(0);

  // Drill into the cold-start card's detail view (fresh search: a
  // detail-page reload can drop the client-side search results list, so
  // each drill-down re-runs the search rather than relying on history).
  const coldRun = await runSearch(page);
  await coldRun.coldStartCard.click();
  await page.getByRole('button', { name: 'Open full details' }).click();
  await expect(page.getByRole('heading', { name: 'Cold start estimate' })).toBeVisible();
  await expect(page.getByText(/wider and less certain than a standard forecast/).first()).toBeVisible();

  // Drill into the excluded card's detail view: honest "insufficient
  // evidence" state, not a fabricated band, not local-scenario-v1.
  const excludedRun = await runSearch(page);
  await excludedRun.excludedCard.click();
  await page.getByRole('button', { name: 'Open full details' }).click();
  await expect(page.getByText('Insufficient evidence for a price forecast')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Modeled trajectory' })).toHaveCount(0);
  await expect(page.getByText('Manual scenario outlook')).toHaveCount(0);
});
