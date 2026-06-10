// perf-hot-paths Task 2 — generic refcounted shared poller with visibility
// pause: the PERF-6 pattern from use-git-status-poll.ts / use-git-activity-
// poll.ts extracted ONCE. One module-level poller per data source; entries
// keyed by string (repo path, session id, …). The interval exists only while
// ≥1 subscriber holds the key, pauses while document.hidden (immediate
// refresh + re-arm on return), and never stacks overlapping fetches
// (in-flight guard — subsumes the jorvis-renderer-fixes overlap stopgap).
// Listeners are bare invalidation callbacks for useSyncExternalStore.

export interface SharedPollerOptions<T> {
  intervalMs: number;
  fetch: (key: string) => Promise<T>;
  /**
   * Phase-offset the recurring tick per key (deterministic FNV-1a hash of the
   * key, range (0, intervalMs)) so N keys don't land their fetches in one
   * synchronized burst (git spawn storms with worktree-per-pane).
   */
  staggerPhase?: boolean;
}

export interface SharedPoller<T> {
  subscribe(key: string, onStoreChange: () => void): () => void;
  getSnapshot(key: string): T | null;
  /** Test-only: tear down all entries + the shared visibility listener. */
  __reset(): void;
}

interface Entry<T> {
  subscribers: Set<() => void>;
  timeoutId: ReturnType<typeof setTimeout> | null;
  intervalId: ReturnType<typeof setInterval> | null;
  last: T | null;
  generation: number;
  inFlight: boolean;
}

function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

function docHidden(): boolean {
  return typeof document !== 'undefined' && document.hidden;
}

export function createSharedPoller<T>(opts: SharedPollerOptions<T>): SharedPoller<T> {
  const entries = new Map<string, Entry<T>>();
  let visibilityInstalled = false;

  async function poll(key: string, entry: Entry<T>): Promise<void> {
    if (entry.inFlight) return; // overlap guard — never stack fetches
    entry.inFlight = true;
    const gen = entry.generation;
    try {
      const value = await opts.fetch(key);
      // Entry may have been torn down while the fetch was in flight — drop
      // the stale result rather than emitting into nobody.
      if (entry.generation !== gen || entry.subscribers.size === 0) return;
      entry.last = value;
      // Snapshot before dispatch so a subscriber that unsubscribes itself
      // during notification doesn't mutate the set we're iterating.
      for (const fn of Array.from(entry.subscribers)) fn();
    } catch {
      // Degrade quietly — keep the last good value.
    } finally {
      if (entry.generation === gen) entry.inFlight = false;
    }
  }

  function clearTimers(entry: Entry<T>): void {
    if (entry.timeoutId != null) {
      clearTimeout(entry.timeoutId);
      entry.timeoutId = null;
    }
    if (entry.intervalId != null) {
      clearInterval(entry.intervalId);
      entry.intervalId = null;
    }
  }

  function arm(key: string, entry: Entry<T>): void {
    if (entry.timeoutId != null || entry.intervalId != null) return; // armed
    if (docHidden()) return; // re-armed by the visibility handler
    const startInterval = (): void => {
      entry.intervalId = setInterval(() => {
        void poll(key, entry);
      }, opts.intervalMs);
    };
    if (opts.staggerPhase) {
      // First recurring tick at a per-key phase in (0, intervalMs); every
      // subsequent tick at intervalMs. Deterministic per key.
      const offset = (fnv1a(key) % (opts.intervalMs - 1)) + 1;
      entry.timeoutId = setTimeout(() => {
        entry.timeoutId = null;
        void poll(key, entry);
        startInterval();
      }, offset);
    } else {
      startInterval();
    }
  }

  function handleVisibility(): void {
    if (docHidden()) {
      for (const entry of entries.values()) clearTimers(entry);
      return;
    }
    for (const [key, entry] of entries.entries()) {
      if (entry.subscribers.size === 0) continue;
      void poll(key, entry);
      arm(key, entry);
    }
  }

  function installVisibilityOnce(): void {
    if (visibilityInstalled || typeof document === 'undefined') return;
    document.addEventListener('visibilitychange', handleVisibility);
    visibilityInstalled = true;
  }

  return {
    subscribe(key, onStoreChange) {
      installVisibilityOnce();
      let entry = entries.get(key);
      if (!entry) {
        entry = {
          subscribers: new Set(),
          timeoutId: null,
          intervalId: null,
          last: null,
          generation: 0,
          inFlight: false,
        };
        entries.set(key, entry);
      }
      const wasEmpty = entry.subscribers.size === 0;
      entry.subscribers.add(onStoreChange);
      if (wasEmpty) {
        entry.generation += 1;
        entry.inFlight = false;
        if (!docHidden()) void poll(key, entry);
        arm(key, entry);
      }
      const captured = entry;
      return () => {
        captured.subscribers.delete(onStoreChange);
        if (captured.subscribers.size === 0) {
          clearTimers(captured);
          captured.generation += 1;
          entries.delete(key);
        }
      };
    },
    getSnapshot(key) {
      return entries.get(key)?.last ?? null;
    },
    __reset() {
      for (const entry of entries.values()) clearTimers(entry);
      entries.clear();
      if (visibilityInstalled && typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibility);
      }
      visibilityInstalled = false;
    },
  };
}
