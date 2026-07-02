// app/src/main/core/pty/attention-detector.ts
import { BellScanner } from './bell-scanner';
import { IdleDetector } from './idle-detector';

export type AttentionReason = 'bell' | 'idle';

export interface AttentionDetectorOptions {
  idleMs: () => number;
  emit: (sessionId: string, reason: AttentionReason) => void;
  dedupeMs?: number;
  /** 2026-07-02 fix D — per-session eligibility gate. Return false for
   *  sessions that must never produce attention (plain shell / scratch /
   *  Dev-workspace panes — previously `ls` chimed "agent needs you" 4s after
   *  its output settled). Omitted = every session eligible. A throwing gate
   *  fails CLOSED (no phantom attention from a broken lookup). */
  isEligible?: (sessionId: string) => boolean;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  now?: () => number;
}

/**
 * Per-session bell + idle attention detection. Feed the (sentinel-stripped) PTY
 * data stream; `emit` fires once per detected "agent is now waiting" event.
 */
export class AttentionDetector {
  private readonly scanners = new Map<string, BellScanner>();
  private readonly idle: IdleDetector;
  private readonly opts: AttentionDetectorOptions;
  private readonly lastAttn = new Map<string, { ts: number; reason: AttentionReason }>();

  // NOTE: TS `erasableSyntaxOnly` — no constructor parameter properties.
  constructor(opts: AttentionDetectorOptions) {
    this.opts = opts;
    this.idle = new IdleDetector({
      idleMs: opts.idleMs,
      dedupeMs: opts.dedupeMs,
      onIdle: (sessionId) => { this.record(sessionId, 'idle'); opts.emit(sessionId, 'idle'); },
      setTimer: opts.setTimer,
      clearTimer: opts.clearTimer,
      now: opts.now,
    });
  }

  private nowMs(): number { return (this.opts.now ?? Date.now)(); }

  private record(sessionId: string, reason: AttentionReason): void {
    this.lastAttn.set(sessionId, { ts: this.nowMs(), reason });
  }

  feed(sessionId: string, data: string): void {
    // fix D — ineligible sessions (shell/scratch panes) are never scanned and
    // never arm the idle timer. Fail closed on a throwing gate.
    try {
      if (this.opts.isEligible && !this.opts.isEligible(sessionId)) return;
    } catch {
      return;
    }
    let scanner = this.scanners.get(sessionId);
    if (!scanner) {
      scanner = new BellScanner();
      this.scanners.set(sessionId, scanner);
    }
    const bells = scanner.feed(data);
    if (bells > 0) {
      this.idle.noteBell(sessionId);
      this.record(sessionId, 'bell');
      this.opts.emit(sessionId, 'bell');
    }
    this.idle.onData(sessionId);
  }

  forget(sessionId: string): void {
    this.scanners.delete(sessionId);
    this.idle.forget(sessionId);
    this.lastAttn.delete(sessionId);
  }

  lastAttention(sessionId: string): { ts: number; reason: AttentionReason } | null {
    return this.lastAttn.get(sessionId) ?? null;
  }

  snapshot(): ReadonlyMap<string, { ts: number; reason: AttentionReason }> {
    return new Map(this.lastAttn);
  }
}
