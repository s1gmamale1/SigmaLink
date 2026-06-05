// @vitest-environment jsdom
//
// Unit tests for useWorkspaceColors hook.
// Mirrors the rpc mock style used in Sidebar.test.tsx.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { defaultWorkspaceColor } from '@/renderer/lib/workspace-color';

// ---- rpc mock ---------------------------------------------------------------

const kvGetMock = vi.fn<(key: string) => Promise<string | null>>();
const kvSetMock = vi.fn<(key: string, value: string) => Promise<void>>();

vi.mock('@/renderer/lib/rpc', () => ({
  rpcSilent: {
    kv: {
      get: (...args: [string]) => kvGetMock(...args),
      set: (...args: [string, string]) => kvSetMock(...args),
    },
  },
}));

// ---- import after mock -------------------------------------------------------

import { useWorkspaceColors } from './use-workspace-colors';

afterEach(() => {
  cleanup();
  kvGetMock.mockClear();
  kvSetMock.mockClear();
});

describe('useWorkspaceColors', () => {
  beforeEach(() => {
    kvGetMock.mockResolvedValue(null);
    kvSetMock.mockResolvedValue(undefined);
  });

  it('returns the default colour when KV has no stored value', async () => {
    kvGetMock.mockResolvedValue(null);

    const { result } = renderHook(() => useWorkspaceColors(['ws-a']));
    await act(async () => {});

    expect(result.current.colorFor('ws-a')).toBe(defaultWorkspaceColor('ws-a'));
  });

  it('returns the default colour when KV returns an empty string', async () => {
    kvGetMock.mockResolvedValue('');

    const { result } = renderHook(() => useWorkspaceColors(['ws-a']));
    await act(async () => {});

    expect(result.current.colorFor('ws-a')).toBe(defaultWorkspaceColor('ws-a'));
  });

  it('uses the stored hex when KV has a value', async () => {
    kvGetMock.mockResolvedValue('#60a5fa');

    const { result } = renderHook(() => useWorkspaceColors(['ws-b']));
    await act(async () => {});

    expect(result.current.colorFor('ws-b')).toBe('#60a5fa');
  });

  it('setColor(id, hex) writes KV key and updates colorFor', async () => {
    kvGetMock.mockResolvedValue(null);
    kvSetMock.mockResolvedValue(undefined);

    const { result } = renderHook(() => useWorkspaceColors(['ws-c']));
    await act(async () => {});

    act(() => {
      result.current.setColor('ws-c', '#a78bfa');
    });

    // Optimistic state updated synchronously.
    expect(result.current.colorFor('ws-c')).toBe('#a78bfa');
    // KV write called with the right key + value.
    expect(kvSetMock).toHaveBeenCalledWith('ui.ws-c.color', '#a78bfa');
  });

  it('setColor(id, null) resets to the default and writes empty string to KV', async () => {
    kvGetMock.mockResolvedValue('#e879f9');

    const { result } = renderHook(() => useWorkspaceColors(['ws-d']));
    await act(async () => {});
    // Confirm we loaded the stored value first.
    expect(result.current.colorFor('ws-d')).toBe('#e879f9');

    act(() => {
      result.current.setColor('ws-d', null);
    });

    expect(result.current.colorFor('ws-d')).toBe(defaultWorkspaceColor('ws-d'));
    expect(kvSetMock).toHaveBeenCalledWith('ui.ws-d.color', '');
  });

  it('colorFor falls back to the default for ids not in the loaded list', async () => {
    kvGetMock.mockResolvedValue(null);
    const { result } = renderHook(() => useWorkspaceColors(['ws-a']));
    await act(async () => {});

    // 'ws-unknown' was never loaded but should still get a stable default.
    expect(result.current.colorFor('ws-unknown')).toBe(defaultWorkspaceColor('ws-unknown'));
  });

  it('handles KV read errors gracefully and falls back to the default', async () => {
    kvGetMock.mockRejectedValue(new Error('KV unavailable'));

    const { result } = renderHook(() => useWorkspaceColors(['ws-e']));
    await act(async () => {});

    expect(result.current.colorFor('ws-e')).toBe(defaultWorkspaceColor('ws-e'));
  });

  it('loads multiple ids concurrently', async () => {
    kvGetMock.mockImplementation((key) => {
      if (key === 'ui.ws-1.color') return Promise.resolve('#f472b6');
      if (key === 'ui.ws-2.color') return Promise.resolve('#34d399');
      return Promise.resolve(null);
    });

    const { result } = renderHook(() => useWorkspaceColors(['ws-1', 'ws-2', 'ws-3']));
    await act(async () => {});

    expect(result.current.colorFor('ws-1')).toBe('#f472b6');
    expect(result.current.colorFor('ws-2')).toBe('#34d399');
    expect(result.current.colorFor('ws-3')).toBe(defaultWorkspaceColor('ws-3'));
  });
});
