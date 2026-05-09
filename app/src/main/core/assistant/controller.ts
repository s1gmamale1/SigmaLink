// V3-W13-013 — Bridge Assistant RPC controller. Wires `assistant.*` to the
// conversations DAO, the launcher (dispatchPane), the tool registry (10
// tools), and the tool tracer. W13 stubs the assistant turn; the LLM
// client lands in W14+.

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

export interface AssistantControllerDeps {
  pty: PtyRegistry;
  worktreePool: WorktreePool;
  mailbox: SwarmMailbox;
  memory: MemoryManager;
  tasks: TasksManager;
  browserRegistry: BrowserManagerRegistry;
  userDataDir: string;
  emit: (event: string, payload: unknown) => void;
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

  const recordTrace = (
    p: Omit<ToolTrace, 'id' | 'finishedAt' | 'startedAt'> & { startedAt?: number },
  ): void => {
    tracer.record({
      id: randomUUID(),
      conversationId: p.conversationId,
      name: p.name,
      startedAt: p.startedAt ?? Date.now(),
      finishedAt: Date.now(),
      args: safeSerialize(p.args) as Record<string, unknown>,
      ok: p.ok,
      result: safeSerialize(p.result),
      error: p.error,
    });
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
      void runStubTurn(turn, input.prompt, deps).finally(() => {
        activeTurns.delete(turnId);
      });
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
        recordTrace({ ...traceBase, args: parsed, ok: true, result, startedAt });
        if (conv) {
          appendMessage({
            conversationId: conv.id,
            role: 'tool',
            content: JSON.stringify({ tool: tool.id, result: safeSerialize(result) }),
            toolCallId: tool.id,
          });
        }
        return { ok: true, result };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        recordTrace({ ...traceBase, args: parsed, ok: false, result: null, error: message, startedAt });
        return { ok: false, result: null, error: message };
      }
    },
  });
}

/** W13 stub turn — emits a deterministic assistant message + streamed deltas. */
async function runStubTurn(
  turn: ActiveTurn,
  prompt: string,
  deps: AssistantControllerDeps,
): Promise<void> {
  const reply = composeStubReply(prompt);
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
