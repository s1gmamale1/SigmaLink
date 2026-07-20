// 2026-06-10 PTY lifecycle audit — registry lifecycle races (findings 1, 4, 5).
//
// Finding 1 (HIGH): the graceful-exit timer captured only the session ID. When
// resume/respawn re-created the same DB row id inside the grace window
// (rpc-router passes gracefulExitDelayMs: 3_000), the STALE timer's forget(id)
// fetched the NEW record, unsubscribed its listeners, and killed the freshly
// resumed pane ~3s in. create() also blindly overwrote an existing map entry,
// which (a) enabled that race and (b) let concurrent resumeWorkspacePanes
// calls double-spawn an untracked zombie PTY.
//
// Finding 4: extractSentinel() is per-chunk; a sentinel split across two PTY
// reads never matched, so onCliExited never fired in shell-first mode (the
// DEFAULT since Phase 7). The registry carries a small per-session tail —
// scan-only; forwarded data is never rewritten (Task 4 adds those tests).
//
// Finding 5: the exit pane-event derived kind from `rec?.exitCode === 0`; a
// forgotten-record race reported a clean exit as 'error' with exitCode
// undefined.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock node-pty entirely (mirrors registry.test.ts). resolveEffectiveSpawnMode
// is reproduced as the real pure logic so shell-first resolution is genuine.
vi.mock('./local-pty', () => {
  return {
    spawnLocalPty: vi.fn(),
    resolveEffectiveSpawnMode: (
      spawnMode: 'direct' | 'shell-first' | undefined,
      command: string,
    ): 'direct' | 'shell-first' =>
      spawnMode === 'shell-first' && command !== '' && process.platform !== 'win32'
        ? 'shell-first'
        : 'direct',
  };
});

const processTreeMock = vi.hoisted(() => ({
  inspectProcessTree: vi.fn(),
  stopProcessTree: vi.fn(),
  stopProcessTrees: vi.fn(),
}));
vi.mock('../process/process-tree', () => processTreeMock);

import { spawnLocalPty } from './local-pty';
import { PtyRegistry } from './registry';
import type { PtyHandle } from './local-pty';
import { SENTINEL_PREFIX, SENTINEL_SUFFIX } from './sentinel';

interface FakePty extends PtyHandle {
  killCalls: number;
}

const FAKE_PID = 999_999_999; // way outside any real PID range
const realKill = process.kill.bind(process);

beforeEach(() => {
  processTreeMock.stopProcessTree.mockImplementation((rootPid: number) => ({
    rootPid,
    supported: false,
    nodes: [],
    descendantPids: [],
    rssBytes: 0,
  }));
  processTreeMock.stopProcessTrees.mockImplementation((rootPids: number[]) => ({
    snapshots: rootPids.map((rootPid) => ({
      rootPid,
      supported: false,
      nodes: [],
      descendantPids: [],
      rssBytes: 0,
    })),
    stoppedPids: [],
  }));
  // Intercept process.kill so isProcessAlive(FAKE_PID) reports "alive" and a
  // fallback SIGKILL never escapes to a real process (mirrors registry.test.ts).
  process.kill = ((pid: number, signal?: number | string) => {
    if (pid === FAKE_PID) return true;
    return realKill(pid, signal as NodeJS.Signals);
  }) as typeof process.kill;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  process.kill = realKill;
  vi.clearAllMocks();
});

/**
 * Fake PTY with manually-fireable data/exit events.
 * `disconnectOnUnsub: true` (default) models a REAL unsubscribe (handler
 * detached) — used to assert that forget()/clean-replace tears listeners down.
 * `disconnectOnUnsub: false` models an event already in flight when the
 * unsubscribe ran (node-pty exit callbacks can race forget()).
 */
function makeLifecyclePty(opts: { disconnectOnUnsub?: boolean } = {}) {
  const disconnect = opts.disconnectOnUnsub ?? true;
  let dataHandler: ((d: string) => void) | null = null;
  let exitHandler: ((info: { exitCode: number; signal?: number }) => void) | null = null;
  const pty: FakePty = {
    pid: FAKE_PID,
    killCalls: 0,
    write: () => undefined,
    resize: () => undefined,
    kill: function (this: FakePty) {
      this.killCalls += 1;
    },
    onData: (cb) => {
      dataHandler = cb;
      return () => {
        if (disconnect) dataHandler = null;
      };
    },
    onExit: (cb) => {
      exitHandler = cb;
      return () => {
        if (disconnect) exitHandler = null;
      };
    },
  } as FakePty;
  return {
    pty,
    fireData: (d: string) => dataHandler?.(d),
    fireExit: (code: number, signal?: number) => exitHandler?.({ exitCode: code, signal }),
    hasDataHandler: () => dataHandler !== null,
  };
}

const baseInput = {
  providerId: 'claude',
  command: 'claude',
  args: [] as string[],
  cwd: '/tmp',
  cols: 80,
  rows: 24,
};

describe('graceful-exit timer vs resume-overwrite race (finding 1)', () => {
  it('a stale graceful-exit timer does NOT forget a record re-created inside the grace window', () => {
    const first = makeLifecyclePty();
    const second = makeLifecyclePty();
    const handles = [first, second];
    let i = 0;
    vi.mocked(spawnLocalPty).mockImplementation(() => handles[i++]!.pty);
    const registry = new PtyRegistry(() => undefined, () => undefined, {
      gracefulExitDelayMs: 3_000, // mirrors rpc-router.ts:491
    });

    registry.create({ ...baseInput, sessionId: 'pane-1', isResume: true });
    // PTY exits → the 3s graceful-exit timer is armed for THIS record.
    first.fireExit(0);
    expect(registry.get('pane-1')?.alive).toBe(false);

    // 1s later the resume path re-creates the SAME DB row id. The
    // already-running guard (resume-launcher.ts `live?.alive`) passes for
    // exited-but-unforgotten records, so this IS the live production path.
    vi.advanceTimersByTime(1_000);
    const resumed = registry.create({ ...baseInput, sessionId: 'pane-1', isResume: true });
    expect(resumed.alive).toBe(true);

    // t=3s: the STALE timer fires. It must bail — not unsubscribe listeners /
    // kill the freshly resumed record.
    vi.advanceTimersByTime(2_100);
    expect(registry.get('pane-1')).toBe(resumed);
    expect(registry.get('pane-1')?.alive).toBe(true);
    expect(second.pty.killCalls).toBe(0);
  });

  it('create() throws on a duplicate id whose record is still ALIVE and does not spawn a second PTY', () => {
    const first = makeLifecyclePty();
    vi.mocked(spawnLocalPty).mockReturnValue(first.pty);
    const registry = new PtyRegistry(() => undefined, () => undefined);
    const original = registry.create({ ...baseInput, sessionId: 'pane-dup' });
    expect(original.alive).toBe(true);

    vi.mocked(spawnLocalPty).mockClear();
    expect(() => registry.create({ ...baseInput, sessionId: 'pane-dup' })).toThrow(
      /already has a live PTY/,
    );
    // The guard must run BEFORE spawnLocalPty — no orphan child process.
    expect(spawnLocalPty).not.toHaveBeenCalled();
    // The original record is untouched.
    expect(registry.get('pane-dup')).toBe(original);
  });

  it('create() over an EXITED-but-unforgotten record clean-replaces it (old listeners detached)', () => {
    const first = makeLifecyclePty();
    const second = makeLifecyclePty();
    const handles = [first, second];
    let i = 0;
    vi.mocked(spawnLocalPty).mockImplementation(() => handles[i++]!.pty);
    const forwarded: string[] = [];
    const registry = new PtyRegistry(
      (_sid, data) => forwarded.push(data),
      () => undefined,
      { gracefulExitDelayMs: 3_000 },
    );

    registry.create({ ...baseInput, sessionId: 'pane-2', isResume: true });
    first.fireExit(1); // dead, inside the grace window
    const replacement = registry.create({ ...baseInput, sessionId: 'pane-2', isResume: true });

    expect(registry.get('pane-2')).toBe(replacement);
    // The OLD record's data listener was unsubscribed by the clean-replace.
    expect(first.hasDataHandler()).toBe(false);
    // Late data from the old PTY no longer reaches the data sink.
    first.fireData('ghost bytes');
    expect(forwarded).not.toContain('ghost bytes');
  });
});

describe('exit pane-event kind hardening (finding 5)', () => {
  it("reports kind 'exited' + exitCode 0 even when the record was already forgotten", () => {
    // disconnectOnUnsub:false models node-pty's exit event already in flight
    // when forget() unsubscribed (e.g. stop({forget:true}) racing the exit).
    const fake = makeLifecyclePty({ disconnectOnUnsub: false });
    vi.mocked(spawnLocalPty).mockReturnValue(fake.pty);
    const events: Array<{ kind: string; exitCode?: number }> = [];
    const registry = new PtyRegistry(() => undefined, () => undefined, {
      onPaneEvent: (e) => events.push({ kind: e.kind, exitCode: e.exitCode }),
    });
    const sess = registry.create({ ...baseInput, sessionId: 'pane-evt' });
    sess.alive = false; // keep forget() off the kill path — exit raced it
    registry.forget('pane-evt');
    fake.fireExit(0);

    const exitEvent = events.find((e) => e.kind === 'exited' || e.kind === 'error');
    expect(exitEvent?.kind).toBe('exited'); // a clean exit must not read as a crash
    expect(exitEvent?.exitCode).toBe(0);
  });
});

describe('account-switch expected-exit suppression (2026-07-14)', () => {
  function createWithPaneEvents() {
    const fake = makeLifecyclePty();
    vi.mocked(spawnLocalPty).mockReturnValue(fake.pty);
    const paneEvents: Array<{ sessionId: string; kind: string }> = [];
    const exitSink: string[] = [];
    const registry = new PtyRegistry(
      () => undefined,
      (id) => exitSink.push(id),
      { onPaneEvent: (e) => paneEvents.push({ sessionId: e.sessionId, kind: e.kind }) },
    );
    registry.create({ ...baseInput, sessionId: 'pane-1' });
    paneEvents.length = 0; // drop the create-time 'started'
    return { fake, registry, paneEvents, exitSink };
  }

  it('markExpectedExit suppresses the exit pane-event but the exit sink still fires', () => {
    const { fake, registry, paneEvents, exitSink } = createWithPaneEvents();
    registry.markExpectedExit('pane-1');
    fake.fireExit(1, 15); // signal-kill shape (the restart flow's kill)
    // pty:exit sink must still fire — the renderer needs it to re-attach.
    expect(exitSink).toEqual(['pane-1']);
    // …but no phantom 'error' pane event reaches jorvis/missions/notifications.
    expect(paneEvents).toEqual([]);
  });

  it('the same exit WITHOUT the flag still reports an error pane-event (baseline)', () => {
    const { fake, paneEvents, exitSink } = createWithPaneEvents();
    fake.fireExit(1, 15);
    expect(exitSink).toEqual(['pane-1']);
    expect(paneEvents).toEqual([{ sessionId: 'pane-1', kind: 'error' }]);
  });

  it('a record re-created after the expected exit starts clean (flag dies with the record)', () => {
    const { fake, registry } = createWithPaneEvents();
    registry.markExpectedExit('pane-1');
    fake.fireExit(1, 15);
    const second = makeLifecyclePty();
    vi.mocked(spawnLocalPty).mockReturnValue(second.pty);
    const resumed = registry.create({ ...baseInput, sessionId: 'pane-1', isResume: true });
    expect(resumed.expectedExit).toBeUndefined();
  });

  it('markExpectedExit on an unknown id is a no-op', () => {
    const fake = makeLifecyclePty();
    vi.mocked(spawnLocalPty).mockReturnValue(fake.pty);
    const registry = new PtyRegistry(() => undefined, () => undefined);
    expect(() => registry.markExpectedExit('nope')).not.toThrow();
  });
});

describe('shell-first sentinel split across PTY reads (finding 4)', () => {
  function createShellFirstSession(
    cliExits: Array<{ sessionId: string; exitCode: number }>,
    forwarded: string[],
  ) {
    const fake = makeLifecyclePty();
    vi.mocked(spawnLocalPty).mockReturnValue(fake.pty);
    const registry = new PtyRegistry(
      (_sid, data) => forwarded.push(data),
      () => undefined,
      { onCliExited: (info) => cliExits.push(info) },
    );
    const sess = registry.create({ ...baseInput, spawnMode: 'shell-first' });
    return { fake, registry, sess };
  }

  it('fires onCliExited when the sentinel is split across two chunks', () => {
    const cliExits: Array<{ sessionId: string; exitCode: number }> = [];
    const { fake, sess } = createShellFirstSession(cliExits, []);

    fake.fireData(`CLI done\n${SENTINEL_PREFIX}`);
    expect(cliExits).toHaveLength(0); // not complete yet
    fake.fireData(`0${SENTINEL_SUFFIX}\n`);

    expect(cliExits).toHaveLength(1);
    expect(cliExits[0]).toEqual({ sessionId: sess.id, exitCode: 0 });
  });

  it('fires onCliExited when the sentinel is split across THREE chunks (multi-chunk carry)', () => {
    const cliExits: Array<{ sessionId: string; exitCode: number }> = [];
    const { fake } = createShellFirstSession(cliExits, []);

    fake.fireData('\n__SIGMALINK');
    fake.fireData('_CLI_EXIT_4');
    fake.fireData('2__\n');

    expect(cliExits).toHaveLength(1);
    expect(cliExits[0]?.exitCode).toBe(42);
  });

  it('forwards both raw halves unchanged (carry is detection-only, never retro-strips)', () => {
    const cliExits: Array<{ sessionId: string; exitCode: number }> = [];
    const forwarded: string[] = [];
    const { fake } = createShellFirstSession(cliExits, forwarded);

    fake.fireData(`CLI done\n${SENTINEL_PREFIX}`);
    fake.fireData(`0${SENTINEL_SUFFIX}\n`);

    // Bytes already forwarded cannot be retracted; the carry must never
    // rewrite the forwarded stream — only detect.
    expect(forwarded).toEqual([`CLI done\n${SENTINEL_PREFIX}`, `0${SENTINEL_SUFFIX}\n`]);
  });

  it('does not false-positive on a partial prefix followed by unrelated text, and still catches a later real sentinel', () => {
    const cliExits: Array<{ sessionId: string; exitCode: number }> = [];
    const { fake } = createShellFirstSession(cliExits, []);

    fake.fireData(`\n${SENTINEL_PREFIX}`);
    fake.fireData('… just ordinary CLI output flowing past the marker prefix, well over the carry cap …');
    expect(cliExits).toHaveLength(0);

    fake.fireData(`\n${SENTINEL_PREFIX}7${SENTINEL_SUFFIX}\n`);
    expect(cliExits).toHaveLength(1);
    expect(cliExits[0]?.exitCode).toBe(7);
  });

  it('whole-chunk sentinels still strip from the forwarded data (existing fast path unchanged)', () => {
    const cliExits: Array<{ sessionId: string; exitCode: number }> = [];
    const forwarded: string[] = [];
    const { fake } = createShellFirstSession(cliExits, forwarded);

    fake.fireData(`visible\n${SENTINEL_PREFIX}0${SENTINEL_SUFFIX}\nprompt`);

    expect(cliExits).toHaveLength(1);
    expect(forwarded[0]).not.toContain(SENTINEL_PREFIX);
    expect(forwarded[0]).toContain('visible');
    expect(forwarded[0]).toContain('prompt');
  });
});

// session-persistence fix (2026-07-18) — quit-time stranding. shutdownRouter
// flags EVERY live session before killAll() so the quit-window SIGTERM exits
// skip the exit classifiers' status writes (rows stay 'running'; the boot
// janitor heals them to exited/-1 and the resume lane picks them up).
describe('markAllExpectedExit (quit-time stranding fix)', () => {
  it('flags every live session so exit classifiers skip the status write', () => {
    const first = makeLifecyclePty();
    const second = makeLifecyclePty();
    const handles = [first, second];
    let i = 0;
    vi.mocked(spawnLocalPty).mockImplementation(() => handles[i++]!.pty);
    const registry = new PtyRegistry(() => undefined, () => undefined);

    const a = registry.create({ ...baseInput, sessionId: 'pane-quit-a' });
    const b = registry.create({ ...baseInput, providerId: 'codex', sessionId: 'pane-quit-b' });
    expect(a.expectedExit).not.toBe(true);
    expect(b.expectedExit).not.toBe(true);

    registry.markAllExpectedExit();

    expect(registry.get('pane-quit-a')?.expectedExit).toBe(true);
    expect(registry.get('pane-quit-b')?.expectedExit).toBe(true);
  });

  it('suppresses the onPaneEvent exit sink for flagged sessions (quit exits are not phantom errors)', () => {
    const fake = makeLifecyclePty();
    vi.mocked(spawnLocalPty).mockReturnValue(fake.pty);
    const events: Array<{ kind: string }> = [];
    const registry = new PtyRegistry(() => undefined, () => undefined, {
      onPaneEvent: (e) => events.push({ kind: e.kind }),
    });
    registry.create({ ...baseInput, sessionId: 'pane-quit-c' });

    registry.markAllExpectedExit();
    // Quit-time SIGTERM: node-pty reports a non-zero exit. Without the flag
    // this fed the pane-event sinks kind 'error'. (create() itself emits
    // 'started' — only exit-kind events must be suppressed.)
    fake.fireExit(143, 15);

    expect(events.filter((e) => e.kind !== 'started')).toHaveLength(0);
  });
});
