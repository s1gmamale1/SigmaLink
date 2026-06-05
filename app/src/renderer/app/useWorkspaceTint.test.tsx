// @vitest-environment jsdom
//
// BSP-T4 — useWorkspaceTint no-leak verification. Proves the clear-on-switch
// invariant: switching from a tinted workspace (ws-A) to an untinted one (ws-B)
// must clear BOTH --accent and --surface-tint, and must do so SYNCHRONOUSLY at
// the top of the effect (before the async KV read resolves), so ws-A's tint can
// never bleed into ws-B even for one frame.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';

// Mock the KV read: ws-A has a stored hex tint; everything else → null.
const readWorkspaceUi = vi.fn(async (wsId: string) =>
  wsId === 'ws-A' ? JSON.stringify({ accent: '#b966f5' }) : null,
);
vi.mock('@/renderer/lib/workspace-ui-kv', () => ({
  readWorkspaceUi: (wsId: string) => readWorkspaceUi(wsId),
  writeWorkspaceUi: vi.fn(),
}));

// Mock useTheme so the hook can run without a real ThemeProvider tree.
vi.mock('@/renderer/app/ThemeProvider', () => ({
  useTheme: () => ({ theme: 'glass' }),
}));

import { useWorkspaceTint } from './useWorkspaceTint';

const root = () => document.documentElement.style;

afterEach(() => {
  cleanup();
  root().removeProperty('--accent');
  root().removeProperty('--surface-tint');
  readWorkspaceUi.mockClear();
});

describe('useWorkspaceTint', () => {
  beforeEach(() => {
    root().removeProperty('--accent');
    root().removeProperty('--surface-tint');
  });

  it('applies the stored tint when a tinted workspace (ws-A) is active', async () => {
    await act(async () => {
      renderHook(({ id }: { id: string | null }) => useWorkspaceTint(id), {
        initialProps: { id: 'ws-A' },
      });
    });
    // --accent is HSL channels; --surface-tint is the raw hex.
    expect(root().getPropertyValue('--accent').trim()).toMatch(/^\d+ \d+% \d+%$/);
    expect(root().getPropertyValue('--surface-tint').trim()).toBe('#b966f5');
  });

  it('CLEARS both vars synchronously on switch to an untinted workspace (no leak)', async () => {
    const { rerender } = renderHook(({ id }: { id: string | null }) => useWorkspaceTint(id), {
      initialProps: { id: 'ws-A' as string | null },
    });
    // Flush ws-A's async apply.
    await act(async () => {});
    expect(root().getPropertyValue('--surface-tint').trim()).toBe('#b966f5');

    // Switch to ws-B. The effect's synchronous clearTint() runs during the
    // rerender — assert the vars are empty IMMEDIATELY, before flushing the
    // mocked KV promise. This is the no-leak guarantee.
    act(() => {
      rerender({ id: 'ws-B' });
    });
    expect(root().getPropertyValue('--accent')).toBe('');
    expect(root().getPropertyValue('--surface-tint')).toBe('');

    // After the async ws-B read resolves (returns null) the vars stay cleared,
    // and ws-A's hex never reappears.
    await act(async () => {});
    expect(root().getPropertyValue('--accent')).toBe('');
    expect(root().getPropertyValue('--surface-tint')).toBe('');
  });

  it('clears the tint when workspaceId becomes null', async () => {
    const { rerender } = renderHook(({ id }: { id: string | null }) => useWorkspaceTint(id), {
      initialProps: { id: 'ws-A' as string | null },
    });
    await act(async () => {});
    expect(root().getPropertyValue('--surface-tint').trim()).toBe('#b966f5');

    act(() => {
      rerender({ id: null });
    });
    expect(root().getPropertyValue('--accent')).toBe('');
    expect(root().getPropertyValue('--surface-tint')).toBe('');
  });
});
