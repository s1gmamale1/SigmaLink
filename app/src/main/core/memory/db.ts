// DB layer for memories: row -> Memory mapping plus transactional helpers
// that callers wrap around the file-system writes. Per A3 in
// `docs/04-critique/01-architecture.md`, callers must commit the SQL
// transaction FIRST, then write the file. If the file write fails, the
// rollback function exported here restores the previous DB state.

import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { getDb, getRawDb } from '../db/client';
import { memories, memoryLinks, memoryTags } from '../db/schema';
import type { Memory } from '../../../shared/types';
import { uniqueLinkTargets } from './parse';

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
  };
}

export function getMemoryRowByName(workspaceId: string, name: string): MemoryRowJoined | null {
  const db = getDb();
  const row = db
    .select()
    .from(memories)
    .where(and(eq(memories.workspaceId, workspaceId), eq(memories.name, name)))
    .get();
  if (!row) return null;
  return joinAuxiliaryRows(row);
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
        .set({ body: args.body, updatedAt: now })
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
          frontmatterJson: null,
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
    db.update(memories)
      .set({ body: previous.body })
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
  const linkRows = db
    .select()
    .from(memoryLinks)
    .where(eq(memoryLinks.toMemoryName, toName))
    .all();
  if (linkRows.length === 0) return [];
  const candidateIds = Array.from(new Set(linkRows.map((l) => l.fromMemoryId)));
  const rows = db
    .select()
    .from(memories)
    .where(
      and(eq(memories.workspaceId, workspaceId), inArray(memories.id, candidateIds)),
    )
    .all();
  return rows.map((row) => joinAuxiliaryRows(row));
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
