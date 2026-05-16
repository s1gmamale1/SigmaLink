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
});
