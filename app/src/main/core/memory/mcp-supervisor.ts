// Per-workspace SigmaMemory MCP supervisor. Each entry tracks one Node child
// process running `electron-dist/mcp-memory-server.cjs`. The child shares the
// app's SQLite db file and the workspace's `<root>/.sigmamemory/` hub dir,
// which means GUI changes are immediately visible to MCP clients (and vice
// versa) — better-sqlite3 in WAL mode handles cross-process reads + a
// single writer at a time, and our writes are short transactions.
//
// Lifecycle mirrors `playwright-supervisor.ts`:
//   • restart up to 3x with linear backoff
//   • SIGTERM on stop / shutdown
//   • emits no IPC events; the GUI rescans on focus / `memory:changed`
//
// `getCommandFor()` returns the `{command, args, env}` triple the
// `mcp-config-writer.ts` needs so spawned agent CLIs can list us in their
// per-workspace `.mcp.json`.

import path from 'node:path';
import fs from 'node:fs';
import { app } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';

interface SupervisedEntry {
  workspaceId: string;
  workspaceRoot: string;
  child: ChildProcess | null;
  restarts: number;
  lastError: string | null;
  shuttingDown: boolean;
}

const MAX_RESTARTS = 3;
const RESPAWN_DELAY_MS = 1500;
const SERVER_FILENAME = 'mcp-memory-server.cjs';

export interface MemoryMcpSupervisorOpts {
  /** Override path to the bundled stdio server. Defaults to electron-dist. */
  serverEntry?: string;
  /** Override path to the SQLite db. Defaults to userData/sigmalink.db. */
  dbPath?: string;
}

export class MemoryMcpSupervisor {
  private readonly entries = new Map<string, SupervisedEntry>();
  private readonly opts: Required<MemoryMcpSupervisorOpts>;

  constructor(opts: MemoryMcpSupervisorOpts = {}) {
    this.opts = {
      serverEntry: opts.serverEntry ?? this.defaultServerEntry(),
      dbPath: opts.dbPath ?? path.join(app.getPath('userData'), 'sigmalink.db'),
    };
  }

  /**
   * Idempotent: returns the existing child for the workspace if it is still
   * alive, otherwise spawns one. The promise resolves once the child has been
   * spawned (does NOT wait for the JSON-RPC `initialize` round-trip — agents
   * issue that themselves on first use).
   */
  async start(workspaceId: string, workspaceRoot?: string): Promise<void> {
    const existing = this.entries.get(workspaceId);
    if (existing && existing.child && !existing.child.killed) return;
    if (!workspaceRoot && existing) workspaceRoot = existing.workspaceRoot;
    if (!workspaceRoot) {
      throw new Error('memory MCP supervisor: workspaceRoot required for first start');
    }
    const entry: SupervisedEntry = existing ?? {
      workspaceId,
      workspaceRoot,
      child: null,
      restarts: 0,
      lastError: null,
      shuttingDown: false,
    };
    if (workspaceRoot) entry.workspaceRoot = workspaceRoot;
    this.entries.set(workspaceId, entry);
    this.spawnChild(entry);
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

  /**
   * The command the per-provider MCP config writer should reference so that
   * any spawned agent CLI launches its OWN copy of the stdio server pointing
   * at the same workspace. We do not share the Electron-side child with
   * external CLIs because MCP stdio is point-to-point — instead each client
   * gets its own short-lived child, all reading the shared SQLite DB.
   */
  getCommandFor(workspaceId: string): { command: string; args: string[]; env: Record<string, string> } | null {
    const e = this.entries.get(workspaceId);
    const root = e?.workspaceRoot;
    if (!root) return null;
    if (!fs.existsSync(this.opts.serverEntry)) {
      return null;
    }
    return {
      command: process.execPath, // node from the bundled Electron — works for `node` MCP transport
      args: [this.opts.serverEntry],
      env: {
        SIGMALINK_DB_PATH: this.opts.dbPath,
        SIGMALINK_WORKSPACE_ID: workspaceId,
        SIGMALINK_WORKSPACE_ROOT: root,
      },
    };
  }

  hasEntry(workspaceId: string): boolean {
    return this.entries.has(workspaceId);
  }

  private spawnChild(entry: SupervisedEntry): void {
    if (entry.shuttingDown) return;
    if (!fs.existsSync(this.opts.serverEntry)) {
      // Treat absent server as a non-fatal warning — the GUI still works,
      // CLI agents simply won't see the tools until the next packaged build.
      entry.lastError = `mcp-memory-server.cjs missing at ${this.opts.serverEntry}`;
      return;
    }
    let child: ChildProcess;
    try {
      child = spawn(process.execPath, [this.opts.serverEntry], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1', // run Electron's bundled node, not Electron itself
          SIGMALINK_DB_PATH: this.opts.dbPath,
          SIGMALINK_WORKSPACE_ID: entry.workspaceId,
          SIGMALINK_WORKSPACE_ROOT: entry.workspaceRoot,
        },
      });
    } catch (err) {
      entry.lastError = err instanceof Error ? err.message : String(err);
      this.scheduleRestart(entry);
      return;
    }
    entry.child = child;
    let stderrBuf = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf8');
      if (stderrBuf.length > 8000) stderrBuf = stderrBuf.slice(-4000);
    });
    child.stdout?.on('data', () => {
      // We don't currently subscribe to the supervisor's child's responses —
      // the GUI talks directly to MemoryManager via RPC. The child only
      // serves spawned agent CLIs that pipe to our stdin/stdout in their own
      // child process. Drain to avoid backpressure.
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

  private defaultServerEntry(): string {
    // electron-dist sits next to the running main.js in production AND in
    // development (we always pre-build via `npm run electron:compile`).
    const electronDist = path.join(app.getAppPath(), 'electron-dist');
    return path.join(electronDist, SERVER_FILENAME);
  }
}
