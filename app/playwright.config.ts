import { defineConfig } from '@playwright/test';

// The perf project (CPU-throttled jank-review harness) is opt-in: it only
// joins the project list when PERF=1 is set. CI and the release gate run a
// BARE `playwright test` (no project filter) — without this guard a bare run
// would sweep BOTH projects and drag the heavy perf spec into the e2e gate.
// `npm run test:perf` sets PERF=1 so `--project=perf` resolves. The existing
// `npx playwright test tests/e2e/` path-only invocation is unaffected either
// way (a path filter scopes to the matching project's testDir).
const includePerf = process.env.PERF === '1';

export default defineConfig({
  // testDir is set per-project below. The release gate / CI runs ONLY the e2e
  // project (`--project=e2e`), and the existing `npx playwright test tests/e2e/`
  // invocation passes an explicit path that overrides project testDirs, so it
  // still picks up only the e2e specs. The `perf` project is heavy
  // (CPU-throttled) + needs a manual video-vision review step, so it is kept
  // OUT of the e2e gate and run on demand via `npm run test:perf`.
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
  projects: [
    { name: 'e2e', testDir: './tests/e2e' },
    // Match ONLY *.spec.ts — tests/perf also holds the vitest analyzer
    // *.test.ts, and letting Playwright load that pulls in @vitest/expect,
    // which collides with Playwright's expect ("Cannot redefine
    // Symbol($$jest-matchers-object)").
    ...(includePerf ? [{ name: 'perf', testDir: './tests/perf', testMatch: /.*\.spec\.ts$/ }] : []),
  ],
});
