import { defineConfig, devices } from '@playwright/test';

const hostedBaseURL = process.env.PLAYWRIGHT_BASE_URL?.replace(/\/$/, '');

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  outputDir: 'test-results',
  snapshotPathTemplate: '{testDir}/{testFilePath}-snapshots/{arg}-{projectName}-{platform}{ext}',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI
    ? [['line'], ['html', { open: 'never', outputFolder: 'playwright-report' }]]
    : 'list',
  use: {
    baseURL: hostedBaseURL || 'http://127.0.0.1:4173',
    colorScheme: 'dark',
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure'
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 }
      }
    }
  ],
  webServer: hostedBaseURL ? undefined : {
    command: 'npm run dev',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000
  }
});
