import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

const TCGCSV_ORIGIN = 'https://tcgcsv-browse-e2e.example.test';

// catalog-v2 B1: Pokémon/Magic/Yu-Gi-Oh! browse the TCGCSV catalog as their
// baseline product universe now (category 3/1/2), not the pokemontcg.io /
// Scryfall / YGOPRODeck APIs. These fixtures stand in for a flagship game's
// TCGCSV groups/products the way the worker would actually serve them.
const POKEMON_GROUPS = [
  { groupId: 1102, categoryId: 3, name: 'Silver Tempest', abbreviation: 'SIT', publishedOn: '2022-11-11', productCount: 121, supplemental: false },
  { groupId: 1, categoryId: 3, name: 'Base Set', abbreviation: 'BS', publishedOn: '1999-01-09', productCount: 102, supplemental: false }
];

function pokemonProducts(groupId, count) {
  return Array.from({ length: count }, (_, index) => {
    const name = index === 23
      ? 'Card 24 — A Very Long Complete Product Title With Every Collector Detail Preserved'
      : `Card ${index + 1}`;
    return {
    productId: 5000 + index,
    categoryId: 3,
    groupId,
    name,
    cleanName: name,
    cardNumber: String(index + 1),
    rarity: index % 10 === 0 ? 'Rare' : 'Common',
    prices: []
    };
  });
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
}

async function mockRuntimeConfig(page) {
  await page.route('**/runtime-config.js', (route) => route.fulfill({
    contentType: 'application/javascript',
    body: `window.COLLECTFOLIO_CONFIG = Object.freeze({
      SUPABASE_URL: window.location.origin + '/__browse-cloud',
      SUPABASE_ANON_KEY: 'synthetic-browser-key',
      APP_VERSION: '0.8.0-test',
      TCGCSV_CATALOG_URL: '${TCGCSV_ORIGIN}/',
      ENABLE_TESSERACT: false,
      ENABLE_PRICE_INTELLIGENCE: false,
      ENABLE_CLOUD_DATA_REMOVAL: false
    });`
  }));
  await page.route('**/__browse-cloud/**', (route) => route.fulfill({ contentType: 'application/json', body: '[]' }));
}

// Flagship category groups: category 3 (Pokémon) carries the two-set demo
// fixture; categories 1 (Magic) and 2 (Yu-Gi-Oh!) are stubbed empty so the
// "all games" browse route (which always fetches all three flagship
// categories) resolves cleanly without needing unrelated fixtures.
async function mockFlagshipCatalog(page) {
  const metrics = { groupRequests: 0, productPageRequests: 0 };
  await mockRuntimeConfig(page);
  const categoryResponse = (route, category) => {
    metrics.groupRequests += 1;
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ groups: category.categoryId === 3 ? POKEMON_GROUPS : [], category, publicationId: 'e2e', sourceUpdatedAt: '2026-08-10' })
    });
  };
  await page.route(`${TCGCSV_ORIGIN}/catalog/categories/3/groups**`, (route) => categoryResponse(route, { categoryId: 3, displayName: 'Pokemon' }));
  await page.route(`${TCGCSV_ORIGIN}/catalog/categories/1/groups**`, (route) => categoryResponse(route, { categoryId: 1, displayName: 'Magic: The Gathering' }));
  await page.route(`${TCGCSV_ORIGIN}/catalog/categories/2/groups**`, (route) => categoryResponse(route, { categoryId: 2, displayName: 'YuGiOh' }));
  await page.route(`${TCGCSV_ORIGIN}/catalog/groups**`, (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ groups: [], categories: [], publicationId: 'e2e', sourceUpdatedAt: '2026-08-10' })
  }));
  await page.route(`${TCGCSV_ORIGIN}/catalog/forecasts/manifest**`, (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ asOf: '2026-08-10', categories: {} })
  }));
  await page.route(`${TCGCSV_ORIGIN}/catalog/history/manifest**`, (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ asOf: '2026-08-10', categories: {} })
  }));
  await page.route(`${TCGCSV_ORIGIN}/catalog/groups/3/1102/products**`, (route) => {
    const url = new URL(route.request().url());
    const limit = Number.parseInt(url.searchParams.get('limit') || '24', 10);
    const cursor = Number.parseInt(url.searchParams.get('cursor') || '0', 10);
    const products = pokemonProducts(1102, 121);
    if (limit === 24) metrics.productPageRequests += 1;
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
      products: products.slice(cursor, cursor + limit),
      total: products.length,
      nextCursor: cursor + limit < products.length ? String(cursor + limit) : null,
      category: { categoryId: 3, displayName: 'Pokemon' },
      group: { categoryId: 3, groupId: 1102, name: 'Silver Tempest', abbreviation: 'SIT', publishedOn: '2022-11-11' },
      publicationId: 'e2e',
      sourceUpdatedAt: '2026-08-10'
      })
    });
  });
  return metrics;
}

test('Browse Sets pages a flagship set in restorable 24-card batches', async ({ page }) => {
  // This exercises network cursor paging, state restoration, and a full axe
  // pass. Allow cold browser startup without weakening any assertion.
  test.setTimeout(90_000);
  const metrics = await mockFlagshipCatalog(page);
  await skipOnboarding(page);
  await page.goto('/discover/pokemon');

  await expect(page).toHaveURL(/\/games\/pokemon$/);
  await expect(page.getByRole('button', { name: 'Browse sets' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: /Silver Tempest/ })).toBeVisible();
  await expect(page.getByText('2 sets', { exact: true })).toBeVisible();

  await page.getByPlaceholder('Search sets or codes…').fill('SIT');
  await expect(page.getByText('1 set', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /Silver Tempest/ }).click();

  await expect(page).toHaveURL(/\/sets\/silver-tempest-3-1102\?game=pokemon$/);
  await expect(page.getByRole('heading', { name: 'Silver Tempest' })).toBeVisible();
  await expect(page.getByText('24 of 121 products loaded', { exact: true })).toBeVisible();
  await expect(page.locator('.result-card')).toHaveCount(24);
  await expect(page.locator('.result-card h3').first()).toHaveText('Card 1');
  await expect(page.locator('.result-card h3').last()).toHaveText('Card 24 — A Very Long Complete Product Title With Every Collector Detail Preserved');
  await expect.poll(() => metrics.productPageRequests).toBe(1);

  await page.getByRole('button', { name: 'Load 24 more' }).click();
  await expect(page.locator('.result-card')).toHaveCount(48);
  await expect(page.getByText('48 of 121 products loaded', { exact: true })).toBeVisible();
  await expect.poll(() => metrics.productPageRequests).toBe(2);

  await page.getByPlaceholder('Search this set…').fill('Card 48');
  await expect(page.locator('.result-card')).toHaveCount(1);
  await expect(page.locator('.result-card h3')).toHaveText('Card 48');

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Silver Tempest' })).toBeVisible();
  await expect(page.getByText('24 of 121 products loaded', { exact: true })).toBeVisible();
  await expect(page.locator('.result-card')).toHaveCount(24);
  await page.getByPlaceholder('Search this set…').fill('Card 24');
  await expect(page.locator('.result-card')).toHaveCount(1);
  await expect(page.locator('.result-card h3')).toHaveText('Card 24 — A Very Long Complete Product Title With Every Collector Detail Preserved');
  await expect(page.locator('.result-outlook-note')).toHaveCount(0);

  const report = await new AxeBuilder({ page })
    .include('#main-content')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(report.violations.filter((entry) => ['serious', 'critical'].includes(entry.impact))).toEqual([]);
});

test('Browse Sets keeps popular games visible and opens the complete searchable category picker', async ({ page }) => {
  const metrics = await mockFlagshipCatalog(page);
  await skipOnboarding(page);
  await page.goto('/discover/browse');

  const popular = page.getByRole('group', { name: 'Popular games' });
  await expect(popular.getByRole('button', { name: /Pokémon/ })).toBeVisible();
  await expect(popular.getByRole('button', { name: /Magic/ })).toBeVisible();
  await expect(popular.getByRole('button', { name: /Yu-Gi-Oh!/ })).toBeVisible();
  expect(metrics.groupRequests).toBe(0);
  await page.getByRole('button', { name: /View All/ }).click();
  await expect(page.getByRole('dialog', { name: 'All games and categories' })).toBeVisible();
  const categories = page.locator('[data-game-search-text]');
  await expect(categories).toHaveCount(90);

  await page.getByPlaceholder('Find Dragon Ball, One Piece, Digimon…').fill('one piece');
  await expect(categories.filter({ visible: true })).toHaveCount(1);
  const onePiece = page.getByRole('button', { name: /One Piece Card Game/ });
  await expect(onePiece).toBeVisible();
  await expect(page.getByRole('button', { name: /Dragon Ball Z TCG/ })).toBeHidden();

  await onePiece.click();
  await expect(page).toHaveURL(/\/games\/tcgcsv-category-68$/);
  await expect(page.getByRole('dialog')).toBeHidden();

  // Drilled into a category: the directory collapses into breadcrumbs.
  await expect(page.locator('.browse-breadcrumbs')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'One Piece Card Game' })).toBeVisible();
  await expect(categories).toHaveCount(0);
  await page.getByRole('button', { name: 'All games', exact: true }).click();
  await expect(page).toHaveURL(/\/discover\/browse$/);
  await expect(page.locator('[data-game-search-text]')).toHaveCount(0);
  await page.getByRole('button', { name: /View All/ }).click();
  await expect(page.locator('[data-game-search-text]')).toHaveCount(90);
});

test('Browse Sets filters a flagship game by selected years and groups sets into families', async ({ page }) => {
  await mockFlagshipCatalog(page);
  await skipOnboarding(page);
  await page.goto('/discover/pokemon');

  await expect(page.locator('.browse-breadcrumbs')).toBeVisible();
  await expect(page.getByText('2 sets', { exact: true })).toBeVisible();

  await page.locator('.browse-year-filter summary').click();
  await page.locator('[data-browse-year][value="2022"]').check();
  await expect(page.getByText('1 set', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /Silver Tempest/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Base Set/ })).toBeHidden();

  await page.locator('[data-browse-year][value="1999"]').check();
  await expect(page.getByText('2 sets', { exact: true })).toBeVisible();

  await page.locator('[data-browse-set-group]').selectOption('year');
  await expect(page.locator('.browse-set-group summary').first()).toContainText('2022');
});
