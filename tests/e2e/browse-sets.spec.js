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
  return Array.from({ length: count }, (_, index) => ({
    productId: 5000 + index,
    categoryId: 3,
    groupId,
    name: `Card ${index + 1}`,
    cleanName: `Card ${index + 1}`,
    cardNumber: String(index + 1),
    rarity: index % 10 === 0 ? 'Rare' : 'Common',
    prices: []
  }));
}

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
  await mockRuntimeConfig(page);
  await page.route(`${TCGCSV_ORIGIN}/catalog/categories/3/groups**`, (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ groups: POKEMON_GROUPS, category: { categoryId: 3, displayName: 'Pokemon' }, publicationId: 'e2e', sourceUpdatedAt: '2026-08-10' })
  }));
  await page.route(`${TCGCSV_ORIGIN}/catalog/categories/1/groups**`, (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ groups: [], category: { categoryId: 1, displayName: 'Magic: The Gathering' }, publicationId: 'e2e', sourceUpdatedAt: '2026-08-10' })
  }));
  await page.route(`${TCGCSV_ORIGIN}/catalog/categories/2/groups**`, (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ groups: [], category: { categoryId: 2, displayName: 'YuGiOh' }, publicationId: 'e2e', sourceUpdatedAt: '2026-08-10' })
  }));
  await page.route(`${TCGCSV_ORIGIN}/catalog/groups**`, (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ groups: [], categories: [], publicationId: 'e2e', sourceUpdatedAt: '2026-08-10' })
  }));
  await page.route(`${TCGCSV_ORIGIN}/catalog/groups/3/1102/products**`, (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      products: pokemonProducts(1102, 121),
      category: { categoryId: 3, displayName: 'Pokemon' },
      group: { categoryId: 3, groupId: 1102, name: 'Silver Tempest', abbreviation: 'SIT', publishedOn: '2022-11-11' },
      publicationId: 'e2e',
      sourceUpdatedAt: '2026-08-10'
    })
  }));
}

test('Browse Sets drills from a restorable flagship game route into every card in a set', async ({ page }) => {
  await mockFlagshipCatalog(page);
  await skipOnboarding(page);
  await page.goto('/discover/pokemon');

  await expect(page).toHaveURL(/\/discover\/pokemon$/);
  await expect(page.getByRole('button', { name: 'Browse sets' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: /Silver Tempest/ })).toBeVisible();
  await expect(page.getByText('2 sets', { exact: true })).toBeVisible();

  await page.getByPlaceholder('Search sets or codes…').fill('SIT');
  await expect(page.getByText('1 set', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /Silver Tempest/ }).click();

  await expect(page).toHaveURL(/\/discover\/pokemon\/silver-tempest-3-1102$/);
  await expect(page.getByRole('heading', { name: 'Silver Tempest' })).toBeVisible();
  await expect(page.getByText('121 cards', { exact: true })).toBeVisible();
  await expect(page.locator('.result-card')).toHaveCount(120);
  await expect(page.locator('.result-card h3').first()).toHaveText('Card 1');
  await expect(page.locator('.result-card h3').last()).toHaveText('Card 120');

  await page.getByRole('button', { name: 'Show 1 more' }).click();
  await expect(page.locator('.result-card')).toHaveCount(121);

  await page.getByPlaceholder('Search this set…').fill('Card 121');
  await expect(page.locator('.result-card')).toHaveCount(1);
  await expect(page.locator('.result-card h3')).toHaveText('Card 121');

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Silver Tempest' })).toBeVisible();
  await expect(page.getByText('121 cards', { exact: true })).toBeVisible();

  const report = await new AxeBuilder({ page })
    .include('#main-content')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(report.violations.filter((entry) => ['serious', 'critical'].includes(entry.impact))).toEqual([]);
});

test('Browse Sets keeps flagship games pinned as quick chips and the rest of the TCGCSV cohort searchable', async ({ page }) => {
  await mockFlagshipCatalog(page);
  await skipOnboarding(page);
  await page.goto('/discover/browse');

  // catalog-v2 B1: Pokémon/Magic/Yu-Gi-Oh! are TCGCSV-identified now too,
  // but they stay pinned quick chips -- they must not double up inside the
  // searchable 87-category directory.
  const chips = page.locator('.browse-game-chips');
  await expect(chips.getByRole('button', { name: 'Pokémon' })).toBeVisible();
  await expect(chips.getByRole('button', { name: 'Magic', exact: true })).toBeVisible();
  await expect(chips.getByRole('button', { name: 'Yu-Gi-Oh!' })).toBeVisible();

  const categories = page.locator('[data-game-search-text]');
  await expect(categories).toHaveCount(87);
  await expect(page.getByText('87 game categories · free community access')).toBeVisible();
  await expect(page.locator('#browse-game-options').getByRole('button', { name: 'Pokémon', exact: true })).toHaveCount(0);

  await page.getByPlaceholder('Find Dragon Ball, One Piece, Digimon…').fill('one piece');
  await expect(categories.filter({ visible: true })).toHaveCount(1);
  const onePiece = page.getByRole('button', { name: /One Piece Card Game/ });
  await expect(onePiece).toBeVisible();
  await expect(page.getByRole('button', { name: /Dragon Ball Z TCG/ })).toBeHidden();

  await onePiece.click();
  await expect(page).toHaveURL(/\/discover\/tcgcsv-category-68$/);
  await expect(page.getByRole('dialog')).toBeHidden();

  // Drilled into a category: the directory collapses into breadcrumbs.
  await expect(page.locator('.browse-breadcrumbs')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'One Piece Card Game' })).toBeVisible();
  await expect(categories).toHaveCount(0);
  await page.getByRole('button', { name: 'All games', exact: true }).click();
  await expect(page).toHaveURL(/\/discover\/browse$/);
  await expect(page.locator('[data-game-search-text]')).toHaveCount(87);
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
