// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useJorvisPaneEvents } from './use-jorvis-pane-events';

const handlers = new Map<string, (e: unknown) => void>();

vi.mock('@/renderer/lib/rpc', () => ({
  onEvent: (name: string, fn: (e: unknown) => void) => {
    handlers.set(name, fn);
    return () => { handlers.delete(name); };
  },
}));

describe('useJorvisPaneEvents', () => {
  it('starts empty', () => {
    const { result } = renderHook(() => useJorvisPaneEvents('conv-1'));
    expect(result.current).toEqual([]);
  });

  it('collects events for the matching conversation', async () => {
    handlers.clear();
    const { result } = renderHook(() => useJorvisPaneEvents('conv-1'));
    const fn = handlers.get('assistant:pane-event');
    expect(fn).toBeTruthy();
    const evt = { id: 'e1', conversationId: 'conv-1', sessionId: 's1', kind: 'exited' as const, ts: 1 };
    fn?.(evt);
    await waitFor(() => expect(result.current).toHaveLength(1));
    expect(result.current[0].id).toBe('e1');
  });

  it('ignores events for other conversations', async () => {
    handlers.clear();
    const { result } = renderHook(() => useJorvisPaneEvents('conv-1'));
    const fn = handlers.get('assistant:pane-event');
    expect(fn).toBeTruthy();
    fn?.({ id: 'e1', conversationId: 'conv-2', sessionId: 's1', kind: 'exited', ts: 1 });
    await waitFor(() => expect(result.current).toHaveLength(0));
  });

  it('re-renders from add() alone — snapshot identity must change (copy-on-add)', () => {
    handlers.clear();
    const { result } = renderHook(() => useJorvisPaneEvents('conv-1'));
    const before = result.current;
    const fn = handlers.get('assistant:pane-event');
    expect(fn).toBeTruthy();
    act(() => {
      fn?.({ id: 'e1', conversationId: 'conv-1', sessionId: 's1', kind: 'exited', ts: 1 });
    });
    // useSyncExternalStore bails out when getSnapshot returns the same
    // reference (Object.is). The pane-event cards only re-render if add()
    // produced a NEW array. The sibling tests above pass even WITHOUT a
    // re-render because `result.current` is the same in-place-mutated array —
    // this identity assertion is the one that catches the bailout.
    expect(result.current).not.toBe(before);
    expect(result.current).toHaveLength(1);
  });
});
