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
    // Truly native — these MUST resolve from disk (.node files cannot be
    // bundled into a JS file).
    'electron',
    'better-sqlite3',
    'node-pty',
    // Optional Drizzle drivers — externalize so esbuild doesn't try to bundle
    // drivers we don't use. Drizzle's lazy imports tolerate the missing
    // require because we only ever use better-sqlite3 at runtime.
    'pg', 'pg-native', 'mysql2', 'mysql', 'sqlite3', 'tedious',
    '@libsql/client', '@neondatabase/serverless', '@vercel/postgres',
    '@planetscale/database', '@cloudflare/workers-types',
    'expo-sqlite', 'bun:sqlite',
    // NOTE — `lazy-val` was externalized in v1.0.1 to dodge a build-time
    // resolution error. v1.1.0-rc3 inlines it instead because pnpm's
    // content-addressed `node_modules` layout means the packaged DMG didn't
    // ship `lazy-val` on disk; the runtime require crashed at first launch.
    // electron-updater's transitive js-yaml + tiny-typed-emitter follow the
    // same path — bundling them inline keeps the build deterministic.
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
