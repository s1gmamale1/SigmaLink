// @vitest-environment jsdom
//
// V1.4.2 packet-03 (Layer 2) — `<SessionTerminal>` host coverage.
//
// The component is now a thin host on top of the renderer-side terminal-cache
// (see `src/renderer/lib/terminal-cache.ts`). These tests assert the host-side
// contract:
//
//   - Mounting requests the cached terminal for the sessionId.
//   - Unmounting does NOT dispose the cached terminal (parking, not death).
//   - A remount of the same sessionId reuses the same cached entry — closing
//     the "feels frozen after room switch" loop end-to-end at the host layer.
//
// xterm + the cache module are mocked so the tests stay focused on the host
// behaviour without needing a real DOM-canvas-capable xterm.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

// ---- mocks ---------------------------------------------------------------

const attachToHostMock = vi.fn();
const detachFromHostMock = vi.fn();
const getOrCreateTerminalMock = vi.fn();
const snapshotMock = vi.fn();

interface MockTerm {
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
}

const createdTerms: MockTerm[] = [];

vi.mock('@/renderer/lib/terminal-cache', () => ({
  getOrCreateTerminal: (...args: unknown[]) => getOrCreateTerminalMock(...args),
  attachToHost: (...args: unknown[]) => attachToHostMock(...args),
  detachFromHost: (...args: unknown[]) => detachFromHostMock(...args),
}));

vi.mock('@xterm/xterm', () => {
  class Terminal {
    __writes: string[] = [];
    element: HTMLElement | undefined = undefined;
    cols = 80;
    rows = 24;
    open = vi.fn((parent: HTMLElement) => {
      const el = document.createElement('div');
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

    constructor() {
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
  WebLinksAddon: class {},
}));

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    pty: {
      snapshot: (...args: unknown[]) => snapshotMock(...args),
      resize: vi.fn(() => Promise.resolve()),
      write: vi.fn(() => Promise.resolve()),
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
    browser: { getState: vi.fn(), navigate: vi.fn(), openTab: vi.fn() },
  },
}));

vi.mock('@/renderer/app/state', () => ({
  useAppStateSelector: (selector: (s: { activeWorkspace?: { id?: string } }) => unknown) =>
    selector({ activeWorkspace: { id: 'ws-1' } }),
}));

type EventCb = (payload: unknown) => void;

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

// Minimal ResizeObserver polyfill — jsdom doesn't ship one and the host
// component constructs a real instance on mount.
beforeEach(() => {
  globalThis.ResizeObserver = class {
    observe(): void { /* no-op */ }
    unobserve(): void { /* no-op */ }
    disconnect(): void { /* no-op */ }
  } as unknown as typeof ResizeObserver;
  getOrCreateTerminalMock.mockReset();
  attachToHostMock.mockReset();
  detachFromHostMock.mockReset();
  snapshotMock.mockReset();
  createdTerms.length = 0;
  delete (window as unknown as { sigma?: unknown }).sigma;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete (window as unknown as { sigma?: unknown }).sigma;
});

function fakeEntry(sessionId: string) {
  return {
    sessionId,
    terminal: {
      cols: 80,
      rows: 24,
      focus: vi.fn(),
    },
    fitAddon: { fit: vi.fn() },
    ptyExited: false,
  };
}

describe('<SessionTerminal> — Layer 2 host contract', () => {
  it('requests the cached terminal on mount and attaches it to the local container', async () => {
    const entry = fakeEntry('sess-A');
    getOrCreateTerminalMock.mockReturnValue(entry);

    const { SessionTerminal } = await import('./Terminal');
    render(<SessionTerminal sessionId="sess-A" />);

    expect(getOrCreateTerminalMock).toHaveBeenCalledTimes(1);
    const callArgs = getOrCreateTerminalMock.mock.calls[0];
    expect(callArgs[0]).toBe('sess-A');
    // Second arg is the cache context — sanity-check it has the two slots
    // the cache contract demands.
    expect(typeof callArgs[1].routeLinkClick).toBe('function');
    expect(callArgs[1].wsIdRef).toBeTruthy();
    expect(attachToHostMock).toHaveBeenCalledTimes(1);
    expect(attachToHostMock.mock.calls[0][0]).toBe(entry);
  });

  it('parks the cached terminal on unmount instead of disposing it', async () => {
    const entry = fakeEntry('sess-B');
    getOrCreateTerminalMock.mockReturnValue(entry);

    const { SessionTerminal } = await import('./Terminal');
    const { unmount } = render(<SessionTerminal sessionId="sess-B" />);
    unmount();

    expect(detachFromHostMock).toHaveBeenCalledTimes(1);
    expect(detachFromHostMock.mock.calls[0][0]).toBe(entry);
  });

  it('reuses the same cache entry across an unmount/remount cycle for the same sessionId', async () => {
    const entry = fakeEntry('sess-C');
    getOrCreateTerminalMock.mockReturnValue(entry);

    const { SessionTerminal } = await import('./Terminal');
    const first = render(<SessionTerminal sessionId="sess-C" />);
    first.unmount();
    render(<SessionTerminal sessionId="sess-C" />);

    // Two mount cycles → cache lookup fires twice with the same sessionId,
    // and the cache returns the same entry (the mock returns the closed-
    // over `entry` both times). The component MUST NOT dispose between
    // mounts — `detachFromHost` was used, not a dispose call.
    expect(getOrCreateTerminalMock).toHaveBeenCalledTimes(2);
    expect(getOrCreateTerminalMock.mock.calls[0][0]).toBe('sess-C');
    expect(getOrCreateTerminalMock.mock.calls[1][0]).toBe('sess-C');
    expect(attachToHostMock).toHaveBeenCalledTimes(2);
    expect(detachFromHostMock).toHaveBeenCalledTimes(1);
  });

  it('preserves live PTY data emitted while the initial snapshot is still pending', async () => {
    vi.useFakeTimers();
    const sigma = installSigmaStub();

    vi.resetModules();
    vi.doUnmock('@/renderer/lib/terminal-cache');

    const busMod = await import('@/renderer/lib/pty-data-bus');
    busMod.__resetPtyDataBus();
    const cacheMod = await import('@/renderer/lib/terminal-cache');
    cacheMod.__resetTerminalCache();

    snapshotMock.mockImplementation(
      () =>
        new Promise<{ buffer: string }>((resolve) => {
          setTimeout(() => resolve({ buffer: 'SNAP-PREFIX' }), 50);
        }),
    );

    const { SessionTerminal } = await import('./Terminal');
    render(<SessionTerminal sessionId="sess-race" />);

    expect(snapshotMock).toHaveBeenCalledWith('sess-race');
    expect(createdTerms.length).toBe(1);

    sigma.emit('pty:data', { sessionId: 'sess-race', data: 'LIVE-DURING-SNAPSHOT' });
    expect(createdTerms[0].__writes).toEqual([]);

    await vi.advanceTimersByTimeAsync(50);
    await Promise.resolve();

    expect(createdTerms[0].__writes).toEqual(['SNAP-PREFIX', 'LIVE-DURING-SNAPSHOT']);

    sigma.emit('pty:data', { sessionId: 'sess-race', data: 'LIVE-AFTER-SNAPSHOT' });
    expect(createdTerms[0].__writes).toEqual([
      'SNAP-PREFIX',
      'LIVE-DURING-SNAPSHOT',
      'LIVE-AFTER-SNAPSHOT',
    ]);
  });
});
