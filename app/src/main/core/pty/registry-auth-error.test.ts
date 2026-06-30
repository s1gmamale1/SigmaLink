// Task 5: registry auth-error scan wiring tests.
//
// Verifies that registry.onData detects codex auth-error signatures, fires the
// onCodexAuthError callback, populates the authErrors map, and that non-codex
// panes are NOT scanned.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

const FAKE_PID = 888_000;

function makeFakePty(): PtyHandle & { fireData: (s: string) => void } {
  const dataSubs: Array<(s: string) => void> = [];
  return {
    pid: FAKE_PID,
    write: () => undefined,
    resize: () => undefined,
    kill: () => undefined,
    onData: (cb: (s: string) => void) => {
      dataSubs.push(cb);
      return () => { const i = dataSubs.indexOf(cb); if (i >= 0) dataSubs.splice(i, 1); };
    },
    onExit: () => () => undefined,
    fireData: (s: string) => { for (const cb of dataSubs) cb(s); },
  };
}

const realKill = process.kill.bind(process);

beforeEach(() => {
  processTreeMock.inspectProcessTree.mockReturnValue({ rootPid: FAKE_PID, supported: false, nodes: [], descendantPids: [], rssBytes: 0 });
  processTreeMock.stopProcessTree.mockReturnValue({ rootPid: FAKE_PID, supported: false, nodes: [], descendantPids: [], rssBytes: 0 });
  processTreeMock.stopProcessTrees.mockReturnValue({ snapshots: [], stoppedPids: [] });
  // Silence process.kill during tests (fake pid is out of range).
  process.kill = (() => true) as typeof process.kill;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  process.kill = realKill;
  vi.clearAllMocks();
});

describe('PtyRegistry — codex auth-error scan (Task 5)', () => {
  it('fires onCodexAuthError and populates authErrors on token_expired chunk', () => {
    const fakePty = makeFakePty();
    vi.mocked(spawnLocalPty).mockReturnValue(fakePty);

    const authErrorCalls: Array<{ sessionId: string; err: { kind: string; atMs: number } }> = [];
    const registry = new PtyRegistry(
      () => undefined,
      () => undefined,
      {
        onCodexAuthError: (sessionId, err) => { authErrorCalls.push({ sessionId, err }); },
      },
    );

    const sess = registry.create({
      providerId: 'codex',
      command: 'codex',
      args: [],
      cwd: '/home/user',
      cols: 120,
      rows: 32,
    });

    fakePty.fireData('Authenticating... error: token_expired\n');

    expect(authErrorCalls).toHaveLength(1);
    expect(authErrorCalls[0]!.sessionId).toBe(sess.id);
    expect(authErrorCalls[0]!.err.kind).toBe('token_expired');
    expect(typeof authErrorCalls[0]!.err.atMs).toBe('number');

    const snap = registry.authErrorSnapshot();
    expect(snap.get(sess.id)).toEqual({ kind: 'token_expired', atMs: authErrorCalls[0]!.err.atMs });
  });

  it('only fires the callback once per session even with multiple matching chunks', () => {
    const fakePty = makeFakePty();
    vi.mocked(spawnLocalPty).mockReturnValue(fakePty);

    const calls: string[] = [];
    const registry = new PtyRegistry(
      () => undefined,
      () => undefined,
      { onCodexAuthError: (_sid, err) => { calls.push(err.kind); } },
    );

    registry.create({ providerId: 'codex', command: 'codex', args: [], cwd: '/', cols: 80, rows: 24 });

    fakePty.fireData('error: token_expired');
    fakePty.fireData('refresh token already used'); // second chunk — should be ignored
    fakePty.fireData('HTTP 401');                   // third chunk  — should be ignored

    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe('token_expired');
  });

  it('does NOT scan non-codex panes', () => {
    const fakePty = makeFakePty();
    vi.mocked(spawnLocalPty).mockReturnValue(fakePty);

    const calls: string[] = [];
    const registry = new PtyRegistry(
      () => undefined,
      () => undefined,
      { onCodexAuthError: (_sid, err) => { calls.push(err.kind); } },
    );

    // Claude pane — must NOT be scanned.
    const sess = registry.create({
      providerId: 'claude',
      command: 'claude',
      args: [],
      cwd: '/',
      cols: 80,
      rows: 24,
    });

    fakePty.fireData('token_expired in some output');

    expect(calls).toHaveLength(0);
    expect(registry.authErrorSnapshot().get(sess.id)).toBeUndefined();
  });

  it('authErrors entry is cleared on forget()', () => {
    const fakePty = makeFakePty();
    vi.mocked(spawnLocalPty).mockReturnValue(fakePty);

    const registry = new PtyRegistry(() => undefined, () => undefined);
    const sess = registry.create({ providerId: 'codex', command: 'codex', args: [], cwd: '/', cols: 80, rows: 24 });

    fakePty.fireData('HTTP 401 Unauthorized');
    expect(registry.authErrorSnapshot().size).toBe(1);

    // Mark session dead (so forget() does not try to kill a real PID).
    sess.alive = false;
    registry.forget(sess.id);

    expect(registry.authErrorSnapshot().size).toBe(0);
  });

  it('detects refresh_reused kind', () => {
    const fakePty = makeFakePty();
    vi.mocked(spawnLocalPty).mockReturnValue(fakePty);

    const calls: Array<{ kind: string }> = [];
    const registry = new PtyRegistry(
      () => undefined,
      () => undefined,
      { onCodexAuthError: (_sid, err) => { calls.push({ kind: err.kind }); } },
    );

    registry.create({ providerId: 'codex', command: 'codex', args: [], cwd: '/', cols: 80, rows: 24 });
    fakePty.fireData('Auth: refresh token already used');

    expect(calls).toEqual([{ kind: 'refresh_reused' }]);
  });
});
