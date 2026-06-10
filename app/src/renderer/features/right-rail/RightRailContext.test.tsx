// @vitest-environment jsdom
//
// 2026-06-10 audit, finding 3 — toggleRail performed its KV write INSIDE the
// setRailOpenState updater. Updaters must be pure: React double-invokes them
// under StrictMode (dev) — the write fired twice per toggle. Rendering under
// <StrictMode> makes the double-fire observable, so the assert below is the
// regression lock.

import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';

const writeWorkspaceUiMock = vi.fn(async (..._a: unknown[]) => undefined);
const readWorkspaceUiMock = vi.fn(async (..._a: unknown[]) => null as string | null);
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

let ctx: RightRailContextValue | null = null;
function Probe() {
  ctx = useRightRail();
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
  ctx = null;
  vi.clearAllMocks();
});

describe('RightRailContext — toggleRail KV write hygiene', () => {
  it('toggleRail writes the per-workspace KV exactly ONCE under StrictMode', async () => {
    renderProvider();
    await act(async () => {}); // drain hydration reads
    writeWorkspaceUiMock.mockClear();

    act(() => {
      ctx?.toggleRail();
    });

    expect(ctx?.railOpen).toBe(false); // default open → closed
    // Pre-fix: 2 calls (updater double-invoked under StrictMode).
    expect(writeWorkspaceUiMock).toHaveBeenCalledTimes(1);
    expect(writeWorkspaceUiMock).toHaveBeenCalledWith('ws1', KV_OPEN, 'false');
  });

  it('a second toggle round-trips back to open and writes "true" once', async () => {
    renderProvider();
    await act(async () => {});
    act(() => {
      ctx?.toggleRail();
    });
    writeWorkspaceUiMock.mockClear();

    act(() => {
      ctx?.toggleRail();
    });

    expect(ctx?.railOpen).toBe(true);
    expect(writeWorkspaceUiMock).toHaveBeenCalledTimes(1);
    expect(writeWorkspaceUiMock).toHaveBeenCalledWith('ws1', KV_OPEN, 'true');
  });
});
