import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

async function expectAccessible(page) {
  const report = await new AxeBuilder({ page })
    .include('#main-content')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const blocking = report.violations.filter((entry) => ['serious', 'critical'].includes(entry.impact));
  expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
}

async function skipOnboarding(page) {
  const onboarding = page.getByRole('heading', { name: 'Set up CollectFolio' });
  const overview = page.getByRole('heading', { name: 'Home' });
  await expect(onboarding.or(overview).first()).toBeVisible();
  if (await onboarding.isVisible()) {
    await page.getByRole('button', { name: /Skip setup and use recommended defaults/ }).click();
  }
  await expect(overview).toBeVisible();
}

function accessTokenFor(userId) {
  return `header.${Buffer.from(JSON.stringify({ sub: userId })).toString('base64url')}.signature`;
}

async function configureCloud(page, { failSync = false } = {}) {
  const userId = '30000000-0000-4000-8000-000000000001';
  await page.addInitScript(({ accessToken, accountId }) => {
    if (localStorage.getItem('collectfolio:supabase-session')) return;
    localStorage.setItem('collectfolio:supabase-session', JSON.stringify({
      access_token: accessToken,
      refresh_token: 'synthetic-refresh-token',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: { id: accountId, email: 'collector@example.test' }
    }));
  }, { accessToken: accessTokenFor(userId), accountId: userId });
  await page.route('**/runtime-config.js', (route) => route.fulfill({
    contentType: 'application/javascript',
    body: `window.COLLECTFOLIO_CONFIG = Object.freeze({
      SUPABASE_URL: window.location.origin + '/__phase5-cloud',
      SUPABASE_ANON_KEY: 'synthetic-browser-key',
      APP_VERSION: '0.8.0-test',
      ENABLE_TESSERACT: false,
      ENABLE_PRICE_INTELLIGENCE: false,
      ENABLE_CLOUD_DATA_REMOVAL: false
    });`
  }));
  const requests = [];
  const writes = [];
  await page.route('**/__phase5-cloud/**', (route) => {
    const request = route.request();
    const url = new URL(request.url());
    requests.push(`${request.method()} ${url.pathname}${url.search}`);
    if (request.method() !== 'GET') writes.push(`${request.method()} ${url.pathname}${url.search}`);
    if (failSync && request.method() === 'GET' && url.pathname.endsWith('/holdings')) {
      return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'service unavailable' }) });
    }
    if (url.pathname.endsWith('/rpc/get_or_create_default_watchlist')) {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify('40000000-0000-4000-8000-000000000001') });
    }
    if (url.pathname.endsWith('/profiles') && request.method() === 'GET') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify([{ demand_analytics_opt_out: false }]) });
    }
    return route.fulfill({ contentType: 'application/json', body: '[]' });
  });
  return { requests, writes };
}

test('three-step onboarding survives refresh and completes after the first collection add', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Set up CollectFolio' })).toBeVisible();
  await expect(page.getByText('Step 1 of 3')).toBeVisible();
  await page.getByRole('button', { name: /Save on this device/ }).click();
  await expect(page.getByText('Step 2 of 3')).toBeVisible();
  await page.getByLabel('Display currency').selectOption('CAD');
  await page.getByRole('button', { name: 'Save and continue' }).click();
  await expect(page.getByText('Step 3 of 3')).toBeVisible();
  await expect(page.getByText('CAD collection currency')).toBeVisible();

  await page.reload();
  await expect(page.getByText('Step 3 of 3')).toBeVisible();
  await expect(page.getByText('CAD collection currency')).toBeVisible();
  await expectAccessible(page);

  await page.getByRole('button', { name: 'Choose how to add' }).click();
  await expect(page).toHaveURL(/\/scan$/);
  await page.getByRole('button', { name: /Create custom item/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Add a custom collectible' });
  await dialog.getByLabel('Name').fill('First onboarding collectible');
  await dialog.getByRole('button', { name: 'Add to collection' }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name: 'Home' }).click();
  // DCL-HOME-01: a holding now exists, so Home's first element is the
  // hero card, not a page-header h1.
  await expect(page.locator('.overview-hero')).toBeVisible();
  await expect(page.getByText('First onboarding collectible', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.locator('.overview-hero')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Set up CollectFolio' })).toHaveCount(0);
});

test('a shared provider card URL hydrates without local card data', async ({ page }) => {
  await page.goto('/');
  await skipOnboarding(page);
  await page.route('https://api.scryfall.com/cards/shared-card-id', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      id: 'shared-card-id', name: 'Shared Archive Card', set_name: 'Linked Set', collector_number: '42',
      rarity: 'rare', released_at: '2026-01-01', image_uris: {}, prices: { usd: '4.20', usd_foil: null, usd_etched: null },
      scryfall_uri: 'https://scryfall.com/card/shared-card-id'
    })
  }));

  await page.goto('/cards/scryfall%3Ashared-card-id');
  await expect(page.getByRole('heading', { name: 'Shared Archive Card' })).toBeVisible();
  await expect(page.getByText('Linked Set · #42 · rare')).toBeVisible();
  await expect(page).toHaveURL(/\/items\/scryfall%3Ashared-card-id$/);
});

test('guest settings are responsive, accessible, textual, and modal focus stays contained', async ({ page }) => {
  await page.goto('/');
  await skipOnboarding(page);
  await page.getByRole('button', { name: 'Open settings' }).click();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await expect(page.locator('[data-account-status="local"]')).toContainText('Saved locally');
  await expect(page.getByRole('button', { name: 'Remove cloud data' })).toBeDisabled();
  await expect(page.getByText(/Supabase|public key|Tier 0|canonical|provider price|Demand analytics|Local mode/i)).toHaveCount(0);
  await expectAccessible(page);

  for (const viewport of [{ width: 390, height: 844 }, { width: 768, height: 900 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize(viewport);
    const dimensions = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
    expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport);
    await expect(page.getByRole('button', { name: 'Export full backup' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Clear local data' })).toBeVisible();
  }

  const clear = page.getByRole('button', { name: 'Clear local data' });
  await clear.click();
  const dialog = page.getByRole('dialog', { name: 'Clear all local data?' });
  await expect(dialog).toBeVisible();
  expect(await page.locator('#app').evaluate((element) => element.inert)).toBe(true);
  await expect(dialog.getByRole('button', { name: 'Close' })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(clear).toBeFocused();
});

test('signed-in settings synchronize successfully and recover their offline state', async ({ page, context }) => {
  const cloud = await configureCloud(page);
  await page.goto('/');
  await skipOnboarding(page);
  await page.getByRole('button', { name: 'Open settings' }).click();
  await expect(page.locator('[data-account-status="pending"]')).toContainText('Waiting to synchronize');
  await expect(page.getByRole('button', { name: 'Remove cloud data' })).toBeDisabled();
  await expect(page.getByText(/Unavailable until independently recoverable cloud removal/)).toBeVisible();
  await page.getByRole('button', { name: 'Synchronize now' }).click();
  await expect(page.locator('[data-account-status="synced"]')).toContainText('Synchronized');
  const ownedReads = cloud.requests.filter((entry) => entry.startsWith('GET ')
    && /\/(?:holdings|holding_deletions|portfolio_snapshots|watchlist_items|watchlist_deletions)\?/.test(entry));
  expect(ownedReads.length).toBeGreaterThanOrEqual(5);
  expect(
    ownedReads.filter((entry) => entry.includes('user_id=eq.30000000-0000-4000-8000-000000000001')),
    ownedReads.join('\n')
  ).toHaveLength(ownedReads.length);
  await expect(page.locator('section.settings-section').filter({ hasText: 'Synchronization history' })).toContainText('Completed');

  await context.setOffline(true);
  await expect(page.locator('[data-account-status="offline"]')).toContainText('Offline');
  await expect(page.getByRole('button', { name: 'Synchronize now' })).toBeDisabled();
  await context.setOffline(false);
  await expect(page.locator('[data-account-status="synced"]')).toContainText('Synchronized');
  await expectAccessible(page);
});

test('a local collection cannot silently synchronize into a different account', async ({ page }) => {
  const cloud = await configureCloud(page);
  await page.goto('/');
  await skipOnboarding(page);
  await page.getByRole('button', { name: 'Open settings' }).click();
  await page.getByRole('button', { name: 'Synchronize now' }).click();
  await expect(page.locator('[data-account-status="synced"]')).toContainText('Synchronized');
  const writesAfterOwnerSync = cloud.writes.length;

  const userB = '30000000-0000-4000-8000-000000000002';
  await page.evaluate(({ accessToken, accountId }) => {
    localStorage.setItem('collectfolio:supabase-session', JSON.stringify({
      access_token: accessToken,
      refresh_token: 'synthetic-refresh-token-b',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: { id: accountId, email: 'other@example.test' }
    }));
  }, { accessToken: accessTokenFor(userB), accountId: userB });
  await page.reload();
  await expect(page.locator('[data-account-status="error"]')).toContainText('linked to another cloud account');
  await page.getByRole('button', { name: 'Synchronize now' }).click();
  await expect(page.locator('[data-account-status="error"]')).toContainText('linked to another cloud account');
  expect(cloud.writes.length).toBe(writesAfterOwnerSync);
});

test('synchronization errors preserve local data and expose a recovery reference', async ({ page }) => {
  await configureCloud(page, { failSync: true });
  await page.goto('/');
  await skipOnboarding(page);
  await page.getByRole('button', { name: 'Open settings' }).click();
  await page.getByRole('button', { name: 'Synchronize now' }).click();
  const status = page.locator('[data-account-status="error"]');
  await expect(status).toContainText('Synchronization needs attention');
  await expect(status).toContainText('local collection is unchanged');
  await page.getByText('Recovery details').click();
  await expect(page.locator('.diagnostic-details code')).toContainText(/^SYNC-/);
  await expect(page.getByRole('button', { name: 'Synchronize now' })).toBeEnabled();
  await expectAccessible(page);
});
