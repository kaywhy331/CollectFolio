import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const legacyBackup = JSON.parse(readFileSync(
  new URL('../fixtures/redesign/indexeddb-v4-backup-v2.json', import.meta.url),
  'utf8'
));
const snapshotFont = readFileSync(
  new URL('../../node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2', import.meta.url)
).toString('base64');

async function dismissOnboarding(page, destination) {
  const onboarding = page.getByRole('heading', { name: 'Set up CollectFolio' });
  const destinationHeading = page.getByRole('heading', { name: destination, exact: true });
  await expect(onboarding.or(destinationHeading).first()).toBeVisible();
  if (await onboarding.isVisible()) {
    await page.getByRole('button', { name: /Skip setup and use recommended defaults/ }).click();
  }
  await expect(destinationHeading).toBeVisible();
}

async function openApp(page) {
  await page.goto('/');
  await dismissOnboarding(page, 'Home');
}

async function stabilizeSnapshotTypography(page) {
  await page.addStyleTag({
    content: `
      @font-face {
        font-family: "CollectFolio Snapshot";
        font-style: normal;
        font-weight: 100 900;
        font-display: block;
        src: url("data:font/woff2;base64,${snapshotFont}") format("woff2-variations");
      }
      html, body, button, input, select, textarea {
        font-family: "CollectFolio Snapshot", sans-serif !important;
      }
    `
  });
  await page.evaluate(async () => {
    await Promise.all([
      document.fonts.load('400 16px "CollectFolio Snapshot"'),
      document.fonts.load('700 16px "CollectFolio Snapshot"')
    ]);
    await document.fonts.ready;
  });
}

async function expectNoBlockingAccessibilityViolations(page) {
  const report = await new AxeBuilder({ page })
    .include('#main-content')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const blocking = report.violations.filter((entry) => ['serious', 'critical'].includes(entry.impact));
  expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
}

async function seedLegacyIndexedDB(page) {
  // Fulfill a same-origin inert HTML document so the v4 fixture exists before
  // any v6 application module can open and upgrade it. A real manifest is not
  // suitable here because production hosts may serve it as a download.
  const fixturePath = '/__collectfolio-indexeddb-fixture__.html';
  await page.route(`**${fixturePath}`, (route) => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><title>CollectFolio IndexedDB fixture</title>'
  }));
  await page.goto(fixturePath);
  await page.unroute(`**${fixturePath}`);
  await page.evaluate(async ({ databaseName, databaseVersion, stores }) => {
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(databaseName);
      request.addEventListener('success', resolve, { once: true });
      request.addEventListener('error', () => reject(request.error), { once: true });
      request.addEventListener('blocked', () => reject(new Error('Existing CollectFolio database remained open.')), { once: true });
    });
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName, databaseVersion);
      request.addEventListener('upgradeneeded', () => {
        const keyPaths = { settings: 'key', catalogCache: 'key', intelligenceCache: 'key' };
        for (const name of Object.keys(stores)) request.result.createObjectStore(name, { keyPath: keyPaths[name] || 'id' });
        request.result.createObjectStore('demandEventsQueue', { keyPath: 'id' });
      }, { once: true });
      request.addEventListener('success', () => resolve(request.result), { once: true });
      request.addEventListener('error', () => reject(request.error), { once: true });
    });
    const names = Object.keys(stores).filter((name) => database.objectStoreNames.contains(name));
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(names, 'readwrite');
      for (const name of names) {
        const store = transaction.objectStore(name);
        store.clear();
        for (const record of stores[name]) store.put(name === 'scans' ? {
          ...record,
          sourceImage: 'data:image/jpeg;base64,legacy-full-source',
          sourceImageRetainedAt: '2026-08-01T00:00:00.000Z'
        } : record);
      }
      transaction.addEventListener('complete', resolve, { once: true });
      transaction.addEventListener('abort', () => reject(transaction.error), { once: true });
      transaction.addEventListener('error', () => reject(transaction.error), { once: true });
    });
    database.close();
  }, legacyBackup);
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}

async function configureApprovedPhase4Publication(page) {
  await page.route('**/runtime-config.js', (route) => route.fulfill({
    contentType: 'application/javascript',
    body: `window.COLLECTFOLIO_CONFIG = Object.freeze({
      SUPABASE_URL: window.location.origin + '/__phase4-cloud',
      SUPABASE_ANON_KEY: 'synthetic-browser-key',
      APP_VERSION: '0.8.0-test',
      ENABLE_TESSERACT: false,
      ENABLE_PRICE_INTELLIGENCE: true
    });`
  }));
  await page.route('**/__phase4-cloud/rest/v1/**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/product_feature_flags')) {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify([
        { key: 'watchlists', enabled: true, updated_at: '2026-08-09T00:00:00.000Z' },
        { key: 'public_price_intelligence', enabled: true, updated_at: '2026-08-09T00:00:00.000Z' }
      ]) });
    }
    if (url.pathname.endsWith('/card_intelligence_publications')) {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify([{
        catalog_variant_id: '20000000-0000-4000-8000-000000000001',
        support_tier: 5,
        publication_status: 'published',
        reason_codes: [],
        payload: {
          seriesIdentity: {
            sourceId: 'approved-synthetic-market', currency: 'USD', language: 'en',
            finish: 'regular', conditionClass: 'raw', marketCondition: 'near-mint',
            priceSemantics: 'market'
          },
          observed: { price: 14, currency: 'USD', source: 'Approved synthetic market', observedAt: '2026-08-09T00:00:00.000Z', quality: 0.94 },
          history: [
            { price: 11, currency: 'USD', source: 'Approved synthetic market', observedAt: '2026-06-09T00:00:00.000Z' },
            { price: 12.5, currency: 'USD', source: 'Approved synthetic market', observedAt: '2026-07-09T00:00:00.000Z' }
          ],
          trend: { return30d: 0.12, return90d: 0.2, status: 'rise', confidence: 78, historyDensity: 0.9 },
          forecasts: { 90: {
            q10: 10, q25: 13, q50: 16, q75: 19, q90: 23,
            probabilityUp: 0.68, confidence: 72,
            confidenceReason: 'A reviewed exact-variant history supports this range.',
            coverageStatus: 'Exact raw variant with approved history',
            dataFreshness: 'Observed August 9, 2026',
            whatChanged: 'First approved public forecast for this exact variant.',
            origin: '2026-08-09T00:00:00.000Z', maturesAt: '2026-11-07T00:00:00.000Z',
            modelVersion: 'synthetic-90d-v1', modelUpdatedAt: '2026-08-08T00:00:00.000Z'
          } },
          drivers: { supporting: ['Consistent approved observations'], limiting: ['A single exact-variant cohort remains narrow'] },
          scorecards: [{
            modelVersion: 'synthetic-90d-v1', cohort: 'Magic raw exact variants', horizonDays: 90,
            maturedForecasts: 24, medianAbsoluteErrorPct: 11.5, directionAccuracy: 0.71,
            interval80Coverage: 0.83, baselineErrorPct: 16.2, lastTrained: '2026-08-08T00:00:00.000Z'
          }]
        },
        source_attributions: [{ name: 'Approved synthetic market', attribution: 'Synthetic browser acceptance fixture' }],
        source_policy_hash: 'synthetic-policy',
        payload_hash: 'synthetic-phase4-v1',
        published_at: '2026-08-09T00:00:00.000Z',
        expires_at: '2027-08-09T00:00:00.000Z'
      }]) });
    }
    return route.fulfill({ contentType: 'application/json', body: '[]' });
  });
}

async function seedPhase4Alert(page) {
  await page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('collectfolio');
      request.addEventListener('success', () => resolve(request.result), { once: true });
      request.addEventListener('error', () => reject(request.error), { once: true });
    });
    await new Promise((resolve, reject) => {
      const transaction = database.transaction('alerts', 'readwrite');
      transaction.objectStore('alerts').put({
        id: 'phase4-browser-alert',
        watchKey: 'variant:20000000-0000-4000-8000-000000000001',
        variantId: '20000000-0000-4000-8000-000000000001',
        kind: 'forecast_change',
        message: 'Synthetic Archive Mage received a revised approved forecast.',
        triggeredAt: '2026-08-09T01:00:00.000Z',
        readAt: '',
        mutedAt: ''
      });
      transaction.addEventListener('complete', resolve, { once: true });
      transaction.addEventListener('abort', () => reject(transaction.error), { once: true });
      transaction.addEventListener('error', () => reject(transaction.error), { once: true });
    });
    database.close();
  });
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}

test('guest shell preserves every current primary entry point', async ({ page }) => {
  await openApp(page);
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
  const navigation = page.getByRole('navigation', { name: 'Primary' });
  await navigation.getByRole('button', { name: 'Discover' }).click();
  await expect(page).toHaveURL(/\/discover$/);
  await expect(page.getByRole('heading', { name: 'Discover' })).toBeVisible();
  await navigation.getByRole('button', { name: 'Scan' }).click();
  await expect(page).toHaveURL(/\/scan$/);
  await expect(page.getByRole('heading', { name: 'Scan', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open Camera' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Upload Photo' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Search catalog/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Import collection/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Export backup/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Create custom item/ })).toBeVisible();
  await expect(page.getByText(/Use one item or several/i)).toBeVisible();
  await expect(page.getByText(/camera permission is denied/i)).toBeVisible();
  await navigation.getByRole('button', { name: 'Collection' }).click();
  await expect(page).toHaveURL(/\/collection\/items$/);
  await expect(page.getByRole('heading', { name: 'Collection', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Watchlist' }).click();
  await expect(page).toHaveURL(/\/collection\/watchlist$/);
  await expect(page.getByRole('heading', { name: 'Track cards before you buy' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Find a card' })).toBeVisible();
  await expect(page.locator('.watchlist-controls')).toHaveCount(0);
  await navigation.getByRole('button', { name: 'Insights' }).click();
  await expect(page).toHaveURL(/\/insights$/);
  await expect(page.getByRole('heading', { name: 'Insights', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open settings' }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
});

test('foundation shell stays truthful and keyboard-operable across breakpoints', async ({ page }) => {
  await openApp(page);
  const navigation = page.getByRole('navigation', { name: 'Primary' });
  for (const name of ['Home', 'Discover', 'Scan', 'Collection', 'Insights']) {
    await expect(navigation.getByRole('button', { name })).toBeVisible();
  }
  await expect(page.locator('.portfolio-context')).toContainText('Collection');
  await expect(page.getByText('Saved on this device', { exact: true })).toBeVisible();
  await expect(page.locator('.shell-topbar').getByRole('button', { name: 'Search cards' })).toBeVisible();
  await expect(page.getByRole('button', { name: /notifications/i })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /switch portfolio/i })).toHaveCount(0);

  await page.keyboard.press('/');
  await expect(page).toHaveURL(/\/discover$/);
  await expect(page.locator('#catalog-query')).toBeFocused();

  for (const viewport of [
    { width: 390, height: 844, mobile: true },
    { width: 768, height: 900, mobile: false },
    { width: 1024, height: 900, mobile: false },
    { width: 1440, height: 900, mobile: false },
    { width: 1920, height: 1080, mobile: false }
  ]) {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await expect(navigation.getByRole('button', { name: 'Home' })).toBeVisible();
    await expect(navigation.getByRole('button', { name: 'Scan' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open settings' })).toBeVisible();
    const layout = await navigation.evaluate((element) => {
      const main = document.querySelector('#main-content');
      return {
        position: getComputedStyle(element).position,
        bottom: Math.round(element.getBoundingClientRect().bottom),
        viewport: innerHeight,
        navigationHeight: Math.round(element.getBoundingClientRect().height),
        mainPaddingBottom: Number.parseFloat(getComputedStyle(main).paddingBottom)
      };
    });
    expect(layout.position).toBe(viewport.mobile ? 'fixed' : 'static');
    if (viewport.mobile) {
      expect(layout.bottom).toBe(layout.viewport);
      expect(layout.mainPaddingBottom).toBeGreaterThan(layout.navigationHeight);
    }
  }
});

test('a blocked local database upgrade explains recovery instead of loading forever', async ({ context, page }) => {
  const fixturePath = '/__collectfolio-blocked-upgrade-fixture__.html';
  await page.route(`**${fixturePath}`, (route) => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><title>CollectFolio blocked upgrade fixture</title>'
  }));
  await page.goto(fixturePath);
  await page.unroute(`**${fixturePath}`);
  await page.evaluate(async () => {
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase('collectfolio');
      request.addEventListener('success', resolve, { once: true });
      request.addEventListener('error', () => reject(request.error), { once: true });
    });
    globalThis.blockingCollectFolioDatabase = await new Promise((resolve, reject) => {
      const request = indexedDB.open('collectfolio', 5);
      request.addEventListener('upgradeneeded', () => {
        request.result.createObjectStore('holdings', { keyPath: 'id' });
      }, { once: true });
      request.addEventListener('success', () => resolve(request.result), { once: true });
      request.addEventListener('error', () => reject(request.error), { once: true });
    });
  });

  const appPage = await context.newPage();
  await appPage.goto('/');
  await expect(appPage.getByRole('heading', { name: 'Local collection needs attention' })).toBeVisible();
  await expect(appPage.locator('#main-content').getByText(/Close every other CollectFolio tab or installed app window/)).toBeVisible();
  await expect(appPage.getByText('Opening your local collection…')).toHaveCount(0);

  await page.evaluate(() => globalThis.blockingCollectFolioDatabase.close());
  await appPage.getByRole('button', { name: 'Try again' }).click();
  await dismissOnboarding(appPage, 'Home');

  const nextVersion = await page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('collectfolio', 7);
    request.addEventListener('success', () => {
      const version = request.result.version;
      request.result.close();
      resolve(version);
    }, { once: true });
    request.addEventListener('error', () => reject(request.error), { once: true });
    request.addEventListener('blocked', () => reject(new Error('The current app did not release its database connection.')), { once: true });
  }));
  expect(nextVersion).toBe(7);
});

test('routes restore filters and Quick Inspector preserves context, focus, and full detail', async ({ page }) => {
  // catalog-v2 B3: the 'Market source' filter's secondary-provider options
  // (scryfall included) were removed -- only 'all' and 'tcgcsv' remain.
  await page.goto('/discover/search?q=Lotus&category=magic&provider=tcgcsv');
  await dismissOnboarding(page, 'Discover');
  await expect(page.locator('#catalog-query')).toHaveValue('Lotus');
  await expect(page.locator('[name="category"]')).toHaveValue('magic');
  await expect(page.locator('[name="provider"]')).toHaveValue('tcgcsv');

  await seedLegacyIndexedDB(page);
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name: 'Collection' }).click();
  const holdingCard = page.locator('[data-action="open-detail"][data-holding-id="10000000-0000-4000-8000-000000000001"]');
  await holdingCard.click();
  await expect(page).toHaveURL(/\/holdings\/10000000-0000-4000-8000-000000000001$/);
  const inspector = page.getByRole('dialog', { name: 'Synthetic Archive Mage' });
  await expect(inspector).toBeVisible();
  await expect(inspector.getByRole('button', { name: 'Close item inspector' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/\/collection\/items$/);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(holdingCard).toBeFocused();

  await holdingCard.click();
  await page.getByRole('dialog', { name: 'Synthetic Archive Mage' }).getByRole('button', { name: 'Open full details' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.detail-product').getByRole('heading', { name: 'Synthetic Archive Mage' })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/collection\/items$/);
  await expect(page.getByRole('heading', { name: 'Collection', exact: true })).toBeVisible();

  await page.goto('/holdings/10000000-0000-4000-8000-000000000001');
  await expect(page.getByRole('heading', { name: 'Synthetic Archive Mage' }).first()).toBeVisible();
});

test('collection chart labels remain readable and unclipped across supported viewports', async ({ page }) => {
  test.slow();
  await seedLegacyIndexedDB(page);
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
  for (const viewport of [
    { name: 'narrow mobile', width: 320, height: 720 },
    { name: 'iPhone class', width: 390, height: 844 },
    { name: 'large Android', width: 412, height: 915 },
    { name: 'mobile landscape', width: 740, height: 412 },
    { name: 'small tablet', width: 768, height: 1024 },
    { name: 'large tablet', width: 1024, height: 900 },
    { name: 'laptop', width: 1366, height: 768 },
    { name: 'large desktop', width: 1920, height: 1080 }
  ]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const axisLabels = await page.locator('.overview-performance .collection-trend-chart .chart-axis-label').evaluateAll((labels) => {
      const chart = labels[0]?.closest('.collection-trend-chart')?.getBoundingClientRect();
      return labels.map((label) => {
        const rect = label.getBoundingClientRect();
        return {
          height: rect.height,
          left: rect.left,
          right: rect.right,
          chartLeft: chart?.left,
          chartRight: chart?.right
        };
      });
    });
    expect(axisLabels.length, `${viewport.name} chart labels`).toBeGreaterThan(0);
    expect(Math.min(...axisLabels.map(({ height }) => height)), `${viewport.name} chart label height`).toBeGreaterThanOrEqual(8);
    expect(axisLabels.every(({ left, right, chartLeft, chartRight }) => (
      left >= chartLeft - 1 && right <= chartRight + 1
    )), `${viewport.name} chart label clipping`).toBe(true);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
});

test('version-4 local data hydrates calculations, holdings, and scan recovery', async ({ page }) => {
  await seedLegacyIndexedDB(page);
  const migration = await page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('collectfolio');
      request.addEventListener('success', () => resolve(request.result), { once: true });
      request.addEventListener('error', () => reject(request.error), { once: true });
    });
    const transaction = database.transaction(['localValueObservations', 'scans']);
    const observationsRequest = transaction.objectStore('localValueObservations').getAll();
    const scansRequest = transaction.objectStore('scans').getAll();
    const readRequest = (request) => new Promise((resolve, reject) => {
      request.addEventListener('success', () => resolve(request.result), { once: true });
      request.addEventListener('error', () => reject(request.error), { once: true });
    });
    const [rows, scans] = await Promise.all([
      readRequest(observationsRequest), readRequest(scansRequest)
    ]);
    const store = transaction.objectStore('localValueObservations');
    const result = {
      version: database.version,
      indexes: [...store.indexNames],
      rows: rows.map(({ subjectId, source, unitPrice }) => ({ subjectId, source, unitPrice })),
      scanSourceFieldsRemoved: scans.every((scan) => !('sourceImage' in scan) && !('sourceImageRetainedAt' in scan))
    };
    database.close();
    return result;
  });
  expect(migration.version).toBe(6);
  expect(migration.scanSourceFieldsRemoved).toBe(true);
  expect(migration.indexes).toEqual(expect.arrayContaining(['subjectId', 'observedAt']));
  expect(migration.rows).toHaveLength(2);
  expect(migration.rows).toEqual(expect.arrayContaining([
    expect.objectContaining({ subjectId: '10000000-0000-4000-8000-000000000001', source: 'catalog', unitPrice: 12 }),
    expect.objectContaining({ subjectId: '10000000-0000-4000-8000-000000000002', source: 'manual' })
  ]));
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
  const summary = page.getByRole('region', { name: 'Collection performance' });
  await expect(summary).toContainText('$79.00');
  await expect(summary).toContainText('$89.00');
  await expect(summary).toContainText('3');
  await expect(page.getByRole('button', { name: /Saved scan ready/ })).toBeVisible();

  await page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name: 'Collection' }).click();
  await expect(page.getByText(/3 purchases saved on this device/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Synthetic Archive Mage' }).first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Synthetic Rights Gate ex' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Synthetic Unpriced Comic' })).toBeVisible();

  await page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name: 'Home' }).click();
  await page.getByRole('button', { name: /Saved scan ready/ }).click();
  await expect(page.getByRole('heading', { name: 'Review 2 detected items' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Review queue summary' })).toContainText('Unmatched1');
  await expect(page.getByText('Apply purchase details to all')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add 1 confirmed' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Identify this item' })).toBeVisible();
  await expectNoBlockingAccessibilityViolations(page);
  await page.getByRole('button', { name: 'Add 1 confirmed' }).click();
  await expect(page.getByRole('heading', { name: 'Items added' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '1 item added' })).toBeVisible();
  await page.getByRole('button', { name: 'View collection' }).click();
  await expect(page.getByText(/4 purchases saved on this device/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Synthetic Scan Draft' })).toBeVisible();
});

test('same-day local value corrections stay append-only in IndexedDB', async ({ page }) => {
  await seedLegacyIndexedDB(page);
  const ledger = await page.evaluate(async () => {
    const [{ getAll, getRecord, saveHolding }, { normalizeLocalObservations }] = await Promise.all([
      import('/assets/js/core/db.js'),
      import('/assets/js/core/local-scenarios.js')
    ]);
    const original = await getRecord('holdings', '10000000-0000-4000-8000-000000000001');
    const first = await saveHolding({ ...original, item: { ...original.item, price: 13 } });
    const second = await saveHolding({ ...first, item: { ...first.item, price: 14 } });
    await saveHolding(second);
    const rows = (await getAll('localValueObservations'))
      .filter((row) => row.subjectId === original.id && row.source === 'catalog');
    const active = normalizeLocalObservations(rows).at(-1);
    return {
      rowCount: rows.length,
      uniqueIds: new Set(rows.map((row) => row.id)).size,
      supersedingRows: rows.filter((row) => row.supersedes).length,
      activePrice: active?.unitPrice,
      sourceUpdatedAt: active?.sourceUpdatedAt
    };
  });
  expect(ledger).toEqual({
    rowCount: 3,
    uniqueIds: 3,
    supersedingRows: 2,
    activePrice: 14,
    sourceUpdatedAt: '2026-08-08T10:00:00.000Z'
  });
});

test('Phase 3 collection tools stay selection-scoped and Watchlist removal is confirmed', async ({ page }) => {
  await seedLegacyIndexedDB(page);
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name: 'Collection' }).click();
  await page.getByRole('button', { name: 'Purchases', exact: true }).click();
  const holding = page.locator('.portfolio-holding-card[data-holding-id="10000000-0000-4000-8000-000000000001"]');
  await page.locator('summary[aria-label="More collection actions"]').click();
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await holding.getByRole('button', { name: 'Select Synthetic Archive Mage' }).click();
  const toolbar = page.getByRole('region', { name: 'Bulk purchase actions' });
  await expect(toolbar).toBeVisible();
  await toolbar.getByRole('button', { name: 'Add tags' }).click();
  const tagDialog = page.getByRole('dialog', { name: /Tag 1 selected purchase/ });
  await tagDialog.getByRole('textbox', { name: 'Tags' }).fill('favorite');
  await tagDialog.getByRole('button', { name: 'Add tags' }).click();
  await expect(holding).toContainText('#favorite');

  await holding.getByRole('button', { name: 'Select Synthetic Archive Mage' }).click();
  await page.getByRole('region', { name: 'Bulk purchase actions' }).getByRole('button', { name: 'Duplicate' }).click();
  await page.getByRole('dialog', { name: /Duplicate 1 purchase/ }).getByRole('button', { name: 'Create copies' }).click();
  await expect(page.getByText(/4 purchases saved on this device/)).toBeVisible();

  await page.getByRole('tab', { name: 'Watchlist' }).click();
  await expect(page.getByRole('heading', { name: 'Synthetic Archive Mage' })).toBeVisible();
  await page.getByRole('button', { name: 'Target & alerts' }).click();
  const preferences = page.getByRole('dialog', { name: /Watch settings/ });
  await preferences.getByRole('spinbutton', { name: 'Target price' }).fill('10');
  await preferences.getByRole('button', { name: 'Save preferences' }).click();
  await expect(page.locator('.watch-stats dd').filter({ hasText: '$10.00' })).toContainText('$2.00 above target');
  await expectNoBlockingAccessibilityViolations(page);
  const remove = page.getByRole('button', { name: 'Remove Synthetic Archive Mage from Watchlist' });
  await remove.click();
  await page.getByRole('dialog', { name: 'Remove from Watchlist?' }).getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('heading', { name: 'Synthetic Archive Mage' })).toBeVisible();
  await remove.click();
  await page.getByRole('dialog', { name: 'Remove from Watchlist?' }).getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Track cards before you buy' })).toBeVisible();
});

test('Scenario Lab keeps assumption-based output separate while published forecasts remain fail closed', async ({ page }) => {
  await seedLegacyIndexedDB(page);

  // T6 demoted local-scenario-v1 to manual/custom items only: the two
  // catalog-linked holdings in this fixture (scryfall, pokemon) now defer
  // to the honest "insufficient evidence" state instead of a modeled
  // local-scenario range, and the fixture's only manual/custom holding
  // (id ...003) carries no manual value of its own. Give it one here,
  // scoped to this test only (not the shared fixture file), so the
  // original protection intent -- manual scenarios still work while
  // published forecasts stay fail-closed -- remains provable.
  await page.evaluate(async ({ databaseName }) => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName);
      request.addEventListener('success', () => resolve(request.result), { once: true });
      request.addEventListener('error', () => reject(request.error), { once: true });
    });
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(['holdings'], 'readwrite');
      const store = transaction.objectStore('holdings');
      const getRequest = store.get('10000000-0000-4000-8000-000000000003');
      getRequest.addEventListener('success', () => {
        const holding = getRequest.result;
        holding.manualMarketPrice = 18;
        holding.manualMarketCurrency = 'USD';
        store.put(holding);
      }, { once: true });
      transaction.addEventListener('complete', resolve, { once: true });
      transaction.addEventListener('abort', () => reject(transaction.error), { once: true });
      transaction.addEventListener('error', () => reject(transaction.error), { once: true });
    });
    database.close();
  }, legacyBackup);
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

  await page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name: 'Insights' }).click();
  await page.getByRole('tab', { name: 'Scenario Lab' }).click();
  await expect(page).toHaveURL(/\/insights\/scenarios$/);
  await expect(page.getByRole('heading', { name: '90-day collection scenario' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Published market forecasts remain gated' })).toBeVisible();

  await expect(page.getByText('Unchanged scenario').first()).toBeVisible();
  await expect(page.getByText(/Scenarios are assumption-based estimates/)).toBeVisible();
  await expect(page.locator('.scenario-item-row').first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Published Forecasts' })).toHaveCount(0);
  await expect(page.getByRole('img', { name: /Approved forecast projection/ })).toHaveCount(0);
});

test('Phase 4 Insights separates actuals and forecasts, persists alert state, and gates track-record metrics', async ({ page }) => {
  test.slow();
  await configureApprovedPhase4Publication(page);
  await seedLegacyIndexedDB(page);
  await seedPhase4Alert(page);

  await page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name: 'Insights' }).click();
  await page.getByRole('tab', { name: 'Scenario Lab' }).click();
  await expect(page).toHaveURL(/\/insights\/scenarios$/);
  await expect(page.getByRole('heading', { name: '90-day collection scenario' })).toBeVisible();
  const published = page.getByRole('region', { name: 'Published Forecasts' });
  await expect(published).toContainText('1 covered');
  await expect(published).toContainText('Current market');
  await expect(published).toContainText('$14.00');
  await expect(published).toContainText('$13.00–$19.00');
  await expect(published.getByText('Synthetic Archive Mage', { exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: /Approved forecast projection/ })).toHaveCount(0);
  await published.locator('[data-published-expand]').click();
  await expect(published.getByText(/Based on 3 observations from 1 source/)).toBeVisible();
  await expectNoBlockingAccessibilityViolations(page);

  await page.getByRole('button', { name: '30 days' }).click();
  await expect(page).toHaveURL(/\/insights\/scenarios\?horizon=30$/);
  await expect(page.getByRole('heading', { name: 'Published Forecasts' })).toHaveCount(0);

  await page.getByRole('tab', { name: /Alerts/ }).click();
  await expect(page).toHaveURL(/\/insights\/alerts$/);
  const alert = page.locator('.alert-history-card').filter({ hasText: 'revised approved forecast' });
  await expect(alert).toContainText('Unread');
  await expect(alert).toContainText('Model-based forecast change');
  await alert.getByRole('button', { name: 'Mark read' }).click();
  await expect(alert).toContainText('Read');
  await alert.getByRole('button', { name: 'Mute notification' }).click();
  await expect(alert).toContainText('Muted');
  await page.reload();
  await expect(page).toHaveURL(/\/insights\/alerts$/);
  await expect(page.locator('.alert-history-card')).toContainText('Muted');

  await page.getByRole('tab', { name: 'Track Record' }).click();
  await expect(page).toHaveURL(/\/insights\/track-record$/);
  await expect(page.getByRole('heading', { name: 'Approved model scorecard' })).toBeVisible();
  await expect(page.getByText('24 matured')).toBeVisible();
  await expect(page.getByText('71.0%')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Forecast history' })).toBeVisible();
  await expect(page.getByText(/Open · not included in metrics/)).toBeVisible();
});

test('Insights alerts has no serious or critical accessibility violations', async ({ page }) => {
  await configureApprovedPhase4Publication(page);
  await seedLegacyIndexedDB(page);
  await seedPhase4Alert(page);
  await page.goto('/insights/alerts');
  await expect(page.getByRole('tab', { name: /Alerts/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.alert-history-card')).toBeVisible();
  await expectNoBlockingAccessibilityViolations(page);
});

test('first-use Overview has no serious or critical accessibility violations', async ({ page }) => {
  await openApp(page);
  const report = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const blocking = report.violations.filter((entry) => ['serious', 'critical'].includes(entry.impact));
  expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
});

test('core vertical slice first-use Overview visual baseline', async ({ page }) => {
  await openApp(page);
  await expect(page.locator('.toast')).toHaveCount(0);
  await stabilizeSnapshotTypography(page);
  await expect(page).toHaveScreenshot('core-slice-overview-empty.png', {
    animations: 'disabled',
    caret: 'hide',
    fullPage: true,
    maxDiffPixels: 50
  });
});
