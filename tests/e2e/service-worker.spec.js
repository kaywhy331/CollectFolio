import { expect, test } from '@playwright/test';

// Most browser tests intentionally bypass the service worker for deterministic
// network mocking. This isolated context exercises the real install/activate
// path and the offline navigation fallback.
test.use({ serviceWorkers: 'allow' });

async function activeRegistration(page) {
  await page.waitForFunction(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    return Boolean(registration?.active);
  });
  return page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    return registration?.active?.scriptURL || '';
  });
}

test('service worker refreshes runtime config, bounds caches, and reloads offline', async ({ page, context }) => {
  await page.goto('/');
  await activeRegistration(page);
  await page.reload();
  await expect(page.getByRole('heading', { name: /Set up CollectFolio|Overview/ })).toBeVisible();
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);

  const installed = await page.evaluate(() => caches.keys());
  expect(installed).toContain('collectfolio-shell-v0.8.2');

  const refreshedConfig = await page.evaluate(async () => {
    const cache = await caches.open('collectfolio-shell-v0.8.2');
    await cache.put('/runtime-config.js', new Response('window.STALE_RUNTIME_CONFIG = true;', {
      headers: { 'Content-Type': 'application/javascript' }
    }));
    const live = await fetch('/runtime-config.js').then((response) => response.text());
    const cached = await cache.match('/runtime-config.js').then((response) => response?.text() || '');
    return { live, cached };
  });
  expect(refreshedConfig.live).toContain('COLLECTFOLIO_CONFIG');
  expect(refreshedConfig.live).not.toContain('STALE_RUNTIME_CONFIG');
  expect(refreshedConfig.cached).toBe(refreshedConfig.live);

  await context.setOffline(true);
  const offlineVisualManifest = await page.evaluate(async () => {
    const response = await fetch('/assets/data/visual-index/pokemon-v1/manifest.json');
    return response.json();
  });
  expect(offlineVisualManifest).toMatchObject({
    format: 'collectfolio-visual-candidate-index', version: 1, entryCount: 20444
  });
  await page.reload();
  await expect(page.getByRole('heading', { name: /Set up CollectFolio|Overview/ })).toBeVisible();
  await context.setOffline(false);

  await page.evaluate(async () => {
    await caches.open('collectfolio-shell-v0.6.0');
    await caches.open('collectfolio-provider-images-stale');
    const providerImages = await caches.open('collectfolio-provider-images-v1');
    await Promise.all(Array.from({ length: 165 }, (_, index) => providerImages.put(
      `/provider-cache-fixture-${index}.png`, new Response(String(index))
    )));
    const registration = await navigator.serviceWorker.getRegistration();
    await registration?.unregister();
  });
  await page.reload();
  await activeRegistration(page);

  await expect.poll(() => page.evaluate(() => caches.keys())).not.toContain('collectfolio-shell-v0.6.0');
  await expect.poll(() => page.evaluate(() => caches.keys())).not.toContain('collectfolio-provider-images-stale');
  await expect.poll(() => page.evaluate(() => caches.keys())).toContain('collectfolio-shell-v0.8.2');
  await expect.poll(() => page.evaluate(async () => (await caches.open('collectfolio-provider-images-v1')).keys().then((keys) => keys.length))).toBeLessThanOrEqual(160);
});
