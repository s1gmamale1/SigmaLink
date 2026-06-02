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
import { spawnLocalPty, resolveEffectiveSpawnMode, type PtyHandle, type SpawnInput } from './local-pty';
import { RingBuffer } from './ring-buffer';
import { detectLinks, type LinkHit } from './link-detector';
import { extractSentinel } from './sentinel';

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
  /**
   * v1.6.0 Phase 2 — the effective spawn mode used for this session.
   * 'shell-first' sessions watch the data stream for the CLI-exit sentinel.
   * 'direct' sessions (the default) never have the sentinel in their data stream.
   * Optional for backwards compatibility with existing SessionRecord mocks in tests.
   */
  spawnMode?: 'direct' | 'shell-first';
}

export type DataSink = (sessionId: string, data: string) => void;
export type ExitSink = (sessionId: string, exitCode: number, signal?: number) => void;
export type LinkSink = (sessionId: string, hit: LinkHit) => void;

/**
 * v1.6.0 Phase 2 — emitted when the CLI exits inside a shell-first pane.
 *
 * Distinct from `ExitSink` (which fires when the SHELL/PTY itself exits) and
 * from `PaneEventSink` (which is wired to the `jorvis_pane_events` DB table whose
 * SQLite enum does not include 'cli-exited').  A separate sink keeps the status
 * model additive and avoids a schema migration.
 *
 * CRITICAL INVARIANT: never fired in direct mode — only in shell-first mode
 * when the sentinel is detected in the PTY data stream.
 */
export type CliExitedSink = (info: { sessionId: string; exitCode: number }) => void;

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
export type PaneEventSink = (event: {
  sessionId: string;
  kind: 'started' | 'exited' | 'error' | 'output-spike' | 'idle';
  exitCode?: number;
  body?: string;
}) => void;

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
   * PERF-2 — gate for the per-chunk link-detection regex + emit. Returns
   * `true` when link capture is enabled (`kv['browser.captureLinks']` is on).
   * When this returns `false`, BOTH `detectLinks` and the `onLinkDetected`
   * emit are short-circuited so the main process pays nothing on every chunk
   * while capture is off — previously the regex ran unconditionally and the
   * renderer was the only gate.
   *
   * When omitted, link detection always runs (when `onLinkDetected` is wired),
   * which preserves the original always-on behaviour for existing callers and
   * tests. The caller (rpc-router) owns the KV read; the registry stays
   * DB-agnostic so it remains loadable under vitest.
   */
  shouldDetectLinks?: () => boolean;
  /**
   * v1.2.8 — invoked once per fresh spawn (skipped on resume, which already
   * carries `opts.sessionId`). The router uses this to schedule the disk-scan
   * retries for codex/kimi/opencode and to persist the pre-assigned UUID
   * (claude/gemini) into the DB without an extra round-trip.
   */
  onPostSpawnCapture?: PostSpawnSink;
  onPaneEvent?: PaneEventSink;
  /**
   * v1.6.0 Phase 2 — called when the CLI exits inside a shell-first pane
   * (sentinel detected in the PTY data stream).  The shell/PTY stays alive.
   *
   * IMPORTANT: this fires INSTEAD OF (not in addition to) `onPaneEvent` for
   * the CLI-exit event in shell-first mode.  Direct-mode panes use the normal
   * `onExit` → `onPaneEvent` path.  The sentinel line is stripped from the data
   * forwarded to the renderer before this callback fires.
   */
  onCliExited?: CliExitedSink;
  /**
   * v1.9-scrollback (DEFAULT-OFF feature) — called synchronously when a PTY
   * exits, with the final buffer snapshot, BEFORE the graceful-exit timer that
   * eventually calls forget()/buffer.clear().  The caller (rpc-router) is
   * responsible for reading the KV flag and only wiring this when the flag is
   * ON.  When omitted (flag off) the exit path is byte-for-byte unchanged.
   */
  onSessionExit?: (sessionId: string, snapshot: string) => void;
}

export class PtyRegistry {
  private sessions = new Map<string, SessionRecord>();
  private readonly onData: DataSink;
  private readonly onExit: ExitSink;
  private readonly gracefulExitDelayMs: number;
  private readonly onLinkDetected: LinkSink | null;
  private readonly shouldDetectLinks: (() => boolean) | null;
  private readonly onPostSpawnCapture: PostSpawnSink | null;
  private readonly onPaneEvent: PaneEventSink | null;
  private readonly onCliExited: CliExitedSink | null;
  private readonly onSessionExit: ((sessionId: string, snapshot: string) => void) | null;
  constructor(onData: DataSink, onExit: ExitSink, opts: PtyRegistryOptions = {}) {
    this.onData = onData;
    this.onExit = onExit;
    this.gracefulExitDelayMs = opts.gracefulExitDelayMs ?? 200;
    this.onLinkDetected = opts.onLinkDetected ?? null;
    this.shouldDetectLinks = opts.shouldDetectLinks ?? null;
    this.onPostSpawnCapture = opts.onPostSpawnCapture ?? null;
    this.onPaneEvent = opts.onPaneEvent ?? null;
    this.onCliExited = opts.onCliExited ?? null;
    this.onSessionExit = opts.onSessionExit ?? null;
  }

  create(
    input: {
      providerId: string;
      sessionId?: string;
      /**
       * v1.5.5-A — SigmaLink-internal DB session id for FRESH spawns.
       * Unlike `sessionId` (the resume sentinel), this field does NOT set
       * `isResume = true`, so `onPostSpawnCapture` still fires and
       * `shouldPreAssign` still injects `--session-id` for claude/gemini.
       *
       * Precedence: `sessionId` > `preassignedSessionId` > `randomUUID()`.
       */
      preassignedSessionId?: string;
      /**
       * v1.2.8 — pre-assigned provider-native session id from the launcher
       * (claude/gemini `--session-id <uuid>`). Stamped onto the SessionRecord
       * so the caller sees it synchronously and the post-spawn hook reports
       * it to the router for immediate DB persistence.
       */
      externalSessionId?: string;
      /**
       * v1.5.5 — explicit resume flag. When provided, takes precedence over
       * the implicit `sessionId !== undefined` derivation. Use `true` for
       * resume callers (resume-launcher) and `false` for fresh spawns
       * (workspaces/launcher, swarms/factory-spawn). When omitted, falls
       * back to the existing implicit derivation for backwards compatibility.
       */
      isResume?: boolean;
      /**
       * v1.9-scrollback (DEFAULT-OFF feature) — persisted scrollback content
       * to seed the ring buffer BEFORE live data arrives.  Only provided when
       * the `pty.scrollbackPersistence` KV flag is 'on' AND this is a resume
       * spawn.  When absent (flag off or fresh spawn) the buffer starts empty
       * and behaviour is byte-for-byte identical to pre-v1.9.
       */
      resumeScrollback?: string;
    } & SpawnInput,
  ): SessionRecord {
    const id = input.sessionId ?? input.preassignedSessionId ?? randomUUID();
    const isResume = input.isResume ?? (input.sessionId !== undefined);
    // v1.6.0 Phase 2: resolve the effective spawn mode so the data handler knows
    // whether to watch for the CLI-exit sentinel.
    //
    // H-6 (Wave-2 hardening): this used to duplicate spawnLocalPty's 3-condition
    // guard inline, and the two drifted on win32 (the spawn side dropped the
    // win32 check in Phase 5 while this kept it). Both call sites now share the
    // single `resolveEffectiveSpawnMode` helper so the watcher armed here always
    // matches whether spawnLocalPty actually wrapped the command in a shell.
    const effectiveSpawnMode = resolveEffectiveSpawnMode(input.spawnMode, input.command ?? '');
    const pty = spawnLocalPty(input);
    const buffer = new RingBuffer();
    // v1.9-scrollback — restore prior content BEFORE the live onData listener
    // is registered so snapshot() returns restored + live data naturally.
    // No-op when resumeScrollback is absent (flag off or fresh spawn).
    if (input.resumeScrollback) {
      buffer.restore(input.resumeScrollback);
    }
    const linkSink = this.onLinkDetected;
    const shouldDetectLinks = this.shouldDetectLinks;
    const cliExitedSink = this.onCliExited;
    const unsubData = pty.onData((rawData) => {
      // v1.6.0 Phase 2 — sentinel detection (shell-first mode only).
      // In shell-first mode the injected command line ends with a `; printf …`
      // snippet that emits the sentinel after the CLI exits.  We intercept it
      // here, strip it from the forwarded data (users must not see the raw
      // marker), and fire the cli-exited signal without tearing down the pane.
      let data = rawData;
      if (effectiveSpawnMode === 'shell-first' && cliExitedSink) {
        const match = extractSentinel(rawData);
        if (match !== null) {
          data = match.strippedData;
          try {
            cliExitedSink({ sessionId: id, exitCode: match.exitCode });
          } catch {
            /* never let a cli-exited listener break the data stream */
          }
        }
      }
      buffer.append(data);
      this.onData(id, data);
      // PERF-2 — only run the link-detection regex + emit when a sink is wired
      // AND link capture is enabled. The `shouldDetectLinks` gate (when
      // provided) mirrors the renderer's `kv['browser.captureLinks']` gate so
      // the main process skips the per-chunk regex entirely while capture is
      // off. Omitting the gate preserves the original always-on behaviour. A
      // throwing gate must never break the data stream → default to detecting
      // (matches the renderer's default-ON-when-KV-unreachable semantics).
      let detectLinksEnabled = true;
      if (shouldDetectLinks !== null) {
        try {
          detectLinksEnabled = shouldDetectLinks();
        } catch {
          detectLinksEnabled = true;
        }
      }
      if (linkSink && detectLinksEnabled) {
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
    const sessionExitSink = this.onSessionExit;
    const unsubExit = pty.onExit(({ exitCode, signal }) => {
      const rec = this.sessions.get(id);
      if (rec) {
        rec.alive = false;
        rec.exitCode = exitCode;
        rec.exitedAt = Date.now();
      }
      this.onExit(id, exitCode, signal);
      if (this.onPaneEvent) {
        try {
          this.onPaneEvent({ sessionId: id, kind: rec?.exitCode === 0 ? 'exited' : 'error', exitCode: rec?.exitCode });
        } catch { /* ignore */ }
      }
      // v1.9-scrollback — persist the buffer snapshot before the graceful-exit
      // timer calls forget()/buffer.clear().  Only runs when the caller wired
      // onSessionExit (flag ON).  Never blocks the exit path.
      if (sessionExitSink) {
        try {
          sessionExitSink(id, buffer.snapshot());
        } catch {
          /* never let the persist path block the exit flow */
        }
      }
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
      spawnMode: effectiveSpawnMode,
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
    if (this.onPaneEvent) {
      try {
        this.onPaneEvent({ sessionId: id, kind: 'started' });
      } catch { /* ignore */ }
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
