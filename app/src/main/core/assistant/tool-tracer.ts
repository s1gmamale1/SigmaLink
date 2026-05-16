// V3-W13-013 — Sigma Assistant tool-trace bus.
// P3-S7 — Persistence: every traced tool call is now also written to the
// `messages` table with role='tool', `toolCallId` set to the trace id, and
// `content` carrying a JSON-serialised {name, args, result|error} payload.
// The in-memory ring buffer survives as a fast read-back path for the
// renderer's ToolCallInspector; the DB row is the source of truth so the
// trace replays cleanly across sessions.
//
// The ring buffer caps at MAX_TRACES so a long-running session can't unbound
// memory; the DB row stays.

import type { Message } from './conversations';
import { appendMessage } from './conversations';

export interface ToolTrace {
  /** ulid/uuid issued by the controller; mirrored as `messages.toolCallId`
   *  so the renderer can reconcile a streamed trace event back to its
   *  persisted row after a reload. */
  id: string;
  conversationId: string | null;
  name: string;
  startedAt: number;
  finishedAt: number;
  args: Record<string, unknown>;
  ok: boolean;
  result: unknown;
  error?: string;
  /** P3-S7 — set after the DB write succeeds so the renderer can prove the
   *  trace is persisted (vs in-flight). */
  messageId?: string;
}

const MAX_TRACES = 200;

type Emit = (event: string, payload: unknown) => void;

export class ToolTracer {
  private readonly buffer: ToolTrace[] = [];
  private emit: Emit = () => undefined;

  setEmitter(fn: Emit): void {
    this.emit = fn;
  }

  /**
   * Persist + cache + announce a trace. Persistence is best-effort: if the
   * DB write throws (e.g. the conversation row was deleted mid-turn) the
   * trace still flows through the in-memory buffer and the emitted event
   * so the renderer doesn't lose visibility — we just don't get a back-link.
   *
   * Mutates the input `trace` to set `messageId` after a successful DB
   * write so callers can chain the persisted id (e.g. into `swarm_origins`)
   * without a second lookup.
   */
  record(trace: ToolTrace): void {
    if (trace.conversationId) {
      try {
        const persisted = persistTrace(trace);
        trace.messageId = persisted.id;
      } catch {
        /* persistence is best-effort; in-memory buffer below is still
         * authoritative for this session's read-back. */
      }
    }
    this.buffer.push(trace);
    if (this.buffer.length > MAX_TRACES) {
      this.buffer.splice(0, this.buffer.length - MAX_TRACES);
    }
    try {
      this.emit('assistant:tool-trace', trace);
    } catch {
      /* best-effort */
    }
  }

  list(): ToolTrace[] {
    return [...this.buffer];
  }
}

/** Internal: serialise the trace into a `messages` row. Wrapped so the
 *  controller can call this directly when the persisted message id needs
 *  to be linked elsewhere (e.g. swarm_origins on `create_swarm`). */
export function persistTrace(trace: ToolTrace): Message {
  if (!trace.conversationId) {
    throw new Error('persistTrace: conversationId required');
  }
  const payload = trace.ok
    ? { name: trace.name, args: trace.args, result: trace.result }
    : { name: trace.name, args: trace.args, error: trace.error ?? 'unknown' };
  return appendMessage({
    conversationId: trace.conversationId,
    role: 'tool',
    content: JSON.stringify(payload),
    toolCallId: trace.id,
  });
}

/** Coerce arbitrary values into a JSON-safe representation for tracing. */
export function safeSerialize(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth-cutoff]';
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') return value;
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((v) => safeSerialize(v, depth + 1));
  }
  if (t === 'object') {
    const out: Record<string, unknown> = {};
    let i = 0;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (i++ >= 50) {
        out['…truncated'] = true;
        break;
      }
      out[k] = safeSerialize(v, depth + 1);
    }
    return out;
  }
  return `[${t}]`;
}
