// Vitest config for unit tests under src/. Kept separate from vite.config.ts
// so the renderer/Electron build stays untouched. Tests are pure-Node and
// exclude everything that needs Electron / native modules.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['node_modules', 'dist', 'electron-dist', 'tests/e2e'],
    environment: 'node',
    globals: false,
  },
});
