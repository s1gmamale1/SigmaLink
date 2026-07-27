// @vitest-environment jsdom

import { useLayoutEffect } from 'react';
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
      expect(result.current.replaceSessionId('ws-1', 'old', 'new')).toBe(true);
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

  it.each([
    [
      'null',
      null,
      ['a', 'new', 'b', 'c'],
    ],
    [
      'malformed',
      '{"version":1,"sessionIds":',
      ['a', 'new', 'b', 'c'],
    ],
    [
      'valid partial',
      '{"version":1,"sessionIds":["c","a"]}',
      ['c', 'a', 'new', 'b'],
    ],
  ] as const)(
    'uses the complete optimistic projection when a %s record omits the queued old ID',
    async (_recordKind, rawOrder, expectedOrder) => {
      const read = deferred<string | null>();
      readWorkspaceUiMock.mockReturnValue(read.promise);
      const { result, rerender } = renderHook(
        ({ canonicalSessionIds }: { canonicalSessionIds: string[] }) => usePaneOrder({
          workspaceId: 'ws-1',
          canonicalSessionIds,
        }),
        { initialProps: { canonicalSessionIds: ['a', 'old', 'b', 'c'] } },
      );

      act(() => {
        expect(result.current.replaceSessionId('ws-1', 'old', 'new')).toBe(true);
      });
      rerender({ canonicalSessionIds: ['a', 'b', 'c', 'new'] });
      expect(result.current.orderedSessionIds).toEqual(['a', 'new', 'b', 'c']);
      expect(writeWorkspaceUiMock).not.toHaveBeenCalled();

      act(() => {
        read.resolve(rawOrder);
      });
      await waitFor(() => {
        expect(result.current.reorderReady).toBe(true);
      });

      expect(result.current.orderedSessionIds).toEqual(expectedOrder);
      expect(writeWorkspaceUiMock).toHaveBeenCalledTimes(1);
      expect(writeWorkspaceUiMock).toHaveBeenCalledWith(
        'ws-1',
        'commandRoom.paneOrder',
        JSON.stringify({ version: 1, sessionIds: expectedOrder }),
      );
    },
  );

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
      expect(result.current.replaceSessionId('ws-1', 'old', 'new')).toBe(true);
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

  it('retains a queued replacement when switching away and back before hydration', async () => {
    const firstWorkspaceARead = deferred<string | null>();
    const workspaceBRead = deferred<string | null>();
    const secondWorkspaceARead = deferred<string | null>();
    let workspaceAReadCount = 0;
    readWorkspaceUiMock.mockImplementation((workspaceId) => {
      if (workspaceId === 'ws-b') {
        return workspaceBRead.promise;
      }
      workspaceAReadCount += 1;
      return workspaceAReadCount === 1
        ? firstWorkspaceARead.promise
        : secondWorkspaceARead.promise;
    });
    const { result, rerender } = renderHook(
      ({ workspaceId, canonicalSessionIds }: {
        workspaceId: string;
        canonicalSessionIds: string[];
      }) => usePaneOrder({ workspaceId, canonicalSessionIds }),
      {
        initialProps: {
          workspaceId: 'ws-a',
          canonicalSessionIds: ['a', 'old', 'b'],
        },
      },
    );

    act(() => {
      expect(result.current.replaceSessionId('ws-a', 'old', 'new')).toBe(true);
    });
    rerender({
      workspaceId: 'ws-a',
      canonicalSessionIds: ['a', 'b', 'new'],
    });
    expect(result.current.orderedSessionIds).toEqual(['a', 'new', 'b']);

    rerender({
      workspaceId: 'ws-b',
      canonicalSessionIds: ['b-1'],
    });
    act(() => {
      firstWorkspaceARead.resolve('{"version":1,"sessionIds":["b","old","a"]}');
      workspaceBRead.resolve('{"version":1,"sessionIds":["b-1"]}');
    });
    await waitFor(() => {
      expect(result.current.reorderReady).toBe(true);
    });
    expect(result.current.orderedSessionIds).toEqual(['b-1']);
    expect(writeWorkspaceUiMock).not.toHaveBeenCalled();

    rerender({
      workspaceId: 'ws-a',
      canonicalSessionIds: ['a', 'b', 'new'],
    });
    expect(result.current.reorderReady).toBe(false);
    expect(result.current.orderedSessionIds).toEqual(['a', 'new', 'b']);

    act(() => {
      secondWorkspaceARead.resolve('{"version":1,"sessionIds":["b","old","a"]}');
    });
    await waitFor(() => {
      expect(result.current.reorderReady).toBe(true);
    });

    expect(result.current.orderedSessionIds).toEqual(['b', 'new', 'a']);
    expect(writeWorkspaceUiMock).toHaveBeenCalledTimes(1);
    expect(writeWorkspaceUiMock).toHaveBeenCalledWith(
      'ws-a',
      'commandRoom.paneOrder',
      '{"version":1,"sessionIds":["b","new","a"]}',
    );
  });

  it('queues a replacement for its explicit inactive workspace before hydration', async () => {
    const firstWorkspaceARead = deferred<string | null>();
    const workspaceBRead = deferred<string | null>();
    const secondWorkspaceARead = deferred<string | null>();
    let workspaceAReadCount = 0;
    readWorkspaceUiMock.mockImplementation((workspaceId) => {
      if (workspaceId === 'ws-b') return workspaceBRead.promise;
      workspaceAReadCount += 1;
      return workspaceAReadCount === 1
        ? firstWorkspaceARead.promise
        : secondWorkspaceARead.promise;
    });
    const { result, rerender } = renderHook(
      ({ workspaceId, canonicalSessionIds }: {
        workspaceId: string;
        canonicalSessionIds: string[];
      }) => usePaneOrder({ workspaceId, canonicalSessionIds }),
      {
        initialProps: {
          workspaceId: 'ws-a',
          canonicalSessionIds: ['a', 'old', 'b'],
        },
      },
    );

    rerender({
      workspaceId: 'ws-b',
      canonicalSessionIds: ['b-1', 'b-2'],
    });
    act(() => {
      workspaceBRead.resolve('{"version":1,"sessionIds":["b-2","b-1"]}');
    });
    await waitFor(() => {
      expect(result.current.reorderReady).toBe(true);
    });

    act(() => {
      expect(result.current.replaceSessionId('ws-a', 'old', 'new')).toBe(true);
    });
    expect(result.current.orderedSessionIds).toEqual(['b-2', 'b-1']);
    expect(writeWorkspaceUiMock).not.toHaveBeenCalled();

    rerender({
      workspaceId: 'ws-a',
      canonicalSessionIds: ['a', 'b', 'new'],
    });
    expect(result.current.orderedSessionIds).toEqual(['a', 'new', 'b']);
    act(() => {
      secondWorkspaceARead.resolve('{"version":1,"sessionIds":["b","old","a"]}');
    });
    await waitFor(() => {
      expect(result.current.reorderReady).toBe(true);
    });

    expect(result.current.orderedSessionIds).toEqual(['b', 'new', 'a']);
    expect(writeWorkspaceUiMock).toHaveBeenCalledTimes(1);
    expect(writeWorkspaceUiMock).toHaveBeenCalledWith(
      'ws-a',
      'commandRoom.paneOrder',
      '{"version":1,"sessionIds":["b","new","a"]}',
    );

    firstWorkspaceARead.resolve(null);
  });

  it('rejects swaps while a cached workspace fresh read is pending', async () => {
    const secondWorkspaceARead = deferred<string | null>();
    let workspaceAReadCount = 0;
    readWorkspaceUiMock.mockImplementation((workspaceId) => {
      if (workspaceId === 'ws-b') {
        return Promise.resolve('{"version":1,"sessionIds":["b-2","b-1"]}');
      }
      workspaceAReadCount += 1;
      return workspaceAReadCount === 1
        ? Promise.resolve('{"version":1,"sessionIds":["a-2","a-1"]}')
        : secondWorkspaceARead.promise;
    });
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
    await waitFor(() => {
      expect(result.current.reorderReady).toBe(true);
    });

    rerender({
      workspaceId: 'ws-b',
      canonicalSessionIds: ['b-1', 'b-2'],
    });
    await waitFor(() => {
      expect(result.current.orderedSessionIds).toEqual(['b-2', 'b-1']);
      expect(result.current.reorderReady).toBe(true);
    });
    writeWorkspaceUiMock.mockClear();

    rerender({
      workspaceId: 'ws-a',
      canonicalSessionIds: ['a-1', 'a-2'],
    });
    expect(result.current.orderedSessionIds).toEqual(['a-2', 'a-1']);
    let swapAccepted = true;
    act(() => {
      swapAccepted = result.current.swapPanes('a-2', 'a-1');
    });

    expect(swapAccepted).toBe(false);
    expect(result.current.reorderReady).toBe(false);
    expect(result.current.orderedSessionIds).toEqual(['a-2', 'a-1']);
    expect(writeWorkspaceUiMock).not.toHaveBeenCalled();

    act(() => {
      secondWorkspaceARead.resolve('{"version":1,"sessionIds":["a-2","a-1"]}');
    });
    await waitFor(() => {
      expect(result.current.reorderReady).toBe(true);
    });
    expect(result.current.orderedSessionIds).toEqual(['a-2', 'a-1']);
    expect(writeWorkspaceUiMock).not.toHaveBeenCalled();
  });

  it('queues a lifecycle replacement behind a cached workspace fresh read', async () => {
    const secondWorkspaceARead = deferred<string | null>();
    let workspaceAReadCount = 0;
    readWorkspaceUiMock.mockImplementation((workspaceId) => {
      if (workspaceId === 'ws-b') {
        return Promise.resolve('{"version":1,"sessionIds":["b2","b1"]}');
      }
      workspaceAReadCount += 1;
      return workspaceAReadCount === 1
        ? Promise.resolve('{"version":1,"sessionIds":["a3","old","a1"]}')
        : secondWorkspaceARead.promise;
    });
    const { result, rerender } = renderHook(
      ({ workspaceId, canonicalSessionIds }: {
        workspaceId: string;
        canonicalSessionIds: string[];
      }) => usePaneOrder({ workspaceId, canonicalSessionIds }),
      {
        initialProps: {
          workspaceId: 'ws-a',
          canonicalSessionIds: ['a1', 'old', 'a3'],
        },
      },
    );
    await waitFor(() => {
      expect(result.current.reorderReady).toBe(true);
    });

    rerender({
      workspaceId: 'ws-b',
      canonicalSessionIds: ['b1', 'b2'],
    });
    await waitFor(() => {
      expect(result.current.orderedSessionIds).toEqual(['b2', 'b1']);
      expect(result.current.reorderReady).toBe(true);
    });
    writeWorkspaceUiMock.mockClear();

    rerender({
      workspaceId: 'ws-a',
      canonicalSessionIds: ['a1', 'old', 'a3'],
    });
    expect(result.current.orderedSessionIds).toEqual(['a3', 'old', 'a1']);
    act(() => {
      expect(result.current.replaceSessionId('ws-a', 'old', 'new')).toBe(true);
    });
    rerender({
      workspaceId: 'ws-a',
      canonicalSessionIds: ['a1', 'a3', 'new'],
    });

    expect(result.current.reorderReady).toBe(false);
    expect(result.current.orderedSessionIds).toEqual(['a3', 'new', 'a1']);
    expect(writeWorkspaceUiMock).not.toHaveBeenCalled();

    act(() => {
      secondWorkspaceARead.resolve('{"version":1,"sessionIds":["a3","old","a1"]}');
    });
    await waitFor(() => {
      expect(result.current.reorderReady).toBe(true);
    });
    expect(result.current.orderedSessionIds).toEqual(['a3', 'new', 'a1']);
    expect(writeWorkspaceUiMock).toHaveBeenCalledTimes(1);
    expect(writeWorkspaceUiMock).toHaveBeenCalledWith(
      'ws-a',
      'commandRoom.paneOrder',
      '{"version":1,"sessionIds":["a3","new","a1"]}',
    );

    rerender({
      workspaceId: 'ws-b',
      canonicalSessionIds: ['b1', 'b2'],
    });
    await waitFor(() => {
      expect(result.current.orderedSessionIds).toEqual(['b2', 'b1']);
    });
    expect(writeWorkspaceUiMock).not.toHaveBeenCalledWith(
      'ws-b',
      'commandRoom.paneOrder',
      expect.any(String),
    );
  });

  it('retains a layout-phase replacement while active workspace state still belongs to the previous workspace', async () => {
    const secondWorkspaceARead = deferred<string | null>();
    let workspaceAReadCount = 0;
    readWorkspaceUiMock.mockImplementation((workspaceId) => {
      if (workspaceId === 'ws-b') {
        return Promise.resolve('{"version":1,"sessionIds":["b2","b1"]}');
      }
      workspaceAReadCount += 1;
      return workspaceAReadCount === 1
        ? Promise.resolve('{"version":1,"sessionIds":["a3","old","a1"]}')
        : secondWorkspaceARead.promise;
    });
    const replacementResults: boolean[] = [];
    const { result, rerender } = renderHook(
      ({ workspaceId, canonicalSessionIds, replaceDuringLayout }: {
        workspaceId: string;
        canonicalSessionIds: string[];
        replaceDuringLayout: boolean;
      }) => {
        const paneOrder = usePaneOrder({ workspaceId, canonicalSessionIds });
        const { replaceSessionId } = paneOrder;
        useLayoutEffect(() => {
          if (replaceDuringLayout) {
            replacementResults.push(
              replaceSessionId('ws-a', 'old', 'new'),
            );
          }
        }, [replaceDuringLayout, replaceSessionId]);
        return paneOrder;
      },
      {
        initialProps: {
          workspaceId: 'ws-a',
          canonicalSessionIds: ['a1', 'old', 'a3'],
          replaceDuringLayout: false,
        },
      },
    );
    await waitFor(() => {
      expect(result.current.reorderReady).toBe(true);
    });

    rerender({
      workspaceId: 'ws-b',
      canonicalSessionIds: ['b1', 'b2'],
      replaceDuringLayout: false,
    });
    await waitFor(() => {
      expect(result.current.orderedSessionIds).toEqual(['b2', 'b1']);
      expect(result.current.reorderReady).toBe(true);
    });
    writeWorkspaceUiMock.mockClear();

    rerender({
      workspaceId: 'ws-a',
      canonicalSessionIds: ['a1', 'old', 'a3'],
      replaceDuringLayout: true,
    });

    expect(replacementResults).toEqual([true]);
    expect(result.current.reorderReady).toBe(false);
    expect(writeWorkspaceUiMock).not.toHaveBeenCalled();

    rerender({
      workspaceId: 'ws-a',
      canonicalSessionIds: ['a1', 'a3', 'new'],
      replaceDuringLayout: false,
    });
    expect(result.current.orderedSessionIds).toEqual(['a3', 'new', 'a1']);
    act(() => {
      secondWorkspaceARead.resolve('{"version":1,"sessionIds":["a3","old","a1"]}');
    });
    await waitFor(() => {
      expect(result.current.reorderReady).toBe(true);
    });

    expect(result.current.orderedSessionIds).toEqual(['a3', 'new', 'a1']);
    expect(writeWorkspaceUiMock).toHaveBeenCalledTimes(1);
    expect(writeWorkspaceUiMock).toHaveBeenCalledWith(
      'ws-a',
      'commandRoom.paneOrder',
      '{"version":1,"sessionIds":["a3","new","a1"]}',
    );

    rerender({
      workspaceId: 'ws-b',
      canonicalSessionIds: ['b1', 'b2'],
      replaceDuringLayout: false,
    });
    await waitFor(() => {
      expect(result.current.orderedSessionIds).toEqual(['b2', 'b1']);
    });
    expect(writeWorkspaceUiMock).not.toHaveBeenCalledWith(
      'ws-b',
      'commandRoom.paneOrder',
      expect.any(String),
    );
  });

  it('uses the complete cached order for an inactive A-to-B layout-phase replacement', async () => {
    const secondWorkspaceARead = deferred<string | null>();
    let workspaceAReadCount = 0;
    readWorkspaceUiMock.mockImplementation((workspaceId) => {
      if (workspaceId === 'ws-b') {
        return Promise.resolve('{"version":1,"sessionIds":["b2","b1"]}');
      }
      workspaceAReadCount += 1;
      return workspaceAReadCount === 1
        ? Promise.resolve('{"version":1,"sessionIds":["a3","a1"]}')
        : secondWorkspaceARead.promise;
    });
    const replacementResults: boolean[] = [];
    const { result, rerender } = renderHook(
      ({ workspaceId, canonicalSessionIds, replaceDuringLayout }: {
        workspaceId: string;
        canonicalSessionIds: string[];
        replaceDuringLayout: boolean;
      }) => {
        const paneOrder = usePaneOrder({ workspaceId, canonicalSessionIds });
        const { replaceSessionId } = paneOrder;
        useLayoutEffect(() => {
          if (replaceDuringLayout) {
            replacementResults.push(
              replaceSessionId('ws-a', 'old', 'new'),
            );
          }
        }, [replaceDuringLayout, replaceSessionId]);
        return paneOrder;
      },
      {
        initialProps: {
          workspaceId: 'ws-a',
          canonicalSessionIds: ['a1', 'passive-before', 'old', 'passive-after', 'a3'],
          replaceDuringLayout: false,
        },
      },
    );
    await waitFor(() => {
      expect(result.current.reorderReady).toBe(true);
    });
    expect(result.current.orderedSessionIds).toEqual([
      'a3',
      'a1',
      'passive-before',
      'old',
      'passive-after',
    ]);
    expect(writeWorkspaceUiMock).not.toHaveBeenCalled();

    rerender({
      workspaceId: 'ws-b',
      canonicalSessionIds: ['b1', 'b2'],
      replaceDuringLayout: true,
    });

    expect(replacementResults).toEqual([true]);
    await waitFor(() => {
      expect(result.current.orderedSessionIds).toEqual(['b2', 'b1']);
      expect(result.current.reorderReady).toBe(true);
    });
    expect(writeWorkspaceUiMock).toHaveBeenCalledTimes(1);
    expect(writeWorkspaceUiMock).toHaveBeenCalledWith(
      'ws-a',
      'commandRoom.paneOrder',
      '{"version":1,"sessionIds":["a3","a1","passive-before","new","passive-after"]}',
    );
    expect(writeWorkspaceUiMock).not.toHaveBeenCalledWith(
      'ws-b',
      'commandRoom.paneOrder',
      expect.any(String),
    );

    rerender({
      workspaceId: 'ws-a',
      canonicalSessionIds: ['a1', 'passive-before', 'new', 'passive-after', 'a3'],
      replaceDuringLayout: false,
    });
    expect(result.current.reorderReady).toBe(false);
    expect(result.current.orderedSessionIds).toEqual([
      'a3',
      'a1',
      'passive-before',
      'new',
      'passive-after',
    ]);

    act(() => {
      secondWorkspaceARead.resolve(
        '{"version":1,"sessionIds":["a3","a1","passive-before","new","passive-after"]}',
      );
    });
    await waitFor(() => {
      expect(result.current.reorderReady).toBe(true);
    });
    expect(result.current.orderedSessionIds).toEqual([
      'a3',
      'a1',
      'passive-before',
      'new',
      'passive-after',
    ]);
    expect(writeWorkspaceUiMock).toHaveBeenCalledTimes(1);
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
