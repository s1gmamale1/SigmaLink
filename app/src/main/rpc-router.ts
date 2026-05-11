// Builds the typed RPC router from main-process controllers and registers
// every channel on ipcMain. Renderer events fan out via BrowserWindow.send.

import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { defineController, defineRouter } from '../shared/rpc';
import type { AppRouter } from '../shared/router-shape';
import { initializeDatabase, closeDatabase, getRawDb } from './core/db/client';
import { runBootJanitor } from './core/db/janitor';
import { PtyRegistry } from './core/pty/registry';
import { probeAllProviders, probeProviderById } from './core/providers/probe';
import { commitAndMerge, gitDiff, gitStatus, runShellLine, worktreeRemove } from './core/git/git-ops';
import { WorktreePool } from './core/git/worktree';
import { listWorkspaces, openWorkspace, removeWorkspace } from './core/workspaces/factory';
import { executeLaunchPlan } from './core/workspaces/launcher';
import { AGENT_PROVIDERS } from '../shared/providers';
import { SwarmMailbox } from './core/swarms/mailbox';
import { BoardManager } from './core/swarms/boards';
import { buildSwarmController } from './core/swarms/controller';
import { buildConsoleController } from './core/swarms/console-controller';
import { ReplayManager } from './core/swarms/replay';
import { and, eq } from 'drizzle-orm';
import { swarmAgents } from './core/db/schema';
import { getDb } from './core/db/client';
import { BrowserManagerRegistry } from './core/browser/manager';
import { buildBrowserController } from './core/browser/controller';
import { PlaywrightMcpSupervisor } from './core/browser/playwright-supervisor';
import { SkillsManager } from './core/skills/manager';
import { buildSkillsController, defaultMarketplaceTempDir } from './core/skills/controller';
import { MemoryManager } from './core/memory/manager';
import { MemoryMcpSupervisor } from './core/memory/mcp-supervisor';
import { buildMemoryController } from './core/memory/controller';
import { ReviewRunner } from './core/review/runner';
import { buildReviewController } from './core/review/controller';
import { TasksManager } from './core/tasks/manager';
import { buildTasksController } from './core/tasks/controller';
import { buildKvController } from './core/db/kv-controller';
import { buildAssistantController } from './core/assistant/controller';
import { McpHostBridge, type ToolInvoker } from './core/assistant/mcp-host-bridge';
import {
  buildConversationsHandlers,
  buildSwarmOriginHandlers,
} from './core/assistant/conversations-controller';
import { buildDesignController } from './core/design/controller';
import { buildVoiceController } from './core/voice/adapter';
import { runVoiceDiagnostics } from './core/voice/diagnostics';
import { fsReadDir, fsReadFile, fsWriteFile } from './core/fs/controller';
import { getChannelSchema } from './core/rpc/schemas';
// Phase 4 Track C — Ruflo MCP embed. Process-singleton supervisor + lazy
// installer + JSON-RPC proxy fronting the renderer-facing controller.
import { RufloMcpSupervisor } from './core/ruflo/supervisor';
import { RufloProxy } from './core/ruflo/proxy';
import { RufloInstaller } from './core/ruflo/installer';
import { buildRufloController } from './core/ruflo/controller';
// V3-W14-008 — auto-update integration. The actual `electron-updater` calls
// live in `electron/auto-update.ts`; this controller exposes a single RPC
// method so the renderer can trigger a manual check, and reads the last-
// check timestamp via `kv.get('updates.lastCheckTimestamp')`.
import { checkForUpdates as checkForUpdatesImpl } from '../../electron/auto-update';
// V3-W15-005 — plan tier resolved from kv['plan.tier'] with a SigmaLink-default
// of 'ultra'. The capability matrix lives next to this import; the renderer
// reads through `app.tier()` rather than touching kv directly.
import { KV_PLAN_TIER, parseTier } from './core/plan/capabilities';

interface SharedDeps {
  pty: PtyRegistry;
  worktreePool: WorktreePool;
  mailbox: SwarmMailbox;
  browserRegistry: BrowserManagerRegistry;
  playwrightSupervisor: PlaywrightMcpSupervisor;
  skills: SkillsManager;
  memory: MemoryManager;
  memorySupervisor: MemoryMcpSupervisor;
  reviewRunner: ReviewRunner;
  tasks: TasksManager;
  /** Phase 4 Track C — process-singleton Ruflo supervisor. Stop in the
   *  shutdown path next to memorySupervisor.stopAll(). */
  rufloSupervisor: RufloMcpSupervisor;
  /** V3-W12-014 — Operator Console controller. Registered side-band so the
   *  `swarm.*` namespace doesn't pollute the typed AppRouter shape. */
  consoleStop?: () => void;
  /** BUG-V1.1.2-01 — Sigma Assistant MCP host bridge. Listens on a Unix
   *  socket (Windows named pipe); each Claude CLI turn writes a temp
   *  `.mcp.json` declaring the stdio server, which dials back here and
   *  proxies `tools/call` envelopes into the assistant controller. */
  mcpHostBridge?: McpHostBridge;
}

let router: ReturnType<typeof buildRouter> | null = null;
let sharedDeps: SharedDeps | null = null;
/** Side-band controller handlers registered outside `defineRouter` so
 *  foundations can grow the AppRouter shape independently. */
let consoleHandlers: Record<string, (...args: unknown[]) => unknown> | null = null;
/** P3-S6 — Persistent Swarm Replay handlers. Registered side-band under the
 *  `swarm.replay.<method>` namespace via the same allowlist gate. */
let replayHandlers: Record<string, (...args: unknown[]) => unknown> | null = null;
/** P3-S7 — Bridge Assistant cross-session persistence. Two side-band
 *  handler maps: `assistant.conversations.<method>` powers the
 *  Conversations panel inside BridgeRoom; `swarm.origin.<method>` resolves
 *  the back-link from a swarm to the chat-turn that created it for the
 *  Operator Console. Same envelope contract as the console + replay
 *  side-bands above. */
let conversationsHandlers: Record<string, (...args: unknown[]) => unknown> | null = null;
let swarmOriginHandlers: Record<string, (...args: unknown[]) => unknown> | null = null;
/** V3-W14-001..006 — Bridge Canvas controller cleanup hook. Called from
 *  `shutdownRouter` so picker overlays + dev-server watchers tear down. */
let designShutdown: (() => void) | null = null;

const requireCJS = createRequire(import.meta.url);

function broadcast(event: string, payload: unknown) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(event, payload);
  }
}

function capitalize(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
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
    {
      // V3-W13-002 — surface OSC8 + plain URLs to the renderer so the click
      // handler can route them into the in-app browser. The renderer-side
      // gate (`kv['browser.captureLinks']`) decides whether to intercept.
      onLinkDetected: (sessionId, hit) =>
        broadcast('pty:link-detected', {
          sessionId,
          url: hit.url,
          text: hit.text,
        }),
    },
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
  // V3-W13-008 — board namespace persistence. The mailbox calls into the
  // BoardManager whenever a `board_post` envelope lands so the DB row + on-
  // disk markdown file stay in sync.
  const boardManager = new BoardManager(userData);
  mailbox.setBoardManager(boardManager);
  // V3-W13-009 — Operator → agent DM pane echo. Resolves agentKey →
  // sessionId via swarm_agents and writes a formatted line into PTY stdin.
  // BUG-V1.1-02-IPC: scope the lookup to the originating `swarmId`. Without
  // it, two concurrent swarms each rostering a `coordinator-1` would race and
  // pick whichever row sorted first, leaking Operator directives across
  // swarms. The `swarmId` argument now drives the WHERE clause; an empty
  // result is logged so a misrouted directive surfaces in dev rather than
  // silently dropping.
  mailbox.setPaneEcho((swarmId, toAgent, body) => {
    if (!toAgent || toAgent === '*' || toAgent === '@all') return;
    const db = getDb();
    const row = db
      .select({
        sessionId: swarmAgents.sessionId,
        role: swarmAgents.role,
        roleIndex: swarmAgents.roleIndex,
      })
      .from(swarmAgents)
      .where(
        and(
          eq(swarmAgents.swarmId, swarmId),
          eq(swarmAgents.agentKey, toAgent),
        ),
      )
      .all()
      .find((r) => r.sessionId);
    if (!row || !row.sessionId) {
      console.warn(
        `[paneEcho] no live session for swarm=${swarmId} agent=${toAgent}; directive not echoed`,
      );
      return;
    }
    const role = capitalize(row.role);
    const line = `[Operator → ${role} ${row.roleIndex}] ${body}\n`;
    try {
      pty.write(row.sessionId, line);
    } catch {
      /* PTY may have exited */
    }
  });
  const playwrightSupervisor = new PlaywrightMcpSupervisor();
  const browserRegistry = new BrowserManagerRegistry({
    windowProvider: () => {
      // Prefer the focused window; fall back to the first non-destroyed one.
      const focused = BrowserWindow.getFocusedWindow();
      if (focused && !focused.isDestroyed()) return focused;
      const all = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
      return all[0] ?? null;
    },
    supervisor: playwrightSupervisor,
    onState: (state) => broadcast('browser:state', state),
  });
  const skillsManager = new SkillsManager({
    userData,
    emit: (event, payload) => broadcast(event, payload),
  });
  const memorySupervisor = new MemoryMcpSupervisor();

  // BUG-V1.1.2-01 — Sigma Assistant MCP host bridge. Constructed early so we
  // can pass its `socketPath` into the assistant controller before the bridge
  // actually listens; the controller only reads the path when a turn runs,
  // by which point `start()` below has completed. The invoker is resolved
  // lazily because the assistant controller is built later in this boot
  // sequence.
  let resolvedToolInvoker: ToolInvoker | null = null;
  const mcpHostBridge = new McpHostBridge({
    resolveInvoker: () => resolvedToolInvoker,
  });
  const sigmaHostServerEntry = path.join(
    app.getAppPath(),
    'electron-dist',
    'mcp-sigma-host-server.cjs',
  );
  const memoryManager = new MemoryManager({
    emit: (event) => broadcast('memory:changed', event),
    resolveMcpCommand: (workspaceId) => {
      const cmd = memorySupervisor.getCommandFor(workspaceId);
      return cmd ? { command: cmd.command, args: cmd.args } : null;
    },
  });
  const reviewRunner = new ReviewRunner((event) => {
    broadcast('review:run-output', event);
  });
  const tasksManager = new TasksManager({
    emit: (taskId) => broadcast('tasks:changed', { taskId }),
  });
  // Phase 4 Track C — Ruflo MCP supervisor + installer + proxy. The
  // supervisor is process-singleton (one child per app, not per workspace).
  // It boots in `down`/`absent` and only spins up the child when the user
  // opts in via Settings → Ruflo. Health transitions broadcast on
  // `ruflo:health`; install progress on `ruflo:install-progress`.
  const rufloSupervisor = new RufloMcpSupervisor();
  rufloSupervisor.on('health', (h) => broadcast('ruflo:health', h));
  const rufloProxy = new RufloProxy(rufloSupervisor);
  const rufloInstaller = new RufloInstaller();
  rufloInstaller.on('progress', (p) => broadcast('ruflo:install-progress', p));

  sharedDeps = {
    pty,
    worktreePool,
    mailbox,
    browserRegistry,
    playwrightSupervisor,
    skills: skillsManager,
    memory: memoryManager,
    memorySupervisor,
    reviewRunner,
    tasks: tasksManager,
    rufloSupervisor,
    mcpHostBridge,
  };

  const appCtl = defineController({
    getVersion: async () => app.getVersion(),
    getPlatform: async () => process.platform as NodeJS.Platform,
    diagnostics: async () => {
      const required = ['better-sqlite3', 'node-pty'];
      const nativeModules = required.map((mod) => {
        try {
          requireCJS(mod);
          return { module: mod, ok: true as const };
        } catch (err) {
          return {
            module: mod,
            ok: false as const,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      });
      return {
        nativeModules,
        env: {
          electron: process.versions.electron ?? null,
          node: process.versions.node,
          chrome: process.versions.chrome ?? null,
          platform: process.platform,
          arch: process.arch,
          userData: app.getPath('userData'),
        },
      };
    },
    // V3-W14-008 — manual update check. Renderer triggers from Settings →
    // Updates. We never throw on "no update" — the result envelope carries an
    // optional version + error string and the UI renders accordingly.
    checkForUpdates: async () => checkForUpdatesImpl(),
    // V3-W15-005 — Plan tier read. Default `'ultra'` since SigmaLink is local-
    // only / free; the override is only writable from a hidden dev-mode control
    // in Settings → Appearance, so production users always see Ultra.
    tier: async () => {
      const row = getRawDb()
        .prepare('SELECT value FROM kv WHERE key = ?')
        .get(KV_PLAN_TIER) as { value?: string } | undefined;
      return parseTier(row?.value ?? null);
    },
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
      // BUG-W7-010: Playwright cannot drive Electron's native folder picker.
      // When `process.env.SIGMA_TEST` is set, skip the dialog and return a
      // deterministic path stored in kv under `tests.fakePickerPath`. If no
      // fake path is configured we fail loudly so tests can't silently fall
      // back to the unscriptable native dialog.
      if (process.env.SIGMA_TEST) {
        const row = getRawDb()
          .prepare('SELECT value FROM kv WHERE key = ?')
          .get('tests.fakePickerPath') as { value?: string } | undefined;
        const fakePath = row?.value;
        if (!fakePath) {
          throw new Error(
            'workspaces.pickFolder: SIGMA_TEST is set but no fake path configured. ' +
              "Set kv['tests.fakePickerPath'] before invoking the picker.",
          );
        }
        return { path: fakePath };
      }
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
    // V3-W14-007 — Editor tab. The controller bodies live in core/fs/controller.ts
    // so they can be unit-tested without spinning up the whole router.
    readDir: async (input: { path: string }) => fsReadDir(input),
    readFile: async (input: { path: string; maxBytes?: number }) => fsReadFile(input),
    writeFile: async (input: { path: string; content: string; repoRoot: string }) =>
      fsWriteFile(input),
  });

  const swarmsCtl = buildSwarmController({
    pty,
    worktreePool,
    mailbox,
    userDataDir: userData,
  });

  // V3-W12-014 — Operator Console controller. Lives outside `defineRouter`
  // so foundations can extend the AppRouter shape without merge conflicts.
  // Channels register under the `swarm.<method>` namespace; events
  // (`swarm:counters`, `swarm:ledger`) broadcast on a 1s interval.
  const consoleCtl = buildConsoleController({
    pty,
    emitCounters: (c) => broadcast('swarm:counters', c),
    emitLedger: (l) => broadcast('swarm:ledger', l),
  });
  consoleHandlers = consoleCtl.handlers as Record<
    string,
    (...args: unknown[]) => unknown
  >;
  // Start the 1s broadcast loop; matching stop runs in shutdownRouter.
  consoleCtl.start();
  sharedDeps.consoleStop = consoleCtl.stop;

  // P3-S6 — Persistent Swarm Replay. The mailbox is event-sourced; this
  // manager harvests `swarm_messages` rows into scrubbable frames + persists
  // labelled bookmarks. Side-band registration mirrors the console pattern so
  // the typed AppRouter shape stays optional.
  const replayManager = new ReplayManager();
  replayHandlers = {
    list: async (input: unknown) => {
      const arg = (input as { workspaceId?: string }) ?? {};
      if (typeof arg.workspaceId !== 'string' || !arg.workspaceId) {
        throw new Error('swarm.replay.list: workspaceId required');
      }
      return replayManager.list(arg.workspaceId);
    },
    scrub: async (input: unknown) => {
      const arg = (input as { swarmId?: string; frameIdx?: number }) ?? {};
      if (typeof arg.swarmId !== 'string' || !arg.swarmId) {
        throw new Error('swarm.replay.scrub: swarmId required');
      }
      if (typeof arg.frameIdx !== 'number' || !Number.isFinite(arg.frameIdx)) {
        throw new Error('swarm.replay.scrub: frameIdx must be a finite number');
      }
      const frame = await replayManager.scrub(arg.swarmId, arg.frameIdx);
      // Broadcast for any sibling inspector listening on the active swarm.
      try {
        broadcast('swarm:replay-frame', {
          swarmId: frame.swarmId,
          frameIdx: frame.frameIdx,
          totalFrames: frame.totalFrames,
        });
      } catch {
        /* fire-and-forget */
      }
      return frame;
    },
    bookmark: async (input: unknown) => {
      const arg =
        (input as { swarmId?: string; frameIdx?: number; label?: string }) ?? {};
      if (typeof arg.swarmId !== 'string' || !arg.swarmId) {
        throw new Error('swarm.replay.bookmark: swarmId required');
      }
      if (typeof arg.frameIdx !== 'number' || !Number.isFinite(arg.frameIdx)) {
        throw new Error(
          'swarm.replay.bookmark: frameIdx must be a finite number',
        );
      }
      return replayManager.bookmark(arg.swarmId, arg.frameIdx, arg.label ?? '');
    },
    listBookmarks: async (input: unknown) => {
      const arg = (input as { swarmId?: string }) ?? {};
      if (typeof arg.swarmId !== 'string' || !arg.swarmId) {
        throw new Error('swarm.replay.listBookmarks: swarmId required');
      }
      return replayManager.listBookmarks(arg.swarmId);
    },
    deleteBookmark: async (input: unknown) => {
      const arg = (input as { snapshotId?: string }) ?? {};
      if (typeof arg.snapshotId !== 'string' || !arg.snapshotId) {
        throw new Error('swarm.replay.deleteBookmark: snapshotId required');
      }
      await replayManager.deleteBookmark(arg.snapshotId);
    },
  };

  const browserCtl = buildBrowserController({ registry: browserRegistry });
  const skillsCtl = buildSkillsController({
    manager: skillsManager,
    marketplaceTempDir: defaultMarketplaceTempDir(userData),
    emit: (event, payload) => broadcast(event, payload),
  });
  const memoryCtl = buildMemoryController({
    manager: memoryManager,
    supervisor: memorySupervisor,
  });
  const reviewCtl = buildReviewController({
    worktreePool,
    runner: reviewRunner,
    onChanged: (sessionId) => broadcast('review:changed', { sessionId }),
  });
  const tasksCtl = buildTasksController({
    manager: tasksManager,
    mailbox,
  });
  const kvCtl = buildKvController();
  // V3-W13-013 — Bridge Assistant controller. Owns the `assistant.*`
  // namespace and pipes tool traces + dispatch echoes back through the
  // shared broadcaster so every BrowserWindow (right-rail, standalone room)
  // sees the same stream.
  const assistantBundle = buildAssistantController({
    pty,
    worktreePool,
    mailbox,
    memory: memoryManager,
    tasks: tasksManager,
    browserRegistry,
    userDataDir: userData,
    emit: (event, payload) => broadcast(event, payload),
    ruflo: rufloProxy,
    mcpHost: {
      serverEntry: sigmaHostServerEntry,
      socketPath: mcpHostBridge.getSocketPath(),
    },
  });
  const assistantCtl = assistantBundle.controller;
  // BUG-V1.1.2-01 — Late-bind the bridge's tool invoker now that the
  // controller has been constructed. The bridge already listens (or will
  // start listening below); any incoming `tools.invoke` calls that race
  // ahead receive `invoker not wired` and the CLI retries on the next
  // turn — but in practice the CLI doesn't dial in until a user prompt
  // lands, by which point the bridge + invoker are fully wired.
  resolvedToolInvoker = assistantBundle.invokeTool;
  // Start listening; failure here is non-fatal because the controller's
  // direct tool dispatch path still works (the CLI just won't see any
  // Sigma tools registered, exactly like v1.1.1 behaviour).
  void mcpHostBridge.start().catch((err) => {
    console.warn(
      `[mcp-host-bridge] failed to start: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
  // P3-S7 — Side-band handlers for the Conversations panel + Operator
  // Console origin link. Mirrors the swarm.replay registration pattern
  // below so the typed AppRouter shape stays flat.
  conversationsHandlers = buildConversationsHandlers() as Record<
    string,
    (...args: unknown[]) => unknown
  >;
  swarmOriginHandlers = buildSwarmOriginHandlers() as Record<
    string,
    (...args: unknown[]) => unknown
  >;
  // V3-W14-001..006 — Bridge Canvas controller. Owns the `design.*` namespace
  // (element-picker overlay, asset staging, HMR poke, canvas DAO + dispatch
  // fan-out). Holds onto its own picker runtime + watch registry so the
  // shutdown path can tear them down deterministically.
  const designCtl = buildDesignController({
    browserRegistry,
    pty,
    worktreePool,
    userDataDir: userData,
    emit: (event, payload) => broadcast(event, payload),
  });
  designShutdown = (designCtl as unknown as { shutdown: () => void }).shutdown;
  // V3-W15-001 / V1.1 — BridgeVoice. Renderer drives Web Speech capture on
  // Win/Linux; macOS uses the native SFSpeechRecognizer pipeline when
  // `@sigmalink/voice-mac` loads. The dispatcher hooks below let the voice
  // controller route final transcripts directly into swarm + assistant
  // controllers without bouncing through the renderer. Active workspace +
  // swarm hints are read from kv (`voice.activeWorkspaceId`,
  // `voice.activeSwarmId`) so the renderer can pin context per surface
  // without keeping a stateful adapter pointer in main.
  const voiceCtl = buildVoiceController({
    emit: (event, payload) => broadcast(event, payload),
    // V1.1.1 — kv hooks let the controller bootstrap routing mode from
    // persisted state and run the macOS first-launch auto-enable. Both
    // statements are wrapped in try/catch on the controller side so a
    // missing kv table (cold migration) never blocks voice startup.
    kv: {
      get: (key) => {
        try {
          const row = getRawDb()
            .prepare('SELECT value FROM kv WHERE key = ?')
            .get(key) as { value?: string } | undefined;
          return row?.value ?? null;
        } catch {
          return null;
        }
      },
      set: (key, value) => {
        try {
          getRawDb()
            .prepare(
              `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, unixepoch() * 1000)
               ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
            )
            .run(key, value);
        } catch {
          /* swallow */
        }
      },
    },
    dispatcher: {
      resolveWorkspaceId: () => {
        try {
          const row = getRawDb()
            .prepare('SELECT value FROM kv WHERE key = ?')
            .get('voice.activeWorkspaceId') as { value?: string } | undefined;
          return row?.value ?? null;
        } catch {
          return null;
        }
      },
      resolveSwarmId: () => {
        try {
          const row = getRawDb()
            .prepare('SELECT value FROM kv WHERE key = ?')
            .get('voice.activeSwarmId') as { value?: string } | undefined;
          return row?.value ?? null;
        } catch {
          return null;
        }
      },
      controllers: {
        // swarmCreate requires the full CreateSwarmInput shape — left
        // unwired in v1.1 until the dispatcher carries enough context to
        // build a valid plan. Falls through to `notRouted`.
        swarmBroadcast: async ({ swarmId, body }) => {
          await (swarmsCtl as { broadcast: (s: string, b: string) => Promise<unknown> })
            .broadcast(swarmId, body);
        },
        swarmRollCall: async ({ swarmId }) => {
          await (swarmsCtl as { rollCall: (s: string) => Promise<unknown> })
            .rollCall(swarmId);
        },
        assistantSend: async ({ workspaceId, prompt }) => {
          await (assistantCtl as {
            send: (i: { workspaceId: string; prompt: string }) => Promise<unknown>;
          }).send({ workspaceId, prompt });
        },
        appNavigate: ({ pane }) => {
          // Forward to renderer subscribers; the title-bar router handles
          // the actual route change.
          broadcast('app:navigate', { pane });
        },
      },
    },
  });

  // Phase 4 Track C — Ruflo controller. Channels: ruflo.health,
  // ruflo.embeddings.search, ruflo.embeddings.generate, ruflo.patterns.search,
  // ruflo.patterns.store, ruflo.autopilot.predict, ruflo.install.start.
  const rufloCtl = buildRufloController({
    supervisor: rufloSupervisor,
    proxy: rufloProxy,
    installer: rufloInstaller,
  });

  return defineRouter({
    app: appCtl,
    pty: ptyCtl,
    providers: providersCtl,
    workspaces: workspacesCtl,
    git: gitCtl,
    fs: fsCtl,
    swarms: swarmsCtl,
    browser: browserCtl,
    skills: skillsCtl,
    memory: memoryCtl,
    review: reviewCtl,
    tasks: tasksCtl,
    kv: kvCtl,
    assistant: assistantCtl,
    design: designCtl,
    voice: voiceCtl,
    ruflo: rufloCtl,
  });
}

export function registerRouter(): void {
  if (router) return;
  router = buildRouter();
  const isDev = !app.isPackaged;
  // V3-W12-017 — soft-launch per-channel zod validation. In dev, warn once
  // for every controller method that lacks a schema entry so future waves can
  // hunt down the gaps; production stays silent. Enforcement (reject on
  // validation failure) is V3-W13's responsibility — do NOT flip on here.
  const missingSchemas: string[] = [];
  for (const [ns, handlers] of Object.entries(router)) {
    for (const key of Object.keys(handlers)) {
      const channel = `${ns}.${key}`;
      if (!getChannelSchema(channel)) missingSchemas.push(channel);
    }
  }
  if (
    isDev &&
    missingSchemas.length > 0 &&
    process.env.NODE_ENV !== 'production'
  ) {
    console.warn(
      `[rpc-router] ${missingSchemas.length} channel(s) have no zod schema entry in core/rpc/schemas.ts:\n  - ${missingSchemas.join('\n  - ')}`,
    );
  }
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

  // V3-W12-014 — Register Operator Console side-band handlers under the
  // `swarm.<method>` namespace. These channels are NOT in the typed AppRouter
  // shape; foundations adds them to the rpc-channels.ts allowlist. Until
  // then, the preload still gates access via `isAllowedChannel` so unlisted
  // channels reject before reaching ipcMain.
  if (consoleHandlers) {
    for (const [key, fn] of Object.entries(consoleHandlers)) {
      const channel = `swarm.${key}`;
      ipcMain.handle(channel, async (_e, ...args) => {
        try {
          const out = await (fn as (...a: unknown[]) => unknown)(...args);
          return { ok: true, data: out };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const stack = isDev && err instanceof Error ? err.stack : undefined;
          return { ok: false, error: message, stack };
        }
      });
    }
  }

  // P3-S6 — Persistent Swarm Replay handlers. Same envelope contract as the
  // console side-band; the channel ids land under `swarm.replay.<method>` so
  // the renderer's `swarm.replay.list` invocation routes here.
  if (replayHandlers) {
    for (const [key, fn] of Object.entries(replayHandlers)) {
      const channel = `swarm.replay.${key}`;
      ipcMain.handle(channel, async (_e, ...args) => {
        try {
          const out = await (fn as (...a: unknown[]) => unknown)(...args);
          return { ok: true, data: out };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const stack = isDev && err instanceof Error ? err.stack : undefined;
          return { ok: false, error: message, stack };
        }
      });
    }
  }

  // P3-S7 — Bridge Assistant Conversations + swarm origin link. Two more
  // side-band registrations: `assistant.conversations.<method>` is the
  // backing for the Conversations panel inside BridgeRoom;
  // `swarm.origin.<method>` resolves the back-link a swarm has into the
  // chat that triggered it. Both use the same envelope as the side-bands
  // above so the preload bridge can speak to them with no special-casing.
  // V1.1.1 — SigmaVoice diagnostics side-band. The channel id
  // `voice.diagnostics.run` lives outside the typed AppRouter shape (the
  // `voice` namespace stays flat) so we register it via the same
  // map-based pattern as the other side-bands above.
  const voiceDiagnosticsHandlers: Record<string, (...args: unknown[]) => unknown> = {
    run: () => runVoiceDiagnostics(),
  };
  const sideBands: Array<{ prefix: string; map: Record<string, (...args: unknown[]) => unknown> | null }> = [
    { prefix: 'assistant.conversations.', map: conversationsHandlers },
    { prefix: 'swarm.origin.', map: swarmOriginHandlers },
    { prefix: 'voice.diagnostics.', map: voiceDiagnosticsHandlers },
  ];
  for (const band of sideBands) {
    if (!band.map) continue;
    for (const [key, fn] of Object.entries(band.map)) {
      const channel = `${band.prefix}${key}`;
      ipcMain.handle(channel, async (_e, ...args) => {
        try {
          const out = await (fn as (...a: unknown[]) => unknown)(...args);
          return { ok: true, data: out };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
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
    sharedDeps?.browserRegistry.teardownAll();
  } catch {
    /* ignore */
  }
  try {
    sharedDeps?.playwrightSupervisor.stopAll();
  } catch {
    /* ignore */
  }
  try {
    sharedDeps?.memorySupervisor.stopAll();
  } catch {
    /* ignore */
  }
  try {
    sharedDeps?.mcpHostBridge?.stop();
  } catch {
    /* ignore */
  }
  // Phase 4 Track C — stop the Ruflo child cleanly so the JSON-RPC stdio
  // pipes drain and the SIGTERM/SIGKILL escalation runs before electron
  // tears the process down.
  try {
    sharedDeps?.rufloSupervisor.stop();
  } catch {
    /* ignore */
  }
  try {
    sharedDeps?.reviewRunner.killAll();
  } catch {
    /* ignore */
  }
  try {
    sharedDeps?.consoleStop?.();
  } catch {
    /* ignore */
  }
  try {
    designShutdown?.();
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
  consoleHandlers = null;
  replayHandlers = null;
  designShutdown = null;
}

/**
 * Expose the shared deps so other main-process modules (e.g. the workspace
 * launcher) can hook into post-W5 dependencies — currently used to give the
 * launcher the per-workspace MCP url for `.mcp.json` writeback.
 */
export function getSharedDeps(): SharedDeps | null {
  return sharedDeps;
}

export type RegisteredRouter = AppRouter;
