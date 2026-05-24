// Builds the typed RPC router from main-process controllers and registers
// every channel on ipcMain. Renderer events fan out via BrowserWindow.send.

import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { defineController, defineRouter } from '../shared/rpc';
import type { AppRouter } from '../shared/router-shape';
import { initializeDatabase, closeDatabase, getRawDb } from './core/db/client';
import { runBootJanitor } from './core/db/janitor';
import { PtyRegistry } from './core/pty/registry';
import {
  DISK_SCAN_PROVIDERS,
  DISK_SCAN_RETRY_SCHEDULE_MS,
  findLatestSessionId,
  listSessionsInCwd,
} from './core/pty/session-disk-scanner';
import { resumeWorkspacePanes, respawnFailedWorkspacePanes } from './core/pty/resume-launcher';
import { probeAllProviders, probeProviderById } from './core/providers/probe';
import { commitAndMerge, gitDiff, gitStatus, runShellLine, worktreeRemove } from './core/git/git-ops';
import { WorktreePool } from './core/git/worktree';
import { listWorkspaces, openWorkspace, removeWorkspace } from './core/workspaces/factory';
import { cleanupOrphanWorktrees } from './core/workspaces/worktree-cleanup';
import { repoHash as computeRepoHash } from './core/git/git-ops';
import {
  installWorkspaceLifecycleIpc,
  markWorkspaceClosed,
  markWorkspaceOpened,
} from './core/workspaces/lifecycle';
import { executeLaunchPlan } from './core/workspaces/launcher';
import { AGENT_PROVIDERS } from '../shared/providers';
import { SwarmMailbox } from './core/swarms/mailbox';
import { BoardManager } from './core/swarms/boards';
import { buildSwarmController } from './core/swarms/controller';
import { buildConsoleController } from './core/swarms/console-controller';
import { createSwarm } from './core/swarms/factory';
import { ReplayManager } from './core/swarms/replay';
// C-12 SigmaBench — multi-agent conflict benchmark harness + store.
import { runConflictBench, type SwarmStatusSnapshot } from './core/sigmabench/harness';
import * as sigmabenchStore from './core/sigmabench/store';
import { scoreConflicts } from '../shared/bench-scoring';
// v1.4.9 #07 — Notifications. Manager owns the DB + dedup; three sources
// (pty/swarm/tool-error) push into it; OS-notify wrapper handles native
// Notification Center forwarding; controller exposes RPC methods.
import { NotificationsManager } from './core/notifications/manager';
import { buildNotificationsController } from './core/notifications/controller';
import { pushPtyExitNotification } from './core/notifications/sources/pty-exit';
import { pushSwarmMessageNotification } from './core/notifications/sources/swarm-message';
import { pushToolErrorNotification } from './core/notifications/sources/tool-error';
import { runBootNotificationsGc } from './core/notifications/gc';
import { OsNotifier } from './core/notifications/os-notify';
import { and, eq } from 'drizzle-orm';
import { agentSessions, jorvisPaneEvents, swarmAgents } from './core/db/schema';
import { getDb } from './core/db/client';
import { BrowserManagerRegistry } from './core/browser/manager';
import { buildBrowserController } from './core/browser/controller';
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
import { McpHostSigma, type ToolInvoker } from './core/assistant/mcp-host-sigma';
import {
  buildConversationsHandlers,
  buildSwarmOriginHandlers,
} from './core/assistant/conversations-controller';
import { buildDesignController } from './core/design/controller';
import { buildVoiceController } from './core/voice/adapter';
// v1.5.0 packet 09 — Cross-machine sync controller.
import { buildSyncController } from './core/sync/controller';
import { runVoiceDiagnostics } from './core/voice/diagnostics';
import { fsReadDir, fsReadFile, fsWriteFile } from './core/fs/controller';
import { getChannelSchema } from './core/rpc/schemas';
// Phase 4 Track C — Ruflo MCP embed. Process-singleton supervisor + lazy
// installer + JSON-RPC proxy fronting the renderer-facing controller.
import { RufloMcpSupervisor } from './core/ruflo/supervisor';
import { RufloHttpDaemonSupervisor } from './core/ruflo/http-daemon-supervisor';
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
import { KV_PTY_SPAWN_MODE, parseSpawnMode, KV_PTY_SCROLLBACK_PERSISTENCE, parseScrollbackPersistence } from './core/pty/local-pty';
import { persistScrollback, loadScrollback, gcScrollback } from './core/pty/scrollback-store';

interface SharedDeps {
  pty: PtyRegistry;
  worktreePool: WorktreePool;
  mailbox: SwarmMailbox;
  browserRegistry: BrowserManagerRegistry;
  skills: SkillsManager;
  memory: MemoryManager;
  memorySupervisor: MemoryMcpSupervisor;
  reviewRunner: ReviewRunner;
  tasks: TasksManager;
  /** Phase 4 Track C — process-singleton Ruflo supervisor. Stop in the
   *  shutdown path next to memorySupervisor.stopAll(). */
  rufloSupervisor: RufloMcpSupervisor;
  /** v1.6.0-A — per-workspace Ruflo HTTP daemon supervisor. Spawn on workspace
   *  open (in `workspaces.open` handler), stop on workspace close. Stop in the
   *  shutdown path via stopAll(). */
  rufloHttpDaemonSupervisor: RufloHttpDaemonSupervisor;
  /** V3-W12-014 — Operator Console controller. Registered side-band so the
   *  `swarm.*` namespace doesn't pollute the typed AppRouter shape. */
  consoleStop?: () => void;
  /** BUG-V1.1.2-01 — Sigma Assistant MCP host bridge. Listens on a Unix
   *  socket (Windows named pipe); each Claude CLI turn writes a temp
   *  `.mcp.json` declaring the stdio server, which dials back here and
   *  proxies `tools/call` envelopes into the assistant controller. */
  mcpHostSigma?: McpHostSigma;
}

let router: ReturnType<typeof buildRouter> | null = null;
let sharedDeps: SharedDeps | null = null;
/** Side-band controller handlers registered outside `defineRouter` so
 *  foundations can grow the AppRouter shape independently. */
let consoleHandlers: Record<string, (...args: unknown[]) => unknown> | null = null;
/** P3-S6 — Persistent Swarm Replay handlers. Registered side-band under the
 *  `swarm.replay.<method>` namespace via the same allowlist gate. */
let replayHandlers: Record<string, (...args: unknown[]) => unknown> | null = null;
/** P3-S7 — Sigma Assistant cross-session persistence. Two side-band
 *  handler maps: `assistant.conversations.<method>` powers the
 *  Conversations panel inside SigmaRoom; `swarm.origin.<method>` resolves
 *  the back-link from a swarm to the chat-turn that created it for the
 *  Operator Console. Same envelope contract as the console + replay
 *  side-bands above. */
let conversationsHandlers: Record<string, (...args: unknown[]) => unknown> | null = null;
let swarmOriginHandlers: Record<string, (...args: unknown[]) => unknown> | null = null;
/** C-12 SigmaBench — side-band handlers under `sigmabench.<method>`. `run`
 *  kicks the conflict-bench harness fire-and-forget; `listRuns`/`getRun` read
 *  the benchmark store. */
let sigmabenchHandlers: Record<string, (...args: unknown[]) => unknown> | null = null;
/** V3-W14-001..006 — Sigma Canvas controller cleanup hook. Called from
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

/** Recursively sum file sizes under a directory (async, bounded concurrency). */
async function dirSize(dir: string): Promise<number> {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  // Process entries in batches of 16 to avoid unbounded parallelism.
  const BATCH = 16;
  for (let i = 0; i < entries.length; i += BATCH) {
    const batch = entries.slice(i, i + BATCH);
    const sizes = await Promise.all(
      batch.map(async (entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          return dirSize(full);
        }
        try {
          const st = await fs.promises.stat(full);
          return st.size;
        } catch {
          /* symlink or permission issue — skip */
          return 0;
        }
      }),
    );
    for (const s of sizes) total += s;
  }
  return total;
}

function buildRouter() {
  const userData = app.getPath('userData');
  initializeDatabase(userData);

  // Boot janitor: clean up zombie running sessions and prune dead worktrees.
  void runBootJanitor().catch(() => {
    /* non-fatal */
  });

  // v1.9-scrollback — boot GC. Best-effort: remove stale .log files for
  // sessions that no longer exist in the DB.  Flag-off: gcScrollback still
  // runs harmlessly (the scrollback dir doesn't exist yet → readdir skipped).
  try {
    const liveIds = new Set<string>(
      (getRawDb()
        .prepare('SELECT id FROM agent_sessions')
        .all() as { id: string }[])
        .map((r) => r.id),
    );
    gcScrollback(userData, liveIds);
  } catch {
    /* never block startup */
  }

  const worktreePool = new WorktreePool({ baseDir: path.join(userData, 'worktrees') });
  /**
   * v1.2.8 — persist the captured provider-native session id into the DB. The
   * write is idempotent (`WHERE external_session_id IS NULL OR ''`) so a stale
   * disk-scan retry can't clobber a fresh value, and so the same UPDATE is
   * safe to issue from both the pre-assign hot path and the disk-scan retry
   * tail.
   */
  function persistExternalSessionId(sessionId: string, externalId: string): void {
    try {
      getRawDb()
        .prepare(
          `UPDATE agent_sessions
           SET external_session_id = ?
           WHERE id = ?
             AND (external_session_id IS NULL OR external_session_id = '')`,
        )
        .run(externalId, sessionId);
    } catch {
      /* migration may not have run yet in dev/test boot; ignore */
    }
  }
  /**
    * v1.2.8 — bounded retry loop driving the disk-scan capture path for
    * codex/kimi/opencode. Each attempt fires `findLatestSessionId(provider,
    * cwd)`; on success we persist + stamp the live registry record and stop.
    * The schedule (+2s/+5s/+15s) bounds total wall-clock to ~15s so a CLI that
    * never writes its session file does not loop forever.
    *
    * v1.4.2-10 — the scanner now receives `workspaceId` so it can reject
    * candidates already claimed by a different workspace (Option B scoping).
    */
  function scheduleDiskScanCapture(
    sessionId: string,
    providerId: string,
    cwd: string,
  ): void {
    if (!DISK_SCAN_PROVIDERS.has(providerId.toLowerCase())) return;
    // Look up the workspace_id for this session so the disk scanner can
    // scope its capture to the correct workspace.
    let workspaceId: string | undefined;
    try {
      const wsRow = getRawDb()
        .prepare('SELECT workspace_id FROM agent_sessions WHERE id = ?')
        .get(sessionId) as { workspace_id: string } | undefined;
      workspaceId = wsRow?.workspace_id;
    } catch {
      /* pre-migration DB; scanner will fall back to unscoped behaviour */
    }
    let stopped = false;
    const attempt = async () => {
      if (stopped) return;
      // Skip if the session was forgotten or already has an id.
      const rec = sharedDeps?.pty.get(sessionId);
      if (!rec) {
        stopped = true;
        return;
      }
      if (rec.externalSessionId && rec.externalSessionId.length > 0) {
        stopped = true;
        return;
      }
      try {
        const captured = await findLatestSessionId(providerId, cwd, { workspaceId });
        if (captured && !stopped) {
          persistExternalSessionId(sessionId, captured);
          sharedDeps?.pty.setExternalSessionId(sessionId, captured);
          stopped = true;
        }
      } catch {
        /* disk-scan failure is non-fatal; later retries may still succeed */
      }
    };
    for (const delay of DISK_SCAN_RETRY_SCHEDULE_MS) {
      setTimeout(() => {
        void attempt();
      }, delay).unref();
    }
  }
  // v1.4.9 #07 — Notifications. Construct manager BEFORE PtyRegistry so the
  // existing onPaneEvent sink (D1 wiring contract) can push pty-exits in.
  // The OS-notify wrapper consumes new rows surfaced via the manager's delta
  // emit; the renderer subscribes to the same delta via `notifications:changed`.
  const osNotifier = new OsNotifier();
  const notificationsManager = new NotificationsManager({
    emit: (delta) => {
      // Fan out the delta to every renderer window.
      broadcast('notifications:changed', delta);
      // D6 — opt-in native Notification Center forwarding. Each newly added
      // row may fire one OS notification subject to the kv gates + 5min
      // throttle in OsNotifier. The manager surfaces dedup-absorbing rows
      // through `added` too (same id, bumped dup_count); the throttle on
      // `dedup_key` prevents the OS panel from re-buzzing for those.
      for (const added of delta.added) {
        try {
          osNotifier.notify(added);
        } catch {
          /* OS notifier is best-effort; never block the IPC fan-out */
        }
      }
    },
  });
  // D2 — boot GC. One indexed DELETE that drops read rows > 30d.
  void runBootNotificationsGc(notificationsManager);

  const pty = new PtyRegistry(
    (sessionId, data) => broadcast('pty:data', { sessionId, data }),
    (sessionId, exitCode, signal) => broadcast('pty:exit', { sessionId, exitCode, signal }),
    {
      // v1.5.6 — 3s grace window prevents fast-exit binaries from clearing the ring buffer before the renderer's pty.snapshot IPC resolves (race surfaced when v1.5.5-A removed async timing slack from the worktree pool path).
      gracefulExitDelayMs: 3_000,
      // V3-W13-002 — surface OSC8 + plain URLs to the renderer so the click
      // handler can route them into the in-app browser. The renderer-side
      // gate (`kv['browser.captureLinks']`) decides whether to intercept.
      onLinkDetected: (sessionId, hit) =>
        broadcast('pty:link-detected', {
          sessionId,
          url: hit.url,
          text: hit.text,
        }),
      // v1.2.8 — fires once per FRESH spawn (the registry skips resume calls).
      // Two responsibilities: (1) persist the pre-assigned UUID for
      // claude/gemini immediately; (2) schedule the bounded disk-scan retry
      // loop for codex/kimi/opencode.
      onPostSpawnCapture: ({ sessionId, providerId, cwd, preassignedExternalSessionId }) => {
        if (preassignedExternalSessionId) {
          persistExternalSessionId(sessionId, preassignedExternalSessionId);
        }
        scheduleDiskScanCapture(sessionId, providerId, cwd);
      },
      onPaneEvent: (event) => {
        try {
          const row = getDb()
            .select({ conversationId: agentSessions.jorvisMonitorConversationId })
            .from(agentSessions)
            .where(eq(agentSessions.id, event.sessionId))
            .get();
          if (row?.conversationId) {
            const id = randomUUID();
            const ts = Date.now();
            getDb()
              .insert(jorvisPaneEvents)
              .values({
                id,
                conversationId: row.conversationId as string,
                sessionId: event.sessionId,
                kind: event.kind,
                body: event.exitCode !== undefined ? JSON.stringify({ exitCode: event.exitCode }) : null,
                ts,
              })
              .run();
            broadcast('assistant:pane-event', {
              id,
              conversationId: row.conversationId,
              sessionId: event.sessionId,
              kind: event.kind,
              body: event.exitCode !== undefined ? { exitCode: event.exitCode } : null,
              ts,
            });
          }
        } catch {
          // best-effort
        }
        // v1.4.9 #07 — Notifications source. The brief explicitly disallows
        // adding a separate pty:exit listener; re-use this existing sink so
        // one pane event lands in both `jorvis_pane_events` (above) AND
        // `notifications` (below). The source helper internally filters out
        // non-exit kinds (`started` / `output-spike` / `idle`) so the bell
        // doesn't drown in PTY chatter.
        try {
          pushPtyExitNotification(notificationsManager, event);
        } catch {
          /* notifications fan-out is best-effort */
        }
      },
      // v1.6.0 Phase 2 — CLI-exit detection in shell-first mode.
      // Fires when the sentinel is detected in the PTY data stream (CLI exited,
      // shell/pane stays alive).  We skip the jorvis_pane_events DB insert (its
      // SQLite enum does not include 'cli-exited' and we don't want a migration)
      // but we DO fire the "agent done" notification via the same path as PTY
      // exit, so shell-first panes notify on CLI completion exactly like direct-
      // mode panes notify on PTY exit.
      onCliExited: ({ sessionId, exitCode }) => {
        try {
          pushPtyExitNotification(notificationsManager, {
            sessionId,
            kind: exitCode === 0 ? 'exited' : 'error',
            exitCode,
          });
        } catch {
          /* notifications fan-out is best-effort */
        }
      },
      // v1.9-scrollback — DEFAULT-OFF.  Only wired when the KV flag is 'on'.
      // Re-reads the flag lazily on each exit so the user can toggle it at
      // runtime without a restart (toggle-on starts persisting immediately;
      // toggle-off stops after the next exit).
      onSessionExit: (() => {
        const scrollbackFlagRow = getRawDb()
          .prepare('SELECT value FROM kv WHERE key = ?')
          .get(KV_PTY_SCROLLBACK_PERSISTENCE) as { value?: string } | undefined;
        if (!parseScrollbackPersistence(scrollbackFlagRow?.value ?? null)) return undefined;
        return (sessionId: string, snapshot: string) => {
          // Re-read the flag on each call so mid-session toggle-off takes effect.
          try {
            const row = getRawDb()
              .prepare('SELECT value FROM kv WHERE key = ?')
              .get(KV_PTY_SCROLLBACK_PERSISTENCE) as { value?: string } | undefined;
            if (!parseScrollbackPersistence(row?.value ?? null)) return;
          } catch {
            return;
          }
          persistScrollback(userData, sessionId, snapshot);
        };
      })(),
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
    // v1.4.9 #07 — Notifications source. Brief §4 item 2 — wrap the SINGLE
    // existing emitter so one mailbox append fans into both the renderer
    // broadcast (above) and the notifications source (below). The source
    // helper gates on `payload.broadcastToSidebar === true` AND a kind in
    // the v1 allowlist so this stays a no-op for most swarm chatter.
    try {
      pushSwarmMessageNotification(notificationsManager, message);
    } catch {
      /* notifications fan-out is best-effort */
    }
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
  const browserRegistry = new BrowserManagerRegistry({
    windowProvider: () => {
      // Prefer the focused window; fall back to the first non-destroyed one.
      const focused = BrowserWindow.getFocusedWindow();
      if (focused && !focused.isDestroyed()) return focused;
      const all = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
      return all[0] ?? null;
    },
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
  const mcpHostSigma = new McpHostSigma({
    resolveInvoker: () => resolvedToolInvoker,
  });
  const jorvisHostServerEntry = path.join(
    app.getAppPath(),
    'electron-dist',
    'mcp-jorvis-host-server.cjs',
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
  // v1.6.0-A — per-workspace Ruflo HTTP daemon supervisor. Spawn lives in the
  // `workspaces.open` handler (so we have the workspaceId + abs path at hand).
  // Restart events surface to the user via the notifications bell (kind:
  // 'ruflo-daemon', severity: warn) — reuses the v1.4.9 notifications system
  // instead of adding a new broadcast event.
  const rufloHttpDaemonSupervisor = new RufloHttpDaemonSupervisor();
  rufloHttpDaemonSupervisor.on('restarted', (workspaceId: string, success: boolean) => {
    try {
      notificationsManager.add({
        workspaceId,
        kind: 'ruflo-daemon',
        severity: success ? 'warn' : 'error',
        title: success
          ? 'Ruflo MCP daemon restarted'
          : 'Ruflo MCP daemon failed to restart',
        body: success
          ? 'The shared MCP daemon for this workspace was restarted after a crash. Retry your last action if it appeared to hang.'
          : 'The shared MCP daemon for this workspace failed to restart after 3 attempts. Panes fell back to per-process stdio mode; live cross-pane state is degraded.',
        dedupKey: `ruflo-daemon-restart-${success ? 'ok' : 'fail'}`,
      });
    } catch (err) {
      console.warn(
        `[ruflo-http] failed to post restart notification: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  });

  sharedDeps = {
    pty,
    worktreePool,
    mailbox,
    browserRegistry,
    skills: skillsManager,
    memory: memoryManager,
    memorySupervisor,
    reviewRunner,
    tasks: tasksManager,
    rufloSupervisor,
    rufloHttpDaemonSupervisor,
    mcpHostSigma,
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
    quitAndInstall: async () => {
      const { quitAndInstallImpl } = await import('../../electron/auto-update');
      await quitAndInstallImpl();
    },
    // V3-W15-005 — Plan tier read. Default `'ultra'` since SigmaLink is local-
    // only / free; the override is only writable from a hidden dev-mode control
    // in Settings → Appearance, so production users always see Ultra.
    tier: async () => {
      const row = getRawDb()
        .prepare('SELECT value FROM kv WHERE key = ?')
        .get(KV_PLAN_TIER) as { value?: string } | undefined;
      return parseTier(row?.value ?? null);
    },
    // v1.4.2-06 — Worktree location UX.
    revealInFolder: async (p: string) => {
      const resolved = path.resolve(p);
      const userDataDir = app.getPath('userData');
      if (!resolved.startsWith(userDataDir + path.sep) && resolved !== userDataDir) {
        const workspaces = getRawDb()
          .prepare('SELECT root_path FROM workspaces')
          .all() as { root_path: string }[];
        const allowed = workspaces.some((w) => {
          const root = path.resolve(w.root_path);
          return resolved.startsWith(root + path.sep) || resolved === root;
        });
        if (!allowed) return { ok: false, error: 'path not in allowed root' };
      }
      shell.showItemInFolder(resolved);
      return { ok: true };
    },
    openShell: async (cwd: string) => {
      const resolved = path.resolve(cwd);
      const userDataDir = app.getPath('userData');
      if (!resolved.startsWith(userDataDir + path.sep) && resolved !== userDataDir) {
        const workspaces = getRawDb()
          .prepare('SELECT root_path FROM workspaces')
          .all() as { root_path: string }[];
        const allowed = workspaces.some((w) => {
          const root = path.resolve(w.root_path);
          return resolved.startsWith(root + path.sep) || resolved === root;
        });
        if (!allowed) return { ok: false, error: 'path not in allowed root' };
      }
      const plat = process.platform;
      if (plat === 'darwin') {
        spawn('open', ['-a', 'Terminal', resolved], { detached: true, stdio: 'ignore' }).unref();
      } else if (plat === 'win32') {
        spawn('cmd', ['/c', 'start', 'cmd', '/k', 'cd', '/d', resolved], {
          detached: true,
          stdio: 'ignore',
        }).unref();
      } else {
        spawn('x-terminal-emulator', ['--working-directory', resolved], {
          detached: true,
          stdio: 'ignore',
        }).unref();
      }
      return { ok: true };
    },
    getUserDataPath: async () => app.getPath('userData'),
    dismissedWorktreeBanner: async () => {
      const row = getRawDb()
        .prepare('SELECT value FROM kv WHERE key = ?')
        .get('ui.dismissedWorktreeBanner') as { value?: string } | undefined;
      return row?.value === '1';
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
      // v1.6.0 Phase 1 — read the feature flag; default 'direct' preserves
      // byte-for-byte identical behaviour when the flag is absent/invalid.
      const spawnModeRow = getRawDb()
        .prepare('SELECT value FROM kv WHERE key = ?')
        .get(KV_PTY_SPAWN_MODE) as { value?: string } | undefined;
      const rec = pty.create({
        providerId,
        command,
        args,
        cwd: input.cwd,
        env: input.env as NodeJS.ProcessEnv | undefined,
        cols: input.cols,
        rows: input.rows,
        spawnMode: parseSpawnMode(spawnModeRow?.value ?? null),
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
    snapshot: async (sessionId: string) => {
      return { buffer: pty.snapshot(sessionId) };
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
        pid: s.pid,
      })),
    forget: async (sessionId: string) => {
      pty.forget(sessionId);
    },
    // W-4 Phase 4 — Ephemeral scratch-shell sub-tabs. Spawns a plain shell PTY
    // in the given cwd. NO agent_session DB row, NO persistence, NO sidebar
    // entry. killAll() in shutdownRouter covers cleanup automatically.
    spawnScratch: async (input: { cwd: string }): Promise<{ scratchId: string }> => {
      if (typeof input?.cwd !== 'string' || !input.cwd) {
        throw new Error('pty.spawnScratch: cwd must be a non-empty string');
      }
      const shell =
        process.env.SHELL ??
        (process.platform === 'win32' ? 'cmd.exe' : '/bin/sh');
      const rec = pty.create({
        providerId: 'shell',
        command: shell,
        args: [],
        cwd: input.cwd,
        cols: 80,
        rows: 24,
      });
      return { scratchId: rec.id };
    },
    killScratch: async (input: { scratchId: string }): Promise<void> => {
      if (typeof input?.scratchId !== 'string' || !input.scratchId) {
        throw new Error('pty.killScratch: scratchId must be a non-empty string');
      }
      pty.kill(input.scratchId);
      pty.forget(input.scratchId);
    },
  });

  const panesCtl = defineController({
    resume: async (workspaceId: string) => {
      // v1.9-scrollback — pass loadScrollbackForSession when the flag is on so
      // the resume launcher can seed each pane's buffer from the persisted file.
      let loadScrollbackForSession: ((sessionId: string) => string) | undefined;
      try {
        const scrollbackRow = getRawDb()
          .prepare('SELECT value FROM kv WHERE key = ?')
          .get(KV_PTY_SCROLLBACK_PERSISTENCE) as { value?: string } | undefined;
        if (parseScrollbackPersistence(scrollbackRow?.value ?? null)) {
          loadScrollbackForSession = (sessionId: string) =>
            loadScrollback(userData, sessionId);
        }
      } catch {
        /* flag read failed — default off */
      }
      return resumeWorkspacePanes(workspaceId, { pty, loadScrollbackForSession });
    },
    // v1.2.8 — "Respawn fresh" toast action. Re-spawns every pane the resume
    // flow marked as `status='exited' AND exit_code=-1` using the same
    // worktree + provider but with no resume args; returns counts so the
    // renderer can confirm via follow-up toast.
    respawnFailed: async (workspaceId: string) =>
      respawnFailedWorkspacePanes(workspaceId, { pty }),
    // v1.3.0 — Session picker: list provider sessions for a cwd. Delegates
    // entirely to the disk-scanner; never throws (returns []).
    listSessions: async (input: {
      providerId: string;
      cwd: string;
      opts?: { maxCount?: number; sinceMs?: number };
    }) => {
      return listSessionsInCwd(input.providerId, input.cwd, input.opts);
    },
    // v1.3.0 — Session picker: most-recent resume plan for a workspace.
    // Returns ONE row per pane slot — the most recent `agent_sessions` row
    // for each `(workspace_id, pane_index)` group — with the provider and
    // last-captured externalSessionId. Uses a parameterised query; never
    // throws (returns []).
    //
    // v1.3.1 fix: the previous query returned one row per historical session
    // (ordered by started_at DESC, with a paneIndex synthesised from
    // ROW_NUMBER). After 3 launches of a 4-pane workspace that yielded 12
    // rows → the frontend set `preset = 12` and spawned 12+ panes. The
    // correlated subquery below joins each row against the per-pane MAX
    // `started_at` so we get back exactly one row per pane, ordered by the
    // launcher-issued pane_index ASC. Rows with NULL pane_index (legacy,
    // pre-v1.3.1) are excluded so the count cannot inflate.
    lastResumePlan: async (workspaceId: string) => {
      try {
        const rows = getRawDb()
          .prepare(
            `SELECT
               s.pane_index AS paneIndex,
               s.provider_id AS providerId,
               s.external_session_id AS externalSessionId
             FROM agent_sessions s
             INNER JOIN (
               SELECT workspace_id, pane_index, MAX(started_at) AS max_started_at
               FROM agent_sessions
               WHERE workspace_id = ? AND pane_index IS NOT NULL
               GROUP BY workspace_id, pane_index
             ) latest
               ON latest.workspace_id = s.workspace_id
               AND latest.pane_index = s.pane_index
               AND latest.max_started_at = s.started_at
             WHERE s.workspace_id = ? AND s.pane_index IS NOT NULL
             ORDER BY s.pane_index ASC`,
          )
          .all(workspaceId, workspaceId) as Array<{
            paneIndex: number;
            providerId: string;
            externalSessionId: string | null;
          }>;
        return rows.map((r) => ({
          paneIndex: r.paneIndex,
          providerId: r.providerId,
          sessionId: r.externalSessionId ?? null,
        }));
      } catch {
        return [];
      }
    },
    // v1.4.3 (#02) — Pane rehydration. Returns ONE full AgentSession row per
    // pane slot for the given workspace (MAX started_at wins per pane_index),
    // ordered by pane_index ASC. The renderer dispatches ADD_SESSIONS from
    // three call-sites so state.sessionsByWorkspace is populated on workspace
    // reopen without requiring a fresh launch.
    //
    // Uses the same MAX(started_at) correlated-subquery shape as lastResumePlan
    // to guarantee exactly one row per pane slot even when the DB has multiple
    // historical rows for the same paneIndex.
    listForWorkspace: async (workspaceId: string) => {
      try {
        interface RawSessionRow {
          id: string;
          workspace_id: string;
          provider_id: string;
          cwd: string;
          branch: string | null;
          worktree_path: string | null;
          status: string;
          exit_code: number | null;
          initial_prompt: string | null;
          started_at: number;
          exited_at: number | null;
        }
        const rows = getRawDb()
          .prepare(
            `SELECT s.*
             FROM agent_sessions s
             INNER JOIN (
               SELECT workspace_id, pane_index, MAX(started_at) AS max_started_at
               FROM agent_sessions
               WHERE workspace_id = ? AND pane_index IS NOT NULL
               GROUP BY workspace_id, pane_index
             ) latest
               ON latest.workspace_id = s.workspace_id
               AND latest.pane_index = s.pane_index
               AND latest.max_started_at = s.started_at
             WHERE s.workspace_id = ? AND s.pane_index IS NOT NULL
             ORDER BY s.pane_index ASC`,
          )
          .all(workspaceId, workspaceId) as RawSessionRow[];
        return rows.map((r) => ({
          id: r.id,
          workspaceId: r.workspace_id,
          providerId: r.provider_id,
          cwd: r.cwd,
          branch: r.branch ?? null,
          worktreePath: r.worktree_path ?? null,
          status: r.status as 'starting' | 'running' | 'exited' | 'error',
          exitCode: r.exit_code ?? undefined,
          startedAt: r.started_at,
          exitedAt: r.exited_at ?? undefined,
          initialPrompt: r.initial_prompt ?? undefined,
        }));
      } catch {
        return [];
      }
    },
    // C-5 — inject a structured plan capsule into the pane's PTY + write a
    // per-worktree CLAUDE.md scope guidance block.
    brief: async ({ sessionId, worktreePath, capsule }: { sessionId: string; worktreePath: string | null; capsule: import('@/shared/plan-capsule').PlanCapsule }) => {
      const { writeScopeBlock } = await import('./core/workspaces/scope-block');
      const { buildCapsuleText } = await import('@/shared/plan-capsule');
      if (worktreePath) await writeScopeBlock(worktreePath, capsule);
      pty.write(sessionId, buildCapsuleText(capsule) + '\n');
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
    // v1.4.9-06 — Spawn the provider's installCommand in an ephemeral PTY.
    // Uses the user's home directory as cwd so the install is not scoped
    // to any particular workspace. The pane lifecycle matches regular panes
    // (stays open on exit-0; user dismisses manually).
    spawnInstall: async (providerId: string): Promise<{ paneId: string }> => {
      const def = AGENT_PROVIDERS.find((p) => p.id === providerId);
      if (!def) throw new Error(`providers.spawnInstall: unknown provider '${providerId}'`);
      const platform = process.platform as 'darwin' | 'linux' | 'win32';
      const cmd = def.installCommand?.[platform] ?? def.installCommand?.linux;
      if (!cmd || cmd.length === 0) {
        throw new Error(
          `providers.spawnInstall: no installCommand for provider '${providerId}' on ${platform}`,
        );
      }
      const [command, ...args] = cmd;
      const rec = pty.create({
        // Use a sentinel providerId so the PTY registry does not confuse
        // this with a real agent session; 'shell' is the closest sentinel.
        providerId: 'shell',
        command: command!,
        args,
        cwd: app.getPath('home'),
        cols: 80,
        rows: 24,
      });
      return { paneId: rec.id };
    },
    // v1.4.9-06 — Consent gating. Key schema:
    //   kv['provider.autoinstall.consent.<providerId>'] = 'declined'
    // Absence means "not yet decided".
    setInstallConsent: async (providerId: string, decision: 'declined'): Promise<void> => {
      if (typeof providerId !== 'string' || !providerId) {
        throw new Error('providers.setInstallConsent: providerId must be a non-empty string');
      }
      const allowed = ['declined'] as const;
      if (!(allowed as readonly string[]).includes(decision)) {
        throw new Error(`providers.setInstallConsent: invalid decision '${String(decision)}'`);
      }
      getRawDb()
        .prepare(
          `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, unixepoch() * 1000)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .run(`provider.autoinstall.consent.${providerId}`, decision);
    },
    getInstallConsent: async (providerId: string): Promise<'declined' | null> => {
      if (typeof providerId !== 'string' || !providerId) return null;
      const row = getRawDb()
        .prepare('SELECT value FROM kv WHERE key = ?')
        .get(`provider.autoinstall.consent.${providerId}`) as { value?: string } | undefined;
      const val = row?.value;
      if (val === 'declined') return 'declined';
      return null;
    },
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
    open: async (root: string) => {
      const workspace = await openWorkspace(root, {
        rufloSupervisor,
        rufloHttpDaemonSupervisor,
        skillsManager,
        emit: (event, payload) => broadcast(event, payload),
      });
      markWorkspaceOpened(workspace.id);
      // v1.4.3 (#04) — Best-effort orphan worktree cleanup. Removes worktree
      // dirs under userData/worktrees/<repoHash>/ that are not referenced by
      // any live or recently-exited agent_sessions row. Non-fatal; failures
      // are logged but never surfaced to the user. Skipped for plain repos
      // (no repoRoot) and on cold install (no DB rows for this repo).
      if (workspace.repoRoot) {
        const worktreeBase = path.join(app.getPath('userData'), 'worktrees');
        const hash = computeRepoHash(workspace.repoRoot);
        void cleanupOrphanWorktrees(worktreeBase, hash, getRawDb()).catch((err) => {
          console.warn('[workspaces.open] Worktree cleanup failed (non-fatal):', err);
        });
      }
      return workspace;
    },
    list: async () => listWorkspaces(),
    remove: async (id: string) => {
      await removeWorkspace(id, { rufloHttpDaemonSupervisor });
      markWorkspaceClosed(id);
    },
    launch: async (plan) => {
      const out = await executeLaunchPlan(plan, {
        pty,
        worktreePool,
        // crash-classification IPC — fan out pty:error to all renderer windows
        // when an exit is classified as a crash (earlyDeath OR non-zero exitCode/signal).
        broadcastPtyError: (payload) => broadcast('pty:error', payload),
      });
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
    // v1.4.2-06 — Storage panel: enumerate worktree dirs with sizes.
    getWorktreeSizes: async () => {
      const worktreesDir = path.join(app.getPath('userData'), 'worktrees');
      const result: {
        worktrees: Array<{ path: string; sizeBytes: number; repoHash: string; branchSeg: string }>;
        totalBytes: number;
      } = { worktrees: [], totalBytes: 0 };
      if (!fs.existsSync(worktreesDir)) return result;
      const repoHashes = fs.readdirSync(worktreesDir);
      for (const repoHash of repoHashes) {
        const repoDir = path.join(worktreesDir, repoHash);
        if (!fs.statSync(repoDir).isDirectory()) continue;
        const branchSegs = fs.readdirSync(repoDir);
        for (const branchSeg of branchSegs) {
          const wtPath = path.join(repoDir, branchSeg);
          if (!fs.statSync(wtPath).isDirectory()) continue;
          const sizeBytes = await dirSize(wtPath);
          result.worktrees.push({ path: wtPath, sizeBytes, repoHash, branchSeg });
          result.totalBytes += sizeBytes;
        }
      }
      return result;
    },
  });

  const swarmsCtl = buildSwarmController({
    pty,
    worktreePool,
    mailbox,
    userDataDir: userData,
  });

  // C-12 SigmaBench — conflict benchmark side-band. Reuses the SAME swarm
  // factory deps the swarm controller already builds (pty / worktreePool /
  // mailbox / userDataDir) plus the raw better-sqlite3 handle for the store.
  // `readSwarmStatuses` reads each agent's live status + worktree path from the
  // swarm_agents → agent_sessions join so the harness can poll for exit and
  // then read each worktree's changed files.
  const sigmabenchSwarmFactoryDeps = {
    pty,
    worktreePool,
    mailbox,
    userDataDir: userData,
  };
  const readSwarmStatuses = async (swarmId: string): Promise<SwarmStatusSnapshot[]> => {
    const db = getDb();
    const agentRows = db
      .select()
      .from(swarmAgents)
      .where(eq(swarmAgents.swarmId, swarmId))
      .all();
    return agentRows.map((agent) => {
      let worktreePath: string | null = null;
      let exitCode: number | null = null;
      let status = agent.status as string;
      if (agent.sessionId) {
        const sess = db
          .select()
          .from(agentSessions)
          .where(eq(agentSessions.id, agent.sessionId))
          .get();
        if (sess) {
          worktreePath = sess.worktreePath ?? null;
          exitCode = sess.exitCode ?? null;
          // Prefer the session row's terminal status when the PTY has exited.
          if (sess.status === 'exited' || sess.status === 'error') {
            status = sess.status;
          }
        }
      }
      return {
        sessionId: agent.sessionId ?? '',
        status,
        worktreePath,
        exitCode,
      };
    });
  };
  sigmabenchHandlers = {
    run: async (input: unknown) => {
      const arg = (input as {
        category?: string;
        taskPrompt?: string;
        providers?: string[];
        workspaceId?: string;
      }) ?? {};
      if (typeof arg.taskPrompt !== 'string' || arg.taskPrompt.trim().length === 0) {
        throw new Error('sigmabench.run: taskPrompt required');
      }
      if (!Array.isArray(arg.providers) || arg.providers.length === 0) {
        throw new Error('sigmabench.run: providers must be a non-empty array');
      }
      if (typeof arg.workspaceId !== 'string' || !arg.workspaceId) {
        throw new Error('sigmabench.run: workspaceId required');
      }
      // The harness creates the run row synchronously (its first step), then
      // does the slow spawn/poll work. We capture the runId via the
      // `onRunCreated` hook so we can reply immediately, then let the harness
      // finish fire-and-forget. The renderer polls getRun for the final state.
      let capturedRunId: string | null = null;
      const harnessPromise = runConflictBench(
        {
          taskPrompt: arg.taskPrompt,
          providers: arg.providers,
          category: arg.category ?? 'multi-agent-conflict',
          workspaceId: arg.workspaceId,
        },
        {
          db: getRawDb(),
          workspaceId: arg.workspaceId,
          createSwarm,
          swarmFactoryDeps: sigmabenchSwarmFactoryDeps,
          readSwarmStatuses,
          gitStatus,
          store: sigmabenchStore,
          scoreConflicts,
          now: () => Date.now(),
          sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
          timeoutMs: 10 * 60 * 1000,
          tickMs: 1_500,
          onRunCreated: (runId) => {
            capturedRunId = runId;
          },
        },
      );
      // Fire-and-forget: surface harness crashes in the log but don't block
      // the RPC reply.
      void harnessPromise.catch((err) => {
        console.error('[sigmabench] conflict bench failed:', err);
      });
      // `onRunCreated` fires synchronously inside runConflictBench before its
      // first await, so capturedRunId is populated by the time the microtask
      // queue yields back here. Guard defensively all the same.
      if (!capturedRunId) {
        const { runId } = await harnessPromise;
        return { runId };
      }
      return { runId: capturedRunId };
    },
    listRuns: () => sigmabenchStore.listRuns(getRawDb()),
    getRun: (input: unknown) => {
      const arg = (input as { id?: string }) ?? {};
      if (typeof arg.id !== 'string' || !arg.id) {
        throw new Error('sigmabench.getRun: id required');
      }
      return sigmabenchStore.getRun(getRawDb(), arg.id);
    },
  };

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
  // V3-W13-013 — Sigma Assistant controller. Owns the `assistant.*`
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
    // v1.4.9 #07 — Notifications source. Brief §4 item 3 — wrap the existing
    // emit so `assistant:tool-trace` events also feed the notifications
    // source. The source helper gates on `trace.ok === false` so successful
    // traces are dropped. Other events (`assistant:state`, `assistant:dispatch-echo`)
    // pass through untouched.
    emit: (event, payload) => {
      broadcast(event, payload);
      if (event === 'assistant:tool-trace' && payload && typeof payload === 'object') {
        try {
          pushToolErrorNotification(
            notificationsManager,
            // Trust the existing tool-tracer payload shape; the source
            // helper internally type-guards on `.ok === false`.
            payload as Parameters<typeof pushToolErrorNotification>[1],
          );
        } catch {
          /* notifications fan-out is best-effort */
        }
      }
    },
    ruflo: rufloProxy,
    mcpHost: {
      serverEntry: jorvisHostServerEntry,
      socketPath: mcpHostSigma.getSocketPath(),
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
  void mcpHostSigma.start().catch((err) => {
    console.warn(
      `[mcp-host-sigma] failed to start: ${err instanceof Error ? err.message : String(err)}`,
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
  // V3-W14-001..006 — Sigma Canvas controller. Owns the `design.*` namespace
  // (element-picker overlay, asset staging, HMR poke, canvas DAO + dispatch
  // fan-out). Holds onto its own picker runtime + watch registry so the
  // shutdown path can tear them down deterministically.
  const designCtl = buildDesignController({
    browserRegistry,
    pty,
    worktreePool,
    userDataDir: userData,
    emit: (event, payload) => broadcast(event, payload),
    // C-13: delegate to the existing pty.write call so design.dispatch can
    // route element captures into live pane PTYs without re-opening IPC.
    ptyWrite: (sessionId, data) => pty.write(sessionId, data),
  });
  designShutdown = (designCtl as unknown as { shutdown: () => void }).shutdown;
  // V3-W15-001 / V1.1 — SigmaVoice. Renderer drives Web Speech capture on
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
  // v1.6.1 B2 — ruflo.daemonStatus, ruflo.restartDaemon.
  const rufloCtl = buildRufloController({
    supervisor: rufloSupervisor,
    proxy: rufloProxy,
    installer: rufloInstaller,
    httpDaemonSupervisor: rufloHttpDaemonSupervisor,
    emit: (event, payload) => broadcast(event, payload),
  });

  // v1.4.9 #07 — Notifications controller. Channels: notifications.list,
  // notifications.unreadCount, notifications.markRead, notifications.markAllRead,
  // notifications.markUnread, notifications.dismiss, notifications.clearRead.
  const notificationsCtl = buildNotificationsController(notificationsManager);

  // v1.5.0 packet 09 — Cross-machine sync controller. Channels: sync.enable,
  // sync.disable, sync.status, sync.listConflicts, sync.resolveConflict,
  // sync.exportMnemonic, sync.isConfigured, sync.recoverFromMnemonic.
  // SECURITY: the sync master key never appears in IPC responses.
  const syncCtl = buildSyncController(getRawDb(), broadcast);

  return defineRouter({
    app: appCtl,
    pty: ptyCtl,
    panes: panesCtl,
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
    notifications: notificationsCtl,
    sync: syncCtl,
  });
}

export function registerRouter(): void {
  if (router) return;
  router = buildRouter();
  installWorkspaceLifecycleIpc();
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

  // P3-S7 — Sigma Assistant Conversations + swarm origin link. Two more
  // side-band registrations: `assistant.conversations.<method>` is the
  // backing for the Conversations panel inside SigmaRoom;
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
    // C-12 SigmaBench — `sigmabench.run` / `.listRuns` / `.getRun`.
    { prefix: 'sigmabench.', map: sigmabenchHandlers },
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
  // v1.9-scrollback — DEFAULT-OFF. Persist every live session's buffer
  // snapshot BEFORE killAll() tears down the PTYs, so we capture the last
  // visible scrollback. Best-effort: errors are swallowed so shutdown is
  // never blocked. Flag-off: the block runs but the flag read returns false
  // and no files are written — zero behaviour change.
  try {
    if (sharedDeps?.pty) {
      const rawDb = getRawDb();
      const scrollbackRow = rawDb
        .prepare('SELECT value FROM kv WHERE key = ?')
        .get(KV_PTY_SCROLLBACK_PERSISTENCE) as { value?: string } | undefined;
      if (parseScrollbackPersistence(scrollbackRow?.value ?? null)) {
        const userDataDir = app.getPath('userData');
        for (const rec of sharedDeps.pty.list()) {
          try {
            persistScrollback(userDataDir, rec.id, rec.buffer.snapshot());
          } catch {
            /* ignore per-session errors */
          }
        }
      }
    }
  } catch {
    /* never block shutdown */
  }
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
    sharedDeps?.memorySupervisor.stopAll();
  } catch {
    /* ignore */
  }
  try {
    sharedDeps?.mcpHostSigma?.stop();
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
  // v1.6.0-A — stop ALL per-workspace HTTP daemons (one per open workspace).
  // SIGTERM → 5s drain → SIGKILL idiom mirrors MemoryMcpSupervisor.stopAll().
  try {
    void sharedDeps?.rufloHttpDaemonSupervisor.stopAll();
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
  sigmabenchHandlers = null;
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
