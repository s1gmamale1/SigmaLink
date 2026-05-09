// SQLite-backed mailbox with a JSONL debug mirror.
//
// Concurrency contract (resolves architecture critique A2):
//   - SQLite is the system-of-record; every append goes through the
//     single-writer queue exposed by `enqueue()`.
//   - The JSONL file under <userData>/swarms/<swarmId>/inboxes/<agentKey>.jsonl
//     is a debug mirror written *after* the SQLite insert. A failed mirror
//     write does NOT roll back the SQLite row — the durable record lives in
//     the DB.
//   - For broadcasts the mailbox writes one DB row (toAgent='*') AND mirrors
//     into every targeted agent's JSONL so a future inbox tail tool sees the
//     message in each per-agent file.

import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import { swarmAgents, swarmMessages } from '../db/schema';
import type { SwarmMessage, SwarmMessageKind } from '../../../shared/types';

export interface MailboxAppend {
  swarmId: string;
  fromAgent: string;
  toAgent: string; // '*' for broadcast or agentKey
  kind: SwarmMessageKind;
  body: string;
  payload?: Record<string, unknown>;
}

type EmitFn = (message: SwarmMessage) => void;

interface QueueItem {
  run: () => Promise<SwarmMessage | SwarmMessage[]>;
  resolve: (v: SwarmMessage | SwarmMessage[]) => void;
  reject: (err: unknown) => void;
}

export class SwarmMailbox {
  private readonly userDataDir: string;
  private readonly queue: QueueItem[] = [];
  private draining = false;
  private emit: EmitFn = () => undefined;

  constructor(userDataDir: string) {
    this.userDataDir = userDataDir;
  }

  setEmitter(fn: EmitFn): void {
    this.emit = fn;
  }

  /** Path to a single agent's JSONL inbox. */
  inboxPathFor(swarmId: string, agentKey: string): string {
    return path.join(this.userDataDir, 'swarms', swarmId, 'inboxes', `${agentKey}.jsonl`);
  }

  /** Make sure the per-agent inbox file exists. Idempotent. */
  ensureInbox(swarmId: string, agentKey: string): string {
    const p = this.inboxPathFor(swarmId, agentKey);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    if (!fs.existsSync(p)) fs.writeFileSync(p, '');
    return p;
  }

  /** Append one message. Returns the persisted SwarmMessage. */
  append(input: MailboxAppend): Promise<SwarmMessage> {
    return this.enqueue(async () => this.doAppend(input)) as Promise<SwarmMessage>;
  }

  /** Enqueue any custom DB op behind the single-writer queue. */
  private enqueue(
    run: () => Promise<SwarmMessage | SwarmMessage[]>,
  ): Promise<SwarmMessage | SwarmMessage[]> {
    return new Promise((resolve, reject) => {
      this.queue.push({ run, resolve, reject });
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length) {
        const item = this.queue.shift()!;
        try {
          const out = await item.run();
          item.resolve(out);
        } catch (err) {
          item.reject(err);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private doAppend(input: MailboxAppend): SwarmMessage {
    const db = getDb();
    const id = randomUUID();
    const ts = Date.now();
    const payloadJson = input.payload ? JSON.stringify(input.payload) : null;
    db.insert(swarmMessages)
      .values({
        id,
        swarmId: input.swarmId,
        fromAgent: input.fromAgent,
        toAgent: input.toAgent,
        kind: input.kind,
        body: input.body,
        payloadJson,
        ts,
        deliveredAt: ts,
      })
      .run();

    const message: SwarmMessage = {
      id,
      swarmId: input.swarmId,
      fromAgent: input.fromAgent,
      toAgent: input.toAgent,
      kind: input.kind,
      body: input.body,
      payload: input.payload,
      ts,
    };

    // JSONL mirror — best effort. Failure to write the debug file must not
    // roll back the durable SQLite record.
    try {
      const recipients = this.recipientsFor(input.swarmId, input.toAgent);
      const line = JSON.stringify(message) + '\n';
      for (const key of recipients) {
        const p = this.inboxPathFor(input.swarmId, key);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.appendFileSync(p, line);
      }
      // Also mirror into the outbox for a stable side-chat tail file.
      const outboxPath = path.join(this.userDataDir, 'swarms', input.swarmId, 'outbox.jsonl');
      fs.mkdirSync(path.dirname(outboxPath), { recursive: true });
      fs.appendFileSync(outboxPath, line);
    } catch {
      /* best-effort mirror */
    }

    try {
      this.emit(message);
    } catch {
      /* renderer event broadcast is fire-and-forget */
    }

    return message;
  }

  private recipientsFor(swarmId: string, toAgent: string): string[] {
    if (toAgent !== '*') return [toAgent];
    const db = getDb();
    const rows = db
      .select({ agentKey: swarmAgents.agentKey })
      .from(swarmAgents)
      .where(eq(swarmAgents.swarmId, swarmId))
      .all();
    return rows.map((r) => r.agentKey);
  }

  /** Tail recent messages for a swarm. Newest last for chronological render. */
  tail(swarmId: string, opts: { limit?: number } = {}): SwarmMessage[] {
    const db = getDb();
    const limit = Math.max(1, Math.min(opts.limit ?? 200, 1000));
    const rows = db
      .select()
      .from(swarmMessages)
      .where(eq(swarmMessages.swarmId, swarmId))
      .orderBy(asc(swarmMessages.ts))
      .all();
    const slice = rows.slice(-limit);
    return slice.map((r) => rowToMessage(r));
  }

  markRead(swarmId: string, messageId: string): void {
    const db = getDb();
    db.update(swarmMessages)
      .set({ readAt: Date.now() })
      .where(and(eq(swarmMessages.id, messageId), eq(swarmMessages.swarmId, swarmId)))
      .run();
  }
}

function rowToMessage(row: typeof swarmMessages.$inferSelect): SwarmMessage {
  let payload: Record<string, unknown> | undefined;
  if (row.payloadJson) {
    try {
      const parsed = JSON.parse(row.payloadJson);
      if (parsed && typeof parsed === 'object') {
        payload = parsed as Record<string, unknown>;
      }
    } catch {
      /* ignore */
    }
  }
  return {
    id: row.id,
    swarmId: row.swarmId,
    fromAgent: row.fromAgent,
    toAgent: row.toAgent,
    kind: row.kind as SwarmMessage['kind'],
    body: row.body,
    payload,
    ts: row.ts,
    readAt: row.readAt ?? null,
  };
}
