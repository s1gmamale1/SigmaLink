// Bundle the Electron main and preload entry points with esbuild.
// Native modules and Electron itself are kept external so the runtime resolves
// them from node_modules; everything else (shared types, Drizzle, controllers)
// is inlined into a single JS file per entry to keep startup fast.

const path = require('node:path');
const fs = require('node:fs');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'electron-dist');
fs.mkdirSync(outDir, { recursive: true });

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  sourcemap: 'linked',
  logLevel: 'info',
  external: [
    'electron',
    'better-sqlite3',
    'node-pty',
    // electron-updater pulls `lazy-val` via dynamic require; mark external so
    // esbuild doesn't try to resolve it at bundle time. v1.0.1 — pre-existing
    // build break uncovered while fixing the DMG bindings defect.
    'lazy-val',
    // Optional drivers Drizzle imports lazily — keep them external to avoid
    // pulling them into the bundle when we use only better-sqlite3.
    'pg', 'pg-native', 'mysql2', 'mysql', 'sqlite3', 'tedious',
    '@libsql/client', '@neondatabase/serverless', '@vercel/postgres',
    '@planetscale/database', '@cloudflare/workers-types',
    'expo-sqlite', 'bun:sqlite',
  ],
};

esbuild.buildSync({
  ...common,
  entryPoints: [path.join(root, 'electron/main.ts')],
  format: 'esm',
  outfile: path.join(outDir, 'main.js'),
  banner: {
    js: `import { createRequire as __sigmaCR } from 'module'; const require = __sigmaCR(import.meta.url);`,
  },
});

esbuild.buildSync({
  ...common,
  entryPoints: [path.join(root, 'electron/preload.ts')],
  format: 'cjs',
  outfile: path.join(outDir, 'preload.cjs'),
});

// Phase 5 Memory: stdio MCP server entry. Bundled as CJS so we can spawn it
// with plain `node mcp-memory-server.cjs` and avoid ESM loader gymnastics.
esbuild.buildSync({
  ...common,
  entryPoints: [path.join(root, 'src/main/core/memory/mcp-server.ts')],
  format: 'cjs',
  outfile: path.join(outDir, 'mcp-memory-server.cjs'),
});

console.log('[build-electron] wrote', path.relative(root, outDir));
