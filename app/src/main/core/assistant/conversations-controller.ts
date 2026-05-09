// P3-S7 — Side-band handlers for the Conversations panel + the Operator
// Console origin link.
//
// Two reusable handler maps:
//   buildConversationsHandlers() — `assistant.conversations.{list,get,delete}`
//   buildSwarmOriginHandlers()   — `swarm.origin.get`
//
// Registered out-of-line in `rpc-router.ts` so the typed AppRouter shape
// stays flat (the existing rpc-proxy supports a single namespace level).
// The renderer reaches these via `window.sigma.invoke('assistant.conversations.list', …)`.

import {
  deleteConversation,
  getConversation,
  listConversationSummaries,
  messagesFor,
  type ConversationSummary,
  type Message,
} from './conversations';
import { getSwarmOrigin, type SwarmOrigin } from './swarm-origins';

export type SideBandHandlers = Record<string, (...args: unknown[]) => unknown>;

/** Build the `assistant.conversations.*` handler map. */
export function buildConversationsHandlers(): SideBandHandlers {
  return {
    list: async (input: unknown): Promise<ConversationSummary[]> => {
      const arg = (input as { workspaceId?: string }) ?? {};
      if (typeof arg.workspaceId !== 'string' || !arg.workspaceId) {
        throw new Error('assistant.conversations.list: workspaceId required');
      }
      return listConversationSummaries({
        workspaceId: arg.workspaceId,
        kind: 'assistant',
      });
    },
    get: async (
      input: unknown,
    ): Promise<{
      conversation: { id: string; workspaceId: string; createdAt: number } | null;
      messages: Message[];
    }> => {
      const arg = (input as { conversationId?: string }) ?? {};
      if (typeof arg.conversationId !== 'string' || !arg.conversationId) {
        throw new Error('assistant.conversations.get: conversationId required');
      }
      const conv = getConversation(arg.conversationId);
      if (!conv) return { conversation: null, messages: [] };
      return {
        conversation: {
          id: conv.id,
          workspaceId: conv.workspaceId,
          createdAt: conv.createdAt,
        },
        messages: messagesFor(conv.id),
      };
    },
    delete: async (input: unknown): Promise<{ ok: true }> => {
      const arg = (input as { conversationId?: string }) ?? {};
      if (typeof arg.conversationId !== 'string' || !arg.conversationId) {
        throw new Error('assistant.conversations.delete: conversationId required');
      }
      deleteConversation(arg.conversationId);
      return { ok: true };
    },
  };
}

/** Build the `swarm.origin.*` handler map. The only method for v1 is `get`,
 *  which resolves the back-link a swarm has into the Bridge Assistant chat
 *  that triggered it (or returns null when none exists). */
export function buildSwarmOriginHandlers(): SideBandHandlers {
  return {
    get: async (input: unknown): Promise<SwarmOrigin | null> => {
      const arg = (input as { swarmId?: string }) ?? {};
      if (typeof arg.swarmId !== 'string' || !arg.swarmId) {
        throw new Error('swarm.origin.get: swarmId required');
      }
      return getSwarmOrigin(arg.swarmId);
    },
  };
}
