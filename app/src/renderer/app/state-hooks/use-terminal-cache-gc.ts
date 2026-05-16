// V1.4.2 packet-03 (Layer 2): garbage-collect the renderer-side terminal
// cache when sessions disappear from app state.
//
// The cache in `src/renderer/lib/terminal-cache.ts` keeps live `Terminal`
// instances around across React unmounts so panes survive room and
// workspace switches without losing scrollback. But once a session is
// permanently gone — either the user explicitly closed the pane or the
// 5s exited-grace timer in `use-exited-session-gc` fired — the cached
// entry is dead weight that should be disposed.
//
// We can't put this logic inside `<SessionTerminal>` itself because the
// component will have already unmounted by the time REMOVE_SESSION
// dispatches. Instead this hook lives next to the state provider and
// watches the live sessions list across all workspaces: any sessionId
// present in the cache but absent from state gets destroyed.

import { useEffect, useRef } from 'react';
import type { AppState } from '../state.types';
import { destroy, hasCached } from '@/renderer/lib/terminal-cache';

export function useTerminalCacheGc(state: AppState): void {
  // Track every sessionId we've seen so a one-shot vanishing (session was
  // present in a previous render, gone in the current one) triggers a
  // cache destroy. Set-of-strings instead of comparing arrays so we don't
  // pay an O(n^2) diff cost on workspaces with many panes.
  const everSeen = useRef<Set<string>>(new Set());

  useEffect(() => {
    const seenNow = new Set<string>();
    // Walk every per-workspace session list. The flat `state.sessions`
    // array exists too, but the per-workspace map is the source of truth
    // GridLayout / SessionTerminal subscribe to.
    for (const list of Object.values(state.sessionsByWorkspace)) {
      for (const session of list) seenNow.add(session.id);
    }
    for (const session of state.sessions) seenNow.add(session.id);

    // Anything in everSeen but not in seenNow disappeared this tick;
    // dispose its cache entry (if any).
    for (const id of everSeen.current) {
      if (!seenNow.has(id) && hasCached(id)) destroy(id);
    }
    // Persist the merged set for next-tick diff. We only ADD here; once
    // a session id has appeared once we keep tracking it until it's gone.
    for (const id of seenNow) everSeen.current.add(id);
    // Prune ids that are gone from both seenNow and the cache — they've
    // already been GC'd in a prior tick and no longer need tracking.
    for (const id of Array.from(everSeen.current)) {
      if (!seenNow.has(id) && !hasCached(id)) everSeen.current.delete(id);
    }
  }, [state.sessionsByWorkspace, state.sessions]);
}
