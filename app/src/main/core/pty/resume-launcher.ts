import type Database from 'better-sqlite3';
import type { PtyRegistry, SessionRecord } from './registry';
import type { AgentProviderDefinition } from '../../../shared/providers';
import type { resolveAndSpawn, ResolveAndSpawnResult } from '../providers/launcher';

export interface PaneResumeSuccess {
  sessionId: string;
  providerId: string;
  providerEffective: string;
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

export interface ResumeLauncherDeps {
  pty: PtyRegistry;
  db?: Database.Database;
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
    const earlyDeath = exitCode < 0 && Date.now() - startedMs < 1500;
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
         id,
         workspace_id AS workspaceId,
         provider_id AS providerId,
         provider_effective AS providerEffective,
         cwd,
         external_session_id AS externalSessionId
       FROM agent_sessions
       WHERE workspace_id = ?
         AND (
           status = 'running'
           OR (status = 'exited' AND exit_code = -1)
         )
       ORDER BY started_at ASC`,
    )
    .all(workspaceId) as ResumeRow[];
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
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
    const externalSessionId = row.externalSessionId?.trim();
    if (!externalSessionId) {
      markResumeFailed(db, row.id, now());
      result.failed.push({
        sessionId: row.id,
        providerId: resumeProviderId,
        externalSessionId: '',
        error: 'missing external_session_id; cannot resume pane',
      });
      continue;
    }

    const provider = await getProvider(resumeProviderId);
    if (!provider) {
      result.skipped.push({
        sessionId: row.id,
        providerId: resumeProviderId,
        reason: 'unknown-provider',
      });
      continue;
    }
    if (!provider.resumeArgs || provider.resumeArgs.length === 0) {
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
          cwd: row.cwd,
          cols: deps.cols ?? 120,
          rows: deps.rows ?? 32,
          showLegacy: deps.showLegacy ?? readShowLegacy(db),
          extraArgs: [...provider.resumeArgs, externalSessionId],
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
        externalSessionId,
        pid: rec.pid,
      });
    } catch (err) {
      const message = errorMessage(err);
      markResumeFailed(db, row.id, now());
      result.failed.push({
        sessionId: row.id,
        providerId: resumeProviderId,
        externalSessionId,
        error: message,
      });
    }
  }

  return result;
}
