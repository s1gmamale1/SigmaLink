// V3-W14-002 — Sigma Assistant turn driver. Spawns the local `claude` CLI
// in streaming-JSON mode and bridges its envelopes onto the existing
// `assistant:state` + `assistant:tool-trace` IPC channels. Renderer compat:
// emit kind:'delta' for text + kind:'state'+state:'standby'+messageId so
// BridgeRoom.tsx commits the message; kind:'final'|'error' is forward-compat.
// Cancellation: cancelClaudeCliTurn(turnId) kills with SIGTERM.
//
// v1.1.9 split: emit/persist/stdin helpers in `./runClaudeCliTurn.emit`;
// tool-routing + trajectory helpers in `./runClaudeCliTurn.trajectory`.
// Both internal-only — public surface here is unchanged.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';
import { eq } from 'drizzle-orm';
import { probeProvider } from '../providers/probe';
import { findProvider } from '../../../shared/providers';
import { getDb } from '../db/client';
import { workspaces as workspacesTable } from '../db/schema';
import { appendMessage, getConversation } from './conversations';
import { ToolTracer } from './tool-tracer';
import { buildSigmaSystemPrompt, estimateTokens } from './system-prompt';
import { writeSigmaHostMcpConfig } from './mcp-host-bridge';
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
   * BUG-V1.1.2-01 — Sigma host MCP wiring. When supplied AND `serverEntry`
   * exists, the driver writes a temp `.mcp.json` declaring the
   * `sigma-host` stdio server and passes `--mcp-config <path>` to the CLI;
   * the spawned server dials back via `socketPath` and forwards
   * `tools/call` into the same `dispatchTool` path. Omitted ⇒ v1.1.1 behaviour.
   */
  mcpHost?: {
    /** Absolute path to `electron-dist/mcp-sigma-host-server.cjs`. */
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

function resolveSystemPrompt(
  workspaceId: string | null,
  build?: (id: string) => string,
): string {
  if (build) return build(workspaceId ?? '');
  if (workspaceId) return defaultSystemPromptForWorkspace(workspaceId);
  return buildSigmaSystemPrompt({ workspaceName: 'workspace', workspaceRoot: '' });
}

function buildCliArgs(prompt: string, sysPrompt: string): string[] {
  return [
    '-p', prompt,
    '--output-format', 'stream-json',
    '--verbose',
    '--append-system-prompt', sysPrompt,
  ];
}

// BUG-V1.1.2-01 — Write a temp `.mcp.json` and load it when the host bridge
// is wired AND the bundled stdio server exists on disk. Non-fatal: the
// turn still streams text, just without Sigma tools.
function applyMcpHostConfig(
  args: string[],
  mcpHost: CliTurnDeps['mcpHost'],
  conversationId: string,
  workspaceId: string | null,
): void {
  if (!mcpHost?.serverEntry || !mcpHost?.socketPath) return;
  try {
    const path = writeSigmaHostMcpConfig(mcpHost, conversationId, workspaceId ?? undefined);
    if (path) args.push('--mcp-config', path, '--strict-mcp-config');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[runClaudeCliTurn] failed to write sigma-host mcp config: ${msg}`);
  }
}

function appendAssistantMessage(conversationId: string): string | null {
  try {
    return appendMessage({ conversationId, role: 'assistant', content: '' }).id;
  } catch {
    /* persistence is best-effort; renderer still receives delta + final */
    return null;
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

  let conv: ReturnType<typeof getConversation> | null = null;
  try {
    conv = getConversation(turn.conversationId);
  } catch {
    /* DB may not be initialised in tests / pre-boot — keep going with no
     * conversation context; the turn still streams. */
  }
  const workspaceId = conv?.workspaceId ?? null;
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
        agent: 'sigma-assistant',
      })) ?? null;
  } catch {
    trajectoryId = null;
  }

  const args = buildCliArgs(prompt, sysPrompt);
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
  // reference its `messageId`. We update its content on result; a partial
  // row is acceptable if the turn is cancelled mid-stream.
  const assistantMessageId =
    turn.conversationId && conv ? appendAssistantMessage(turn.conversationId) : null;

  const stderrChunks: string[] = [];
  child.stderr.on('data', (chunk: Buffer | string) => {
    const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    stderrChunks.push(s);
    // Cap accumulated stderr to ~16 KB so a runaway CLI can't OOM us.
    while (stderrChunks.join('').length > 16_384) stderrChunks.shift();
  });

  const state: TurnLoopState = { sawResult: false, receivingEmitted: false, finalText: '' };
  const ctx: TurnLoopCtx = {
    deps,
    turn,
    assistantMessageId,
    stdinWriter: createStdinWriter(child),
    trajectoryId,
    pendingToolRoutes: new Set<Promise<void>>(),
  };
  const rl = readline.createInterface({ input: child.stdout });

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
      activeChildren.delete(turn.turnId);
      rl.close();
      await Promise.allSettled(Array.from(ctx.pendingToolRoutes));
      await ctx.stdinWriter.drain().catch(() => undefined);
      finalizeTurnOnClose(code, ctx, state, stderrChunks);
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

  return { handled: true };
}
