// V3-W13-013 — Bridge Assistant RPC controller. Wires `assistant.*` to the
// conversations DAO, the launcher (dispatchPane), the tool registry (10
// tools), and the tool tracer. V3-W14-002 — `send` now drives the local
// Claude Code CLI via runClaudeCliTurn; runStubTurn is the binary-missing
// fallback only.

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { defineController } from '../../../shared/rpc';
import type { PtyRegistry } from '../pty/registry';
import type { WorktreePool } from '../git/worktree';
import type { SwarmMailbox } from '../swarms/mailbox';
import type { MemoryManager } from '../memory/manager';
import type { TasksManager } from '../tasks/manager';
import type { BrowserManagerRegistry } from '../browser/manager';
import type { AgentSession, LaunchPlan } from '../../../shared/types';
import { getDb } from '../db/client';
import { workspaces as workspacesTable } from '../db/schema';
import { executeLaunchPlan } from '../workspaces/launcher';
import {
  appendMessage,
  createConversation,
  getConversation,
  listConversations,
  type ConversationWithMessages,
} from './conversations';
import { findTool, publicTools } from './tools';
import { ToolTracer, safeSerialize, type ToolTrace } from './tool-tracer';
import { recordSwarmOrigin } from './swarm-origins';
import { runClaudeCliTurn, cancelClaudeCliTurn } from './runClaudeCliTurn';
import type { RufloProxy } from '../ruflo/proxy';

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
}

interface ActiveTurn {
  conversationId: string;
  turnId: string;
  cancelled: boolean;
}

const pickPreset = (n: number): LaunchPlan['preset'] =>
  n <= 1 ? 1 : n <= 2 ? 2 : n <= 4 ? 4 : 6;

const delay = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

export function buildAssistantController(deps: AssistantControllerDeps) {
  const tracer = new ToolTracer();
  tracer.setEmitter(deps.emit);
  const activeTurns = new Map<string, ActiveTurn>();

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
  }): Promise<{ ok: boolean; result: unknown; error?: string }> => {
    const tool = findTool(input?.name ?? '');
    const conv = input?.conversationId ? getConversation(input.conversationId) : null;
    const traceBase = {
      conversationId: conv?.id ?? null,
      name: tool?.id ?? input?.name ?? '<unknown>',
    };
    if (!tool) {
      const err = `Unknown tool: ${input?.name}`;
      recordTrace({ ...traceBase, args: input?.args ?? {}, ok: false, result: null, error: err });
      return { ok: false, result: null, error: err };
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
      });
      // P3-S7 — single persistence path: the tracer writes the `messages`
      // row with role='tool' and `toolCallId` set to the trace id; the
      // legacy second appendMessage call here is gone because it
      // duplicated the row + lost the ulid back-link.
      const trace = recordTrace({ ...traceBase, args: parsed, ok: true, result, startedAt });
      if (conv && tool.id === 'create_swarm') {
        // P3-S7 — Bridge → swarm cross-link. The tool result includes the
        // freshly-created swarm row; persist a `swarm_origins` row keyed
        // to the trace's `messages.id` so the Operator Console can show
        // "Started from Bridge Assistant chat: <date>" and link back to
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

  return defineController({
    send: async (input: {
      workspaceId: string;
      conversationId?: string;
      prompt: string;
      attachments?: string[];
    }): Promise<{ conversationId: string; turnId: string }> => {
      if (typeof input?.workspaceId !== 'string' || !input.workspaceId) {
        throw new Error('assistant.send: workspaceId required');
      }
      if (typeof input?.prompt !== 'string') {
        throw new Error('assistant.send: prompt required');
      }
      let conversationId = input.conversationId ?? null;
      if (conversationId && !getConversation(conversationId)) conversationId = null;
      if (!conversationId) {
        conversationId = createConversation({
          workspaceId: input.workspaceId,
          kind: 'assistant',
        }).id;
      }
      appendMessage({ conversationId, role: 'user', content: input.prompt });
      const turnId = randomUUID();
      const turn: ActiveTurn = { conversationId, turnId, cancelled: false };
      activeTurns.set(turnId, turn);
      // V3-W14-002 — try the local Claude CLI first; fall back to the stub
      // when the binary is missing on disk. The stub keeps the demo path
      // alive so a fresh DMG without `claude` installed still feels alive.
      void (async () => {
        try {
          const out = await runClaudeCliTurn(turn, input.prompt, {
            emit: deps.emit,
            tracer,
            ruflo: deps.ruflo,
            dispatchTool: async (name, args) => {
              const result = await invokeAssistantTool({ conversationId, name, args });
              if (!result.ok) throw new Error(result.error ?? `Tool failed: ${name}`);
              return result.result;
            },
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
    }): Promise<{ ok: boolean; result: unknown; error?: string }> => {
      return invokeAssistantTool(input);
    },
  });
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
