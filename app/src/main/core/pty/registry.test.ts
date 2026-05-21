// Coverage for Fix 2 — PTY process leaks in `registry.forget()` and the
// killAll() timer storm. The registry must:
//   1. SIGTERM the underlying PTY when forget() is called on a still-alive
//      session, then arm a single 5s SIGKILL fallback.
//   2. Use ONE 5s timer for killAll() regardless of how many survivors there
//      are (not N timers).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock node-pty entirely so we never touch a real PTY. The registry only
// cares about the `PtyHandle` interface returned by spawnLocalPty.
vi.mock('./local-pty', () => {
  return {
    spawnLocalPty: vi.fn(),
  };
});

import { spawnLocalPty } from './local-pty';
import { PtyRegistry } from './registry';
import type { PtyHandle } from './local-pty';
import { SENTINEL_PREFIX, SENTINEL_SUFFIX } from './sentinel';

interface FakePty extends PtyHandle {
  killCalls: number;
  killSignal?: string;
}

const FAKE_PID = 999_999_999; // way outside any real PID range

// Override process.kill so the fallback SIGKILL path doesn't blow up the test
// runner. We intercept BOTH probes (signal 0) and real kills:
//   - signal 0 → return success for our FAKE_PID so isProcessAlive reports
//     "alive" (which is what we want — the test verifies the kill is issued).
//   - any real signal → record the call without delivering it.
const killCalls: { pid: number; signal: number | string }[] = [];
const realKill = process.kill.bind(process);

beforeEach(() => {
  killCalls.length = 0;
  process.kill = ((pid: number, signal?: number | string) => {
    killCalls.push({ pid, signal: signal ?? 0 });
    if (pid === FAKE_PID) return true; // fake "process exists"
    // For other PIDs (e.g. real ones), delegate.
    return realKill(pid, signal as NodeJS.Signals);
  }) as typeof process.kill;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  process.kill = realKill;
  vi.clearAllMocks();
});

function makeFakePty(pid: number = FAKE_PID): FakePty {
  const handle = {
    pid,
    killCalls: 0,
    killSignal: undefined as string | undefined,
    write: () => undefined,
    resize: () => undefined,
    kill: function (this: FakePty) {
      this.killCalls += 1;
    },
    onData: () => () => undefined,
    onExit: () => () => undefined,
  } as FakePty;
  return handle;
}

describe('PtyRegistry.forget()', () => {
  it('calls pty.kill() when the session is still alive', () => {
    const pty = makeFakePty(FAKE_PID); // use our own PID so isProcessAlive=true
    vi.mocked(spawnLocalPty).mockReturnValue(pty);
    const registry = new PtyRegistry(
      () => undefined,
      () => undefined,
    );
    const sess = registry.create({
      providerId: 'test',
      command: 'shell',
      args: [],
      cwd: '/tmp',
      cols: 80,
      rows: 24,
    });
    expect(sess.alive).toBe(true);
    registry.forget(sess.id);
    expect(pty.killCalls).toBe(1);
    // Subsequent get() returns undefined — entry has been dropped.
    expect(registry.get(sess.id)).toBeUndefined();
  });

  it('arms a single 5s SIGKILL fallback timer after SIGTERM', () => {
    const pty = makeFakePty(FAKE_PID);
    vi.mocked(spawnLocalPty).mockReturnValue(pty);
    const registry = new PtyRegistry(
      () => undefined,
      () => undefined,
    );
    const sess = registry.create({
      providerId: 'test',
      command: 'shell',
      args: [],
      cwd: '/tmp',
      cols: 80,
      rows: 24,
    });
    const beforeCount = vi.getTimerCount();
    registry.forget(sess.id);
    // forget() arms exactly ONE new timer (the SIGKILL fallback).
    expect(vi.getTimerCount()).toBe(beforeCount + 1);
    // Advance time past the 5s fallback — the timer should be cleared.
    vi.advanceTimersByTime(6_000);
    // No exception means process.kill(pid, 'SIGKILL') was attempted safely.
  });

  it('does NOT kill the pty when the session is already dead', () => {
    const pty = makeFakePty(-1); // bogus pid → isProcessAlive=false
    vi.mocked(spawnLocalPty).mockReturnValue(pty);
    const registry = new PtyRegistry(
      () => undefined,
      () => undefined,
    );
    const sess = registry.create({
      providerId: 'test',
      command: 'shell',
      args: [],
      cwd: '/tmp',
      cols: 80,
      rows: 24,
    });
    // Manually mark it dead.
    sess.alive = false;
    const before = vi.getTimerCount();
    registry.forget(sess.id);
    expect(pty.killCalls).toBe(0);
    // No fallback timer armed when the session is dead.
    expect(vi.getTimerCount()).toBe(before);
  });

  it('is a no-op when called with an unknown id', () => {
    const registry = new PtyRegistry(
      () => undefined,
      () => undefined,
    );
    expect(() => registry.forget('does-not-exist')).not.toThrow();
  });
});

describe('PtyRegistry.resize()', () => {
  // v1.2.5 — fast-exit panes (e.g. Kimi spawn → ENOENT → exit within the
  // 200ms graceful-exit window) used to surface "ioctl(2) failed, EBADF" as
  // a red toast when the renderer's ResizeObserver fired one last call into
  // a dead handle. The registry now short-circuits on `!alive`, and the
  // PtyHandle's `resize` wraps node-pty in try/catch as a belt-and-braces
  // guard. These cases lock in the contract: never throw.
  it('is a no-op when the session has already exited (alive=false)', () => {
    const pty = makeFakePty(FAKE_PID);
    const resizeSpy = vi.fn();
    pty.resize = resizeSpy;
    vi.mocked(spawnLocalPty).mockReturnValue(pty);
    const registry = new PtyRegistry(
      () => undefined,
      () => undefined,
    );
    const sess = registry.create({
      providerId: 'test',
      command: 'shell',
      args: [],
      cwd: '/tmp',
      cols: 80,
      rows: 24,
    });
    // Simulate the post-exit grace window: the registry record still exists
    // but the underlying PTY fd is closed.
    sess.alive = false;
    expect(() => registry.resize(sess.id, 100, 30)).not.toThrow();
    expect(resizeSpy).not.toHaveBeenCalled();
  });

  it('is a no-op when called with an unknown id', () => {
    const registry = new PtyRegistry(
      () => undefined,
      () => undefined,
    );
    expect(() => registry.resize('does-not-exist', 80, 24)).not.toThrow();
  });

  it('forwards to pty.resize while the session is alive', () => {
    const pty = makeFakePty(FAKE_PID);
    const resizeSpy = vi.fn();
    pty.resize = resizeSpy;
    vi.mocked(spawnLocalPty).mockReturnValue(pty);
    const registry = new PtyRegistry(
      () => undefined,
      () => undefined,
    );
    const sess = registry.create({
      providerId: 'test',
      command: 'shell',
      args: [],
      cwd: '/tmp',
      cols: 80,
      rows: 24,
    });
    registry.resize(sess.id, 120, 40);
    expect(resizeSpy).toHaveBeenCalledTimes(1);
    expect(resizeSpy).toHaveBeenCalledWith(120, 40);
  });
});

describe('PtyRegistry.snapshot()', () => {
  it('returns the buffered bytes for a live session', () => {
    let emitData: (data: string) => void = () => {
      throw new Error('onData was not registered');
    };
    const pty = makeFakePty(FAKE_PID);
    pty.onData = (cb) => {
      emitData = cb;
      return () => undefined;
    };
    vi.mocked(spawnLocalPty).mockReturnValue(pty);
    const registry = new PtyRegistry(
      () => undefined,
      () => undefined,
    );
    const sess = registry.create({
      providerId: 'test',
      command: 'shell',
      args: [],
      cwd: '/tmp',
      cols: 80,
      rows: 24,
    });

    emitData('hello ');
    emitData('world');

    expect(registry.snapshot(sess.id)).toBe('hello world');
    expect(registry.snapshot('does-not-exist')).toBe('');
  });
});

describe('PtyRegistry onPostSpawnCapture (v1.2.8)', () => {
  it('fires the capture hook on fresh spawn with preassigned external id', () => {
    const pty = makeFakePty(FAKE_PID);
    vi.mocked(spawnLocalPty).mockReturnValue(pty);
    const captures: Array<{
      sessionId: string;
      providerId: string;
      cwd: string;
      preassignedExternalSessionId?: string;
    }> = [];
    const registry = new PtyRegistry(
      () => undefined,
      () => undefined,
      { onPostSpawnCapture: (c) => captures.push(c) },
    );
    const sess = registry.create({
      providerId: 'claude',
      command: 'claude',
      args: ['--session-id', 'my-uuid'],
      cwd: '/tmp/proj',
      cols: 80,
      rows: 24,
      externalSessionId: 'my-uuid',
    });
    expect(captures).toHaveLength(1);
    expect(captures[0]?.sessionId).toBe(sess.id);
    expect(captures[0]?.providerId).toBe('claude');
    expect(captures[0]?.cwd).toBe('/tmp/proj');
    expect(captures[0]?.preassignedExternalSessionId).toBe('my-uuid');
    // The session record itself is also stamped synchronously.
    expect(sess.externalSessionId).toBe('my-uuid');
  });

  it('fires capture without a preassigned id for disk-scan providers', () => {
    const pty = makeFakePty(FAKE_PID);
    vi.mocked(spawnLocalPty).mockReturnValue(pty);
    const captures: Array<{ preassignedExternalSessionId?: string }> = [];
    const registry = new PtyRegistry(
      () => undefined,
      () => undefined,
      { onPostSpawnCapture: (c) => captures.push(c) },
    );
    registry.create({
      providerId: 'codex',
      command: 'codex',
      args: [],
      cwd: '/tmp/proj',
      cols: 80,
      rows: 24,
    });
    expect(captures).toHaveLength(1);
    expect(captures[0]?.preassignedExternalSessionId).toBeUndefined();
  });

  it('does NOT fire the capture hook when resuming (sessionId provided)', () => {
    const pty = makeFakePty(FAKE_PID);
    vi.mocked(spawnLocalPty).mockReturnValue(pty);
    const captures: unknown[] = [];
    const registry = new PtyRegistry(
      () => undefined,
      () => undefined,
      { onPostSpawnCapture: (c) => captures.push(c) },
    );
    registry.create({
      providerId: 'claude',
      sessionId: 'pre-existing-id',
      command: 'claude',
      args: ['--continue'],
      cwd: '/tmp/proj',
      cols: 80,
      rows: 24,
    });
    expect(captures).toHaveLength(0);
  });

  it('setExternalSessionId stamps a live record idempotently', () => {
    const pty = makeFakePty(FAKE_PID);
    vi.mocked(spawnLocalPty).mockReturnValue(pty);
    const registry = new PtyRegistry(
      () => undefined,
      () => undefined,
    );
    const sess = registry.create({
      providerId: 'codex',
      command: 'codex',
      args: [],
      cwd: '/tmp/proj',
      cols: 80,
      rows: 24,
    });
    expect(sess.externalSessionId).toBeUndefined();
    registry.setExternalSessionId(sess.id, 'captured-id');
    expect(sess.externalSessionId).toBe('captured-id');
    // Idempotent: second call with same value is a no-op.
    registry.setExternalSessionId(sess.id, 'captured-id');
    expect(sess.externalSessionId).toBe('captured-id');
    // Unknown session: silent drop, no throw.
    expect(() =>
      registry.setExternalSessionId('does-not-exist', 'whatever'),
    ).not.toThrow();
  });
});

describe('PtyRegistry.create() — preassignedSessionId (v1.5.5-A)', () => {
  it('uses preassignedSessionId as the row id and keeps isResume=false (onPostSpawnCapture fires)', () => {
    const pty = makeFakePty(FAKE_PID);
    vi.mocked(spawnLocalPty).mockReturnValue(pty);
    const captures: Array<{ sessionId: string }> = [];
    const registry = new PtyRegistry(
      () => undefined,
      () => undefined,
      { onPostSpawnCapture: (c) => captures.push(c) },
    );
    const sess = registry.create({
      providerId: 'codex',
      command: 'codex',
      args: [],
      cwd: '/tmp/proj',
      cols: 80,
      rows: 24,
      preassignedSessionId: 'fresh-uuid',
    });
    expect(sess.id).toBe('fresh-uuid');
    // isResume was false → capture hook fires.
    expect(captures).toHaveLength(1);
    expect(captures[0]?.sessionId).toBe('fresh-uuid');
  });

  it('sessionId takes precedence over preassignedSessionId and isResume=true (onPostSpawnCapture suppressed)', () => {
    const pty = makeFakePty(FAKE_PID);
    vi.mocked(spawnLocalPty).mockReturnValue(pty);
    const captures: unknown[] = [];
    const registry = new PtyRegistry(
      () => undefined,
      () => undefined,
      { onPostSpawnCapture: (c) => captures.push(c) },
    );
    const sess = registry.create({
      providerId: 'claude',
      command: 'claude',
      args: ['--continue'],
      cwd: '/tmp/proj',
      cols: 80,
      rows: 24,
      sessionId: 'resume-uuid',
      preassignedSessionId: 'should-be-ignored',
    });
    // sessionId wins for the row id.
    expect(sess.id).toBe('resume-uuid');
    // isResume=true → capture hook must NOT fire.
    expect(captures).toHaveLength(0);
  });
});

describe('PtyRegistry.create() — explicit isResume field (v1.5.5)', () => {
  it('isResume:true suppresses onPostSpawnCapture even when sessionId is undefined', () => {
    const pty = makeFakePty(FAKE_PID);
    vi.mocked(spawnLocalPty).mockReturnValue(pty);
    const captures: unknown[] = [];
    const registry = new PtyRegistry(
      () => undefined,
      () => undefined,
      { onPostSpawnCapture: (c) => captures.push(c) },
    );
    // No sessionId supplied — implicit derivation would give isResume=false.
    // The explicit isResume:true must win and suppress the capture hook.
    registry.create({
      providerId: 'codex',
      command: 'codex',
      args: [],
      cwd: '/tmp/proj',
      cols: 80,
      rows: 24,
      isResume: true,
    });
    expect(captures).toHaveLength(0);
  });

  it('isResume:false fires onPostSpawnCapture even if sessionId were set (hypothetical override)', () => {
    const pty = makeFakePty(FAKE_PID);
    vi.mocked(spawnLocalPty).mockReturnValue(pty);
    const captures: Array<{ sessionId: string }> = [];
    const registry = new PtyRegistry(
      () => undefined,
      () => undefined,
      { onPostSpawnCapture: (c) => captures.push(c) },
    );
    // Explicit isResume:false must override the implicit sessionId derivation
    // and allow the capture hook to fire.
    const sess = registry.create({
      providerId: 'codex',
      command: 'codex',
      args: [],
      cwd: '/tmp/proj',
      cols: 80,
      rows: 24,
      sessionId: 'some-id',
      isResume: false,
    });
    expect(captures).toHaveLength(1);
    expect(captures[0]?.sessionId).toBe(sess.id);
  });

  it('omitting isResume falls back to implicit sessionId-based derivation (equivalence)', () => {
    const pty = makeFakePty(FAKE_PID);
    vi.mocked(spawnLocalPty).mockReturnValue(pty);
    const capturesA: unknown[] = [];
    const capturesB: unknown[] = [];

    const registryA = new PtyRegistry(
      () => undefined,
      () => undefined,
      { onPostSpawnCapture: (c) => capturesA.push(c) },
    );
    const registryB = new PtyRegistry(
      () => undefined,
      () => undefined,
      { onPostSpawnCapture: (c) => capturesB.push(c) },
    );

    // With sessionId, implicit derivation → isResume=true → no capture.
    registryA.create({
      providerId: 'codex',
      command: 'codex',
      args: [],
      cwd: '/tmp/proj',
      cols: 80,
      rows: 24,
      sessionId: 'existing-id',
      // isResume intentionally omitted
    });
    expect(capturesA).toHaveLength(0);

    // Without sessionId, implicit derivation → isResume=false → capture fires.
    registryB.create({
      providerId: 'codex',
      command: 'codex',
      args: [],
      cwd: '/tmp/proj',
      cols: 80,
      rows: 24,
      // sessionId intentionally omitted, isResume intentionally omitted
    });
    expect(capturesB).toHaveLength(1);
  });
});

describe('v1.5.6 — gracefulExitDelayMs race fix', () => {
  it('v1.5.6 — ring buffer survives gracefulExitDelayMs window after PTY exit so renderer snapshot wins the race', () => {
    // Arrange: wire up onExit so we can trigger it manually.
    let triggerExit: (code: number, signal: number) => void = () => {
      throw new Error('onExit was not registered');
    };
    const pty = makeFakePty(FAKE_PID);
    pty.onExit = (cb) => {
      triggerExit = (exitCode, signal) => cb({ exitCode, signal });
      return () => undefined;
    };
    let emitData: (data: string) => void = () => undefined;
    pty.onData = (cb) => {
      emitData = cb;
      return () => undefined;
    };
    vi.mocked(spawnLocalPty).mockReturnValue(pty);

    const gracefulExitDelayMs = 1_000;
    const epsilon = 50;

    const registry = new PtyRegistry(
      () => undefined,
      () => undefined,
      { gracefulExitDelayMs },
    );
    const sess = registry.create({
      providerId: 'test',
      command: 'shell',
      args: [],
      cwd: '/tmp',
      cols: 80,
      rows: 24,
    });

    // Write content into the buffer before exit.
    emitData('hello from fast-exit binary');

    // Sanity: snapshot returns content while alive.
    expect(registry.snapshot(sess.id)).toBe('hello from fast-exit binary');

    // Simulate PTY exit (onExit callback fires).
    triggerExit(1, 0);

    // Immediately after exit — still within the grace window — snapshot must
    // still return the buffered content (the renderer's IPC round-trip wins).
    expect(registry.snapshot(sess.id)).toBe('hello from fast-exit binary');

    // Advance time to just before the grace window expires (gracefulExitDelayMs - epsilon).
    vi.advanceTimersByTime(gracefulExitDelayMs - epsilon);
    // Buffer must still be intact — forget() has NOT been called yet.
    expect(registry.snapshot(sess.id)).toBe('hello from fast-exit binary');

    // Advance time past the grace window (gracefulExitDelayMs + epsilon total).
    vi.advanceTimersByTime(epsilon * 2);
    // Now forget() has fired: the record is gone and snapshot returns ''.
    expect(registry.snapshot(sess.id)).toBe('');
  });
});

describe('PtyRegistry.killAll()', () => {
  it('uses ONE 5s timer regardless of session count', () => {
    // Spawn 4 fake sessions.
    const ptys = [makeFakePty(FAKE_PID), makeFakePty(FAKE_PID), makeFakePty(FAKE_PID), makeFakePty(FAKE_PID)];
    let i = 0;
    vi.mocked(spawnLocalPty).mockImplementation(() => ptys[i++]!);
    const registry = new PtyRegistry(
      () => undefined,
      () => undefined,
    );
    for (let n = 0; n < 4; n++) {
      registry.create({
        providerId: 'test',
        command: 'shell',
        args: [],
        cwd: '/tmp',
        cols: 80,
        rows: 24,
        sessionId: `s${n}`,
      });
    }
    const before = vi.getTimerCount();
    registry.killAll();
    // Exactly ONE additional timer should be armed (the fallback SIGKILL),
    // not 4. This is the key regression test for the N→1 timer fix.
    expect(vi.getTimerCount()).toBe(before + 1);
    // All four PTYs must have received SIGTERM (the underlying pty.kill()).
    for (const pty of ptys) {
      expect(pty.killCalls).toBe(1);
    }
    vi.advanceTimersByTime(6_000);
  });

  it('arms NO timer when there are no alive sessions', () => {
    const registry = new PtyRegistry(
      () => undefined,
      () => undefined,
    );
    const before = vi.getTimerCount();
    registry.killAll();
    expect(vi.getTimerCount()).toBe(before);
  });

  it('skips sessions whose alive flag is already false', () => {
    const ptys = [makeFakePty(FAKE_PID), makeFakePty(FAKE_PID)];
    let i = 0;
    vi.mocked(spawnLocalPty).mockImplementation(() => ptys[i++]!);
    const registry = new PtyRegistry(
      () => undefined,
      () => undefined,
    );
    const s1 = registry.create({
      providerId: 'test',
      command: 'shell',
      args: [],
      cwd: '/tmp',
      cols: 80,
      rows: 24,
      sessionId: 'alive',
    });
    const s2 = registry.create({
      providerId: 'test',
      command: 'shell',
      args: [],
      cwd: '/tmp',
      cols: 80,
      rows: 24,
      sessionId: 'dead',
    });
    s2.alive = false;
    registry.killAll();
    expect(ptys[0]?.killCalls).toBe(1);
    expect(ptys[1]?.killCalls).toBe(0);
    expect(s1.id).toBe('alive');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// v1.6.0 Phase 2 — sentinel detection in registry (shell-first mode)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Helper: create a fake PTY that lets us manually emit data and exit events,
 * plus capture the data forwarded to the registry's DataSink.
 */
function makeSentinelTestPty(pid: number = FAKE_PID) {
  let dataHandler: ((d: string) => void) | null = null;
  let exitHandler: ((info: { exitCode: number; signal?: number }) => void) | null = null;

  const pty: FakePty = {
    pid,
    killCalls: 0,
    write: () => undefined,
    resize: () => undefined,
    kill: function (this: FakePty) { this.killCalls += 1; },
    onData: (cb) => {
      dataHandler = cb;
      return () => undefined;
    },
    onExit: (cb) => {
      exitHandler = cb;
      return () => undefined;
    },
  } as FakePty;

  return {
    pty,
    fireData: (d: string) => dataHandler?.(d),
    fireExit: (code: number, signal?: number) =>
      exitHandler?.({ exitCode: code, signal }),
  };
}

describe('PtyRegistry — Phase 2 sentinel detection', () => {
  it('fires onCliExited with parsed exit code when sentinel appears in data (exit 0)', () => {
    const { pty, fireData } = makeSentinelTestPty();
    vi.mocked(spawnLocalPty).mockReturnValue(pty);

    const cliExits: Array<{ sessionId: string; exitCode: number }> = [];
    const registry = new PtyRegistry(
      () => undefined,
      () => undefined,
      {
        onCliExited: (info) => cliExits.push(info),
      },
    );

    const sess = registry.create({
      providerId: 'claude',
      command: 'claude',
      args: [],
      cwd: '/tmp',
      cols: 80,
      rows: 24,
      spawnMode: 'shell-first',
    });

    // Simulate the shell printing the sentinel after the CLI exits with code 0.
    fireData(`CLI done\n${SENTINEL_PREFIX}0${SENTINEL_SUFFIX}\n`);

    expect(cliExits).toHaveLength(1);
    expect(cliExits[0]?.sessionId).toBe(sess.id);
    expect(cliExits[0]?.exitCode).toBe(0);
  });

  it('fires onCliExited with non-zero exit code', () => {
    const { pty, fireData } = makeSentinelTestPty();
    vi.mocked(spawnLocalPty).mockReturnValue(pty);

    const cliExits: Array<{ exitCode: number }> = [];
    const registry = new PtyRegistry(
      () => undefined,
      () => undefined,
      { onCliExited: (info) => cliExits.push(info) },
    );
    registry.create({
      providerId: 'claude',
      command: 'claude',
      args: [],
      cwd: '/tmp',
      cols: 80,
      rows: 24,
      spawnMode: 'shell-first',
    });

    fireData(`\n${SENTINEL_PREFIX}42${SENTINEL_SUFFIX}\n`);

    expect(cliExits).toHaveLength(1);
    expect(cliExits[0]?.exitCode).toBe(42);
  });

  it('strips the sentinel line from data forwarded to the DataSink', () => {
    const { pty, fireData } = makeSentinelTestPty();
    vi.mocked(spawnLocalPty).mockReturnValue(pty);

    const forwarded: string[] = [];
    const registry = new PtyRegistry(
      (_sid, data) => forwarded.push(data),
      () => undefined,
      { onCliExited: () => undefined },
    );
    registry.create({
      providerId: 'claude',
      command: 'claude',
      args: [],
      cwd: '/tmp',
      cols: 80,
      rows: 24,
      spawnMode: 'shell-first',
    });

    fireData(`visible output\n${SENTINEL_PREFIX}0${SENTINEL_SUFFIX}\nshell prompt`);

    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]).not.toContain(SENTINEL_PREFIX);
    expect(forwarded[0]).not.toContain(SENTINEL_SUFFIX);
    // Content before and after sentinel is preserved.
    expect(forwarded[0]).toContain('visible output');
    expect(forwarded[0]).toContain('shell prompt');
  });

  it('does NOT call onCliExited in direct mode even if sentinel-like data appears', () => {
    const { pty, fireData } = makeSentinelTestPty();
    vi.mocked(spawnLocalPty).mockReturnValue(pty);

    const cliExits: unknown[] = [];
    const registry = new PtyRegistry(
      () => undefined,
      () => undefined,
      { onCliExited: (info) => cliExits.push(info) },
    );
    // No spawnMode or explicit 'direct'
    registry.create({
      providerId: 'claude',
      command: 'claude',
      args: [],
      cwd: '/tmp',
      cols: 80,
      rows: 24,
      spawnMode: 'direct',
    });

    // Even if the sentinel text somehow appeared in direct-mode output, it must
    // not trigger onCliExited.
    fireData(`\n${SENTINEL_PREFIX}0${SENTINEL_SUFFIX}\n`);

    expect(cliExits).toHaveLength(0);
  });

  it('direct mode with no spawnMode field: sentinel ignored (default=direct)', () => {
    const { pty, fireData } = makeSentinelTestPty();
    vi.mocked(spawnLocalPty).mockReturnValue(pty);

    const cliExits: unknown[] = [];
    const registry = new PtyRegistry(
      () => undefined,
      () => undefined,
      { onCliExited: (info) => cliExits.push(info) },
    );
    registry.create({
      providerId: 'codex',
      command: 'codex',
      args: [],
      cwd: '/tmp',
      cols: 80,
      rows: 24,
      // spawnMode intentionally omitted — defaults to direct
    });

    fireData(`\n${SENTINEL_PREFIX}0${SENTINEL_SUFFIX}\n`);
    expect(cliExits).toHaveLength(0);
  });

  it('does NOT call forget()/kill() on cli-exited — pane stays alive', () => {
    const { pty, fireData } = makeSentinelTestPty();
    vi.mocked(spawnLocalPty).mockReturnValue(pty);

    const registry = new PtyRegistry(
      () => undefined,
      () => undefined,
      { onCliExited: () => undefined },
    );
    const sess = registry.create({
      providerId: 'claude',
      command: 'claude',
      args: [],
      cwd: '/tmp',
      cols: 80,
      rows: 24,
      spawnMode: 'shell-first',
    });

    fireData(`\n${SENTINEL_PREFIX}0${SENTINEL_SUFFIX}\n`);

    // Session must still be alive and accessible — the shell is still running.
    expect(registry.get(sess.id)).toBeDefined();
    expect(registry.get(sess.id)?.alive).toBe(true);
    expect(pty.killCalls).toBe(0);
  });

  it('sentinel-detected session still records spawnMode=shell-first', () => {
    const { pty } = makeSentinelTestPty();
    vi.mocked(spawnLocalPty).mockReturnValue(pty);

    const registry = new PtyRegistry(
      () => undefined,
      () => undefined,
    );
    const sess = registry.create({
      providerId: 'claude',
      command: 'claude',
      args: [],
      cwd: '/tmp',
      cols: 80,
      rows: 24,
      spawnMode: 'shell-first',
    });

    expect(sess.spawnMode).toBe('shell-first');
  });

  it('direct-mode session records spawnMode=direct', () => {
    const { pty } = makeSentinelTestPty();
    vi.mocked(spawnLocalPty).mockReturnValue(pty);

    const registry = new PtyRegistry(
      () => undefined,
      () => undefined,
    );
    const sess = registry.create({
      providerId: 'codex',
      command: 'codex',
      args: [],
      cwd: '/tmp',
      cols: 80,
      rows: 24,
      // no spawnMode — default is direct
    });

    expect(sess.spawnMode).toBe('direct');
  });

  it('onCliExited fires notification path (integration: notification sink called on sentinel)', () => {
    const { pty, fireData } = makeSentinelTestPty();
    vi.mocked(spawnLocalPty).mockReturnValue(pty);

    const notifCalls: Array<{ sessionId: string; exitCode: number }> = [];
    const registry = new PtyRegistry(
      () => undefined,
      () => undefined,
      {
        onCliExited: ({ sessionId, exitCode }) => {
          // This simulates what rpc-router.ts does: call pushPtyExitNotification
          // with the same kind/exitCode mapping as the direct-mode onPaneEvent path.
          notifCalls.push({ sessionId, exitCode });
        },
      },
    );
    const sess = registry.create({
      providerId: 'claude',
      command: 'claude',
      args: [],
      cwd: '/tmp',
      cols: 80,
      rows: 24,
      spawnMode: 'shell-first',
    });

    fireData(`\n${SENTINEL_PREFIX}0${SENTINEL_SUFFIX}\n`);

    expect(notifCalls).toHaveLength(1);
    expect(notifCalls[0]?.sessionId).toBe(sess.id);
    expect(notifCalls[0]?.exitCode).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// v1.6.0 Phase 2 — direct-mode regression guard
// Verifies that the PTY-exit path (onExit → onPaneEvent) is UNCHANGED for
// direct-mode sessions — no sentinel processing, no onCliExited calls.
// ─────────────────────────────────────────────────────────────────────────────

describe('PtyRegistry — Phase 2 direct-mode regression guard', () => {
  it('direct mode: onPaneEvent fires on PTY exit (unchanged behavior)', () => {
    // Use a container object so TypeScript control-flow narrowing doesn't
    // restrict the call at the bottom of the test to `never`.
    const state: { exitHandler: ((info: { exitCode: number; signal?: number }) => void) | null } =
      { exitHandler: null };
    const pty = makeFakePty(FAKE_PID);
    pty.onExit = (cb) => {
      state.exitHandler = (info) => cb(info);
      return () => undefined;
    };
    vi.mocked(spawnLocalPty).mockReturnValue(pty);

    const paneEvents: Array<{ kind: string; exitCode?: number }> = [];
    const cliExitsCalled: unknown[] = [];

    const registry = new PtyRegistry(
      () => undefined,
      () => undefined,
      {
        onPaneEvent: (ev) => paneEvents.push({ kind: ev.kind, exitCode: ev.exitCode }),
        onCliExited: (info) => cliExitsCalled.push(info),
      },
    );
    registry.create({
      providerId: 'codex',
      command: 'codex',
      args: [],
      cwd: '/tmp',
      cols: 80,
      rows: 24,
      // no spawnMode — direct
    });

    // Simulate PTY exit (the shell/CLI dying in direct mode)
    state.exitHandler?.({ exitCode: 0 });

    // onPaneEvent fires twice: 'started' at create(), then 'exited' at PTY exit.
    // We only care that an 'exited' event appeared (direct-mode PTY-exit path unchanged).
    const exitedEvents = paneEvents.filter((e) => e.kind === 'exited');
    expect(exitedEvents).toHaveLength(1);
    expect(exitedEvents[0]?.exitCode).toBe(0);

    // onCliExited must NOT have fired
    expect(cliExitsCalled).toHaveLength(0);
  });
});
