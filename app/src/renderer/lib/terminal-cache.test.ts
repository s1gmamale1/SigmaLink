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
  onSelectionChange: ReturnType<typeof vi.fn>;
  hasSelection: ReturnType<typeof vi.fn>;
  getSelection: ReturnType<typeof vi.fn>;
  cols: number;
  rows: number;
  focus: ReturnType<typeof vi.fn>;
  attachCustomWheelEventHandler: ReturnType<typeof vi.fn>;
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
    onSelectionChange = vi.fn(() => ({ dispose: vi.fn() }));
    hasSelection = vi.fn(() => false);
    getSelection = vi.fn(() => '');
    focus = vi.fn();
    attachCustomWheelEventHandler = vi.fn();
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

// 2026-06-10 finding 3 — observable WebGL addon lifecycle. The real addon
// needs a GPU context; this mock records construction/dispose so tests can
// assert "contexts ≈ visible panes".
interface MockWebgl {
  dispose: ReturnType<typeof vi.fn>;
  onContextLoss: ReturnType<typeof vi.fn>;
}
const createdWebgls: MockWebgl[] = [];
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    dispose = vi.fn();
    onContextLoss = vi.fn();
    constructor() {
      createdWebgls.push(this as unknown as MockWebgl);
    }
  },
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
  createdWebgls.length = 0;
  snapshotControllers = new Map();
  snapshotMock = vi.fn((sessionId: string) => {
    return new Promise<{ buffer: string }>((resolve, reject) => {
      snapshotControllers.set(sessionId, { resolve, reject });
    });
  });
  sigma = installSigmaStub();
  const busMod = await import('./pty-data-bus');
  busMod.__resetPtyDataBus();
  // PERF-9 — the cache now subscribes to `pty:exit` through the shared exit
  // bus (one global listener). Reset its singleton too so each test starts
  // from a clean fan-out table.
  const exitBusMod = await import('./pty-exit-bus');
  exitBusMod.__resetPtyExitBus();
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

  // ── SF-3 — Device-Attributes responses must NOT reach pty.write ─────────────
  //
  // On OS window focus-switch, a program in the PTY emits a DA query (`\x1b[c`);
  // xterm answers via this same onData channel with `\x1b[?1;2c`. Before the
  // fix that reply was forwarded to pty.write and the shell echoed `1;2c` into
  // every pane's prompt. We drive the captured onData callback directly (this
  // is the exact callback xterm invokes when it answers a DA query) and assert
  // the DA reply is dropped while a normal keystroke still reaches pty.write.
  it('does NOT forward a Primary DA response to pty.write, but DOES forward keystrokes', async () => {
    const { getOrCreateTerminal } = await import('./terminal-cache');
    const { rpc } = await import('./rpc');
    const writeMock = rpc.pty.write as unknown as ReturnType<typeof vi.fn>;
    writeMock.mockClear();

    const entry = getOrCreateTerminal('sess-da-1', ctx);
    const term = entry.terminal as unknown as MockTerm;
    // The cache registered exactly one onData handler — recover it.
    const onDataCb = term.onData.mock.calls[0]?.[0] as (d: string) => void;
    expect(typeof onDataCb).toBe('function');

    // 1) xterm answering a DA query (the focus-switch corruption path).
    onDataCb('\x1b[?1;2c');
    // 2) xterm answering a Secondary DA query.
    onDataCb('\x1b[>0;276;0c');
    // Neither must be written to the pty.
    expect(writeMock).not.toHaveBeenCalled();

    // 3) A normal keystroke MUST still reach the pty unchanged.
    onDataCb('ls -la\n');
    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(writeMock).toHaveBeenCalledWith('sess-da-1', 'ls -la\n');
  });

  it('strips an embedded DA response but forwards the surrounding keystrokes', async () => {
    const { getOrCreateTerminal } = await import('./terminal-cache');
    const { rpc } = await import('./rpc');
    const writeMock = rpc.pty.write as unknown as ReturnType<typeof vi.fn>;
    writeMock.mockClear();

    const entry = getOrCreateTerminal('sess-da-2', ctx);
    const term = entry.terminal as unknown as MockTerm;
    const onDataCb = term.onData.mock.calls[0]?.[0] as (d: string) => void;

    onDataCb('a\x1b[?1;2cb');
    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(writeMock).toHaveBeenCalledWith('sess-da-2', 'ab');
  });

  it('preserves Cursor-Position (R) and Device-Status (n) replies — programs rely on them', async () => {
    const { getOrCreateTerminal } = await import('./terminal-cache');
    const { rpc } = await import('./rpc');
    const writeMock = rpc.pty.write as unknown as ReturnType<typeof vi.fn>;
    writeMock.mockClear();

    const entry = getOrCreateTerminal('sess-da-3', ctx);
    const term = entry.terminal as unknown as MockTerm;
    const onDataCb = term.onData.mock.calls[0]?.[0] as (d: string) => void;

    onDataCb('\x1b[12;5R'); // CPR
    onDataCb('\x1b[0n');    // DSR
    expect(writeMock).toHaveBeenCalledTimes(2);
    expect(writeMock).toHaveBeenNthCalledWith(1, 'sess-da-3', '\x1b[12;5R');
    expect(writeMock).toHaveBeenNthCalledWith(2, 'sess-da-3', '\x1b[0n');
  });
});

// ── SF-3 — pure-function grammar coverage for the DA-response stripper ────────
describe('stripDeviceAttributesResponses (SF-3)', () => {
  it('strips Primary DA reply (\\x1b[?1;2c)', async () => {
    const { stripDeviceAttributesResponses } = await import('./terminal-cache');
    expect(stripDeviceAttributesResponses('\x1b[?1;2c')).toBe('');
  });
  it('strips Secondary DA reply (\\x1b[>…c)', async () => {
    const { stripDeviceAttributesResponses } = await import('./terminal-cache');
    expect(stripDeviceAttributesResponses('\x1b[>0;276;0c')).toBe('');
  });
  it('leaves normal text untouched (fast path: no CSI)', async () => {
    const { stripDeviceAttributesResponses } = await import('./terminal-cache');
    expect(stripDeviceAttributesResponses('ls -la\n')).toBe('ls -la\n');
  });
  it('does NOT strip Cursor-Position-Report (ends in R)', async () => {
    const { stripDeviceAttributesResponses } = await import('./terminal-cache');
    expect(stripDeviceAttributesResponses('\x1b[1;1R')).toBe('\x1b[1;1R');
  });
  it('does NOT strip Device-Status-Report (ends in n)', async () => {
    const { stripDeviceAttributesResponses } = await import('./terminal-cache');
    expect(stripDeviceAttributesResponses('\x1b[0n')).toBe('\x1b[0n');
  });
  it('does NOT strip an arrow-key CSI (\\x1b[A)', async () => {
    const { stripDeviceAttributesResponses } = await import('./terminal-cache');
    expect(stripDeviceAttributesResponses('\x1b[A')).toBe('\x1b[A');
  });
  it('does NOT strip bracketed-paste markers', async () => {
    const { stripDeviceAttributesResponses } = await import('./terminal-cache');
    expect(stripDeviceAttributesResponses('\x1b[200~hi\x1b[201~')).toBe('\x1b[200~hi\x1b[201~');
  });
  it('strips multiple DA replies in one chunk', async () => {
    const { stripDeviceAttributesResponses } = await import('./terminal-cache');
    expect(stripDeviceAttributesResponses('\x1b[?1;2c\x1b[>0;1;0c')).toBe('');
  });
});

// ── 2026-06-10 finding 2 — LRU eviction must skip host-attached terminals ───
describe('terminal-cache — eviction guard (2026-06-10 finding 2)', () => {
  it('never evicts an entry attached to a real host, even when it is the LRU', async () => {
    const { getOrCreateTerminal, attachToHost, hasCached, TERMINAL_CACHE_LIMIT } =
      await import('./terminal-cache');
    const host = document.createElement('div');
    document.body.appendChild(host);

    // Deterministic lastAccessed ordering: advance the clock 1ms per entry.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      const entries = [];
      for (let i = 0; i < TERMINAL_CACHE_LIMIT; i++) {
        entries.push(getOrCreateTerminal(`evict-${i}`, ctx));
        vi.setSystemTime(1_000_000 + (i + 1) * 1000);
      }
      // evict-0 is the LRU — but it is ON-SCREEN (attached to a real host).
      // attachToHost bumps lastAccessed, so re-pin it as oldest afterwards.
      attachToHost(entries[0]!, host);
      entries[0]!.lastAccessed = 0;

      // 33rd entry forces an eviction.
      getOrCreateTerminal('evict-overflow', ctx);

      // The attached LRU survives; the oldest PARKED entry (evict-1) died.
      expect(hasCached('evict-0')).toBe(true);
      expect(hasCached('evict-1')).toBe(false);
      expect(hasCached('evict-overflow')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('exceeds the cap rather than evict when every entry is attached', async () => {
    const { getOrCreateTerminal, attachToHost, getCacheSize, TERMINAL_CACHE_LIMIT } =
      await import('./terminal-cache');
    for (let i = 0; i < TERMINAL_CACHE_LIMIT; i++) {
      const entry = getOrCreateTerminal(`pin-${i}`, ctx);
      const host = document.createElement('div');
      document.body.appendChild(host);
      attachToHost(entry, host);
    }
    getOrCreateTerminal('pin-overflow', ctx);
    // Nothing was destroyable — the cache grows past the cap (bounded by
    // the number of mounted panes), instead of blanking a visible pane.
    expect(getCacheSize()).toBe(TERMINAL_CACHE_LIMIT + 1);
  });
});

// ── 2026-06-10 finding 5b — snapshot ∩ pending dedup (no double-written text) ─
describe('terminal-cache — snapshot drain dedup (2026-06-10 finding 5b)', () => {
  it('drops a pending chunk fully contained in the snapshot tail', async () => {
    const { getOrCreateTerminal } = await import('./terminal-cache');
    const entry = getOrCreateTerminal('dedup-1', ctx);
    const term = entry.terminal as unknown as MockTerm;

    // The chunk reaches the renderer through the live bus AND was already in
    // the main ring buffer when the snapshot was read (the 12ms coalescer
    // window) — i.e. the snapshot ENDS with it.
    emitData('dedup-1', 'AAA');
    snapshotControllers.get('dedup-1')?.resolve({ buffer: 'PREFIX-AAA' });
    await Promise.resolve();
    await Promise.resolve();

    expect(term.__writes).toEqual(['PREFIX-AAA']); // 'AAA' NOT written twice
  });

  it('trims a partial overlap and writes only the unseen suffix', async () => {
    const { getOrCreateTerminal } = await import('./terminal-cache');
    const entry = getOrCreateTerminal('dedup-2', ctx);
    const term = entry.terminal as unknown as MockTerm;

    emitData('dedup-2', 'BBCC'); // 'BB' is already in the snapshot; 'CC' is new
    snapshotControllers.get('dedup-2')?.resolve({ buffer: 'XX-BB' });
    await Promise.resolve();
    await Promise.resolve();

    expect(term.__writes).toEqual(['XX-BB', 'CC']);
  });

  it('handles overlap spanning multiple pending chunks', async () => {
    const { getOrCreateTerminal } = await import('./terminal-cache');
    const entry = getOrCreateTerminal('dedup-3', ctx);
    const term = entry.terminal as unknown as MockTerm;

    emitData('dedup-3', 'AB'); // entirely duplicated
    emitData('dedup-3', 'CD'); // 'C' duplicated, 'D' new
    snapshotControllers.get('dedup-3')?.resolve({ buffer: 'snap:ABC' });
    await Promise.resolve();
    await Promise.resolve();

    expect(term.__writes).toEqual(['snap:ABC', 'D']);
  });
});

// ── 2026-06-10 finding 5a — cache hit refreshes the link-routing context ────
describe('terminal-cache — ctx refresh on cache hit (2026-06-10 finding 5a)', () => {
  it('routes link clicks through the LATEST mount ctx, not the first', async () => {
    const { getOrCreateTerminal } = await import('./terminal-cache');

    const routeA = vi.fn();
    const ctxA = { wsIdRef: { current: 'ws-A' as string | undefined }, routeLinkClick: routeA };
    getOrCreateTerminal('ctx-1', ctxA);

    // Remount with a FRESH ctx (new wsIdRef holder — exactly what a new
    // SessionTerminal mount produces) pointing at a different workspace.
    const routeB = vi.fn();
    const surfaceB = vi.fn();
    const ctxB = {
      wsIdRef: { current: 'ws-B' as string | undefined },
      routeLinkClick: routeB,
      surfaceBrowser: surfaceB,
    };
    getOrCreateTerminal('ctx-1', ctxB);

    // Drive the OSC8 linkHandler captured at construction.
    const opts = createdTerms[0]!.__ctorArg as {
      linkHandler: { activate: (e: unknown, text: string) => void };
    };
    opts.linkHandler.activate(null, 'https://example.com');

    expect(routeB).toHaveBeenCalledWith('https://example.com', 'ws-B', surfaceB);
    expect(routeA).not.toHaveBeenCalled();
  });
});

// ── 2026-06-10 finding 3 — WebGL renderer only while attached to a host ─────
describe('terminal-cache — WebGL attach/detach lifecycle (2026-06-10 finding 3)', () => {
  it('does NOT load the WebGL addon at creation (parked terminals parse buffers only)', async () => {
    const { getOrCreateTerminal } = await import('./terminal-cache');
    getOrCreateTerminal('webgl-1', ctx);
    expect(createdWebgls.length).toBe(0);
  });

  it('loads WebGL on attachToHost and disposes it on detachFromHost', async () => {
    const { getOrCreateTerminal, attachToHost, detachFromHost } =
      await import('./terminal-cache');
    const host = document.createElement('div');
    document.body.appendChild(host);

    const entry = getOrCreateTerminal('webgl-2', ctx);
    attachToHost(entry, host);
    expect(createdWebgls.length).toBe(1);
    // Registered the context-loss self-heal before loading.
    expect(createdWebgls[0]!.onContextLoss).toHaveBeenCalledTimes(1);

    detachFromHost(entry);
    expect(createdWebgls[0]!.dispose).toHaveBeenCalledTimes(1);

    // Re-attach builds a FRESH addon (contexts track visible panes).
    attachToHost(entry, host);
    expect(createdWebgls.length).toBe(2);
  });

  it('attachToHost is idempotent — re-attaching to the same host loads no second addon', async () => {
    const { getOrCreateTerminal, attachToHost } = await import('./terminal-cache');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const entry = getOrCreateTerminal('webgl-3', ctx);
    attachToHost(entry, host);
    attachToHost(entry, host);
    expect(createdWebgls.length).toBe(1);
  });
});

// Spec 2026-06-10 (C) — iTerm2-style select-to-copy. xterm 6 dropped the
// built-in copyOnSelect option, so the cache wires onSelectionChange to this
// pure helper. It pushes any non-empty selection to the system clipboard.
describe('copySelectionToClipboard (spec 2026-06-10 C)', () => {
  it('writes the selection to the clipboard when a selection is present', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    const { copySelectionToClipboard } = await import('./terminal-cache');
    copySelectionToClipboard({
      hasSelection: () => true,
      getSelection: () => 'picked text',
    });
    expect(writeText).toHaveBeenCalledWith('picked text');
  });

  it('does NOT write when there is no selection', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    const { copySelectionToClipboard } = await import('./terminal-cache');
    copySelectionToClipboard({
      hasSelection: () => false,
      getSelection: () => '',
    });
    expect(writeText).not.toHaveBeenCalled();
  });

  it('does NOT write when the selection is empty string', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    const { copySelectionToClipboard } = await import('./terminal-cache');
    copySelectionToClipboard({
      hasSelection: () => true,
      getSelection: () => '',
    });
    expect(writeText).not.toHaveBeenCalled();
  });
});
