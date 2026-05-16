import { useEffect } from 'react';
import { rpcSilent, onEvent } from '@/renderer/lib/rpc';
import type { OrbState } from './Orb';
import type { ChatMessageView } from './ChatTranscript';

interface AssistantStateEvent {
  kind: 'state' | 'delta';
  state?: OrbState;
  conversationId: string;
  turnId: string;
  delta?: string;
  messageId?: string;
}

export interface UseSigmaAssistantStateArgs {
  conversationId: string | null;
  setMessages: React.Dispatch<React.SetStateAction<ChatMessageView[]>>;
  setOrbState: React.Dispatch<React.SetStateAction<OrbState>>;
  setBusy: React.Dispatch<React.SetStateAction<boolean>>;
  setStreaming: React.Dispatch<React.SetStateAction<{ turnId: string; delta: string } | null>>;
  lastSentPromptRef: React.MutableRefObject<string | null>;
  rufloReadyRef: React.MutableRefObject<boolean>;
}

/** assistant:state event handler for streaming. Handles state transitions,
 *  delta accumulation, and fire-and-forget pattern store on standby. */
export function useSigmaAssistantState({
  conversationId,
  setMessages,
  setOrbState,
  setBusy,
  setStreaming,
  lastSentPromptRef,
  rufloReadyRef,
}: UseSigmaAssistantStateArgs): void {
  useEffect(() => {
    const off = onEvent<AssistantStateEvent>('assistant:state', (raw) => {
      if (!raw || typeof raw !== 'object') return;
      const e = raw as AssistantStateEvent;
      if (conversationId && e.conversationId !== conversationId) return;
      if (e.kind === 'state') {
        if (e.state) setOrbState(e.state);
        if (e.state === 'standby') {
          setBusy(false);
          // Phase 4 Track C — fire-and-forget pattern store.
          if (lastSentPromptRef.current && rufloReadyRef.current) {
            const pat = lastSentPromptRef.current;
            lastSentPromptRef.current = null;
            void rpcSilent.ruflo['patterns.store']({
              pattern: pat,
              type: 'task-completion',
              confidence: 0.8,
            }).catch(() => {
              /* background telemetry — losing it is acceptable */
            });
          }
          setStreaming((prev) => {
            if (!prev || !e.messageId) return null;
            const messageId = e.messageId;
            setMessages((rows) =>
              rows.some((r) => r.id === messageId)
                ? rows
                : [
                    ...rows,
                    {
                      id: messageId,
                      role: 'assistant',
                      content: prev.delta,
                      createdAt: Date.now(),
                    },
                  ],
            );
            return null;
          });
        }
      } else if (e.kind === 'delta' && e.delta) {
        setStreaming((prev) =>
          !prev || prev.turnId !== e.turnId
            ? { turnId: e.turnId, delta: e.delta ?? '' }
            : { turnId: prev.turnId, delta: prev.delta + e.delta },
        );
      }
    });
    return off;
  }, [conversationId, setMessages, setOrbState, setBusy, setStreaming, lastSentPromptRef, rufloReadyRef]);
}
