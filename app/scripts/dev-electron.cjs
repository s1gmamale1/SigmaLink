// DEV-7 — Real Electron dev mode with renderer HMR.
//
// The default `electron:dev` script runs a full production `vite build` then
// launches Electron against the built `dist/` files — no hot-reload, slow inner
// loop. This launcher instead:
//   1. starts the Vite dev server (HMR) on a deterministic port,
//   2. esbuild-compiles the Electron main/preload bundles (electron:compile),
//   3. waits for the dev server to answer,
//   4. launches Electron with VITE_DEV_SERVER_URL set so the main process loads
//      the live dev server (electron/main.ts already honors this env var, see
//      `const devServerUrl = process.env.VITE_DEV_SERVER_URL`).
//
// Renderer edits hot-reload instantly; main/preload edits need a manual restart
// (re-run this script) because the Electron process must be recreated.
//
// NOTE: must be smoke-tested by launching it once (`pnpm electron:dev:hmr`) —
// it is intentionally NOT wired as the default `electron:dev` so the known-good
// build-and-launch path keeps working if this dev path needs tweaking.

const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.VITE_PORT || 5173);
const DEV_URL = `http://localhost:${PORT}`;
const IS_WIN = process.platform === 'win32';

/** @type {import('node:child_process').ChildProcess[]} */
const children = [];

function shutdown(code) {
  for (const child of children) {
    try {
      child.kill();
    } catch {
      /* already exited */
    }
  }
  process.exit(typeof code === 'number' ? code : 0);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

function spawnInherit(cmd, args, extraEnv) {
  const child = spawn(cmd, args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: IS_WIN,
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
  });
  children.push(child);
  return child;
}

function runToCompletion(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: IS_WIN });
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`)),
    );
    child.on('error', reject);
  });
}

function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() > deadline) reject(new Error(`Vite dev server never came up at ${url}`));
        else setTimeout(attempt, 300);
      });
    };
    attempt();
  });
}

async function main() {
  // 1. Vite dev server (HMR) on a deterministic port (strictPort → URL is known).
  spawnInherit('npx', ['vite', '--port', String(PORT), '--strictPort']);
  // 2. Compile the Electron main/preload bundles.
  await runToCompletion('node', ['scripts/build-electron.cjs']);
  // 3. Wait for the dev server, then launch Electron pointed at it.
  await waitForServer(DEV_URL, 30_000);
  const electron = spawnInherit('npx', ['electron', 'electron-dist/main.js'], {
    VITE_DEV_SERVER_URL: DEV_URL,
    NODE_ENV: 'development',
  });
  electron.on('exit', (code) => shutdown(code));
}

main().catch((err) => {
  console.error(`[dev-electron] ${err.message}`);
  shutdown(1);
});
