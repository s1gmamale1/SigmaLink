// V3-W14-002 / v1.1.9 — Stream/state emit helpers extracted from
// runClaudeCliTurn.ts. These wrap `deps.emit` for the renderer-compat IPC
// channels (`assistant:state`), persist the final assistant message back
// into the conversations DB, and provide the small stdin-write queue +
// timeout primitives the turn driver depends on. Internal-only — not
// surfaced through any barrel; the only caller is runClaudeCliTurn.ts and
// runClaudeCliTurn.trajectory.ts (for `withTimeout` + `StdinWriter`).
//
// Splitting these out lets runClaudeCliTurn.ts focus on the spawn /
// envelope-routing top-level loop while keeping the test surface
// (`__resetProbeCache`, `__resetActiveChildren`, `runClaudeCliTurn`,
// `cancelClaudeCliTurn`) on the parent module.

import { eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import { messages as messagesTable } from '../db/schema';
import type { CliChildLike, CliTurnDeps, CliTurnHandle } from './runClaudeCliTurn';

export interface StdinWriter {
  enqueue(line: string): Promise<void>;
  drain(): Promise<void>;
}

/**
 * Slice `text` into 4-char chunks and emit each as a `kind:'delta'`
 * envelope. Matches the W13 stub cadence so the renderer's typing
 * animation stays consistent across the CLI and stub paths.
 */
export function streamDelta(
  deps: CliTurnDeps,
  turn: CliTurnHandle,
  messageId: string | null,
  text: string,
): void {
  // We don't `await` between chunks — the CLI emits the text in one
  // envelope, and re-emitting it slowly would defeat the live-stream UX.
  // The renderer handles however many deltas land in a tick.
  const CHUNK = 4;
  for (let i = 0; i < text.length; i += CHUNK) {
    emitDelta(deps, turn, messageId, text.slice(i, i + CHUNK));
  }
}

export function emitDelta(
  deps: CliTurnDeps,
  turn: CliTurnHandle,
  messageId: string | null,
  delta: string,
): void {
  if (!delta) return;
  try {
    deps.emit('assistant:state', {
      kind: 'delta',
      conversationId: turn.conversationId,
      turnId: turn.turnId,
      messageId,
      delta,
    });
  } catch {
    /* best-effort */
  }
}

export function emitState(
  deps: CliTurnDeps,
  state: 'standby' | 'listening' | 'receiving' | 'thinking',
  turn: CliTurnHandle,
  extra?: Record<string, unknown>,
): void {
  try {
    deps.emit('assistant:state', {
      kind: 'state',
      state,
      conversationId: turn.conversationId,
      turnId: turn.turnId,
      ...extra,
    });
  } catch {
    /* best-effort */
  }
}

export function emitFinal(
  deps: CliTurnDeps,
  turn: CliTurnHandle,
  messageId: string | null,
  text: string,
  usage?: unknown,
): void {
  // Forward-compat envelope (`kind: 'final'`) for any consumer wanting the
  // rich shape; the existing renderer ignores unknown kinds.
  try {
    deps.emit('assistant:state', {
      kind: 'final',
      conversationId: turn.conversationId,
      turnId: turn.turnId,
      messageId,
      text,
      usage: usage ?? null,
    });
  } catch {
    /* best-effort */
  }
  // Renderer-compat: standby with messageId is what BridgeRoom uses to
  // commit the streamed message into the transcript.
  emitState(deps, 'standby', turn, { messageId });
}

export function emitErrorFinal(
  deps: CliTurnDeps,
  turn: CliTurnHandle,
  message: string,
  messageId: string | null = null,
): void {
  // Surface the error inline as a delta so the user sees the failure text
  // even on the legacy renderer (which only handles delta + state).
  emitDelta(deps, turn, messageId, message);
  try {
    deps.emit('assistant:state', {
      kind: 'error',
      conversationId: turn.conversationId,
      turnId: turn.turnId,
      messageId,
      message,
    });
  } catch {
    /* best-effort */
  }
  emitState(deps, 'standby', turn, { messageId, error: message });
}

export function persistFinal(
  turn: CliTurnHandle,
  messageId: string | null,
  text: string,
): void {
  if (!messageId || !turn.conversationId) return;
  try {
    getDb()
      .update(messagesTable)
      .set({ content: text })
      .where(eq(messagesTable.id, messageId))
      .run();
  } catch {
    /* persistence is best-effort */
  }
}

/** Default per-write timeout for stdin writes to the CLI child (ms). */
export const STDIN_WRITE_TIMEOUT_MS = 30_000;

export interface CreateStdinWriterOptions {
  /** Per-write timeout. Defaults to {@link STDIN_WRITE_TIMEOUT_MS}. */
  timeoutMs?: number;
  /**
   * Invoked when a write times out. Production passes `() => child.kill()` so
   * a hung CLI is torn down; tests can stub this to avoid actually killing.
   */
  onTimeout?: (reason: 'stdin_write_timeout') => void;
}

/**
 * Build the stdin-write queue used by the CLI turn driver.
 *
 * BUG-V1.1.3-ORCH-03 (audit fix): the prior implementation chained writes
 * through a promise tail with no timeout. If the CLI process stopped draining
 * stdin — say it crashed, hung in a syscall, or filled its kernel pipe buffer —
 * the per-write Promise resolved by `child.stdin.write(line, cb)` would never
 * settle, the chain would freeze, and the turn driver's `await
 * stdinWriter.enqueue(...)` would hang forever (the parent turn never finishes,
 * the renderer's "thinking" spinner spins forever).
 *
 * Each enqueue now races against {@link CreateStdinWriterOptions.timeoutMs}
 * (default 30s). On timeout we reject the write with `Error('stdin_write_timeout')`
 * AND invoke {@link CreateStdinWriterOptions.onTimeout} so the caller can kill
 * the hung child. The chain's `.catch(() => undefined)` link is preserved so
 * subsequent enqueues are not poisoned by a prior timeout — the turn driver
 * decides whether to keep writing or abort.
 */
export function createStdinWriter(
  child: CliChildLike,
  opts: CreateStdinWriterOptions = {},
): StdinWriter {
  const timeoutMs = Math.max(1, opts.timeoutMs ?? STDIN_WRITE_TIMEOUT_MS);
  const onTimeout = opts.onTimeout;
  let writeChain = Promise.resolve();
  return {
    enqueue(line: string): Promise<void> {
      writeChain = writeChain
        .catch(() => undefined)
        .then(
          () =>
            new Promise<void>((resolve, reject) => {
              let settled = false;
              let timer: NodeJS.Timeout | null = setTimeout(() => {
                if (settled) return;
                settled = true;
                timer = null;
                try {
                  onTimeout?.('stdin_write_timeout');
                } catch {
                  /* best-effort — caller may have already torn down */
                }
                reject(new Error('stdin_write_timeout'));
              }, timeoutMs);
              try {
                child.stdin.write(line, (err?: Error | null) => {
                  if (settled) return;
                  settled = true;
                  if (timer) {
                    clearTimeout(timer);
                    timer = null;
                  }
                  if (err) reject(err);
                  else resolve();
                });
              } catch (err) {
                if (settled) return;
                settled = true;
                if (timer) {
                  clearTimeout(timer);
                  timer = null;
                }
                reject(err instanceof Error ? err : new Error(String(err)));
              }
            }),
        );
      return writeChain;
    },
    drain(): Promise<void> {
      return writeChain;
    },
  };
}

export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  toolName: string,
): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`tool_timeout: ${toolName}`));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
