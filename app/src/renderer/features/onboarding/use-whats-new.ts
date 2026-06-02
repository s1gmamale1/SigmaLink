// ONB-1 — "What's new" toast. On mount (once the UI has booted and the user
// has finished onboarding), compare the running app version against the last
// version the user saw (`kv['app.lastSeenVersion']`). On an upgrade, surface a
// single informational toast with an action that opens the Updates tab. The
// last-seen version is then written so the toast fires only once per upgrade.
//
// First-run skip: on a fresh install `kv['app.lastSeenVersion']` is `null`. We
// MUST NOT toast in that case — the Feature Spotlight already greets new users,
// and "What's new in v…" makes no sense before they've seen any version. We
// still persist the current version so the NEXT upgrade is detected correctly.

import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { rpc, rpcSilent } from '@/renderer/lib/rpc';
import { useAppState } from '@/renderer/app/state';

const LAST_SEEN_KEY = 'app.lastSeenVersion';

export { LAST_SEEN_KEY };

/**
 * Surfaces the "What's new" toast exactly once per detected upgrade. Gated on
 * `uiBoot && onboarded` so it never races the onboarding modal or fires before
 * boot kv is hydrated. Runs its check a single time per mount (a ref guard) so
 * an unrelated re-render of the host component doesn't re-toast.
 */
export function useWhatsNew(): void {
  const { state, dispatch } = useAppState();
  const { uiBoot, onboarded } = state;
  const ranRef = useRef(false);

  useEffect(() => {
    // Gate: only after the UI has booted (kv hydrated) AND onboarding is done.
    if (!uiBoot || !onboarded) return;
    if (ranRef.current) return;
    ranRef.current = true;

    let alive = true;
    void (async () => {
      try {
        const current = await rpc.app.getVersion();
        // Silent read: a missing key is the first-run signal, not an error.
        const last = await rpcSilent.kv.get(LAST_SEEN_KEY).catch(() => null);
        if (!alive) return;

        // First run (no stored version) → skip the toast, just seed the key.
        // Upgrade (stored !== current) → toast once, then persist current.
        // Same version → nothing to do.
        if (last !== null && last !== current) {
          toast.info(`What's new in v${current}`, {
            description: 'See the latest improvements and fixes in this release.',
            action: {
              label: 'View',
              onClick: () => dispatch({ type: 'SET_ROOM', room: 'settings' }),
            },
          });
        }
        if (last !== current) {
          void rpc.kv.set(LAST_SEEN_KEY, current).catch(() => undefined);
        }
      } catch {
        // Version lookup failed (very early boot / preload gap) — allow a retry
        // on a later mount by resetting the guard.
        if (alive) ranRef.current = false;
      }
    })();

    return () => {
      alive = false;
    };
  }, [uiBoot, onboarded, dispatch]);
}
