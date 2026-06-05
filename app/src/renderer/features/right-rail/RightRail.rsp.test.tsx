// @vitest-environment jsdom
//
// RSP-1 (Lane RSP-Shell) — RightRail per-workspace width persistence + narrow
// auto-collapse.
//
// Asserts:
//   - Width hydrates from the per-workspace key (`ui.<wsId>.rightRail.width`)
//     when a workspace is active, with read-through fallback to the legacy
//     global key (`rightRail.width`).
//   - A splitter commit writes the PER-WORKSPACE key (not the global one).
//   - Changing `wsId` re-hydrates.
//   - With no workspace open (`wsId === null`) it falls back to the legacy
//     global key.
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

// ─── per-workspace kv helper (in-memory map) ─────────────────────────────────
const { store } = vi.hoisted(() => ({ store: new Map<string, string>() }));
const readWorkspaceUiMock = vi.fn(
  async (wsId: string, panel: string, legacyGlobalKey?: string): Promise<string | null> => {
    const scoped = store.get(`ui.${wsId}.${panel}`);
    if (scoped !== undefined) return scoped;
    if (legacyGlobalKey) return store.get(legacyGlobalKey) ?? null;
    return null;
  },
);
const writeWorkspaceUiMock = vi.fn(async (wsId: string, panel: string, value: string) => {
  store.set(`ui.${wsId}.${panel}`, value);
});
vi.mock('@/renderer/lib/workspace-ui-kv', () => ({
  workspaceUiKey: (wsId: string, panel: string) => `ui.${wsId}.${panel}`,
  readWorkspaceUi: (...a: [string, string, string?]) => readWorkspaceUiMock(...a),
  writeWorkspaceUi: (...a: [string, string, string]) => writeWorkspaceUiMock(...a),
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
  readWorkspaceUiMock.mockClear();
  writeWorkspaceUiMock.mockClear();
  belowNarrow = false;
  activeWsId = 'ws-1';
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('RightRail RSP-1 — per-workspace width persistence', () => {
  it('hydrates width from the per-workspace key when present', async () => {
    store.set('ui.ws-1.rightRail.width', '600');
    const { container } = renderRail();
    await act(async () => {});
    const aside = container.querySelector('aside') as HTMLElement;
    expect(aside.style.width).toBe('600px');
    expect(readWorkspaceUiMock).toHaveBeenCalledWith('ws-1', 'rightRail.width', 'rightRail.width');
  });

  it('falls through to the legacy global key when the scoped value is unset', async () => {
    store.set('rightRail.width', '520'); // pre-RSP-1 global value
    const { container } = renderRail();
    await act(async () => {});
    const aside = container.querySelector('aside') as HTMLElement;
    expect(aside.style.width).toBe('520px');
  });

  it('a splitter commit writes the per-workspace key', async () => {
    const { getByTestId } = renderRail();
    await act(async () => {});
    getByTestId('splitter').click();
    expect(writeWorkspaceUiMock).toHaveBeenCalledWith('ws-1', 'rightRail.width', '640');
    expect(kvSetMock).not.toHaveBeenCalledWith('rightRail.width', expect.anything());
  });

  it('re-hydrates when wsId changes', async () => {
    store.set('ui.ws-1.rightRail.width', '600');
    store.set('ui.ws-2.rightRail.width', '300');
    const { container, rerender } = renderRail();
    await act(async () => {});
    let aside = container.querySelector('aside') as HTMLElement;
    expect(aside.style.width).toBe('600px');

    activeWsId = 'ws-2';
    rerender(
      <RightRail>
        <div data-testid="body-slot">content</div>
      </RightRail>,
    );
    await act(async () => {});
    aside = container.querySelector('aside') as HTMLElement;
    expect(aside.style.width).toBe('300px');
  });

  it('falls back to the global key when no workspace is open', async () => {
    activeWsId = null;
    kvGetMock.mockResolvedValue('444');
    const { container, getByTestId } = renderRail();
    await act(async () => {});
    const aside = container.querySelector('aside') as HTMLElement;
    expect(aside.style.width).toBe('444px');
    expect(kvGetMock).toHaveBeenCalledWith('rightRail.width');

    getByTestId('splitter').click();
    expect(kvSetMock).toHaveBeenCalledWith('rightRail.width', '640');
    expect(writeWorkspaceUiMock).not.toHaveBeenCalled();
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
