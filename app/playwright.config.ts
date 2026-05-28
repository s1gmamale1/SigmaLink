import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 240_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  workers: 1,
  retries: 0,
  // Visual observability: every run emits a reviewable trace timeline (DOM +
  // screenshots per action) so an agent or human can SEE what the app did, not
  // just trust the assertion. Video/screenshot retained on failure for triage.
  outputDir: 'test-results',
  use: {
    actionTimeout: 8_000,
    navigationTimeout: 30_000,
    trace: 'on',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
