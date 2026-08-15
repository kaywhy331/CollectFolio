import { test, expect } from '@playwright/test';

async function skipOnboarding(page) {
  await page.goto('/');
  const onboarding = page.getByRole('heading', { name: 'Set up CollectFolio' });
  const overview = page.getByRole('heading', { name: 'Overview', exact: true });
  await expect(onboarding.or(overview).first()).toBeVisible();
  if (await onboarding.isVisible()) {
    await page.getByRole('button', { name: /Skip setup and use recommended defaults/ }).click();
    await expect(onboarding).toBeHidden();
  }
  await page.goto('/discover?mode=search');
  await expect(page.getByRole('heading', { name: 'Discover' })).toBeVisible();
}

test('Discover retains every provider page and reveals complete results in bounded batches', async ({ page }) => {
  await page.route('https://api.scryfall.com/cards/search**', async (route) => {
    const url = new URL(route.request().url());
    const pageNumber = Number(url.searchParams.get('page') || 1);
    const count = pageNumber < 3 ? 250 : 27;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        object: 'list',
        has_more: pageNumber < 3,
        next_page: pageNumber < 3 ? `https://api.scryfall.com/cards/search?q=dragon&page=${pageNumber + 1}` : undefined,
        data: Array.from({ length: count }, (_, index) => ({
          id: `dragon-${pageNumber}-${index}`,
          name: `Dragon ${pageNumber}-${index}`,
          set_name: 'Pagination Set',
          collector_number: `${pageNumber}-${index}`,
          prices: {}
        }))
      })
    });
  });

  await skipOnboarding(page);
  await page.locator('details.discover-filters > summary').click();
  await page.locator('#catalog-search [name="category"]').selectOption('magic');
  await page.locator('#catalog-query').fill('dragon');
  await page.locator('#catalog-search').getByRole('button', { name: 'Search', exact: true }).click();

  await expect(page.getByText('Showing 200 of 527 results')).toBeVisible();
  await expect(page.locator('.result-card')).toHaveCount(200);

  await page.getByRole('button', { name: 'Show 200 more' }).click();
  await expect(page.getByText('Showing 400 of 527 results')).toBeVisible();
  await expect(page.locator('.result-card')).toHaveCount(400);

  await page.getByRole('button', { name: 'Show all 527' }).click();
  await expect(page.locator('.discover-results-head strong')).toHaveText('527 results');
  await expect(page.locator('.result-card')).toHaveCount(527);
});
