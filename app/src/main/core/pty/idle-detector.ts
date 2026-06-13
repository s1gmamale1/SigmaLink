// app/src/main/core/pty/idle-detector.ts

export interface IdleDetectorOptions {
  /** Idle threshold in ms, read fresh each arm (so a KV change takes effect). */
  idleMs: () => number;
  /** Suppress an idle fire if a bell fired within this window (default 6000). */
  dedupeMs?: number;
  onIdle: (sessionId: string) => void;
  /** Injectable for tests. Defaults to setTimeout/clearTimeout/Date.now. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  now?: () => number;
}

/**
 * Per-session output-inactivity timer. `onData(id)` (re)arms; when a session
 * that was producing output goes silent for `idleMs`, `onIdle(id)` fires —
 * UNLESS a bell fired for that session within `dedupeMs` (the bell already
 * signalled attention). `noteBell(id)` records the bell and cancels the pending
 * idle fire.
 */
export class IdleDetector {
  private readonly timers = new Map<string, unknown>();
  private readonly lastBellAt = new Map<string, number>();
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly now: () => number;
  private readonly dedupeMs: number;
  private readonly opts: IdleDetectorOptions;

  constructor(opts: IdleDetectorOptions) {
    this.opts = opts;
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.now = opts.now ?? (() => Date.now());
    this.dedupeMs = opts.dedupeMs ?? 6000;
  }

  onData(sessionId: string): void {
    this.cancel(sessionId);
    const handle = this.setTimer(() => {
      this.timers.delete(sessionId);
      const bellAt = this.lastBellAt.get(sessionId) ?? Number.NEGATIVE_INFINITY;
      if (this.now() - bellAt > this.dedupeMs) this.opts.onIdle(sessionId);
    }, this.opts.idleMs());
    this.timers.set(sessionId, handle);
  }

  noteBell(sessionId: string): void {
    this.lastBellAt.set(sessionId, this.now());
    this.cancel(sessionId); // the bell already signalled — don't also idle-fire
  }

  forget(sessionId: string): void {
    this.cancel(sessionId);
    this.lastBellAt.delete(sessionId);
  }

  private cancel(sessionId: string): void {
    const handle = this.timers.get(sessionId);
    if (handle !== undefined) {
      this.clearTimer(handle);
      this.timers.delete(sessionId);
    }
  }
}
