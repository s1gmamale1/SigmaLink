// Workspace persistence + repo-mode detection.

import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb, getRawDb } from '../db/client';
import { workspaces } from '../db/schema';
import { getRepoRoot } from '../git/git-ops';
import { KV_RUFLO_AUTOWRITE_MCP, KV_RUFLO_AUTOTRUST_MCP, writeWorkspaceMcpConfig } from './mcp-autowrite';
import { ensureRufloTrusted } from './mcp-trust';
import { maybeNotifyStdioFallback, type StdioFallbackNotificationInput } from './ruflo-fallback-notice';
import { seedWorkspaceMemory } from '../ruflo/seed-workspace-memory';
import type { RufloMcpSupervisor } from '../ruflo/supervisor';
import type { RufloHttpDaemonSupervisor } from '../ruflo/http-daemon-supervisor';
import {
  KV_RUFLO_STRICT_MCP_VERIFICATION,
  verifyForWorkspace,
  type RufloVerifyMode,
} from '../ruflo/verify';
import type { SkillsManager } from '../skills/manager';
import type { Workspace } from '../../../shared/types';

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
      writeWorkspaceMcpConfig(abs, port !== undefined ? { port } : undefined);
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

export async function openWorkspace(rootPath: string, deps: OpenWorkspaceDeps = {}): Promise<Workspace> {
  const abs = path.resolve(rootPath);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    throw new Error(`Not a directory: ${abs}`);
  }
  const repoRoot = await getRepoRoot(abs);
  const repoMode: 'git' | 'plain' = repoRoot ? 'git' : 'plain';
  const name = path.basename(abs) || abs;
  const db = getDb();
  const existing = db.select().from(workspaces).where(eq(workspaces.rootPath, abs)).get();
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
      writeWorkspaceMcpConfig(abs, port !== undefined ? { port } : undefined);
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
  db.delete(workspaces).where(eq(workspaces.id, id)).run();
}
