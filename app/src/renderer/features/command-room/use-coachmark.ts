/**
 * use-coachmark — tiny hook that reads/writes a KV "seen" flag so one-time
 * coachmarks can be shown once and then permanently dismissed.
 *
 * Usage:
 *   const { seen, markSeen } = useCoachmark('coachmark.dragGrip.seen');
 */
import { useEffect, useState, useCallback } from 'react';
import { rpc, rpcSilent } from '@/renderer/lib/rpc';

export interface CoachmarkState {
  /** true once the KV lookup has resolved (either seen or unseen). */
  loaded: boolean;
  /** true if the user has already seen this coachmark. */
  seen: boolean;
  /** Call once to permanently dismiss the coachmark. */
  markSeen: () => void;
}

export function useCoachmark(key: string): CoachmarkState {
  const [loaded, setLoaded] = useState(false);
  const [seen, setSeen] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const v = await rpcSilent.kv.get(key);
        if (!alive) return;
        setSeen(v === '1' || v === 'true');
      } catch {
        // Treat errors as unseen so the coachmark still appears.
        if (alive) setSeen(false);
      } finally {
        if (alive) setLoaded(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [key]);

  const markSeen = useCallback(() => {
    setSeen(true);
    void rpc.kv.set(key, '1').catch(() => undefined);
  }, [key]);

  return { loaded, seen, markSeen };
}
