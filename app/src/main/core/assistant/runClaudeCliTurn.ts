// V3-W14-002 — Jorvis Assistant turn driver. Spawns the local `claude` CLI
// in streaming-JSON mode and bridges its envelopes onto the existing
// `assistant:state` + `assistant:tool-trace` IPC channels. Renderer compat:
// emit kind:'delta' for text + kind:'state'+state:'standby'+messageId so
// JorvisRoom.tsx commits the message; kind:'final'|'error' is forward-compat.
// Cancellation: cancelClaudeCliTurn(turnId) kills with SIGTERM.
//
// v1.1.9 split: emit/persist/stdin helpers in `./runClaudeCliTurn.emit`;
// tool-routing + trajectory helpers in `./runClaudeCliTurn.trajectory`.
// v1.4.5 split: CLI-args assembly + session-id helpers in `./runClaudeCliTurn.args`.
// All siblings are internal-only — public surface here is unchanged.

import { spawnExecutable } from '../util/spawn-cross-platform';
import readline from 'node:readline';
import { probeProvider } from '../providers/probe';
import { findProvider } from '../../../shared/providers';
import { isClaudeSessionId } from '../pty/claude-resume-sigma';
import * as conversationsDao from './conversations';
import { ToolTracer } from './tool-tracer';
import { estimateTokens } from './system-prompt';
import type { RufloProxy } from '../ruflo/proxy';
import { parseCliLine } from './cli-envelope';
import {
  createStdinWriter,
  emitDelta,
  emitErrorFinal,
  emitState,
  persistFinal,
} from './runClaudeCliTurn.emit';
import {
  endTrajectory,
  finalizeTurnOnClose,
  handleParsedEnvelope,
  type TurnLoopCtx,
  type TurnLoopState,
} from './runClaudeCliTurn.trajectory';
import {
  applyMcpHostConfig,
  appendAssistantMessage,
  buildCliArgs,
  clearPriorClaudeSessionId,
  getPriorClaudeSessionId,
  resolveSystemPrompt,
} from './runClaudeCliTurn.args';

export interface CliTurnHandle {
  conversationId: string;
  turnId: string;
  cancelled: boolean;
}

export interface CliTurnDeps {
  emit: (event: string, payload: unknown) => void;
  /** Tool tracer (controller-owned). Tests inject a mock. */
  tracer?: ToolTracer;
  /** Executes a Sigma tool emitted by the Claude CLI. */
  dispatchTool?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  /** Optional Ruflo bridge for SONA trajectory learning. Fail-soft. */
  ruflo?: Pick<RufloProxy, 'trajectoryStart' | 'trajectoryStep' | 'trajectoryEnd'>;
  /**
   * H-19 (full) — opportunistic outbound PII scrub applied to the assistant's
   * FINAL reply text immediately before the `kind:'final'` emit (and the
   * matching persist). Supplied by the controller as
   * `(t) => aidefence.scrubOutbound(t)`. FINAL ONLY — streamed deltas are never
   * scrubbed (the live-typing UX shows raw text; the committed reply is the
   * scrubbed one). Opportunistic + fail-open: ABSENT ⇒ text unchanged; a
   * THROWING scrub ⇒ the ORIGINAL text is still emitted (a scrub failure must
   * never block or drop a reply).
   */
  scrubFinal?: (text: string) => Promise<string>;
  /**
   * BUG-V1.1.2-01 — Jorvis host MCP wiring. When supplied AND `serverEntry`
   * exists, the driver writes a temp `.mcp.json` declaring the
   * `jorvis-host` stdio server and passes `--mcp-config <path>` to the CLI;
   * the spawned server dials back via `socketPath` and forwards
   * `tools/call` into the same `dispatchTool` path. Omitted ⇒ v1.1.1 behaviour.
   */
  mcpHost?: {
    /** Absolute path to `electron-dist/mcp-jorvis-host-server.cjs`. */
    serverEntry: string;
    /** Unix socket path or `\\.\pipe\…` name the bridge listens on. */
    socketPath: string;
    /** Anchors the temp `.mcp.json` under `<root>/.claude-flow/`; falls back to OS temp. */
    workspaceRoot?: string;
  };
}

/** Test injection points: probe / spawner / system-prompt overrides. */
export interface CliTurnOptions {
  probeOverride?: () => Promise<{ found: boolean; resolvedPath?: string; version?: string }>;
  spawnOverride?: SpawnOverride;
  buildSystemPrompt?: (workspaceId: string) => string;
  /** Captures spawn args without supplying a full fake. Sync, called before spawn. */
  onSpawnArgs?: (bin: string, args: string[]) => void;
  /**
   * B3 — override the overall per-turn timeout (ms). Defaults to
   * {@link TURN_TIMEOUT_MS}. Tests pass a tiny value to assert the hung-turn
   * teardown without waiting 90s.
   */
  turnTimeoutMs?: number;
}

/** Minimal subset of ChildProcessWithoutNullStreams the driver depends on. */
export interface CliChildLike {
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  on(event: 'close', listener: (code: number | null) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export type SpawnOverride = (bin: string, args: string[]) => CliChildLike;

export interface CliTurnResult {
  handled: boolean;
  reason?: 'no-binary' | 'spawn-failed';
}

interface CachedProbe {
  found: boolean;
  resolvedPath?: string;
  version?: string;
}

/**
 * B3 (defense-in-depth) — overall wall-clock budget for a single CLI turn.
 * If the `claude` child produces no terminal `result` envelope within this
 * window (e.g. it blocks on an interactive trust/login prompt in dev and never
 * streams anything), we kill the child and emit an error-final through the
 * SAME `assistant:state` path so the renderer's Orb/composer clear instead of
 * hanging silently. The stdin-write timeout (30s) only covers a stuck WRITE;
 * this covers a child that accepts input but never answers. Generous so a
 * legitimately long, actively-streaming turn isn't cut off.
 */
export const TURN_TIMEOUT_MS = 90_000;

let cachedProbe: CachedProbe | null = null;

/** Reset the cached probe (test-only escape hatch). */
export function __resetProbeCache(): void {
  cachedProbe = null;
}

/** Drop any in-flight child entries (test-only escape hatch). */
export function __resetActiveChildren(): void {
  activeChildren.clear();
}

async function getOrProbe(
  override?: () => Promise<CachedProbe>,
): Promise<CachedProbe> {
  if (cachedProbe) return cachedProbe;
  if (override) {
    cachedProbe = await override();
    return cachedProbe;
  }
  const def = findProvider('claude');
  if (!def) {
    cachedProbe = { found: false };
    return cachedProbe;
  }
  const probe = await probeProvider(def);
  cachedProbe = {
    found: probe.found,
    resolvedPath: probe.resolvedPath,
    version: probe.version,
  };
  return cachedProbe;
}

const activeChildren = new Map<string, CliChildLike>();

/** Kill the in-flight CLI child for `turnId` (no-op if already finished). */
export function cancelClaudeCliTurn(turnId: string): boolean {
  const child = activeChildren.get(turnId);
  if (!child) return false;
  try {
    child.kill('SIGTERM');
    return true;
  } catch {
    return false;
  }
}

/**
 * Drive a single Sigma Assistant turn through the local `claude` CLI.
 * Returns `{handled: false, reason: 'no-binary'}` when the binary is missing
 * so the controller can fall back to the stub message; never throws on the
 * missing-binary path so installing Claude Code later doesn't require a
 * relaunch to clear an exception.
 */
export async function runClaudeCliTurn(
  turn: CliTurnHandle,
  prompt: string,
  deps: CliTurnDeps,
  opts: CliTurnOptions = {},
): Promise<CliTurnResult> {
  const probe = await getOrProbe(opts.probeOverride);
  if (!probe.found || !probe.resolvedPath) {
    return { handled: false, reason: 'no-binary' };
  }

  let conv: ReturnType<typeof conversationsDao.getConversation> | null = null;
  try {
    conv = conversationsDao.getConversation(turn.conversationId);
  } catch {
    /* DB may not be initialised in tests / pre-boot — keep going with no
     * conversation context; the turn still streams. */
  }
  const workspaceId = conv?.workspaceId ?? null;
  const priorClaudeSessionId = getPriorClaudeSessionId(conv);
  const sysPrompt = resolveSystemPrompt(workspaceId, opts.buildSystemPrompt);

  // R-1.1.1-2: warn if the system prompt grew past the 1500-token budget.
  const tokenEstimate = estimateTokens(sysPrompt);
  if (tokenEstimate > 1500) {
    console.warn(
      `[runClaudeCliTurn] system prompt token estimate ${tokenEstimate} > 1500; latency may suffer`,
    );
  }

  // Emit thinking immediately so the orb cycles before the CLI produces
  // its first envelope (~1-2s cold-start on Claude Code).
  emitState(deps, 'thinking', turn);
  let trajectoryId: string | null = null;
  try {
    trajectoryId =
      (await deps.ruflo?.trajectoryStart({
        task: prompt.slice(0, 200),
        agent: 'jorvis-assistant',
      })) ?? null;
  } catch {
    trajectoryId = null;
  }

  // Persist the assistant message envelope up-front so streaming deltas can
  // reference its `messageId`. We update its content on result; a partial
  // row is acceptable if the turn is cancelled mid-stream.
  const assistantMessageId =
    turn.conversationId && conv ? appendAssistantMessage(turn.conversationId, turn.turnId) : null;

  let retryWithoutResume = false;
  let shouldRun = true;
  while (shouldRun) {
    shouldRun = false;
    const resumeSessionId = retryWithoutResume ? null : priorClaudeSessionId;
    const args = buildCliArgs(prompt, sysPrompt, resumeSessionId);
    applyMcpHostConfig(args, deps.mcpHost, turn.conversationId, workspaceId);

    if (opts.onSpawnArgs) {
      try {
        opts.onSpawnArgs(probe.resolvedPath, args);
      } catch {
        /* observer-only; never fail the turn */
      }
    }

    let child: CliChildLike;
    try {
      child = opts.spawnOverride
        ? opts.spawnOverride(probe.resolvedPath, args)
        : spawnExecutable(probe.resolvedPath, args, {
            stdio: ['pipe', 'pipe', 'pipe'],
          });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const errMsg = `Failed to spawn claude CLI: ${msg}`;
      persistFinal(turn, assistantMessageId, errMsg);
      emitErrorFinal(deps, turn, errMsg, assistantMessageId);
      return { handled: true, reason: 'spawn-failed' };
    }

    activeChildren.set(turn.turnId, child);

    const stderrChunks: string[] = [];
    child.stderr.on('data', (chunk: Buffer | string) => {
      const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      stderrChunks.push(s);
      // Cap accumulated stderr to ~16 KB so a runaway CLI can't OOM us.
      while (stderrChunks.join('').length > 16_384) stderrChunks.shift();
    });

    const state: TurnLoopState = {
      sawResult: false,
      receivingEmitted: false,
      finalText: '',
      resumeAttempted: Boolean(resumeSessionId && isClaudeSessionId(resumeSessionId)),
      resumeLikelyFailed: false,
    };
    const ctx: TurnLoopCtx = {
      deps,
      turn,
      assistantMessageId,
      stdinWriter: createStdinWriter(child, {
        // BUG-V1.1.3-ORCH-03 (audit fix): on stdin write timeout we kill the
        // hung CLI child so the turn driver's `close` listener fires, the
        // assistant state transitions to standby, and the renderer's spinner
        // stops. Without this the CLI process would hang stdin indefinitely
        // and the parent turn promise would never resolve.
        onTimeout: () => {
          try {
            child.kill('SIGTERM');
          } catch {
            /* best-effort — child may already be dead */
          }
        },
      }),
      trajectoryId,
      pendingToolRoutes: new Set<Promise<void>>(),
    };
    const rl = readline.createInterface({ input: child.stdout });

    // B3 (defense-in-depth) — overall turn timeout. A `claude -p stream-json`
    // that blocks on interactive trust/login (common in dev before the
    // operator has accepted trust once) accepts our stdin but never streams a
    // `result`, so neither the stdin-write timeout nor the readline loop ever
    // fires. Without this the child stays alive, `close` never fires, the turn
    // promise never resolves, and the renderer's Orb spins forever. On timeout
    // we emit an error-final through the SAME `assistant:state` path (so the
    // renderer clears) and SIGTERM the child; the resulting `close` is a no-op
    // because `state.timedOut` short-circuits `finalizeTurnOnClose`.
    const turnTimeoutMs = Math.max(1, opts.turnTimeoutMs ?? TURN_TIMEOUT_MS);
    let turnTimer: NodeJS.Timeout | null = setTimeout(() => {
      turnTimer = null;
      if (state.sawResult || turn.cancelled) return;
      state.timedOut = true;
      const msg = 'Jorvis turn timed out — the claude CLI never responded. If this is the first run, open a terminal and run `claude` once to accept the trust prompt, then try again.';
      persistFinal(turn, assistantMessageId, msg);
      emitErrorFinal(deps, turn, msg, assistantMessageId);
      void endTrajectory(deps, trajectoryId, false, 'turn_timeout');
      try {
        child.kill('SIGTERM');
      } catch {
        /* best-effort — child may already be dead */
      }
    }, turnTimeoutMs);
    const clearTurnTimer = () => {
      if (turnTimer) {
        clearTimeout(turnTimer);
        turnTimer = null;
      }
    };

    await new Promise<void>((resolve) => {
      rl.on('line', (line) => {
        if (turn.cancelled) return;
        const env = parseCliLine(line);
        if (!env) {
          // Non-JSON lines (rare) — forward as raw text so the user sees something.
          const trimmed = line.trim();
          if (trimmed) emitDelta(deps, turn, assistantMessageId, trimmed + '\n');
          return;
        }
        handleParsedEnvelope(env, ctx, state);
      });
      child.on('close', async (code: number | null) => {
        clearTurnTimer();
        activeChildren.delete(turn.turnId);
        rl.close();
        await Promise.allSettled(Array.from(ctx.pendingToolRoutes));
        await ctx.stdinWriter.drain().catch(() => undefined);
        finalizeTurnOnClose(code, ctx, state, stderrChunks);
        resolve();
      });
      child.on('error', (err: Error) => {
        clearTurnTimer();
        activeChildren.delete(turn.turnId);
        const msg = `claude CLI process error: ${err.message}`;
        persistFinal(turn, assistantMessageId, msg);
        emitErrorFinal(deps, turn, msg, assistantMessageId);
        void endTrajectory(deps, trajectoryId, false, msg.slice(0, 300));
        resolve();
      });
    });
    clearTurnTimer();

    if (state.resumeAttempted && state.resumeLikelyFailed && !retryWithoutResume) {
      clearPriorClaudeSessionId(turn.conversationId);
      retryWithoutResume = true;
      shouldRun = true;
      continue;
    }
  }

  return { handled: true };
}
