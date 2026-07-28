// Per-workspace SigmaMemory MCP command registry. MCP stdio is point-to-point:
// each configured agent CLI launches and owns its own server process, so an
// Electron-owned copy cannot serve those clients and would sit idle. Entries
// therefore retain only the workspace identity needed to build launch config.
//
// `getCommandFor()` returns the `{command, args, env}` triple the
// `mcp-config-writer.ts` needs so spawned agent CLIs can list us in their
// per-workspace `.mcp.json`.

import path from 'node:path';
import fs from 'node:fs';
import { app } from 'electron';

interface RegisteredEntry {
  workspaceId: string;
  workspaceRoot: string;
}

const SERVER_FILENAME = 'mcp-memory-server.cjs';

export interface MemoryMcpSupervisorOpts {
  /** Override path to the bundled stdio server. Defaults to electron-dist. */
  serverEntry?: string;
  /** Override path to the SQLite db. Defaults to userData/sigmalink.db. */
  dbPath?: string;
}

export class MemoryMcpSupervisor {
  private readonly entries = new Map<string, RegisteredEntry>();
  private readonly opts: Required<MemoryMcpSupervisorOpts>;

  constructor(opts: MemoryMcpSupervisorOpts = {}) {
    this.opts = {
      serverEntry: opts.serverEntry ?? this.defaultServerEntry(),
      dbPath: opts.dbPath ?? path.join(app.getPath('userData'), 'sigmalink.db'),
    };
  }

  /** Register or refresh the workspace used to generate a client launch command. */
  async start(workspaceId: string, workspaceRoot?: string): Promise<void> {
    const existing = this.entries.get(workspaceId);
    if (!workspaceRoot && existing) workspaceRoot = existing.workspaceRoot;
    if (!workspaceRoot) {
      throw new Error('memory MCP supervisor: workspaceRoot required for first start');
    }
    this.entries.set(workspaceId, { workspaceId, workspaceRoot });
  }

  stop(workspaceId: string): void {
    this.entries.delete(workspaceId);
  }

  stopAll(): void {
    this.entries.clear();
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
        ELECTRON_RUN_AS_NODE: '1',
        SIGMALINK_DB_PATH: this.opts.dbPath,
        SIGMALINK_WORKSPACE_ID: workspaceId,
        SIGMALINK_WORKSPACE_ROOT: root,
      },
    };
  }

  hasEntry(workspaceId: string): boolean {
    return this.entries.has(workspaceId);
  }

  private defaultServerEntry(): string {
    // electron-dist sits next to the running main.js in production AND in
    // development (we always pre-build via `npm run electron:compile`).
    const electronDist = path.join(app.getAppPath(), 'electron-dist');
    return path.join(electronDist, SERVER_FILENAME);
  }
}
