// P3-S7 — Side-band handlers for the Conversations panel + the Operator
// Console origin link.
//
// Two reusable handler maps:
//   buildConversationsHandlers() — `assistant.conversations.{list,get,delete,resumeHint}`
//   buildSwarmOriginHandlers()   — `swarm.origin.get`
//
// Registered out-of-line in `rpc-router.ts` so the typed AppRouter shape
// stays flat (the existing rpc-proxy supports a single namespace level).
// The renderer reaches these via `window.sigma.invoke('assistant.conversations.list', …)`.

import { existsSync as fsExistsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import { workspaces as workspacesTable } from '../db/schema';
import { claudeSlugForCwd, isClaudeSessionId } from '../pty/claude-resume-bridge';
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

export interface ConversationsHandlerDeps {
  homeDir?: string;
  existsSync?: (path: string) => boolean;
}

function workspaceRootForConversation(workspaceId: string): string | null {
  const row = getDb()
    .select({ rootPath: workspacesTable.rootPath })
    .from(workspacesTable)
    .where(eq(workspacesTable.id, workspaceId))
    .get();
  return row?.rootPath ?? null;
}

/** Build the `assistant.conversations.*` handler map. */
export function buildConversationsHandlers(
  deps: ConversationsHandlerDeps = {},
): SideBandHandlers {
  const homeDir = deps.homeDir ?? os.homedir();
  const existsSync = deps.existsSync ?? fsExistsSync;
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
      conversation: {
        id: string;
        workspaceId: string;
        createdAt: number;
        claudeSessionId: string | null;
      } | null;
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
          claudeSessionId: conv.claudeSessionId,
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
    resumeHint: async (
      input: unknown,
    ): Promise<{ available: boolean; sessionId: string | null }> => {
      const arg = (input as { conversationId?: string }) ?? {};
      if (typeof arg.conversationId !== 'string' || !arg.conversationId) {
        throw new Error('assistant.conversations.resumeHint: conversationId required');
      }
      const conv = getConversation(arg.conversationId);
      if (!conv?.claudeSessionId || !isClaudeSessionId(conv.claudeSessionId)) {
        return { available: false, sessionId: conv?.claudeSessionId ?? null };
      }
      const workspaceRoot = workspaceRootForConversation(conv.workspaceId);
      if (!workspaceRoot) {
        return { available: false, sessionId: conv.claudeSessionId };
      }
      const slug = claudeSlugForCwd(workspaceRoot);
      const jsonlPath = path.join(
        homeDir,
        '.claude',
        'projects',
        slug,
        `${conv.claudeSessionId}.jsonl`,
      );
      return {
        available: existsSync(jsonlPath),
        sessionId: conv.claudeSessionId,
      };
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
