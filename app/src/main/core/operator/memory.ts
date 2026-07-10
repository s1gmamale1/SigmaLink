// P2 Task 2 — Jorvis's durable long-term memory DAO. CRUD (rememberMemory /
// updateMemory / forgetMemory / listMemories) rides drizzle exactly like
// `../missions/dao.ts`; `recallMemories` is raw SQL against the FTS5 index
// (migration 0041) — same idiom as `../memory/db.ts`'s `searchMemoriesFts`
// (PERF-14): the user query is neutralized by re-quoting each whitespace
// token (never interpolated into the SQL text, always a bound param) and the
// WHOLE lookup is wrapped in try/catch so a broken/missing FTS index degrades
// to `[]` instead of throwing into a wake. `tags` is stored as JSON text on
// the row; this module parses/serializes it at the DAO boundary so callers
// only ever see `string[]`.

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb, getRawDb } from '../db/client';
import { jorvisMemory } from '../db/schema';
import type { JorvisMemoryRow } from '../db/schema';
import type { JorvisMemory, JorvisMemoryKind } from '../../../shared/types';

function parseTags(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

function rowToMemory(row: JorvisMemoryRow): JorvisMemory {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    tags: parseTags(row.tags),
    workspaceId: row.workspaceId,
    confidence: row.confidence,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastUsedAt: row.lastUsedAt,
  };
}

function getMemoryRow(id: string): JorvisMemoryRow | null {
  return getDb().select().from(jorvisMemory).where(eq(jorvisMemory.id, id)).get() ?? null;
}

export function rememberMemory(input: {
  kind: JorvisMemoryKind;
  title: string;
  body: string;
  tags?: string[];
  workspaceId?: string | null;
  confidence?: number;
}): JorvisMemory {
  const now = Date.now();
  const memory: JorvisMemory = {
    id: randomUUID(),
    kind: input.kind,
    title: input.title,
    body: input.body,
    tags: input.tags ?? [],
    workspaceId: input.workspaceId ?? null,
    confidence: input.confidence ?? 0.7,
    createdAt: now,
    updatedAt: now,
    lastUsedAt: null,
  };
  getDb()
    .insert(jorvisMemory)
    .values({ ...memory, tags: JSON.stringify(memory.tags) })
    .run();
  return memory;
}

export function updateMemory(
  id: string,
  patch: { title?: string; body?: string; tags?: string[]; confidence?: number },
): JorvisMemory {
  const row = getMemoryRow(id);
  if (!row) throw new Error(`jorvis memory not found: ${id}`);
  const existing = rowToMemory(row);
  const updatedAt = Date.now();
  const merged: JorvisMemory = {
    ...existing,
    title: patch.title !== undefined ? patch.title : existing.title,
    body: patch.body !== undefined ? patch.body : existing.body,
    tags: patch.tags !== undefined ? patch.tags : existing.tags,
    confidence: patch.confidence !== undefined ? patch.confidence : existing.confidence,
    updatedAt,
  };
  getDb()
    .update(jorvisMemory)
    .set({
      title: merged.title,
      body: merged.body,
      tags: JSON.stringify(merged.tags),
      confidence: merged.confidence,
      updatedAt,
    })
    .where(eq(jorvisMemory.id, id))
    .run();
  return merged;
}

export function forgetMemory(id: string): void {
  const row = getMemoryRow(id);
  if (!row) throw new Error(`jorvis memory not found: ${id}`);
  // Hard delete — the jorvis_memory_fts_ad trigger (migration 0041) cleans
  // the FTS index in lockstep, so no separate FTS cleanup is needed here.
  getDb().delete(jorvisMemory).where(eq(jorvisMemory.id, id)).run();
}

export function listMemories(filter?: { kind?: JorvisMemoryKind; limit?: number }): JorvisMemory[] {
  const rows = filter?.kind
    ? getDb().select().from(jorvisMemory).where(eq(jorvisMemory.kind, filter.kind)).all()
    : getDb().select().from(jorvisMemory).all();
  const out = rows.map(rowToMemory);
  out.sort((a, b) => b.updatedAt - a.updatedAt); // most-recently-updated first, mirrors missions/dao.ts listMissions
  return filter?.limit !== undefined ? out.slice(0, filter.limit) : out;
}

// ── recallMemories — raw SQL FTS5 (see migration 0041) ─────────────────────

/**
 * Neutralize FTS5 query syntax by wrapping each whitespace-separated token in
 * double quotes (an FTS5 "string" matches its content literally), so stray
 * operator characters in a user query (`-`, `:`, `*`, unbalanced quotes, …)
 * can never be parsed as MATCH syntax. A literal double-quote inside a token
 * is escaped by doubling it, FTS5's own escape convention. Returns '' for an
 * empty/whitespace-only query.
 */
function quoteFtsQuery(query: string): string {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' ');
}

/** Raw-SQL row shape: `SELECT m.*` returns the actual (snake_case) column
 *  names, NOT the camelCase drizzle-mapped `JorvisMemoryRow`. */
interface RawMemoryRow {
  id: string;
  kind: JorvisMemoryKind;
  title: string;
  body: string;
  tags: string;
  workspace_id: string | null;
  confidence: number;
  created_at: number;
  updated_at: number;
  last_used_at: number | null;
}

function rawRowToMemory(row: RawMemoryRow): JorvisMemory {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    tags: parseTags(row.tags),
    workspaceId: row.workspace_id,
    confidence: row.confidence,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
  };
}

/**
 * Full-text recall over `jorvis_memory` via its FTS5 sibling. Ranks by
 * bm25(jorvis_memory_fts) ascending (lower = better in FTS5). The WHOLE
 * lookup is wrapped in try/catch: a missing/corrupt FTS index or a malformed
 * MATCH expression that slips past sanitization must degrade to `[]`, never
 * throw into a wake (D4). Touches `last_used_at` on every returned row in one
 * `UPDATE ... WHERE id IN (...)` — mirrors the dynamic-placeholder idiom used
 * by `assistant/conversations.ts`.
 */
export function recallMemories(input: {
  query: string;
  k?: number;
  kind?: JorvisMemoryKind;
  workspaceId?: string | null;
}): JorvisMemory[] {
  const match = quoteFtsQuery(input.query);
  if (!match) return [];
  const limit = input.k ?? 5;
  try {
    const raw = getRawDb();
    const clauses: string[] = ['jorvis_memory_fts MATCH ?'];
    const params: unknown[] = [match];
    if (input.kind) {
      clauses.push('m.kind = ?');
      params.push(input.kind);
    }
    if (input.workspaceId !== undefined) {
      if (input.workspaceId === null) {
        clauses.push('m.workspace_id IS NULL');
      } else {
        clauses.push('m.workspace_id = ?');
        params.push(input.workspaceId);
      }
    }
    params.push(limit);
    const sql = `
      SELECT m.* FROM jorvis_memory m
      JOIN jorvis_memory_fts f ON f.rowid = m.rowid
      WHERE ${clauses.join(' AND ')}
      ORDER BY bm25(jorvis_memory_fts) LIMIT ?`;
    const rows = raw.prepare(sql).all(...params) as RawMemoryRow[];
    if (rows.length === 0) return [];

    const touchedAt = Date.now();
    const ids = rows.map((r) => r.id);
    const placeholders = ids.map(() => '?').join(',');
    raw
      .prepare(`UPDATE jorvis_memory SET last_used_at = ? WHERE id IN (${placeholders})`)
      .run(touchedAt, ...ids);

    return rows.map((r) => rawRowToMemory({ ...r, last_used_at: touchedAt }));
  } catch {
    return [];
  }
}
