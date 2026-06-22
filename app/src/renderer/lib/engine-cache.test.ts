// Engine lifecycle against the REAL TerminalEngine; only the IPC edges
// (rpc, pty buses) are mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const labelReaderMock = vi.hoisted(() => ({
  attachEngineLabelReader: vi.fn(),
  detachLabelReader: vi.fn(),
}));
vi.mock('@/renderer/lib/label-reader', () => labelReaderMock);

const rpcMock = vi.hoisted(() => ({
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

import { __resetEngineCache, destroyEngine, getCachedEngine, getOrCreateEngine } from './engine-cache';

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
afterEach(() => __resetEngineCache());

describe('engine-cache', () => {
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
    expect(labelReaderMock.detachLabelReader).toHaveBeenCalledWith('lbl-1');
  });
});
