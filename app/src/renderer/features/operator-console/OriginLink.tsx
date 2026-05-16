// P3-S7 — Sigma → swarm cross-link banner.
//
// When a swarm was created via the Sigma Assistant `create_swarm` tool, the
// main process writes a row to `swarm_origins`. This widget reads that row
// for the active swarm and renders a single-line link: clicking it switches
// the active room back to `sigma`, asks SigmaRoom to load the originating
// conversation, and scrolls to the exact tool-call message that produced
// the swarm. When no origin row exists the component renders nothing — the
// Operator Console swarm-room view is unchanged for swarms created via the
// Swarm Room directly.

import { useEffect, useState } from 'react';
import { MessageCircle } from 'lucide-react';
import { useAppState } from '@/renderer/app/state';

interface SwarmOriginPayload {
  swarmId: string;
  conversationId: string;
  messageId: string;
  createdAt: number;
}

interface Props {
  swarmId: string | null;
}

async function fetchOrigin(swarmId: string): Promise<SwarmOriginPayload | null> {
  if (!('sigma' in window)) return null;
  try {
    const env = (await window.sigma.invoke('swarm.origin.get', { swarmId })) as
      | { ok: true; data: SwarmOriginPayload | null }
      | { ok: false; error: string };
    if (env && 'ok' in env && env.ok) return env.data ?? null;
  } catch {
    /* fall through to null */
  }
  return null;
}

export function OriginLink({ swarmId }: Props) {
  const { dispatch } = useAppState();
  const [origin, setOrigin] = useState<SwarmOriginPayload | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      if (!swarmId) {
        if (alive) setOrigin(null);
        return;
      }
      const o = await fetchOrigin(swarmId);
      if (alive) setOrigin(o);
    })();
    return () => {
      alive = false;
    };
  }, [swarmId]);

  if (!origin) return null;

  const stamp = new Date(origin.createdAt).toLocaleString();

  const onJump = () => {
    // 1) Switch the room. 2) Notify SigmaRoom via a window event so it
    //    hydrates the right conversation + scrolls to the message.
    dispatch({ type: 'SET_ROOM', room: 'sigma' });
    try {
      window.dispatchEvent(
        new CustomEvent('sigma:bridge-jump-to-message', {
          detail: {
            conversationId: origin.conversationId,
            messageId: origin.messageId,
          },
        }),
      );
    } catch {
      /* ignore */
    }
  };

  return (
    <button
      type="button"
      onClick={onJump}
      data-testid="bridge-origin-link"
      className="flex shrink-0 items-center gap-2 border-b border-border bg-primary/5 px-3 py-1.5 text-left text-[11px] text-muted-foreground transition hover:bg-primary/10 hover:text-foreground"
    >
      <MessageCircle className="h-3 w-3 text-primary" aria-hidden />
      <span>
        Started from{' '}
        <span className="font-medium text-foreground">Sigma Assistant chat</span>
        {' · '}
        <span className="tabular-nums">{stamp}</span>
      </span>
      <span className="ml-auto text-[10px] uppercase tracking-wider text-primary/80">
        Open chat
      </span>
    </button>
  );
}
