// src/main/core/pty/prompt-sink.ts
//
// Main-side watcher: scans raw PTY chunks (fed from PtyRegistry.onData) for
// SIGMA::PROMPT protocol lines and tracks idle/exit, so a main-process tool
// (wait_for_pane) can block until a pane needs input / settles / exits.
// Reuses the node-safe parser in ../swarms/protocol (NO electron/DB import).

import {
  ProtocolLineBuffer,
  parseProtocolLine,
  isPromptPayload,
  type PromptPayload,
} from '../swarms/protocol';

export type PaneWaitReason = 'prompt' | 'idle' | 'exit' | 'timeout';

export interface PaneWaitResult {
  sessionId: string | null; // null only for reason:'timeout'
  reason: PaneWaitReason;
  prompt?: PromptPayload;
}

interface Waiter {
  sessionIds: Set<string>;
  until: 'prompt' | 'idle' | 'exit';
  idleMs: number;
  resolve: (r: PaneWaitResult) => void;
  timer: ReturnType<typeof setTimeout>;
  idleTimers: Map<string, ReturnType<typeof setTimeout>>;
}

interface SessionState {
  buf: ProtocolLineBuffer;
  lastPrompt: PromptPayload | null;
}

export class PromptSink {
  private readonly sessions = new Map<string, SessionState>();
  private readonly waiters = new Set<Waiter>();

  feed(sessionId: string, data: string): void {
    let st = this.sessions.get(sessionId);
    if (!st) {
      st = { buf: new ProtocolLineBuffer(), lastPrompt: null };
      this.sessions.set(sessionId, st);
    }
    // Any data resets idle timers for waiters watching this session.
    for (const w of this.waiters) {
      if (w.until === 'idle' && w.sessionIds.has(sessionId)) this.armIdle(w, sessionId);
    }
    st.buf.push(data, (line) => {
      const parsed = parseProtocolLine(line);
      if (!parsed || parsed.verb !== 'PROMPT' || !isPromptPayload(parsed.payload)) return;
      st!.lastPrompt = parsed.payload;
      this.fire(sessionId, { sessionId, reason: 'prompt', prompt: parsed.payload });
    });
  }

  noteExit(sessionId: string): void {
    // Exit is terminal: settle EVERY waiter watching this session, regardless of
    // `until` (a dead pane will never prompt or settle meaningfully — a
    // prompt-waiter must learn the pane died instead of hanging to timeout).
    // First terminal event among a wait-for-any set wins.
    for (const w of [...this.waiters]) {
      if (w.sessionIds.has(sessionId)) this.settle(w, { sessionId, reason: 'exit' });
    }
    this.sessions.delete(sessionId);
  }

  wait(opts: {
    sessionIds: string[];
    until: 'prompt' | 'idle' | 'exit';
    timeoutMs: number;
    idleMs?: number;
  }): Promise<PaneWaitResult> {
    return new Promise<PaneWaitResult>((resolve) => {
      const w: Waiter = {
        sessionIds: new Set(opts.sessionIds),
        until: opts.until,
        idleMs: opts.idleMs ?? 800,
        resolve,
        timer: setTimeout(() => this.settle(w, { sessionId: null, reason: 'timeout' }), opts.timeoutMs),
        idleTimers: new Map(),
      };
      this.waiters.add(w);
      if (opts.until === 'idle') for (const id of opts.sessionIds) this.armIdle(w, id);
    });
  }

  private armIdle(w: Waiter, sessionId: string): void {
    const prev = w.idleTimers.get(sessionId);
    if (prev) clearTimeout(prev);
    w.idleTimers.set(
      sessionId,
      setTimeout(() => this.settle(w, { sessionId, reason: 'idle' }), w.idleMs),
    );
  }

  private fire(sessionId: string, result: PaneWaitResult): void {
    // Only prompt-waiters wake on a SIGMA::PROMPT (idle/exit have their own paths).
    for (const w of [...this.waiters]) {
      if (w.until === 'prompt' && w.sessionIds.has(sessionId)) this.settle(w, result);
    }
  }

  private settle(w: Waiter, result: PaneWaitResult): void {
    if (!this.waiters.has(w)) return;
    this.waiters.delete(w);
    clearTimeout(w.timer);
    for (const t of w.idleTimers.values()) clearTimeout(t);
    w.resolve(result);
  }
}
