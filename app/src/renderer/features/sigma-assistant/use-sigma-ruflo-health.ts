import { useEffect, useRef, useState } from 'react';
import { rpcSilent, onEvent } from '@/renderer/lib/rpc';

interface RufloHealthEvent {
  state: 'absent' | 'starting' | 'ready' | 'degraded' | 'down';
}

export interface UseSigmaRufloHealthReturn {
  rufloReady: boolean;
  rufloReadyRef: React.MutableRefObject<boolean>;
}

/** Phase 4 Track C — track Ruflo health. */
export function useSigmaRufloHealth(): UseSigmaRufloHealthReturn {
  const [rufloReady, setRufloReady] = useState(false);
  const rufloReadyRef = useRef(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const h = await rpcSilent.ruflo.health();
        if (alive) {
          setRufloReady(h.state === 'ready');
          rufloReadyRef.current = h.state === 'ready';
        }
      } catch {
        /* main-process method missing — keep default false */
      }
    })();
    const off = onEvent<RufloHealthEvent>('ruflo:health', (e) => {
      const ready = e?.state === 'ready';
      setRufloReady(ready);
      rufloReadyRef.current = ready;
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  return { rufloReady, rufloReadyRef };
}
