import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test.use({ serviceWorkers: 'block', hasTouch: true });

const VIEWPORTS = [
  { name: 'narrow mobile', width: 320, height: 720, bottomNav: true },
  { name: 'iPhone class', width: 390, height: 844, bottomNav: true },
  { name: 'large Android', width: 412, height: 915, bottomNav: true },
  { name: 'mobile landscape', width: 740, height: 412, bottomNav: true },
  { name: 'small tablet', width: 768, height: 1024, bottomNav: false },
  { name: 'large tablet', width: 1024, height: 900, bottomNav: false },
  { name: 'laptop', width: 1366, height: 768, bottomNav: false },
  { name: 'large desktop', width: 1920, height: 1080, bottomNav: false }
];

async function completeFirstUse(page) {
  await page.goto('/');
  const onboarding = page.getByRole('heading', { name: 'Set up CollectFolio' });
  const home = page.getByRole('heading', { name: 'Home', exact: true });
  await expect(onboarding.or(home).first()).toBeVisible();
  if (await onboarding.isVisible()) {
    await page.getByRole('button', { name: /Skip setup and use recommended defaults/ }).click();
  }
  await expect(home).toBeVisible();
}

const PANEL_TCGCSV_ORIGIN = 'https://tcgcsv-premium-ux-panel-e2e.example.test';

// A minimal deterministic catalog so the panel-focused tests below can open
// a real result's quick view without depending on live network access.
async function mockPanelCatalog(page) {
  await page.route('**/runtime-config.js', (route) => route.fulfill({
    contentType: 'application/javascript',
    body: `window.COLLECTFOLIO_CONFIG = Object.freeze({
      SUPABASE_URL: window.location.origin + '/__premium-ux-panel-cloud',
      SUPABASE_ANON_KEY: 'synthetic-browser-key',
      APP_VERSION: 'premium-ux-panel',
      TCGCSV_CATALOG_URL: '${PANEL_TCGCSV_ORIGIN}/',
      ENABLE_TESSERACT: false,
      ENABLE_PRICE_INTELLIGENCE: false
    });`
  }));
  await page.route('**/__premium-ux-panel-cloud/**', (route) => route.fulfill({ contentType: 'application/json', body: '[]' }));
  await page.route(`${PANEL_TCGCSV_ORIGIN}/catalog/search**`, (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      products: [{
        productId: 77001, categoryId: 3, groupId: 1442, categoryName: 'Pokemon', groupName: 'Panel Test Set',
        name: 'Panel Test Card', cleanName: 'Panel Test Card', cardNumber: '1',
        prices: [{ subtypeName: 'Holofoil', marketPrice: 12 }]
      }], sourceUpdatedAt: '2026-08-20'
    })
  }));
  await page.route(`${PANEL_TCGCSV_ORIGIN}/catalog/forecasts/manifest**`, (route) => route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }));
  await page.route(`${PANEL_TCGCSV_ORIGIN}/catalog/history/manifest**`, (route) => route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }));
}

async function layoutHealth(page) {
  return page.evaluate(() => {
    const navigation = document.querySelector('[aria-label="Primary"]');
    const main = document.querySelector('#main-content');
    const visibleControls = [...document.querySelectorAll('h1, h2, h3, button, input, select')]
      .filter((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      });
    return {
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      navigationPosition: getComputedStyle(navigation).position,
      navigationHeight: navigation.getBoundingClientRect().height,
      mainPaddingBottom: Number.parseFloat(getComputedStyle(main).paddingBottom),
      clippedControls: visibleControls.filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.left < -1 || rect.right > innerWidth + 1;
      }).map((element) => element.getAttribute('aria-label') || element.textContent.trim().slice(0, 60))
    };
  });
}

test('responsive shell remains usable across the required device matrix with touch and mouse input', async ({ page }) => {
  test.slow();
  await completeFirstUse(page);
  for (const viewport of VIEWPORTS) {
    await test.step(viewport.name, async () => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible();
      const health = await layoutHealth(page);
      expect(health.overflow, `${viewport.name} horizontal overflow`).toBeLessThanOrEqual(1);
      expect(health.clippedControls, `${viewport.name} clipped controls`).toEqual([]);
      expect(health.navigationPosition).toBe(viewport.bottomNav ? 'fixed' : 'static');
      if (viewport.bottomNav) expect(health.mainPaddingBottom).toBeGreaterThan(health.navigationHeight);
    });
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/home');
  const discover = page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name: 'Discover' });
  const discoverBox = await discover.boundingBox();
  await page.touchscreen.tap(discoverBox.x + discoverBox.width / 2, discoverBox.y + discoverBox.height / 2);
  await expect(page).toHaveURL(/\/discover$/);
  const scan = page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name: 'Scan' });
  const scanBox = await scan.boundingBox();
  await page.mouse.click(scanBox.x + scanBox.width / 2, scanBox.y + scanBox.height / 2);
  await expect(page).toHaveURL(/\/scan$/);

  for (const control of [
    page.getByRole('button', { name: 'Open Camera' }),
    page.getByRole('button', { name: 'Upload Photo' }),
    ...await page.getByRole('navigation', { name: 'Primary' }).getByRole('button').all()
  ]) {
    const box = await control.boundingBox();
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
});

test('keyboard workflow and 200% text zoom preserve core navigation without clipping', async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 900 });
  await completeFirstUse(page);
  await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);

  await page.keyboard.press('/');
  await expect(page).toHaveURL(/\/discover$/);
  await expect(page.locator('#catalog-query')).toBeFocused();
  await page.locator('#catalog-query').fill('Pikachu 001');

  const scan = page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name: 'Scan' });
  await scan.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/scan$/);
  await expect(page.getByRole('button', { name: 'Upload Photo' })).toBeVisible();
  const focusedAction = page.getByRole('button', { name: 'Upload Photo' });
  await expect(page.locator('.toast')).toHaveCount(0);
  await focusedAction.scrollIntoViewIfNeeded();
  await focusedAction.focus();
  const focusGeometry = await focusedAction.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return { top: rect.top, bottom: rect.bottom, viewport: innerHeight, outline: style.outlineStyle, shadow: style.boxShadow };
  });
  expect(focusGeometry.top).toBeGreaterThanOrEqual(0);
  expect(focusGeometry.bottom).toBeLessThanOrEqual(focusGeometry.viewport);
  expect(focusGeometry.outline !== 'none' || focusGeometry.shadow !== 'none').toBe(true);
});

test('all primary destinations have no serious or critical WCAG 2.2 A/AA violations', async ({ page }) => {
  // Five complete route scans can exceed the generic interaction timeout on
  // slower browser runners; Axe runtime is not an application performance
  // budget, and every violation assertion below remains unchanged.
  test.slow();
  await completeFirstUse(page);
  for (const [path, heading] of [
    ['/home', 'Home'], ['/discover', 'Discover'], ['/scan', 'Scan'],
    ['/collection/items', 'Collection'], ['/insights', 'Insights']
  ]) {
    await page.goto(path);
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
    const report = await new AxeBuilder({ page })
      .include('#main-content')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    const blocking = report.violations.filter(({ impact }) => ['serious', 'critical'].includes(impact));
    expect(blocking, `${path}\n${JSON.stringify(blocking, null, 2)}`).toEqual([]);
  }
});

test('the quick view panel is a non-modal, labelled complementary region with no serious or critical violations', async ({ page }) => {
  // Directive 2: the panel is a real side window, not a modal dialog -- no
  // aria-modal, no focus trap on desktop, just a labelled complementary
  // landmark layered over whatever the collector was already browsing.
  await mockPanelCatalog(page);
  await completeFirstUse(page);
  await page.goto('/discover/search?category=tcgcsv-category-3&provider=tcgcsv');
  await page.locator('#catalog-query').fill('Panel Test');
  await page.locator('#catalog-search').getByRole('button', { name: 'Search', exact: true }).click();
  const firstResult = page.locator('.result-card').first();
  await expect(firstResult).toBeVisible();
  await firstResult.click();
  const panel = page.locator('.quick-inspector');
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute('role', 'complementary');
  await expect(panel).not.toHaveAttribute('aria-modal', 'true');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  // The rest of the shell stays reachable -- the primary nav is not inert
  // while the panel is open (non-modal: no focus trap on desktop).
  await expect(page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name: 'Home' })).toBeEnabled();

  const report = await new AxeBuilder({ page })
    .include('#main-content')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const blocking = report.violations.filter(({ impact }) => ['serious', 'critical'].includes(impact));
  expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
});

test('on mobile the quick view is a bottom drawer that closes on an outside tap', async ({ page }) => {
  await mockPanelCatalog(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await completeFirstUse(page);
  await page.goto('/discover/search?category=tcgcsv-category-3&provider=tcgcsv');
  await page.locator('#catalog-query').fill('Panel Test');
  await page.locator('#catalog-search').getByRole('button', { name: 'Search', exact: true }).click();
  const firstResult = page.locator('.result-card').first();
  await expect(firstResult).toBeVisible();
  await firstResult.click();
  const panel = page.locator('.quick-inspector');
  await expect(panel).toBeVisible();

  const scrim = page.locator('.inspector-scrim');
  await expect(scrim).toBeVisible();
  // The scrim spans the full viewport behind the sheet, but the sheet
  // itself (docked to the bottom, "medium" detent) visually covers and
  // intercepts pointer events over the scrim's own geometric center --
  // tap a corner that is actually outside the sheet, i.e. genuinely
  // "outside" from the collector's point of view.
  await scrim.tap({ position: { x: 20, y: 20 } });
  await expect(panel).toHaveCount(0);
  // The mobile open pushed a shallow history entry to back the tap-close --
  // the collector should still be exactly where they were searching, not
  // bounced up the stack an extra step.
  await expect(page).toHaveURL(/\/discover/);
  await expect(page.locator('#catalog-query')).toHaveValue('Panel Test');
});

test('first-use performance stays inside the LCP, interaction, and layout-shift budgets', async ({ page }) => {
  await page.addInitScript(() => {
    window.__collectfolioPerformance = { lcp: 0, cls: 0, inp: 0 };
    if (PerformanceObserver.supportedEntryTypes.includes('largest-contentful-paint')) {
      new PerformanceObserver((list) => {
        const last = list.getEntries().at(-1);
        if (last) window.__collectfolioPerformance.lcp = last.startTime;
      }).observe({ type: 'largest-contentful-paint', buffered: true });
    }
    if (PerformanceObserver.supportedEntryTypes.includes('layout-shift')) {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (!entry.hadRecentInput) window.__collectfolioPerformance.cls += entry.value;
        }
      }).observe({ type: 'layout-shift', buffered: true });
    }
    if (PerformanceObserver.supportedEntryTypes.includes('event')) {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.interactionId || ['click', 'pointerup', 'keydown'].includes(entry.name)) {
            window.__collectfolioPerformance.inp = Math.max(window.__collectfolioPerformance.inp, entry.duration);
          }
        }
      }).observe({ type: 'event', buffered: true, durationThreshold: 16 });
    }
  });
  await completeFirstUse(page);
  await page.goto('/home');
  await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible();
  await page.waitForTimeout(500);
  const paint = await page.evaluate(() => {
    const navigation = performance.getEntriesByType('navigation')[0];
    return {
      lcp: window.__collectfolioPerformance.lcp || navigation?.loadEventEnd || 0,
      cls: window.__collectfolioPerformance.cls
    };
  });
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name: 'Discover' }).click();
  await expect(page.getByRole('heading', { name: 'Discover', exact: true })).toBeVisible();
  await page.waitForTimeout(100);
  const interaction = await page.evaluate(() => window.__collectfolioPerformance.inp);
  test.info().annotations.push({ type: 'performance', description: JSON.stringify({ ...paint, interaction }) });
  expect(paint.lcp).toBeGreaterThan(0);
  expect(paint.lcp).toBeLessThan(2_500);
  expect(interaction).toBeGreaterThan(0);
  expect(interaction).toBeLessThan(200);
  expect(paint.cls).toBeLessThan(0.1);
});

test('a failed catalog image exposes a retry action and recovers in place', async ({ page }) => {
  // This scenario intentionally waits through multiple failed image loads
  // before exercising the recovery path; keep shared-runner contention from
  // consuming the functional assertion's entire timeout budget.
  test.slow();
  // Keep the synthetic catalog under the application origin so the same
  // deterministic fixture can qualify immutable/production deployments
  // without weakening their connect-src policy for a test-only hostname.
  let imageAttempts = 0;
  let allowImage = false;
  await page.route('**/runtime-config.js', (route) => route.fulfill({
    contentType: 'application/javascript',
    body: `window.COLLECTFOLIO_CONFIG = Object.freeze({
      SUPABASE_URL: window.location.origin + '/__premium-cloud',
      SUPABASE_ANON_KEY: 'synthetic-browser-key',
      APP_VERSION: 'premium-acceptance',
      TCGCSV_CATALOG_URL: window.location.origin + '/',
      ENABLE_TESSERACT: false,
      ENABLE_PRICE_INTELLIGENCE: false
    });`
  }));
  await page.route('**/__premium-cloud/**', (route) => route.fulfill({ contentType: 'application/json', body: '[]' }));
  await page.route('**/catalog/summary**', (route) => route.fulfill({ contentType: 'application/json', body: '{"categories":[]}' }));
  await page.route('**/catalog/forecasts/manifest**', (route) => route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }));
  await page.route('**/catalog/history/manifest**', (route) => route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }));
  await page.route('**/catalog/search**', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ products: [{
      productId: 88001, categoryId: 3, groupId: 1442, categoryName: 'Pokemon', groupName: 'Retry Set',
      name: 'Retry Image Card', cleanName: 'Retry Image Card', cardNumber: '1',
      prices: [{ subtypeName: 'Holofoil', marketPrice: 12 }]
    }], sourceUpdatedAt: '2026-08-20' })
  }));
  await page.route('https://tcgplayer-cdn.tcgplayer.com/product/**', (route) => {
    imageAttempts += 1;
    if (!allowImage) return route.fulfill({ status: 503, contentType: 'text/plain', body: 'temporary image failure' });
    return route.fulfill({
      status: 200,
      contentType: 'image/png',
      body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
    });
  });

  await completeFirstUse(page);
  await page.goto('/discover/search?category=tcgcsv-category-3&provider=tcgcsv');
  await page.locator('#catalog-query').fill('Retry Image');
  await page.locator('#catalog-search').getByRole('button', { name: 'Search', exact: true }).click();
  const card = page.locator('.result-card', { hasText: 'Retry Image Card' });
  await expect(card).toBeVisible();
  const retry = card.getByRole('button', { name: 'Retry image' });
  await expect(retry).toBeVisible();
  allowImage = true;
  await retry.click();
  await expect(retry).toHaveCount(0);
  await expect.poll(() => card.locator('img').evaluate((image) => image.complete && image.naturalWidth > 0)).toBe(true);
  expect(imageAttempts).toBeGreaterThanOrEqual(3);
});
