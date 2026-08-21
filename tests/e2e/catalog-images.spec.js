import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

const fixtureImage = readFileSync(new URL('../../app/assets/icons/icon-192.png', import.meta.url));

async function openApp(page) {
  await page.goto('/');
  const onboarding = page.getByRole('heading', { name: 'Set up CollectFolio' });
  const home = page.getByRole('heading', { name: 'Home' });
  await expect(onboarding.or(home).first()).toBeVisible();
  if (await onboarding.isVisible()) {
    await page.getByRole('button', { name: /Skip setup and use recommended defaults/ }).click();
  }
  await expect(home).toBeVisible();
}

test('legacy TCGCSV identity renders its product-derived card image', async ({ page }) => {
  const requests = [];
  await page.route('https://tcgplayer-cdn.tcgplayer.com/product/**', (route) => {
    requests.push(route.request().url());
    return route.fulfill({ contentType: 'image/png', body: fixtureImage });
  });
  await openApp(page);

  const source = await page.evaluate(async () => {
    const { externalImage } = await import('/assets/js/core/components.js');
    const fixture = document.createElement('div');
    fixture.id = 'legacy-tcgcsv-image-fixture';
    fixture.innerHTML = externalImage({
      provider: 'tcgcsv',
      externalId: '3:604:42402',
      name: 'Pikachu'
    }, 'holding-image', { loading: 'eager' });
    document.body.append(fixture);
    return fixture.querySelector('img')?.getAttribute('src') || '';
  });

  expect(source).toBe('https://tcgplayer-cdn.tcgplayer.com/product/42402_in_400x400.jpg');
  const image = page.locator('#legacy-tcgcsv-image-fixture img');
  await expect.poll(() => image.evaluate((node) => node.naturalWidth)).toBeGreaterThan(0);
  expect(requests.some((url) => /42402_in_(?:400x400|1000x1000)\.jpg$/.test(url))).toBe(true);
});
