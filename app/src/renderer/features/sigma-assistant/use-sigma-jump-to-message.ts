import { useEffect } from 'react';
import { rpc } from '@/renderer/lib/rpc';
import { KV_ACTIVE_CONVERSATION } from './use-sigma-conversations';

export interface UseSigmaJumpToMessageArgs {
  conversationId: string | null;
  hydrateConversation: (id: string) => Promise<void>;
  transcriptRef: React.MutableRefObject<HTMLDivElement | null>;
}

/** P3-S7 — External jump-to-message hook. The Operator Console fires a
 *  `sigma:bridge-jump-to-message` window event after switching the room
 *  back to `bridge`; we hydrate the requested conversation (if it isn't
 *  already active) and scroll the matching `[data-message-id]` element
 *  into view. */
export function useSigmaJumpToMessage({
  conversationId,
  hydrateConversation,
  transcriptRef,
}: UseSigmaJumpToMessageArgs): void {
  useEffect(() => {
    const handler = (raw: Event) => {
      const ev = raw as CustomEvent<{ conversationId: string; messageId?: string }>;
      const detail = ev.detail;
      if (!detail || typeof detail.conversationId !== 'string') return;
      void (async () => {
        if (detail.conversationId !== conversationId) {
          await hydrateConversation(detail.conversationId);
          try {
            await rpc.kv.set(KV_ACTIVE_CONVERSATION, detail.conversationId);
          } catch {
            /* best-effort */
          }
        }
        if (detail.messageId) {
          requestAnimationFrame(() => {
            const root = transcriptRef.current ?? document;
            const el = root.querySelector<HTMLElement>(
              `[data-message-id="${detail.messageId}"]`,
            );
            if (el) {
              el.scrollIntoView({ behavior: 'smooth', block: 'center' });
              el.classList.add('ring-2', 'ring-primary/60');
              window.setTimeout(
                () => el.classList.remove('ring-2', 'ring-primary/60'),
                1500,
              );
            }
          });
        }
      })();
    };
    window.addEventListener('sigma:sigma-jump-to-message', handler);
    return () => window.removeEventListener('sigma:sigma-jump-to-message', handler);
    // transcriptRef is a stable ref — no need to re-subscribe when it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, hydrateConversation]);
}
