// V3-W14-002 — Sigma Assistant turn driver: spawns the local `claude` CLI in
// streaming JSON mode and bridges its envelopes onto the existing
// `assistant:state` + `assistant:tool-trace` IPC channels.
//
// child_process.spawn (not the launcher facade) because we need clean stdout
// JSONL — no PTY echoing, no shell quoting. Renderer compat: emit
// kind:'delta' for text + kind:'state'+state:'standby'+messageId at end so
// BridgeRoom.tsx:311 commits the message; additionally emit forward-compat
// kind:'final'|'error' envelopes (ignored by older renderers).
// Cancellation: cancelClaudeCliTurn(turnId) kills the child with SIGTERM.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { probeProvider } from '../providers/probe';
import { findProvider } from '../../../shared/providers';
import { getDb } from '../db/client';
import { workspaces as workspacesTable, messages as messagesTable } from '../db/schema';
import { appendMessage, getConversation } from './conversations';
import { ToolTracer, safeSerialize, type ToolTrace } from './tool-tracer';
import { findTool } from './tools';
import { buildSigmaSystemPrompt, estimateTokens } from './system-prompt';
import type { RufloProxy } from '../ruflo/proxy';
import {
  parseCliLine,
  isAssistantEnvelope,
  isResultEnvelope,
  isResultSuccess,
  type CliAssistantEnvelope,
  type CliAssistantContentBlock,
  type CliResultErrorEnvelope,
} from './cli-envelope';

// ── Types ──────────────────────────────────────────────────────────────────

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
}

/** Test injection points: probe / spawner / system-prompt overrides. */
export interface CliTurnOptions {
  probeOverride?: () => Promise<{ found: boolean; resolvedPath?: string; version?: string }>;
  spawnOverride?: SpawnOverride;
  buildSystemPrompt?: (workspaceId: string) => string;
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

export type SpawnOverride = (
  bin: string,
  args: string[],
) => CliChildLike;

export interface CliTurnResult {
  handled: boolean;
  reason?: 'no-binary' | 'spawn-failed';
}

// ── Probe cache ────────────────────────────────────────────────────────────

interface CachedProbe {
  found: boolean;
  resolvedPath?: string;
  version?: string;
}

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

// ── Active-turn registry ───────────────────────────────────────────────────

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

// ── System prompt context ──────────────────────────────────────────────────

function defaultSystemPromptForWorkspace(workspaceId: string): string {
  let workspaceName = 'workspace';
  let workspaceRoot = '';
  try {
    const wsRow = getDb()
      .select()
      .from(workspacesTable)
      .where(eq(workspacesTable.id, workspaceId))
      .get();
    if (wsRow) {
      workspaceName = wsRow.name;
      workspaceRoot = wsRow.rootPath;
    }
  } catch {
    /* DB miss is non-fatal — prompt still works with placeholders */
  }
  return buildSigmaSystemPrompt({ workspaceName, workspaceRoot });
}

// ── Main entry point ───────────────────────────────────────────────────────

/**
 * Drive a single Sigma Assistant turn through the local `claude` CLI.
 *
 * Returns `{handled: false, reason: 'no-binary'}` when the binary is missing
 * so the controller can fall back to the stub message — DOES NOT throw on
 * the missing-binary path because the user installing Claude Code later
 * should not require a relaunch to clear an exception.
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

  let conv: ReturnType<typeof getConversation> | null = null;
  try {
    conv = getConversation(turn.conversationId);
  } catch {
    /* DB may not be initialised in tests / pre-boot — keep going with no
     * conversation context; the turn still streams. */
  }
  const workspaceId = conv?.workspaceId ?? null;
  const sysPrompt = opts.buildSystemPrompt
    ? opts.buildSystemPrompt(workspaceId ?? '')
    : workspaceId
      ? defaultSystemPromptForWorkspace(workspaceId)
      : buildSigmaSystemPrompt({ workspaceName: 'workspace', workspaceRoot: '' });

  // R-1.1.1-2: warn if the system prompt grew past the 1500-token budget.
  const tokenEstimate = estimateTokens(sysPrompt);
  if (tokenEstimate > 1500) {
    console.warn(
      `[runClaudeCliTurn] system prompt token estimate ${tokenEstimate} > 1500; latency may suffer`,
    );
  }

  // Emit thinking immediately so the orb cycles even before the CLI
  // produces its first envelope (cold-start latency on Claude Code is
  // ~1-2s before the first JSONL line lands).
  emitState(deps, 'thinking', turn);
  let trajectoryId: string | null = null;
  try {
    trajectoryId =
      (await deps.ruflo?.trajectoryStart({
        task: prompt.slice(0, 200),
        agent: 'sigma-assistant',
      })) ?? null;
  } catch {
    trajectoryId = null;
  }

  const args = [
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--append-system-prompt',
    sysPrompt,
  ];

  let child: CliChildLike;
  try {
    child = opts.spawnOverride
      ? opts.spawnOverride(probe.resolvedPath, args)
      : (spawn(probe.resolvedPath, args, {
          stdio: ['pipe', 'pipe', 'pipe'],
        }) as ChildProcessWithoutNullStreams);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    emitErrorFinal(deps, turn, `Failed to spawn claude CLI: ${msg}`);
    return { handled: true, reason: 'spawn-failed' };
  }

  activeChildren.set(turn.turnId, child);

  // Persist the assistant message envelope up-front so streaming deltas can
  // reference its `messageId`. We update its content with the final text on
  // result; a partial row is acceptable if the turn is cancelled mid-stream.
  let assistantMessageId: string | null = null;
  if (turn.conversationId && conv) {
    try {
      assistantMessageId = appendMessage({
        conversationId: turn.conversationId,
        role: 'assistant',
        content: '',
      }).id;
    } catch {
      /* persistence is best-effort; the renderer will still receive the
       * delta + final events even if we can't anchor a message row. */
    }
  }

  const stderrChunks: string[] = [];
  child.stderr.on('data', (chunk: Buffer | string) => {
    const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    stderrChunks.push(s);
    // Cap accumulated stderr to ~16 KB so a runaway CLI can't OOM us.
    while (stderrChunks.join('').length > 16_384) stderrChunks.shift();
  });

  let sawResult = false;
  let receivingEmitted = false;
  let finalText = '';
  const stdinWriter = createStdinWriter(child);
  const pendingToolRoutes = new Set<Promise<void>>();

  const rl = readline.createInterface({ input: child.stdout });

  const closePromise = new Promise<void>((resolve) => {
    rl.on('line', (line) => {
      if (turn.cancelled) return;
      const env = parseCliLine(line);
      if (!env) {
        // Non-JSON lines (rare — claude usually emits clean JSONL) are
        // forwarded as raw text so the user at least sees something.
        const trimmed = line.trim();
        if (trimmed) emitDelta(deps, turn, assistantMessageId, trimmed + '\n');
        return;
      }
      if (!receivingEmitted && env.type !== 'system') {
        emitState(deps, 'receiving', turn);
        receivingEmitted = true;
      }
      if (isAssistantEnvelope(env)) {
        for (const block of env.message.content ?? []) {
          if (block.type === 'text' && typeof block.text === 'string') {
            // Chunk the text into small slices so the renderer animates
            // the typing effect (BridgeRoom expects ~4-char deltas).
            finalText += block.text;
            streamDelta(deps, turn, assistantMessageId, block.text);
          }
        }
        const routePromise = routeToolUse(env, deps, turn, stdinWriter, trajectoryId).catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          console.warn(`[runClaudeCliTurn] failed to route tool_use: ${message}`);
        });
        pendingToolRoutes.add(routePromise);
        routePromise.finally(() => pendingToolRoutes.delete(routePromise));
      } else if (isResultEnvelope(env)) {
        sawResult = true;
        if (isResultSuccess(env)) {
          const text = env.result ?? finalText;
          // If the streamed deltas already covered the text (common —
          // claude streams as it goes), avoid re-emitting; otherwise top
          // up with whatever's missing.
          if (text && text !== finalText) {
            const remainder = text.slice(finalText.length);
            if (remainder) streamDelta(deps, turn, assistantMessageId, remainder);
            finalText = text;
          }
          persistFinal(turn, assistantMessageId, finalText);
          emitFinal(deps, turn, assistantMessageId, finalText, env.usage);
          void endTrajectory(deps, trajectoryId, true, finalText.slice(0, 300));
        } else {
          const errMsg =
            (env as CliResultErrorEnvelope).result ?? `claude CLI returned ${env.subtype}`;
          persistFinal(turn, assistantMessageId, errMsg);
          emitErrorFinal(deps, turn, errMsg, assistantMessageId);
          void endTrajectory(deps, trajectoryId, false, errMsg.slice(0, 300));
        }
      }
      // system / user / unknown envelopes are log-only.
    });
    child.on('close', async (code: number | null) => {
      activeChildren.delete(turn.turnId);
      rl.close();
      await Promise.allSettled(Array.from(pendingToolRoutes));
      await stdinWriter.drain().catch(() => undefined);
      if (turn.cancelled) {
        emitState(deps, 'standby', turn, { cancelled: true, messageId: assistantMessageId });
        void endTrajectory(deps, trajectoryId, false, 'cancelled');
        resolve();
        return;
      }
      if (!sawResult) {
        const tail = stderrChunks.join('').slice(-512).trim();
        const message =
          code === 0
            ? 'claude CLI exited without producing a result'
            : `claude CLI exited ${code}${tail ? `: ${tail}` : ''}`;
        persistFinal(turn, assistantMessageId, message);
        emitErrorFinal(deps, turn, message, assistantMessageId);
        void endTrajectory(deps, trajectoryId, false, message.slice(0, 300));
      }
      resolve();
    });
    child.on('error', (err: Error) => {
      activeChildren.delete(turn.turnId);
      const msg = `claude CLI process error: ${err.message}`;
      persistFinal(turn, assistantMessageId, msg);
      emitErrorFinal(deps, turn, msg, assistantMessageId);
      void endTrajectory(deps, trajectoryId, false, msg.slice(0, 300));
      resolve();
    });
  });

  await closePromise;
  return { handled: true };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function streamDelta(
  deps: CliTurnDeps,
  turn: CliTurnHandle,
  messageId: string | null,
  text: string,
): void {
  // Match the existing 4-char chunk cadence so the renderer's typing
  // animation feels identical to the W13 stub. We don't `await` between
  // chunks here — the CLI emits the text in one envelope, and re-emitting
  // it slowly would defeat the live-stream UX. The renderer handles
  // however many deltas land in a tick.
  const CHUNK = 4;
  for (let i = 0; i < text.length; i += CHUNK) {
    emitDelta(deps, turn, messageId, text.slice(i, i + CHUNK));
  }
}

function emitDelta(
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

function emitState(
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

function emitFinal(
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

function emitErrorFinal(
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

function persistFinal(
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

interface StdinWriter {
  enqueue(line: string): Promise<void>;
  drain(): Promise<void>;
}

function createStdinWriter(child: CliChildLike): StdinWriter {
  let writeChain = Promise.resolve();
  return {
    enqueue(line: string): Promise<void> {
      writeChain = writeChain
        .catch(() => undefined)
        .then(
          () =>
            new Promise<void>((resolve, reject) => {
              child.stdin.write(line, (err?: Error | null) => {
                if (err) reject(err);
                else resolve();
              });
            }),
        );
      return writeChain;
    },
    drain(): Promise<void> {
      return writeChain;
    },
  };
}

async function routeToolUse(
  envelope: CliAssistantEnvelope,
  deps: CliTurnDeps,
  turn: CliTurnHandle,
  stdinWriter: StdinWriter,
  trajectoryId: string | null,
): Promise<void> {
  const blocks = (envelope.message.content ?? []).filter(
    (block) => block.type === 'tool_use',
  );
  for (const block of blocks) {
    traceToolUse(deps.tracer, turn, block);
    const toolUseId = block.id ?? randomUUID();
    const name = block.name ?? '<unknown>';
    const input = block.input ?? {};
    const tool = findTool(name);
    let result: unknown;
    let isError = false;

    if (!tool) {
      result = { error: 'unknown_tool', name };
      isError = true;
    } else if (!deps.dispatchTool) {
      result = { error: 'tool_dispatch_unavailable', name };
      isError = true;
    } else {
      try {
        result = await withTimeout(deps.dispatchTool(name, input), 30_000, name);
      } catch (err) {
        result = { error: err instanceof Error ? err.message : String(err) };
        isError = true;
      }
    }
    void recordTrajectoryStep(deps, trajectoryId, name, input, result, !isError);

    const resultBlock: Record<string, unknown> = {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: JSON.stringify(result ?? null),
    };
    if (isError) resultBlock.is_error = true;
    const line =
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [resultBlock] },
      }) + '\n';
    await stdinWriter.enqueue(line);
  }
}

async function recordTrajectoryStep(
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
  } catch {
    /* learning is best-effort */
  }
}

async function endTrajectory(
  deps: CliTurnDeps,
  trajectoryId: string | null,
  success: boolean,
  feedback: string,
): Promise<void> {
  if (!trajectoryId || !deps.ruflo) return;
  try {
    await deps.ruflo.trajectoryEnd({ trajectoryId, success, feedback });
  } catch {
    /* learning is best-effort */
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, toolName: string): Promise<T> {
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

function traceToolUse(
  tracer: ToolTracer | undefined,
  turn: CliTurnHandle,
  block: CliAssistantContentBlock,
): void {
  if (!tracer) return;
  // CLI-emitted tool calls from claude's perspective. The host hasn't run
  // the tool yet (that path is invokeTool RPC); we trace the *intent* so
  // the right-rail "Tool calls" disclosure shows what the model proposed
  // even when the CLI's tool-loop runs server-side. The tracer's existing
  // schema accepts ok=true with the input as result; we mark it explicitly
  // as a CLI-authored envelope by setting result={fromCli:true,input}.
  const trace: ToolTrace = {
    id: block.id ?? randomUUID(),
    conversationId: turn.conversationId,
    name: block.name ?? '<unknown>',
    startedAt: Date.now(),
    finishedAt: Date.now(),
    args: safeSerialize(block.input ?? {}) as Record<string, unknown>,
    ok: true,
    result: { fromCli: true, input: block.input ?? {} },
  };
  try {
    tracer.record(trace);
  } catch {
    /* tracing is best-effort — never fail the turn over it */
  }
}
