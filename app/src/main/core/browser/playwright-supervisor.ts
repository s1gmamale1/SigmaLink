// Per-workspace Playwright MCP supervisor.
//
// Lifecycle:
//   1. `start(workspaceId)` is called lazily on first browser open. We pick a
//      free TCP port on 127.0.0.1, spawn `npx @playwright/mcp@latest --port N`
//      via `child_process.spawn`, and store the URL `http://127.0.0.1:N/mcp`.
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
import net from 'node:net';

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

export class PlaywrightMcpSupervisor {
  private readonly entries = new Map<string, SupervisedEntry>();

  /**
   * Idempotently start the MCP server for the given workspace and return its
   * URL once the child is spawned. Repeated calls return the same URL.
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
    const cmd = isWin ? 'npx.cmd' : 'npx';
    const args = ['-y', '@playwright/mcp@latest', '--port', String(entry.port)];
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
