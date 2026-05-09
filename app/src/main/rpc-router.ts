// Builds the typed RPC router from main-process controllers and registers
// every channel on ipcMain. Renderer events fan out via BrowserWindow.send.

import path from 'node:path';
import fs from 'node:fs';
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { defineController, defineRouter } from '../shared/rpc';
import type { AppRouter } from '../shared/router-shape';
import { initializeDatabase, closeDatabase } from './core/db/client';
import { runBootJanitor } from './core/db/janitor';
import { PtyRegistry } from './core/pty/registry';
import { probeAllProviders, probeProviderById } from './core/providers/probe';
import { commitAndMerge, gitDiff, gitStatus, runShellLine, worktreeRemove } from './core/git/git-ops';
import { WorktreePool } from './core/git/worktree';
import { listWorkspaces, openWorkspace, removeWorkspace } from './core/workspaces/factory';
import { executeLaunchPlan } from './core/workspaces/launcher';
import { AGENT_PROVIDERS } from '../shared/providers';
import { SwarmMailbox } from './core/swarms/mailbox';
import { buildSwarmController } from './core/swarms/controller';

interface SharedDeps {
  pty: PtyRegistry;
  worktreePool: WorktreePool;
  mailbox: SwarmMailbox;
}

let router: ReturnType<typeof buildRouter> | null = null;
let sharedDeps: SharedDeps | null = null;

function broadcast(event: string, payload: unknown) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(event, payload);
  }
}

function buildRouter() {
  const userData = app.getPath('userData');
  initializeDatabase(userData);

  // Boot janitor: clean up zombie running sessions and prune dead worktrees.
  void runBootJanitor().catch(() => {
    /* non-fatal */
  });

  const worktreePool = new WorktreePool({ baseDir: path.join(userData, 'worktrees') });
  const pty = new PtyRegistry(
    (sessionId, data) => broadcast('pty:data', { sessionId, data }),
    (sessionId, exitCode, signal) => broadcast('pty:exit', { sessionId, exitCode, signal }),
  );
  const mailbox = new SwarmMailbox(userData);
  mailbox.setEmitter((message) => {
    broadcast('swarm:message', {
      swarmId: message.swarmId,
      from: message.fromAgent,
      to: message.toAgent,
      body: message.body,
      ts: message.ts,
      kind: message.kind,
      id: message.id,
      payload: message.payload,
    });
  });
  sharedDeps = { pty, worktreePool, mailbox };

  const appCtl = defineController({
    getVersion: async () => app.getVersion(),
    getPlatform: async () => process.platform as NodeJS.Platform,
  });

  const ptyCtl = defineController({
    create: async (input: {
      providerId: string;
      cwd: string;
      cols: number;
      rows: number;
      args?: string[];
      env?: Record<string, string>;
      initialPrompt?: string;
    }) => {
      const providerId = input.providerId;
      const definition = AGENT_PROVIDERS.find((p) => p.id === providerId);
      const command = definition?.command ?? '';
      const args = input.args ?? definition?.args ?? [];
      const rec = pty.create({
        providerId,
        command,
        args,
        cwd: input.cwd,
        env: input.env as NodeJS.ProcessEnv | undefined,
        cols: input.cols,
        rows: input.rows,
      });
      // Note: typing the initial prompt is the launcher's responsibility (see
      // `core/workspaces/launcher.ts`) so callers using executeLaunchPlan do
      // not double-send. When this controller is invoked directly (no current
      // production caller) the initial prompt is still typed here once.
      if (input.initialPrompt) {
        setTimeout(() => {
          try {
            pty.write(rec.id, input.initialPrompt + '\n');
          } catch {
            /* ignore */
          }
        }, 500);
      }
      return { sessionId: rec.id, pid: rec.pid };
    },
    write: async (sessionId: string, data: string) => {
      pty.write(sessionId, data);
    },
    resize: async (sessionId: string, cols: number, rows: number) => {
      pty.resize(sessionId, cols, rows);
    },
    kill: async (sessionId: string) => {
      pty.kill(sessionId);
    },
    subscribe: async (sessionId: string) => {
      return { history: pty.snapshot(sessionId) };
    },
    list: async () =>
      pty.list().map((s) => ({
        sessionId: s.id,
        providerId: s.providerId,
        cwd: s.cwd,
        alive: s.alive,
      })),
    forget: async (sessionId: string) => {
      pty.forget(sessionId);
    },
  });

  const providersCtl = defineController({
    list: async () =>
      AGENT_PROVIDERS.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        color: p.color,
        icon: p.icon,
        installHint: p.installHint,
      })),
    probeAll: async () => probeAllProviders(),
    probe: async (id: string) => probeProviderById(id),
  });

  const workspacesCtl = defineController({
    pickFolder: async () => {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      const opts: Electron.OpenDialogOptions = { properties: ['openDirectory', 'createDirectory'] };
      const r = win
        ? await dialog.showOpenDialog(win, opts)
        : await dialog.showOpenDialog(opts);
      if (r.canceled || !r.filePaths[0]) return null;
      return { path: r.filePaths[0] };
    },
    open: async (root: string) => openWorkspace(root),
    list: async () => listWorkspaces(),
    remove: async (id: string) => removeWorkspace(id),
    launch: async (plan) => {
      const out = await executeLaunchPlan(plan, { pty, worktreePool });
      return { sessions: out.sessions };
    },
  });

  const gitCtl = defineController({
    status: async (cwd: string) => gitStatus(cwd),
    diff: async (cwd: string) => gitDiff(cwd),
    runCommand: async (cwd: string, line: string, timeoutMs?: number) =>
      runShellLine(cwd, line, timeoutMs),
    commitAndMerge: async (input: {
      worktreePath: string;
      branch: string;
      repoRoot: string;
      message: string;
    }) => commitAndMerge(input),
    worktreeRemove: async (worktreePath: string) => {
      // Find the repoRoot that owns this worktree by walking up.
      // For Phase 1 we accept the worktreePath and trust the caller knows
      // its repoRoot; we resolve via `git rev-parse --show-toplevel`.
      const root = await (async () => {
        try {
          const res = await runShellLine(worktreePath, 'git rev-parse --show-toplevel', 5_000);
          return res.code === 0 ? res.stdout.trim() : null;
        } catch {
          return null;
        }
      })();
      if (!root) return;
      await worktreeRemove(root, worktreePath);
    },
  });

  const fsCtl = defineController({
    exists: async (p: string) => fs.existsSync(p),
  });

  const swarmsCtl = buildSwarmController({
    pty,
    worktreePool,
    mailbox,
    userDataDir: userData,
  });

  return defineRouter({
    app: appCtl,
    pty: ptyCtl,
    providers: providersCtl,
    workspaces: workspacesCtl,
    git: gitCtl,
    fs: fsCtl,
    swarms: swarmsCtl,
  });
}

export function registerRouter(): void {
  if (router) return;
  router = buildRouter();
  const isDev = !app.isPackaged;
  for (const [ns, handlers] of Object.entries(router)) {
    for (const [key, fn] of Object.entries(handlers)) {
      const channel = `${ns}.${key}`;
      ipcMain.handle(channel, async (_e, ...args) => {
        try {
          const out = await (fn as (...a: unknown[]) => unknown)(...args);
          return { ok: true, data: out };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          // Include stack in dev for easier debugging, omit in production to
          // avoid leaking implementation details across IPC.
          const stack = isDev && err instanceof Error ? err.stack : undefined;
          return { ok: false, error: message, stack };
        }
      });
    }
  }
}

/**
 * Best-effort cleanup hooks for the Electron main bootstrap. Killing live
 * PTYs, closing the DB, and flushing WAL keeps quits graceful and prevents
 * orphan worktrees / zombie session rows after a normal shutdown.
 */
export function shutdownRouter(): void {
  try {
    sharedDeps?.pty.killAll();
  } catch {
    /* ignore */
  }
  try {
    closeDatabase();
  } catch {
    /* ignore */
  }
  router = null;
  sharedDeps = null;
}

export type RegisteredRouter = AppRouter;
