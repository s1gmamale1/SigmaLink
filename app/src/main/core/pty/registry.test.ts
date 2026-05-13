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
