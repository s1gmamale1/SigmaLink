// Session registry: keeps PtyHandle + ring buffer per session id, fans data to
// all subscribed renderers via the shared event bus.

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

export class PtyRegistry {
  private sessions = new Map<string, SessionRecord>();
  private readonly onData: DataSink;
  private readonly onExit: ExitSink;
  constructor(onData: DataSink, onExit: ExitSink) {
    this.onData = onData;
    this.onExit = onExit;
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
    rec.unsubData();
    rec.unsubExit();
    this.sessions.delete(id);
  }

  // Returns the historical buffer atomically; the caller is responsible for
  // having already attached to the live event stream BEFORE calling this so
  // there is no replay/live race.
  snapshot(id: string): string {
    return this.sessions.get(id)?.buffer.snapshot() ?? '';
  }
}
