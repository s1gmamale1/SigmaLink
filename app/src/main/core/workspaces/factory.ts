// Workspace persistence + repo-mode detection.

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb, getRawDb } from '../db/client';
import { agentSessions, workspaces } from '../db/schema';
import { getRepoRoot } from '../git/git-ops';
import { KV_RUFLO_AUTOWRITE_MCP, KV_RUFLO_AUTOTRUST_MCP, writeWorkspaceMcpConfig } from './mcp-autowrite';
import { ensureRufloTrusted } from './mcp-trust';
import { maybeNotifyStdioFallback, type StdioFallbackNotificationInput } from './ruflo-fallback-notice';
import { seedWorkspaceMemory } from '../ruflo/seed-workspace-memory';
import type { RufloMcpSupervisor } from '../ruflo/supervisor';
import type { RufloHttpDaemonSupervisor } from '../ruflo/http-daemon-supervisor';
import type { PtyRegistry } from '../pty/registry';
import {
  KV_RUFLO_STRICT_MCP_VERIFICATION,
  verifyForWorkspace,
  type RufloVerifyMode,
} from '../ruflo/verify';
import type { SkillsManager } from '../skills/manager';
import type { Workspace } from '../../../shared/types';
import { DEV_WORKSPACE_KV_KEY, DEV_WORKSPACE_NAME } from '../../../shared/special-workspace';

export interface OpenWorkspaceDeps {
  rufloSupervisor?: Pick<RufloMcpSupervisor, 'ensureStarted'>;
  skillsManager?: Pick<SkillsManager, 'verifyFanoutForWorkspace'>;
  /** v1.6.0-A — per-workspace Ruflo HTTP daemon. When provided, openWorkspace
   *  spawns a daemon and the mcp-autowrite writes HTTP entries pointing at it.
   *  When omitted (or spawn fails), autowrite falls through to stdio entries
   *  unchanged. */
  rufloHttpDaemonSupervisor?: Pick<RufloHttpDaemonSupervisor, 'spawn'>;
  emit?: (event: string, payload: unknown) => void;
  /** SF-7 — sink for the one-time stdio-fallback notice. When omitted, the
   *  notice is skipped (auto-trust still runs). */
  notifications?: { add: (input: StdioFallbackNotificationInput) => unknown };
}

export interface RemoveWorkspaceDeps {
  rufloHttpDaemonSupervisor?: Pick<RufloHttpDaemonSupervisor, 'stop'>;
  /** 2026-06-10 audit — live PTY registry so removal can stop the workspace's
   *  running panes. Optional: callers without a registry still get the DB-row
   *  cleanup (the stop loop is skipped per-row via optional chaining). */
  pty?: Pick<PtyRegistry, 'stop'>;
}

/**
 * B4 — feature gate for the per-workspace Ruflo HTTP daemon.
 *
 * HTTP server-mode is UPSTREAM-BROKEN in every installed/published
 * `@claude-flow/cli` / `ruflo`: the homebrew alpha ignores `-t http` and falls
 * back to stdio (then exits on EOF); npm @3.10.x crashes with "Unexpected end
 * of input"; the old SF-14 pin `2.0.0-alpha.91` is unpublished (ETARGET). The
 * supervisor sends the CORRECT command — the server mode just doesn't work. So
 * spawning the daemon on every workspace open only produced a spawn → crash →
 * retry → warn-spam cycle, while panes silently kept working via the per-CLI
 * stdio autowrite (SF-15).
 *
 * While disabled we SKIP the daemon spawn entirely and write stdio MCP entries
 * (no port). Flip this to `true` ONLY once a `@claude-flow/cli` version is
 * verified to keep `mcp start -t http -p N` alive AND answer GET /health.
 */
export const ENABLE_RUFLO_HTTP_DAEMON = false;

/**
 * Windows containment — opt-in KV flag that re-enables writing a SigmaLink-managed
 * Codex *stdio* Ruflo MCP entry on Windows. Default OFF: on Windows, when no HTTP
 * daemon port is available, we suppress (and strip) the managed Codex stdio entry
 * to avoid a per-pane `npx … mcp start` process that leaks RAM. Operators who want
 * it back set this KV to '1'.
 */
export const KV_RUFLO_CODEX_STDIO_MCP = 'ruflo.codexStdioMcp';

/**
 * Read a boolean KV flag: '0' → false, '1'/'true' → true, anything else (missing
 * or unreadable) → `defaultValue`. Mirrors the (non-exported) readKvEnabled in
 * ruflo-mcp-policy.ts so factory's gate uses identical semantics.
 */
function readKvEnabled(key: string, defaultValue: boolean): boolean {
  try {
    const row = getRawDb()
      .prepare('SELECT value FROM kv WHERE key = ?')
      .get(key) as { value?: string } | undefined;
    if (row?.value === '0') return false;
    if (row?.value === '1' || row?.value === 'true') return true;
    return defaultValue;
  } catch {
    return defaultValue;
  }
}

/**
 * Decide whether mcp-autowrite should skip (and strip) the managed Codex stdio
 * Ruflo entry. Only on Windows, only when no HTTP port is available, and only
 * while the opt-in KV (KV_RUFLO_CODEX_STDIO_MCP) is unset/disabled.
 */
function shouldSkipCodexStdioRuflo(port: number | undefined): boolean {
  if (port !== undefined) return false;
  if (process.platform !== 'win32') return false;
  return !readKvEnabled(KV_RUFLO_CODEX_STDIO_MCP, false);
}

function rowToWorkspace(row: typeof workspaces.$inferSelect): Workspace {
  return {
    id: row.id,
    name: row.name,
    rootPath: row.rootPath,
    repoRoot: row.repoRoot,
    repoMode: row.repoMode as Workspace['repoMode'],
    createdAt: row.createdAt,
    lastOpenedAt: row.lastOpenedAt,
  };
}

/**
 * DEV-W3a — Open a BRAND-NEW workspace for `rootPath` even if a workspace with
 * the same rootPath already exists. Always inserts a fresh row with a new UUID;
 * the dedup-reuse branch of `openWorkspace` is intentionally skipped. Two
 * workspaces sharing one directory are disambiguated by their custom name
 * (DEV-W2 `workspaces.rename`).
 *
 * Side-effects (MCP autowrite, preflight, etc.) are identical to `openWorkspace`
 * — the new workspace receives its own per-directory MCP config entry and is
 * fully initialised before being returned.
 */
export async function openWorkspaceNew(
  rootPath: string,
  deps: OpenWorkspaceDeps = {},
): Promise<Workspace> {
  const abs = path.resolve(rootPath);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    throw new Error(`Not a directory: ${abs}`);
  }
  const repoRoot = await getRepoRoot(abs);
  const repoMode: 'git' | 'plain' = repoRoot ? 'git' : 'plain';
  const name = path.basename(abs) || abs;
  const db = getDb();
  const now = Date.now();
  // Always insert — never reuse an existing row (DEV-W3a).
  const resultId = randomUUID();
  db.insert(workspaces)
    .values({
      id: resultId,
      name,
      rootPath: abs,
      repoRoot,
      repoMode,
      createdAt: now,
      lastOpenedAt: now,
    })
    .run();

  // Force WAL checkpoint so a subsequent list sees the new row immediately.
  try {
    getRawDb().pragma('wal_checkpoint(PASSIVE)');
  } catch {
    /* best-effort */
  }

  const row = db.select().from(workspaces).where(eq(workspaces.id, resultId)).get();
  const workspace = rowToWorkspace(row!);
  try {
    const autowrite = getRawDb()
      .prepare('SELECT value FROM kv WHERE key = ?')
      .get(KV_RUFLO_AUTOWRITE_MCP) as { value?: string } | undefined;
    if (autowrite?.value !== '0') {
      let port: number | undefined;
      if (ENABLE_RUFLO_HTTP_DAEMON && deps.rufloHttpDaemonSupervisor) {
        try {
          const handle = await deps.rufloHttpDaemonSupervisor.spawn(resultId, abs);
          if (handle) port = handle.port;
        } catch (err) {
          console.warn(
            `[ruflo-http] daemon spawn failed for ${abs}; falling back to stdio: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
      writeWorkspaceMcpConfig(abs, {
        ...(port !== undefined ? { port } : {}),
        skipCodexStdio: shouldSkipCodexStdioRuflo(port),
      });
      const autotrust = getRawDb()
        .prepare('SELECT value FROM kv WHERE key = ?')
        .get(KV_RUFLO_AUTOTRUST_MCP) as { value?: string } | undefined;
      if (autotrust?.value !== '0') {
        try {
          ensureRufloTrusted(abs);
        } catch (err) {
          console.warn(
            `[ruflo-trust] ensureRufloTrusted threw for ${abs}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
      if (deps.notifications) {
        maybeNotifyStdioFallback({ notifications: deps.notifications }, resultId, port !== undefined);
      }
      void seedWorkspaceMemory({ workspaceRoot: abs }).catch(() => {});
    }
  } catch (err) {
    console.warn(
      `[ruflo] MCP autowrite failed for ${abs}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (deps.rufloSupervisor || deps.skillsManager) {
    void runWorkspacePreflight(workspace, abs, deps).catch((err) => {
      console.warn(
        `[workspace] preflight failed for ${abs}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  }
  return workspace;
}

/**
 * SigmaLink Dev (2026-06-11) — open THE singleton dev workspace: a
 * forced-`plain` row rooted at os.homedir() that holds only plain shell
 * panes. Deliberately:
 *   • never calls getRepoRoot(~) — even if ~ sits inside a dotfiles repo,
 *     this workspace must never engage worktree machinery (repoMode is
 *     forced 'plain', repoRoot null, so launcher Gate A and factory-spawn
 *     Gate B both skip worktreePool.create unconditionally);
 *   • skips EVERY open side effect (MCP autowrite, ruflo trust, memory
 *     seeding, preflight) — nothing may write `.mcp.json`/`.sigmamemory`
 *     into the user's home directory.
 * Singleton: the kv row DEV_WORKSPACE_KV_KEY points at the live row; a
 * dangling pointer (row deleted) self-heals by inserting fresh + repointing.
 */
export async function openDevWorkspace(): Promise<Workspace> {
  const db = getDb();
  const raw = getRawDb();
  const now = Date.now();
  const kvRow = raw
    .prepare('SELECT value FROM kv WHERE key = ?')
    .get(DEV_WORKSPACE_KV_KEY) as { value?: string } | undefined;
  if (kvRow?.value) {
    const existing = db.select().from(workspaces).where(eq(workspaces.id, kvRow.value)).get();
    if (existing) {
      db.update(workspaces).set({ lastOpenedAt: now }).where(eq(workspaces.id, existing.id)).run();
      return rowToWorkspace({ ...existing, lastOpenedAt: now });
    }
  }
  const resultId = randomUUID();
  db.insert(workspaces)
    .values({
      id: resultId,
      name: DEV_WORKSPACE_NAME,
      rootPath: os.homedir(),
      repoRoot: null,
      repoMode: 'plain',
      createdAt: now,
      lastOpenedAt: now,
    })
    .run();
  raw
    .prepare(
      `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, unixepoch() * 1000)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(DEV_WORKSPACE_KV_KEY, resultId);
  // Same WAL-checkpoint rationale as openWorkspaceNew (BUG-W7-006).
  try {
    raw.pragma('wal_checkpoint(PASSIVE)');
  } catch {
    /* best-effort */
  }
  const row = db.select().from(workspaces).where(eq(workspaces.id, resultId)).get();
  return rowToWorkspace(row!);
}

export async function openWorkspace(rootPath: string, deps: OpenWorkspaceDeps = {}): Promise<Workspace> {
  const abs = path.resolve(rootPath);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    throw new Error(`Not a directory: ${abs}`);
  }
  const repoRoot = await getRepoRoot(abs);
  const repoMode: 'git' | 'plain' = repoRoot ? 'git' : 'plain';
  const name = path.basename(abs) || abs;
  const db = getDb();
  // SigmaLink Dev (2026-06-11) — never dedup-reuse the dev singleton: a
  // normal open at ~ must not capture the dev row (its reuse branch would
  // overwrite repoMode/repoRoot and re-engage worktree machinery on it).
  // A fresh, separate row at the same path is fine post-mig-0034.
  let devWorkspaceId: string | null = null;
  try {
    const devKv = getRawDb()
      .prepare('SELECT value FROM kv WHERE key = ?')
      .get(DEV_WORKSPACE_KV_KEY) as { value?: string } | undefined;
    devWorkspaceId = devKv?.value ?? null;
  } catch {
    devWorkspaceId = null;
  }
  const existing = db
    .select()
    .from(workspaces)
    .where(eq(workspaces.rootPath, abs))
    .all()
    .find((r) => r.id !== devWorkspaceId);
  // SigmaLink Dev (2026-06-11) — by-path reopen of the dev singleton.
  // When there is no non-dev row at `abs` AND the dev pointer resolves to a
  // live row whose rootPath equals `abs`, the caller's intent is to reopen the
  // dev workspace (recents / persisted-closed rows reopen by path). Delegate
  // to openDevWorkspace() instead of inserting a second row at ~ — the open
  // side effects (MCP autowrite, trust, memory seed) must never run against
  // the home directory.
  if (!existing && devWorkspaceId) {
    try {
      const devRow = db
        .select()
        .from(workspaces)
        .where(eq(workspaces.id, devWorkspaceId))
        .get();
      if (devRow && devRow.rootPath === abs) {
        return openDevWorkspace();
      }
    } catch {
      // DB probe failed; fall through to the normal insert path.
    }
  }
  const now = Date.now();
  let resultId: string;
  if (existing) {
    db.update(workspaces)
      .set({ lastOpenedAt: now, repoRoot, repoMode })
      .where(eq(workspaces.id, existing.id))
      .run();
    resultId = existing.id;
  } else {
    resultId = randomUUID();
    db.insert(workspaces)
      .values({
        id: resultId,
        name,
        rootPath: abs,
        repoRoot,
        repoMode,
        createdAt: now,
        lastOpenedAt: now,
      })
      .run();
  }

  // BUG-W7-006: ensure the row is durable before returning so a subsequent
  // `workspaces.list` (from the renderer or a swarm controller) will see it.
  // Better-sqlite3 already performs synchronous writes, but we force a WAL
  // checkpoint so reads coming from another statement-cache snapshot can't
  // race ahead of the insert.
  try {
    getRawDb().pragma('wal_checkpoint(PASSIVE)');
  } catch {
    /* best-effort */
  }

  const row = db.select().from(workspaces).where(eq(workspaces.id, resultId)).get();
  const workspace = rowToWorkspace(row!);
  try {
    const autowrite = getRawDb()
      .prepare('SELECT value FROM kv WHERE key = ?')
      .get(KV_RUFLO_AUTOWRITE_MCP) as { value?: string } | undefined;
    if (autowrite?.value !== '0') {
      // v1.6.0-A — spawn per-workspace Ruflo HTTP daemon BEFORE autowrite so
      // we know the port to thread into mcp-autowrite. If spawn returns null
      // (binary missing, port collision after retries, etc.) we fall through
      // to stdio entries — no regression vs v1.5.6.
      //
      // B4 — gated OFF: HTTP server-mode is upstream-broken (see
      // ENABLE_RUFLO_HTTP_DAEMON). When disabled we skip the spawn entirely and
      // leave `port` undefined so writeWorkspaceMcpConfig emits stdio entries.
      let port: number | undefined;
      if (ENABLE_RUFLO_HTTP_DAEMON && deps.rufloHttpDaemonSupervisor) {
        try {
          const handle = await deps.rufloHttpDaemonSupervisor.spawn(resultId, abs);
          if (handle) port = handle.port;
        } catch (err) {
          console.warn(
            `[ruflo-http] daemon spawn failed for ${abs}; falling back to stdio: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
      writeWorkspaceMcpConfig(abs, {
        ...(port !== undefined ? { port } : {}),
        skipCodexStdio: shouldSkipCodexStdioRuflo(port),
      });
      // SF-7 — auto-trust the bundled ruflo server (default-ON, opt-out, fail-open).
      const autotrust = getRawDb()
        .prepare('SELECT value FROM kv WHERE key = ?')
        .get(KV_RUFLO_AUTOTRUST_MCP) as { value?: string } | undefined;
      if (autotrust?.value !== '0') {
        try {
          ensureRufloTrusted(abs);
        } catch (err) {
          console.warn(
            `[ruflo-trust] ensureRufloTrusted threw for ${abs}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
      // SF-7 — surface the silent stdio fallback (daemon didn't spawn → no port).
      if (deps.notifications) {
        maybeNotifyStdioFallback({ notifications: deps.notifications }, resultId, port !== undefined);
      }
      void seedWorkspaceMemory({ workspaceRoot: abs }).catch(() => {});
    }
  } catch (err) {
    console.warn(
      `[ruflo] MCP autowrite failed for ${abs}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (deps.rufloSupervisor || deps.skillsManager) {
    void runWorkspacePreflight(workspace, abs, deps).catch((err) => {
      console.warn(
        `[workspace] preflight failed for ${abs}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  }
  return workspace;
}

async function runWorkspacePreflight(
  workspace: Workspace,
  workspaceRoot: string,
  deps: OpenWorkspaceDeps,
): Promise<void> {
  if (deps.rufloSupervisor) {
    await deps.rufloSupervisor.ensureStarted();
    const mode = readRufloVerificationMode();
    const result = await verifyForWorkspace(workspaceRoot, mode);
    deps.emit?.('ruflo:workspace-verified', {
      workspaceId: workspace.id,
      workspaceRoot,
      ...result,
    });
  }

  if (deps.skillsManager) {
    const result = await deps.skillsManager.verifyFanoutForWorkspace(workspace.id);
    deps.emit?.('skills:workspace-verified', result);
  }
}

function readRufloVerificationMode(): RufloVerifyMode {
  try {
    const row = getRawDb()
      .prepare('SELECT value FROM kv WHERE key = ?')
      .get(KV_RUFLO_STRICT_MCP_VERIFICATION) as { value?: string } | undefined;
    return row?.value === '1' ? 'strict' : 'fast';
  } catch {
    return 'fast';
  }
}

export function listWorkspaces(): Workspace[] {
  const db = getDb();
  const rows = db.select().from(workspaces).all();
  return rows
    .map(rowToWorkspace)
    .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
}

/** DEV-W2 — rename a workspace's display label.
 *
 * Only the `name` column is touched; `rootPath` and all other fields are
 * left unchanged. The name is trimmed; empty or over-long (>120 chars)
 * names are rejected. Returns the updated `Workspace` row.
 */
export function renameWorkspace(id: string, name: string): Workspace {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error('renameWorkspace: name must not be empty');
  }
  if (trimmed.length > 120) {
    throw new Error('renameWorkspace: name must be 120 characters or fewer');
  }
  if (!id || typeof id !== 'string') {
    throw new Error('renameWorkspace: id must be a non-empty string');
  }
  const db = getDb();
  db.update(workspaces)
    .set({ name: trimmed })
    .where(eq(workspaces.id, id))
    .run();
  const row = db.select().from(workspaces).where(eq(workspaces.id, id)).get();
  if (!row) {
    throw new Error(`renameWorkspace: workspace not found: ${id}`);
  }
  return rowToWorkspace(row);
}

export async function removeWorkspace(id: string, deps: RemoveWorkspaceDeps = {}): Promise<void> {
  // v1.6.0-A — stop the per-workspace Ruflo HTTP daemon BEFORE deleting the
  // DB row so the supervisor's map entry is cleared on the same operation.
  // Stop is best-effort; failures are logged and never block workspace
  // removal.
  if (deps.rufloHttpDaemonSupervisor) {
    try {
      await deps.rufloHttpDaemonSupervisor.stop(id);
    } catch (err) {
      console.warn(
        `[ruflo-http] daemon stop failed for workspace ${id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  const db = getDb();
  // 2026-06-10 audit (MED ws) — agent_sessions has NO foreign key to
  // workspaces (its bootstrap DDL predates the cascading tables), so deleting
  // only the workspace row leaked: live PTYs kept running headless, and the
  // orphaned rows were flipped to exited/-1 by the boot janitor — a state the
  // worktree keep-predicate protects with no time bound. Mirror
  // cleanup.ts#removeWorkspaceAndGc's stopLiveSessions path: stop live PTY
  // trees (fail-open, one bad session never aborts the batch), delete the
  // session rows, THEN the workspace row. Sessions first so a crash between
  // the two deletes leaves the workspace visible and remove retryable —
  // the reverse order would orphan the rows this fix exists to clean up.
  // (session_review rows cascade off agent_sessions via FK; foreign_keys=ON.)
  const sessionRows = db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.workspaceId, id))
    .all();
  for (const row of sessionRows) {
    if (row.status === 'starting' || row.status === 'running') {
      try {
        deps.pty?.stop(row.id, { tree: true, forget: true });
      } catch (err) {
        console.warn(
          `[workspaces.remove] pty stop failed for session ${row.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }
  db.delete(agentSessions).where(eq(agentSessions.workspaceId, id)).run();
  db.delete(workspaces).where(eq(workspaces.id, id)).run();
}
