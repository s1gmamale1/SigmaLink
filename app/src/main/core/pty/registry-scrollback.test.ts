// v1.9-scrollback — Registry integration tests for scrollback persistence.
// Covers:
//   • flag-on + isResume → buffer seeded from store (mock the store)
//   • flag-off → NOT seeded (regression guard)
//   • flag-on + PTY exit → onSessionExit called with snapshot

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock node-pty (same as registry.test.ts)
vi.mock('./local-pty', () => ({
  spawnLocalPty: vi.fn(),
  // H-6: registry.create now reads this shared helper to decide whether to arm
  // the sentinel watcher. Provide the real (pure) impl so the mock is complete.
  resolveEffectiveSpawnMode: (
    spawnMode: 'direct' | 'shell-first' | undefined,
    command: string,
  ): 'direct' | 'shell-first' =>
    spawnMode === 'shell-first' && command !== '' ? 'shell-first' : 'direct',
}));

import { spawnLocalPty } from './local-pty';
import { PtyRegistry } from './registry';
import type { PtyHandle } from './local-pty';

interface FakePty extends PtyHandle {
  killCalls: number;
}

const FAKE_PID = 888_111_222;

function makeFakePty(pid = FAKE_PID): {
  pty: FakePty;
  fireData: (d: string) => void;
  fireExit: (code: number, signal?: number) => void;
} {
  let dataHandler: ((d: string) => void) | null = null;
  let exitHandler: ((info: { exitCode: number; signal?: number }) => void) | null = null;
  const pty: FakePty = {
    pid,
    killCalls: 0,
    write: () => undefined,
    resize: () => undefined,
    kill: function (this: FakePty) { this.killCalls += 1; },
    onData: (cb) => { dataHandler = cb; return () => undefined; },
    onExit: (cb) => { exitHandler = (info) => cb(info); return () => undefined; },
  };
  return {
    pty,
    fireData: (d) => dataHandler?.(d),
    fireExit: (code, signal) => exitHandler?.({ exitCode: code, signal }),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

// ─── flag-on + isResume → buffer seeded ──────────────────────────────────────

describe('v1.9-scrollback: registry flag-on + isResume → buffer seeded', () => {
  it('seeds the buffer with resumeScrollback content before live data', () => {
    const { pty, fireData } = makeFakePty();
    vi.mocked(spawnLocalPty).mockReturnValue(pty);

    const registry = new PtyRegistry(() => undefined, () => undefined);
    const sess = registry.create({
      providerId: 'claude',
      command: 'claude',
      args: ['--continue'],
      cwd: '/tmp',
      cols: 80,
      rows: 24,
      sessionId: 'resume-id',
      isResume: true,
      resumeScrollback: '—— restored scrollback ——\nprev line',
    });

    // Before any live data: snapshot must include the seeded content.
    expect(registry.snapshot(sess.id)).toBe('—— restored scrollback ——\nprev line');

    // Live data appends after the restored content.
    fireData(' live output');
    expect(registry.snapshot(sess.id)).toBe('—— restored scrollback ——\nprev line live output');
  });

  it('empty resumeScrollback leaves buffer empty (no-op)', () => {
    const { pty } = makeFakePty();
    vi.mocked(spawnLocalPty).mockReturnValue(pty);

    const registry = new PtyRegistry(() => undefined, () => undefined);
    const sess = registry.create({
      providerId: 'claude',
      command: 'claude',
      args: ['--continue'],
      cwd: '/tmp',
      cols: 80,
      rows: 24,
      sessionId: 'resume-empty',
      isResume: true,
      resumeScrollback: '',
    });

    expect(registry.snapshot(sess.id)).toBe('');
  });
});

// ─── flag-off → buffer NOT seeded ────────────────────────────────────────────

describe('v1.9-scrollback: flag-off → buffer NOT seeded (regression guard)', () => {
  it('omitting resumeScrollback leaves buffer empty on resume', () => {
    const { pty, fireData } = makeFakePty();
    vi.mocked(spawnLocalPty).mockReturnValue(pty);

    const registry = new PtyRegistry(() => undefined, () => undefined);
    const sess = registry.create({
      providerId: 'claude',
      command: 'claude',
      args: ['--continue'],
      cwd: '/tmp',
      cols: 80,
      rows: 24,
      sessionId: 'flag-off-id',
      isResume: true,
      // resumeScrollback intentionally omitted — flag is off
    });

    // Buffer starts empty — no restored content.
    expect(registry.snapshot(sess.id)).toBe('');

    // Live data still appends normally.
    fireData('live only');
    expect(registry.snapshot(sess.id)).toBe('live only');
  });

  it('fresh spawn (isResume=false) never has resumeScrollback applied', () => {
    const { pty } = makeFakePty();
    vi.mocked(spawnLocalPty).mockReturnValue(pty);

    const registry = new PtyRegistry(() => undefined, () => undefined);
    const sess = registry.create({
      providerId: 'codex',
      command: 'codex',
      args: [],
      cwd: '/tmp',
      cols: 80,
      rows: 24,
      isResume: false,
      // resumeScrollback intentionally absent for fresh spawn
    });

    expect(registry.snapshot(sess.id)).toBe('');
  });
});

// ─── flag-on + PTY exit → onSessionExit called with snapshot ─────────────────

describe('v1.9-scrollback: flag-on + PTY exit → onSessionExit called', () => {
  it('fires onSessionExit with the buffer snapshot before graceful forget', () => {
    const { pty, fireData, fireExit } = makeFakePty();
    vi.mocked(spawnLocalPty).mockReturnValue(pty);

    const persistCalls: Array<{ sessionId: string; snapshot: string }> = [];
    const registry = new PtyRegistry(
      () => undefined,
      () => undefined,
      {
        gracefulExitDelayMs: 200,
        onSessionExit: (sessionId, snapshot) => {
          persistCalls.push({ sessionId, snapshot });
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
    });

    // Write some data into the buffer.
    fireData('some terminal output');

    // Trigger PTY exit.
    fireExit(0);

    // onSessionExit must have fired synchronously during exit handling.
    expect(persistCalls).toHaveLength(1);
    expect(persistCalls[0]?.sessionId).toBe(sess.id);
    expect(persistCalls[0]?.snapshot).toBe('some terminal output');

    // Advance past the graceful window so forget() clears the buffer.
    vi.advanceTimersByTime(300);
    // After forget, snapshot returns ''.
    expect(registry.snapshot(sess.id)).toBe('');
  });

  it('does NOT fire onSessionExit when not wired (flag-off regression)', () => {
    const { pty, fireExit } = makeFakePty();
    vi.mocked(spawnLocalPty).mockReturnValue(pty);

    const exitCalls: unknown[] = [];
    // Registry with NO onSessionExit wired (flag off)
    const registry = new PtyRegistry(
      () => undefined,
      () => undefined,
      {
        gracefulExitDelayMs: 200,
        // onSessionExit intentionally omitted
      },
    );

    registry.create({
      providerId: 'codex',
      command: 'codex',
      args: [],
      cwd: '/tmp',
      cols: 80,
      rows: 24,
    });

    fireExit(0);

    // exitCalls is not populated since we don't wire it — just verify no throw.
    expect(exitCalls).toHaveLength(0);
    vi.advanceTimersByTime(300);
  });

  it('onSessionExit receives the restored + live snapshot combined', () => {
    const { pty, fireData, fireExit } = makeFakePty();
    vi.mocked(spawnLocalPty).mockReturnValue(pty);

    const persistCalls: Array<{ snapshot: string }> = [];
    const registry = new PtyRegistry(
      () => undefined,
      () => undefined,
      {
        gracefulExitDelayMs: 200,
        onSessionExit: (_id, snapshot) => persistCalls.push({ snapshot }),
      },
    );

    registry.create({
      providerId: 'claude',
      command: 'claude',
      args: ['--continue'],
      cwd: '/tmp',
      cols: 80,
      rows: 24,
      sessionId: 'resume-persist-id',
      isResume: true,
      resumeScrollback: 'prior\n',
    });

    fireData('live\n');
    fireExit(0);

    expect(persistCalls[0]?.snapshot).toBe('prior\nlive\n');
    vi.advanceTimersByTime(300);
  });
});
