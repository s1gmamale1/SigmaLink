// Session registry: keeps PtyHandle + ring buffer per session id, fans data to
// all subscribed renderers via the shared event bus.
//
// Lifecycle:
//   create() → record alive=true.
//   onExit (from PTY) → record alive=false, broadcast pty:exit, then schedule a
//     gracefulExitDelayMs delay before forgetting so the renderer's last data
//     drain (and any subscribe-late history pull) is not lost.
//   forget() → unsubscribes data/exit listeners and removes the record.
//   killAll() → ask every record to die; called from app `before-quit`.

import { randomUUID } from 'node:crypto';
import { spawnLocalPty, type PtyHandle, type SpawnInput } from './local-pty';
import { RingBuffer } from './ring-buffer';
import { detectLinks, type LinkHit } from './link-detector';
import {
  extractSessionIdFromLine,
  type SessionIdExtraction,
} from './session-id-extractor';

/** Milliseconds between SIGTERM and the fallback SIGKILL on lingering PTYs. */
const PTY_KILL_FALLBACK_MS = 5_000;

/**
 * Probe whether a PID is still resident in the OS process table.
 *
 * `process.kill(pid, 0)` does not deliver a signal — it just performs the
 * permission/existence check. ESRCH means "no such process"; EPERM means the
 * process exists but we lack permission (still alive). Any other error we
 * treat as "unknown" → assume gone to avoid runaway SIGKILL loops.
 */
function isProcessAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM') return true;
    return false;
  }
}

export interface SessionRecord {
  id: string;
  providerId: string;
  cwd: string;
  pid: number;
  alive: boolean;
  exitCode?: number;
  startedAt: number;
  exitedAt?: number;
  externalSessionId?: string;
  pty: PtyHandle;
  buffer: RingBuffer;
  unsubData: () => void;
  unsubExit: () => void;
}

export type DataSink = (sessionId: string, data: string) => void;
export type ExitSink = (sessionId: string, exitCode: number, signal?: number) => void;
export type LinkSink = (sessionId: string, hit: LinkHit) => void;
export type ExternalSessionIdSink = (
  sessionId: string,
  extraction: SessionIdExtraction,
) => void;

export interface PtyRegistryOptions {
  /**
   * Milliseconds to keep the SessionRecord alive after the PTY exit so live
   * data subscribers see the trailing chunk and late `subscribe` calls still
   * receive the buffer.
   */
  gracefulExitDelayMs?: number;
  /**
   * V3-W13-002 — invoked once per detected URL (OSC8 hyperlink or plain URL)
   * appearing in any session's data stream. Optional: when omitted the
   * detector is skipped entirely so non-link consumers (tests, headless
   * spawn) pay no cost.
   */
  onLinkDetected?: LinkSink;
  /**
   * v1.1.3 Step 3 — invoked once when early provider output reveals the
   * provider-native resumable session id.
   */
  onExternalSessionId?: ExternalSessionIdSink;
  /** Maximum complete output lines to scan per PTY before giving up. */
  externalSessionScanLineLimit?: number;
}

export class PtyRegistry {
  private sessions = new Map<string, SessionRecord>();
  private readonly onData: DataSink;
  private readonly onExit: ExitSink;
  private readonly gracefulExitDelayMs: number;
  private readonly onLinkDetected: LinkSink | null;
  private readonly onExternalSessionId: ExternalSessionIdSink | null;
  private readonly externalSessionScanLineLimit: number;
  constructor(onData: DataSink, onExit: ExitSink, opts: PtyRegistryOptions = {}) {
    this.onData = onData;
    this.onExit = onExit;
    this.gracefulExitDelayMs = opts.gracefulExitDelayMs ?? 200;
    this.onLinkDetected = opts.onLinkDetected ?? null;
    this.onExternalSessionId = opts.onExternalSessionId ?? null;
    this.externalSessionScanLineLimit = opts.externalSessionScanLineLimit ?? 500;
  }

  create(input: { providerId: string; sessionId?: string } & SpawnInput): SessionRecord {
    const id = input.sessionId ?? randomUUID();
    const pty = spawnLocalPty(input);
    const buffer = new RingBuffer();
    const linkSink = this.onLinkDetected;
    const externalSink = this.onExternalSessionId;
    const scanLimit = this.externalSessionScanLineLimit;
    let scanDone = scanLimit <= 0;
    let scannedLines = 0;
    let pendingLine = '';
    let extractedExternalSessionId: string | undefined;
    const recordExternalSessionId = (extraction: SessionIdExtraction) => {
      if (scanDone) return;
      scanDone = true;
      extractedExternalSessionId = extraction.sessionId;
      const rec = this.sessions.get(id);
      if (rec) rec.externalSessionId = extraction.sessionId;
      if (externalSink) {
        try {
          externalSink(id, extraction);
        } catch {
          /* never let persistence break the PTY data stream */
        }
      }
    };
    const scanExternalSessionId = (data: string) => {
      if (scanDone) return;
      pendingLine += data;
      const lines = pendingLine.split(/\r\n|\n|\r/);
      pendingLine = lines.pop() ?? '';
      for (const line of lines) {
        scannedLines += 1;
        const hit = extractSessionIdFromLine(input.providerId, line);
        if (hit) {
          recordExternalSessionId(hit);
          return;
        }
        if (scannedLines >= scanLimit) {
          scanDone = true;
          pendingLine = '';
          return;
        }
      }
      if (pendingLine.length > 8192) {
        scannedLines += 1;
        const hit = extractSessionIdFromLine(input.providerId, pendingLine);
        if (hit) {
          recordExternalSessionId(hit);
          return;
        }
        pendingLine = '';
        if (scannedLines >= scanLimit) scanDone = true;
      }
    };
    const unsubData = pty.onData((data) => {
      buffer.append(data);
      scanExternalSessionId(data);
      this.onData(id, data);
      if (linkSink) {
        const hits = detectLinks(data);
        for (const hit of hits) {
          try {
            linkSink(id, hit);
          } catch {
            /* never let a buggy listener break the data stream */
          }
        }
      }
    });
    const unsubExit = pty.onExit(({ exitCode, signal }) => {
      const rec = this.sessions.get(id);
      if (rec) {
        rec.alive = false;
        rec.exitCode = exitCode;
        rec.exitedAt = Date.now();
      }
      this.onExit(id, exitCode, signal);
      // Forget after a short grace period so the renderer's last data drain is
      // not lost and a late subscribe() can still pull the snapshot.
      setTimeout(() => this.forget(id), this.gracefulExitDelayMs);
    });
    const rec: SessionRecord = {
      id,
      providerId: input.providerId,
      cwd: input.cwd,
      pid: pty.pid,
      alive: true,
      startedAt: Date.now(),
      externalSessionId: extractedExternalSessionId,
      pty,
      buffer,
      unsubData,
      unsubExit,
    };
    this.sessions.set(id, rec);
    return rec;
  }

  get(id: string): SessionRecord | undefined {
    return this.sessions.get(id);
  }

  list(): SessionRecord[] {
    return Array.from(this.sessions.values());
  }

  write(id: string, data: string): void {
    this.sessions.get(id)?.pty.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    // Mirror the `kill()` idiom below: short-circuit when the session is
    // unknown or has already exited (its PTY fd is closed). Without this
    // guard, the renderer's ResizeObserver firing during the
    // gracefulExitDelayMs window after `pty:exit` would forward the resize
    // into a dead node-pty handle and surface EBADF as a red toast.
    const session = this.sessions.get(id);
    if (!session?.alive) return;
    session.pty.resize(cols, rows);
  }

  kill(id: string): void {
    const rec = this.sessions.get(id);
    if (!rec) return;
    try {
      rec.pty.kill();
    } catch {
      /* ignore */
    }
  }

  forget(id: string): void {
    const rec = this.sessions.get(id);
    if (!rec) return;
    try {
      rec.unsubData();
    } catch {
      /* ignore */
    }
    try {
      rec.unsubExit();
    } catch {
      /* ignore */
    }
    // If the underlying PTY is still alive, ask it to terminate before we drop
    // our handle. Without this, dropping the only reference leaks the child
    // process (it keeps running detached) — the registry's `alive` flag is
    // bookkeeping, not a kernel resource.
    const pid = rec.pid;
    const stillAlive = rec.alive && isProcessAlive(pid);
    if (stillAlive) {
      try {
        rec.pty.kill();
      } catch {
        /* ignore */
      }
      // 5s fallback: SIGKILL any survivor that ignored SIGTERM (e.g. a CLI
      // mid-`waitpid` that's swallowing signals). PID may have been reused
      // by then, but `process.kill(pid, 0)` will tell us if the original
      // child is still resident before we escalate.
      setTimeout(() => {
        try {
          if (pid > 0 && isProcessAlive(pid)) {
            process.kill(pid, 'SIGKILL');
          }
        } catch {
          /* ignore — already gone */
        }
      }, PTY_KILL_FALLBACK_MS).unref();
    }
    rec.buffer.clear();
    this.sessions.delete(id);
  }

  /**
   * Best-effort termination of every live session. Called from
   * Electron's `before-quit` hook. Does not wait for exit acknowledgement.
   *
   * Uses a single 5s SIGKILL fallback for all survivors instead of per-entry
   * timers — N timers become 1, which matters when an app has many panes.
   */
  killAll(): void {
    const survivorPids: number[] = [];
    for (const rec of this.sessions.values()) {
      if (rec.alive) {
        try {
          rec.pty.kill();
        } catch {
          /* ignore */
        }
        if (rec.pid > 0) survivorPids.push(rec.pid);
      }
    }
    if (survivorPids.length === 0) return;
    setTimeout(() => {
      for (const pid of survivorPids) {
        try {
          if (isProcessAlive(pid)) process.kill(pid, 'SIGKILL');
        } catch {
          /* ignore — already gone */
        }
      }
    }, PTY_KILL_FALLBACK_MS).unref();
  }

  // Returns the historical buffer atomically; the caller is responsible for
  // having already attached to the live event stream BEFORE calling this so
  // there is no replay/live race.
  snapshot(id: string): string {
    return this.sessions.get(id)?.buffer.snapshot() ?? '';
  }
}
