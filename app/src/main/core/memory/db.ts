// DB layer for memories: row -> Memory mapping plus transactional helpers
// that callers wrap around the file-system writes. Per A3 in
// `docs/04-critique/01-architecture.md`, callers must commit the SQL
// transaction FIRST, then write the file. If the file write fails, the
// rollback function exported here restores the previous DB state.

import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { getDb, getRawDb } from '../db/client';
import { memories, memoryLinks, memoryTags } from '../db/schema';
import type { Memory, MemorySearchHit } from '../../../shared/types';
import {
  frontmatterFromJson,
  frontmatterToJson,
  parseFrontmatter,
  uniqueLinkTargets,
} from './parse';

/**
 * P4.2 MEM-5 — pull the `aliases` list out of a parsed frontmatter record,
 * keeping only non-empty strings. The frontmatter parser already coerces an
 * inline `aliases: [a, b]` flow list into an array; a single scalar
 * `aliases: foo` is also accepted (wrapped into a one-element list). Anything
 * else (numbers, booleans, nested maps) is dropped. Returned trimmed +
 * de-duplicated (case-insensitively) preserving first-seen order.
 */
export function extractAliases(frontmatter: Record<string, unknown> | null): string[] {
  if (!frontmatter) return [];
  const raw = frontmatter.aliases;
  const candidates: unknown[] = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of candidates) {
    if (typeof c !== 'string') continue;
    const trimmed = c.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

/** Parse the cached `aliases_json` column back into a string[]. Tolerates null,
 *  empty, malformed JSON, and non-array JSON — all collapse to [] so a bad
 *  cached value never throws on read. */
function aliasesFromJson(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    if (Array.isArray(parsed)) return parsed.filter((a): a is string => typeof a === 'string');
    return [];
  } catch {
    return [];
  }
}

/** Serialize aliases for the `aliases_json` column. NULL when empty so the
 *  column stays NULL rather than holding a meaningless `"[]"`. */
function aliasesToJson(aliases: string[]): string | null {
  return aliases.length === 0 ? null : JSON.stringify(aliases);
}

export interface MemoryRowJoined {
  row: typeof memories.$inferSelect;
  tags: string[];
  links: string[];
}

export function rowToMemory(row: typeof memories.$inferSelect, tags: string[], links: string[]): Memory {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    body: row.body,
    tags,
    links,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    // BUG-10: surface the cached frontmatter. Tolerates null / malformed JSON
    // (frontmatterFromJson collapses both to null).
    frontmatter: frontmatterFromJson(row.frontmatterJson),
    // MEM-5: surface the cached aliases. Tolerates null / malformed JSON (→ []).
    aliases: aliasesFromJson(row.aliasesJson),
  };
}

export function getMemoryRowByName(workspaceId: string, name: string): MemoryRowJoined | null {
  const db = getDb();
  // Primary: exact (case-insensitive — migration 0027 makes the unique index
  // NOCASE) name match.
  const row = db
    .select()
    .from(memories)
    .where(
      and(
        eq(memories.workspaceId, workspaceId),
        sql`${memories.name} = ${name} COLLATE NOCASE`,
      ),
    )
    .get();
  if (row) return joinAuxiliaryRows(row);
  // MEM-5 fallback: no note is literally named `name`, but a note may resolve
  // under `name` as an alias. Scan the workspace's cached aliases (small
  // volumes) and return the first match.
  const aliasRow = findRowByAlias(workspaceId, name);
  return aliasRow ? joinAuxiliaryRows(aliasRow) : null;
}

/** MEM-5 — find the first note in `workspaceId` whose cached `aliases_json`
 *  contains `name` (case-insensitively). Returns null when none match. */
function findRowByAlias(
  workspaceId: string,
  name: string,
): typeof memories.$inferSelect | null {
  const db = getDb();
  const target = name.trim().toLowerCase();
  if (!target) return null;
  const rows = db
    .select()
    .from(memories)
    .where(eq(memories.workspaceId, workspaceId))
    .all();
  for (const r of rows) {
    if (aliasesFromJson(r.aliasesJson).some((a) => a.toLowerCase() === target)) {
      return r;
    }
  }
  return null;
}

export function getMemoryById(id: string): MemoryRowJoined | null {
  const db = getDb();
  const row = db.select().from(memories).where(eq(memories.id, id)).get();
  if (!row) return null;
  return joinAuxiliaryRows(row);
}

export function listMemoryRows(workspaceId: string): MemoryRowJoined[] {
  const db = getDb();
  const rows = db
    .select()
    .from(memories)
    .where(eq(memories.workspaceId, workspaceId))
    .orderBy(desc(memories.updatedAt))
    .all();
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const tagRows = db.select().from(memoryTags).where(inArray(memoryTags.memoryId, ids)).all();
  const linkRows = db.select().from(memoryLinks).where(inArray(memoryLinks.fromMemoryId, ids)).all();
  const tagMap = new Map<string, string[]>();
  for (const t of tagRows) {
    const list = tagMap.get(t.memoryId) ?? [];
    list.push(t.tag);
    tagMap.set(t.memoryId, list);
  }
  const linkMap = new Map<string, string[]>();
  for (const l of linkRows) {
    const list = linkMap.get(l.fromMemoryId) ?? [];
    list.push(l.toMemoryName);
    linkMap.set(l.fromMemoryId, list);
  }
  return rows.map((row) => ({
    row,
    tags: (tagMap.get(row.id) ?? []).sort(),
    links: linkMap.get(row.id) ?? [],
  }));
}

function joinAuxiliaryRows(row: typeof memories.$inferSelect): MemoryRowJoined {
  const db = getDb();
  const tags = db
    .select()
    .from(memoryTags)
    .where(eq(memoryTags.memoryId, row.id))
    .all()
    .map((t) => t.tag)
    .sort();
  const links = db
    .select()
    .from(memoryLinks)
    .where(eq(memoryLinks.fromMemoryId, row.id))
    .all()
    .map((l) => l.toMemoryName);
  return { row, tags, links };
}

export interface UpsertArgs {
  workspaceId: string;
  name: string;
  body: string;
  tags: string[];
}

export interface UpsertResult {
  joined: MemoryRowJoined;
  /** Pre-state used to rebuild the file if upstream rolls back. */
  previous: { existed: boolean; body: string; tags: string[]; links: string[] } | null;
}

/**
 * Insert or update a memory inside a single SQLite transaction. The CRUD
 * order is: ensure row -> wipe stale tags / links -> insert fresh tags /
 * links. Returns the resulting joined view plus the snapshot of any
 * pre-existing record so callers can roll back the file on disk if their
 * subsequent fs.write throws.
 */
export function upsertMemoryTx(args: UpsertArgs): UpsertResult {
  const raw = getRawDb();
  const db = getDb();
  const links = uniqueLinkTargets(args.body);
  const tags = Array.from(new Set(args.tags.map((t) => t.trim()).filter(Boolean))).sort();
  const now = Date.now();
  // BUG-10: derive the structured frontmatter cache from the body. Stored as
  // JSON (or NULL when the body has no frontmatter block).
  const parsedFrontmatter = parseFrontmatter(args.body).frontmatter;
  const frontmatterJson = frontmatterToJson(parsedFrontmatter);
  // MEM-5: cache the frontmatter aliases (filtered to strings) so the
  // link/backlink/graph layers can resolve a wikilink to this note by alias.
  const aliasesJson = aliasesToJson(extractAliases(parsedFrontmatter));

  let previous: UpsertResult['previous'] = null;
  let resultId = '';

  const tx = raw.transaction(() => {
    const existing = db
      .select()
      .from(memories)
      .where(and(eq(memories.workspaceId, args.workspaceId), eq(memories.name, args.name)))
      .get();
    if (existing) {
      previous = {
        existed: true,
        body: existing.body,
        tags: db
          .select()
          .from(memoryTags)
          .where(eq(memoryTags.memoryId, existing.id))
          .all()
          .map((t) => t.tag),
        links: db
          .select()
          .from(memoryLinks)
          .where(eq(memoryLinks.fromMemoryId, existing.id))
          .all()
          .map((l) => l.toMemoryName),
      };
      db.update(memories)
        .set({ body: args.body, frontmatterJson, aliasesJson, updatedAt: now })
        .where(eq(memories.id, existing.id))
        .run();
      resultId = existing.id;
    } else {
      previous = null;
      const id = randomUUID();
      resultId = id;
      db.insert(memories)
        .values({
          id,
          workspaceId: args.workspaceId,
          name: args.name,
          body: args.body,
          frontmatterJson,
          aliasesJson,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }

    // Replace tags & links wholesale; cheap for the volumes we expect.
    db.delete(memoryTags).where(eq(memoryTags.memoryId, resultId)).run();
    db.delete(memoryLinks).where(eq(memoryLinks.fromMemoryId, resultId)).run();
    for (const tag of tags) {
      db.insert(memoryTags).values({ memoryId: resultId, tag }).run();
    }
    for (const target of links) {
      db.insert(memoryLinks)
        .values({ id: randomUUID(), fromMemoryId: resultId, toMemoryName: target, createdAt: now })
        .run();
    }
  });
  tx();

  const joined = getMemoryById(resultId);
  if (!joined) throw new Error('Memory row vanished after upsert');
  return { joined, previous };
}

/**
 * Re-apply a previous snapshot. Used when an upsert succeeded in SQL but the
 * subsequent file write threw; we restore the row (or remove the freshly
 * created one) so DB and disk converge again.
 */
export function rollbackMemoryUpsert(
  workspaceId: string,
  name: string,
  previous: UpsertResult['previous'],
): void {
  const raw = getRawDb();
  const db = getDb();
  const tx = raw.transaction(() => {
    const row = db
      .select()
      .from(memories)
      .where(and(eq(memories.workspaceId, workspaceId), eq(memories.name, name)))
      .get();
    if (!row) return;
    if (!previous) {
      db.delete(memories).where(eq(memories.id, row.id)).run();
      return;
    }
    const prevFrontmatter = parseFrontmatter(previous.body).frontmatter;
    db.update(memories)
      .set({
        body: previous.body,
        // Keep the frontmatter + alias caches consistent with the restored body.
        frontmatterJson: frontmatterToJson(prevFrontmatter),
        aliasesJson: aliasesToJson(extractAliases(prevFrontmatter)),
      })
      .where(eq(memories.id, row.id))
      .run();
    db.delete(memoryTags).where(eq(memoryTags.memoryId, row.id)).run();
    db.delete(memoryLinks).where(eq(memoryLinks.fromMemoryId, row.id)).run();
    for (const tag of previous.tags) {
      db.insert(memoryTags).values({ memoryId: row.id, tag }).run();
    }
    for (const target of previous.links) {
      db.insert(memoryLinks)
        .values({
          id: randomUUID(),
          fromMemoryId: row.id,
          toMemoryName: target,
          createdAt: Date.now(),
        })
        .run();
    }
  });
  tx();
}

export interface DeleteSnapshot {
  row: typeof memories.$inferSelect;
  tags: string[];
  links: string[];
}

export function deleteMemoryTx(workspaceId: string, name: string): DeleteSnapshot | null {
  const raw = getRawDb();
  const db = getDb();
  let snap: DeleteSnapshot | null = null;
  const tx = raw.transaction(() => {
    const row = db
      .select()
      .from(memories)
      .where(and(eq(memories.workspaceId, workspaceId), eq(memories.name, name)))
      .get();
    if (!row) return;
    snap = {
      row,
      tags: db
        .select()
        .from(memoryTags)
        .where(eq(memoryTags.memoryId, row.id))
        .all()
        .map((t) => t.tag),
      links: db
        .select()
        .from(memoryLinks)
        .where(eq(memoryLinks.fromMemoryId, row.id))
        .all()
        .map((l) => l.toMemoryName),
    };
    // ON DELETE CASCADE will clean tags/links automatically.
    db.delete(memories).where(eq(memories.id, row.id)).run();
  });
  tx();
  return snap;
}

export function restoreDeletedMemory(workspaceId: string, snap: DeleteSnapshot): void {
  const raw = getRawDb();
  const db = getDb();
  void workspaceId;
  const tx = raw.transaction(() => {
    db.insert(memories).values(snap.row).run();
    for (const tag of snap.tags) {
      db.insert(memoryTags).values({ memoryId: snap.row.id, tag }).run();
    }
    for (const target of snap.links) {
      db.insert(memoryLinks)
        .values({
          id: randomUUID(),
          fromMemoryId: snap.row.id,
          toMemoryName: target,
          createdAt: Date.now(),
        })
        .run();
    }
  });
  tx();
}

export function findBacklinks(workspaceId: string, toName: string): MemoryRowJoined[] {
  const db = getDb();
  // BUG-12: link/graph resolution lowercases note names, so backlink lookups
  // must be case-insensitive too — match with COLLATE NOCASE rather than a
  // binary `=`. Migration 0027 also makes the note-name uniqueness NOCASE so a
  // note and its inbound `[[Note]]` links agree on identity regardless of case.
  //
  // MEM-5: a note also answers to its aliases, so a `[[Alias]]` link counts as a
  // backlink to the target note. We resolve the target's aliases and match links
  // pointing at the canonical name OR any alias (all NOCASE).
  const targetRow = getMemoryRowByName(workspaceId, toName);
  const names = new Set<string>([toName.toLowerCase()]);
  if (targetRow) {
    names.add(targetRow.row.name.toLowerCase());
    for (const a of aliasesFromJson(targetRow.row.aliasesJson)) names.add(a.toLowerCase());
  }
  // Pull every link row in the workspace's note set, then filter case-insensitively
  // in JS so the alias-set membership test is a single pass (small volumes).
  const wsRows = db
    .select()
    .from(memories)
    .where(eq(memories.workspaceId, workspaceId))
    .all();
  if (wsRows.length === 0) return [];
  const wsIds = wsRows.map((r) => r.id);
  const linkRows = db
    .select()
    .from(memoryLinks)
    .where(inArray(memoryLinks.fromMemoryId, wsIds))
    .all();
  const matchingFromIds = new Set(
    linkRows.filter((l) => names.has(l.toMemoryName.toLowerCase())).map((l) => l.fromMemoryId),
  );
  if (matchingFromIds.size === 0) return [];
  // Exclude the target note linking to itself via its own alias.
  const targetId = targetRow?.row.id;
  return wsRows
    .filter((r) => matchingFromIds.has(r.id) && r.id !== targetId)
    .map((row) => joinAuxiliaryRows(row));
}

export function listOrphans(workspaceId: string): MemoryRowJoined[] {
  const all = listMemoryRows(workspaceId);
  if (all.length === 0) return [];
  const linksTo = new Set<string>();
  const linksFrom = new Set<string>();
  for (const m of all) {
    if (m.links.length > 0) linksFrom.add(m.row.name);
    for (const t of m.links) linksTo.add(t);
  }
  return all.filter((m) => !linksFrom.has(m.row.name) && !linksTo.has(m.row.name));
}

/** MEM-3 — distinct tags in a workspace with their note counts, busiest first
 *  (ties broken alphabetically). Reuses listMemoryRows (tags already joined). */
export function listTags(workspaceId: string): Array<{ tag: string; count: number }> {
  const counts = new Map<string, number>();
  for (const m of listMemoryRows(workspaceId)) {
    for (const t of m.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/** MEM-3 — notes carrying `tag` (most-recently-updated first). Exposed as a typed
 *  RPC for MCP/agent use + future server-side filtering of large vaults; the live
 *  Tags-pane filter is client-side over the already-loaded note set (review L2). */
export function listByTag(workspaceId: string, tag: string): MemoryRowJoined[] {
  return listMemoryRows(workspaceId)
    .filter((m) => m.tags.includes(tag))
    .sort((a, b) => b.row.updatedAt - a.row.updatedAt);
}

// ── PERF-14 — FTS5 full-text search ──────────────────────────────────────────

/**
 * Sanitize raw user input into a safe FTS5 MATCH expression. FTS5 has its own
 * query grammar (AND / OR / NOT / NEAR / column filters / prefix `*`), and raw
 * user input containing those operators — or an unbalanced quote — would throw
 * SQLITE_ERROR. We neutralize the grammar entirely by tokenizing the input into
 * bare alphanumeric/underscore terms and re-emitting each as a double-quoted
 * STRING (an FTS5 "string" matches the term literally). Inner double-quotes are
 * impossible after tokenization, so no escaping is needed. The terms are joined
 * with a space (implicit AND in FTS5). Returns '' when nothing usable remains.
 *
 * NO dynamic RegExp (semgrep ReDoS) — the term pattern is a static literal.
 */
export function sanitizeFtsQuery(query: string): string {
  if (!query) return '';
  const terms: string[] = [];
  // Static regex: runs of letters/digits/underscore length >= 1. The `g` flag
  // walks every term; FTS5 operator chars (", *, :, (), -, ^, etc.) and
  // whitespace act purely as separators and are discarded.
  const re = /[A-Za-z0-9_]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(query)) !== null) {
    terms.push(`"${m[0]}"`);
  }
  return terms.join(' ');
}

/**
 * Full-text search the `memories` FTS5 index (migration 0031). Ranks by
 * bm25(memories_fts) ascending (lower = better in FTS5) and joins back to
 * `memories` so we can filter to one workspace and surface the row fields.
 *
 * Returns [] when the sanitized query is empty OR the FTS index/table is
 * unavailable (e.g. migration not yet applied) — callers fall back to the JS
 * index in that case. The raw query is NEVER interpolated into SQL: the column
 * data uses bound params and the MATCH expression is the sanitized, fully
 * double-quoted term list.
 */
export function searchMemoriesFts(
  workspaceId: string,
  query: string,
  limit = 20,
): MemorySearchHit[] {
  const match = sanitizeFtsQuery(query);
  if (!match) return [];
  const raw = getRawDb();
  try {
    const rows = raw
      .prepare(
        `SELECT m.id   AS id,
                m.name AS name,
                m.body AS body,
                m.updated_at AS updatedAt,
                bm25(memories_fts) AS rank
           FROM memories_fts
           JOIN memories m ON m.rowid = memories_fts.rowid
          WHERE memories_fts MATCH ?
            AND m.workspace_id = ?
          ORDER BY rank ASC
          LIMIT ?`,
      )
      .all(match, workspaceId, limit) as Array<{
      id: string;
      name: string;
      body: string;
      updatedAt: number;
      rank: number;
    }>;
    // Surface the matched terms for snippet generation. We strip the surrounding
    // quotes back off the sanitized terms so the index's snippet() can locate
    // them in the body.
    const qTokens = match.split(' ').map((t) => t.replace(/"/g, '').toLowerCase());
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      // bm25 is negative (more-negative = better). Map to a positive descending
      // score so the renderer's existing "higher is better" assumption holds.
      score: -r.rank,
      snippet: ftsSnippet(r.body, qTokens),
      updatedAt: r.updatedAt,
    }));
  } catch {
    // FTS table missing / malformed MATCH that slipped past sanitization /
    // SQLITE_ERROR — degrade to empty so the manager falls back to the JS index.
    return [];
  }
}

/** Lightweight body excerpt around the first matched token (mirrors the
 *  index.ts snippet() heuristic). Kept local so db.ts has no import cycle with
 *  index.ts; the manager reuses index.ts's snippet for the JS-index path. */
function ftsSnippet(body: string, qTokens: string[]): string {
  if (!body) return '';
  const lower = body.toLowerCase();
  for (const tok of qTokens) {
    if (!tok) continue;
    const idx = lower.indexOf(tok);
    if (idx !== -1) {
      const start = Math.max(0, idx - 40);
      const end = Math.min(body.length, idx + tok.length + 80);
      const prefix = start > 0 ? '… ' : '';
      const suffix = end < body.length ? ' …' : '';
      return prefix + body.slice(start, end).replace(/\s+/g, ' ').trim() + suffix;
    }
  }
  return body.slice(0, 120).replace(/\s+/g, ' ').trim();
}
