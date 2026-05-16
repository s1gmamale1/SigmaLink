// @vitest-environment jsdom
//
// V1.4.2 packet-03 (Layer 1 + Layer 2) — terminal-cache coverage.
//
// The cache is a renderer module-singleton that keeps xterm `Terminal`
// instances alive across React unmount cycles so PTY scrollback survives
// room + workspace switches. Critical correctness properties:
//
//   - Layer 1 race-safety: bytes arriving on the pty-data bus BEFORE the
//     snapshot RPC resolves are NOT lost. They buffer locally and drain
//     after the snapshot write in arrival order.
//   - Cache hit semantics: a second `getOrCreateTerminal(sessionId, …)`
//     returns the SAME `Terminal` instance and does NOT issue a second
//     `rpc.pty.snapshot` call (the existing scrollback is authoritative).
//   - `destroy(sessionId)` actually disposes the xterm AND tears down the
//     pty-data subscription so the next mount creates a fresh entry.
//
// `@xterm/xterm` is mocked because its real implementation needs a full
// DOM + canvas (xterm 5 still triggers `getBoundingClientRect` math on
// `open()`) and is overkill for these contract assertions.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---- mocks ----------------------------------------------------------------

interface MockTerm {
  __id: string;
  __writes: string[];
  element: HTMLElement | undefined;
  open: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  loadAddon: ReturnType<typeof vi.fn>;
  onData: ReturnType<typeof vi.fn>;
  cols: number;
  rows: number;
  focus: ReturnType<typeof vi.fn>;
  __ctorArg: unknown;
}

let nextTermId = 0;
const createdTerms: MockTerm[] = [];

vi.mock('@xterm/xterm', () => {
  class Terminal {
    __id: string;
    __writes: string[] = [];
    element: HTMLElement | undefined = undefined;
    cols = 80;
    rows = 24;
    __ctorArg: unknown;
    open = vi.fn((parent: HTMLElement) => {
      // Mimic xterm's behaviour: append a child to the provided parent
      // and surface it via `term.element`.
      const el = document.createElement('div');
      el.setAttribute('data-mock-xterm', this.__id);
      parent.appendChild(el);
      this.element = el;
    });
    write = vi.fn((data: string) => {
      this.__writes.push(data);
    });
    dispose = vi.fn(() => {
      if (this.element?.parentNode) {
        this.element.parentNode.removeChild(this.element);
      }
      this.element = undefined;
    });
    loadAddon = vi.fn();
    onData = vi.fn(() => ({ dispose: vi.fn() }));
    focus = vi.fn();
    constructor(opts: unknown) {
      this.__ctorArg = opts;
      this.__id = `t${++nextTermId}`;
      createdTerms.push(this as unknown as MockTerm);
    }
  }
  return { Terminal };
});

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit = vi.fn();
  },
}));

vi.mock('@xterm/addon-web-links', () => ({
  // The ctor accepts a click handler we don't exercise in these tests; we
  // ignore arguments rather than name them to silence no-unused-vars.
  WebLinksAddon: class {},
}));

// `@xterm/xterm/css/xterm.css` import in terminal-cache.ts side-channel
// (we don't import the .ts module's css — the cache module does NOT import
// the css, only Terminal.tsx does — confirmed by reading the source).

// ---- rpc + window.sigma stubs --------------------------------------------

type EventCb = (payload: unknown) => void;

interface SnapshotResolver {
  resolve: (value: { buffer: string }) => void;
  reject: (err: Error) => void;
}

let snapshotControllers: Map<string, SnapshotResolver> = new Map();
type SnapshotFn = (sessionId: string) => Promise<{ buffer: string }>;
let snapshotMock: ReturnType<typeof vi.fn<SnapshotFn>>;

vi.mock('@/renderer/lib/rpc', () => {
  return {
    rpc: {
      pty: {
        snapshot: (sessionId: string) => snapshotMock(sessionId),
        write: vi.fn(() => Promise.resolve()),
        resize: vi.fn(() => Promise.resolve()),
        kill: vi.fn(() => Promise.resolve()),
      },
      kv: { get: vi.fn(() => Promise.resolve('1')) },
      browser: {
        getState: vi.fn(),
        navigate: vi.fn(),
        openTab: vi.fn(),
      },
    },
    rpcSilent: {
      kv: { get: vi.fn(() => Promise.resolve('1')) },
      browser: {
        getState: vi.fn(),
        navigate: vi.fn(),
        openTab: vi.fn(),
      },
    },
  };
});

interface SigmaStub {
  eventOn: ReturnType<typeof vi.fn<(event: string, cb: EventCb) => () => void>>;
  emit: (event: string, payload: unknown) => void;
}

function installSigmaStub(): SigmaStub {
  const handlers = new Map<string, Set<EventCb>>();
  const eventOn = vi.fn((event: string, cb: EventCb) => {
    let set = handlers.get(event);
    if (!set) {
      set = new Set();
      handlers.set(event, set);
    }
    set.add(cb);
    return () => {
      handlers.get(event)?.delete(cb);
    };
  });
  const emit = (event: string, payload: unknown) => {
    handlers.get(event)?.forEach((fn) => fn(payload));
  };
  (window as unknown as { sigma: unknown }).sigma = { eventOn };
  return { eventOn, emit };
}

let sigma: SigmaStub;

beforeEach(async () => {
  nextTermId = 0;
  createdTerms.length = 0;
  snapshotControllers = new Map();
  snapshotMock = vi.fn((sessionId: string) => {
    return new Promise<{ buffer: string }>((resolve, reject) => {
      snapshotControllers.set(sessionId, { resolve, reject });
    });
  });
  sigma = installSigmaStub();
  const busMod = await import('./pty-data-bus');
  busMod.__resetPtyDataBus();
  const cacheMod = await import('./terminal-cache');
  cacheMod.__resetTerminalCache();
});

afterEach(() => {
  delete (window as unknown as { sigma?: unknown }).sigma;
});

function emitData(sessionId: string, data: string): void {
  sigma.emit('pty:data', { sessionId, data });
}

const ctx = {
  wsIdRef: { current: undefined as string | undefined },
  routeLinkClick: vi.fn(),
};

// ---- tests ----------------------------------------------------------------

describe('terminal-cache — Layer 1 race + Layer 2 instance preservation', () => {
  it('preserves PTY chunks emitted BEFORE snapshot resolves (Layer 1 race fix)', async () => {
    const { getOrCreateTerminal } = await import('./terminal-cache');

    const entry = getOrCreateTerminal('sess-1', ctx);
    const term = entry.terminal as unknown as MockTerm;

    // Live bus subscription should already be installed synchronously —
    // a chunk arriving NOW must be captured even though the snapshot RPC
    // has not yet resolved.
    emitData('sess-1', 'pre-snapshot-chunk-A');
    emitData('sess-1', 'pre-snapshot-chunk-B');

    // At this point we should have written NOTHING yet — pending chunks
    // are buffered so the snapshot prefix lands first when it arrives.
    expect(term.__writes).toEqual([]);

    // Resolve the snapshot.
    snapshotControllers.get('sess-1')?.resolve({ buffer: 'SNAP-PREFIX' });
    // Let microtasks drain.
    await Promise.resolve();
    await Promise.resolve();

    // Expected order: snapshot prefix first, then the two pending chunks.
    expect(term.__writes).toEqual([
      'SNAP-PREFIX',
      'pre-snapshot-chunk-A',
      'pre-snapshot-chunk-B',
    ]);

    // A chunk arriving AFTER the drain bypasses the buffer entirely.
    emitData('sess-1', 'post-drain-chunk-C');
    expect(term.__writes[term.__writes.length - 1]).toBe('post-drain-chunk-C');
  });

  it('survives a rejected snapshot — pending chunks still drain (no byte loss)', async () => {
    const { getOrCreateTerminal } = await import('./terminal-cache');
    const entry = getOrCreateTerminal('sess-2', ctx);
    const term = entry.terminal as unknown as MockTerm;

    emitData('sess-2', 'chunk-X');
    emitData('sess-2', 'chunk-Y');

    // Snapshot fails (e.g. session was forgotten in the main process).
    snapshotControllers.get('sess-2')?.reject(new Error('forgot'));
    await Promise.resolve();
    await Promise.resolve();

    // The two pre-snapshot chunks STILL land — Layer 1 contract.
    expect(term.__writes).toEqual(['chunk-X', 'chunk-Y']);
  });

  it('returns the same Terminal instance on cache hit and does NOT re-fire snapshot RPC', async () => {
    const { getOrCreateTerminal } = await import('./terminal-cache');

    const first = getOrCreateTerminal('sess-3', ctx);
    // Resolve the first snapshot so the async IIFE doesn't leave the
    // microtask queue dirty between calls.
    snapshotControllers.get('sess-3')?.resolve({ buffer: 'X' });
    await Promise.resolve();
    await Promise.resolve();

    const second = getOrCreateTerminal('sess-3', ctx);
    expect(second.terminal).toBe(first.terminal);
    // Snapshot RPC fired exactly once — the second call short-circuited
    // because the cache hit and the existing scrollback is authoritative.
    expect(snapshotMock).toHaveBeenCalledTimes(1);
  });

  it('keeps writing PTY chunks while detached from any host (Layer 2 contract)', async () => {
    const { getOrCreateTerminal, detachFromHost } = await import('./terminal-cache');
    const host = document.createElement('div');
    document.body.appendChild(host);

    const entry = getOrCreateTerminal('sess-4', ctx);
    const term = entry.terminal as unknown as MockTerm;
    snapshotControllers.get('sess-4')?.resolve({ buffer: '' });
    await Promise.resolve();
    await Promise.resolve();

    // Simulate React mount.
    const { attachToHost } = await import('./terminal-cache');
    attachToHost(entry, host);
    emitData('sess-4', 'mounted-1');
    expect(term.__writes).toContain('mounted-1');

    // Simulate React unmount.
    detachFromHost(entry);
    emitData('sess-4', 'detached-1');
    emitData('sess-4', 'detached-2');

    // Bytes still land in the cached terminal even with no host attached.
    expect(term.__writes).toContain('detached-1');
    expect(term.__writes).toContain('detached-2');
  });

  it('moves the xterm DOM root between hosts on remount (no replay)', async () => {
    const { getOrCreateTerminal, attachToHost, detachFromHost } = await import('./terminal-cache');
    const hostA = document.createElement('div');
    const hostB = document.createElement('div');
    document.body.appendChild(hostA);
    document.body.appendChild(hostB);

    const entry = getOrCreateTerminal('sess-5', ctx);
    const term = entry.terminal as unknown as MockTerm;
    snapshotControllers.get('sess-5')?.resolve({ buffer: 'INIT' });
    await Promise.resolve();
    await Promise.resolve();

    attachToHost(entry, hostA);
    expect(term.element?.parentNode).toBe(hostA);

    detachFromHost(entry);
    expect(term.element?.parentNode).not.toBe(hostA);

    attachToHost(entry, hostB);
    expect(term.element?.parentNode).toBe(hostB);

    // Critical: the xterm instance was NEVER disposed across the swap.
    expect(term.dispose).not.toHaveBeenCalled();
  });

  it('destroy(sessionId) disposes xterm + tears down the bus subscription', async () => {
    const { getOrCreateTerminal, destroy, hasCached } = await import('./terminal-cache');
    const entry = getOrCreateTerminal('sess-6', ctx);
    const term = entry.terminal as unknown as MockTerm;
    snapshotControllers.get('sess-6')?.resolve({ buffer: '' });
    await Promise.resolve();
    await Promise.resolve();

    expect(hasCached('sess-6')).toBe(true);

    destroy('sess-6');
    expect(hasCached('sess-6')).toBe(false);
    expect(term.dispose).toHaveBeenCalledTimes(1);

    // Subsequent bus emits must be no-ops — no error thrown, no write.
    const writesBefore = term.__writes.length;
    expect(() => emitData('sess-6', 'after-destroy')).not.toThrow();
    expect(term.__writes.length).toBe(writesBefore);
  });

  it('writes the pty:exit message into the cached terminal exactly once', async () => {
    const { getOrCreateTerminal } = await import('./terminal-cache');
    const entry = getOrCreateTerminal('sess-7', ctx);
    const term = entry.terminal as unknown as MockTerm;
    snapshotControllers.get('sess-7')?.resolve({ buffer: '' });
    await Promise.resolve();
    await Promise.resolve();

    sigma.emit('pty:exit', { sessionId: 'sess-7', exitCode: 0 });
    sigma.emit('pty:exit', { sessionId: 'sess-7', exitCode: 0 });

    const exitWrites = term.__writes.filter((w) => w.includes('[session exited code=0]'));
    expect(exitWrites.length).toBe(1);
    expect(entry.ptyExited).toBe(true);
  });
});
