// PERF-1 — coalesce per-session `pty:data` chunks into one IPC send per ~flushMs.
//
// The PtyRegistry emits one chunk per OS read (~50/s/pane); each was previously a
// separate `webContents.send` (a structured-clone IPC) → the hottest path in the
// app under streaming output across N panes. This buffers per session and flushes
// on a short timer (< one 16ms frame), or immediately when a session's buffer
// exceeds `maxBytes` so big pastes/bursts aren't delayed.
//
// Only the renderer BROADCAST is coalesced — the ring buffer + OSC8/link detection
// still run per raw chunk inside the registry (snapshot fidelity + link timing are
// untouched). xterm `.write()` and the renderer `pty-data-bus` accept concatenated
// strings unchanged, so the renderer needs no change.
//
// The shell-first CLI-exit sentinel is stripped inside the registry BEFORE the data
// callback, so it never rides `pty:data` — coalescing cannot delay/corrupt exit
// detection. Callers should still `flush(sessionId)` right before broadcasting that
// session's `pty:exit` so trailing output lands before the renderer's exit line.

export interface PtyDataCoalescerDeps {
  /** Sends one coalesced chunk for a session (= `broadcast('pty:data', …)`). */
  emit: (sessionId: string, data: string) => void;
  /** Flush interval in ms. Default 12 (under one 16ms frame). */
  flushMs?: number;
  /** Per-session size cap (chars) that forces an immediate flush. Default 64 KiB. */
  maxBytes?: number;
  /** Timer scheduler — injectable for deterministic tests. Defaults to setTimeout. */
  schedule?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  cancel?: (handle: ReturnType<typeof setTimeout>) => void;
}

export class PtyDataCoalescer {
  private readonly emit: (sessionId: string, data: string) => void;
  private readonly flushMs: number;
  private readonly maxBytes: number;
  private readonly schedule: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly cancel: (handle: ReturnType<typeof setTimeout>) => void;
  private readonly buffers = new Map<string, string>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(deps: PtyDataCoalescerDeps) {
    this.emit = deps.emit;
    this.flushMs = deps.flushMs ?? 12;
    this.maxBytes = deps.maxBytes ?? 64 * 1024;
    this.schedule = deps.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    this.cancel = deps.cancel ?? ((handle) => clearTimeout(handle));
  }

  /** Buffer a chunk; arm the shared flush timer (or flush now on a big burst). */
  push(sessionId: string, data: string): void {
    if (typeof data !== 'string' || data.length === 0) return;
    const next = (this.buffers.get(sessionId) ?? '') + data;
    this.buffers.set(sessionId, next);
    if (next.length >= this.maxBytes) {
      this.flush(sessionId); // big burst — don't make it wait the timer
      return;
    }
    if (this.timer === null) {
      this.timer = this.schedule(() => {
        this.timer = null;
        this.flushAll();
      }, this.flushMs);
    }
  }

  /** Flush one session's pending buffer immediately (e.g. before its `pty:exit`). */
  flush(sessionId: string): void {
    const data = this.buffers.get(sessionId);
    this.buffers.delete(sessionId);
    if (data !== undefined && data.length > 0) this.emit(sessionId, data);
  }

  private flushAll(): void {
    if (this.buffers.size === 0) return;
    // Snapshot keys first — emit() is foreign code and could, in theory, re-enter.
    for (const id of [...this.buffers.keys()]) this.flush(id);
  }

  /** Stop the timer + flush everything (router shutdown). */
  dispose(): void {
    if (this.timer !== null) {
      this.cancel(this.timer);
      this.timer = null;
    }
    this.flushAll();
  }
}
