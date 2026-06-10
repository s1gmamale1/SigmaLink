// @vitest-environment jsdom
//
// 2026-06-10 audit, finding 3 — toggleRail performed its KV write INSIDE the
// setRailOpenState updater. Updaters must be pure: React double-invokes them
// under StrictMode (dev) — the write fired twice per toggle. Rendering under
// <StrictMode> makes the double-fire observable, so the assert below is the
// regression lock.

import { StrictMode, useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';

const writeWorkspaceUiMock = vi.fn(async (): Promise<undefined> => undefined);
const readWorkspaceUiMock = vi.fn(async (): Promise<string | null> => null);
vi.mock('@/renderer/lib/workspace-ui-kv', () => ({
  readWorkspaceUi: (...args: unknown[]) => readWorkspaceUiMock(...args),
  writeWorkspaceUi: (...args: unknown[]) => writeWorkspaceUiMock(...args),
}));

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    kv: {
      set: vi.fn(async () => undefined),
      get: vi.fn(async () => null),
    },
  },
  rpcSilent: {
    kv: { get: vi.fn(async () => null) },
  },
}));

vi.mock('@/renderer/app/state', () => ({
  useAppStateSelector: (sel: (s: unknown) => unknown) =>
    sel({ activeWorkspace: { id: 'ws1' } }),
}));

import { RightRailProvider } from './RightRailContext';
import { KV_OPEN, useRightRail, type RightRailContextValue } from './RightRailContext.data';

// Capture the live context into a module ref via useEffect (not during render)
// so the react-hooks/globals lint rule — which forbids writing module-scope
// values during render — is satisfied. The effect runs synchronously inside
// the test's act() wrappers, so ctxRef.current is up to date when asserted.
const ctxRef: { current: RightRailContextValue | null } = { current: null };
function Probe() {
  const value = useRightRail();
  useEffect(() => {
    ctxRef.current = value;
  });
  return null;
}

function renderProvider() {
  return render(
    <StrictMode>
      <RightRailProvider>
        <Probe />
      </RightRailProvider>
    </StrictMode>,
  );
}

afterEach(() => {
  cleanup();
  ctxRef.current = null;
  vi.clearAllMocks();
});

describe('RightRailContext — toggleRail KV write hygiene', () => {
  it('toggleRail writes the per-workspace KV exactly ONCE under StrictMode', async () => {
    renderProvider();
    await act(async () => {}); // drain hydration reads
    writeWorkspaceUiMock.mockClear();

    act(() => {
      ctxRef.current?.toggleRail();
    });

    expect(ctxRef.current?.railOpen).toBe(false); // default open → closed
    // Pre-fix: 2 calls (updater double-invoked under StrictMode).
    expect(writeWorkspaceUiMock).toHaveBeenCalledTimes(1);
    expect(writeWorkspaceUiMock).toHaveBeenCalledWith('ws1', KV_OPEN, 'false');
  });

  it('a second toggle round-trips back to open and writes "true" once', async () => {
    renderProvider();
    await act(async () => {});
    act(() => {
      ctxRef.current?.toggleRail();
    });
    writeWorkspaceUiMock.mockClear();

    act(() => {
      ctxRef.current?.toggleRail();
    });

    expect(ctxRef.current?.railOpen).toBe(true);
    expect(writeWorkspaceUiMock).toHaveBeenCalledTimes(1);
    expect(writeWorkspaceUiMock).toHaveBeenCalledWith('ws1', KV_OPEN, 'true');
  });
});
