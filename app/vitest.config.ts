// Vitest config for unit tests under src/. Kept separate from vite.config.ts
// so the renderer/Electron build stays untouched. Tests default to a pure
// Node environment and exclude everything that needs Electron / native
// modules. Renderer-component tests opt into jsdom via a per-file
// `@vitest-environment jsdom` docblock comment.
import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    include: [
      'src/**/*.test.ts',
      'src/**/*.test.tsx',
      'packages/**/*.test.ts',
      'packages/**/*.test.tsx',
      // perf harness analyzer (pure fn) — the .spec.ts is Playwright-only and
      // never matches *.test.ts, so it stays out of the vitest sweep.
      'tests/perf/**/*.test.ts',
      'electron/**/*.test.ts',
    ],
    exclude: ['node_modules', 'dist', 'electron-dist', 'tests/e2e'],
    environment: 'node',
    globals: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      reportsDirectory: 'coverage',
      // Initial repo-wide ratchet from the v1.1.9 baseline. Keep these just
      // below current coverage so CI prevents regressions without pretending
      // the legacy surface is already broadly covered.
      thresholds: {
        lines: 22,
        statements: 21,
        functions: 21,
        branches: 18,
      },
    },
  },
});
