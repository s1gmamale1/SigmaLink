// V3-W13-013 — Sigma Assistant RPC controller. Wires `assistant.*` to the
// conversations DAO, the launcher (dispatchPane), the tool registry (10
// tools), and the tool tracer. V3-W14-002 — `send` now drives the local
// Claude Code CLI via runClaudeCliTurn; runStubTurn is the binary-missing
// fallback only.
// V3-W13-013 (SHIPPED-PARTIAL) — `dispatchBulk` and `refResolve` added.

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { defineController } from '../../../shared/rpc';
import { findProvider } from '../../../shared/providers';
import type { PtyRegistry } from '../pty/registry';
import type { WorktreePool } from '../git/worktree';
import type { SwarmMailbox } from '../swarms/mailbox';
import type { MemoryManager } from '../memory/manager';
import type { TasksManager } from '../tasks/manager';
import type { BrowserManagerRegistry } from '../browser/manager';
import type { AgentSession, LaunchPlan } from '../../../shared/types';
import { getDb, getRawDb } from '../db/client';
import { workspaces as workspacesTable } from '../db/schema';
import { executeLaunchPlan } from '../workspaces/launcher';
import {
  appendMessage,
  createConversation,
  getConversation,
  listConversations,
  type ConversationWithMessages,
} from './conversations';
import { DANGEROUS_REMOTE, findTool, publicTools, summarizeArgs } from './tools';
import { classifyExternal } from '../control/authz-external';
import type { PendingEscalationStore } from '../control/pending-escalations';
import { ToolTracer, safeSerialize, type ToolTrace } from './tool-tracer';
import { recordSwarmOrigin } from './swarm-origins';
import { runClaudeCliTurn, cancelClaudeCliTurn } from './runClaudeCliTurn';
import type { RufloProxy } from '../ruflo/proxy';
import { createAidefenceGate, type RufloCall } from '../security/aidefence-gate';

export interface AssistantControllerDeps {
  pty: PtyRegistry;
  worktreePool: WorktreePool;
  mailbox: SwarmMailbox;
  memory: MemoryManager;
  tasks: TasksManager;
  browserRegistry: BrowserManagerRegistry;
  userDataDir: string;
  emit: (event: string, payload: unknown) => void;
  ruflo?: Pick<RufloProxy, 'trajectoryStart' | 'trajectoryStep' | 'trajectoryEnd'>;
  /**
   * H-19 (partial) — opportunistic Ruflo aidefence proxy. When supplied, the
   * controller builds an `AidefenceGate` internally and runs an ADVISORY
   * inbound scan on every `send` prompt (flagging is AUDITED, never blocked —
   * local operator input is trusted). Absent ⇒ no-op (all existing callers +
   * tests are unchanged). The lead injects this from rpc-router as
   * `(tool, args) => rufloProxy.call(tool, args)`.
   */
  rufloCall?: RufloCall;
  /**
   * BUG-V1.1.2-01 — Sigma host MCP wiring. When supplied, the controller
   * forwards both fields to `runClaudeCliTurn` so the Claude CLI registers
   * the 13 Sigma tools as an MCP server and emits real `tool_use` envelopes
   * (instead of describing them in prose in the system prompt, which left
   * the live `list_*` dispatchers as dead code).
   */
  mcpHost?: {
    /** Absolute path to `electron-dist/mcp-jorvis-host-server.cjs`. */
    serverEntry: string;
    /** Unix socket path or `\\.\pipe\…` the bridge is listening on. */
    socketPath: string;
  };
  /**
   * Audit 2026-06-10 — optional launch sinks for every executeLaunchPlan call
   * this controller makes (dispatchPane / dispatchPanes / the launch_pane tool
   * via ToolContext). Wired live from rpc-router; absent ⇒ console-only.
   */
  notifications?: { add: (input: import('../notifications/manager').AddInput) => unknown };
  broadcastPtyError?: (payload: { sessionId: string; exitCode: number | null; signal?: string | null }) => void;
  /**
   * Control MCP — supervised-autonomy gate for origin:'external' tool calls.
   * Returns the provider string (e.g. 'claude', 'shell') for a given session id,
   * or null if the session is unknown. When absent, provider resolves to null
   * (triggers escalate for provider-gated tools). Existing callers unaffected.
   */
  resolveSessionProvider?: (sessionId: string) => string | null;
  /**
   * Control MCP — kill-switch predicate. When it returns true, ALL external
   * tool calls are denied immediately. When absent, defaults to false (off).
   */
  controlFrozen?: () => boolean;
  /**
   * Task 4 — non-blocking escalation store. When supplied, an external
   * escalate-class tool returns {ok:false, status:'needs_approval', escalationId}
   * immediately instead of blocking 60s waiting for operator approval.
   * Absent → back-compat: blocking confirmDangerous path still runs.
   */
  pendingEscalations?: PendingEscalationStore;
  /**
   * wait_for_pane — main-side pane watcher. When supplied, the tool blocks
   * until one of the given sessions becomes ready (prompt/idle/exit) or
   * times out. Absent ⇒ the tool returns `reason:'unavailable'` immediately
   * (safe default — all existing callers unaffected).
   */
  promptSink?: {
    wait(opts: { sessionIds: string[]; until: 'prompt' | 'idle' | 'exit'; timeoutMs: number; idleMs?: number }): Promise<{ sessionId: string | null; reason: string; prompt?: unknown }>;
  };
  /**
   * get_app_state — holistic app snapshot provider (built in rpc-router).
   * Absent ⇒ the tool returns `{ ok: false, error: 'app-state unavailable' }`
   * (safe default — all existing callers unaffected).
   */
  appState?: { snapshot(opts: { workspaceId?: string; allWorkspaces?: boolean }): unknown };
  /**
   * Direct main-side swarm controller for the swarm-op tools (robustness fix —
   * the tools call this and return the real result/error instead of a silent
   * ok:true). Absent ⇒ those tools return ok:false 'swarm controller unavailable'.
   */
  swarms?: {
    splitPane(input: { paneId: string; direction: 'horizontal' | 'vertical'; provider: string }): Promise<import('../../../shared/types').AgentSession>;
    sendMessage(input: { swarmId: string; toAgent: string; body: string; kind?: string }): Promise<unknown>;
    resume(id: string): Promise<{ ok: boolean; healed: boolean }>;
    kill(id: string): Promise<void>;
  };
}

interface ActiveTurn {
  conversationId: string;
  turnId: string;
  cancelled: boolean;
}

/**
 * R-1 (Jorvis Telegram remote) — provenance of a turn / tool call.
 * `'local'` (default) = in-app operator, full trust. `'telegram'` = remote
 * bridge, gated through `confirmDangerous` for DANGEROUS_REMOTE tools.
 */
export type ToolOrigin = 'local' | 'telegram' | 'external';

/**
 * R-1 — confirm-on-dangerous callback (cross-lane contract). Resolve `true` to
 * authorize a dangerous remote tool call; anything else rejects it.
 */
export type ConfirmDangerous = (toolName: string, summary: string) => Promise<boolean>;

export function pickPreset(n: number): LaunchPlan['preset'] {
  if (n <= 1) return 1;
  if (n <= 2) return 2;
  if (n <= 4) return 4;
  if (n <= 6) return 6;
  return 8;
}

const delay = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

export interface AssistantController {
  controller: ReturnType<typeof defineController>;
  /**
   * Direct, in-process tool invoker used by the MCP host bridge. Skips the
   * router serialisation hop but goes through the exact same trace +
   * dispatch path as the public `assistant.invokeTool` RPC.
   */
  invokeTool: (input: {
    conversationId?: string;
    name: string;
    args: Record<string, unknown>;
    /** R-1 — defaults to `'local'` (no gating) when omitted. */
    origin?: ToolOrigin;
    /** R-1 — supplied by the remote bridge to approve DANGEROUS_REMOTE calls. */
    confirmDangerous?: ConfirmDangerous;
    /** Task 4 — label of the external client (used to key one-shot grants). */
    clientLabel?: string;
  }) => Promise<{ ok: boolean; result: unknown; error?: string }>;
}

export function buildAssistantController(deps: AssistantControllerDeps): AssistantController {
  const tracer = new ToolTracer();
  tracer.setEmitter(deps.emit);
  const activeTurns = new Map<string, ActiveTurn>();

  // H-19 (partial) — opportunistic aidefence gate. Built only when a ruflo
  // proxy is injected; otherwise the send path is a no-op (back-compat). Audit
  // events ride the existing emit broadcaster as `assistant:security` so the
  // renderer can flip `Security: PENDING` → active and record threats.
  const aidefence = deps.rufloCall
    ? createAidefenceGate({
        rufloCall: deps.rufloCall,
        audit: (e) => {
          try {
            deps.emit('assistant:security', { kind: e.kind, detail: e.detail });
          } catch {
            /* audit fan-out is best-effort */
          }
        },
      })
    : undefined;

  /** P3-S7 — Returns the persisted trace so the caller can link follow-up
   *  rows (e.g. `swarm_origins`) to the same `messages.id` written by the
   *  tracer. The previous void return value would have forced a second
   *  appendMessage round-trip. */
  const recordTrace = (
    p: Omit<ToolTrace, 'id' | 'finishedAt' | 'startedAt'> & { startedAt?: number },
  ): ToolTrace => {
    const trace: ToolTrace = {
      id: randomUUID(),
      conversationId: p.conversationId,
      name: p.name,
      startedAt: p.startedAt ?? Date.now(),
      finishedAt: Date.now(),
      args: safeSerialize(p.args) as Record<string, unknown>,
      ok: p.ok,
      result: safeSerialize(p.result),
      error: p.error,
    };
    tracer.record(trace);
    return trace;
  };

  const invokeAssistantTool = async (input: {
    conversationId?: string;
    name: string;
    args: Record<string, unknown>;
    origin?: ToolOrigin;
    confirmDangerous?: ConfirmDangerous;
    /** BSP-B3 — shared per-turn CDP call counter (passed from the send closure). */
    cdpCallCounter?: { count: number };
    /** Task 4 — label of the external client for grant keying. */
    clientLabel?: string;
  }): Promise<{ ok: boolean; result: unknown; error?: string }> => {
    const tool = findTool(input?.name ?? '');
    const conv = input?.conversationId ? getConversation(input.conversationId) : null;
    const origin: ToolOrigin = input?.origin ?? 'local';
    const traceBase = {
      conversationId: conv?.id ?? null,
      name: tool?.id ?? input?.name ?? '<unknown>',
    };
    if (!tool) {
      const err = `Unknown tool: ${input?.name}`;
      recordTrace({ ...traceBase, args: input?.args ?? {}, ok: false, result: null, error: err });
      return { ok: false, result: null, error: err };
    }
    // R-1 (Jorvis Telegram remote) — authorization gate. Remote-origin calls to
    // DANGEROUS_REMOTE tools (`prompt_agent`, which writes raw bytes into a live
    // PTY; `close_pane`, which kills a pane) require explicit human
    // confirmation. Local-origin calls
    // are NOT gated — in-app operator behaviour is unchanged. Free + contained
    // tools always pass through here (containment is enforced inside the tool
    // handlers themselves, for every origin).
    if (origin === 'telegram' && DANGEROUS_REMOTE.has(tool.id)) {
      const args = input?.args ?? {};
      let approved = false;
      try {
        approved =
          typeof input?.confirmDangerous === 'function' &&
          (await input.confirmDangerous(tool.id, summarizeArgs(tool.id, args))) === true;
      } catch {
        approved = false;
      }
      if (!approved) {
        const error = 'This action needs confirmation and was not approved.';
        recordTrace({ ...traceBase, args, ok: false, result: null, error });
        return { ok: false, result: null, error };
      }
    }
    // Supervised-autonomy gate for origin:'external' (Control MCP). Provider-aware:
    // talking to an AGENT pane is free; close/destructive/shell-write escalates.
    if (origin === 'external') {
      const killSwitch = deps.controlFrozen ? deps.controlFrozen() : false;
      const sidRaw = (input?.args as { sessionId?: unknown })?.sessionId;
      const sid = typeof sidRaw === 'string' ? sidRaw : null;
      const targetProvider = sid && deps.resolveSessionProvider ? deps.resolveSessionProvider(sid) : null;
      // Task 4 — one-shot grant check: a previous operator approval provides a
      // consumable grant that downgrades the escalate verdict to free once.
      const clientLabel = input?.clientLabel ?? 'external';
      const argsHash = JSON.stringify(input?.args ?? {});
      const pendingStore = deps.pendingEscalations;
      const verdict = classifyExternal({
        toolId: tool.id,
        targetProvider,
        killSwitch,
        consumeGrant: pendingStore
          ? () => pendingStore.consumeGrant(tool.id, argsHash, clientLabel)
          : undefined,
      });
      if (verdict === 'deny') {
        const error = 'External control is frozen (kill-switch engaged).';
        recordTrace({ ...traceBase, args: input?.args ?? {}, ok: false, result: null, error });
        return { ok: false, result: null, error };
      }
      if (verdict === 'escalate') {
        // Task 4: non-blocking path for external origin when the pending store is
        // wired. Register the escalation and return immediately; the driver polls
        // check_escalation and re-issues when approved.
        if (pendingStore) {
          const summary = summarizeArgs(tool.id, input?.args ?? {});
          const { id: escalationId } = pendingStore.registerEscalation({
            toolName: tool.id,
            argsHash,
            summary,
            clientLabel,
          });
          const error = `Needs operator approval. Poll check_escalation({escalationId:"${escalationId}"}) then re-issue.`;
          recordTrace({
            ...traceBase,
            args: input?.args ?? {},
            ok: false,
            result: { status: 'needs_approval', escalationId },
            error,
          });
          return { ok: false, result: { status: 'needs_approval', escalationId }, error };
        }
        // Fallback (no pending store): blocking path for back-compat.
        let approved = false;
        try {
          approved =
            typeof input?.confirmDangerous === 'function' &&
            (await input.confirmDangerous(tool.id, summarizeArgs(tool.id, input?.args ?? {}))) === true;
        } catch {
          approved = false;
        }
        if (!approved) {
          const error = 'This action needs operator confirmation and was not approved.';
          recordTrace({ ...traceBase, args: input?.args ?? {}, ok: false, result: null, error });
          return { ok: false, result: null, error };
        }
      }
    }
    const startedAt = Date.now();
    let parsed: Record<string, unknown>;
    try {
      parsed = tool.parse(input?.args ?? {});
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const error = `Invalid input: ${message}`;
      recordTrace({ ...traceBase, args: input?.args ?? {}, ok: false, result: null, error, startedAt });
      return { ok: false, result: null, error };
    }
    try {
      const result = await tool.handler(parsed, {
        pty: deps.pty,
        worktreePool: deps.worktreePool,
        mailbox: deps.mailbox,
        memory: deps.memory,
        tasks: deps.tasks,
        browserRegistry: deps.browserRegistry,
        defaultWorkspaceId: conv?.workspaceId ?? null,
        userDataDir: deps.userDataDir,
        // Spec 2026-06-10 (A) — let pane-spawning tools echo dispatch-echo.
        emit: deps.emit,
        // R-1 — provenance + confirm hook also flow into the tool ctx so a
        // handler can apply origin-specific behaviour if it needs to. The gate
        // above is the primary enforcement point.
        origin,
        confirmDangerous: input?.confirmDangerous,
        // H-19 (full) — opportunistic ingestion scanner. Wired from the same
        // aidefence gate built at :124-139; no-op (undefined) when no ruflo
        // proxy is injected, so back-compat is preserved.
        scanIngested: aidefence
          ? (t: string, l: string) => aidefence.scanIngested(t, l)
          : undefined,
        // BSP-B3 — KV read accessor for the browser.agentDriving gate.
        // Never throws: the `?? null` fallback degrades to OFF safely.
        kvGet: (key: string): string | null => {
          try {
            const row = getRawDb()
              .prepare('SELECT value FROM kv WHERE key = ?')
              .get(key) as { value?: string } | undefined;
            return row?.value ?? null;
          } catch {
            return null;
          }
        },
        // BSP-B3 — per-turn CDP call counter shared across all tool calls in
        // this assistant turn. The send-level closure allocates once per turn;
        // the direct invokeTool RPC path passes the counter from its input.
        cdpCallCounter: input.cdpCallCounter,
        // Audit 2026-06-10 — launch sinks ride the tool ctx so launch_pane
        // (including the MCP-host bridge path) gets them too.
        notifications: deps.notifications,
        broadcastPtyError: deps.broadcastPtyError,
        resolveSessionProvider: deps.resolveSessionProvider,
        promptSink: deps.promptSink,
        appState: deps.appState,
        swarms: deps.swarms,
        pendingEscalations: deps.pendingEscalations,
      });
      // P3-S7 — single persistence path: the tracer writes the `messages`
      // row with role='tool' and `toolCallId` set to the trace id; the
      // legacy second appendMessage call here is gone because it
      // duplicated the row + lost the ulid back-link.
      const trace = recordTrace({ ...traceBase, args: parsed, ok: true, result, startedAt });
      if (conv && tool.id === 'create_swarm') {
        // P3-S7 — Sigma → swarm cross-link. The tool result includes the
        // freshly-created swarm row; persist a `swarm_origins` row keyed
        // to the trace's `messages.id` so the Operator Console can show
        // "Started from Sigma Assistant chat: <date>" and link back to
        // this exact tool call.
        const swarmId =
          typeof (result as { swarm?: { id?: string } } | null)?.swarm?.id === 'string'
            ? (result as { swarm: { id: string } }).swarm.id
            : null;
        if (swarmId && trace.messageId) {
          try {
            recordSwarmOrigin({
              swarmId,
              conversationId: conv.id,
              messageId: trace.messageId,
            });
          } catch {
            /* origin is decorative — never fail the tool call over it */
          }
        }
      }
      return { ok: true, result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      recordTrace({ ...traceBase, args: parsed, ok: false, result: null, error: message, startedAt });
      return { ok: false, result: null, error: message };
    }
  };

  const controller = defineController({
    send: async (input: {
      workspaceId: string;
      conversationId?: string;
      prompt: string;
      attachments?: string[];
      /**
       * R-1 (Jorvis Telegram remote) — who started this turn. `'local'`
       * (default) is the in-app operator; `'telegram'` is the remote bridge,
       * whose DANGEROUS_REMOTE tool calls are gated through `confirmDangerous`.
       * Every existing caller omits this and keeps full-trust local behaviour.
       */
      origin?: ToolOrigin;
      /**
       * R-1 — confirm-on-dangerous hook, supplied by the remote bridge. Carried
       * onto the turn so it reaches the tool-invocation gate. Optional.
       */
      confirmDangerous?: ConfirmDangerous;
    }): Promise<{ conversationId: string; turnId: string }> => {
      if (typeof input?.workspaceId !== 'string' || !input.workspaceId) {
        throw new Error('assistant.send: workspaceId required');
      }
      if (typeof input?.prompt !== 'string') {
        throw new Error('assistant.send: prompt required');
      }
      const origin: ToolOrigin = input.origin === 'telegram' ? 'telegram' : 'local';
      const confirmDangerous = input.confirmDangerous;
      let conversationId = input.conversationId ?? null;
      if (conversationId && !getConversation(conversationId)) conversationId = null;
      if (!conversationId) {
        conversationId = createConversation({
          workspaceId: input.workspaceId,
          kind: 'assistant',
        }).id;
      }
      appendMessage({ conversationId, role: 'user', content: input.prompt });
      // H-19 (partial) — ADVISORY inbound scan. Best-effort + never blocks the
      // local operator's own prompt; a flagged result is AUDITED (the gate emits
      // `assistant:security`) so threats are recorded and `Security: PENDING`
      // becomes active. No-op when `aidefence` is absent. Wrapped so a scan
      // never delays or breaks the turn it precedes.
      try {
        await aidefence?.scanInbound(input.prompt);
      } catch {
        /* scan is advisory + never-fail-open — ignore */
      }
      const turnId = randomUUID();
      const turn: ActiveTurn = { conversationId, turnId, cancelled: false };
      activeTurns.set(turnId, turn);
      // BSP-B3 — allocate a fresh CDP call counter for this turn. It is shared
      // (by reference) across all tool calls dispatched within the same turn so
      // the cumulative rate limit is enforced globally, not per-call.
      const turnCdpCallCounter: { count: number } = { count: 0 };
      // V3-W14-002 — try the local Claude CLI first; fall back to the stub
      // when the binary is missing on disk. The stub keeps the demo path
      // alive so a fresh DMG without `claude` installed still feels alive.
      // BUG-V1.1.2-01 — resolve the workspace root for the temp `.mcp.json`
      // anchor. Falls back to the OS temp dir inside writeJorvisHostMcpConfig
      // when the workspace row is missing or the directory isn't writable.
      let mcpWorkspaceRoot: string | undefined;
      try {
        const wsRow = getDb()
          .select()
          .from(workspacesTable)
          .where(eq(workspacesTable.id, input.workspaceId))
          .get();
        mcpWorkspaceRoot = wsRow?.rootPath ?? undefined;
      } catch {
        mcpWorkspaceRoot = undefined;
      }
      void (async () => {
        try {
          const out = await runClaudeCliTurn(turn, input.prompt, {
            emit: deps.emit,
            tracer,
            ruflo: deps.ruflo,
            // H-19 (full) — opportunistic outbound PII scrub on the FINAL reply.
            // Reuses the same gate built at :124-139; no-op (undefined) when no
            // ruflo proxy is injected, so back-compat is preserved.
            scrubFinal: aidefence ? (t: string) => aidefence.scrubOutbound(t) : undefined,
            dispatchTool: async (name, args) => {
              // R-1 — carry the turn's origin + confirm hook onto every tool
              // call the CLI emits, so the authorization gate fires for
              // telegram-origin DANGEROUS_REMOTE tools.
              // BSP-B3 — also carry the per-turn CDP counter.
              const result = await invokeAssistantTool({
                conversationId,
                name,
                args,
                origin,
                confirmDangerous,
                cdpCallCounter: turnCdpCallCounter,
              });
              if (!result.ok) throw new Error(result.error ?? `Tool failed: ${name}`);
              return result.result;
            },
            mcpHost: deps.mcpHost
              ? {
                  serverEntry: deps.mcpHost.serverEntry,
                  socketPath: deps.mcpHost.socketPath,
                  workspaceRoot: mcpWorkspaceRoot,
                }
              : undefined,
          });
          if (!out.handled && out.reason === 'no-binary') {
            await runStubTurn(turn, input.prompt, deps, {
              forcedReply:
                'Claude Code CLI not detected on disk. Install Claude Code (https://www.anthropic.com/claude-code) to enable Sigma Assistant.',
            });
          }
        } catch (err) {
          // Last-ditch: the CLI driver itself blew up. Surface the error
          // through the stub so the user sees something.
          const message = err instanceof Error ? err.message : String(err);
          await runStubTurn(turn, input.prompt, deps, {
            forcedReply: `Sigma Assistant hit an error: ${message}`,
          });
        } finally {
          activeTurns.delete(turnId);
        }
      })();
      return { conversationId, turnId };
    },

    list: async (input: { workspaceId: string }): Promise<ConversationWithMessages[]> => {
      if (typeof input?.workspaceId !== 'string' || !input.workspaceId) {
        throw new Error('assistant.list: workspaceId required');
      }
      return listConversations({ workspaceId: input.workspaceId, kind: 'assistant' });
    },

    cancel: async (input: { conversationId: string; turnId: string }): Promise<void> => {
      const t = activeTurns.get(input.turnId);
      if (t) t.cancelled = true;
      // V3-W14-002 — also kill the in-flight CLI child if there is one.
      // No-op when the turn is being run by the stub fallback.
      cancelClaudeCliTurn(input.turnId);
    },

    /** Spawn N panes; emit one `assistant:dispatch-echo` per pane. */
    dispatchPane: async (input: {
      workspaceId: string;
      provider: string;
      count: number;
      initialPrompt: string;
      conversationId?: string;
    }): Promise<{ sessionIds: string[] }> => {
      if (typeof input?.workspaceId !== 'string' || !input.workspaceId) {
        throw new Error('assistant.dispatchPane: workspaceId required');
      }
      const count = Math.max(1, Math.min(8, Math.trunc(input.count ?? 1)));
      const wsRow = getDb()
        .select()
        .from(workspacesTable)
        .where(eq(workspacesTable.id, input.workspaceId))
        .get();
      if (!wsRow) {
        throw new Error(`assistant.dispatchPane: workspace not found: ${input.workspaceId}`);
      }
      const plan: LaunchPlan = {
        workspaceRoot: wsRow.rootPath,
        preset: pickPreset(count),
        panes: Array.from({ length: count }, (_, i) => ({
          paneIndex: i,
          providerId: input.provider,
          initialPrompt: input.initialPrompt,
        })),
      };
      const out = await executeLaunchPlan(plan, {
        pty: deps.pty,
        worktreePool: deps.worktreePool,
        notifications: deps.notifications,
        broadcastPtyError: deps.broadcastPtyError,
      });
      const sessionIds = out.sessions
        .filter((s): s is AgentSession => s.status !== 'error')
        .map((s) => s.id);
      for (const session of out.sessions) {
        try {
          deps.emit('assistant:dispatch-echo', {
            workspaceId: input.workspaceId,
            sessionId: session.id,
            providerId: session.providerId,
            ok: session.status !== 'error',
            error: session.error ?? null,
            conversationId: input.conversationId ?? null,
          });
        } catch {
          /* best-effort */
        }
      }
      if (input.conversationId && getConversation(input.conversationId)) {
        appendMessage({
          conversationId: input.conversationId,
          role: 'tool',
          content: JSON.stringify({
            tool: 'dispatchPane',
            sessionIds,
            count: sessionIds.length,
          }),
          toolCallId: 'dispatchPane',
        });
      }
      return { sessionIds };
    },

    tools: async () => publicTools(),

    invokeTool: async (input: {
      conversationId?: string;
      name: string;
      args: Record<string, unknown>;
      origin?: ToolOrigin;
      confirmDangerous?: ConfirmDangerous;
    }): Promise<{ ok: boolean; result: unknown; error?: string }> => {
      return invokeAssistantTool(input);
    },

    /**
     * V3-W13-013 — Spawn multiple panes in one call. For each item in the
     * array, spawns `count` panes via the existing `dispatchPane` internal
     * path. Unknown providers produce per-pane error entries; other items
     * continue — no fail-fast.
     */
    dispatchBulk: async (
      items: Array<{
        workspaceId: string;
        provider: string;
        count: number;
        initialPrompt?: string;
        conversationId?: string;
      }>,
    ): Promise<
      Array<{
        paneId: string | null;
        providerId: string;
        workspaceId: string;
        success: boolean;
        error?: string;
      }>
    > => {
      if (!Array.isArray(items) || items.length === 0) {
        throw new Error('assistant.dispatchBulk: items must be a non-empty array');
      }
      const results: Array<{
        paneId: string | null;
        providerId: string;
        workspaceId: string;
        success: boolean;
        error?: string;
      }> = [];

      for (const item of items) {
        const workspaceId = typeof item?.workspaceId === 'string' ? item.workspaceId : '';
        const providerId = typeof item?.provider === 'string' ? item.provider : '';
        const count = Math.max(1, Math.min(8, Math.trunc(item?.count ?? 1)));

        if (!workspaceId) {
          results.push({ paneId: null, providerId, workspaceId, success: false, error: 'workspaceId required' });
          continue;
        }
        if (!providerId) {
          results.push({ paneId: null, providerId, workspaceId, success: false, error: 'provider required' });
          continue;
        }

        // Validate provider exists in the registry
        const providerDef = findProvider(providerId);
        if (!providerDef) {
          for (let i = 0; i < count; i++) {
            results.push({
              paneId: null,
              providerId,
              workspaceId,
              success: false,
              error: `Unknown provider: ${providerId}`,
            });
          }
          continue;
        }

        const wsRow = getDb()
          .select()
          .from(workspacesTable)
          .where(eq(workspacesTable.id, workspaceId))
          .get();
        if (!wsRow) {
          for (let i = 0; i < count; i++) {
            results.push({
              paneId: null,
              providerId,
              workspaceId,
              success: false,
              error: `Workspace not found: ${workspaceId}`,
            });
          }
          continue;
        }

        const plan: LaunchPlan = {
          workspaceRoot: wsRow.rootPath,
          preset: pickPreset(count),
          panes: Array.from({ length: count }, (_, i) => ({
            paneIndex: i,
            providerId,
            initialPrompt: item.initialPrompt,
          })),
        };

        let out: Awaited<ReturnType<typeof executeLaunchPlan>>;
        try {
          out = await executeLaunchPlan(plan, {
            pty: deps.pty,
            worktreePool: deps.worktreePool,
            notifications: deps.notifications,
            broadcastPtyError: deps.broadcastPtyError,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          for (let i = 0; i < count; i++) {
            results.push({ paneId: null, providerId, workspaceId, success: false, error: message });
          }
          continue;
        }

        for (const session of out.sessions) {
          const success = session.status !== 'error';
          results.push({
            paneId: success ? session.id : null,
            providerId,
            workspaceId,
            success,
            error: success ? undefined : (session.error ?? 'launch failed'),
          });
          try {
            deps.emit('assistant:dispatch-echo', {
              workspaceId,
              sessionId: session.id,
              providerId: session.providerId,
              ok: success,
              error: session.error ?? null,
              conversationId: item.conversationId ?? null,
            });
          } catch {
            /* best-effort */
          }
        }
      }

      return results;
    },

    /**
     * V3-W13-013 — Resolve an `@filename` ref typed in a Sigma conversation.
     * Walks the workspace index (or the workspace root via fs.readdirSync
     * recursion) for files matching `atRef` (case-insensitive basename match).
     * Returns up to 10 matches with `{ absPath, snippet }`.
     */
    refResolve: async (input: {
      workspaceId: string;
      atRef: string;
    }): Promise<Array<{ absPath: string; snippet: string }>> => {
      if (typeof input?.workspaceId !== 'string' || !input.workspaceId) {
        throw new Error('assistant.refResolve: workspaceId required');
      }
      const atRef = typeof input?.atRef === 'string' ? input.atRef.replace(/^@/, '').trim() : '';
      if (!atRef) return [];

      const wsRow = getDb()
        .select()
        .from(workspacesTable)
        .where(eq(workspacesTable.id, input.workspaceId))
        .get();
      if (!wsRow) return [];

      const root = wsRow.rootPath;
      if (!root) return [];

      const MAX_RESULTS = 10;
      const SNIPPET_LEN = 200;
      const MAX_WALK_DEPTH = 8;
      const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'out', '__pycache__', '.cache']);

      const matches: Array<{ absPath: string; snippet: string }> = [];
      const needle = atRef.toLowerCase();

      function walk(dir: string, depth: number): void {
        if (depth > MAX_WALK_DEPTH || matches.length >= MAX_RESULTS) return;
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          if (matches.length >= MAX_RESULTS) return;
          if (entry.isDirectory()) {
            if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
            walk(path.join(dir, entry.name), depth + 1);
          } else if (entry.isFile()) {
            if (entry.name.toLowerCase().includes(needle)) {
              const absPath = path.join(dir, entry.name);
              let snippet = '';
              try {
                const raw = fs.readFileSync(absPath, 'utf8');
                snippet = raw.slice(0, SNIPPET_LEN);
              } catch {
                snippet = '';
              }
              matches.push({ absPath, snippet });
            }
          }
        }
      }

      walk(root, 0);
      return matches;
    },
  });
  return { controller, invokeTool: invokeAssistantTool };
}

/**
 * W13 stub turn — emits a deterministic assistant message + streamed deltas.
 *
 * V3-W14-002 — now used as the fallback path when the local Claude CLI is
 * missing on disk. The caller may pass `forcedReply` to surface a specific
 * install-prompt or error message instead of the heuristic stub.
 */
async function runStubTurn(
  turn: ActiveTurn,
  prompt: string,
  deps: AssistantControllerDeps,
  opts?: { forcedReply?: string },
): Promise<void> {
  const reply = opts?.forcedReply ?? composeStubReply(prompt);
  emitState(deps, 'thinking', turn);
  await delay(150);
  if (turn.cancelled) return;
  emitState(deps, 'receiving', turn);
  const message = appendMessage({
    conversationId: turn.conversationId,
    role: 'assistant',
    content: reply,
  });
  for (let i = 0; i < reply.length; i += 4) {
    if (turn.cancelled) {
      emitState(deps, 'standby', turn, { cancelled: true });
      return;
    }
    try {
      deps.emit('assistant:state', {
        kind: 'delta',
        conversationId: turn.conversationId,
        turnId: turn.turnId,
        messageId: message.id,
        delta: reply.slice(i, i + 4),
      });
    } catch {
      /* best-effort */
    }
    await delay(35);
  }
  emitState(deps, 'standby', turn, { messageId: message.id });
}

function composeStubReply(prompt: string): string {
  const t = prompt.trim();
  if (!t) return 'Standing by — what would you like me to do?';
  if (/\b(launch|spawn|start|run)\b/i.test(t)) {
    return `I would dispatch a pane for: "${t}". Use Dispatch to spawn it, or ask me to refine the prompt first.`;
  }
  if (/\b(memory|note|search)\b/i.test(t)) {
    return `I can search memories or create a new note. Try: "search memories for ${t}".`;
  }
  return `Got it — "${t}". I'm in stub mode for W13; the LLM-backed turn lands in W14.`;
}

function emitState(
  deps: AssistantControllerDeps,
  state: 'standby' | 'listening' | 'receiving' | 'thinking',
  turn: ActiveTurn,
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
