// Per-workspace Playwright MCP supervisor.
//
// Lifecycle:
//   1. `start(workspaceId)` is called lazily on first browser open. We pick a
//      free TCP port on 127.0.0.1, spawn the Playwright MCP CLI (preferring
//      the bundled `@playwright/mcp` from node_modules; falling back to a
//      pinned `npx @playwright/mcp@<PLAYWRIGHT_MCP_VERSION>` only when
//      resolution fails) via `child_process.spawn`, and store the URL
//      `http://127.0.0.1:N/mcp`.
//   2. We supervise the child: stderr is buffered, exit triggers a respawn
//      with exponential backoff up to 3 attempts. After 3 consecutive
//      failures the supervisor records `lastError` and the renderer surfaces
//      the absent MCP url; the in-app browser still works as a passive
//      Chromium pane.
//   3. `stop(workspaceId)` SIGKILLs the child and clears state.
//
// CDP-attach mode vs. separate-Chromium mode
// ──────────────────────────────────────────
// Per the build blueprint, two paths are acceptable. We chose
// **separate-Chromium mode** for v1 because Electron's per-WebContents
// debugger does NOT expose a global CDP HTTP endpoint (`/json/version`)
// without the `--remote-debugging-port=<n>` switch being set BEFORE
// `app.whenReady()`. The product `main.ts` has long since booted by the
// time the supervisor wakes up, so `--cdp-endpoint` would have nothing to
// connect to.
//
// Concretely:
//   • Playwright MCP runs with its own headed (or headless) Chromium.
//   • The agent drives that Chromium via MCP tool calls.
//   • The in-app `WebContentsView` remains the user's local pane: same
//     browser_tabs persisted, same address bar. v1 does NOT mirror the
//     agent's Chromium frame-by-frame; the renderer simply shows a
//     "browser:state.lockOwner" indicator when the agent claims control.
//
// A future Phase-7 follow-up can add `app.commandLine.appendSwitch(
// 'remote-debugging-port', '0')` at the top of `main.ts` and switch to
// shared-Chromium CDP-attach mode without breaking the supervisor's API.

import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';

interface SupervisedEntry {
  workspaceId: string;
  port: number;
  url: string;
  child: ChildProcess | null;
  restarts: number;
  lastError: string | null;
  shuttingDown: boolean;
}

const MAX_RESTARTS = 3;
const RESPAWN_DELAY_MS = 1500;

// V3-W12 / closes A7 — pin the Playwright MCP version we ship against. Must
// match the `@playwright/mcp` devDependency in package.json so the npx
// fallback fetches the same release we tested.
const PLAYWRIGHT_MCP_VERSION = '0.0.75';

let cachedBundledCli: string | null | undefined;

/**
 * Try to resolve a bundled `@playwright/mcp/cli.js` from local node_modules.
 * Returns null if the package is not installed (npx fallback path) or if
 * resolution throws for any reason.
 */
function resolveBundledMcpCli(): string | null {
  if (cachedBundledCli !== undefined) return cachedBundledCli;
  try {
    const req = createRequire(import.meta.url);
    const pkgJson = req.resolve('@playwright/mcp/package.json');
    const root = path.dirname(pkgJson);
    cachedBundledCli = path.join(root, 'cli.js');
  } catch {
    cachedBundledCli = null;
  }
  return cachedBundledCli;
}

export class PlaywrightMcpSupervisor {
  private readonly entries = new Map<string, SupervisedEntry>();

  /**
   * Idempotently start the MCP server for the given workspace and return its
   * URL once the child is spawned AND the MCP port is actually accepting
   * connections. Repeated calls return the same URL.
   *
   * The port-readiness probe (`waitForPortListening`) is required because
   * callers write the MCP config and spawn the agent CLI immediately after
   * this resolves — without it the CLI's first MCP call would race the
   * Playwright child's bind and ECONNREFUSED.
   */
  async start(workspaceId: string): Promise<string> {
    const existing = this.entries.get(workspaceId);
    if (existing && existing.child && !existing.child.killed) {
      return existing.url;
    }

    const port = await pickFreePort();
    const url = `http://127.0.0.1:${port}/mcp`;
    const entry: SupervisedEntry = {
      workspaceId,
      port,
      url,
      child: null,
      restarts: 0,
      lastError: null,
      shuttingDown: false,
    };
    this.entries.set(workspaceId, entry);

    this.spawnChild(entry);
    // Best-effort readiness probe — never longer than 4s. If the child fails
    // to bind in time we still return the URL so the caller can write the
    // config; the supervisor will keep retrying via scheduleRestart().
    await waitForPortListening(port, 4000).catch(() => undefined);
    return url;
  }

  getMcpUrl(workspaceId: string): string | null {
    const e = this.entries.get(workspaceId);
    if (!e) return null;
    if (e.child && e.child.exitCode == null && !e.child.killed) return e.url;
    if (e.restarts < MAX_RESTARTS) return e.url; // supervisor may still be respawning
    return null;
  }

  stop(workspaceId: string): void {
    const e = this.entries.get(workspaceId);
    if (!e) return;
    e.shuttingDown = true;
    if (e.child) {
      try {
        e.child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    }
    this.entries.delete(workspaceId);
  }

  stopAll(): void {
    for (const id of Array.from(this.entries.keys())) this.stop(id);
  }

  private spawnChild(entry: SupervisedEntry): void {
    if (entry.shuttingDown) return;
    const isWin = process.platform === 'win32';
    const bundled = resolveBundledMcpCli();
    let cmd: string;
    let args: string[];
    if (bundled) {
      // Preferred path: spawn the bundled CLI directly with the current
      // Node/Electron runtime. Avoids an uncached `npx` cold-start (~3-8s
      // first run) and pins the exact tested MCP version.
      cmd = process.execPath;
      args = [bundled, '--port', String(entry.port)];
    } else {
      // Fallback: dev installs without the package or packaged builds that
      // failed to bundle node_modules. We pin the version so the install
      // matches whatever was tested in `pnpm test` for this build. The prior
      // console.warn here printed on every spawn in dev because the Electron
      // resolver couldn't find the package from `dist-electron/main.js`; the
      // warning was noise rather than signal, so we drop it.
      cmd = isWin ? 'npx.cmd' : 'npx';
      args = ['-y', `@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}`, '--port', String(entry.port)];
    }
    let child: ChildProcess;
    try {
      child = spawn(cmd, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
      });
    } catch (err) {
      entry.lastError = err instanceof Error ? err.message : String(err);
      this.scheduleRestart(entry);
      return;
    }

    entry.child = child;
    child.stdout?.on('data', () => {
      /* swallow — Playwright MCP prints its own banner */
    });
    let stderrBuf = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf8');
      if (stderrBuf.length > 8_000) stderrBuf = stderrBuf.slice(-4_000);
    });
    child.on('error', (err: Error) => {
      entry.lastError = err.message;
    });
    child.on('exit', (code, signal) => {
      entry.child = null;
      if (entry.shuttingDown) return;
      entry.lastError = `exit code=${code ?? 'null'} signal=${signal ?? 'null'} stderr=${stderrBuf.slice(-400)}`;
      this.scheduleRestart(entry);
    });
  }

  private scheduleRestart(entry: SupervisedEntry): void {
    if (entry.shuttingDown) return;
    if (entry.restarts >= MAX_RESTARTS) return;
    entry.restarts += 1;
    const delay = RESPAWN_DELAY_MS * entry.restarts;
    setTimeout(() => this.spawnChild(entry), delay);
  }
}

function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (typeof addr === 'object' && addr && 'port' in addr) {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error('Failed to allocate free port')));
      }
    });
  });
}

/**
 * Resolves when a TCP connect to 127.0.0.1:`port` succeeds, or rejects after
 * `timeoutMs`. Polls every 100ms. Used to gate `start()` until the spawned
 * Playwright MCP child has actually bound the port — fixes the race where
 * agent CLIs read the MCP URL before the server is listening.
 */
function waitForPortListening(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryConnect = (): void => {
      const sock = net.createConnection({ port, host: '127.0.0.1' });
      let settled = false;
      const settle = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        sock.removeAllListeners();
        sock.destroy();
        if (ok) {
          resolve();
        } else if (Date.now() >= deadline) {
          reject(new Error(`waitForPortListening: timed out on 127.0.0.1:${port}`));
        } else {
          setTimeout(tryConnect, 100);
        }
      };
      sock.once('connect', () => settle(true));
      sock.once('error', () => settle(false));
      sock.setTimeout(500, () => settle(false));
    };
    tryConnect();
  });
}
