import type Database from 'better-sqlite3';
import type { PtyRegistry, SessionRecord } from './registry';
import type { AgentProviderDefinition } from '../../../shared/providers';
import type { resolveAndSpawn, ResolveAndSpawnResult } from '../providers/launcher';
import {
  ensureClaudeProjectDir,
  isClaudeSessionId,
  prepareClaudeResume,
  prepareClaudeWorkspaceContext,
} from './claude-resume-bridge';
import {
  ensureGeminiProjectDir,
  prepareGeminiResume,
} from './gemini-resume-bridge';
import { workspaceCwdInWorktree } from '../workspaces/worktree-cwd';

export interface PaneResumeSuccess {
  sessionId: string;
  providerId: string;
  providerEffective: string;
  /** Empty string when the resume took the universal `--continue` fallback. */
  externalSessionId: string;
  /** v1.2.8 — `'id'` when resumed by captured external id; `'continue'` when
   *  the universal fallback (--continue / --resume latest / resume --last) was
   *  used because no external id was on file. The renderer surfaces this as a
   *  hint in the resume toast. */
  resumeMode: 'id' | 'continue';
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
      return id
        ? { args: ['--resume', id], mode: 'id' }
        : { args: ['--resume', 'latest'], mode: 'continue' };
    case 'kimi':
      return id
        ? { args: ['--session', id], mode: 'id' }
        : { args: ['--continue'], mode: 'continue' };
    case 'opencode':
      return id
        ? { args: ['--session', id], mode: 'id' }
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
         s.external_session_id AS externalSessionId
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

export async function resumeWorkspacePanes(
  workspaceId: string,
  deps: ResumeLauncherDeps,
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

  const rows = listEligibleRows(db, workspaceId);
  for (const row of rows) {
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
    // v1.4.3-01 — Gemini boot-restore path. Mirror the claude branch above:
    // alias the worktree cwd to the workspace slug so gemini reads the same
    // chats directory. If the workspace slug has no sessions ('missing'),
    // drop the external session id so buildResumeArgs falls through to
    // '--resume latest' — which will still fail gracefully (empty chats dir
    // is handled by ensureGeminiProjectDir pre-creating it).
    if (resumeProviderId === 'gemini') {
      const bridge = await prepareGeminiResume(row.workspaceRoot, cwd, {
        homeDir: deps.claudeHomeDir,
      });
      if (bridge === 'missing') {
        externalSessionId = null;
      }
      await ensureGeminiProjectDir(cwd, row.workspaceRoot, {
        homeDir: deps.claudeHomeDir,
      });
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
        resumeMode: resume.mode,
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
