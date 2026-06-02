// @vitest-environment jsdom
//
// P4 MEM-4 — ⌘O Memory Quick Switcher.
//
// These tests drive the REAL `@/components/ui/command` (cmdk) primitives so we
// exercise cmdk's actual fuzzy filtering. Only `@/renderer/lib/rpc` and
// `window.sigma` are faked. jsdom lacks the layout/pointer APIs cmdk + Radix
// touch, so we polyfill `scrollIntoView` + pointer-capture helpers.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Memory, RufloEntry } from '@/shared/types';

// ---- rpc mock --------------------------------------------------------------
// `healthMock` + `entriesMock` are swapped per-test to model ready / not-ready
// and the canned entry list.
const healthMock = vi.fn();
const entriesMock = vi.fn();

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: { ruflo: { health: (...a: unknown[]) => healthMock(...a) } },
  rpcSilent: {
    ruflo: {
      health: (...a: unknown[]) => healthMock(...a),
      'entries.list': (...a: unknown[]) => entriesMock(...a),
    },
  },
  onEvent: () => () => undefined,
}));

import { MemoryQuickSwitcher } from './MemoryQuickSwitcher';

// ---- fixtures --------------------------------------------------------------
const MEMORIES: Memory[] = [
  {
    id: 'm1' as never,
    workspaceId: 'ws-1' as never,
    name: 'Architecture overview',
    body: '',
    tags: [],
    links: [],
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: 'm2' as never,
    workspaceId: 'ws-1' as never,
    name: 'Release checklist',
    body: '',
    tags: [],
    links: [],
    createdAt: 0,
    updatedAt: 0,
  },
];

const RUFLO_ENTRIES: RufloEntry[] = [
  { id: 'r1', text: 'WRITE patterns READ memory_search_unified', namespace: 'patterns' },
  { id: 'r2', text: 'verdict: ship-as-is after Opus review', namespace: 'verdict' },
];

// ---- jsdom polyfills for cmdk + Radix --------------------------------------
function installDomEnv() {
  if (!('ResizeObserver' in globalThis)) {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  }
  const proto = window.HTMLElement.prototype as unknown as {
    scrollIntoView?: () => void;
    hasPointerCapture?: () => boolean;
    setPointerCapture?: () => void;
    releasePointerCapture?: () => void;
  };
  if (!proto.scrollIntoView) proto.scrollIntoView = () => undefined;
  if (!proto.hasPointerCapture) proto.hasPointerCapture = () => false;
  if (!proto.setPointerCapture) proto.setPointerCapture = () => undefined;
  if (!proto.releasePointerCapture) proto.releasePointerCapture = () => undefined;
}

function renderSwitcher(over: Partial<React.ComponentProps<typeof MemoryQuickSwitcher>> = {}) {
  const onOpenChange = vi.fn();
  const onSelectNote = vi.fn();
  const onSelectRuflo = vi.fn();
  render(
    <MemoryQuickSwitcher
      open
      onOpenChange={onOpenChange}
      memories={MEMORIES}
      onSelectNote={onSelectNote}
      onSelectRuflo={onSelectRuflo}
      {...over}
    />,
  );
  return { onOpenChange, onSelectNote, onSelectRuflo };
}

describe('MemoryQuickSwitcher (P4 MEM-4)', () => {
  beforeEach(() => {
    installDomEnv();
    (window as unknown as { sigma?: Record<string, unknown> }).sigma = {
      eventOn: vi.fn(() => () => undefined),
    };
    healthMock.mockResolvedValue({ state: 'ready' });
    entriesMock.mockResolvedValue({ ok: true, entries: RUFLO_ENTRIES });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    delete (window as unknown as { sigma?: unknown }).sigma;
  });

  it('renders Notes from props and Agent memory from the fetched entries', async () => {
    renderSwitcher();

    // Notes render synchronously from props.
    expect(screen.getByText('Architecture overview')).toBeTruthy();
    expect(screen.getByText('Release checklist')).toBeTruthy();

    // Agent-memory rows appear once the (gated) entries fetch resolves.
    expect(await screen.findByText(/WRITE patterns/)).toBeTruthy();
    expect(screen.getByText(/ship-as-is after Opus review/)).toBeTruthy();
    expect(entriesMock).toHaveBeenCalledWith({ limit: 50 });
  });

  it('lets cmdk filter the visible items as you type', async () => {
    renderSwitcher();
    await screen.findByText(/WRITE patterns/);

    const input = screen.getByPlaceholderText('Jump to a note or agent memory…');
    fireEvent.change(input, { target: { value: 'Release' } });

    await waitFor(() => {
      expect(screen.queryByText('Architecture overview')).toBeNull();
    });
    expect(screen.getByText('Release checklist')).toBeTruthy();
  });

  it('selecting a note calls onSelectNote + closes', async () => {
    const { onSelectNote, onOpenChange } = renderSwitcher();

    fireEvent.click(await screen.findByText('Architecture overview'));

    expect(onSelectNote).toHaveBeenCalledWith('Architecture overview');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('selecting a Ruflo item calls onSelectRuflo(entry) + closes', async () => {
    const { onSelectRuflo, onOpenChange } = renderSwitcher();

    fireEvent.click(await screen.findByText(/ship-as-is after Opus review/));

    expect(onSelectRuflo).toHaveBeenCalledWith(RUFLO_ENTRIES[1]);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('renders only Notes (no throw, no fetch) when Ruflo is not ready', async () => {
    healthMock.mockResolvedValue({ state: 'down' });
    renderSwitcher();

    expect(screen.getByText('Architecture overview')).toBeTruthy();

    // Give the health probe a tick to resolve; entries.list must never fire.
    await waitFor(() => expect(healthMock).toHaveBeenCalled());
    expect(entriesMock).not.toHaveBeenCalled();
    expect(screen.queryByText(/WRITE patterns/)).toBeNull();
  });

  it('degrades to Notes-only when entries.list returns { ok: false }', async () => {
    entriesMock.mockResolvedValue({ ok: false, code: 'ruflo-unavailable', reason: 'offline' });
    renderSwitcher();

    expect(screen.getByText('Release checklist')).toBeTruthy();
    await waitFor(() => expect(entriesMock).toHaveBeenCalled());
    expect(screen.queryByText(/WRITE patterns/)).toBeNull();
  });
});
