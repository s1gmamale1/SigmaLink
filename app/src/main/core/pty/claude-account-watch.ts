// claude-account-watch.ts — claude account-switch propagation (2026-07-14)
//
// WHY: the claude CLI caches its OAuth credentials in an in-memory memo per
// process. Its staleness probe re-reads the store only when
// `~/.claude/.credentials.json`'s mtime changes — but on macOS the KEYCHAIN
// is the authoritative store, so a `/login` account switch never trips the
// probe and every already-running pane keeps serving the OLD account until
// its ~1h expiry check or a process restart (upstream: anthropics/claude-code
// #24317 / #54443 / #56339; no supported hot-reload exists — #36847, #23892).
// Worse, a stale pane's own token refresh can write old-account-derived
// tokens back over the fresh login (single shared slot, not account-aware).
//
// WHAT: watch `~/.claude.json` for an `oauthAccount` identity change (the
// only durable account-identity signal the CLI writes on login) and, on a
// switch, kill + resume every live claude pane in place (`--resume <id>`,
// same ghost-heal semantics as boot resume) so all panes adopt the new
// account immediately — which also closes the stale-refresh clobber window.
//
// Full investigation record: WISHLIST.md "Deep review findings (2026-07-14)".

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { ResolveAndSpawnResult } from '../providers/launcher';
import { providerPreAssignsSession } from '../providers/launcher';
import {
  ensureClaudeProjectDir,
  isClaudeSessionId,
  prepareClaudeResume,
  prepareClaudeWorkspaceContext,
} from './claude-resume-sigma';
import {
  attachExitPersistence,
  buildResumeArgs,
  markResumeFailed,
  markResumeRunning,
  readShowLegacy,
  readSpawnMode,
  setExternalSessionId,
  writeProviderEffective,
  type ResumeLauncherDeps,
} from './resume-launcher';

// ---------------------------------------------------------------------------
// Identity detection
// ---------------------------------------------------------------------------

export interface ClaudeAccountIdentity {
  /** `oauthAccount.accountUuid` — primary comparison key. */
  accountUuid: string;
  /** `oauthAccount.emailAddress` — fallback key + operator-facing label. */
  emailAddress: string;
}

export function defaultClaudeConfigPath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, '.claude.json');
}

/**
 * Read the current account identity from `~/.claude.json`. Returns null when
 * the file is missing/unparseable or holds no `oauthAccount` (logged out).
 * The file is ~160KB on a busy machine — a JSON.parse per mtime change is
 * cheap and only runs when the poll sees a stat delta.
 */
export function readClaudeAccountIdentity(
  configPath: string,
): ClaudeAccountIdentity | null {
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw) as {
      oauthAccount?: { accountUuid?: unknown; emailAddress?: unknown };
    };
    const acct = parsed?.oauthAccount;
    if (!acct || typeof acct !== 'object') return null;
    const accountUuid =
      typeof acct.accountUuid === 'string' ? acct.accountUuid : '';
    const emailAddress =
      typeof acct.emailAddress === 'string' ? acct.emailAddress : '';
    if (!accountUuid && !emailAddress) return null;
    return { accountUuid, emailAddress };
  } catch {
    return null;
  }
}

/**
 * A switch is a NON-NULL identity changing to a DIFFERENT non-null identity.
 * null transitions (logout, transient parse failure, first login) never fire:
 * panes running through a logout were already unauthenticated, and treating
 * transient-null → same-identity as a switch would restart panes spuriously.
 * `accountUuid` wins when both sides have one; email is the fallback key
 * (upstream #23906 notes /login can leave oauthAccount partially stale).
 */
export function identitySwitched(
  prev: ClaudeAccountIdentity | null,
  next: ClaudeAccountIdentity | null,
): boolean {
  if (!prev || !next) return false;
  if (prev.accountUuid && next.accountUuid) {
    return prev.accountUuid !== next.accountUuid;
  }
  return prev.emailAddress !== next.emailAddress;
}

export interface ClaudeAccountWatcher {
  start(): void;
  stop(): void;
  /** Run one detection pass now (also the test seam — no timers needed). */
  checkNow(): void;
}

export interface ClaudeAccountWatcherOptions {
  onSwitch: (next: ClaudeAccountIdentity, prev: ClaudeAccountIdentity) => void;
  configPath?: string;
  /** fs.watchFile poll interval; default 2s (identity adoption, not hot-path). */
  intervalMs?: number;
}

/**
 * Poll-watch `~/.claude.json` for an account-identity change. `fs.watchFile`
 * (stat polling) survives the rename-replace writes CLIs use, where an
 * inode-bound `fs.watch` would silently die after the first swap.
 */
export function createClaudeAccountWatcher(
  opts: ClaudeAccountWatcherOptions,
): ClaudeAccountWatcher {
  const configPath = opts.configPath ?? defaultClaudeConfigPath();
  const intervalMs = opts.intervalMs ?? 2_000;
  let last: ClaudeAccountIdentity | null = null;
  let started = false;

  const checkNow = () => {
    const next = readClaudeAccountIdentity(configPath);
    const prev = last;
    // Never regress the baseline to null: a transient unreadable/parse-failed
    // read must not make the NEXT good read of the SAME account look like a
    // switch (identitySwitched already ignores null, so keeping `prev` is the
    // whole defence).
    if (next) last = next;
    if (identitySwitched(prev, next)) {
      opts.onSwitch(next as ClaudeAccountIdentity, prev as ClaudeAccountIdentity);
    }
  };

  const listener = () => {
    try {
      checkNow();
    } catch {
      /* a detection pass must never throw into the StatWatcher */
    }
  };

  return {
    start() {
      if (started) return;
      started = true;
      last = readClaudeAccountIdentity(configPath);
      fs.watchFile(configPath, { interval: intervalMs }, listener);
    },
    stop() {
      if (!started) return;
      started = false;
      fs.unwatchFile(configPath, listener);
    },
    checkNow,
  };
}

// ---------------------------------------------------------------------------
// Live-pane restart (adopt the new account)
// ---------------------------------------------------------------------------

export interface AccountSwitchRestartResult {
  restarted: number;
  failed: number;
  skipped: number;
  /**
   * Workspaces whose panes were touched — the renderer refetches these so the
   * restarted (briefly 'exited') panes re-upsert as running before the
   * exited-session GC can drop them from the grid.
   */
  workspaceIds: string[];
}

/** KV gate for the auto-restart behaviour; anything but '0' means ON. */
export const KV_CLAUDE_ACCOUNT_AUTORESTART = 'claude.accountSwitch.autoRestart';

export type AccountSwitchRestartDeps = ResumeLauncherDeps & {
  /** How long to wait for a killed PTY to actually die; test seam. */
  killWaitMs?: number;
};

interface LiveClaudeRow {
  id: string;
  workspaceId: string;
  providerId: string;
  providerEffective: string | null;
  cwd: string;
  workspaceRoot: string;
  externalSessionId: string | null;
  autoApprove: number | null;
}

function listLiveClaudeRows(db: Database.Database): LiveClaudeRow[] {
  return db
    .prepare(
      `SELECT
         s.id,
         s.workspace_id AS workspaceId,
         s.provider_id AS providerId,
         s.provider_effective AS providerEffective,
         s.cwd,
         w.root_path AS workspaceRoot,
         s.external_session_id AS externalSessionId,
         s.auto_approve AS autoApprove
       FROM agent_sessions s
       JOIN workspaces w ON w.id = s.workspace_id
       WHERE s.closed_at IS NULL
         AND s.status = 'running'
         AND COALESCE(s.provider_effective, s.provider_id) = 'claude'
       ORDER BY s.started_at ASC`,
    )
    .all() as LiveClaudeRow[];
}

async function waitForDead(
  pty: ResumeLauncherDeps['pty'],
  id: string,
  timeoutMs: number,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const rec = pty.get(id);
    if (!rec || !rec.alive) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !(pty.get(id)?.alive ?? false);
}

async function getDefaultRawDb(): Promise<Database.Database> {
  const mod = await import('../db/client');
  return mod.getRawDb();
}

async function getDefaultResolve() {
  const mod = await import('../providers/launcher');
  return mod.resolveAndSpawn;
}

/**
 * Kill + resume-in-place every LIVE claude pane so its fresh process reads
 * the just-switched credentials. Mirrors resumeWorkspacePanes' claude branch
 * (id-or-fresh, ghost-heal via pre-assigned --session-id) but:
 *   - operates ONLY on registry-alive claude panes, across ALL workspaces;
 *   - marks each pane's kill as an EXPECTED exit first (registry flag), so
 *     the three crash classifiers + pane-event sinks don't report a crash;
 *   - skips cwd/worktree recreation — a running pane's cwd exists by
 *     definition (its process is executing in it).
 * The pane the operator ran /login in restarts too: its resumed process is
 * on the same new account, and "every claude pane is on the current account"
 * is the invariant worth a 1-2s TUI reload (deferral polish is WISHLISTed).
 */
export async function restartLiveClaudePanes(
  deps: AccountSwitchRestartDeps,
): Promise<AccountSwitchRestartResult> {
  const db = deps.db ?? (await getDefaultRawDb());
  const now = deps.now ?? Date.now;
  const resolve = deps.resolve ?? (await getDefaultResolve());
  const spawnMode = readSpawnMode(db);
  const killWaitMs = deps.killWaitMs ?? 5_000;
  const result: AccountSwitchRestartResult = {
    restarted: 0,
    failed: 0,
    skipped: 0,
    workspaceIds: [],
  };
  const touchedWorkspaces = new Set<string>();

  for (const row of listLiveClaudeRows(db)) {
    const rec = deps.pty.get(row.id);
    if (!rec?.alive) {
      // DB says running but the registry disagrees (exit in flight) — the
      // normal exit/resume lifecycle owns this row, not the account switch.
      result.skipped += 1;
      continue;
    }
    deps.pty.markExpectedExit(row.id);
    deps.pty.kill(row.id);
    if (!(await waitForDead(deps.pty, row.id, killWaitMs))) {
      // Never spawn a twin on top of a process that refused to die.
      result.failed += 1;
      continue;
    }

    let externalSessionId = row.externalSessionId?.trim() ?? null;
    try {
      await prepareClaudeWorkspaceContext(row.workspaceRoot, row.cwd, {
        homeDir: deps.claudeHomeDir,
      });
      if (externalSessionId && !isClaudeSessionId(externalSessionId)) {
        externalSessionId = null;
      }
      if (externalSessionId) {
        const bridge = await prepareClaudeResume(
          row.workspaceRoot,
          row.cwd,
          externalSessionId,
          { homeDir: deps.claudeHomeDir },
        );
        if (bridge === 'missing') externalSessionId = null;
      }
      await ensureClaudeProjectDir(row.cwd, { homeDir: deps.claudeHomeDir });

      const resume = buildResumeArgs('claude', externalSessionId);
      if (!resume) {
        result.skipped += 1;
        continue;
      }
      // Ghost-heal parity with resumeWorkspacePanes: a null/ghost id spawns
      // FRESH with a pre-assigned --session-id that is stamped back below.
      const freshFallback = resume.args.length === 0;
      const healViaPreAssign = freshFallback && providerPreAssignsSession('claude');
      if (healViaPreAssign) setExternalSessionId(db, row.id, null);

      const spawned: ResolveAndSpawnResult = resolve(
        { ptyRegistry: deps.pty },
        {
          providerId: 'claude',
          ...(healViaPreAssign
            ? { preassignedSessionId: row.id, isResume: false as const }
            : { sessionId: row.id, isResume: true as const }),
          cwd: row.cwd,
          cols: deps.cols ?? 120,
          rows: deps.rows ?? 32,
          showLegacy: deps.showLegacy ?? readShowLegacy(db),
          extraArgs: resume.args,
          autoApprove: row.autoApprove === 1,
          spawnMode,
        },
      );
      markResumeRunning(db, row.id, spawned.ptySession.startedAt);
      writeProviderEffective(db, row.id, spawned.providerEffective);
      attachExitPersistence(db, row.id, spawned.ptySession, deps.broadcastPtyError);
      if (healViaPreAssign && spawned.preassignedExternalSessionId) {
        setExternalSessionId(db, row.id, spawned.preassignedExternalSessionId);
      }
      result.restarted += 1;
      touchedWorkspaces.add(row.workspaceId);
    } catch {
      // Keep the row in the exited/-1 respawn bucket so the operator's
      // "Respawn fresh" toast action can recover it.
      markResumeFailed(db, row.id, now());
      result.failed += 1;
      touchedWorkspaces.add(row.workspaceId);
    }
  }
  result.workspaceIds = Array.from(touchedWorkspaces);
  return result;
}
