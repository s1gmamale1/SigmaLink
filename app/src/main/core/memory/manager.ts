// MemoryManager: orchestrates DB writes, atomic file writes, and the
// in-memory inverted index for one app instance. Methods accept a
// `workspaceId` and resolve the on-disk hub root via the cached workspace
// row. Per A3 the order is always: SQLite transaction first, file write
// second, with rollback on failure.

import path from 'node:path';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import { workspaces } from '../db/schema';
import type {
  Memory,
  MemoryConnectionSuggestion,
  MemoryGraph,
  MemoryHubStatus,
  MemorySearchHit,
} from '../../../shared/types';
import {
  deleteMemoryTx,
  findBacklinks,
  getMemoryRowByName,
  listMemoryRows,
  listOrphans,
  restoreDeletedMemory,
  rollbackMemoryUpsert,
  rowToMemory,
  upsertMemoryTx,
} from './db';
import {
  deleteMemoryFile,
  ensureHub,
  ensureHubSync,
  listMemoryFiles,
  resolveHubPath,
  sanitizeName,
  writeMemoryFile,
} from './storage';
import { uniqueLinkTargets } from './parse';
import { MemoryIndex } from './index';
import { buildGraph } from './graph';

export type MemoryEvent = { id: string; kind: 'create' | 'update' | 'delete' };
export type EmitFn = (event: MemoryEvent) => void;

export interface MemoryManagerDeps {
  emit: EmitFn;
  /** Resolves the on-disk root to use for `<root>/.sigmamemory`. */
  resolveWorkspaceRoot?: (workspaceId: string) => string | null;
  /** Optional supervisor-command resolver for hub_status. */
  resolveMcpCommand?: (
    workspaceId: string,
  ) => { command: string; args: string[] } | null;
}

export class MemoryManager {
  private readonly indexes = new Map<string, MemoryIndex>();
  private readonly hydrated = new Set<string>();
  private readonly deps: MemoryManagerDeps;

  constructor(deps: MemoryManagerDeps) {
    this.deps = deps;
  }

  // ──────────────────────────────────────────── public API ──

  async hubStatus(workspaceId: string): Promise<MemoryHubStatus> {
    const root = this.requireRoot(workspaceId);
    const layout = resolveHubPath(root);
    const rows = listMemoryRows(workspaceId);
    const memCount = rows.length;
    const linkCount = rows.reduce((acc, r) => acc + r.links.length, 0);
    const tagCount = rows.reduce((acc, r) => acc + r.tags.length, 0);
    const cmd = this.deps.resolveMcpCommand?.(workspaceId) ?? null;
    return {
      workspaceId,
      hubPath: layout.hubPath,
      memoryCount: memCount,
      linkCount,
      tagCount,
      initialized: await safeStat(layout.hubPath),
      mcpCommand: cmd?.command ?? null,
      mcpArgs: cmd?.args ?? [],
    };
  }

  async initHub(workspaceId: string): Promise<MemoryHubStatus> {
    const root = this.requireRoot(workspaceId);
    await ensureHub(root);
    await this.hydrate(workspaceId);
    return this.hubStatus(workspaceId);
  }

  async listMemories(workspaceId: string): Promise<Memory[]> {
    await this.hydrate(workspaceId);
    const rows = listMemoryRows(workspaceId);
    return rows.map((r) => rowToMemory(r.row, r.tags, r.links));
  }

  async readMemory(workspaceId: string, name: string): Promise<Memory | null> {
    await this.hydrate(workspaceId);
    const row = getMemoryRowByName(workspaceId, sanitizeName(name));
    return row ? rowToMemory(row.row, row.tags, row.links) : null;
  }

  async createMemory(input: {
    workspaceId: string;
    name: string;
    body?: string;
    tags?: string[];
  }): Promise<Memory> {
    const safeName = sanitizeName(input.name);
    const existing = getMemoryRowByName(input.workspaceId, safeName);
    if (existing) {
      throw new Error(`Memory already exists: ${safeName}`);
    }
    return this.writeAndPersist({
      workspaceId: input.workspaceId,
      name: safeName,
      body: input.body ?? '',
      tags: input.tags ?? [],
      kind: 'create',
    });
  }

  async updateMemory(input: {
    workspaceId: string;
    name: string;
    body?: string;
    tags?: string[];
  }): Promise<Memory> {
    const safeName = sanitizeName(input.name);
    const existing = getMemoryRowByName(input.workspaceId, safeName);
    if (!existing) {
      throw new Error(`Memory not found: ${safeName}`);
    }
    return this.writeAndPersist({
      workspaceId: input.workspaceId,
      name: safeName,
      body: input.body ?? existing.row.body,
      tags: input.tags ?? existing.tags,
      kind: 'update',
    });
  }

  async appendToMemory(input: {
    workspaceId: string;
    name: string;
    text: string;
  }): Promise<Memory> {
    const safeName = sanitizeName(input.name);
    const existing = getMemoryRowByName(input.workspaceId, safeName);
    const baseBody = existing ? existing.row.body : '';
    const sep = baseBody.length === 0 || baseBody.endsWith('\n') ? '' : '\n';
    const body = baseBody + sep + input.text;
    return this.writeAndPersist({
      workspaceId: input.workspaceId,
      name: safeName,
      body,
      tags: existing ? existing.tags : [],
      kind: existing ? 'update' : 'create',
    });
  }

  async deleteMemory(input: { workspaceId: string; name: string }): Promise<void> {
    const safeName = sanitizeName(input.name);
    const root = this.requireRoot(input.workspaceId);
    const snap = deleteMemoryTx(input.workspaceId, safeName);
    if (!snap) {
      // Nothing in DB; still try to remove a stray file.
      await deleteMemoryFile(root, safeName).catch(() => false);
      return;
    }
    try {
      await deleteMemoryFile(root, safeName);
    } catch (err) {
      // Restore SQL state to keep DB & disk consistent.
      restoreDeletedMemory(input.workspaceId, snap);
      throw err;
    }
    this.indexFor(input.workspaceId).remove(snap.row.id);
    this.deps.emit({ id: snap.row.id, kind: 'delete' });
  }

  async searchMemories(input: {
    workspaceId: string;
    query: string;
    limit?: number;
  }): Promise<MemorySearchHit[]> {
    await this.hydrate(input.workspaceId);
    return this.indexFor(input.workspaceId).search(input.query, input.limit ?? 20);
  }

  async findBacklinks(input: { workspaceId: string; name: string }): Promise<Memory[]> {
    await this.hydrate(input.workspaceId);
    const safe = sanitizeName(input.name);
    const rows = findBacklinks(input.workspaceId, safe);
    return rows.map((r) => rowToMemory(r.row, r.tags, r.links));
  }

  async listOrphans(input: { workspaceId: string }): Promise<Memory[]> {
    await this.hydrate(input.workspaceId);
    return listOrphans(input.workspaceId).map((r) => rowToMemory(r.row, r.tags, r.links));
  }

  async suggestConnections(input: {
    workspaceId: string;
    name: string;
  }): Promise<MemoryConnectionSuggestion[]> {
    await this.hydrate(input.workspaceId);
    const safe = sanitizeName(input.name);
    const target = getMemoryRowByName(input.workspaceId, safe);
    if (!target) return [];
    const tagSet = new Set(target.tags);
    if (tagSet.size === 0) return [];
    const all = listMemoryRows(input.workspaceId);
    const suggestions: MemoryConnectionSuggestion[] = [];
    for (const m of all) {
      if (m.row.id === target.row.id) continue;
      const shared = m.tags.filter((t) => tagSet.has(t));
      if (shared.length === 0) continue;
      suggestions.push({
        id: m.row.id,
        name: m.row.name,
        sharedTags: shared,
        score: shared.length,
      });
    }
    suggestions.sort((a, b) => b.score - a.score);
    return suggestions.slice(0, 10);
  }

  async getGraph(workspaceId: string): Promise<MemoryGraph> {
    await this.hydrate(workspaceId);
    const all = await this.listMemories(workspaceId);
    return buildGraph(all);
  }

  // ──────────────────────────────────────────── internals ──

  /**
   * Hydrate the in-memory index for a workspace. Reads from the DB once per
   * workspace per process lifetime; subsequent calls are no-ops.
   */
  private async hydrate(workspaceId: string): Promise<void> {
    if (this.hydrated.has(workspaceId)) return;
    const all = listMemoryRows(workspaceId).map((r) => rowToMemory(r.row, r.tags, r.links));
    const idx = new MemoryIndex();
    idx.rebuild(all);
    this.indexes.set(workspaceId, idx);
    this.hydrated.add(workspaceId);
    // Best-effort: ensure the `.sigmamemory` directory exists once we know the
    // workspace is active. Silently ignore failures — the manager can still
    // operate against existing rows even if the dir is unavailable.
    try {
      const root = this.requireRoot(workspaceId);
      ensureHubSync(root);
    } catch {
      /* tolerate missing workspace */
    }
  }

  private indexFor(workspaceId: string): MemoryIndex {
    let idx = this.indexes.get(workspaceId);
    if (!idx) {
      idx = new MemoryIndex();
      this.indexes.set(workspaceId, idx);
    }
    return idx;
  }

  private requireRoot(workspaceId: string): string {
    const custom = this.deps.resolveWorkspaceRoot?.(workspaceId);
    if (custom) return custom;
    const db = getDb();
    const row = db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).get();
    if (!row) throw new Error(`Unknown workspace: ${workspaceId}`);
    return row.repoRoot ?? row.rootPath;
  }

  private async writeAndPersist(args: {
    workspaceId: string;
    name: string;
    body: string;
    tags: string[];
    kind: 'create' | 'update';
  }): Promise<Memory> {
    const root = this.requireRoot(args.workspaceId);
    const upsert = upsertMemoryTx({
      workspaceId: args.workspaceId,
      name: args.name,
      body: args.body,
      tags: args.tags,
    });
    try {
      await writeMemoryFile({
        workspaceRoot: root,
        name: args.name,
        body: args.body,
        frontmatter: {
          name: args.name,
          tags: args.tags,
          created: upsert.joined.row.createdAt,
          updated: upsert.joined.row.updatedAt,
        },
      });
    } catch (err) {
      rollbackMemoryUpsert(args.workspaceId, args.name, upsert.previous);
      throw err;
    }
    const memory = rowToMemory(upsert.joined.row, upsert.joined.tags, upsert.joined.links);
    this.indexFor(args.workspaceId).upsert(memory);
    this.deps.emit({ id: memory.id, kind: args.kind });
    return memory;
  }

  /**
   * Replay-from-disk. Used by tests / power-user "rescan" buttons. Reads
   * every `<hub>/<name>.md` file and upserts it through the normal pipeline.
   */
  async rescanFromDisk(workspaceId: string): Promise<number> {
    const root = this.requireRoot(workspaceId);
    const files = await listMemoryFiles(root);
    let touched = 0;
    for (const file of files) {
      const tags = file.frontmatter.tags ?? [];
      try {
        const wasPresent = !!getMemoryRowByName(workspaceId, file.name);
        const upsert = upsertMemoryTx({
          workspaceId,
          name: file.name,
          body: file.body,
          tags,
        });
        const memory = rowToMemory(
          upsert.joined.row,
          upsert.joined.tags,
          upsert.joined.links,
        );
        this.indexFor(workspaceId).upsert(memory);
        this.deps.emit({ id: memory.id, kind: wasPresent ? 'update' : 'create' });
        touched += 1;
      } catch {
        /* skip malformed files */
      }
    }
    return touched;
  }
}

async function safeStat(p: string): Promise<boolean> {
  try {
    const fsp = await import('node:fs/promises');
    const s = await fsp.stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}

export function namesAreEqual(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export function memoryAbsolutePath(workspaceRoot: string, name: string): string {
  return path.join(resolveHubPath(workspaceRoot).hubPath, sanitizeName(name) + '.md');
}

// Convenience link calculator for renderers needing fresh outgoing links.
export function outgoingLinks(body: string): string[] {
  return uniqueLinkTargets(body);
}
