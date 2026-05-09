// V3-W13-008 — Per-agent board namespace.
//
// Persists `board_post` envelopes into:
//   1. `boards` SQLite table (system of record).
//   2. `<userData>/swarms/<swarmId>/boards/<agentId>/<postId>.md` (atomic
//      temp+rename so a partial write never leaves a half-baked file).
//
// Concurrency contract:
//   - DB row is inserted *first* inside an immediate transaction. The disk
//     write is performed inside the same try/catch; a write failure issues a
//     `DELETE FROM boards WHERE id = ?` rollback before re-throwing. The
//     SQLite transaction is committed only after the file is safely renamed
//     into place — so a successful return implies both row + file exist.
//   - The temp file uses a `.tmp-<uuid>` suffix so concurrent writers for
//     the same `<postId>` (should never happen in practice) cannot collide.

import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import { boards, type BoardRow } from '../db/schema';

export interface BoardPostInput {
  /** Stable user-facing post identifier (envelope payload `boardId`). */
  postId?: string;
  title: string;
  bodyMd: string;
  attachments?: string[];
}

export interface BoardPostRecord {
  id: string;
  swarmId: string;
  agentId: string;
  postId: string;
  title: string;
  bodyMd: string;
  attachments: string[];
  createdAt: number;
  filePath: string;
}

export class BoardManager {
  private readonly userDataDir: string;

  constructor(userDataDir: string) {
    this.userDataDir = userDataDir;
  }

  /** Absolute path to the markdown file for a given post. */
  postFilePath(swarmId: string, agentId: string, postId: string): string {
    return path.join(
      this.userDataDir,
      'swarms',
      swarmId,
      'boards',
      agentId,
      `${postId}.md`,
    );
  }

  /**
   * Create a board post. Inserts a `boards` row and atomically writes the
   * markdown file. On disk-write failure, the DB row is rolled back so the
   * two stores stay consistent.
   */
  create(
    swarmId: string,
    agentId: string,
    input: BoardPostInput,
  ): BoardPostRecord {
    const postId = (input.postId && input.postId.trim()) || randomUUID();
    const id = randomUUID();
    const createdAt = Date.now();
    const attachments = input.attachments ?? [];
    const attachmentsJson = JSON.stringify(attachments);
    const filePath = this.postFilePath(swarmId, agentId, postId);

    const db = getDb();
    db.insert(boards)
      .values({
        id,
        swarmId,
        agentId,
        postId,
        title: input.title,
        bodyMd: input.bodyMd,
        attachmentsJson,
        createdAt,
      })
      .run();

    try {
      writeAtomic(filePath, input.bodyMd);
    } catch (err) {
      // File write failed — roll the row back so the DB never claims a post
      // that has no on-disk artifact.
      try {
        db.delete(boards).where(eq(boards.id, id)).run();
      } catch {
        /* best-effort; surface the original error */
      }
      throw err;
    }

    return {
      id,
      swarmId,
      agentId,
      postId,
      title: input.title,
      bodyMd: input.bodyMd,
      attachments,
      createdAt,
      filePath,
    };
  }

  /**
   * List board posts for a swarm. When `agentId` is provided, scoped to that
   * agent's namespace. Hydrates `bodyMd` from disk when the file still exists,
   * falling back to the DB column otherwise (e.g. after manual file deletion).
   */
  list(swarmId: string, agentId?: string): BoardPostRecord[] {
    const db = getDb();
    const where = agentId
      ? and(eq(boards.swarmId, swarmId), eq(boards.agentId, agentId))
      : eq(boards.swarmId, swarmId);
    const rows = db
      .select()
      .from(boards)
      .where(where)
      .orderBy(desc(boards.createdAt))
      .all();
    return rows.map((row) => this.hydrate(row));
  }

  private hydrate(row: BoardRow): BoardPostRecord {
    const filePath = this.postFilePath(row.swarmId, row.agentId, row.postId);
    let bodyMd = row.bodyMd;
    try {
      if (fs.existsSync(filePath)) {
        bodyMd = fs.readFileSync(filePath, 'utf8');
      }
    } catch {
      /* fall back to DB body */
    }
    let attachments: string[] = [];
    try {
      const parsed = JSON.parse(row.attachmentsJson);
      if (Array.isArray(parsed)) {
        attachments = parsed.filter((s): s is string => typeof s === 'string');
      }
    } catch {
      /* default to empty */
    }
    return {
      id: row.id,
      swarmId: row.swarmId,
      agentId: row.agentId,
      postId: row.postId,
      title: row.title,
      bodyMd,
      attachments,
      createdAt: row.createdAt,
      filePath,
    };
  }
}

/**
 * Write `data` to `dest` via a temp+rename to avoid torn-write states. The
 * directory is created on demand. The temp suffix is randomised so concurrent
 * writers can't stomp each other.
 */
function writeAtomic(dest: string, data: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp-${randomUUID()}`;
  fs.writeFileSync(tmp, data, 'utf8');
  fs.renameSync(tmp, dest);
}
