import { test, expect } from '@playwright/test';

// catalog-v2 B3 (search primacy): magic/pokemon/yugioh search now always
// resolves through TCGCSV (services/providers/tcgcsv.js), which caps a
// search at MAX_SEARCH_RESULTS (200) total, across as many cursor-paginated
// upstream pages as it takes to reach that cap. This spec previously
// stubbed Scryfall's own (uncapped) pagination directly to prove a >200
// result set arrives and gets shown in growing UI batches; that specific
// >200-in-one-search scenario can no
// longer occur for any category now that TCGCSV is the sole search
// backend, so this test instead proves the two things that still matter
// post-B3: (1) the client keeps following TCGCSV's cursor until the cap is
// hit rather than stopping at the first page, and (2) the complete result
// set is exposed through fixed 48-tile pages without a growing DOM.
const TCGCSV_ORIGIN = 'https://tcgcsv-e2e-pagination.example.test';

function tcgcsvProduct(index) {
  return {
    productId: 9000 + index,
    categoryId: 1,
    groupId: 601,
    categoryName: 'Magic: The Gathering',
    groupName: 'Pagination Set',
    name: `Dragon ${index}`,
    cleanName: `Dragon ${index}`,
    prices: [{ subtypeName: 'Normal', marketPrice: 1 }]
  };
}

async function skipOnboarding(page) {
  await page.goto('/');
  const onboarding = page.getByRole('heading', { name: 'Set up CollectFolio' });
  const overview = page.getByRole('heading', { name: 'Home', exact: true });
  await expect(onboarding.or(overview).first()).toBeVisible();
  if (await onboarding.isVisible()) {
    await page.getByRole('button', { name: /Skip setup and use recommended defaults/ }).click();
    await expect(onboarding).toBeHidden();
  }
  await page.goto('/discover/search');
  await expect(page.getByRole('heading', { name: 'Discover' })).toBeVisible();
}

test('Discover follows TCGCSV cursors to the search cap and renders fixed 48-tile pages', async ({ page }) => {
  await page.route('**/runtime-config.js', (route) => route.fulfill({
    contentType: 'application/javascript',
    body: `window.COLLECTFOLIO_CONFIG = Object.freeze({
      SUPABASE_URL: window.location.origin + '/__pagination-cloud',
      SUPABASE_ANON_KEY: 'synthetic-browser-key',
      APP_VERSION: '0.8.33-test',
      TCGCSV_CATALOG_URL: '${TCGCSV_ORIGIN}/',
      ENABLE_TESSERACT: false,
      ENABLE_PRICE_INTELLIGENCE: false,
      ENABLE_CLOUD_DATA_REMOVAL: false
    });`
  }));
  await page.route('**/__pagination-cloud/**', (route) => route.fulfill({ contentType: 'application/json', body: '[]' }));

  // 250 rows are available upstream, spread across three cursor pages --
  // the client's cap (200) is hit after the second page, so the third
  // page must never be requested.
  const allProducts = Array.from({ length: 250 }, (_, index) => tcgcsvProduct(index));
  let thirdPageRequested = false;
  await page.route(`${TCGCSV_ORIGIN}/catalog/search**`, (route) => {
    const url = new URL(route.request().url());
    const cursor = url.searchParams.get('cursor') || '';
    if (cursor === '') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ products: allProducts.slice(0, 100), nextCursor: 'page-2', publicationId: 'e2e-pagination', sourceUpdatedAt: '2026-08-17' }) });
    }
    if (cursor === 'page-2') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ products: allProducts.slice(100, 200), nextCursor: 'page-3', publicationId: 'e2e-pagination', sourceUpdatedAt: '2026-08-17' }) });
    }
    thirdPageRequested = true;
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ products: allProducts.slice(200, 250), nextCursor: '', publicationId: 'e2e-pagination', sourceUpdatedAt: '2026-08-17' }) });
  });

  await skipOnboarding(page);
  await page.locator('#catalog-query').fill('dragon');
  await page.locator('#catalog-search').getByRole('button', { name: 'Search', exact: true }).click();

  // Both upstream pages needed to reach the 200-result search cap were
  // fetched, but only one 48-tile UI page is mounted at a time.
  await expect(page.locator('.result-card')).toHaveCount(48);
  await expect(page.locator('.discover-results-head strong')).toHaveText('Showing 1–48 of 200 results');
  await expect(page.locator('.catalog-pagination')).toContainText('Page 1 of 5');

  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.locator('.result-card')).toHaveCount(48);
  await expect(page.locator('.result-card h3').first()).toHaveText('Dragon 48');
  await expect(page.locator('.result-card h3').last()).toHaveText('Dragon 95');
  await expect(page.locator('.catalog-pagination')).toContainText('Page 2 of 5');
  await expect(page.getByRole('button', { name: /Show \d+ more/ })).toHaveCount(0);

  expect(thirdPageRequested).toBe(false);
});
