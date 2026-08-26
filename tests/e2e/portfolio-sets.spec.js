import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

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

async function seedSetHoldings(page) {
  const holding = (id, item, quantity, manualMarketPrice, updatedAt) => ({
    id,
    catalogId: `${item.provider}:${item.externalId}`,
    canonicalVariantId: '',
    item,
    quantity,
    condition: 'Near Mint',
    marketCondition: 'near-mint',
    gradeCompany: '',
    grade: '',
    purchasePrice: 5,
    purchaseCurrency: 'USD',
    fees: 0,
    manualMarketPrice,
    manualMarketCurrency: 'USD',
    folder: '',
    tags: [],
    notes: '',
    userImage: '',
    createdAt: updatedAt,
    updatedAt,
    dirty: true
  });
  const alpha = {
    provider: 'scryfall', category: 'magic', game: 'Magic: The Gathering', setName: 'Alpha Set',
    name: 'Alpha Card', externalId: 'alpha-1', number: '1', variant: 'foil', language: 'en',
    image: '', imageSmall: '', price: null, currency: 'USD', priceSource: ''
  };
  const beta = {
    provider: 'pokemon', category: 'pokemon', game: 'Pokémon', setName: 'Beta Set',
    name: 'Beta Card', externalId: 'beta-1', number: '2', variant: 'holo', language: 'en',
    image: '', imageSmall: '', price: null, currency: 'USD', priceSource: ''
  };
  const similarlyNamed = {
    ...alpha, setName: 'Alpha Set 2', name: 'Other Alpha Card', externalId: 'alpha-2', number: '2'
  };
  const rows = [
    holding('alpha-lot-1', alpha, 2, 10, '2026-08-10T00:00:00.000Z'),
    holding('alpha-lot-2', alpha, 1, 12, '2026-08-11T00:00:00.000Z'),
    holding('beta-lot-1', beta, 1, '', '2026-08-09T00:00:00.000Z'),
    holding('alpha-2-lot', similarlyNamed, 1, 8, '2026-08-08T00:00:00.000Z')
  ];
  await page.evaluate(async (holdings) => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('collectfolio');
      request.addEventListener('success', () => resolve(request.result), { once: true });
      request.addEventListener('error', () => reject(request.error), { once: true });
    });
    await new Promise((resolve, reject) => {
      const transaction = database.transaction('holdings', 'readwrite');
      for (const row of holdings) transaction.objectStore('holdings').put(row);
      transaction.addEventListener('complete', resolve, { once: true });
      transaction.addEventListener('abort', () => reject(transaction.error), { once: true });
      transaction.addEventListener('error', () => reject(transaction.error), { once: true });
    });
    database.close();
  }, rows);
}

test('Collection Sets restores, filters, and drills into the exact local items', async ({ page }) => {
  await skipOnboarding(page);
  await seedSetHoldings(page);
  await page.goto('/collection/sets');

  await expect(page).toHaveURL(/\/collection\/sets$/);
  await expect(page.getByRole('heading', { name: 'Sets', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Sets' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.portfolio-set-card')).toHaveCount(3);
  await expect(page.getByText('1 distinct printing · 3 copies across 2 purchases')).toBeVisible();
  // DCL-COLL-03/Appendix C: the banned "completion percentage is
  // intentionally unavailable" fine print is deleted from set cards.
  await expect(page.getByText(/completion percentage is intentionally unavailable/)).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Sets', exact: true })).toBeVisible();

  await page.getByPlaceholder('Search collected sets').fill('Alpha');
  await expect(page.locator('.portfolio-set-card')).toHaveCount(2);
  const alphaCard = page.locator('.portfolio-set-card').filter({ has: page.getByRole('heading', { name: 'Alpha Set', exact: true }) });
  await alphaCard.getByRole('button', { name: 'View items' }).click();

  await expect(page).toHaveURL(/\/collection\/items$/);
  await expect(page.getByText('Set: Alpha Set')).toBeVisible();
  await expect(page.locator('.portfolio-holding-card')).toHaveCount(1);
  await expect(page.locator('.portfolio-holding-card')).toContainText('2 purchases');

  await page.getByRole('tab', { name: 'Sets' }).click();
  const report = await new AxeBuilder({ page })
    .include('#main-content')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(report.violations.filter((entry) => ['serious', 'critical'].includes(entry.impact))).toEqual([]);
});
