import { useCallback, useEffect, useState } from 'react';
import { useAppState } from '@/renderer/app/state';
import { rpc } from '@/renderer/lib/rpc';
import type { ChatMessageView, ChatRole } from './ChatTranscript';
import type { AppRouter } from '@/shared/router-shape';

export const KV_ACTIVE_CONVERSATION = 'sigma.activeConversationId';

type ConvList = Awaited<ReturnType<AppRouter['assistant']['conversations']['list']>>;
type ConvGet = Awaited<ReturnType<AppRouter['assistant']['conversations']['get']>>;
export type ConversationListRow = ConvList[number] & { claudeSessionId?: string | null };
type HydratedConversation = NonNullable<ConvGet['conversation']> & {
  claudeSessionId?: string | null;
};

export interface ResumeNotice {
  conversationId: string;
  lastMessageAt: number;
}

export const persistActiveConversation = (id: string): void => {
  void rpc.kv.set(KV_ACTIVE_CONVERSATION, id).catch(() => undefined);
};

/** Side-band invoke for the `assistant.conversations.<method>` namespace.
 *  The typed `rpc` proxy only knows about flat namespaces; this helper
 *  mirrors the `invokeReplay` pattern used by the Operator Console replay
 *  scrubber so the renderer can still exercise side-band channels with
 *  the standard `{ok,data,error}` envelope. */
async function invokeSideBand<T = unknown>(
  channel: `assistant.conversations.${string}` | `swarm.origin.${string}`,
  ...args: unknown[]
): Promise<T> {
  if (!('sigma' in window)) {
    throw new Error('Preload bridge missing — restart the app.');
  }
  const env = (await window.sigma.invoke(channel, ...args)) as
    | { ok: true; data: T }
    | { ok: false; error: string };
  if (!env || typeof env !== 'object' || !('ok' in env)) {
    throw new Error(`Bad RPC response from ${channel}`);
  }
  if (env.ok) return env.data;
  throw new Error(env.error);
}

export interface UseSigmaConversationsReturn {
  conversations: ConversationListRow[];
  conversationId: string | null;
  setConversationId: React.Dispatch<React.SetStateAction<string | null>>;
  messages: ChatMessageView[];
  setMessages: React.Dispatch<React.SetStateAction<ChatMessageView[]>>;
  resumeNotice: ResumeNotice | null;
  setResumeNotice: React.Dispatch<React.SetStateAction<ResumeNotice | null>>;
  refreshConversations: (workspaceId: string) => Promise<ConversationListRow[]>;
  hydrateConversation: (id: string) => Promise<void>;
  onPickConversation: (id: string) => void;
  onDeleteConversation: (id: string) => Promise<void>;
  clearConversation: () => void;
}

export function useSigmaConversations(): UseSigmaConversationsReturn {
  const { state } = useAppState();
  const wsId = state.activeWorkspace?.id;
  const [conversations, setConversations] = useState<ConversationListRow[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessageView[]>([]);
  const [resumeNotice, setResumeNotice] = useState<ResumeNotice | null>(null);

  /** P3-S7 — Refresh the Conversations panel from the side-band channel.
   *  Pulled into a callback so the panel can re-fetch after a delete or
   *  after a fresh `assistant.send` upgrades a transient client-side row
   *  into a persisted one. */
  const refreshConversations = useCallback(
    async (forWorkspaceId: string): Promise<ConversationListRow[]> => {
      try {
        const rows = await invokeSideBand<ConvList>('assistant.conversations.list', {
          workspaceId: forWorkspaceId,
        });
        setConversations(rows);
        return rows;
      } catch {
        setConversations([]);
        return [];
      }
    },
    [],
  );

  /** Hydrate a specific conversation into the transcript. Falls back to a
   *  blank slate when the row no longer exists (e.g. it was just deleted). */
  const hydrateConversation = useCallback(async (id: string): Promise<void> => {
    try {
      const res = await invokeSideBand<ConvGet>('assistant.conversations.get', {
        conversationId: id,
      });
      if (!res.conversation) {
        setConversationId(null);
        setMessages([]);
        setResumeNotice(null);
        return;
      }
      const conversation = res.conversation as HydratedConversation;
      setConversationId(conversation.id);
      setMessages(
        res.messages.map((m) => ({
          id: m.id,
          role: m.role as ChatRole,
          content: m.content,
          toolCallId: m.toolCallId,
          createdAt: m.createdAt,
        })),
      );
      setResumeNotice(
        conversation.claudeSessionId
          ? {
              conversationId: conversation.id,
              lastMessageAt: res.messages.at(-1)?.createdAt ?? conversation.createdAt,
            }
          : null,
      );
    } catch {
      /* keep current view on hydration failure */
    }
  }, []);

  // Hydrate the conversation list when the workspace changes. Reset path
  // is microtasked so we never call setState synchronously inside the
  // effect body (lint: react-hooks/set-state-in-effect).
  useEffect(() => {
    let alive = true;
    void (async () => {
      if (!wsId) {
        if (!alive) return;
        setConversationId(null);
        setMessages([]);
        setConversations([]);
        setResumeNotice(null);
        return;
      }
      const rows = await refreshConversations(wsId);
      if (!alive) return;
      // Restore the persisted active conversation when one exists in this
      // workspace; otherwise drop down to the most recent or empty.
      let restored: string | null = null;
      try {
        restored = await rpc.kv.get(KV_ACTIVE_CONVERSATION);
      } catch {
        restored = null;
      }
      if (!alive) return;
      const target =
        rows.find((r) => r.id === restored)?.id ?? rows[0]?.id ?? null;
      if (target) {
        await hydrateConversation(target);
      } else {
        setConversationId(null);
        setMessages([]);
        setResumeNotice(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [wsId, refreshConversations, hydrateConversation]);

  const onPickConversation = useCallback(
    (id: string) => {
      void hydrateConversation(id);
      persistActiveConversation(id);
    },
    [hydrateConversation],
  );

  const onDeleteConversation = useCallback(
    async (id: string) => {
      try {
        await invokeSideBand<{ ok: true }>('assistant.conversations.delete', {
          conversationId: id,
        });
      } catch {
        /* swallowed; the panel still refreshes below */
      }
      if (!wsId) return;
      const rows = await refreshConversations(wsId);
      // If the deleted row was active, fall back to the next one.
      if (id === conversationId) {
        const next = rows[0]?.id ?? null;
        if (next) {
          await hydrateConversation(next);
          persistActiveConversation(next);
        } else {
          setConversationId(null);
          setMessages([]);
          setResumeNotice(null);
          persistActiveConversation('');
        }
      }
    },
    [conversationId, wsId, refreshConversations, hydrateConversation],
  );

  const clearConversation = useCallback(() => {
    setConversationId(null);
    setMessages([]);
    setResumeNotice(null);
    persistActiveConversation('');
  }, []);

  return {
    conversations,
    conversationId,
    setConversationId,
    messages,
    setMessages,
    resumeNotice,
    setResumeNotice,
    refreshConversations,
    hydrateConversation,
    onPickConversation,
    onDeleteConversation,
    clearConversation,
  };
}
