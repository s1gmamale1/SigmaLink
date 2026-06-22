// @vitest-environment jsdom
//
// Window-scope-aware rail chrome. The component calls readChromeUi/writeChromeUi
// (which resolve main→global / scoped→per-scope; that resolution is unit-tested
// in chrome-ui-kv.test.ts). Here we assert the component calls the helper with
// the right (globalKey, panel) and preserves the StrictMode write-once invariant.

import { StrictMode, useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';

const readChromeUiMock = vi.fn<(...a: unknown[]) => Promise<string | null>>(async () => null);
const writeChromeUiMock = vi.fn<(...a: unknown[]) => Promise<undefined>>(async () => undefined);
vi.mock('@/renderer/lib/chrome-ui-kv', () => ({
  readChromeUi: (...a: unknown[]) => readChromeUiMock(...a),
  writeChromeUi: (...a: unknown[]) => writeChromeUiMock(...a),
}));

import { RightRailProvider } from './RightRailContext';
import { KV_OPEN, KV_TAB, useRightRail, type RightRailContextValue } from './RightRailContext.data';

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
  it('toggleRail writes the open key exactly ONCE under StrictMode', async () => {
    renderProvider();
    await act(async () => {});
    writeChromeUiMock.mockClear();

    act(() => {
      ctxRef.current?.toggleRail();
    });

    expect(ctxRef.current?.railOpen).toBe(false);
    expect(writeChromeUiMock).toHaveBeenCalledTimes(1);
    expect(writeChromeUiMock).toHaveBeenCalledWith(KV_OPEN, KV_OPEN, 'false');
  });

  it('a second toggle round-trips back to open and writes "true" once', async () => {
    renderProvider();
    await act(async () => {});
    act(() => {
      ctxRef.current?.toggleRail();
    });
    writeChromeUiMock.mockClear();

    act(() => {
      ctxRef.current?.toggleRail();
    });

    expect(ctxRef.current?.railOpen).toBe(true);
    expect(writeChromeUiMock).toHaveBeenCalledTimes(1);
    expect(writeChromeUiMock).toHaveBeenCalledWith(KV_OPEN, KV_OPEN, 'true');
  });
});

describe('RightRailContext — active tab persistence (window-scope-aware)', () => {
  it('hydrates the active tab via readChromeUi(KV_TAB, KV_TAB)', async () => {
    renderProvider();
    await act(async () => {
      await Promise.resolve();
    });
    expect(readChromeUiMock).toHaveBeenCalledWith(KV_TAB, KV_TAB);
  });

  it('persists tab changes via writeChromeUi(KV_TAB, KV_TAB, tab)', async () => {
    renderProvider();
    await act(async () => {
      await Promise.resolve();
    });
    writeChromeUiMock.mockClear();

    await act(async () => {
      ctxRef.current?.setActiveTab('skills');
    });

    expect(writeChromeUiMock).toHaveBeenCalledWith(KV_TAB, KV_TAB, 'skills');
  });
});
