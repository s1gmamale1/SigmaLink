// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { readWorkspaceUiMock, writeWorkspaceUiMock } = vi.hoisted(() => ({
  readWorkspaceUiMock: vi.fn<(
    workspaceId: string,
    panel: string,
  ) => Promise<string | null>>(),
  writeWorkspaceUiMock: vi.fn<(
    workspaceId: string,
    panel: string,
    value: string,
  ) => Promise<void>>(),
}));

vi.mock('@/renderer/lib/workspace-ui-kv', () => ({
  readWorkspaceUi: (...args: [string, string]) => readWorkspaceUiMock(...args),
  writeWorkspaceUi: (...args: [string, string, string]) => writeWorkspaceUiMock(...args),
}));

import { usePaneOrder } from './usePaneOrder';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  readWorkspaceUiMock.mockReset();
  writeWorkspaceUiMock.mockReset();
  writeWorkspaceUiMock.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
});

describe('usePaneOrder hydration', () => {
  it('hydrates and reconciles the workspace order without writing', async () => {
    readWorkspaceUiMock.mockResolvedValue(
      '{"version":1,"sessionIds":["c","stale","a"]}',
    );

    const { result } = renderHook(() => usePaneOrder({
      workspaceId: 'ws-1',
      canonicalSessionIds: ['a', 'b', 'c'],
    }));

    expect(result.current.orderedSessionIds).toEqual(['a', 'b', 'c']);
    expect(result.current.reorderReady).toBe(false);

    await waitFor(() => {
      expect(result.current.reorderReady).toBe(true);
    });

    expect(readWorkspaceUiMock).toHaveBeenCalledWith('ws-1', 'commandRoom.paneOrder');
    expect(result.current.orderedSessionIds).toEqual(['c', 'a', 'b']);
    expect(writeWorkspaceUiMock).not.toHaveBeenCalled();
  });

  it('treats a failed read as an empty saved order and becomes ready', async () => {
    readWorkspaceUiMock.mockRejectedValue(new Error('read failed'));

    const { result } = renderHook(() => usePaneOrder({
      workspaceId: 'ws-1',
      canonicalSessionIds: ['a', 'b'],
    }));

    await waitFor(() => {
      expect(result.current.reorderReady).toBe(true);
    });

    expect(result.current.orderedSessionIds).toEqual(['a', 'b']);
    expect(writeWorkspaceUiMock).not.toHaveBeenCalled();
  });
});

describe('usePaneOrder mutations', () => {
  it('swaps hydrated panes and persists the resulting presentation order', async () => {
    readWorkspaceUiMock.mockResolvedValue(
      '{"version":1,"sessionIds":["c","a","b"]}',
    );
    const { result } = renderHook(() => usePaneOrder({
      workspaceId: 'ws-1',
      canonicalSessionIds: ['a', 'b', 'c'],
    }));
    await waitFor(() => {
      expect(result.current.reorderReady).toBe(true);
    });

    act(() => {
      expect(result.current.swapPanes('c', 'b')).toBe(true);
    });

    expect(result.current.orderedSessionIds).toEqual(['b', 'a', 'c']);
    expect(writeWorkspaceUiMock).toHaveBeenCalledWith(
      'ws-1',
      'commandRoom.paneOrder',
      '{"version":1,"sessionIds":["b","a","c"]}',
    );
  });

  it('rejects swaps before hydration and reference-preserving swaps without rendering or writing', async () => {
    const read = deferred<string | null>();
    readWorkspaceUiMock.mockReturnValue(read.promise);
    let renderCount = 0;
    const { result } = renderHook(() => {
      renderCount += 1;
      return usePaneOrder({
        workspaceId: 'ws-1',
        canonicalSessionIds: ['a', 'b'],
      });
    });

    expect(result.current.swapPanes('a', 'b')).toBe(false);
    const rendersBeforeHydration = renderCount;
    expect(renderCount).toBe(rendersBeforeHydration);
    expect(writeWorkspaceUiMock).not.toHaveBeenCalled();

    act(() => {
      read.resolve('{"version":1,"sessionIds":["a","b"]}');
    });
    await waitFor(() => {
      expect(result.current.reorderReady).toBe(true);
    });
    const rendersBeforeNoOps = renderCount;

    expect(result.current.swapPanes('a', 'a')).toBe(false);
    expect(result.current.swapPanes('missing', 'b')).toBe(false);
    expect(renderCount).toBe(rendersBeforeNoOps);
    expect(writeWorkspaceUiMock).not.toHaveBeenCalled();
  });

  it('queues a pre-hydration lifecycle replacement and persists the transformed saved record once', async () => {
    const read = deferred<string | null>();
    readWorkspaceUiMock.mockReturnValue(read.promise);
    const { result, rerender } = renderHook(
      ({ canonicalSessionIds }: { canonicalSessionIds: string[] }) => usePaneOrder({
        workspaceId: 'ws-1',
        canonicalSessionIds,
      }),
      { initialProps: { canonicalSessionIds: ['a', 'old', 'b'] } },
    );

    act(() => {
      expect(result.current.replaceSessionId('old', 'new')).toBe(true);
    });
    rerender({ canonicalSessionIds: ['a', 'b', 'new'] });
    expect(result.current.orderedSessionIds).toEqual(['a', 'new', 'b']);
    expect(writeWorkspaceUiMock).not.toHaveBeenCalled();

    act(() => {
      read.resolve('{"version":1,"sessionIds":["b","old","a"]}');
    });
    await waitFor(() => {
      expect(result.current.reorderReady).toBe(true);
    });

    expect(result.current.orderedSessionIds).toEqual(['b', 'new', 'a']);
    expect(writeWorkspaceUiMock).toHaveBeenCalledTimes(1);
    expect(writeWorkspaceUiMock).toHaveBeenCalledWith(
      'ws-1',
      'commandRoom.paneOrder',
      '{"version":1,"sessionIds":["b","new","a"]}',
    );
  });

  it('persists an applied lifecycle replacement after hydration', async () => {
    readWorkspaceUiMock.mockResolvedValue(
      '{"version":1,"sessionIds":["b","old","a"]}',
    );
    const { result, rerender } = renderHook(
      ({ canonicalSessionIds }: { canonicalSessionIds: string[] }) => usePaneOrder({
        workspaceId: 'ws-1',
        canonicalSessionIds,
      }),
      { initialProps: { canonicalSessionIds: ['a', 'old', 'b'] } },
    );
    await waitFor(() => {
      expect(result.current.reorderReady).toBe(true);
    });

    act(() => {
      expect(result.current.replaceSessionId('old', 'new')).toBe(true);
    });
    rerender({ canonicalSessionIds: ['a', 'b', 'new'] });

    expect(result.current.orderedSessionIds).toEqual(['b', 'new', 'a']);
    expect(writeWorkspaceUiMock).toHaveBeenCalledWith(
      'ws-1',
      'commandRoom.paneOrder',
      '{"version":1,"sessionIds":["b","new","a"]}',
    );
  });
});

describe('usePaneOrder races and passive canonical changes', () => {
  it('ignores a late read from the previous workspace', async () => {
    const reads = {
      'ws-a': deferred<string | null>(),
      'ws-b': deferred<string | null>(),
    };
    readWorkspaceUiMock.mockImplementation((workspaceId) => reads[
      workspaceId as keyof typeof reads
    ].promise);
    const { result, rerender } = renderHook(
      ({ workspaceId, canonicalSessionIds }: {
        workspaceId: string;
        canonicalSessionIds: string[];
      }) => usePaneOrder({ workspaceId, canonicalSessionIds }),
      {
        initialProps: {
          workspaceId: 'ws-a',
          canonicalSessionIds: ['a-1', 'a-2'],
        },
      },
    );

    rerender({
      workspaceId: 'ws-b',
      canonicalSessionIds: ['b-1', 'b-2'],
    });
    expect(result.current.orderedSessionIds).toEqual(['b-1', 'b-2']);
    expect(result.current.reorderReady).toBe(false);

    act(() => {
      reads['ws-b'].resolve('{"version":1,"sessionIds":["b-2","b-1"]}');
    });
    await waitFor(() => {
      expect(result.current.reorderReady).toBe(true);
    });
    expect(result.current.orderedSessionIds).toEqual(['b-2', 'b-1']);

    await act(async () => {
      reads['ws-a'].resolve('{"version":1,"sessionIds":["a-2","a-1"]}');
      await reads['ws-a'].promise;
    });

    expect(result.current.orderedSessionIds).toEqual(['b-2', 'b-1']);
    expect(result.current.reorderReady).toBe(true);
    expect(writeWorkspaceUiMock).not.toHaveBeenCalled();
  });

  it('drops closed panes and appends added panes without a passive write', async () => {
    readWorkspaceUiMock.mockResolvedValue(
      '{"version":1,"sessionIds":["c","a","b"]}',
    );
    const { result, rerender } = renderHook(
      ({ canonicalSessionIds }: { canonicalSessionIds: string[] }) => usePaneOrder({
        workspaceId: 'ws-1',
        canonicalSessionIds,
      }),
      { initialProps: { canonicalSessionIds: ['a', 'b', 'c'] } },
    );
    await waitFor(() => {
      expect(result.current.reorderReady).toBe(true);
    });

    rerender({ canonicalSessionIds: ['a', 'c', 'd'] });

    expect(result.current.orderedSessionIds).toEqual(['c', 'a', 'd']);
    expect(writeWorkspaceUiMock).not.toHaveBeenCalled();
  });

  it('keeps the canonical order usable when reads and best-effort writes reject', async () => {
    readWorkspaceUiMock.mockRejectedValue(new Error('read failed'));
    writeWorkspaceUiMock.mockRejectedValue(new Error('write failed'));
    const { result } = renderHook(() => usePaneOrder({
      workspaceId: 'ws-1',
      canonicalSessionIds: ['a', 'b'],
    }));
    await waitFor(() => {
      expect(result.current.reorderReady).toBe(true);
    });

    act(() => {
      expect(result.current.swapPanes('a', 'b')).toBe(true);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.orderedSessionIds).toEqual(['b', 'a']);
    expect(writeWorkspaceUiMock).toHaveBeenCalledTimes(1);
  });
});
