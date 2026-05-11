// Workspace persistence + repo-mode detection.

import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb, getRawDb } from '../db/client';
import { workspaces } from '../db/schema';
import { getRepoRoot } from '../git/git-ops';
import { KV_RUFLO_AUTOWRITE_MCP, writeWorkspaceMcpConfig } from './mcp-autowrite';
import type { RufloMcpSupervisor } from '../ruflo/supervisor';
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
  emit?: (event: string, payload: unknown) => void;
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
      writeWorkspaceMcpConfig(abs);
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

export function removeWorkspace(id: string): void {
  const db = getDb();
  db.delete(workspaces).where(eq(workspaces.id, id)).run();
}
