// SF-7 — Task B1: per-workspace Ruflo HTTP daemon health hook.
//
// Polls `rpc.ruflo.daemonStatus(workspaceId)` every ~5 s (and once on mount)
// and maps the result to a normalised { state, detail } pair for the pane
// header health dot. Fail-safe: rejected RPC → 'unknown', never throws into
// the caller.
//
// PERF-5 (P5 Lane Poll) — refcounted shared poller. Before: every PaneHeader
// mounted its own 5 s interval calling `rpc.ruflo.daemonStatus`, so a workspace
// with N panes fired N identical RPCs every tick. After: a module-level
// singleton keyed by workspaceId runs ONE 5 s poll and fans the resolved health
// out to every subscriber; the hook only subscribes/unsubscribes (refcount).
// The interval is created on the first subscriber for a workspace and torn down
// when the last subscriber leaves. Mirrors the refcount/fan-out pattern in
// `src/renderer/lib/pty-data-bus.ts`. The hook's return shape is unchanged so
// PaneHeader is untouched.
//
// State mapping:
//   row.status === 'running'             → 'running'
//   row.status === 'crashed' | 'down'    → 'down'
//   row.status === 'starting'            → 'starting'
//   no row for this workspaceId          → 'fallback' (stdio MCP is active)
//   RPC error / unavailable              → 'unknown'

import { useCallback, useSyncExternalStore } from 'react';
import { rpcSilent } from '@/renderer/lib/rpc';

export type RufloDaemonState = 'running' | 'fallback' | 'down' | 'starting' | 'unknown';

export interface RufloDaemonHealth {
  state: RufloDaemonState;
  detail: string;
}

const POLL_INTERVAL_MS = 5_000;

const INITIAL_HEALTH: RufloDaemonHealth = { state: 'unknown', detail: 'checking…' };

function mapRow(row: {
  status: string;
  port: number;
  connections: number | null;
}): RufloDaemonHealth {
  switch (row.status) {
    case 'running':
      return {
        state: 'running',
        detail: `running · port ${row.port}${row.connections != null ? ` · ${row.connections} conn` : ''}`,
      };
    case 'crashed':
      return { state: 'down', detail: 'crashed — restart the workspace to recover' };
    case 'down':
      return { state: 'down', detail: 'daemon down' };
    case 'starting':
      return { state: 'starting', detail: 'starting…' };
    default:
      return { state: 'unknown', detail: `unknown status: ${row.status}` };
  }
}

// ── Refcounted per-workspace poller singleton ────────────────────────────────
//
// One entry per workspaceId. `subscribers` holds every hook callback; `last` is
// the most recent resolved health (so a late subscriber gets the cached value
// immediately rather than waiting a full tick). The interval lives only while
// `subscribers.size > 0`.

type HealthListener = (health: RufloDaemonHealth) => void;

interface PollerEntry {
  subscribers: Set<HealthListener>;
  intervalId: ReturnType<typeof setInterval> | null;
  last: RufloDaemonHealth;
  /** Monotonic token: a teardown bumps this so an in-flight poll for a torn-down
   *  entry can detect it lost the race and drop its result. */
  generation: number;
}

const pollers = new Map<string, PollerEntry>();

function emit(entry: PollerEntry, health: RufloDaemonHealth): void {
  entry.last = health;
  // Snapshot before dispatch so a subscriber that unsubscribes itself during
  // notification doesn't mutate the set we're iterating (mirrors pty-data-bus).
  for (const fn of Array.from(entry.subscribers)) fn(health);
}

async function pollWorkspace(workspaceId: string, entry: PollerEntry): Promise<void> {
  const gen = entry.generation;
  try {
    const rows = await rpcSilent.ruflo.daemonStatus(workspaceId);
    // The entry may have been torn down (last subscriber left) while the RPC was
    // in flight — drop the stale result rather than re-arming or emitting.
    if (entry.generation !== gen || entry.subscribers.size === 0) return;

    const row = rows.find((r) => r.workspaceId === workspaceId);
    if (!row) {
      emit(entry, { state: 'fallback', detail: 'stdio fallback — HTTP daemon unavailable' });
      return;
    }
    emit(entry, mapRow(row));
  } catch {
    if (entry.generation !== gen || entry.subscribers.size === 0) return;
    emit(entry, { state: 'unknown', detail: 'Ruflo MCP status unavailable' });
  }
}

/**
 * Subscribe to the shared per-workspace Ruflo health poller. Returns an
 * unsubscribe function. The interval is created on the first subscriber and
 * torn down when the last one leaves. The listener is a bare invalidation
 * callback (React's `useSyncExternalStore` re-reads the snapshot on notify).
 */
function subscribeRufloHealth(workspaceId: string, fn: HealthListener): () => void {
  let entry = pollers.get(workspaceId);
  if (!entry) {
    entry = {
      subscribers: new Set(),
      intervalId: null,
      last: INITIAL_HEALTH,
      generation: 0,
    };
    pollers.set(workspaceId, entry);
  }
  const wasEmpty = entry.subscribers.size === 0;
  entry.subscribers.add(fn);

  if (wasEmpty) {
    // First subscriber for this workspace — kick off an immediate poll + arm
    // the interval. A re-subscribe after dropping to zero bumps the generation
    // so any in-flight poll from the previous cycle is ignored.
    entry.generation += 1;
    void pollWorkspace(workspaceId, entry);
    entry.intervalId = setInterval(() => {
      void pollWorkspace(workspaceId, entry!);
    }, POLL_INTERVAL_MS);
  }

  const captured = entry;
  return () => {
    captured.subscribers.delete(fn);
    if (captured.subscribers.size === 0) {
      if (captured.intervalId != null) {
        clearInterval(captured.intervalId);
        captured.intervalId = null;
      }
      // Invalidate any in-flight poll and drop the entry so a future
      // subscriber starts from a clean slate.
      captured.generation += 1;
      pollers.delete(workspaceId);
    }
  };
}

/** Current cached health for a workspace (the external-store snapshot). */
function getRufloSnapshot(workspaceId: string): RufloDaemonHealth {
  return pollers.get(workspaceId)?.last ?? INITIAL_HEALTH;
}

/**
 * Returns the live health of the Ruflo HTTP daemon for the given workspace.
 *
 * Backed by a single refcounted per-workspace poller (an external store read
 * via `useSyncExternalStore`): N panes in one workspace share ONE 5 s interval
 * / one RPC per tick. The interval is created on the first pane and torn down
 * when the last pane for the workspace unmounts. Never throws.
 */
export function useRufloDaemonHealth(workspaceId: string): RufloDaemonHealth {
  const subscribe = useCallback(
    (onStoreChange: () => void) => subscribeRufloHealth(workspaceId, onStoreChange),
    [workspaceId],
  );
  const getSnapshot = useCallback(() => getRufloSnapshot(workspaceId), [workspaceId]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Test-only helper. Resets the module-level poller singleton between tests so
 * each `describe` block starts from a clean slate. Not referenced by any
 * production code path.
 */
export function __resetRufloHealthPollers(): void {
  for (const entry of pollers.values()) {
    if (entry.intervalId != null) clearInterval(entry.intervalId);
  }
  pollers.clear();
}
