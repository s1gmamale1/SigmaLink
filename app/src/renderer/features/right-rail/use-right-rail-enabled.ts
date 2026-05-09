// Hook hosting the kv-backed `rightRail.enabled` toggle.
//
// Lives in its own file so `RightRail.tsx` only exports React components
// (Vite/react-refresh forbids mixing component + hook exports in one file).

import { useEffect, useState } from 'react';
import { rpcSilent } from '@/renderer/lib/rpc';

const KV_ENABLED = 'rightRail.enabled';

/**
 * Reads `kv['rightRail.enabled']` once on mount. Default is ON when the key
 * has never been written; the dock owner falls back to the legacy
 * single-column layout while the kv read is in flight, so the rail does not
 * flash open + closed on first paint.
 */
export function useRightRailEnabled(): { enabled: boolean; ready: boolean } {
  const [enabled, setEnabled] = useState(false);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const raw = await rpcSilent.kv.get(KV_ENABLED);
        if (!alive) return;
        setEnabled(raw === null || raw === undefined ? true : raw === '1');
      } catch {
        if (alive) setEnabled(true);
      } finally {
        if (alive) setReady(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);
  return { enabled, ready };
}
