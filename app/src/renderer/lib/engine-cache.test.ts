// Engine lifecycle against the REAL TerminalEngine; only the IPC edges
// (rpc, pty buses) are mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const labelReaderMock = vi.hoisted(() => ({
  attachEngineLabelReader: vi.fn(),
  detachLabelReader: vi.fn(),
}));
vi.mock('@/renderer/lib/label-reader', () => labelReaderMock);

const orchestratorMock = vi.hoisted(() => ({
  onAgentLabel: vi.fn(),
  onPrompt: vi.fn(),
  clearPaneTitle: vi.fn(),
  __resetPaneTitleOrchestrator: vi.fn(),
}));
vi.mock('@/renderer/lib/pane-title-orchestrator', () => orchestratorMock);

const rpcMock = vi.hoisted(() => ({
  kv: {
    get: vi.fn(async () => '2500'),
  },
  pty: {
    snapshot: vi.fn(async () => ({ buffer: '' })),
    write: vi.fn(async () => undefined),
    resize: vi.fn(async () => undefined),
  },
}));
vi.mock('@/renderer/lib/rpc', () => ({ rpc: rpcMock, rpcSilent: rpcMock }));

const dataSubs = vi.hoisted(() => new Map<string, (p: { sessionId: string; data: string }) => void>());
const exitSubs = vi.hoisted(() => new Map<string, (p: { sessionId: string; exitCode: number }) => void>());
vi.mock('@/renderer/lib/pty-data-bus', () => ({
  subscribePtyData: (id: string, fn: (p: { sessionId: string; data: string }) => void) => {
    dataSubs.set(id, fn);
    return () => dataSubs.delete(id);
  },
}));
vi.mock('@/renderer/lib/pty-exit-bus', () => ({
  subscribeExit: (id: string, fn: (p: { sessionId: string; exitCode: number }) => void) => {
    exitSubs.set(id, fn);
    return () => exitSubs.delete(id);
  },
}));

import {
  __resetEngineCache,
  destroyEngine,
  getCachedEngine,
  getOrCreateEngine,
  setEngineMounted,
} from './engine-cache';
import { __resetTitleFollow, setTitleFollow } from './pane-title-follow';

function engineText(entry: ReturnType<typeof getOrCreateEngine>): string {
  return entry.engine.logicalLines().map((l) => l.text).join('\n').trimEnd();
}

/** Engine writes are queued — settle parser + the async snapshot IIFE. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 5));
}

beforeEach(() => {
  vi.clearAllMocks();
  dataSubs.clear();
  exitSubs.clear();
  rpcMock.pty.snapshot.mockImplementation(async () => ({ buffer: '' }));
});
afterEach(() => {
  __resetEngineCache();
  __resetTitleFollow();
});

describe('engine-cache', () => {
  it('creates engines with the persisted visible scrollback depth', async () => {
    await Promise.resolve();
    const entry = getOrCreateEngine('scrollback-setting');
    expect(entry.engine.term.options.scrollback).toBe(2500);
  });

  it('trims the oldest DOM-engine rows when parked without dropping the cache or PTY subscription', async () => {
    const sessionId = 'parked-dom';
    const entry = getOrCreateEngine(sessionId);
    setEngineMounted(sessionId, true);
    await settle();

    await new Promise<void>((resolve) => {
      dataSubs.get(sessionId)!({
        sessionId,
        data: Array.from({ length: 2400 }, (_, i) => `line-${i}\r\n`).join(''),
      });
      entry.engine.term.write('', resolve);
    });
    expect(entry.engine.bufferLength).toBeGreaterThan(2032);

    setEngineMounted(sessionId, false);

    expect(entry.mounted).toBe(false);
    expect(entry.engine.bufferLength).toBeLessThanOrEqual(2032);
    expect(engineText(entry)).toContain('line-2399');
    expect(getCachedEngine(sessionId)).toBe(entry);
    expect(dataSubs.has(sessionId)).toBe(true);
  });

  it('HOLDS the parked bound as PTY output keeps arriving, and restores depth on remount', async () => {
    // Regression: trimming once on park is not enough. engine-cache keeps
    // writing live PTY output into parked entries, so the clamp has to STAY
    // in force until the pane is mounted again — otherwise a parked pane
    // regrows straight back to the full configured depth and the memory the
    // trim was supposed to reclaim comes right back.
    const sessionId = 'parked-still-writing';
    const entry = getOrCreateEngine(sessionId);
    setEngineMounted(sessionId, true);
    await settle();

    const feed = (count: number, prefix: string) =>
      new Promise<void>((resolve) => {
        dataSubs.get(sessionId)!({
          sessionId,
          data: Array.from({ length: count }, (_, i) => `${prefix}-${i}\r\n`).join(''),
        });
        entry.engine.term.write('', resolve);
      });

    await feed(2400, 'before');
    expect(entry.engine.bufferLength).toBeGreaterThan(2032);

    setEngineMounted(sessionId, false);
    expect(entry.engine.bufferLength).toBeLessThanOrEqual(2032);

    // Thousands more rows arrive while the pane is still parked.
    await feed(9000, 'while-parked');
    expect(entry.engine.bufferLength).toBeLessThanOrEqual(2032);
    expect(engineText(entry)).toContain('while-parked-8999');

    // Remount lifts the clamp back to the operator-configured depth (2500 via
    // the kv mock) so a visible pane keeps its full history again.
    setEngineMounted(sessionId, true);
    expect(entry.engine.term.options.scrollback).toBe(2500);
    await feed(3000, 'after');
    expect(entry.engine.bufferLength).toBeGreaterThan(2032);
  });

  it('seeds from snapshot then drains pending without duplicating the overlap', async () => {
    let release!: (v: { buffer: string }) => void;
    rpcMock.pty.snapshot.mockImplementation(
      () => new Promise<{ buffer: string }>((r) => (release = r)),
    );
    const entry = getOrCreateEngine('s1');
    // live chunk arrives while the snapshot is in flight, duplicating its tail
    dataSubs.get('s1')!({ sessionId: 's1', data: 'world\r\n' });
    release({ buffer: 'hello world\r\n' });
    await settle();
    expect(entry.snapshotReady).toBe(true);
    expect(engineText(entry)).toBe('hello world');
  });

  it('post-snapshot live chunks write straight through', async () => {
    const entry = getOrCreateEngine('s2');
    await settle();
    dataSubs.get('s2')!({ sessionId: 's2', data: 'streamed' });
    await settle();
    expect(engineText(entry)).toContain('streamed');
  });

  it('pty exit writes the banner once and flags the entry', async () => {
    const entry = getOrCreateEngine('s3');
    await settle();
    exitSubs.get('s3')!({ sessionId: 's3', exitCode: 0 });
    exitSubs.get('s3')!({ sessionId: 's3', exitCode: 0 });
    await settle();
    expect(entry.ptyExited).toBe(true);
    const text = entry.engine.logicalLines().map((l) => l.text).join('\n');
    expect(text.match(/session exited code=0/g)).toHaveLength(1);
  });

  it('DA answers from the engine are stripped before reaching pty.write (SF-3 parity)', async () => {
    getOrCreateEngine('s4');
    await settle();
    dataSubs.get('s4')!({ sessionId: 's4', data: '\x1b[c' }); // hosted app queries DA
    await settle();
    // the engine synthesised a DA reply; the cache must NOT forward it as stdin
    expect(rpcMock.pty.write).not.toHaveBeenCalled();
  });

  it('destroyEngine unsubscribes and disposes; getOrCreate is idempotent', async () => {
    const a = getOrCreateEngine('s5');
    expect(getOrCreateEngine('s5')).toBe(a);
    expect(getCachedEngine('s5')).toBe(a);
    destroyEngine('s5');
    expect(getCachedEngine('s5')).toBeUndefined();
    expect(dataSubs.has('s5')).toBe(false);
    expect(exitSubs.has('s5')).toBe(false);
  });
});

describe('engine-cache label-reader wiring', () => {
  it('attaches a label reader on create and detaches on destroy', async () => {
    labelReaderMock.attachEngineLabelReader.mockClear();
    labelReaderMock.detachLabelReader.mockClear();
    const entry = getOrCreateEngine('lbl-1');
    expect(labelReaderMock.attachEngineLabelReader).toHaveBeenCalledWith('lbl-1', entry.engine);
    destroyEngine('lbl-1');
    expect(labelReaderMock.detachLabelReader).toHaveBeenCalledWith('lbl-1', entry.engine);
  });
});

describe('engine-cache OSC title sink (pane-title-follow gate)', () => {
  it('forwards an OSC 2 title to onAgentLabel by default (agent panes)', async () => {
    getOrCreateEngine('title-1');
    await settle();
    dataSubs.get('title-1')!({ sessionId: 'title-1', data: '\x1b]2;agent rename\x07' });
    await settle();
    expect(orchestratorMock.onAgentLabel).toHaveBeenCalledWith('title-1', 'agent rename');
  });

  it('does NOT forward an OSC 2 title when title-follow is disabled (shell panes)', async () => {
    setTitleFollow('title-2', false);
    getOrCreateEngine('title-2');
    await settle();
    dataSubs.get('title-2')!({ sessionId: 'title-2', data: '\x1b]2;shell auto-title\x07' });
    await settle();
    expect(orchestratorMock.onAgentLabel).not.toHaveBeenCalled();
  });

  it('gate is evaluated at fire time — disabling after creation stops forwarding', async () => {
    getOrCreateEngine('title-3');
    await settle();
    dataSubs.get('title-3')!({ sessionId: 'title-3', data: '\x1b]2;first\x07' });
    await settle();
    expect(orchestratorMock.onAgentLabel).toHaveBeenCalledWith('title-3', 'first');
    orchestratorMock.onAgentLabel.mockClear();
    setTitleFollow('title-3', false);
    dataSubs.get('title-3')!({ sessionId: 'title-3', data: '\x1b]2;second\x07' });
    await settle();
    expect(orchestratorMock.onAgentLabel).not.toHaveBeenCalled();
  });
});
