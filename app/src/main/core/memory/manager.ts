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
  MemoryUnlinkedMention,
} from '../../../shared/types';
import {
  deleteMemoryTx,
  findBacklinks,
  getMemoryRowByName,
  listMemoryRows,
  listOrphans,
  listTags,
  listByTag,
  restoreDeletedMemory,
  rollbackMemoryUpsert,
  rowToMemory,
  searchMemoriesFts,
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
    const limit = input.limit ?? 20;
    // PERF-14 — prefer the FTS5 index (bm25 ranking, sanitized MATCH). Fall back
    // to the in-process JS inverted index when FTS returns nothing (empty result
    // OR the index/table is unavailable — searchMemoriesFts swallows those into
    // []), so search keeps working before migration 0031 applies or when the
    // query has no FTS hits but the JS index (e.g. alias tier) would.
    const fts = searchMemoriesFts(input.workspaceId, input.query, limit);
    if (fts.length > 0) return fts;
    return this.indexFor(input.workspaceId).search(input.query, limit);
  }

  async findBacklinks(input: { workspaceId: string; name: string }): Promise<Memory[]> {
    await this.hydrate(input.workspaceId);
    const safe = sanitizeName(input.name);
    const rows = findBacklinks(input.workspaceId, safe);
    return rows.map((r) => rowToMemory(r.row, r.tags, r.links));
  }

  /**
   * MEM-7 — unlinked mentions: notes whose body mentions the active note's name
   * (or any MEM-5 alias) as plain text, but which do NOT already carry an
   * explicit `[[wikilink]]` to it. One-click promotable to a real link in the UI.
   *
   * Algorithm (O(notes × body) — guarded for vault size below):
   *   1. Resolve the active note → canonical name + aliases + id.
   *   2. Build the set of mention strings (name + aliases).
   *   3. For every OTHER note: skip if it already links to the active note (its
   *      outgoing links include the name or an alias, case-insensitively); else
   *      scan its body for any mention string at a word boundary; if found,
   *      emit a {sourceId, sourceName, excerpt}.
   *
   * Vault-size guard: this is linear in (notes × bodyLength). Fine for the ≤500
   * notes the Memory hub targets; above that we cap the scan to keep the call
   * snappy rather than block the main process.
   */
  async findUnlinkedMentions(input: {
    workspaceId: string;
    name: string;
  }): Promise<MemoryUnlinkedMention[]> {
    await this.hydrate(input.workspaceId);
    const safe = sanitizeName(input.name);
    const target = getMemoryRowByName(input.workspaceId, safe);
    if (!target) return [];

    // Mention strings: canonical name + aliases. Trimmed, de-duplicated, and
    // sorted longest-first so a longer alias wins the first match.
    const aliases = rowToMemory(target.row, target.tags, target.links).aliases ?? [];
    const mentionSet = new Set<string>();
    for (const s of [target.row.name, ...aliases]) {
      const t = s.trim();
      if (t) mentionSet.add(t);
    }
    const mentions = [...mentionSet]
      .map((m) => ({ raw: m, lower: m.toLowerCase() }))
      .sort((a, b) => b.lower.length - a.lower.length);
    if (mentions.length === 0) return [];

    // Names this note answers to (for the "already linked" exclusion).
    const targetNames = new Set(mentions.map((m) => m.lower));

    const VAULT_SCAN_CAP = 500;
    const allRows = listMemoryRows(input.workspaceId);
    const idx = this.indexFor(input.workspaceId);
    const out: MemoryUnlinkedMention[] = [];

    let scanned = 0;
    for (const r of allRows) {
      if (scanned >= VAULT_SCAN_CAP) break;
      if (r.row.id === target.row.id) continue; // never self-mention
      // Exclude notes already linking to the active note (or any of its aliases).
      if (r.links.some((l) => targetNames.has(l.toLowerCase()))) continue;
      scanned += 1;

      // Prefer the index's cached body; fall back to the row body if the index
      // is cold for this entry (shouldn't happen post-hydrate, but be safe).
      const body = idx.bodyOf(r.row.id) ?? r.row.body;
      if (!body) continue;

      const hit = findMentionInBody(body, mentions);
      if (hit) {
        out.push({
          sourceId: r.row.id,
          sourceName: r.row.name,
          excerpt: mentionExcerpt(body, hit.index, hit.length),
        });
      }
    }
    return out;
  }

  async listOrphans(input: { workspaceId: string }): Promise<Memory[]> {
    await this.hydrate(input.workspaceId);
    return listOrphans(input.workspaceId).map((r) => rowToMemory(r.row, r.tags, r.links));
  }

  // MEM-3 — tag facets.
  async listTags(input: { workspaceId: string }): Promise<Array<{ tag: string; count: number }>> {
    await this.hydrate(input.workspaceId);
    return listTags(input.workspaceId);
  }

  async listByTag(input: { workspaceId: string; tag: string }): Promise<Memory[]> {
    await this.hydrate(input.workspaceId);
    return listByTag(input.workspaceId, input.tag).map((r) => rowToMemory(r.row, r.tags, r.links));
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

// ── MEM-7 mention-scan helpers ────────────────────────────────────────────────

/** True when `ch` is an alphanumeric or underscore "word" character. Used for
 *  word-boundary checks so "Foo" does not match inside "Foobar". No RegExp. */
function isWordChar(ch: string | undefined): boolean {
  if (ch === undefined) return false;
  return /[A-Za-z0-9_]/.test(ch); // static literal pattern, single char input
}

/**
 * Find the first whole-word, case-insensitive occurrence of any mention string
 * in `body`. Returns the match offset + matched length, or null. Mentions must
 * already be sorted longest-first so the longest match wins at a given position.
 * A match is "whole word" only when the chars immediately before/after the hit
 * are non-word chars (or the string boundary) — this avoids false positives like
 * matching "API" inside "RAPID". A mention that contains non-word chars (e.g.
 * "Note v2") still matches by substring; the boundary test uses the body chars
 * adjacent to the substring, which behaves sensibly for such names.
 */
function findMentionInBody(
  body: string,
  mentions: Array<{ raw: string; lower: string }>,
): { index: number; length: number } | null {
  const lowerBody = body.toLowerCase();
  let best: { index: number; length: number } | null = null;
  for (const mention of mentions) {
    let from = 0;
    for (;;) {
      const idx = lowerBody.indexOf(mention.lower, from);
      if (idx === -1) break;
      const before = idx > 0 ? lowerBody[idx - 1] : undefined;
      const after =
        idx + mention.lower.length < lowerBody.length
          ? lowerBody[idx + mention.lower.length]
          : undefined;
      if (!isWordChar(before) && !isWordChar(after)) {
        if (best === null || idx < best.index) best = { index: idx, length: mention.lower.length };
        break; // earliest hit for this mention found; move to next mention
      }
      from = idx + 1;
    }
  }
  return best;
}

/** Short excerpt of `body` centred on a matched mention at [index, index+length).
 *  Mirrors the index.ts snippet() window so unlinked-mention previews read the
 *  same as search snippets. */
function mentionExcerpt(body: string, index: number, length: number): string {
  const start = Math.max(0, index - 40);
  const end = Math.min(body.length, index + length + 80);
  const prefix = start > 0 ? '… ' : '';
  const suffix = end < body.length ? ' …' : '';
  return prefix + body.slice(start, end).replace(/\s+/g, ' ').trim() + suffix;
}
