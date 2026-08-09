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

async function openApp(page) {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
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

async function seedLegacyIndexedDB(page) {
  await openApp(page);
  await page.evaluate(async ({ databaseName, databaseVersion, stores }) => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName, databaseVersion);
      request.addEventListener('success', () => resolve(request.result), { once: true });
      request.addEventListener('error', () => reject(request.error), { once: true });
    });
    const names = Object.keys(stores).filter((name) => database.objectStoreNames.contains(name));
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(names, 'readwrite');
      for (const name of names) {
        const store = transaction.objectStore(name);
        store.clear();
        for (const record of stores[name]) store.put(record);
      }
      transaction.addEventListener('complete', resolve, { once: true });
      transaction.addEventListener('abort', () => reject(transaction.error), { once: true });
      transaction.addEventListener('error', () => reject(transaction.error), { once: true });
    });
    database.close();
  }, legacyBackup);
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}

test('guest shell preserves every current primary entry point', async ({ page }) => {
  await openApp(page);
  await expect(page.getByRole('heading', { name: 'Your collection starts here.' })).toBeVisible();
  const navigation = page.getByRole('navigation', { name: 'Primary' });
  await navigation.getByRole('button', { name: 'Search' }).click();
  await expect(page.getByRole('heading', { name: 'Search collectibles' })).toBeVisible();
  await navigation.getByRole('button', { name: 'Add' }).click();
  await expect(page.getByRole('heading', { name: 'Add collectibles' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Scan multiple items/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Scan one item/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Search catalogs/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Create custom item/ })).toBeVisible();
  await navigation.getByRole('button', { name: 'Portfolio' }).click();
  await expect(page.getByRole('heading', { name: 'Portfolio' })).toBeVisible();
  await navigation.getByRole('button', { name: 'Profile' }).click();
  await expect(page.getByRole('heading', { name: 'Profile' })).toBeVisible();
});

test('version-4 local data hydrates calculations, holdings, and scan recovery', async ({ page }) => {
  await seedLegacyIndexedDB(page);
  await expect(page.getByRole('heading', { name: 'Your collection is moving.' })).toBeVisible();
  const summary = page.getByRole('region', { name: 'Portfolio summary' });
  await expect(summary).toContainText('$79.00');
  await expect(summary).toContainText('$89.00');
  await expect(summary).toContainText('3');
  await expect(page.getByRole('button', { name: 'Resume saved scan (1)' })).toBeVisible();

  await page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name: 'Portfolio' }).click();
  await expect(page.getByText('3 results')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Synthetic Archive Mage' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Synthetic Rights Gate ex' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Synthetic Unpriced Comic' })).toBeVisible();

  await page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name: 'Home' }).click();
  await page.getByRole('button', { name: 'Resume saved scan (1)' }).click();
  await expect(page.getByRole('heading', { name: 'Review 2 crops' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add 1 approved' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Unmatched crop' })).toBeVisible();
});

test('public forecast presentation remains fail closed', async ({ page }) => {
  await seedLegacyIndexedDB(page);
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name: 'Portfolio' }).click();
  await page.getByRole('tab', { name: 'Forecasts' }).click();
  await expect(page.getByRole('heading', { name: 'Forecasts are not publicly available' })).toBeVisible();
  await expect(page.locator('.projection-chart')).toHaveCount(0);
});

test('first-use Overview has no serious or critical accessibility violations', async ({ page }) => {
  await openApp(page);
  const report = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const blocking = report.violations.filter((entry) => ['serious', 'critical'].includes(entry.impact));
  expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
});

test('first-use Overview visual baseline', async ({ page }) => {
  await openApp(page);
  await stabilizeSnapshotTypography(page);
  await expect(page).toHaveScreenshot('legacy-overview-empty.png', {
    animations: 'disabled',
    caret: 'hide',
    fullPage: true
  });
});
