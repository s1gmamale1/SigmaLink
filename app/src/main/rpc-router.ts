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
import { PtyDataCoalescer } from './core/pty/pty-data-coalescer';
import {
  DISK_SCAN_PROVIDERS,
  DISK_SCAN_RETRY_SCHEDULE_MS,
  findLatestSessionId,
  listSessionsInCwd,
} from './core/pty/session-disk-scanner';
import { resumeWorkspacePanes, respawnFailedWorkspacePanes } from './core/pty/resume-launcher';
import { probeAllProviders, probeProviderById } from './core/providers/probe';
import {
  commitAndMerge,
  createCheckpoint,
  gitActivityLog,
  gitDiff,
  gitStatus,
  restoreCheckpoint,
  runShellLine,
  worktreeRemove,
} from './core/git/git-ops';
import { buildGitCheckpointController } from './core/git/checkpoint-controller';
import { buildUsageController } from './core/usage/controller';
import { buildMcpDiagnosticController } from './core/workspaces/mcp-diagnostic';
import { WorktreePool } from './core/git/worktree';
import { worktreeCreate } from './core/git/worktree-gui';
import { openInPane } from './core/workspaces/open-in-pane';
import { listWorkspaces, openWorkspace, openWorkspaceNew, removeWorkspace, renameWorkspace } from './core/workspaces/factory';
import { cleanupOrphanWorktrees, sweepAllReposOnBoot } from './core/workspaces/worktree-cleanup';
import {
  pruneOrphanWorktreesForWorkspace,
  clearPanesForWorkspace,
  removeWorkspaceAndGc,
} from './core/workspaces/cleanup';
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
// P4.2 — daily-note agent-activity digest + NTF-DIGEST once-daily summary.
import { DigestCollector, parseMinSeverity } from './core/memory/agent-digest';
import { DailyScheduler } from './core/notifications/daily-scheduler';
import { buildDailySummary, type DigestRow } from './core/notifications/digest-builder';
import {
  KV_DAILY_SUMMARY_ENABLED,
  KV_DAILY_SUMMARY_TIME,
  KV_DAILY_NOTE_DIGEST_ENABLED,
  KV_DAILY_NOTE_DIGEST_MIN_SEVERITY,
  DEFAULT_DAILY_SUMMARY_TIME,
} from '../shared/notification-prefs';
import { and, eq } from 'drizzle-orm';
import { agentSessions, jorvisPaneEvents, swarmAgents, workspaces } from './core/db/schema';
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
// R-1 — Jorvis Telegram remote. Supervisor + `telegram.*` controller. The
// bridge is INERT by default; it only starts when enabled + token + encryption
// + non-empty allowlist all hold (see core/remote/bridge.ts).
import { TelegramBridge } from './core/remote/bridge';
import { buildTelegramController } from './core/remote/controller';
import { CredentialStore } from './core/credentials/storage';
import { runVoiceDiagnostics } from './core/voice/diagnostics';
import { fsReadDir, fsReadFile, fsWriteFile } from './core/fs/controller';
import { assertAllowedPath, type AllowedRootsSource } from './core/security/path-guard';
import { validateChannelInput, validateChannelOutput } from './core/rpc/validate';
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
import { cmdQuoteArg } from './core/util/windows-spawn';

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
  /** R-1 — Jorvis Telegram remote supervisor. Stopped in the shutdown path. */
  telegramBridge?: TelegramBridge;
  /** P4.2 — daily-note agent-activity digest collector. Final flush + cancel
   *  run in the shutdown path. */
  digestCollector?: DigestCollector;
  /** P4.2 NTF-DIGEST — once-daily summary scheduler. Cancelled in shutdown. */
  dailyScheduler?: DailyScheduler;
  /** P4.2 NTF-DIGEST — re-arm the daily-summary scheduler from current KV.
   *  Callable from a Settings-persistence side if it wants eager re-arm; the
   *  scheduler also re-reads KV on every fire so this is optional. */
  rearmDailySummary?: () => void;
}

let router: Awaited<ReturnType<typeof buildRouter>> | null = null;
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
/** PERF-1 — module ref so shutdownRouter can flush + cancel the coalescer timer. */
let ptyDataCoalescerRef: PtyDataCoalescer | null = null;

const requireCJS = createRequire(import.meta.url);

// PERF-11 — the app has exactly one renderer window. Cache it so the hot
// `broadcast()` path (pty:data etc.) sends O(1) instead of rebuilding the
// `getAllWindows()` array per event. `createWindow()` sets this; the window's
// `closed` handler clears it. Falls back to the full sweep when unset/stale.
let broadcastTarget: BrowserWindow | null = null;

/** PERF-11 — register the single renderer window as the broadcast fast-path. */
export function setBroadcastTarget(win: BrowserWindow | null): void {
  broadcastTarget = win;
}

function broadcast(event: string, payload: unknown) {
  const target = broadcastTarget;
  if (target && !target.isDestroyed()) {
    target.webContents.send(event, payload);
    return;
  }
  // Fallback: no target registered yet (early boot) or it was destroyed.
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
        // H-16 — never follow symlinks: a symlinked dir could escape the tree
        // (or cycle into an infinite recursion) and a symlinked file's stat()
        // would follow to an out-of-tree target. `withFileTypes` reports the
        // link itself, so skip it outright and lstat regular files.
        if (entry.isSymbolicLink()) return 0;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          return dirSize(full);
        }
        try {
          const st = await fs.promises.lstat(full);
          return st.isFile() ? st.size : 0;
        } catch {
          /* permission issue — skip */
          return 0;
        }
      }),
    );
    for (const s of sizes) total += s;
  }
  return total;
}

async function buildRouter() {
  const userData = app.getPath('userData');
  initializeDatabase(userData);

  const worktreeBase = path.join(userData, 'worktrees');

  // Boot recovery (CRIT-2/CRIT-1): clear zombie pane-slots and reap leaked
  // worktrees BEFORE any window/auto-resume so fresh spawns aren't locked out
  // and the disk can't carry orphaned checkouts. Both are best-effort and must
  // never block startup.
  await runBootJanitor().catch((err) => {
    console.warn('[boot] janitor failed (non-fatal):', err);
  });
  await sweepAllReposOnBoot(worktreeBase, getRawDb()).catch((err) => {
    console.warn('[boot] worktree sweep failed (non-fatal):', err);
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

  const worktreePool = new WorktreePool({ baseDir: worktreeBase });

  // Wave-1 H-5 — authoritative allowed-roots for the renderer-facing fs/git/pty
  // path sandbox. Re-derived per call so freshly-opened workspaces are picked up;
  // a DB failure yields [] (deny-all) for that call rather than widening the
  // sandbox. Same root-derivation as `allowedReadRoots(ctx)` in tools.ts and the
  // `revealInFolder` allow-set below — reads/writes/shell/read_files share ONE
  // sandbox definition.
  const fsAllowedRoots: AllowedRootsSource = () => {
    const set = new Set<string>();
    try {
      for (const ws of getDb().select().from(workspaces).all()) {
        if (ws.rootPath) set.add(path.resolve(ws.rootPath));
        if (ws.repoRoot) {
          set.add(path.resolve(ws.repoRoot));
          try {
            set.add(path.resolve(worktreePool.poolPathForRepo(ws.repoRoot)));
          } catch {
            /* worktree pool unavailable for this repo — skip */
          }
        }
      }
    } catch {
      /* DB unavailable — deny-all */
    }
    return [...set];
  };
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
  // P4.2 — forward ref so the manager's emit tap can feed delta.added into the
  // daily-note digest. The collector is constructed after memoryManager exists
  // (a few lines down); the closure captures this binding by reference, so it
  // sees the live instance once assigned. Tap-before-construct is a no-op
  // (`?.`), which is fine — no notifications fire during the construct gap.
  let digestCollector: DigestCollector | null = null;
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
        // P4.2 daily-note digest — tap every newly-surfaced row. The collector
        // itself gates on KV-enabled + severity + null-workspace; here we only
        // forward. Failures must never break the IPC fan-out.
        try {
          digestCollector?.onNotification(added);
        } catch {
          /* digest journaling is best-effort */
        }
      }
    },
  });
  // D2 — boot GC. One indexed DELETE that drops read rows > 30d.
  void runBootNotificationsGc(notificationsManager);

  // PERF-1 — coalesce per-session pty:data chunks into one IPC send per ~12ms
  // (the registry still appends to the ring buffer + runs link detection per raw
  // chunk). Flush a session immediately before its pty:exit so trailing output
  // lands before the renderer's exit line.
  const ptyDataCoalescer = new PtyDataCoalescer({
    emit: (sessionId, data) => broadcast('pty:data', { sessionId, data }),
  });
  ptyDataCoalescerRef = ptyDataCoalescer; // PERF-1 — for shutdownRouter dispose
  // PERF-2 — the link-capture flag only changes on an operator toggle, so cache
  // the KV read for 2s instead of querying per chunk (~50/s/pane).
  let linkGate = { value: true, at: 0 };
  const shouldDetectLinks = (): boolean => {
    const now = Date.now();
    if (now - linkGate.at < 2_000) return linkGate.value;
    let value = true;
    try {
      const row = getRawDb()
        .prepare('SELECT value FROM kv WHERE key = ?')
        .get('browser.captureLinks') as { value?: string } | undefined;
      value = row?.value == null ? true : row.value === '1';
    } catch {
      value = true; // default ON when the KV is unreachable (matches Terminal.tsx)
    }
    linkGate = { value, at: now };
    return value;
  };
  const pty = new PtyRegistry(
    (sessionId, data) => ptyDataCoalescer.push(sessionId, data),
    (sessionId, exitCode, signal) => {
      ptyDataCoalescer.flush(sessionId);
      broadcast('pty:exit', { sessionId, exitCode, signal });
    },
    {
      // v1.5.6 — 3s grace window prevents fast-exit binaries from clearing the ring buffer before the renderer's pty.snapshot IPC resolves (race surfaced when v1.5.5-A removed async timing slack from the worktree pool path).
      gracefulExitDelayMs: 3_000,
      // PERF-2 — skip the per-chunk link-detection regex + emit in MAIN when the
      // renderer's capture is off (matches Terminal.tsx's `browser.captureLinks`
      // gate; default ON when the KV is unreachable). The read is 2s-cached above.
      shouldDetectLinks,
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
        // PERF-1 — flush any buffered output for this session before the
        // CLI-done notification fires (spec parity; harmless if already empty).
        ptyDataCoalescer.flush(sessionId);
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

  // P4.2 — daily-note agent-activity digest + NTF-DIGEST once-daily summary.
  // Both read their KV gates lazily (each event / each re-arm) so a Settings
  // toggle takes effect without a restart. `readKv` is a tiny cached-free
  // helper matching the existing `SELECT value FROM kv` pattern; the reads are
  // cold-path (a digest event or a once-a-day fire), so no caching is needed.
  const readKv = (key: string): string | null => {
    try {
      const row = getRawDb()
        .prepare('SELECT value FROM kv WHERE key = ?')
        .get(key) as { value?: string } | undefined;
      return row?.value ?? null;
    } catch {
      return null;
    }
  };
  digestCollector = new DigestCollector({
    appendToMemory: (input) => memoryManager.appendToMemory(input),
    isEnabled: () => readKv(KV_DAILY_NOTE_DIGEST_ENABLED) === '1',
    getMinSeverity: () => parseMinSeverity(readKv(KV_DAILY_NOTE_DIGEST_MIN_SEVERITY)),
  });
  const digestCollectorRef = digestCollector;
  // NTF-DIGEST — once-daily summary. The scheduler re-reads the enabled gate +
  // fire-time KV on every (re-)arm, so toggling the time in Settings re-points
  // the next fire. `armDailySummary` is the canonical (re-)arm entry: it is
  // called once at boot, on each fire (inside onFire), and by the side that
  // owns Settings persistence if it chooses to re-arm eagerly.
  const dailyScheduler = new DailyScheduler({
    onFire: () => {
      // Re-read the enabled gate at fire time — the operator may have toggled
      // it off after the timer was armed.
      if (readKv(KV_DAILY_SUMMARY_ENABLED) !== '1') return;
      try {
        buildDailySummary(
          {
            notifications: notificationsManager,
            queryDay: (since, until) =>
              getRawDb()
                .prepare(
                  `SELECT kind, severity FROM notifications
                   WHERE created_at >= ? AND created_at < ?
                     AND kind != 'daily-summary'`,
                )
                .all(since, until) as DigestRow[],
          },
          new Date(),
        );
      } catch {
        /* a failed summary build must not break the scheduler's re-arm */
      }
    },
  });
  const armDailySummary = (): void => {
    if (readKv(KV_DAILY_SUMMARY_ENABLED) === '1') {
      const time = readKv(KV_DAILY_SUMMARY_TIME) ?? DEFAULT_DAILY_SUMMARY_TIME;
      dailyScheduler.schedule(time);
    } else {
      dailyScheduler.cancel();
    }
  };
  armDailySummary();

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
    digestCollector: digestCollectorRef,
    dailyScheduler,
    rearmDailySummary: armDailySummary,
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
        spawn('cmd.exe', ['/d', '/s', '/k', `cd /d ${cmdQuoteArg(resolved)}`], {
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
      // H-4 — contain the renderer-supplied spawn cwd to a workspace/worktree
      // root (same class as spawnScratch; the command is already constrained to
      // the provider registry). Legit pane launches use workspace/worktree dirs
      // that are in the allow-set; a compromised renderer cannot spawn an agent
      // CLI in an arbitrary directory with arbitrary args/env.
      assertAllowedPath(input.cwd, fsAllowedRoots());
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
      // H-4 — contain the renderer-supplied cwd to a workspace/worktree root
      // before spawning a shell there (throws 'path outside workspace' otherwise).
      assertAllowedPath(input.cwd, fsAllowedRoots());
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
    // P6 FEAT-1 — on-demand subset relaunch from the "Resume agents…" command.
    // ADDITIVE: the boot auto-resume keeps calling `resume(workspaceId)` with no
    // subset (full behaviour). This passes the operator-chosen `sessionIds`
    // allowlist so only the picked panes are relaunched. Reuses the same
    // scrollback-seeding gate as `resume`.
    resumeSelected: async (workspaceId: string, sessionIds: string[]) => {
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
      // Defensive: only ever pass an array of non-empty string ids through.
      const ids = Array.isArray(sessionIds)
        ? sessionIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
        : [];
      return resumeWorkspacePanes(workspaceId, { pty, loadScrollbackForSession }, ids);
    },
    // v1.3.0 — Session picker: list provider sessions for a cwd. Delegates
    // entirely to the disk-scanner; never throws (returns []).
    //
    // B2 — thread `workspaceId` so codex/kimi/gemini lists scope to the
    // workspace (Option-B whitelist). Without it codex/kimi return EVERY
    // session on the machine (their disk layouts don't partition by project),
    // which let the picker surface — and then resume — a session from a
    // DIFFERENT project. `workspaceId` may ride either the top-level field
    // (SessionStep) or inside `opts`; the top-level wins when both are set.
    listSessions: async (input: {
      providerId: string;
      cwd: string;
      workspaceId?: string;
      opts?: { maxCount?: number; sinceMs?: number; workspaceId?: string };
    }) => {
      const opts = {
        ...input.opts,
        workspaceId: input.workspaceId ?? input.opts?.workspaceId,
      };
      return listSessionsInCwd(input.providerId, input.cwd, opts);
    },
    // v1.3.0 — Session picker: most-recent resume plan for a workspace.
    // Returns ONE row per pane slot with the provider and last-captured
    // externalSessionId. Uses a parameterised query; never throws (returns []).
    //
    // SF-12 — choose a deterministic slot owner. A slot may have historical
    // duplicate rows, and `started_at` is mutated during resume, so
    // MAX(started_at) can select an exited row or return ties. Rank live
    // sessions first, then newest `started_at`, then highest id.
    lastResumePlan: async (workspaceId: string) => {
      try {
        const rows = getRawDb()
          .prepare(
            `WITH ranked AS (
               SELECT
                 s.pane_index AS paneIndex,
                 s.provider_id AS providerId,
                 s.external_session_id AS externalSessionId,
                 ROW_NUMBER() OVER (
                   PARTITION BY s.workspace_id, s.pane_index
                   ORDER BY
                     CASE WHEN s.status IN ('running', 'starting') THEN 0 ELSE 1 END ASC,
                     s.started_at DESC,
                     s.id DESC
                 ) AS rn
               FROM agent_sessions s
               WHERE s.workspace_id = ? AND s.pane_index IS NOT NULL
             )
             SELECT paneIndex, providerId, externalSessionId
             FROM ranked
             WHERE rn = 1
             ORDER BY paneIndex ASC`,
          )
          .all(workspaceId) as Array<{
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
    // pane slot for the given workspace, ordered by pane_index ASC. The
    // renderer dispatches ADD_SESSIONS from three call-sites so
    // state.sessionsByWorkspace is populated on workspace reopen without
    // requiring a fresh launch.
    //
    // SF-12 — same slot-owner ranking as lastResumePlan: live rows first, then
    // started_at DESC, then id DESC. This is deterministic and cannot return
    // two rows for one pane slot.
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
          display_provider_id: string | null;
        }
        const rows = getRawDb()
          .prepare(
            `WITH ranked AS (
               SELECT
                 s.*,
                 ROW_NUMBER() OVER (
                   PARTITION BY s.workspace_id, s.pane_index
                   ORDER BY
                     CASE WHEN s.status IN ('running', 'starting') THEN 0 ELSE 1 END ASC,
                     s.started_at DESC,
                     s.id DESC
                 ) AS rn
               FROM agent_sessions s
               WHERE s.workspace_id = ? AND s.pane_index IS NOT NULL
             )
             SELECT *
             FROM ranked
             WHERE rn = 1
             ORDER BY pane_index ASC`,
          )
          .all(workspaceId) as RawSessionRow[];
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
          displayProviderId: r.display_provider_id ?? null,
        }));
      } catch {
        return [];
      }
    },
    // SF-10 — set a display-only CLI label on a pane (e.g. tag a shell pane the
    // operator ran `cursor-agent` in as "Cursor"). Cosmetic ONLY: the session's
    // real provider_id (spawn/resume/MCP behaviour) is untouched. Pass null to
    // clear the override and show the real provider again. Broadcasts so the
    // pane header re-renders.
    setDisplayProvider: async ({
      sessionId,
      displayProviderId,
    }: {
      sessionId: string;
      displayProviderId: string | null;
    }): Promise<{ ok: boolean }> => {
      if (typeof sessionId !== 'string' || !sessionId.trim()) {
        return { ok: false };
      }
      const value =
        typeof displayProviderId === 'string' && displayProviderId.trim()
          ? displayProviderId
          : null;
      try {
        getRawDb()
          .prepare(`UPDATE agent_sessions SET display_provider_id = ? WHERE id = ?`)
          .run(value, sessionId);
        broadcast('panes:display-provider-changed', { sessionId, displayProviderId: value });
        return { ok: true };
      } catch {
        return { ok: false };
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
      // H-12 — never expose the internal `shell` sentinel over RPC (the
      // Settings → Providers tab renders whatever this returns and only
      // filters `legacy`). Filtering at the source keeps `shell` out of every
      // consumer; `legacy` rows still flow through for the tab to handle.
      AGENT_PROVIDERS.filter((p) => p.id !== 'shell').map((p) => ({
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
        // SF-7 — sink for the one-time stdio-fallback notice.
        notifications: notificationsManager,
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
    // DEV-W3a — force a DISTINCT workspace on a directory (bypasses the
    // dedup-by-rootPath reuse in `open`). Disambiguated by the user's custom
    // name (DEV-W2). Migration 0034 (drop workspaces_root_idx) is what lets the
    // second row insert. MCP autowrite is path-scoped, so two same-dir
    // workspaces intentionally share one `.mcp.json` (documented trade-off).
    openNew: async (root: string) => {
      const workspace = await openWorkspaceNew(root, {
        rufloSupervisor,
        rufloHttpDaemonSupervisor,
        skillsManager,
        emit: (event, payload) => broadcast(event, payload),
        notifications: notificationsManager,
      });
      markWorkspaceOpened(workspace.id);
      return workspace;
    },
    list: async () => listWorkspaces(),
    rename: async (input: { id: string; name: string }) => {
      return renameWorkspace(input.id, input.name);
    },
    remove: async (id: string) => {
      await removeWorkspace(id, { rufloHttpDaemonSupervisor });
      markWorkspaceClosed(id);
    },
    launch: async (plan) => {
      const out = await executeLaunchPlan(plan, {
        pty,
        worktreePool,
        // C6 obs (HIGH fix) — supply the live notifications sink so a
        // disk-floor/cap refusal during launch fires a CRITICAL alert the
        // operator can actually see in a packaged app (console.warn is invisible
        // there). Without this thread, the disk-guard notification is a no-op.
        notifications: notificationsManager,
        // crash-classification IPC — fan out pty:error to all renderer windows
        // when an exit is classified as a crash (earlyDeath OR non-zero exitCode/signal).
        broadcastPtyError: (payload) => broadcast('pty:error', payload),
      });
      return { sessions: out.sessions };
    },
  });

  // P6 FEAT-11 — agent undo/rewind checkpoint methods. The logic lives in a
  // dependency-injected factory (core/git/checkpoint-controller.ts) so it is
  // unit-testable without booting the whole router; here we build it with the
  // live deps and spread the methods into gitCtl below.
  const checkpointCtl = buildGitCheckpointController({
    getDb,
    createCheckpoint,
    restoreCheckpoint,
    onChanged: (sessionId) => broadcast('git:checkpoints-changed', { sessionId }),
  });

  const gitCtl = defineController({
    status: async (cwd: string) => gitStatus(cwd),
    diff: async (cwd: string) => gitDiff(cwd),
    runCommand: async (cwd: string, line: string, timeoutMs?: number) => {
      // H-4 — the renderer supplies cwd; contain it to a workspace/worktree
      // root before running a shell line there (throws 'path outside workspace'
      // otherwise). The line itself is a git command run with shell:false.
      assertAllowedPath(cwd, fsAllowedRoots());
      return runShellLine(cwd, line, timeoutMs);
    },
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

    // BSP-G1 — GUI "Create Git Worktree". Over WorktreePool.create (which owns
    // the disk cap + statfs floor guards). The renderer supplies the repo root.
    worktreeCreate: async (input: { repoRoot: string; hint?: string; base?: string }) => {
      assertAllowedPath(input.repoRoot, fsAllowedRoots());
      return worktreeCreate(worktreePool, input);
    },

    // BSP-G3 — "open worktree in this (idle) pane". The openInPane controller
    // refuses a running pane (idle-only — never swap a live turn). Conservative
    // re-home: the pane's cwd/worktree is repointed in the DB (effective on the
    // next (re)spawn) and, for a plain SHELL pane, the live shell is nudged with
    // a `cd`. Agent CLIs ignore stdin `cd`, so their live PTY is intentionally
    // NOT mutated here (full live agent re-home is deferred — the documented
    // pane-state-corruption risk). idle-gate enforced by the controller.
    openInPane: async (input: { sessionId: string; worktreePath: string }) => {
      assertAllowedPath(input.worktreePath, fsAllowedRoots());
      return openInPane(
        {
          getSession: (id) => {
            const row = getRawDb()
              .prepare(
                'SELECT id, status, cwd, worktree_path AS worktreePath FROM agent_sessions WHERE id = ?',
              )
              .get(id) as
              | { id: string; status: string; cwd: string; worktreePath: string | null }
              | undefined;
            return row ?? null;
          },
          updateSessionCwd: (sessionId, cwd, worktreePath) => {
            getRawDb()
              .prepare('UPDATE agent_sessions SET cwd = ?, worktree_path = ? WHERE id = ?')
              .run(cwd, worktreePath, sessionId);
          },
          respawnInCwd: async (sessionId, cwd) => {
            const prov = (
              getRawDb()
                .prepare('SELECT provider_id AS p FROM agent_sessions WHERE id = ?')
                .get(sessionId) as { p?: string } | undefined
            )?.p;
            // Shell panes can be live-moved safely; agent panes pick up the new
            // cwd from the DB on their next spawn (no live stdin mutation).
            if (prov === 'shell') {
              try {
                pty.write(sessionId, ` cd ${JSON.stringify(cwd)}\n`);
              } catch {
                /* pane may already be gone */
              }
            }
          },
        },
        input,
      );
    },

    // ── P6 FEAT-11 — agent undo/rewind via worktree git checkpoints ──────
    // Delegated to the dependency-injected factory above; the renderer NEVER
    // passes a filesystem path — these resolve the worktree server-side.
    createCheckpoint: checkpointCtl.createCheckpoint,
    listCheckpoints: checkpointCtl.listCheckpoints,
    restoreCheckpoint: checkpointCtl.restoreCheckpoint,

    // ── P6 FEAT-8 — per-worktree git-activity heatmap ────────────────────
    // The renderer poller passes the worktree path; contain it to an allowed
    // workspace root (H-4) before traversing commit history there.
    activityLog: async (cwd: string, days?: number) => {
      assertAllowedPath(cwd, fsAllowedRoots());
      return gitActivityLog(cwd, days);
    },
  });

  const fsCtl = defineController({
    exists: async (p: string) => fs.existsSync(p),
    // V3-W14-007 — Editor tab. The controller bodies live in core/fs/controller.ts
    // so they can be unit-tested without spinning up the whole router.
    readDir: async (input: { path: string }) =>
      fsReadDir({ ...input, allowedRoots: fsAllowedRoots }),
    readFile: async (input: { path: string; maxBytes?: number }) =>
      fsReadFile({ ...input, allowedRoots: fsAllowedRoots }),
    writeFile: async (input: { path: string; content: string; repoRoot: string }) =>
      fsWriteFile({ ...input, allowedRoots: fsAllowedRoots }),
    // v1.4.2-06 — Storage panel: enumerate worktree dirs with sizes.
    getWorktreeSizes: async () => {
      const worktreesDir = path.join(app.getPath('userData'), 'worktrees');
      const result: {
        worktrees: Array<{ path: string; sizeBytes: number; repoHash: string; branchSeg: string }>;
        totalBytes: number;
      } = { worktrees: [], totalBytes: 0 };
      if (!fs.existsSync(worktreesDir)) return result;
      // PERF-8 — the directory walk runs on the main thread; use the async
      // fs.promises variants so the readdir/lstat syscalls don't block the
      // event loop before the (already-async) `dirSize` recursion.
      const repoHashes = await fs.promises.readdir(worktreesDir);
      for (const repoHash of repoHashes) {
        const repoDir = path.join(worktreesDir, repoHash);
        // H-16 — lstat (no-follow): a symlink here is skipped rather than
        // traversed off-tree, consistent with the hardened dirSize.
        if (!(await fs.promises.lstat(repoDir)).isDirectory()) continue;
        const branchSegs = await fs.promises.readdir(repoDir);
        for (const branchSeg of branchSegs) {
          const wtPath = path.join(repoDir, branchSeg);
          if (!(await fs.promises.lstat(wtPath)).isDirectory()) continue;
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
    // C6 obs (HIGH fix) — the swarm spawn paths (createSwarm /
    // materializeRosterAgent / addAgentToSwarm / splitPane) all surface a
    // disk-guard refusal as a CRITICAL notification; thread the live sink so
    // that alert reaches the operator instead of being a console-only no-op.
    notifications: notificationsManager,
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
  // R-1 — Telegram bridge taps `assistant:state` here so a remote operator
  // sees the same streamed reply. The assistant `emit` wrapper below fans out
  // to this set; the bridge subscribes/unsubscribes on start()/stop().
  const assistantStateSubscribers = new Set<(payload: unknown) => void>();
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
      // R-1 — fan `assistant:state` deltas out to the Telegram bridge so a
      // remote operator sees the same streamed reply. Best-effort + isolated
      // from the renderer broadcast above.
      if (event === 'assistant:state') {
        for (const sub of assistantStateSubscribers) {
          try {
            sub(payload);
          } catch {
            /* per-subscriber isolation */
          }
        }
      }
    },
    ruflo: rufloProxy,
    // H-19 — opportunistic aidefence proxy. Advisory inbound scan on every send
    // prompt; never blocks the local operator, never throws (the gate swallows
    // a Ruflo failure). Makes `Security: PENDING` → active at runtime.
    rufloCall: (tool, args) => rufloProxy.call(tool, args),
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
          // R-1 — the cast now accepts+forwards an optional `origin`
          // (default 'local'); the voice path omits it, so this stays
          // back-compatible while the Telegram bridge can pass 'telegram'.
          await (assistantCtl as {
            send: (i: {
              workspaceId: string;
              prompt: string;
              origin?: 'local' | 'telegram';
              confirmDangerous?: (toolName: string, summary: string) => Promise<boolean>;
            }) => Promise<unknown>;
          }).send({ workspaceId, prompt, origin: 'local' });
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

  // R-1 — Jorvis Telegram remote. SECURITY-CRITICAL. The bridge is INERT by
  // default and only starts when enabled + token + at-rest encryption +
  // non-empty allowlist all hold. The token never crosses IPC; the controller
  // exposes a write-only setter. The bridge subscribes to `assistant:state`
  // via the fan-out set above so a remote operator sees the streamed reply.
  const telegramKv = {
    get: (key: string): string | null => {
      try {
        const row = getRawDb()
          .prepare('SELECT value FROM kv WHERE key = ?')
          .get(key) as { value?: string } | undefined;
        return row?.value ?? null;
      } catch {
        return null;
      }
    },
    set: (key: string, value: string): void => {
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
  };
  const telegramBridge = new TelegramBridge({
    kv: telegramKv,
    credentials: CredentialStore,
    // Assistant seam via the same CAST pattern as the voice path's
    // assistantSend above — Lane H widens the real controller to honour
    // `origin` + `confirmDangerous`; until then this cast is the contract.
    assistant: {
      send: (input) =>
        (
          assistantCtl as {
            send: (i: {
              workspaceId: string;
              prompt: string;
              origin?: 'local' | 'telegram';
              confirmDangerous?: (t: string, s: string) => Promise<boolean>;
            }) => Promise<unknown>;
          }
        ).send(input),
    },
    subscribeAssistantState: (cb) => {
      assistantStateSubscribers.add(cb);
      return () => assistantStateSubscribers.delete(cb);
    },
    resolveDefaultWorkspaceId: () => {
      try {
        const row = getRawDb()
          .prepare('SELECT id FROM workspaces ORDER BY created_at ASC LIMIT 1')
          .get() as { id?: string } | undefined;
        return row?.id ?? null;
      } catch {
        return null;
      }
    },
    notifier: notificationsManager,
    rufloCall: (tool, args) => rufloProxy.call(tool, args),
    auditDir: path.join(app.getPath('userData'), 'remote-audit'),
  });
  const telegramCtl = buildTelegramController({
    bridge: telegramBridge,
    kv: telegramKv,
    credentials: CredentialStore,
  });
  // Expose the bridge to the shutdown path. `sharedDeps` was assigned earlier
  // in buildRouter(); we attach the late-constructed bridge here.
  if (sharedDeps) sharedDeps.telegramBridge = telegramBridge;
  // Attempt to start. start() self-gates and stays inert when preconditions
  // are unmet, so this is safe on every boot (including a fresh DMG).
  void telegramBridge.start().catch((err) => {
    console.warn(
      `[telegram] bridge start failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  });

  // P6 FEAT-3 — per-pane usage/cost rollups (reads the usage_ledger).
  const usageCtl = defineController(buildUsageController({ getDb }));

  // P6 FEAT-5 — MCP config diagnostics; raises an actionable bell per issue.
  const mcpCtl = defineController(
    buildMcpDiagnosticController({
      getDb,
      notify: {
        add: (input) =>
          notificationsManager.add({
            workspaceId: input.workspaceId,
            kind: input.kind,
            severity: input.severity,
            title: input.title,
            body: input.body,
            dedupKey: input.dedupKey,
          }),
      },
    }),
  );

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
    telegram: telegramCtl,
    usage: usageCtl,
    mcp: mcpCtl,
  });
}

/**
 * BUG-4 — single seam that registers an `ipcMain.handle` for `channel`, threads
 * the renderer's first positional arg through the per-channel zod input schema
 * (`validateChannelInput`, enforce mode), and wraps the result/error in the
 * stable `{ ok, data } | { ok, error, stack }` envelope. Both the typed
 * AppRouter loop AND every side-band loop (console / replay / sideBands) call
 * this, so a side-band channel can no longer skip input validation, and the
 * validate-then-handle pattern can't drift between the loops (grep-sibling
 * class). It only ADDS validation — the handler's response/envelope shape and
 * behaviour are untouched. The renderer invokes side-bands via
 * `window.sigma.invoke` with an envelope that is unwrapped before it reaches
 * here, so `args[0]` is already the INNER payload we validate (SF-12 lesson).
 */
function registerIpcHandler(
  channel: string,
  fn: (...args: unknown[]) => unknown,
  isDev: boolean,
): void {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      // Enforce the per-channel input schema at the boundary (no-op for
      // z.any()/unhardened channels; throws ZodError on a tightened channel's
      // malformed payload, converted to the error envelope below).
      args[0] = validateChannelInput(channel, args[0]);
      const out = await fn(...args);
      // ARCH-9 — fail-open output drift detection (logs once, returns the
      // original). Never converts a working response into an error.
      return { ok: true, data: validateChannelOutput(channel, out) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Include stack in dev for easier debugging, omit in production to avoid
      // leaking implementation details across IPC.
      const stack = isDev && err instanceof Error ? err.stack : undefined;
      return { ok: false, error: message, stack };
    }
  });
}

export async function registerRouter(): Promise<void> {
  if (router) return;
  router = await buildRouter();
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
      registerIpcHandler(`${ns}.${key}`, fn as (...a: unknown[]) => unknown, isDev);
    }
  }

  // V3-W12-014 — Register Operator Console side-band handlers under the
  // `swarm.<method>` namespace. These channels are NOT in the typed AppRouter
  // shape; foundations adds them to the rpc-channels.ts allowlist. Until
  // then, the preload still gates access via `isAllowedChannel` so unlisted
  // channels reject before reaching ipcMain.
  if (consoleHandlers) {
    for (const [key, fn] of Object.entries(consoleHandlers)) {
      // BUG-4 — route through the same validate-then-handle seam as the typed
      // router so the `swarm.*` console side-band can't bypass input validation.
      registerIpcHandler(`swarm.${key}`, fn, isDev);
    }
  }

  // P3-S6 — Persistent Swarm Replay handlers. Same envelope contract as the
  // console side-band; the channel ids land under `swarm.replay.<method>` so
  // the renderer's `swarm.replay.list` invocation routes here.
  if (replayHandlers) {
    for (const [key, fn] of Object.entries(replayHandlers)) {
      // BUG-4 — same validate-then-handle seam for `swarm.replay.*`.
      registerIpcHandler(`swarm.replay.${key}`, fn, isDev);
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
  // SF-13 — operator cleanup actions (`cleanup.*`). Destructive; every handler
  // defaults to dry-run UNLESS the caller passes `dryRun:false`, and the
  // cleanup core never deletes a worktree referenced by a live session.
  const cleanupWorktreeBase = (): string => path.join(app.getPath('userData'), 'worktrees');
  const cleanupRepoHash = (workspaceId: string): string | undefined => {
    const row = getRawDb()
      .prepare('SELECT repo_root FROM workspaces WHERE id = ?')
      .get(workspaceId) as { repo_root?: string | null } | undefined;
    return row?.repo_root ? computeRepoHash(row.repo_root) : undefined;
  };
  const cleanupHandlers: Record<string, (...args: unknown[]) => unknown> = {
    removeWorkspace: async (input: unknown) => {
      const a = (input as { workspaceId?: string; dryRun?: boolean }) ?? {};
      if (typeof a.workspaceId !== 'string' || !a.workspaceId) {
        throw new Error('cleanup.removeWorkspace: workspaceId required');
      }
      const dryRun = a.dryRun !== false; // safe default: dry-run unless explicit false
      if (!dryRun) {
        try {
          await getSharedDeps()?.rufloHttpDaemonSupervisor.stop(a.workspaceId);
        } catch {
          /* daemon stop is best-effort */
        }
      }
      return removeWorkspaceAndGc({
        workspaceId: a.workspaceId,
        worktreeBase: cleanupWorktreeBase(),
        repoHash: cleanupRepoHash(a.workspaceId),
        db: getRawDb(),
        dryRun,
      });
    },
    clearPanes: async (input: unknown) => {
      const a = (input as { workspaceId?: string; dryRun?: boolean }) ?? {};
      if (typeof a.workspaceId !== 'string' || !a.workspaceId) {
        throw new Error('cleanup.clearPanes: workspaceId required');
      }
      return clearPanesForWorkspace({
        workspaceId: a.workspaceId,
        db: getRawDb(),
        dryRun: a.dryRun !== false,
      });
    },
    pruneWorktrees: async (input: unknown) => {
      const a = (input as { workspaceId?: string; dryRun?: boolean }) ?? {};
      if (typeof a.workspaceId !== 'string' || !a.workspaceId) {
        throw new Error('cleanup.pruneWorktrees: workspaceId required');
      }
      const hash = cleanupRepoHash(a.workspaceId);
      if (!hash) return { wouldRemove: [], liveBlocked: [], removed: 0, errors: 0 };
      return pruneOrphanWorktreesForWorkspace({
        worktreeBase: cleanupWorktreeBase(),
        repoHash: hash,
        workspaceId: a.workspaceId,
        db: getRawDb(),
        dryRun: a.dryRun !== false,
      });
    },
  };
  const sideBands: Array<{ prefix: string; map: Record<string, (...args: unknown[]) => unknown> | null }> = [
    { prefix: 'assistant.conversations.', map: conversationsHandlers },
    { prefix: 'swarm.origin.', map: swarmOriginHandlers },
    { prefix: 'voice.diagnostics.', map: voiceDiagnosticsHandlers },
    // C-12 SigmaBench — `sigmabench.run` / `.listRuns` / `.getRun`.
    { prefix: 'sigmabench.', map: sigmabenchHandlers },
    // SF-13 — `cleanup.removeWorkspace` / `.clearPanes` / `.pruneWorktrees`.
    { prefix: 'cleanup.', map: cleanupHandlers },
  ];
  for (const band of sideBands) {
    if (!band.map) continue;
    for (const [key, fn] of Object.entries(band.map)) {
      // BUG-4 — route every side-band (`assistant.conversations.*`,
      // `swarm.origin.*`, `voice.diagnostics.*`, `sigmabench.*`, and the
      // DESTRUCTIVE `cleanup.*`) through the same validate-then-handle seam so
      // a malformed payload is rejected at the boundary before the handler runs.
      registerIpcHandler(`${band.prefix}${key}`, fn, isDev);
    }
  }
}

/**
 * Best-effort cleanup hooks for the Electron main bootstrap. Killing live
 * PTYs, closing the DB, and flushing WAL keeps quits graceful and prevents
 * orphan worktrees / zombie session rows after a normal shutdown.
 */
export async function shutdownRouter(): Promise<void> {
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
  // H-13 — AWAIT the drain (was fire-and-forget): the supervisor self-bounds at
  // ~5s (SIGTERM→drain→SIGKILL), so awaiting can't hang quit but DOES ensure the
  // daemons are reaped before the process exits (no orphaned HTTP servers).
  try {
    await sharedDeps?.rufloHttpDaemonSupervisor.stopAll();
  } catch {
    /* ignore */
  }
  // R-1 — stop the Telegram bridge (cancels long-poll, clears pending
  // confirmations, unsubscribes the assistant-state relay). Awaited for the
  // same reason (fast — just aborts the long-poll + clears timers).
  try {
    await sharedDeps?.telegramBridge?.stop();
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
    // PERF-1 — flush any buffered pty:data + cancel the coalescer timer.
    ptyDataCoalescerRef?.dispose();
    ptyDataCoalescerRef = null;
  } catch {
    /* ignore */
  }
  try {
    // P4.2 NTF-DIGEST — cancel the once-daily summary timer.
    sharedDeps?.dailyScheduler?.cancel();
  } catch {
    /* ignore */
  }
  try {
    // P4.2 — flush the last buffered digest bullets BEFORE the DB closes, then
    // cancel the debounce timer. flushNow writes via memoryManager.appendToMemory
    // (DB still open here); cancel() stops the pending setTimeout.
    await sharedDeps?.digestCollector?.flushNow();
  } catch {
    /* ignore */
  }
  try {
    sharedDeps?.digestCollector?.cancel();
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
