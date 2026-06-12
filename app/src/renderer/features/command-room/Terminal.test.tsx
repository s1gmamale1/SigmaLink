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
// C-8 — surfaceBrowser wiring:
//   - routeLinkClick with capture ON calls browser RPC AND surfaceBrowser.
//   - routeLinkClick with capture OFF falls back to window.open and does NOT
//     call surfaceBrowser.
//
// xterm + the cache module are mocked so the tests stay focused on the host
// behaviour without needing a real DOM-canvas-capable xterm.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, act, waitFor } from '@testing-library/react';

// ---- mocks ---------------------------------------------------------------

const attachToHostMock = vi.fn();
const detachFromHostMock = vi.fn();
const getOrCreateTerminalMock = vi.fn();
const destroyXtermMock = vi.fn();

vi.mock('@/renderer/lib/terminal-cache', () => ({
  getOrCreateTerminal: (...args: unknown[]) => getOrCreateTerminalMock(...args),
  attachToHost: (...args: unknown[]) => attachToHostMock(...args),
  detachFromHost: (...args: unknown[]) => detachFromHostMock(...args),
  destroy: (...args: unknown[]) => destroyXtermMock(...args),
}));

// P1b — SessionTerminal is now the renderer switch. The DOM host + engine
// cache are mocked away here; this suite is the XTERM-host contract. Since
// v2.4.1 the unset-flag default is 'dom', so the beforeEach kv.get mock
// answers renderer keys with an EXPLICIT 'xterm' (and '1' for everything
// else, the captureLinks gate); the switch then mounts the xterm host. An
// `await act(async () => {})` after each render settles that tick.
const destroyEngineMock = vi.fn();
vi.mock('@/renderer/lib/engine-cache', () => ({
  destroyEngine: (...args: unknown[]) => destroyEngineMock(...args),
}));
vi.mock('./DomTerminalView', () => ({
  // Lightweight stand-in — the real DomTerminalView has its own suite; here we
  // only need to assert the switch mounts IT (not the xterm host) in dom mode.
  DomTerminalView: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="dom-terminal-view" data-session={sessionId} />
  ),
}));

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    pty: {
      resize: vi.fn(() => Promise.resolve()),
      write: vi.fn(() => Promise.resolve()),
    },
    kv: { get: vi.fn(() => Promise.resolve('1')), set: vi.fn(() => Promise.resolve()) },
    browser: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getState: vi.fn(() => Promise.resolve({ workspaceId: 'ws-1', tabs: [], activeTabId: null, lockOwner: null, mcpUrl: null } as any)),
      navigate: vi.fn(() => Promise.resolve()),
      openTab: vi.fn(() => Promise.resolve()),
    },
  },
  rpcSilent: {
    kv: { get: vi.fn(() => Promise.resolve('1')) },
    browser: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getState: vi.fn(() => Promise.resolve({ workspaceId: 'ws-1', tabs: [], activeTabId: null, lockOwner: null, mcpUrl: null } as any)),
      navigate: vi.fn(() => Promise.resolve()),
      openTab: vi.fn(() => Promise.resolve()),
    },
  },
}));

vi.mock('@/renderer/app/state', () => ({
  useAppStateSelector: (selector: (s: { activeWorkspace?: { id?: string } }) => unknown) =>
    selector({ activeWorkspace: { id: 'ws-1' } }),
}));

const setActiveTabMock = vi.fn();

vi.mock('@/renderer/features/right-rail/RightRailContext.data', () => ({
  useRightRail: () => ({ activeTab: 'browser', setActiveTab: setActiveTabMock }),
}));

// Minimal BrowserState-shaped object — only `activeTabId` matters to
// `routeLinkClick`. Cast via `unknown` so TS doesn't demand the full shape.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeState(activeTabId: string | null): any {
  return { workspaceId: 'ws-1', tabs: [], activeTabId, lockOwner: null, mcpUrl: null };
}

type SigmaCb = (payload: unknown) => void;
let sigmaHandlers: Map<string, Set<SigmaCb>>;
const emitSigma = (name: string, payload: unknown = {}) =>
  sigmaHandlers.get(name)?.forEach((fn) => fn(payload));

// Minimal ResizeObserver polyfill — jsdom doesn't ship one and the host
// component constructs a real instance on mount.
beforeEach(async () => {
  globalThis.ResizeObserver = class {
    observe(): void { /* no-op */ }
    unobserve(): void { /* no-op */ }
    disconnect(): void { /* no-op */ }
  } as unknown as typeof ResizeObserver;

  // window.sigma.eventOn registry — terminal-cache loads against it, and the
  // host now subscribes to 'window:restored' through it (pane-refit spec
  // 2026-06-11). emitSigma() drives those subscriptions in tests.
  sigmaHandlers = new Map();
  (globalThis as unknown as { sigma: unknown }).sigma = {
    eventOn: (name: string, cb: SigmaCb) => {
      let set = sigmaHandlers.get(name);
      if (!set) {
        set = new Set();
        sigmaHandlers.set(name, set);
      }
      set.add(cb);
      return () => {
        sigmaHandlers.get(name)?.delete(cb);
      };
    },
  };

  getOrCreateTerminalMock.mockReset();
  attachToHostMock.mockReset();
  detachFromHostMock.mockReset();
  destroyXtermMock.mockReset();
  destroyEngineMock.mockReset();
  setActiveTabMock.mockReset();

  // P1b — the renderer-flag module caches resolutions across imports; clear
  // it so each test re-resolves against this test's kv.get mock.
  const { __resetRendererFlagCache } = await import('@/renderer/lib/renderer-flag');
  __resetRendererFlagCache();

  // Reset browser RPC mocks to defaults before each test. Use mockClear
  // (not mockReset) on openTab so the factory's Promise<BrowserTab>
  // implementation is not wiped; re-apply getState / kv.get with correct
  // full-shape values so each test starts with a known default.
  const { rpcSilent, rpc } = await import('@/renderer/lib/rpc');
  vi.mocked(rpcSilent.kv.get)
    .mockReset()
    .mockImplementation(async (key: string) =>
      key.startsWith('panes.renderer.') ? 'xterm' : '1',
    );
  vi.mocked(rpcSilent.browser.getState).mockReset().mockResolvedValue(fakeState(null));
  vi.mocked(rpcSilent.browser.navigate).mockClear();
  vi.mocked(rpcSilent.browser.openTab).mockClear();
  vi.mocked(rpc.browser.getState).mockReset().mockResolvedValue(fakeState(null));
  vi.mocked(rpc.browser.navigate).mockClear();
  vi.mocked(rpc.browser.openTab).mockClear();
});

afterEach(() => {
  cleanup();
});

// jsdom reports clientWidth/Height 0 for every element; give the host div a
// real layout size so runFit's zero-size guard (see Terminal.tsx) lets fits
// through in tests that exercise the fit paths.
function sizeHost(root: HTMLElement, width = 800, height = 600) {
  const el = root.firstElementChild as HTMLElement;
  Object.defineProperty(el, 'clientWidth', { configurable: true, value: width });
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: height });
}

// P1b — SessionTerminal resolves the renderer flag on an async tick before
// mounting the xterm host. Flush that tick (and the cache reattach effects)
// so the rest of each test sees the mounted xterm host — exactly as it did
// before the switch wrapper existed.
async function settleFlag() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function fakeEntry(sessionId: string) {
  return {
    sessionId,
    terminal: {
      cols: 80,
      rows: 24,
      focus: vi.fn(),
      refresh: vi.fn(),
    },
    fitAddon: { fit: vi.fn() },
    ptyExited: false,
    webglAddon: null as null | { clearTextureAtlas: ReturnType<typeof vi.fn> },
  };
}

describe('<SessionTerminal> — Layer 2 host contract', () => {
  it('requests the cached terminal on mount and attaches it to the local container', async () => {
    const entry = fakeEntry('sess-A');
    getOrCreateTerminalMock.mockReturnValue(entry);

    const { SessionTerminal } = await import('./Terminal');
    render(<SessionTerminal sessionId="sess-A" />);
    await settleFlag();

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
    await settleFlag();
    unmount();

    expect(detachFromHostMock).toHaveBeenCalledTimes(1);
    expect(detachFromHostMock.mock.calls[0][0]).toBe(entry);
  });

  it('reuses the same cache entry across an unmount/remount cycle for the same sessionId', async () => {
    const entry = fakeEntry('sess-C');
    getOrCreateTerminalMock.mockReturnValue(entry);

    const { SessionTerminal } = await import('./Terminal');
    const first = render(<SessionTerminal sessionId="sess-C" />);
    await settleFlag();
    first.unmount();
    render(<SessionTerminal sessionId="sess-C" />);
    await settleFlag();

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

  // C-8 — context passes surfaceBrowser callback from useRightRail.
  it('C-8: passes a surfaceBrowser callback in the TerminalCacheContext', async () => {
    const entry = fakeEntry('sess-D');
    getOrCreateTerminalMock.mockReturnValue(entry);

    const { SessionTerminal } = await import('./Terminal');
    render(<SessionTerminal sessionId="sess-D" />);
    await settleFlag();

    const callArgs = getOrCreateTerminalMock.mock.calls[0];
    const ctx = callArgs[1] as { surfaceBrowser?: () => void };
    expect(typeof ctx.surfaceBrowser).toBe('function');
  });
});

// P1b — SessionTerminal renderer switch (spec 2026-06-12). Resolves the pane's
// renderer mode from KV, then mounts exactly one host.
describe('<SessionTerminal> — renderer switch (P1b)', () => {
  it('mounts DomTerminalView when the session KV override is dom', async () => {
    const { rpcSilent } = await import('@/renderer/lib/rpc');
    vi.mocked(rpcSilent.kv.get).mockImplementation(async (key: string) =>
      key === 'panes.renderer.sess-dom' ? 'dom' : null,
    );

    const { SessionTerminal } = await import('./Terminal');
    const { findByTestId } = render(<SessionTerminal sessionId="sess-dom" />);
    expect(await findByTestId('dom-terminal-view')).toBeTruthy();
    // mutual exclusion: dom mode destroys any cached xterm for this session.
    expect(destroyXtermMock).toHaveBeenCalledWith('sess-dom');
    // and never constructs the xterm host's cache entry.
    expect(getOrCreateTerminalMock).not.toHaveBeenCalled();
  });

  it('defaults to the DOM host when no flag is set (v2.4.1 default flip)', async () => {
    const { rpcSilent } = await import('@/renderer/lib/rpc');
    vi.mocked(rpcSilent.kv.get).mockResolvedValue(null);

    const { SessionTerminal } = await import('./Terminal');
    const { findByTestId } = render(<SessionTerminal sessionId="sess-x" />);
    expect(await findByTestId('dom-terminal-view')).toBeTruthy();
    expect(getOrCreateTerminalMock).not.toHaveBeenCalled();
    expect(destroyXtermMock).toHaveBeenCalledWith('sess-x');
  });

  it('mounts the xterm host when the KV says xterm (one-KV revert)', async () => {
    const entry = fakeEntry('sess-x2');
    getOrCreateTerminalMock.mockReturnValue(entry);
    const { rpcSilent } = await import('@/renderer/lib/rpc');
    vi.mocked(rpcSilent.kv.get).mockImplementation(async (key: string) =>
      key === 'panes.renderer.sess-x2' ? 'xterm' : null,
    );

    const { SessionTerminal } = await import('./Terminal');
    const { queryByTestId } = render(<SessionTerminal sessionId="sess-x2" />);
    await settleFlag();
    // the xterm host mounted (cache lookup fired) and the DOM host did not.
    await waitFor(() => expect(getOrCreateTerminalMock).toHaveBeenCalledTimes(1));
    expect(queryByTestId('dom-terminal-view')).toBeNull();
    // mutual exclusion: xterm mode destroys any cached engine for this session.
    expect(destroyEngineMock).toHaveBeenCalledWith('sess-x2');
  });

  it('sigma:renderer-mode-changed remounts the host in the new mode', async () => {
    const { rpcSilent } = await import('@/renderer/lib/rpc');
    vi.mocked(rpcSilent.kv.get).mockResolvedValue(null); // default → dom
    const { SessionTerminal } = await import('./Terminal');
    const { setSessionRendererMode } = await import('@/renderer/lib/renderer-flag');
    const { findByTestId, queryByTestId } = render(<SessionTerminal sessionId="sess-t" />);
    expect(await findByTestId('dom-terminal-view')).toBeTruthy();

    const entry = fakeEntry('sess-t');
    getOrCreateTerminalMock.mockReturnValue(entry);
    await act(async () => {
      await setSessionRendererMode('sess-t', 'xterm'); // updates the module cache
      window.dispatchEvent(
        new CustomEvent('sigma:renderer-mode-changed', { detail: { sessionId: 'sess-t' } }),
      );
    });
    await settleFlag();
    await waitFor(() => expect(queryByTestId('dom-terminal-view')).toBeNull());
    await waitFor(() => expect(getOrCreateTerminalMock).toHaveBeenCalled());
    expect(destroyEngineMock).toHaveBeenCalledWith('sess-t'); // exclusion fired
  });
});

// C-8 — routeLinkClick surfaces the browser tab after navigating.
//
// These tests exercise the module-scope `routeLinkClick` directly by
// extracting it from the TerminalCacheContext the component passes to
// `getOrCreateTerminal`. This is the simplest way to test the async browser-
// RPC + surfaceBrowser path without a full integration mount.
describe('C-8 — routeLinkClick → surfaceBrowser', () => {
  it('calls browser openTab AND surfaceBrowser when capture is ON and no active tab', async () => {
    const entry = fakeEntry('sess-E');
    getOrCreateTerminalMock.mockReturnValue(entry);

    // Configure mocks: capture ON, no active tab → openTab path.
    const { rpcSilent, rpc } = await import('@/renderer/lib/rpc');
    vi.mocked(rpcSilent.kv.get).mockImplementation(async (key: string) =>
      key.startsWith('panes.renderer.') ? 'xterm' : '1',
    );
    vi.mocked(rpcSilent.browser.getState).mockResolvedValue(fakeState(null));

    const { SessionTerminal } = await import('./Terminal');
    render(<SessionTerminal sessionId="sess-E" />);
    await settleFlag();

    const ctx = getOrCreateTerminalMock.mock.calls[0][1] as {
      routeLinkClick: (url: string, wsId: string | undefined, surfaceBrowser?: () => void) => void;
      surfaceBrowser?: () => void;
    };

    await act(async () => {
      ctx.routeLinkClick('https://x.dev', 'ws-1', ctx.surfaceBrowser);
      // flush microtasks so the async routeLinkClick body resolves
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(rpc.browser.openTab).toHaveBeenCalledWith({ workspaceId: 'ws-1', url: 'https://x.dev' });
    expect(setActiveTabMock).toHaveBeenCalledWith('browser');
  });

  it('calls browser navigate AND surfaceBrowser when capture is ON and active tab exists', async () => {
    const entry = fakeEntry('sess-F');
    getOrCreateTerminalMock.mockReturnValue(entry);

    const { rpcSilent, rpc } = await import('@/renderer/lib/rpc');
    vi.mocked(rpcSilent.kv.get).mockImplementation(async (key: string) =>
      key.startsWith('panes.renderer.') ? 'xterm' : '1',
    );
    vi.mocked(rpcSilent.browser.getState).mockResolvedValue(fakeState('tab-42'));

    const { SessionTerminal } = await import('./Terminal');
    render(<SessionTerminal sessionId="sess-F" />);
    await settleFlag();

    const ctx = getOrCreateTerminalMock.mock.calls[0][1] as {
      routeLinkClick: (url: string, wsId: string | undefined, surfaceBrowser?: () => void) => void;
      surfaceBrowser?: () => void;
    };

    await act(async () => {
      ctx.routeLinkClick('https://y.dev', 'ws-1', ctx.surfaceBrowser);
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(rpc.browser.navigate).toHaveBeenCalledWith({ workspaceId: 'ws-1', tabId: 'tab-42', url: 'https://y.dev' });
    expect(setActiveTabMock).toHaveBeenCalledWith('browser');
  });

  it('does NOT call surfaceBrowser when capture is OFF (OS fallback)', async () => {
    const entry = fakeEntry('sess-G');
    getOrCreateTerminalMock.mockReturnValue(entry);

    // Capture OFF: kv returns '0'.
    const { rpcSilent } = await import('@/renderer/lib/rpc');
    vi.mocked(rpcSilent.kv.get).mockImplementation(async (key: string) =>
      key.startsWith('panes.renderer.') ? 'xterm' : '0',
    );
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);

    const { SessionTerminal } = await import('./Terminal');
    render(<SessionTerminal sessionId="sess-G" />);
    await settleFlag();

    const ctx = getOrCreateTerminalMock.mock.calls[0][1] as {
      routeLinkClick: (url: string, wsId: string | undefined, surfaceBrowser?: () => void) => void;
      surfaceBrowser?: () => void;
    };

    await act(async () => {
      ctx.routeLinkClick('https://z.dev', 'ws-1', ctx.surfaceBrowser);
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(openSpy).toHaveBeenCalledWith('https://z.dev', '_blank', 'noopener,noreferrer');
    expect(setActiveTabMock).not.toHaveBeenCalled();
    openSpy.mockRestore();
  });
});

// Keystone regression guard (2026-06-09): the resize refit MUST go through
// xterm's atomic fit.fit(), which calls _renderService.clear() before resizing.
// A regression back to proposeDimensions()+term.resize() (no clear) re-introduces
// the resize "ghost / duplicated text" bug. See docs/superpowers/plans/
// 2026-06-09-pane-content-reflow-keystone.md.
describe('resize refit — renderer-clear regression guard', () => {
  it('refits via the atomic fit.fit() on sigma:pane-resize-end', async () => {
    const entry = fakeEntry('sess-R');
    getOrCreateTerminalMock.mockReturnValue(entry);

    const { rpc } = await import('@/renderer/lib/rpc');
    vi.mocked(rpc.pty.resize).mockClear();

    const { SessionTerminal } = await import('./Terminal');
    const { container } = render(<SessionTerminal sessionId="sess-R" />);
    await settleFlag();
    sizeHost(container);

    // jsdom's ResizeObserver polyfill is a no-op, so no fit fires on mount.
    expect(entry.fitAddon.fit).not.toHaveBeenCalled();

    await act(async () => {
      window.dispatchEvent(new Event('sigma:pane-resize-end'));
    });

    // The release refit MUST call fit.fit() (clears the renderer, then resizes).
    expect(entry.fitAddon.fit).toHaveBeenCalledTimes(1);
    // First fit propagates the real grid to the PTY (lastCols/lastRows start -1).
    expect(rpc.pty.resize).toHaveBeenCalledWith('sess-R', 80, 24);
  });
});

// Drag guard, v2 (2026-06-10 → 2026-06-11): between sigma:pane-resize-start
// and -end (a divider drag) the per-frame RO callbacks drive a THROTTLED
// VISUAL-ONLY re-wrap (fit.fit — text tracks the moving box) but MUST NOT
// notify the PTY — a mid-drag SIGWINCH storm makes the CLI repaint over every
// dragged-through size (the original "glitches until it adjusts / breaks",
// plus Claude Code's Ink duplicates a transcript frame per SIGWINCH). The
// single PTY resize happens at release — and only if the grid changed.
describe('resize refit — drag: live visual re-wrap, single PTY notify', () => {
  it('re-wraps visually mid-drag but sends no pty.resize until release', async () => {
    const entry = fakeEntry('sess-D2');
    getOrCreateTerminalMock.mockReturnValue(entry);

    const { rpc } = await import('@/renderer/lib/rpc');
    vi.mocked(rpc.pty.resize).mockClear();

    // Capturing ResizeObserver so the test can drive the refit callback the
    // component registers (jsdom's default polyfill never invokes it).
    let roCb: ResizeObserverCallback | null = null;
    globalThis.ResizeObserver = class {
      constructor(cb: ResizeObserverCallback) {
        roCb = cb;
      }
      observe(): void {/* no-op */}
      unobserve(): void {/* no-op */}
      disconnect(): void {/* no-op */}
    } as unknown as typeof ResizeObserver;

    const { SessionTerminal } = await import('./Terminal');
    const { container } = render(<SessionTerminal sessionId="sess-D2" />);
    await settleFlag();
    sizeHost(container);

    const fireRo = () =>
      roCb?.(
        [{ contentRect: { width: 800, height: 600 } }] as unknown as ResizeObserverEntry[],
        {} as ResizeObserver,
      );

    // First RO callback = the synchronous first-fit → fit once + ONE pty.resize.
    await act(async () => {
      fireRo();
    });
    expect(entry.fitAddon.fit).toHaveBeenCalledTimes(1);
    expect(rpc.pty.resize).toHaveBeenCalledTimes(1);

    // Drag starts → mid-drag RO callbacks re-wrap VISUALLY (leading throttle
    // fires immediately; rapid follow-ups coalesce) without touching the PTY.
    await act(async () => {
      window.dispatchEvent(new Event('sigma:pane-resize-start'));
    });
    await act(async () => {
      fireRo();
      fireRo();
      fireRo();
    });
    expect(entry.fitAddon.fit).toHaveBeenCalledTimes(2); // +1 leading dragFit
    expect(rpc.pty.resize).toHaveBeenCalledTimes(1); // STILL just the first

    // Release → one full refit; the mock grid never changed (80×24), so the
    // lastCols/lastRows dedup sends NO second pty.resize either.
    await act(async () => {
      window.dispatchEvent(new Event('sigma:pane-resize-end'));
    });
    expect(entry.fitAddon.fit).toHaveBeenCalledTimes(3);
    expect(rpc.pty.resize).toHaveBeenCalledTimes(1);
  });
});

// Restore-from-hidden reveal (pane-refit spec 2026-06-11): every pane-hide
// affordance (minimise, fullscreen siblings, scratch tabs) is display:none and
// restores at the SAME pixel size, where fit.fit() no-ops (no renderer clear).
// The host must force a full repaint: fit + refresh(0, rows-1) + atlas clear.
describe('resize refit — restore-from-hidden reveal', () => {
  function captureRo() {
    let roCb: ResizeObserverCallback | null = null;
    globalThis.ResizeObserver = class {
      constructor(cb: ResizeObserverCallback) {
        roCb = cb;
      }
      observe(): void {/* no-op */}
      unobserve(): void {/* no-op */}
      disconnect(): void {/* no-op */}
    } as unknown as typeof ResizeObserver;
    return (width: number, height: number) =>
      roCb?.(
        [{ contentRect: { width, height } }] as unknown as ResizeObserverEntry[],
        {} as ResizeObserver,
      );
  }

  it('forces fit + refresh + atlas clear immediately when restored at the same size', async () => {
    const entry = fakeEntry('sess-RV');
    entry.webglAddon = { clearTextureAtlas: vi.fn() };
    getOrCreateTerminalMock.mockReturnValue(entry);
    const fireRo = captureRo();

    const { SessionTerminal } = await import('./Terminal');
    const { container } = render(<SessionTerminal sessionId="sess-RV" />);
    await settleFlag();
    sizeHost(container);

    await act(async () => {
      fireRo(800, 600); // first fit
    });
    expect(entry.fitAddon.fit).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireRo(0, 0);     // hidden (display:none)
      fireRo(800, 600); // restored at the SAME size
    });
    // Reveal is immediate — no 60ms debounce window with a stale frame.
    expect(entry.fitAddon.fit).toHaveBeenCalledTimes(2);
    expect(entry.terminal.refresh).toHaveBeenCalledWith(0, 23);
    expect(entry.webglAddon.clearTextureAtlas).toHaveBeenCalledTimes(1);
  });

  it('reveals even while a divider drag is in flight', async () => {
    const entry = fakeEntry('sess-RV2');
    getOrCreateTerminalMock.mockReturnValue(entry);
    const fireRo = captureRo();

    const { SessionTerminal } = await import('./Terminal');
    const { container } = render(<SessionTerminal sessionId="sess-RV2" />);
    await settleFlag();
    sizeHost(container);

    await act(async () => {
      fireRo(800, 600);
    });
    await act(async () => {
      window.dispatchEvent(new Event('sigma:pane-resize-start'));
    });
    await act(async () => {
      fireRo(0, 0);
      fireRo(800, 600);
    });
    expect(entry.fitAddon.fit).toHaveBeenCalledTimes(2);
    expect(entry.terminal.refresh).toHaveBeenCalledTimes(1);
  });

  it('repaints on window:restored while visible, ignores it while hidden', async () => {
    const entry = fakeEntry('sess-WR');
    getOrCreateTerminalMock.mockReturnValue(entry);
    const fireRo = captureRo();

    const { SessionTerminal } = await import('./Terminal');
    const { container } = render(<SessionTerminal sessionId="sess-WR" />);
    await settleFlag();
    sizeHost(container);

    await act(async () => {
      fireRo(800, 600);
    });
    await act(async () => {
      emitSigma('window:restored');
    });
    expect(entry.fitAddon.fit).toHaveBeenCalledTimes(2);
    expect(entry.terminal.refresh).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireRo(0, 0);
      emitSigma('window:restored'); // hidden pane — pane-level restore will handle it
    });
    expect(entry.fitAddon.fit).toHaveBeenCalledTimes(2);
  });
});

// Zero-size fit guard (pane-refit follow-up 2026-06-11): a refit signal can
// arrive in the same frame a pane went display:none (the maximize toggle flips
// siblings hidden, then dispatches sigma:pane-resize-end before the RO has
// delivered the 0×0 to the controller). Fitting a zero-size container would
// clamp to addon-fit's 2×1 minimum and catastrophically reflow the buffer —
// runFit must skip when the container has no layout size.
describe('resize refit — zero-size container guard', () => {
  it('skips the fit when the container has no layout size', async () => {
    const entry = fakeEntry('sess-Z');
    getOrCreateTerminalMock.mockReturnValue(entry);

    const { SessionTerminal } = await import('./Terminal');
    render(<SessionTerminal sessionId="sess-Z" />); // jsdom default: clientWidth/Height = 0
    await settleFlag();

    await act(async () => {
      window.dispatchEvent(new Event('sigma:pane-resize-end'));
    });
    expect(entry.fitAddon.fit).not.toHaveBeenCalled();
  });
});
