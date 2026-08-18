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

// Four TCGCSV products in the same category (3 = Pokemon) but four
// different groups, one per display state: 100 = published/standard,
// 101 = published/cold-start, 102 = excluded (collapses to the same
// "insufficient evidence" honest state as an unrecognized/unknown group),
// 103 = published/standard but 90d-only serving mode (forecast-display-
// everywhere: the T5 publisher stripped the 30d horizon because only the
// 90d horizon passed the T4 holdout gate for this category/cohort).
const PRODUCTS = [
  { categoryId: 3, groupId: 100, productId: 5001, name: 'Trajectory Eligible Card', subtypeName: 'Holofoil', marketPrice: 120 },
  { categoryId: 3, groupId: 101, productId: 5002, name: 'Trajectory Cold Start Card', subtypeName: 'Holofoil', marketPrice: 80 },
  { categoryId: 3, groupId: 102, productId: 5003, name: 'Trajectory Excluded Card', subtypeName: 'Holofoil', marketPrice: 40 },
  { categoryId: 3, groupId: 103, productId: 5004, name: 'Trajectory 90d Only Card', subtypeName: 'Holofoil', marketPrice: 60 },
  // 104 = published/low-history (serve-all-cohorts mode, Kevin 2026-08-18):
  // served everywhere but labeled as an early estimate, never presented as
  // a fully modeled forecast.
  { categoryId: 3, groupId: 104, productId: 5005, name: 'Trajectory Early Estimate Card', subtypeName: 'Holofoil', marketPrice: 30 }
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
          102: { status: 'excluded', reason: 'insufficient variants' },
          103: { status: 'published', parts: [{ part: 1, partsTotal: 1, objectKey: 'forecasts/3/103.json.gz' }] },
          104: { status: 'published', parts: [{ part: 1, partsTotal: 1, objectKey: 'forecasts/3/104.json.gz' }] }
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
  if (groupId === 103) {
    // forecast-display-everywhere: 90d-only serving mode. The publisher
    // strips this packet's horizons object down to just "90" -- the app
    // must render only the 3-month estimate and never fabricate a 30-day
    // one that was never published.
    return {
      asOf: '2026-08-10',
      modelVersion: 'trajectory-v1',
      part: 1,
      partsTotal: 1,
      variants: [{
        productId: 5004,
        subTypeName: 'Holofoil',
        confidence: 'standard',
        lastKnownPrice: 60,
        lastKnownDate: '2026-08-10',
        medianPath: [{ date: '2026-08-10', price: 60 }, { date: '2026-11-08', price: 66 }],
        horizons: {
          90: { q10: 50, q25: 58, q50: 66, q75: 74, q90: 82 }
        }
      }]
    };
  }
  if (groupId === 104) {
    // Serve-all-cohorts mode: a low-history packet serves both horizons
    // with an explicit early-estimate label.
    return {
      asOf: '2026-08-10',
      modelVersion: 'trajectory-v1',
      part: 1,
      partsTotal: 1,
      variants: [{
        productId: 5005,
        subTypeName: 'Holofoil',
        confidence: 'low-history',
        lastKnownPrice: 30,
        lastKnownDate: '2026-08-10',
        medianPath: [{ date: '2026-08-10', price: 30 }, { date: '2026-09-09', price: 32 }],
        horizons: {
          30: { q10: 24, q25: 28, q50: 32, q75: 36, q90: 42 },
          90: { q10: 20, q25: 27, q50: 34, q75: 42, q90: 52 }
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
      ENABLE_PRICE_INTELLIGENCE: false,
      ENABLE_CLOUD_DATA_REMOVAL: false
    });`
  }));

  // Supabase stub: deliberately does NOT enable public_price_intelligence
  // (forecast-display-everywhere: trajectory-v1 forecasts are decoupled
  // from that Supabase rights gate and must render from their own
  // default-enabled trajectoryForecasts flag). This proves the fix -- the
  // trajectory-v1 packets below are what drive display, not this stub.
  await page.route('**/__trajectory-cloud/**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/product_feature_flags')) {
      return route.fulfill({ contentType: 'application/json', body: '[]' });
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
  await page.route(`${TCGCSV_ORIGIN}/catalog/forecasts/3/103**`, (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(groupPayload(103))
  }));
  await page.route(`${TCGCSV_ORIGIN}/catalog/forecasts/3/104**`, (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(groupPayload(104))
  }));
}

async function runSearch(page) {
  await page.goto('/discover?category=tcgcsv-category-3&provider=tcgcsv');
  await page.getByPlaceholder('Card, set, number, character, or player').fill('Trajectory');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  const eligibleCard = page.locator('.result-card', { hasText: 'Trajectory Eligible Card' });
  const coldStartCard = page.locator('.result-card', { hasText: 'Trajectory Cold Start Card' });
  const excludedCard = page.locator('.result-card', { hasText: 'Trajectory Excluded Card' });
  const ninetyDayOnlyCard = page.locator('.result-card', { hasText: 'Trajectory 90d Only Card' });
  const earlyEstimateCard = page.locator('.result-card', { hasText: 'Trajectory Early Estimate Card' });
  await expect(eligibleCard).toBeVisible();
  await expect(coldStartCard).toBeVisible();
  await expect(excludedCard).toBeVisible();
  await expect(ninetyDayOnlyCard).toBeVisible();
  await expect(earlyEstimateCard).toBeVisible();
  return { eligibleCard, coldStartCard, excludedCard, ninetyDayOnlyCard, earlyEstimateCard };
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
  // Uniform template (Kevin 2026-08-18): the outlook block still renders
  // with the same 1 mo / 3 mo slots as every other card, but with explicit
  // "—" placeholders instead of values.
  await expect(excludedCard.getByText('No published outlook', { exact: true })).toBeVisible();
  await expect(excludedCard.locator('.result-market-outlook')).toBeVisible();
  await expect(excludedCard.getByText('1 mo est.', { exact: true })).toBeVisible();
  await expect(excludedCard.getByText('3 mo est.', { exact: true })).toBeVisible();
  await expect(excludedCard.getByText('Not enough data yet').first()).toBeVisible();
  await expect(excludedCard.locator('.result-market-outlook dd', { hasText: '$' })).toHaveCount(0);

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

test('trajectory-v1 90d-only serving mode renders only the gate-passed horizon, never a fabricated 30-day estimate', async ({ page }) => {
  // forecast-display-everywhere: categories 1/2 standard cohort are served
  // 90d-only (the T4 holdout gate only passed the 90-day horizon), and
  // this must render as an honestly-partial forecast, not a fabricated
  // 30-day block. The Supabase public_price_intelligence flag is off in
  // this stub (see configureTrajectoryStubs) -- trajectory-v1 forecasts
  // must still render because they're gated by their own default-enabled
  // trajectoryForecasts flag, decoupled from that Supabase rights gate.
  await configureTrajectoryStubs(page);
  await skipOnboarding(page);

  const { ninetyDayOnlyCard } = await runSearch(page);

  await expect(ninetyDayOnlyCard.locator('.result-market-outlook')).toBeVisible();
  await expect(ninetyDayOnlyCard.getByText('3 mo est.', { exact: true })).toBeVisible();
  // Uniform template (Kevin 2026-08-18): the 1 mo slot still renders, but
  // as an explicit placeholder -- never a fabricated 30-day value.
  await expect(ninetyDayOnlyCard.getByText('1 mo est.', { exact: true })).toBeVisible();
  await expect(ninetyDayOnlyCard.getByText('Not enough data yet')).toHaveCount(1);
  await expect(ninetyDayOnlyCard.getByText('Published outlook', { exact: true })).toBeVisible();

  await ninetyDayOnlyCard.click();
  await page.getByRole('button', { name: 'Open full details' }).click();
  await expect(page.getByRole('heading', { name: 'Modeled trajectory' })).toBeVisible();
  await expect(page.getByText('90-day outlook')).toBeVisible();
  await expect(page.getByText('30-day outlook')).toHaveCount(0);
  await expect(page.getByText('Insufficient evidence for a price forecast')).toHaveCount(0);
});

test('serve-all-cohorts (2026-08-18): a low-history packet renders labeled early estimates on card and detail', async ({ page }) => {
  await configureTrajectoryStubs(page);
  await skipOnboarding(page);

  const { earlyEstimateCard } = await runSearch(page);

  await expect(earlyEstimateCard.locator('.result-market-outlook')).toBeVisible();
  await expect(earlyEstimateCard.getByText('1 mo est.', { exact: true })).toBeVisible();
  await expect(earlyEstimateCard.getByText('3 mo est.', { exact: true })).toBeVisible();
  await expect(earlyEstimateCard.getByText(/early estimate/).first()).toBeVisible();
  await expect(earlyEstimateCard.locator('.result-outlook-note')).toContainText('Early estimate');
  await expect(earlyEstimateCard.getByText('cold start estimate')).toHaveCount(0);

  await earlyEstimateCard.click();
  await page.getByRole('button', { name: 'Open full details' }).click();
  await expect(page.getByRole('heading', { name: 'Early estimate', exact: true })).toBeVisible();
  await expect(page.getByText(/short observed price history/).first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Modeled trajectory' })).toHaveCount(0);
});

test('bugfix (0.8.17): a card-detail deep link with no prior search still hydrates trajectory forecasts', async ({ page }) => {
  // Regression for the live bug report: hydrateCardRoute() set activeDetail
  // and enriched the item, but never fired hydrateTrajectoryForecasts()
  // (that only ran inside hydrateIntelligence(), which a deep link never
  // invokes). Navigating straight to /cards/<id> with no prior search must
  // still fetch and render the published forecast.
  await configureTrajectoryStubs(page);
  await page.route(`${TCGCSV_ORIGIN}/catalog/products/3/100/5001**`, (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      product: {
        productId: 5001,
        categoryId: 3,
        groupId: 100,
        name: 'Trajectory Eligible Card',
        cleanName: 'Trajectory Eligible Card',
        prices: [{ subtypeName: 'Holofoil', marketPrice: 120 }]
      },
      category: { categoryId: 3, displayName: 'Pokemon' },
      group: { groupId: 100, name: 'Group 100' },
      publicationId: 'e2e',
      sourceUpdatedAt: '2026-08-10'
    })
  }));
  await skipOnboarding(page);

  await page.goto('/cards/tcgcsv%3A3%3A100%3A5001');
  // A card-detail deep link renders the full detail page directly (no
  // Quick Inspector drawer / "Open full details" step in between).
  await expect(page.getByRole('heading', { name: 'Trajectory Eligible Card' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Modeled trajectory' })).toBeVisible();
  await expect(page.locator('.trajectory-chart svg')).toBeVisible();
  await expect(page.getByText('Insufficient evidence for a price forecast')).toHaveCount(0);
});
