import { useEffect, useRef } from 'react';
import { rpc } from '@/renderer/lib/rpc';
import { KV_ACTIVE_CONVERSATION } from './use-jorvis-conversations';

export interface UseJorvisJumpToMessageArgs {
  conversationId: string | null;
  hydrateConversation: (id: string) => Promise<void>;
  transcriptRef: React.MutableRefObject<HTMLDivElement | null>;
}

/** How many frames to keep re-querying for the target row. The hydrate
 *  commit can flush a frame (or several, under load) AFTER the first rAF
 *  fires; a single-frame query silently no-scrolls (2026-06-10 audit #3). */
const MAX_HIGHLIGHT_FRAMES = 10;
const HIGHLIGHT_CLASSES = ['ring-2', 'ring-primary/60'] as const;
const HIGHLIGHT_MS = 1_500;

/** P3-S7 — External jump-to-message hook. The Operator Console fires a
 *  `jorvis:jump-to-message` window event after switching the room
 *  back to `jorvis`; we hydrate the requested conversation (if it isn't
 *  already active) and scroll the matching `[data-message-id]` element
 *  into view, retrying across frames until the commit lands. */
export function useJorvisJumpToMessage({
  conversationId,
  hydrateConversation,
  transcriptRef,
}: UseJorvisJumpToMessageArgs): void {
  // The handler reads the ACTIVE conversation through a ref so the event
  // subscription never re-subscribes mid-jump — the jump's own hydrate
  // CHANGES `conversationId`, and a dep'd-effect cleanup on that change
  // would cancel the in-flight highlight retry chain below.
  const conversationIdRef = useRef(conversationId);
  useEffect(() => {
    conversationIdRef.current = conversationId;
  }, [conversationId]);

  // Pending rAF + highlight-removal timer handles. Cancelled on unmount so a
  // dangling 1.5s timer can't hold a detached transcript node alive, and on a
  // superseding jump so two highlight loops never race.
  const pendingRef = useRef<{ raf: number | null; timer: number | null }>({
    raf: null,
    timer: null,
  });

  useEffect(() => {
    const pending = pendingRef.current;

    const tryHighlight = (messageId: string, attempt: number): void => {
      pending.raf = null;
      const root = transcriptRef.current ?? document;
      const el = root.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`);
      if (!el) {
        // The hydrate commit may not have flushed yet — retry next frame.
        if (attempt < MAX_HIGHLIGHT_FRAMES) {
          pending.raf = requestAnimationFrame(() => tryHighlight(messageId, attempt + 1));
        }
        return;
      }
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add(...HIGHLIGHT_CLASSES);
      pending.timer = window.setTimeout(() => {
        pending.timer = null;
        el.classList.remove(...HIGHLIGHT_CLASSES);
      }, HIGHLIGHT_MS);
    };

    const handler = (raw: Event) => {
      const ev = raw as CustomEvent<{ conversationId: string; messageId?: string }>;
      const detail = ev.detail;
      if (!detail || typeof detail.conversationId !== 'string') return;
      void (async () => {
        if (detail.conversationId !== conversationIdRef.current) {
          await hydrateConversation(detail.conversationId);
          try {
            await rpc.kv.set(KV_ACTIVE_CONVERSATION, detail.conversationId);
          } catch {
            /* best-effort */
          }
        }
        if (detail.messageId) {
          const messageId = detail.messageId;
          // A new jump supersedes any in-flight retry/highlight.
          if (pending.raf !== null) cancelAnimationFrame(pending.raf);
          if (pending.timer !== null) window.clearTimeout(pending.timer);
          pending.raf = requestAnimationFrame(() => tryHighlight(messageId, 0));
        }
      })();
    };

    window.addEventListener('jorvis:jump-to-message', handler);
    return () => {
      window.removeEventListener('jorvis:jump-to-message', handler);
      if (pending.raf !== null) {
        cancelAnimationFrame(pending.raf);
        pending.raf = null;
      }
      if (pending.timer !== null) {
        window.clearTimeout(pending.timer);
        pending.timer = null;
      }
    };
    // `transcriptRef` is a stable ref prop; `conversationId` rides
    // conversationIdRef so this subscription survives the jump's own hydrate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrateConversation]);
}
