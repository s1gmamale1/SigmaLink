// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useSigmaPaneEvents } from './use-sigma-pane-events';

const handlers = new Map<string, (e: unknown) => void>();

vi.mock('@/renderer/lib/rpc', () => ({
  onEvent: (name: string, fn: (e: unknown) => void) => {
    handlers.set(name, fn);
    return () => { handlers.delete(name); };
  },
}));

describe('useSigmaPaneEvents', () => {
  it('starts empty', () => {
    const { result } = renderHook(() => useSigmaPaneEvents('conv-1'));
    expect(result.current).toEqual([]);
  });

  it('collects events for the matching conversation', async () => {
    handlers.clear();
    const { result } = renderHook(() => useSigmaPaneEvents('conv-1'));
    const fn = handlers.get('assistant:pane-event');
    expect(fn).toBeTruthy();
    const evt = { id: 'e1', conversationId: 'conv-1', sessionId: 's1', kind: 'exited' as const, ts: 1 };
    fn?.(evt);
    await waitFor(() => expect(result.current).toHaveLength(1));
    expect(result.current[0].id).toBe('e1');
  });

  it('ignores events for other conversations', async () => {
    handlers.clear();
    const { result } = renderHook(() => useSigmaPaneEvents('conv-1'));
    const fn = handlers.get('assistant:pane-event');
    expect(fn).toBeTruthy();
    fn?.({ id: 'e1', conversationId: 'conv-2', sessionId: 's1', kind: 'exited', ts: 1 });
    await waitFor(() => expect(result.current).toHaveLength(0));
  });
});
