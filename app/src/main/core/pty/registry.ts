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
//
// v1.2.8 — the stdout `session-id-extractor` scan loop was removed in favour
// of (a) pre-assigning UUIDs at spawn for claude/gemini and (b) async disk
// scanning for codex/kimi/opencode. The registry now exposes an
// `onPostSpawnCapture` hook that the rpc-router uses to schedule the
// disk-scan retries via `pty/session-disk-scanner`.

import { randomUUID } from 'node:crypto';
import { spawnLocalPty, type PtyHandle, type SpawnInput } from './local-pty';
import { RingBuffer } from './ring-buffer';
import { detectLinks, type LinkHit } from './link-detector';

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

/**
 * v1.2.8 — emitted right after a fresh PTY is spawned (NOT during resume).
 * The rpc-router uses this to schedule the bounded retry loop in
 * `pty/session-disk-scanner.ts` for codex/kimi/opencode. Providers that
 * pre-assigned a UUID at spawn time (claude, gemini) supply it via
 * `preassignedExternalSessionId`; receivers may persist it immediately
 * without waiting for any output.
 */
export interface PostSpawnCapture {
  sessionId: string;
  providerId: string;
  cwd: string;
  preassignedExternalSessionId?: string;
}
export type PostSpawnSink = (capture: PostSpawnCapture) => void;

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
   * v1.2.8 — invoked once per fresh spawn (skipped on resume, which already
   * carries `opts.sessionId`). The router uses this to schedule the disk-scan
   * retries for codex/kimi/opencode and to persist the pre-assigned UUID
   * (claude/gemini) into the DB without an extra round-trip.
   */
  onPostSpawnCapture?: PostSpawnSink;
}

export class PtyRegistry {
  private sessions = new Map<string, SessionRecord>();
  private readonly onData: DataSink;
  private readonly onExit: ExitSink;
  private readonly gracefulExitDelayMs: number;
  private readonly onLinkDetected: LinkSink | null;
  private readonly onPostSpawnCapture: PostSpawnSink | null;
  constructor(onData: DataSink, onExit: ExitSink, opts: PtyRegistryOptions = {}) {
    this.onData = onData;
    this.onExit = onExit;
    this.gracefulExitDelayMs = opts.gracefulExitDelayMs ?? 200;
    this.onLinkDetected = opts.onLinkDetected ?? null;
    this.onPostSpawnCapture = opts.onPostSpawnCapture ?? null;
  }

  create(
    input: {
      providerId: string;
      sessionId?: string;
      /**
       * v1.2.8 — pre-assigned provider-native session id from the launcher
       * (claude/gemini `--session-id <uuid>`). Stamped onto the SessionRecord
       * so the caller sees it synchronously and the post-spawn hook reports
       * it to the router for immediate DB persistence.
       */
      externalSessionId?: string;
    } & SpawnInput,
  ): SessionRecord {
    const id = input.sessionId ?? randomUUID();
    const isResume = input.sessionId !== undefined;
    const pty = spawnLocalPty(input);
    const buffer = new RingBuffer();
    const linkSink = this.onLinkDetected;
    const unsubData = pty.onData((data) => {
      buffer.append(data);
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
      externalSessionId: input.externalSessionId,
      pty,
      buffer,
      unsubData,
      unsubExit,
    };
    this.sessions.set(id, rec);
    // v1.2.8 — only fire the post-spawn capture hook for FRESH spawns; resume
    // calls already carry the external id in their DB row and the disk-scan
    // would only race the resume's own start-up I/O.
    if (!isResume && this.onPostSpawnCapture) {
      try {
        this.onPostSpawnCapture({
          sessionId: id,
          providerId: input.providerId,
          cwd: input.cwd,
          preassignedExternalSessionId: input.externalSessionId,
        });
      } catch {
        /* never let capture wiring break the spawn */
      }
    }
    return rec;
  }

  get(id: string): SessionRecord | undefined {
    return this.sessions.get(id);
  }

  /**
   * v1.2.8 — set the captured external session id on a live record after a
   * successful disk-scan. Idempotent: a second call with the same id is a
   * no-op; a call after `forget()` silently drops the update.
   */
  setExternalSessionId(id: string, externalSessionId: string): void {
    const rec = this.sessions.get(id);
    if (!rec) return;
    if (rec.externalSessionId === externalSessionId) return;
    rec.externalSessionId = externalSessionId;
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
