import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

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

function mockPokemonCatalog(page) {
  return Promise.all([
    page.route('https://api.pokemontcg.io/v2/sets**', (route) => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: [
          { id: 'swsh12', name: 'Silver Tempest', series: 'Sword & Shield', printedTotal: 195, total: 215, releaseDate: '2022-11-11', ptcgoCode: 'SIT' },
          { id: 'base1', name: 'Base Set', series: 'Base', printedTotal: 102, total: 102, releaseDate: '1999-01-09', ptcgoCode: 'BS' }
        ],
        count: 2,
        totalCount: 2
      })
    })),
    page.route('https://api.pokemontcg.io/v2/cards**', (route) => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: Array.from({ length: 121 }, (_, index) => ({
          id: `swsh12-${index + 1}`,
          name: `Card ${index + 1}`,
          number: String(index + 1),
          rarity: index % 10 === 0 ? 'Rare' : 'Common',
          set: { id: 'swsh12', name: 'Silver Tempest', releaseDate: '2022-11-11' },
          images: {}
        })),
        count: 121,
        totalCount: 121
      })
    }))
  ]);
}

test('Browse Sets drills from a restorable game route into every card in a set', async ({ page }) => {
  await mockPokemonCatalog(page);
  await skipOnboarding(page);
  await page.goto('/discover/pokemon');

  await expect(page).toHaveURL(/\/discover\/pokemon$/);
  await expect(page.getByRole('button', { name: 'Browse sets' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: /Silver Tempest/ })).toBeVisible();
  await expect(page.getByText('2 sets', { exact: true })).toBeVisible();

  await page.getByPlaceholder('Search sets or codes…').fill('SIT');
  await expect(page.getByText('1 set', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /Silver Tempest/ }).click();

  await expect(page).toHaveURL(/\/discover\/pokemon\/swsh12$/);
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

test('Browse Sets makes the full TCGCSV cohort searchable and routes locked categories to sign-in', async ({ page }) => {
  await mockPokemonCatalog(page);
  await skipOnboarding(page);
  await page.goto('/discover/pokemon');

  const categories = page.locator('[data-game-search-text]');
  await expect(categories).toHaveCount(90);
  await expect(page.getByText('90 TCGCSV categories mapped · sign in to browse imported contents')).toBeVisible();

  await page.getByPlaceholder('Find Dragon Ball, One Piece, Digimon…').fill('one piece');
  await expect(categories.filter({ visible: true })).toHaveCount(1);
  const onePiece = page.getByRole('button', { name: /One Piece Card Game — sign in/ });
  await expect(onePiece).toBeVisible();
  await expect(page.getByRole('button', { name: /Dragon Ball Z TCG — sign in/ })).toBeHidden();

  await onePiece.click();
  await expect(page).toHaveURL(/\/discover\/tcgcsv-category-68$/);
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Optional cloud account' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
});
