import { useEffect, useLayoutEffect, useRef } from 'react';
import { rpcSilent, onEvent } from '@/renderer/lib/rpc';
import type { OrbState } from './Orb';
import type { ChatMessageView } from './ChatTranscript';

interface AssistantStateEvent {
  kind: 'state' | 'delta' | 'error';
  state?: OrbState;
  conversationId: string;
  turnId: string;
  delta?: string;
  messageId?: string;
  /** P0.2 — failure text carried on `kind:'error'` (runClaudeCliTurn.emit.ts
   *  emitErrorFinal). */
  message?: string;
}

export interface UseJorvisAssistantStateArgs {
  conversationId: string | null;
  setMessages: React.Dispatch<React.SetStateAction<ChatMessageView[]>>;
  setOrbState: React.Dispatch<React.SetStateAction<OrbState>>;
  setBusy: React.Dispatch<React.SetStateAction<boolean>>;
  setStreaming: React.Dispatch<
    React.SetStateAction<{ turnId: string; delta: string; messageId: string | null } | null>
  >;
  lastSentPromptRef: React.MutableRefObject<string | null>;
  rufloReadyRef: React.MutableRefObject<boolean>;
  /**
   * B3 — the id of the in-flight turn started by THIS room in THIS session.
   * `sendPrompt` writes the turnId returned by `assistant.send` here; the
   * handler below only reacts to busy/orb-affecting events whose `turnId`
   * matches. A boot/restore/stale/cross-conversation `assistant:state` event
   * can therefore no longer latch `busy=true` (or the Orb to 'thinking') at
   * rest — the at-rest state stays ungated until the local turn actually runs.
   */
  activeTurnIdRef: React.MutableRefObject<string | null>;
  /**
   * B3 — true between `sendPrompt` (which optimistically sets busy) and the
   * turn's terminal 'standby'. Lets the handler ADOPT the first event of a
   * turn even if it lands before `assistant.send` resolves and writes
   * `activeTurnIdRef` (an IPC race). At rest (`busy === false`) no event is
   * adopted, so a boot/stale event still can't gate the composer.
   */
  busyRef: React.MutableRefObject<boolean>;
  /**
   * 2026-06-10 audit #4 — mirror of the `streaming` state. The handler writes
   * it SYNCHRONOUSLY on each delta and reads it at standby so the commit
   * happens as a SIBLING setState, never inside the setStreaming updater
   * (StrictMode/rebase re-invokes updaters; a nested setMessages re-fires —
   * previously shielded only by the rows.some idempotency guard). JorvisRoom
   * re-syncs the ref when it clears `streaming` externally (watchdog, reset).
   */
  streamingRef: React.MutableRefObject<
    { turnId: string; delta: string; messageId: string | null } | null
  >;
  /**
   * B3 — per-turn watchdog. `clearWatchdog` cancels the pending timer when a
   * turn reaches standby/error (or is superseded). Owned by JorvisRoom so it
   * can also be invoked from `sendPrompt` (arm) and `onNewConversation`.
   */
  clearWatchdog: () => void;
}

/** assistant:state event handler for streaming. Handles state transitions,
 *  delta accumulation, and fire-and-forget pattern store on standby.
 *
 *  B3 — every busy/orb mutation is now gated on `turnId === activeTurnIdRef`.
 *  Deltas for the active turn still stream; standby for the active turn clears
 *  busy + the watchdog. Events for any OTHER turn (a stale in-flight turn from
 *  before a reload, a turn for a different conversation, a replayed boot event)
 *  are ignored for busy/orb purposes so they cannot brick the composer. */
export function useJorvisAssistantState({
  conversationId,
  setMessages,
  setOrbState,
  setBusy,
  setStreaming,
  lastSentPromptRef,
  rufloReadyRef,
  activeTurnIdRef,
  busyRef,
  streamingRef,
  clearWatchdog,
}: UseJorvisAssistantStateArgs): void {
  // Keep the latest props on a ref so the event subscription can stay stable
  // (it never needs to re-subscribe just because `conversationId` changed).
  // The ref is refreshed in a layout effect — writing it during render trips
  // `react-hooks/refs` ("cannot update ref during render"); a layout effect
  // commits synchronously before paint so the handler never reads stale props.
  const propsRef = useRef({
    conversationId,
    setMessages,
    setOrbState,
    setBusy,
    setStreaming,
    lastSentPromptRef,
    rufloReadyRef,
    activeTurnIdRef,
    busyRef,
    streamingRef,
    clearWatchdog,
  });
  useLayoutEffect(() => {
    propsRef.current = {
      conversationId,
      setMessages,
      setOrbState,
      setBusy,
      setStreaming,
      lastSentPromptRef,
      rufloReadyRef,
      activeTurnIdRef,
      busyRef,
      streamingRef,
      clearWatchdog,
    };
  });

  useEffect(() => {
    const off = onEvent<AssistantStateEvent>('assistant:state', (raw) => {
      if (!raw || typeof raw !== 'object') return;
      const e = raw as AssistantStateEvent;
      const p = propsRef.current;
      if (typeof e.turnId !== 'string' || !e.turnId) return;
      // B3 — only the turn THIS room started this session may move busy/orb or
      // commit a streamed reply.
      //
      // Match path: the event's turnId equals the one `assistant.send` returned.
      // Adopt path: we're busy (sendPrompt ran) but `activeTurnIdRef` isn't set
      //   yet — the first turn event raced ahead of the send response. Adopt it
      //   so early deltas aren't dropped. This only fires while busy, so a
      //   boot/stale event AT REST is never adopted and cannot gate the room.
      // Reject everything else (stale in-flight turn from before a reload, a
      //   turn for a different conversation, a replayed boot event).
      if (e.turnId !== p.activeTurnIdRef.current) {
        const adoptable =
          p.busyRef.current &&
          p.activeTurnIdRef.current === null &&
          (!p.conversationId || e.conversationId === p.conversationId);
        if (!adoptable) return;
        p.activeTurnIdRef.current = e.turnId;
      }
      // Defensive conversation match: once a turn is adopted the conversation
      // must stay consistent (a forked/renamed conversation can't hijack it).
      if (p.conversationId && e.conversationId !== p.conversationId) return;
      if (e.kind === 'error') {
        // P0.2 — a CLI/turn failure (runClaudeCliTurn.emit.ts emitErrorFinal).
        // Commit a distinct error row (idempotent by id) and retire the turn
        // so the composer unlocks with a legible failure instead of relying
        // on the trailing standby. The main process also re-emits the same
        // text as a delta then `state:'standby'{error}` — null the streaming
        // buffer here so that trailing standby (even if it re-adopts this
        // now-retired turnId via the busy-but-unset-activeTurnId path above)
        // finds nothing buffered and can't commit a second/blank row.
        const id = e.messageId ?? `err-${e.turnId}`;
        const text = e.message ?? 'Jorvis turn failed.';
        p.setMessages((rows) =>
          rows.some((r) => r.id === id)
            ? rows
            : [...rows, { id, role: 'error', content: text, createdAt: Date.now() }],
        );
        p.setBusy(false);
        // Review fix — every other failure path in this component (the
        // watchdog timeout and sendPrompt's catch, both in JorvisRoom) pairs
        // the busy-clear with an orb reset. Without this the Orb can stick on
        // "thinking" after a failed turn even though the composer unlocks.
        p.setOrbState('standby');
        p.activeTurnIdRef.current = null;
        p.streamingRef.current = null;
        p.setStreaming(null);
        p.clearWatchdog();
        return;
      }
      if (e.kind === 'state') {
        if (e.state) p.setOrbState(e.state);
        if (e.state === 'standby') {
          // B3 — turn is done; clear the gate + cancel the watchdog and retire
          // the active turn id so subsequent stray events for it are ignored.
          p.setBusy(false);
          p.activeTurnIdRef.current = null;
          p.clearWatchdog();
          // Phase 4 Track C — fire-and-forget pattern store.
          if (p.lastSentPromptRef.current && p.rufloReadyRef.current) {
            const pat = p.lastSentPromptRef.current;
            p.lastSentPromptRef.current = null;
            void rpcSilent.ruflo['patterns.store']({
              pattern: pat,
              type: 'task-completion',
              confidence: 0.8,
            }).catch(() => {
              /* background telemetry — losing it is acceptable */
            });
          }
          // 2026-06-10 audit #4 — commit the streamed reply OUTSIDE any state
          // updater. The buffer is read from streamingRef (written
          // synchronously by the delta path below), so the commit is a plain
          // sibling setState and every updater stays pure.
          const buffered = p.streamingRef.current;
          if (buffered && e.messageId) {
            const messageId = e.messageId;
            p.setMessages((rows) =>
              rows.some((r) => r.id === messageId)
                ? rows
                : [
                    ...rows,
                    {
                      id: messageId,
                      role: 'assistant',
                      content: buffered.delta,
                      createdAt: Date.now(),
                    },
                  ],
            );
          }
          p.streamingRef.current = null;
          p.setStreaming(null);
        }
      } else if (e.kind === 'delta' && e.delta) {
        // Phase 6 — capture the (stable) messageId carried on the delta. It's
        // the SAME id the standby-commit will assign to the committed row, so
        // ChatTranscript can key the in-flight sentinel by it → React reuses
        // the DOM node across the commit → the bubble doesn't re-spring.
        const messageId = typeof e.messageId === 'string' ? e.messageId : null;
        // Accumulate against the ref (not a functional updater): the ref is
        // the synchronous source of truth, so a standby — or a second delta —
        // in the same tick sees the full buffer, and setStreaming receives a
        // VALUE (pure under StrictMode re-invocation).
        const prev = p.streamingRef.current;
        const next =
          !prev || prev.turnId !== e.turnId
            ? { turnId: e.turnId, delta: e.delta, messageId }
            : {
                turnId: prev.turnId,
                delta: prev.delta + e.delta,
                messageId: prev.messageId ?? messageId,
              };
        p.streamingRef.current = next;
        p.setStreaming(next);
      }
    });
    return off;
  }, []);
}
