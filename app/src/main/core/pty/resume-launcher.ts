import type Database from 'better-sqlite3';
import type { PtyRegistry, SessionRecord } from './registry';
import type { AgentProviderDefinition } from '../../../shared/providers';
import type { resolveAndSpawn, ResolveAndSpawnResult } from '../providers/launcher';
import {
  ensureClaudeProjectDir,
  isClaudeSessionId,
  prepareClaudeResume,
  prepareClaudeWorkspaceContext,
} from './claude-resume-sigma';
import {
  ensureGeminiProjectDir,
  prepareGeminiResume,
} from './gemini-resume-sigma';
import { workspaceCwdInWorktree } from '../workspaces/worktree-cwd';

export interface PaneResumeSuccess {
  sessionId: string;
  providerId: string;
  providerEffective: string;
  /** Empty string when the resume took the universal `--continue` fallback. */
  externalSessionId: string;
  pid: number;
}

export interface PaneResumeFailure {
  sessionId: string;
  providerId: string;
  externalSessionId: string;
  error: string;
}

export interface PaneResumeSkipped {
  sessionId: string;
  providerId: string;
  reason: string;
}

export interface PaneResumeResult {
  workspaceId: string;
  resumed: PaneResumeSuccess[];
  failed: PaneResumeFailure[];
  skipped: PaneResumeSkipped[];
}

/**
 * v1.2.8 — per-provider resume argv builder. Two flavours per provider:
 *   - by-id: when we captured an `external_session_id`, use the provider's
 *     native resume flag (`claude --resume <id>`, `codex resume <id>`, …).
 *   - continue: universal "resume latest in cwd" fallback. Every shipped CLI
 *     supports one; missing `external_session_id` is no longer a failure —
 *     it just routes to this branch.
 *
 * Returns `null` when the provider has no known resume strategy at all (only
 * the internal `shell`/`custom` sentinels in practice); the caller treats
 * that as `skipped` rather than `failed`.
 */
export function buildResumeArgs(
  providerId: string,
  externalSessionId: string | null,
): { args: string[]; mode: 'id' | 'continue' } | null {
  const id = externalSessionId?.trim();
  switch (providerId.toLowerCase()) {
    case 'claude':
      return id
        ? { args: ['--resume', id], mode: 'id' }
        : { args: ['--continue'], mode: 'continue' };
    case 'codex':
      return id
        ? { args: ['resume', id], mode: 'id' }
        : { args: ['resume', '--last'], mode: 'continue' };
    case 'gemini':
      // Gemini's --resume flag only accepts 'latest' or an index number, NOT a
      // filename stem. The session-disk-scanner stores the JSONL filename stem as
      // external_session_id for history display only; the projects.json alias
      // bridge (gemini-resume-sigma.ts) maps the worktree cwd to the workspace
      // slug so '--resume latest' resolves against the SAME chats directory the
      // picked session lives in.
      //
      // B2 fix — the prior code returned `--resume latest` UNCONDITIONALLY,
      // even when `externalSessionId` is null. A null id means "no session was
      // picked / the bridge was 'missing'" — in that case `--resume latest`
      // fell through to gemini's GLOBAL newest session (a DIFFERENT project),
      // silently resuming the wrong conversation. The caller only ever passes
      // a non-null id here AFTER the projects.json alias has been registered
      // (slug truly has the picked session), so:
      //   * id present → resume the aliased workspace slug via `--resume latest`.
      //   * id null    → spawn FRESH (no --resume arg) instead of latching onto
      //                  a foreign global session.
      // See: session-disk-scanner.ts (listGeminiSessions) and the launcher /
      // resumeWorkspacePanes gemini branches that gate ensure/alias on bridge
      // !== 'missing'.
      return id
        ? { args: ['--resume', 'latest'], mode: 'continue' }
        : { args: [], mode: 'continue' };
    case 'kimi':
      return id
        ? { args: ['--session', id], mode: 'id' }
        : { args: ['--continue'], mode: 'continue' };
    case 'opencode':
      return id
        ? { args: ['--session', id], mode: 'id' }
        : { args: ['--continue'], mode: 'continue' };
    case 'cursor':
      // R-2 — cursor-agent supports `--resume [chatId]` (select a session by id)
      // and `--continue` (resume latest in cwd). Cursor sessions are not scanned
      // off disk (cursor is NOT in DISK_SCAN_PROVIDERS), so `externalSessionId`
      // is only populated if a future capture path records one; until then the
      // `--continue` fallback is the live path. Mirrors claude's flag shape.
      return id
        ? { args: ['--resume', id], mode: 'id' }
        : { args: ['--continue'], mode: 'continue' };
    default:
      return null;
  }
}

export interface ResumeLauncherDeps {
  pty: PtyRegistry;
  db?: Database.Database;
  claudeHomeDir?: string;
  now?: () => number;
  cols?: number;
  rows?: number;
  showLegacy?: boolean;
  resolve?: typeof resolveAndSpawn;
  getProvider?: (
    id: string,
  ) => AgentProviderDefinition | undefined | Promise<AgentProviderDefinition | undefined>;
  /**
   * v1.9-scrollback (DEFAULT-OFF feature) — when the caller has loaded
   * persisted scrollback for a session, provide a function that maps a
   * session id to its scrollback text. Only wired when the KV flag is 'on'.
   * Absent → no-op for every session.
   */
  loadScrollbackForSession?: (sessionId: string) => string;
}

async function getDefaultRawDb(): Promise<Database.Database> {
  const mod = await import('../db/client');
  return mod.getRawDb();
}

async function getDefaultProvider(
  id: string,
): Promise<AgentProviderDefinition | undefined> {
  const mod = await import('../../../shared/providers');
  return mod.findProvider(id);
}

async function getDefaultResolve(): Promise<typeof resolveAndSpawn> {
  const mod = await import('../providers/launcher');
  return mod.resolveAndSpawn;
}

interface ResumeRow {
  id: string;
  workspaceId: string;
  providerId: string;
  providerEffective: string | null;
  cwd: string;
  worktreePath: string | null;
  workspaceRoot: string;
  repoRoot: string | null;
  externalSessionId: string | null;
  /** SF-8 Yolo/Bypass — persisted 0/1 flag; re-applied on every resume. */
  autoApprove: number | null;
}

function readShowLegacy(db: Database.Database): boolean {
  try {
    const row = db
      .prepare('SELECT value FROM kv WHERE key = ?')
      .get('providers.showLegacy') as { value?: string } | undefined;
    return row?.value === '1' || row?.value === 'true';
  } catch {
    return false;
  }
}

function writeProviderEffective(
  db: Database.Database,
  sessionId: string,
  providerEffective: string,
): void {
  try {
    db.prepare('UPDATE agent_sessions SET provider_effective = ? WHERE id = ?')
      .run(providerEffective, sessionId);
  } catch {
    /* column may not exist on a pre-0010 DB; ignore */
  }
}

function markResumeFailed(
  db: Database.Database,
  sessionId: string,
  now: number,
): void {
  try {
    db.prepare(
      `UPDATE agent_sessions
       SET status = 'exited', exit_code = -1, exited_at = ?
       WHERE id = ?`,
    ).run(now, sessionId);
  } catch {
    /* best-effort; caller still returns failure details */
  }
}

function markResumeRunning(
  db: Database.Database,
  sessionId: string,
  startedAt: number,
): void {
  db.prepare(
    `UPDATE agent_sessions
     SET status = 'running', exit_code = NULL, exited_at = NULL, started_at = ?
     WHERE id = ?`,
  ).run(startedAt, sessionId);
}

function attachExitPersistence(
  db: Database.Database,
  sessionId: string,
  rec: SessionRecord,
): void {
  const startedMs = rec.startedAt;
  rec.pty.onExit(({ exitCode }) => {
    // Treat any exit within 1.5s of spawn as a launch failure ('error').
    // This catches both synthetic ENOENT failures (exitCode < 0) and real
    // CLI crashes (e.g. Claude exiting with code 1 on bad resume).
    const earlyDeath = Date.now() - startedMs < 1500;
    try {
      db.prepare(
        `UPDATE agent_sessions
         SET status = ?, exit_code = ?, exited_at = ?
         WHERE id = ?`,
      ).run(earlyDeath ? 'error' : 'exited', exitCode, Date.now(), sessionId);
    } catch {
      /* db may be closing during shutdown */
    }
  });
}

function listEligibleRows(db: Database.Database, workspaceId: string): ResumeRow[] {
  return db
    .prepare(
      `SELECT
         s.id,
         s.workspace_id AS workspaceId,
         s.provider_id AS providerId,
         s.provider_effective AS providerEffective,
         s.cwd,
         s.worktree_path AS worktreePath,
         w.root_path AS workspaceRoot,
         w.repo_root AS repoRoot,
         s.external_session_id AS externalSessionId,
         s.auto_approve AS autoApprove
       FROM agent_sessions s
       JOIN workspaces w ON w.id = s.workspace_id
       WHERE s.workspace_id = ?
         AND (
           s.status = 'running'
           OR (s.status = 'exited' AND s.exit_code = -1)
         )
       ORDER BY s.started_at ASC`,
    )
    .all(workspaceId) as ResumeRow[];
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// v1.2.8 — "Respawn fresh" recovery. When the resume flow marks rows as
// `status='exited', exit_code=-1` (the failed-resume marker), the renderer
// surfaces a single aggregated toast with a "Respawn fresh" action. Clicking
// the action invokes `panes.respawnFailed(workspaceId)`, which re-uses the
// existing worktree + cwd + providerEffective on each failed row and spawns a
// brand-new PTY (no `--resume` / `--continue`) in-place. The DB row is
// updated to `running` with a fresh `started_at`; on spawn failure the row is
// re-marked failed so a follow-up retry stays idempotent.
export interface PaneRespawnResult {
  workspaceId: string;
  spawned: number;
  failed: number;
}

interface RespawnRow {
  id: string;
  providerId: string;
  providerEffective: string | null;
  cwd: string;
  worktreePath: string | null;
  workspaceRoot: string;
  repoRoot: string | null;
}

function listRespawnableRows(
  db: Database.Database,
  workspaceId: string,
): RespawnRow[] {
  // Failed-resume marker: `markResumeFailed` writes `status='exited' AND
  // exit_code=-1`. We deliberately do NOT include rows whose exit_code is 0 or
  // a positive provider exit — those represent a clean process death, not a
  // resume failure, and the user would expect them to stay closed.
  return db
    .prepare(
      `SELECT
         s.id,
         s.provider_id AS providerId,
         s.provider_effective AS providerEffective,
         s.cwd,
         s.worktree_path AS worktreePath,
         w.root_path AS workspaceRoot,
         w.repo_root AS repoRoot
       FROM agent_sessions s
       JOIN workspaces w ON w.id = s.workspace_id
       WHERE s.workspace_id = ?
         AND s.status = 'exited'
         AND s.exit_code = -1
       ORDER BY s.started_at ASC`,
    )
    .all(workspaceId) as RespawnRow[];
}

/**
 * Re-spawn every pane in `workspaceId` that the resume flow previously marked
 * as `status='exited' AND exit_code=-1`. Each row is re-launched fresh in its
 * existing `cwd` using the resolved `providerEffective` (falling back to
 * `providerId`) with NO resume args, so the worktree + branch stay intact but
 * the operator gets a clean PTY in them. Returns counts so the renderer can
 * toast a follow-up.
 */
export async function respawnFailedWorkspacePanes(
  workspaceId: string,
  deps: ResumeLauncherDeps,
): Promise<PaneRespawnResult> {
  const db = deps.db ?? (await getDefaultRawDb());
  const now = deps.now ?? Date.now;
  const resolve = deps.resolve ?? (await getDefaultResolve());

  const rows = listRespawnableRows(db, workspaceId);
  let spawned = 0;
  let failed = 0;

  for (const row of rows) {
    const providerId = row.providerEffective ?? row.providerId;
    const cwd = workspaceCwdInWorktree({
      workspaceRoot: row.workspaceRoot,
      repoRoot: row.repoRoot,
      worktreePath: row.worktreePath,
    });
    try {
      if (providerId === 'claude') {
        await prepareClaudeWorkspaceContext(row.workspaceRoot, cwd, {
          homeDir: deps.claudeHomeDir,
        });
        await ensureClaudeProjectDir(cwd, { homeDir: deps.claudeHomeDir });
      }
      // v1.4.3-01 — ensure gemini project dir exists before a fresh respawn
      // so the first write to the chats dir succeeds.
      if (providerId === 'gemini') {
        await ensureGeminiProjectDir(cwd, row.workspaceRoot, {
          homeDir: deps.claudeHomeDir,
        });
      }
      const result: ResolveAndSpawnResult = resolve(
        { ptyRegistry: deps.pty },
        {
          providerId,
          sessionId: row.id,
          cwd,
          cols: deps.cols ?? 120,
          rows: deps.rows ?? 32,
          showLegacy: deps.showLegacy ?? readShowLegacy(db),
          // No resumeArgs — this is a fresh spawn in the same worktree.
          extraArgs: [],
          // v1.5.5 — explicit resume flag: sessionId reuses the existing DB
          // row, so this IS a resume even though no --resume/--continue arg
          // is passed. Suppresses the redundant onPostSpawnCapture disk-scan.
          isResume: true,
        },
      );
      const rec = result.ptySession;
      markResumeRunning(db, row.id, rec.startedAt);
      writeProviderEffective(db, row.id, result.providerEffective);
      attachExitPersistence(db, row.id, rec);
      spawned += 1;
    } catch {
      // Re-mark failure so the row stays in the bucket for a future retry.
      markResumeFailed(db, row.id, now());
      failed += 1;
    }
  }

  return { workspaceId, spawned, failed };
}

/**
 * P6 FEAT-1 — optional subset allowlist for an on-demand "Resume agents…"
 * relaunch. When `sessionIds` is provided, only the eligible rows whose `id`
 * appears in the set are resumed; every other eligible row is left untouched
 * (NOT marked skipped — it is simply out of scope for this relaunch). When
 * `sessionIds` is omitted (the default — including the boot auto-resume path),
 * EVERY eligible row resumes exactly as before, so existing behaviour is
 * unchanged. An empty `sessionIds` array resumes nothing.
 */
export async function resumeWorkspacePanes(
  workspaceId: string,
  deps: ResumeLauncherDeps,
  sessionIds?: string[],
): Promise<PaneResumeResult> {
  const db = deps.db ?? await getDefaultRawDb();
  const now = deps.now ?? Date.now;
  const resolve = deps.resolve ?? await getDefaultResolve();
  const getProvider = deps.getProvider ?? getDefaultProvider;
  const result: PaneResumeResult = {
    workspaceId,
    resumed: [],
    failed: [],
    skipped: [],
  };

  // P6 FEAT-1 — when a subset is supplied, gate the eligible-row loop on
  // membership. `undefined` ⇒ resume all eligible (boot/full behaviour).
  const subset = sessionIds ? new Set(sessionIds) : null;

  const rows = listEligibleRows(db, workspaceId);
  for (const row of rows) {
    if (subset && !subset.has(row.id)) continue;
    const live = deps.pty.get(row.id);
    if (live?.alive) {
      result.skipped.push({
        sessionId: row.id,
        providerId: row.providerId,
        reason: 'already-running',
      });
      continue;
    }

    const resumeProviderId = row.providerEffective ?? row.providerId;
    let externalSessionId = row.externalSessionId?.trim() ?? null;
    const cwd = workspaceCwdInWorktree({
      workspaceRoot: row.workspaceRoot,
      repoRoot: row.repoRoot,
      worktreePath: row.worktreePath,
    });

    // v1.2.8 — the provider definition is only consulted for the unknown-
    // provider skip path. Resume argv is built locally by `buildResumeArgs`
    // so the new universal `--continue` fallback applies even to providers
    // whose registry entry still has `resumeArgs` undefined (e.g. gemini,
    // kimi, opencode before this wave).
    const provider = await getProvider(resumeProviderId);
    if (!provider) {
      result.skipped.push({
        sessionId: row.id,
        providerId: resumeProviderId,
        reason: 'unknown-provider',
      });
      continue;
    }
    if (resumeProviderId === 'claude') {
      await prepareClaudeWorkspaceContext(row.workspaceRoot, cwd, {
        homeDir: deps.claudeHomeDir,
      });
      if (externalSessionId && !isClaudeSessionId(externalSessionId)) {
        externalSessionId = null;
      }
      if (externalSessionId) {
        const bridge = await prepareClaudeResume(
          row.workspaceRoot,
          cwd,
          externalSessionId,
          { homeDir: deps.claudeHomeDir },
        );
        if (bridge === 'missing') {
          externalSessionId = null;
        }
      }
      await ensureClaudeProjectDir(cwd, { homeDir: deps.claudeHomeDir });
    }
    // v1.4.3-01 / B2 — Gemini boot-restore path. Mirror the claude branch
    // above AND the workspace launcher's gemini branch:
    //   * Bridge resolves (workspace slug HAS the session) → alias worktreeCwd
    //     → workspaceSlug so `--resume latest` reads that chats directory.
    //   * Bridge 'missing' (workspace slug has no sessions) → drop the external
    //     id so buildResumeArgs emits NO --resume (fresh spawn) instead of
    //     `--resume latest`, which previously fell through to gemini's GLOBAL
    //     newest session (a DIFFERENT project). On the fresh path we pre-create
    //     gemini's OWN worktree-slug dir WITHOUT aliasing so a new session does
    //     not write into the workspace's history.
    if (resumeProviderId === 'gemini') {
      const bridge = await prepareGeminiResume(row.workspaceRoot, cwd, {
        homeDir: deps.claudeHomeDir,
      });
      if (bridge === 'missing') {
        externalSessionId = null;
      }
      if (externalSessionId) {
        await ensureGeminiProjectDir(cwd, row.workspaceRoot, {
          homeDir: deps.claudeHomeDir,
        });
      } else {
        await ensureGeminiProjectDir(cwd, cwd, {
          homeDir: deps.claudeHomeDir,
        });
      }
    }

    const resume = buildResumeArgs(resumeProviderId, externalSessionId);
    if (!resume) {
      // Internal sentinels (shell / custom) — nothing to resume.
      result.skipped.push({
        sessionId: row.id,
        providerId: resumeProviderId,
        reason: 'provider-has-no-resume-args',
      });
      continue;
    }

    try {
      const spawned: ResolveAndSpawnResult = resolve(
        { ptyRegistry: deps.pty },
        {
          providerId: resumeProviderId,
          sessionId: row.id,
          cwd,
          cols: deps.cols ?? 120,
          rows: deps.rows ?? 32,
          showLegacy: deps.showLegacy ?? readShowLegacy(db),
          extraArgs: resume.args,
          // v1.5.5 — explicit resume flag. Suppresses the redundant
          // onPostSpawnCapture disk-scan; the DB row already carries the
          // external_session_id from the original spawn.
          isResume: true,
          // v1.9-scrollback — load persisted scrollback when the flag is on.
          resumeScrollback: deps.loadScrollbackForSession?.(row.id),
          // SF-8 Yolo/Bypass — re-apply the persisted bypass flag so the
          // provider's autoApproveFlag is appended to argv on every resume.
          autoApprove: row.autoApprove === 1,
        },
      );
      const rec = spawned.ptySession;
      markResumeRunning(db, row.id, rec.startedAt);
      writeProviderEffective(db, row.id, spawned.providerEffective);
      attachExitPersistence(db, row.id, rec);
      result.resumed.push({
        sessionId: row.id,
        providerId: row.providerId,
        providerEffective: spawned.providerEffective,
        externalSessionId: externalSessionId ?? '',
        pid: rec.pid,
      });
    } catch (err) {
      const message = errorMessage(err);
      markResumeFailed(db, row.id, now());
      result.failed.push({
        sessionId: row.id,
        providerId: resumeProviderId,
        externalSessionId: externalSessionId ?? '',
        error: message,
      });
    }
  }

  return result;
}
