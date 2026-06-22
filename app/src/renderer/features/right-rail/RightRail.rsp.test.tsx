// @vitest-environment jsdom
//
// RightRail — universal/window-scope-aware width (via chrome-ui-kv) + narrow
// auto-collapse.
//
// Asserts:
//   - Width hydrates from the GLOBAL key (`rightRail.width`) via chrome-ui-kv,
//     mount-once (no re-read on workspace change).
//   - A splitter commit writes via writeChromeUi (global key, never per-workspace).
//   - Width is universal: switching the active workspace does NOT re-hydrate.
//   - Below the `narrow` breakpoint (900px) the rail auto-collapses: the body
//     renders full-bleed (with `min-w-0`, SF-11) and no <aside> is mounted.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';

// ─── rpc mock ────────────────────────────────────────────────────────────────
const kvGetMock = vi.fn<(key: string) => Promise<string | null>>();
const kvSetMock = vi.fn<(key: string, value: string) => Promise<void>>();
vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    kv: {
      get: (...a: [string]) => kvGetMock(...a),
      set: (...a: [string, string]) => kvSetMock(...a),
    },
  },
  rpcSilent: {
    kv: { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue(undefined) },
  },
}));

// ─── chrome-ui-kv mock (in-memory map keyed by globalKey) ───────────────────
const { store } = vi.hoisted(() => ({ store: new Map<string, string>() }));
const readChromeUiMock = vi.fn(
  async (globalKey: string, _panel: string): Promise<string | null> => store.get(globalKey) ?? null,
);
const writeChromeUiMock = vi.fn(async (globalKey: string, _panel: string, value: string) => {
  store.set(globalKey, value);
});
vi.mock('@/renderer/lib/chrome-ui-kv', () => ({
  readChromeUi: (...a: [string, string]) => readChromeUiMock(...a),
  writeChromeUi: (...a: [string, string, string]) => writeChromeUiMock(...a),
}));

// ─── shared breakpoint hook ──────────────────────────────────────────────────
let belowNarrow = false;
vi.mock('@/renderer/lib/use-breakpoint', () => ({
  useBelowBreakpoint: (name: string) => (name === 'narrow' ? belowNarrow : false),
}));

// ─── app state ───────────────────────────────────────────────────────────────
let activeWsId: string | null = 'ws-1';
vi.mock('@/renderer/app/state', () => ({
  useAppStateSelector: (sel: (s: unknown) => unknown) =>
    sel({ activeWorkspace: activeWsId ? { id: activeWsId } : null }),
}));

// ─── RightRailContext + heavy lazy bodies ────────────────────────────────────
const setActiveTabMock = vi.fn();
vi.mock('./RightRailContext.data', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./RightRailContext.data')>();
  return {
    ...orig,
    useRightRail: () => ({
      activeTab: 'editor' as const,
      setActiveTab: setActiveTabMock,
      railOpen: true,
      setRailOpen: vi.fn(),
      toggleRail: vi.fn(),
    }),
  };
});
vi.mock('@/renderer/features/browser/BrowserRoom', () => ({
  BrowserRoom: () => <div data-testid="browser-stub" />,
}));
vi.mock('@/renderer/features/skills/SkillsTab', () => ({
  SkillsTab: () => <div data-testid="skills-stub" />,
}));
vi.mock('./SwarmRailTab', () => ({ SwarmRailTab: () => <div data-testid="swarm-stub" /> }));
vi.mock('./JorvisTabPlaceholder', () => ({
  JorvisTabPlaceholder: () => <div data-testid="jorvis-stub" />,
}));
vi.mock('./EditorTabPlaceholder', () => ({
  EditorTabPlaceholder: () => <div data-testid="editor-stub" />,
}));
vi.mock('./RightRailTabs', () => ({
  RightRailTabs: ({ bodies }: { bodies: Record<string, React.ReactNode> }) => (
    <div data-testid="rail-tabs">{bodies['editor']}</div>
  ),
}));
// Splitter: expose a button that commits a width so we can test persistence.
vi.mock('./Splitter', () => ({
  Splitter: ({ onCommit }: { onCommit: (n: number) => void }) => (
    <button type="button" data-testid="splitter" onClick={() => onCommit(640)} />
  ),
}));

import { RightRail } from './RightRail';

function renderRail() {
  return render(
    <RightRail>
      <div data-testid="body-slot">content</div>
    </RightRail>,
  );
}

beforeEach(() => {
  store.clear();
  kvGetMock.mockReset().mockResolvedValue(null);
  kvSetMock.mockReset().mockResolvedValue(undefined);
  readChromeUiMock.mockClear();
  writeChromeUiMock.mockClear();
  belowNarrow = false;
  activeWsId = 'ws-1';
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('RightRail — universal width (window-scope-aware via chrome-ui-kv)', () => {
  it('hydrates width from the global key', async () => {
    store.set('rightRail.width', '600');
    const { container } = renderRail();
    await act(async () => {});
    const aside = container.querySelector('aside') as HTMLElement;
    expect(aside.style.width).toBe('600px');
    expect(readChromeUiMock).toHaveBeenCalledWith('rightRail.width', 'rightRail.width');
  });

  it('a splitter commit writes via writeChromeUi(global, panel, value)', async () => {
    const { getByTestId } = renderRail();
    await act(async () => {});
    getByTestId('splitter').click();
    expect(writeChromeUiMock).toHaveBeenCalledWith('rightRail.width', 'rightRail.width', '640');
    expect(store.get('rightRail.width')).toBe('640');
  });

  it('does NOT re-hydrate when the active workspace changes (universal)', async () => {
    store.set('rightRail.width', '600');
    const { container, rerender } = renderRail();
    await act(async () => {});
    let aside = container.querySelector('aside') as HTMLElement;
    expect(aside.style.width).toBe('600px');

    // Change the global value AND the active workspace; width must not re-read.
    store.set('rightRail.width', '300');
    activeWsId = 'ws-2';
    rerender(
      <RightRail>
        <div data-testid="body-slot">content</div>
      </RightRail>,
    );
    await act(async () => {});
    aside = container.querySelector('aside') as HTMLElement;
    expect(aside.style.width).toBe('600px');
  });
});

describe('RightRail RSP-1 — narrow auto-collapse', () => {
  it('renders the rail aside at/above the narrow breakpoint', async () => {
    belowNarrow = false;
    const { container } = renderRail();
    await act(async () => {});
    expect(container.querySelector('aside')).not.toBeNull();
  });

  it('hides the aside and renders body full-bleed below the narrow breakpoint', async () => {
    belowNarrow = true;
    const { container, getByTestId } = renderRail();
    await act(async () => {});
    // No rail panel when collapsed.
    expect(container.querySelector('aside')).toBeNull();
    // Body still rendered.
    expect(getByTestId('body-slot')).toBeTruthy();
    // SF-11: the full-bleed wrapper retains min-w-0 + flex-1 so it doesn't
    // overflow its flex parent.
    const outer = container.firstElementChild as HTMLElement;
    expect(Array.from(outer.classList)).toContain('min-w-0');
    expect(Array.from(outer.classList)).toContain('flex-1');
  });
});
