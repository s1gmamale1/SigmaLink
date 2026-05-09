// Workspace persistence + repo-mode detection.

import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import { workspaces } from '../db/schema';
import { getRepoRoot } from '../git/git-ops';
import type { Workspace } from '../../../shared/types';

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

export async function openWorkspace(rootPath: string): Promise<Workspace> {
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
  if (existing) {
    db.update(workspaces)
      .set({ lastOpenedAt: now, repoRoot, repoMode })
      .where(eq(workspaces.id, existing.id))
      .run();
    const row = db.select().from(workspaces).where(eq(workspaces.id, existing.id)).get();
    return rowToWorkspace(row!);
  }
  const id = randomUUID();
  db.insert(workspaces)
    .values({
      id,
      name,
      rootPath: abs,
      repoRoot,
      repoMode,
      createdAt: now,
      lastOpenedAt: now,
    })
    .run();
  const row = db.select().from(workspaces).where(eq(workspaces.id, id)).get();
  return rowToWorkspace(row!);
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
