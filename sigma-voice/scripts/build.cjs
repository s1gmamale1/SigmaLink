// SigmaVoice — esbuild bundler for Electron main + preload.
//
// Mirrors app/scripts/build-electron.cjs but scoped to the sigma-voice app.
// Native .node modules (voice-mac, voice-win, voice-whisper) are kept external
// so the Electron runtime resolves them from disk; electron-builder's
// asarUnpack globs handle the rest.
//
// Relative path notes (sigmavoice-v0.3 — promoted to the top-level sibling):
//   __dirname  = SigmaLink/sigma-voice/scripts/
//   root       = SigmaLink/sigma-voice/
//   outDir     = SigmaLink/sigma-voice/sigma-dist/
//   repo root  = SigmaLink/  (two levels up — only for the cosmetic log below)
// The native modules (voice-mac/win/whisper) live under ../app/native/ and are
// resolved at runtime via link: deps in package.json; here they stay external.

const path = require('node:path');
const fs = require('node:fs');
const esbuild = require('esbuild');

const appRoot = path.resolve(__dirname, '..');           // SigmaLink/sigma-voice/
const repoRoot = path.resolve(appRoot, '..');            // SigmaLink/
const outDir = path.join(appRoot, 'sigma-dist');
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

    // node-global-key-listener spawns a prebuilt key-server binary via paths
    // relative to its OWN package dir (__dirname). Bundling it rewrites those
    // paths to sigma-dist/ and the binary can't be found → push-to-talk would
    // silently never fire. Keep it external so it loads from node_modules and
    // resolves its server binary correctly. (asar:false ships node_modules.)
    'node-global-key-listener',

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

// Preloads — must be CJS; Electron's contextBridge/ipcRenderer are CJS-land.
// settings preload (window.bridgeVoice) + HUD-overlay preload (window.sigmaHud).
for (const name of ['preload', 'hud-preload']) {
  esbuild.buildSync({
    ...common,
    entryPoints: [path.join(appRoot, `src/${name}.ts`)],
    format: 'cjs',
    outfile: path.join(outDir, `${name}.cjs`),
  });
}

console.log('[build-sigma-voice] wrote', path.relative(repoRoot, outDir));
