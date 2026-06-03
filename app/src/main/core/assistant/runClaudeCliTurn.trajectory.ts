// V3-W14-002 / v1.1.9 — Tool-routing + Ruflo trajectory + readline-loop
// handlers extracted from runClaudeCliTurn.ts. All trajectory + tracing
// writes are fail-soft. Internal-only.

import { randomUUID } from 'node:crypto';
import {
  parseCliLine,
  isAssistantEnvelope,
  isResultEnvelope,
  isResultSuccess,
  isSystemInitEnvelope,
  type CliAssistantEnvelope,
  type CliAssistantContentBlock,
  type CliResultErrorEnvelope,
  type CliResultSuccessEnvelope,
} from './cli-envelope';
import { getDb } from '../db/client';
import { recordTurn } from '../usage/dao';
import { safeSerialize, type ToolTrace, type ToolTracer } from './tool-tracer';
import { findTool } from './tools';
import type { CliTurnDeps, CliTurnHandle } from './runClaudeCliTurn';
import {
  emitErrorFinal,
  emitFinal,
  emitState,
  persistFinal,
  streamDelta,
  withTimeout,
  type StdinWriter,
} from './runClaudeCliTurn.emit';
import * as conversationsDao from './conversations';

export interface TurnLoopState {
  sawResult: boolean;
  receivingEmitted: boolean;
  finalText: string;
  capturedSessionId?: string;
  resumeAttempted?: boolean;
  resumeLikelyFailed?: boolean;
  /**
   * B3 — set true when the overall turn timeout fired and already emitted an
   * error-final. `finalizeTurnOnClose` checks this so the subsequent `close`
   * (from the kill) doesn't emit a second, redundant error.
   */
  timedOut?: boolean;
}

export interface TurnLoopCtx {
  deps: CliTurnDeps;
  turn: CliTurnHandle;
  assistantMessageId: string | null;
  stdinWriter: StdinWriter;
  trajectoryId: string | null;
  pendingToolRoutes: Set<Promise<void>>;
}

/** Drive a single parsed CLI envelope through emit/route/persist. Mutates `state`. */
export function handleParsedEnvelope(
  env: NonNullable<ReturnType<typeof parseCliLine>>,
  ctx: TurnLoopCtx,
  state: TurnLoopState,
): void {
  const { deps, turn, assistantMessageId, stdinWriter, trajectoryId, pendingToolRoutes } = ctx;
  if (!state.receivingEmitted && env.type !== 'system') {
    emitState(deps, 'receiving', turn);
    state.receivingEmitted = true;
  }
  if (isSystemInitEnvelope(env)) {
    captureClaudeSessionId(turn.conversationId, env.session_id, state);
  } else if (isAssistantEnvelope(env)) {
    for (const block of env.message.content ?? []) {
      if (block.type === 'text' && typeof block.text === 'string') {
        // 4-char chunks via streamDelta so JorvisRoom's typing animation fires.
        state.finalText += block.text;
        streamDelta(deps, turn, assistantMessageId, block.text);
      }
    }
    const p = routeToolUse(env, deps, turn, stdinWriter, trajectoryId).catch((err) => {
      const m = err instanceof Error ? err.message : String(err);
      console.warn(`[runClaudeCliTurn] failed to route tool_use: ${m}`);
    });
    pendingToolRoutes.add(p);
    p.finally(() => pendingToolRoutes.delete(p));
  } else if (isResultEnvelope(env)) {
    state.sawResult = true;
    if (state.resumeAttempted && env.subtype === 'error_during_execution') {
      state.resumeLikelyFailed = true;
      return;
    }
    if (isResultSuccess(env)) {
      const text = env.result ?? state.finalText;
      if (text && text !== state.finalText) {
        const remainder = text.slice(state.finalText.length);
        if (remainder) streamDelta(deps, turn, assistantMessageId, remainder);
        state.finalText = text;
      }
      // H-19 — scrub PII from the FINAL reply BEFORE persist + emit. The scrub
      // is async but the readline loop is sync, so we track the finalisation
      // promise in `pendingToolRoutes`, which the `close` handler awaits before
      // resolving the turn — guaranteeing the (scrubbed) final lands. The
      // trajectory feedback (internal Ruflo learning) keeps the raw text.
      const finalP = finalizeSuccess(deps, turn, assistantMessageId, state.finalText, env.usage)
        .catch((err) => {
          const m = err instanceof Error ? err.message : String(err);
          console.warn(`[runClaudeCliTurn] final scrub/emit failed: ${m}`);
        });
      pendingToolRoutes.add(finalP);
      finalP.finally(() => pendingToolRoutes.delete(finalP));
      // FEAT-3 — record this turn's token/cost into the usage ledger. Fully
      // defensive + fire-and-forget: a recording failure must never affect the
      // reply. Synchronous DAO write wrapped in its own try/catch inside.
      recordTurnUsage(turn, env);
      void endTrajectory(deps, trajectoryId, true, state.finalText.slice(0, 300));
      return;
    }
    const errMsg = (env as CliResultErrorEnvelope).result ?? `claude CLI returned ${env.subtype}`;
    persistFinal(turn, assistantMessageId, errMsg);
    emitErrorFinal(deps, turn, errMsg, assistantMessageId);
    void endTrajectory(deps, trajectoryId, false, errMsg.slice(0, 300));
  }
  // system / user / unknown envelopes are log-only.
}

/**
 * H-19 — finalise a successful turn: scrub the reply (opportunistic, fail-open),
 * then persist + emit the scrubbed text. Async so it can `await deps.scrubFinal`;
 * the caller tracks the returned promise so the turn waits for the emit.
 *
 * Fail-open contract: a THROWING / rejecting `scrubFinal` must NOT drop or block
 * the reply — on any scrub error we fall back to the ORIGINAL text. The persist
 * and the emit both receive the SAME (scrubbed-or-original) text so the stored
 * transcript matches what the renderer shows (no PII persisted while displaying
 * a scrubbed reply, or vice-versa).
 */
export async function finalizeSuccess(
  deps: CliTurnDeps,
  turn: CliTurnHandle,
  assistantMessageId: string | null,
  finalText: string,
  usage: unknown,
): Promise<void> {
  let outText = finalText;
  if (deps.scrubFinal) {
    try {
      const scrubbed = await deps.scrubFinal(finalText);
      if (typeof scrubbed === 'string') outText = scrubbed;
    } catch {
      // Fail-open: keep the original reply. Never drop or block on a scrub error.
      outText = finalText;
    }
  }
  persistFinal(turn, assistantMessageId, outText);
  emitFinal(deps, turn, assistantMessageId, outText, usage);
}

/**
 * FEAT-3 — harvest token/cost from a successful `result` envelope into the
 * usage ledger. Keyed by `conversationId` (the assistant has no agent_sessions
 * row, so `sessionId` is NULL) with `providerId: 'claude'` — the assistant CLI
 * turn path is the only machine-readable usage source today.
 *
 * Fully defensive: every read goes through a numeric coercion in the DAO, and
 * the whole call is wrapped in try/catch so a missing DB (pre-boot / tests) or a
 * malformed envelope can NEVER throw into the turn loop. Synchronous fire-and-
 * forget — not awaited; the DAO write is a single better-sqlite3 INSERT.
 */
export function recordTurnUsage(
  turn: CliTurnHandle,
  env: CliResultSuccessEnvelope,
): void {
  try {
    const usage = (env.usage ?? {}) as Record<string, unknown>;
    // The CLI envelope sometimes carries a top-level `model`; read it defensively.
    const modelId =
      typeof (env as { model?: unknown }).model === 'string'
        ? ((env as { model?: string }).model as string)
        : null;
    recordTurn(getDb(), {
      sessionId: null,
      conversationId: turn.conversationId || null,
      providerId: 'claude',
      modelId,
      inputTokens: numFromUsage(usage.input_tokens),
      outputTokens: numFromUsage(usage.output_tokens),
      cacheCreationTokens: numFromUsage(usage.cache_creation_input_tokens),
      cacheReadTokens: numFromUsage(usage.cache_read_input_tokens),
      totalCostUsd:
        typeof env.total_cost_usd === 'number' && Number.isFinite(env.total_cost_usd)
          ? env.total_cost_usd
          : null,
      recordedAt: Date.now(),
    });
  } catch {
    /* usage telemetry is best-effort — never affect the reply or the turn. */
  }
}

/** Coerce an untrusted usage field to a non-negative integer; missing → 0. */
function numFromUsage(value: unknown): number {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Drain the final transitions when the CLI child closes (cancelled or no-result). */
export function finalizeTurnOnClose(
  code: number | null,
  ctx: TurnLoopCtx,
  state: TurnLoopState,
  stderrChunks: string[],
): void {
  const { deps, turn, assistantMessageId, trajectoryId } = ctx;
  // B3 — the overall turn timeout already killed the child + emitted the
  // error-final. Don't double-emit on the resulting `close`.
  if (state.timedOut) return;
  if (turn.cancelled) {
    emitState(deps, 'standby', turn, { cancelled: true, messageId: assistantMessageId });
    void endTrajectory(deps, trajectoryId, false, 'cancelled');
    return;
  }
  if (!state.sawResult) {
    const tail = stderrChunks.join('').slice(-512).trim();
    if (state.resumeAttempted && isLikelyResumeFailure(tail)) {
      state.resumeLikelyFailed = true;
      return;
    }
    const message =
      code === 0
        ? 'claude CLI exited without producing a result'
        : `claude CLI exited ${code}${tail ? `: ${tail}` : ''}`;
    persistFinal(turn, assistantMessageId, message);
    emitErrorFinal(deps, turn, message, assistantMessageId);
    void endTrajectory(deps, trajectoryId, false, message.slice(0, 300));
  }
}

function captureClaudeSessionId(
  conversationId: string,
  sessionId: string,
  state: TurnLoopState,
): void {
  if (state.capturedSessionId) return;
  state.capturedSessionId = sessionId;
  const dao = conversationsDao as typeof conversationsDao & {
    setClaudeSessionId?: (conversationId: string, claudeSessionId: string | null) => void;
  };
  try {
    dao.setClaudeSessionId?.(conversationId, sessionId);
  } catch {
    /* persistence is best-effort; resume falls through to fresh on miss */
  }
}

export function isLikelyResumeFailure(stderrTail: string): boolean {
  return (
    /(?:no such|cannot find|not found|unknown|missing|invalid)\s+(?:claude\s+)?session/i.test(
      stderrTail,
    ) || /(?:claude\s+)?session\s+(?:not found|missing|invalid|unknown)/i.test(stderrTail)
  );
}

async function dispatchToolBlock(
  deps: CliTurnDeps,
  name: string,
  input: Record<string, unknown>,
): Promise<{ result: unknown; isError: boolean }> {
  if (!findTool(name)) return { result: { error: 'unknown_tool', name }, isError: true };
  if (!deps.dispatchTool) return { result: { error: 'tool_dispatch_unavailable', name }, isError: true };
  try {
    const result = await withTimeout(deps.dispatchTool(name, input), 30_000, name);
    return { result, isError: false };
  } catch (err) {
    return { result: { error: err instanceof Error ? err.message : String(err) }, isError: true };
  }
}

export async function routeToolUse(
  envelope: CliAssistantEnvelope,
  deps: CliTurnDeps,
  turn: CliTurnHandle,
  stdinWriter: StdinWriter,
  trajectoryId: string | null,
): Promise<void> {
  for (const block of (envelope.message.content ?? []).filter((b) => b.type === 'tool_use')) {
    traceToolUse(deps.tracer, turn, block);
    const name = block.name ?? '<unknown>';
    const input = block.input ?? {};
    const { result, isError } = await dispatchToolBlock(deps, name, input);
    void recordTrajectoryStep(deps, trajectoryId, name, input, result, !isError);
    const resultBlock: Record<string, unknown> = {
      type: 'tool_result',
      tool_use_id: block.id ?? randomUUID(),
      content: JSON.stringify(result ?? null),
    };
    if (isError) resultBlock.is_error = true;
    await stdinWriter.enqueue(
      JSON.stringify({ type: 'user', message: { role: 'user', content: [resultBlock] } }) + '\n',
    );
  }
}

export async function recordTrajectoryStep(
  deps: CliTurnDeps,
  trajectoryId: string | null,
  name: string,
  input: Record<string, unknown>,
  result: unknown,
  ok: boolean,
): Promise<void> {
  if (!trajectoryId || !deps.ruflo) return;
  try {
    await deps.ruflo.trajectoryStep({
      trajectoryId,
      action: name,
      result: JSON.stringify({ input, result }).slice(0, 500),
      quality: ok ? 1 : 0,
    });
  } catch { /* learning is best-effort */ }
}

export async function endTrajectory(
  deps: CliTurnDeps,
  trajectoryId: string | null,
  success: boolean,
  feedback: string,
): Promise<void> {
  if (!trajectoryId || !deps.ruflo) return;
  try {
    await deps.ruflo.trajectoryEnd({ trajectoryId, success, feedback });
  } catch { /* learning is best-effort */ }
}

// CLI intent only — the host hasn't run the tool yet (that's invokeTool
// RPC). result={fromCli:true,input} lets the right-rail distinguish intent
// from real invocations.
export function traceToolUse(
  tracer: ToolTracer | undefined,
  turn: CliTurnHandle,
  block: CliAssistantContentBlock,
): void {
  if (!tracer) return;
  const now = Date.now();
  const trace: ToolTrace = {
    id: block.id ?? randomUUID(),
    conversationId: turn.conversationId,
    name: block.name ?? '<unknown>',
    startedAt: now,
    finishedAt: now,
    args: safeSerialize(block.input ?? {}) as Record<string, unknown>,
    ok: true,
    result: { fromCli: true, input: block.input ?? {} },
  };
  try { tracer.record(trace); } catch { /* tracing is best-effort */ }
}
