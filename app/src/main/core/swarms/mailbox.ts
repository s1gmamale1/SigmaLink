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
import type { BoardManager } from './boards';
import { GROUP_TO_ROLE, isRecipientGroup, type MailboxKind } from './types';

export interface MailboxAppend {
  swarmId: string;
  fromAgent: string;
  toAgent: string; // '*' for broadcast or agentKey
  // Allow V3 envelope kinds (`board_post`, `directive`, …) alongside the
  // legacy SIGMA::* verbs. The DB column is plain TEXT so any string is
  // storable; this widening just lets callers use the typed union without
  // casting through `as`.
  kind: SwarmMessageKind | MailboxKind;
  body: string;
  payload?: Record<string, unknown>;
  /**
   * For `directive` envelopes only — when set to `'pane'`, the mailbox fans
   * the recipient out through the swarm roster and calls the registered
   * `paneEcho` closure after the durable insert so each target agent's PTY
   * stdin receives `[Operator → <Role> <N>] <body>\n`. Other kinds ignore
   * this field.
   */
  echo?: 'pane';
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
  // V3-W13-008 — optional board manager wired at boot from rpc-router. Kept
  // optional so unit tests that exercise the mailbox in isolation don't have
  // to construct a manager just to satisfy the type.
  private boardManager: BoardManager | null = null;
  // V3-W13-009 — pane-echo writer. The router supplies a closure that knows
  // how to resolve a concrete agentKey → sessionId and write to the PTY. The
  // mailbox expands groups and calls it after every `directive` insert with
  // `echo === 'pane'`.
  private paneEcho:
    | ((swarmId: string, toAgent: string, body: string) => void)
    | null = null;

  constructor(userDataDir: string) {
    this.userDataDir = userDataDir;
  }

  setEmitter(fn: EmitFn): void {
    this.emit = fn;
  }

  setBoardManager(manager: BoardManager): void {
    this.boardManager = manager;
  }

  setPaneEcho(
    fn: (swarmId: string, toAgent: string, body: string) => void,
  ): void {
    this.paneEcho = fn;
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
      // SwarmMessage.kind is the legacy SIGMA::* enum; V3 envelope kinds are
      // wider but still serialise as a plain string column. Cast at the
      // boundary so callers can pass the typed union without losing the V3
      // `kind` strings on the wire.
      kind: input.kind as SwarmMessageKind,
      body: input.body,
      payload: input.payload,
      ts,
    };

    // JSONL mirror — best effort. Failure to write the debug file must not
    // roll back the durable SQLite record.
    //
    // BUG-V1.1.3-ORCH-01 (audit fix): wrap each recipient's mirror in its own
    // try/catch so a single failing fs.appendFileSync (permission flap, ENOSPC,
    // a destroyed inbox path) cannot abort the broadcast loop and silently
    // strand the remaining recipients. Failures are logged with the recipient
    // key + swarmId so an operator can correlate against the audit log; the
    // outbox mirror is its own isolated step for the same reason.
    const line = JSON.stringify(message) + '\n';
    let recipients: string[] = [];
    try {
      recipients = this.recipientsFor(input.swarmId, input.toAgent);
    } catch (err) {
      console.warn(
        `[mailbox] recipient expansion failed for swarm=${input.swarmId} to=${input.toAgent}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    for (const key of recipients) {
      try {
        const p = this.inboxPathFor(input.swarmId, key);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.appendFileSync(p, line);
      } catch (err) {
        console.warn(
          `[mailbox] JSONL mirror failed for swarm=${input.swarmId} agent=${key}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    try {
      const outboxPath = path.join(this.userDataDir, 'swarms', input.swarmId, 'outbox.jsonl');
      fs.mkdirSync(path.dirname(outboxPath), { recursive: true });
      fs.appendFileSync(outboxPath, line);
    } catch (err) {
      console.warn(
        `[mailbox] outbox mirror failed for swarm=${input.swarmId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // V3-W13-008 — board_post side effect. After the mailbox row lands, mirror
    // the post into the `boards` table + on-disk markdown file. Failures are
    // logged but do NOT roll back the mailbox row: the envelope is the
    // durable record, the board file is a derived artifact.
    if (input.kind === 'board_post' && this.boardManager) {
      try {
        const p = (input.payload ?? {}) as Record<string, unknown>;
        const title = typeof p.title === 'string' ? p.title : '(untitled)';
        const bodyMd = typeof p.bodyMd === 'string' ? p.bodyMd : input.body;
        const postId = typeof p.boardId === 'string' ? p.boardId : undefined;
        const attachments = Array.isArray(p.attachments)
          ? (p.attachments as unknown[]).filter(
              (s): s is string => typeof s === 'string',
            )
          : undefined;
        // The agent that posted owns the namespace. For broadcast posts we
        // skip the board write — boards are per-agent by definition.
        if (input.fromAgent !== '*' && input.fromAgent !== 'operator') {
          this.boardManager.create(input.swarmId, input.fromAgent, {
            postId,
            title,
            bodyMd,
            attachments,
          });
        }
      } catch {
        /* board write failure is non-fatal for the mailbox */
      }
    }

    // V3-W13-009 — directive.echo='pane' side effect. Resolve group selectors
    // (`@all`, `@coordinators`, …) before calling the router-supplied closure.
    // The closure intentionally handles concrete agent keys only so pane echo
    // stays scoped to this swarm's roster and cannot leak to same-named agents
    // in a different swarm.
    //
    // BUG-V1.1.3-ORCH-01 (audit fix): isolate each paneEcho call in its own
    // try/catch so one PTY that has exited can't strand the rest of the
    // broadcast. The closure may throw if the renderer-side write fails; we
    // log per-recipient and keep delivering.
    if (input.kind === 'directive' && input.echo === 'pane' && this.paneEcho) {
      let paneRecipients: string[] = [];
      try {
        paneRecipients = this.recipientsFor(input.swarmId, input.toAgent);
      } catch (err) {
        console.warn(
          `[mailbox] paneEcho recipient expansion failed for swarm=${input.swarmId} to=${input.toAgent}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      for (const key of paneRecipients) {
        try {
          this.paneEcho(input.swarmId, key, input.body);
        } catch (err) {
          console.warn(
            `[mailbox] paneEcho failed for swarm=${input.swarmId} agent=${key}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    try {
      this.emit(message);
    } catch {
      /* renderer event broadcast is fire-and-forget */
    }

    return message;
  }

  private recipientsFor(swarmId: string, toAgent: string): string[] {
    return expandRecipient(swarmId, toAgent);
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

/**
 * Expand a mailbox `toAgent` field into the concrete list of agent keys that
 * should receive the envelope. Resolves V3 group selectors (`@all`,
 * `@coordinators`, `@builders`, `@scouts`, `@reviewers`) and the legacy `'*'`
 * broadcast against `swarm_agents` for the given swarmId. Literal agent keys
 * are validated against the swarm's roster — unknown keys return `[]` and log
 * a warning so an Operator's directive cannot be silently dropped onto a
 * non-existent inbox file.
 *
 * Resolves BUG-V1.1-01-IPC: previously `recipientsFor` short-circuited on any
 * `toAgent !== '*'` and returned the literal string, so a `@coordinators`
 * envelope mirrored into `inboxes/@coordinators.jsonl` and zero PTYs received
 * the SIGMA:: line.
 */
export function expandRecipient(swarmId: string, recipient: string): string[] {
  if (!recipient) return [];
  // Broadcasts: '*' (legacy wire) and '@all' (V3 canonical) both expand to
  // every agent in the swarm.
  if (recipient === '*' || recipient === '@all') {
    const db = getDb();
    const rows = db
      .select({ agentKey: swarmAgents.agentKey })
      .from(swarmAgents)
      .where(eq(swarmAgents.swarmId, swarmId))
      .all();
    return rows.map((r) => r.agentKey);
  }
  // Role-scoped groups: expand against the role column.
  if (isRecipientGroup(recipient)) {
    const role = GROUP_TO_ROLE[recipient as keyof typeof GROUP_TO_ROLE];
    if (!role) return [];
    const db = getDb();
    const rows = db
      .select({ agentKey: swarmAgents.agentKey })
      .from(swarmAgents)
      .where(and(eq(swarmAgents.swarmId, swarmId), eq(swarmAgents.role, role)))
      .all();
    return rows.map((r) => r.agentKey);
  }
  // Literal agentKey — verify membership before honouring it. An unknown key
  // (typo, stale roster) returns `[]` instead of producing a phantom inbox
  // file the operator can never read from.
  const db = getDb();
  const hit = db
    .select({ agentKey: swarmAgents.agentKey })
    .from(swarmAgents)
    .where(and(eq(swarmAgents.swarmId, swarmId), eq(swarmAgents.agentKey, recipient)))
    .get();
  if (!hit) {
    console.warn(
      `[mailbox] expandRecipient: unknown recipient "${recipient}" for swarm ${swarmId}`,
    );
    return [];
  }
  return [hit.agentKey];
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
