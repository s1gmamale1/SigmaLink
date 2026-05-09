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

export interface SessionRecord {
  id: string;
  providerId: string;
  cwd: string;
  pid: number;
  alive: boolean;
  exitCode?: number;
  startedAt: number;
  exitedAt?: number;
  pty: PtyHandle;
  buffer: RingBuffer;
  unsubData: () => void;
  unsubExit: () => void;
}

export type DataSink = (sessionId: string, data: string) => void;
export type ExitSink = (sessionId: string, exitCode: number, signal?: number) => void;

export interface PtyRegistryOptions {
  /**
   * Milliseconds to keep the SessionRecord alive after the PTY exit so live
   * data subscribers see the trailing chunk and late `subscribe` calls still
   * receive the buffer.
   */
  gracefulExitDelayMs?: number;
}

export class PtyRegistry {
  private sessions = new Map<string, SessionRecord>();
  private readonly onData: DataSink;
  private readonly onExit: ExitSink;
  private readonly gracefulExitDelayMs: number;
  constructor(onData: DataSink, onExit: ExitSink, opts: PtyRegistryOptions = {}) {
    this.onData = onData;
    this.onExit = onExit;
    this.gracefulExitDelayMs = opts.gracefulExitDelayMs ?? 200;
  }

  create(input: { providerId: string } & SpawnInput): SessionRecord {
    const id = randomUUID();
    const pty = spawnLocalPty(input);
    const buffer = new RingBuffer();
    const unsubData = pty.onData((data) => {
      buffer.append(data);
      this.onData(id, data);
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
    this.sessions.get(id)?.pty.resize(cols, rows);
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
    rec.buffer.clear();
    this.sessions.delete(id);
  }

  /**
   * Best-effort termination of every live session. Called from
   * Electron's `before-quit` hook. Does not wait for exit acknowledgement.
   */
  killAll(): void {
    for (const rec of this.sessions.values()) {
      if (rec.alive) {
        try {
          rec.pty.kill();
        } catch {
          /* ignore */
        }
      }
    }
  }

  // Returns the historical buffer atomically; the caller is responsible for
  // having already attached to the live event stream BEFORE calling this so
  // there is no replay/live race.
  snapshot(id: string): string {
    return this.sessions.get(id)?.buffer.snapshot() ?? '';
  }
}
