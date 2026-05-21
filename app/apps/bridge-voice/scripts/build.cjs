// BridgeVoice — esbuild bundler for Electron main + preload.
//
// Mirrors app/scripts/build-electron.cjs but scoped to the bridge-voice app.
// Native .node modules (voice-mac, voice-win, voice-whisper) are kept external
// so the Electron runtime resolves them from disk; electron-builder's
// asarUnpack globs handle the rest.
//
// Relative path notes:
//   __dirname  = app/apps/bridge-voice/scripts/
//   root       = app/apps/bridge-voice/
//   outDir     = app/apps/bridge-voice/bridge-dist/
//   app root   = app/  (two levels up — for the native/ directory)

const path = require('node:path');
const fs = require('node:fs');
const esbuild = require('esbuild');

const appRoot = path.resolve(__dirname, '..');            // app/apps/bridge-voice/
const workspaceRoot = path.resolve(appRoot, '../..');    // app/
const outDir = path.join(appRoot, 'bridge-dist');
fs.mkdirSync(outDir, { recursive: true });

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  sourcemap: 'linked',
  logLevel: 'info',
  external: [
    // Electron must resolve from the runtime — never bundle it.
    'electron',

    // Voice native modules — .node files cannot be bundled into JS.
    // These are workspace packages that resolve to native/voice-*/build/Release/*.node.
    '@sigmalink/voice-mac',
    '@sigmalink/voice-win',
    '@sigmalink/voice-whisper',

    // Optional Drizzle drivers — externalize the same set as the main app so
    // esbuild does not complain about missing optional peer deps.
    'pg', 'pg-native', 'mysql2', 'mysql', 'sqlite3', 'tedious',
    '@libsql/client', '@neondatabase/serverless', '@vercel/postgres',
    '@planetscale/database', '@cloudflare/workers-types',
    'expo-sqlite', 'bun:sqlite',
  ],
};

// Main process — ESM output so Electron 30+ can load it as a module.
esbuild.buildSync({
  ...common,
  entryPoints: [path.join(appRoot, 'src/main.ts')],
  format: 'esm',
  outfile: path.join(outDir, 'main.js'),
  // Shim require() for any CJS transitive dep inside the ESM bundle.
  banner: {
    js: `import { createRequire as __bvCR } from 'module'; const require = __bvCR(import.meta.url);`,
  },
});

// Preload — must be CJS; Electron's contextBridge/ipcRenderer are CJS-land.
esbuild.buildSync({
  ...common,
  entryPoints: [path.join(appRoot, 'src/preload.ts')],
  format: 'cjs',
  outfile: path.join(outDir, 'preload.cjs'),
});

console.log('[build-bridge-voice] wrote', path.relative(workspaceRoot, outDir));
