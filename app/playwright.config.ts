import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 240_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  workers: 1,
  retries: 0,
  use: {
    actionTimeout: 8_000,
    navigationTimeout: 30_000,
  },
});
