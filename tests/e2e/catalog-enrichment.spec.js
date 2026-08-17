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

// Two TCGCSV products in the same category (3 = Pokemon), one mapped in
// the bridge table (5001) and one deliberately absent from it (5002) --
// catalog-v2 B2's fail-closed contract requires the unmapped product to
// render exactly as it does today, with no enrichment note and no broken
// image.
const MAPPED_PRODUCT = { categoryId: 3, groupId: 1102, productId: 5001, name: 'Enriched Bridge Card', subtypeName: 'Holofoil', marketPrice: 45 };
const UNMAPPED_PRODUCT = { categoryId: 3, groupId: 1102, productId: 5002, name: 'Unmapped Bridge Card', subtypeName: 'Holofoil', marketPrice: 12 };

function tcgcsvSearchProduct(product) {
  return {
    productId: product.productId,
    categoryId: product.categoryId,
    groupId: product.groupId,
    categoryName: 'Pokemon',
    groupName: 'Silver Tempest',
    name: product.name,
    cleanName: product.name,
    prices: [{ subtypeName: product.subtypeName, marketPrice: product.marketPrice }]
  };
}

function bridgeTablePayload() {
  return {
    modelVersion: 'catalog-bridge-v1',
    categoryId: 3,
    provider: 'pokemon',
    asOf: '2026-08-17',
    sets: [{ groupId: 1102, providerSetId: 'swsh12', matchMethod: 'name-exact' }],
    products: [{ groupId: 1102, productId: 5001, providerSetId: 'swsh12', providerCardId: 'poke-1', matchMethod: 'collector-number' }]
  };
}

function pokemonCardDetailPayload() {
  return {
    data: {
      id: 'poke-1',
      name: 'Enriched Bridge Card VMAX',
      rarity: 'Rare Holo VMAX',
      number: '7',
      set: { name: 'Silver Tempest', releaseDate: '2022-11-11' },
      images: {
        large: 'https://images.pokemontcg.io/swsh12/7_hires.png',
        small: 'https://images.pokemontcg.io/swsh12/7.png'
      }
    }
  };
}

async function configureEnrichmentStubs(page) {
  await page.route('**/runtime-config.js', (route) => route.fulfill({
    contentType: 'application/javascript',
    body: `window.COLLECTFOLIO_CONFIG = Object.freeze({
      SUPABASE_URL: window.location.origin + '/__enrichment-cloud',
      SUPABASE_ANON_KEY: 'synthetic-browser-key',
      APP_VERSION: '0.8.0-test',
      TCGCSV_CATALOG_URL: '${TCGCSV_ORIGIN}/',
      ENABLE_TESSERACT: false,
      ENABLE_PRICE_INTELLIGENCE: false,
      ENABLE_CLOUD_DATA_REMOVAL: false
    });`
  }));

  await page.route('**/__enrichment-cloud/**', (route) => route.fulfill({ contentType: 'application/json', body: '[]' }));

  await page.route(`${TCGCSV_ORIGIN}/catalog/search**`, (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ products: [MAPPED_PRODUCT, UNMAPPED_PRODUCT].map(tcgcsvSearchProduct), publicationId: 'e2e', sourceUpdatedAt: '2026-08-17' })
  }));

  // The worker route this spec is stubbing: GET /catalog/bridge/<categoryId>
  // (catalog-v2 B2, cloudflare/tcgcsv-refresh/src/catalog.js's
  // serveBridgeObject). Only category 3 is published here -- any other
  // category must 404, matching the worker's fail-closed "absent ==
  // not published" contract.
  await page.route(`${TCGCSV_ORIGIN}/catalog/bridge/3**`, (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(bridgeTablePayload())
  }));

  // The lazy, detail-view-only provider card fetch (services/providers/
  // pokemon.js's getPokemonCard) -- must never be requested for the
  // unmapped product (5002 has no bridge row) or during list hydration.
  await page.route('https://api.pokemontcg.io/v2/cards/poke-1', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(pokemonCardDetailPayload())
  }));
}

async function runSearch(page) {
  await page.goto('/discover?category=tcgcsv-category-3&provider=tcgcsv');
  await page.getByPlaceholder('Card, set, number, character, or player').fill('Bridge Card');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  const mappedCard = page.locator('.result-card', { hasText: 'Enriched Bridge Card' });
  const unmappedCard = page.locator('.result-card', { hasText: 'Unmapped Bridge Card' });
  await expect(mappedCard).toBeVisible();
  await expect(unmappedCard).toBeVisible();
  return { mappedCard, unmappedCard };
}

test('catalog-v2 B2: a bridge-mapped product enriches its detail view with the provider image and note', async ({ page }) => {
  let providerCardRequested = false;
  await configureEnrichmentStubs(page);
  page.on('request', (request) => { if (request.url() === 'https://api.pokemontcg.io/v2/cards/poke-1') providerCardRequested = true; });

  await skipOnboarding(page);
  const { mappedCard } = await runSearch(page);

  // List/browse hydration never fetches provider data (API etiquette) --
  // it's only the act of opening the detail view below that should
  // trigger the lazy provider fetch.
  expect(providerCardRequested).toBe(false);

  await mappedCard.click();
  await page.getByRole('button', { name: 'Open full details' }).click();

  await expect(page.getByText(/Image and details enriched from pokemon/)).toBeVisible();
  await expect(page.locator('.detail-image')).toHaveAttribute('src', 'https://images.pokemontcg.io/swsh12/7_hires.png');
  await expect(page.locator('.detail-image')).toHaveAttribute('data-fallback-src', /tcgplayer-cdn\.tcgplayer\.com\/product\/5001_in_/);
  expect(providerCardRequested).toBe(true);
});

test('catalog-v2 B2: an unmapped product renders its detail view exactly as today (fail-closed, no enrichment)', async ({ page }) => {
  let providerCardRequested = false;
  await configureEnrichmentStubs(page);
  page.on('request', (request) => { if (request.url() === 'https://api.pokemontcg.io/v2/cards/poke-1') providerCardRequested = true; });

  await skipOnboarding(page);
  const { unmappedCard } = await runSearch(page);

  await unmappedCard.click();
  await page.getByRole('button', { name: 'Open full details' }).click();

  await expect(page.getByRole('heading', { name: 'Unmapped Bridge Card' })).toBeVisible();
  await expect(page.getByText(/Image and details enriched from/)).toHaveCount(0);
  expect(providerCardRequested).toBe(false);
});
