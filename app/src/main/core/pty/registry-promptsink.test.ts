// Tests for the promptSink injection into PtyRegistry.
// Verifies that:
//   1. feed(sessionId, data) is called on every data chunk (both direct and
//      shell-first modes, OUTSIDE the shell-first conditional — the call is
//      unconditional after this.onData).
//   2. noteExit(sessionId) is called when the PTY exits.
//   3. A throwing promptSink never breaks the data stream or the exit path.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./local-pty', () => ({
  spawnLocalPty: vi.fn(),
  resolveEffectiveSpawnMode: (
    spawnMode: 'direct' | 'shell-first' | undefined,
    command: string,
  ): 'direct' | 'shell-first' =>
    spawnMode === 'shell-first' && command !== '' && process.platform !== 'win32'
      ? 'shell-first'
      : 'direct',
}));

const processTreeMock = vi.hoisted(() => ({
  inspectProcessTree: vi.fn(),
  stopProcessTree: vi.fn(),
  stopProcessTrees: vi.fn(),
}));
vi.mock('../process/process-tree', () => processTreeMock);

import { spawnLocalPty } from './local-pty';
import { PtyRegistry } from './registry';
import type { PtyHandle } from './local-pty';

const FAKE_PID = 888_777_666;

const realKill = process.kill.bind(process);
beforeEach(() => {
  processTreeMock.inspectProcessTree.mockImplementation((rootPid: number) => ({
    rootPid, supported: false, nodes: [], descendantPids: [], rssBytes: 0,
  }));
  processTreeMock.stopProcessTree.mockImplementation((rootPid: number) => ({
    rootPid, supported: false, nodes: [], descendantPids: [], rssBytes: 0,
  }));
  processTreeMock.stopProcessTrees.mockImplementation((rootPids: number[]) => ({
    snapshots: rootPids.map((rootPid) => ({
      rootPid, supported: false, nodes: [], descendantPids: [], rssBytes: 0,
    })),
    stoppedPids: [],
  }));
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

function makeControllablePty(pid: number = FAKE_PID) {
  let dataHandler: ((d: string) => void) | null = null;
  let exitHandler: ((info: { exitCode: number; signal?: number }) => void) | null = null;

  const pty = {
    pid,
    killCalls: 0,
    write: () => undefined,
    resize: () => undefined,
    kill(this: { killCalls: number }) { this.killCalls += 1; },
    onData(cb: (d: string) => void) {
      dataHandler = cb;
      return () => undefined;
    },
    onExit(cb: (info: { exitCode: number; signal?: number }) => void) {
      exitHandler = cb;
      return () => undefined;
    },
  } as unknown as PtyHandle & { killCalls: number };

  return {
    pty,
    fireData: (d: string) => dataHandler?.(d),
    fireExit: (code: number, signal?: number) => exitHandler?.({ exitCode: code, signal }),
  };
}

describe('PtyRegistry — promptSink injection', () => {
  it('calls promptSink.feed(sessionId, chunk) for each data chunk in direct mode', () => {
    const { pty, fireData } = makeControllablePty();
    vi.mocked(spawnLocalPty).mockReturnValue(pty);

    const promptSink = { feed: vi.fn(), noteExit: vi.fn() };
    const registry = new PtyRegistry(
      () => undefined,
      () => undefined,
      { promptSink },
    );
    const sess = registry.create({
      providerId: 'claude',
      command: 'claude',
      args: [],
      cwd: '/tmp',
      cols: 80,
      rows: 24,
      // direct mode (default)
    });

    fireData('hello world');
    fireData('second chunk');

    expect(promptSink.feed).toHaveBeenCalledTimes(2);
    expect(promptSink.feed).toHaveBeenNthCalledWith(1, sess.id, 'hello world');
    expect(promptSink.feed).toHaveBeenNthCalledWith(2, sess.id, 'second chunk');
    expect(promptSink.noteExit).not.toHaveBeenCalled();
  });

  it('calls promptSink.feed in shell-first mode (feed is OUTSIDE the sentinel conditional)', () => {
    const { pty, fireData } = makeControllablePty();
    vi.mocked(spawnLocalPty).mockReturnValue(pty);

    const promptSink = { feed: vi.fn(), noteExit: vi.fn() };
    const registry = new PtyRegistry(
      () => undefined,
      () => undefined,
      { promptSink, onCliExited: () => undefined },
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

    fireData('output from shell-first pane');

    expect(promptSink.feed).toHaveBeenCalledTimes(1);
    expect(promptSink.feed).toHaveBeenCalledWith(sess.id, 'output from shell-first pane');
  });

  it('calls promptSink.noteExit(sessionId) when the PTY exits', () => {
    const { pty, fireData, fireExit } = makeControllablePty();
    vi.mocked(spawnLocalPty).mockReturnValue(pty);

    const promptSink = { feed: vi.fn(), noteExit: vi.fn() };
    const registry = new PtyRegistry(
      () => undefined,
      () => undefined,
      { promptSink },
    );
    const sess = registry.create({
      providerId: 'claude',
      command: 'claude',
      args: [],
      cwd: '/tmp',
      cols: 80,
      rows: 24,
    });

    fireData('some output');
    expect(promptSink.noteExit).not.toHaveBeenCalled();

    fireExit(0);

    expect(promptSink.noteExit).toHaveBeenCalledTimes(1);
    expect(promptSink.noteExit).toHaveBeenCalledWith(sess.id);
  });

  it('a throwing promptSink.feed never breaks the data stream', () => {
    const { pty, fireData } = makeControllablePty();
    vi.mocked(spawnLocalPty).mockReturnValue(pty);

    const forwarded: string[] = [];
    const promptSink = {
      feed: vi.fn(() => { throw new Error('feed exploded'); }),
      noteExit: vi.fn(),
    };
    const registry = new PtyRegistry(
      (_id, data) => forwarded.push(data),
      () => undefined,
      { promptSink },
    );
    registry.create({
      providerId: 'claude',
      command: 'claude',
      args: [],
      cwd: '/tmp',
      cols: 80,
      rows: 24,
    });

    expect(() => fireData('important data')).not.toThrow();
    // The data must still have been forwarded to the DataSink.
    expect(forwarded).toEqual(['important data']);
  });

  it('a throwing promptSink.noteExit never breaks the exit path', () => {
    const { pty, fireExit } = makeControllablePty();
    vi.mocked(spawnLocalPty).mockReturnValue(pty);

    const exitsSeen: Array<{ sessionId: string; exitCode: number }> = [];
    const promptSink = {
      feed: vi.fn(),
      noteExit: vi.fn(() => { throw new Error('noteExit exploded'); }),
    };
    const registry = new PtyRegistry(
      () => undefined,
      (sessionId, exitCode) => exitsSeen.push({ sessionId, exitCode }),
      { promptSink },
    );
    registry.create({
      providerId: 'claude',
      command: 'claude',
      args: [],
      cwd: '/tmp',
      cols: 80,
      rows: 24,
    });

    expect(() => fireExit(1)).not.toThrow();
    // The standard onExit DataSink still fired.
    expect(exitsSeen).toHaveLength(1);
    expect(exitsSeen[0]?.exitCode).toBe(1);
  });

  it('no promptSink wired: data and exit paths are byte-for-byte unchanged', () => {
    const { pty, fireData, fireExit } = makeControllablePty();
    vi.mocked(spawnLocalPty).mockReturnValue(pty);

    const forwarded: string[] = [];
    const exited: number[] = [];
    const registry = new PtyRegistry(
      (_id, data) => forwarded.push(data),
      (_id, code) => exited.push(code),
      // no promptSink
    );
    registry.create({
      providerId: 'claude',
      command: 'claude',
      args: [],
      cwd: '/tmp',
      cols: 80,
      rows: 24,
    });

    fireData('chunk');
    fireExit(0);

    expect(forwarded).toEqual(['chunk']);
    expect(exited).toEqual([0]);
  });
});
