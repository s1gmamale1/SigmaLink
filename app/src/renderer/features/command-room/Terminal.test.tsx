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
import { cleanup, render, act } from '@testing-library/react';

// ---- mocks ---------------------------------------------------------------

const attachToHostMock = vi.fn();
const detachFromHostMock = vi.fn();
const getOrCreateTerminalMock = vi.fn();

vi.mock('@/renderer/lib/terminal-cache', () => ({
  getOrCreateTerminal: (...args: unknown[]) => getOrCreateTerminalMock(...args),
  attachToHost: (...args: unknown[]) => attachToHostMock(...args),
  detachFromHost: (...args: unknown[]) => detachFromHostMock(...args),
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

// Minimal ResizeObserver polyfill — jsdom doesn't ship one and the host
// component constructs a real instance on mount.
beforeEach(async () => {
  globalThis.ResizeObserver = class {
    observe(): void { /* no-op */ }
    unobserve(): void { /* no-op */ }
    disconnect(): void { /* no-op */ }
  } as unknown as typeof ResizeObserver;

  // window.sigma.eventOn is used by terminal-cache; provide a no-op stub so
  // the module loads without crashing in jsdom.
  (globalThis as unknown as { sigma: { eventOn: () => () => void } }).sigma = {
    eventOn: () => () => undefined,
  };

  getOrCreateTerminalMock.mockReset();
  attachToHostMock.mockReset();
  detachFromHostMock.mockReset();
  setActiveTabMock.mockReset();

  // Reset browser RPC mocks to defaults before each test. Use mockClear
  // (not mockReset) on openTab so the factory's Promise<BrowserTab>
  // implementation is not wiped; re-apply getState / kv.get with correct
  // full-shape values so each test starts with a known default.
  const { rpcSilent, rpc } = await import('@/renderer/lib/rpc');
  vi.mocked(rpcSilent.kv.get).mockReset().mockResolvedValue('1');
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

  // C-8 — context passes surfaceBrowser callback from useRightRail.
  it('C-8: passes a surfaceBrowser callback in the TerminalCacheContext', async () => {
    const entry = fakeEntry('sess-D');
    getOrCreateTerminalMock.mockReturnValue(entry);

    const { SessionTerminal } = await import('./Terminal');
    render(<SessionTerminal sessionId="sess-D" />);

    const callArgs = getOrCreateTerminalMock.mock.calls[0];
    const ctx = callArgs[1] as { surfaceBrowser?: () => void };
    expect(typeof ctx.surfaceBrowser).toBe('function');
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
    vi.mocked(rpcSilent.kv.get).mockResolvedValue('1');
    vi.mocked(rpcSilent.browser.getState).mockResolvedValue(fakeState(null));

    const { SessionTerminal } = await import('./Terminal');
    render(<SessionTerminal sessionId="sess-E" />);

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
    vi.mocked(rpcSilent.kv.get).mockResolvedValue('1');
    vi.mocked(rpcSilent.browser.getState).mockResolvedValue(fakeState('tab-42'));

    const { SessionTerminal } = await import('./Terminal');
    render(<SessionTerminal sessionId="sess-F" />);

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
    vi.mocked(rpcSilent.kv.get).mockResolvedValue('0');
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);

    const { SessionTerminal } = await import('./Terminal');
    render(<SessionTerminal sessionId="sess-G" />);

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
