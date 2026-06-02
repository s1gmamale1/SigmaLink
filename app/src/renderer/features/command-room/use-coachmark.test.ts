// @vitest-environment jsdom
//
// use-coachmark — KV-backed seen-flag hook.
// Covers:
//  1. Returns seen=false + loaded=false initially (before KV resolves).
//  2. Returns seen=false + loaded=true when KV returns null (never seen).
//  3. Returns seen=true + loaded=true when KV returns '1'.
//  4. markSeen() sets seen=true and writes '1' to rpc.kv.set.
//  5. KV errors are treated as unseen (not seen).

import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { cleanup, renderHook, act, waitFor } from '@testing-library/react';

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    kv: {
      set: vi.fn().mockResolvedValue(undefined),
    },
  },
  rpcSilent: {
    kv: {
      get: vi.fn().mockResolvedValue(null),
    },
  },
}));

import { useCoachmark } from './use-coachmark';
import { rpc, rpcSilent } from '@/renderer/lib/rpc';

const mockGet = rpcSilent.kv.get as ReturnType<typeof vi.fn>;
const mockSet = rpc.kv.set as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockGet.mockResolvedValue(null);
  mockSet.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
  cleanup();
});

describe('useCoachmark', () => {
  it('starts with loaded=false and seen=false', () => {
    // Use a promise that never resolves to keep it in pending state.
    mockGet.mockReturnValueOnce(new Promise(() => undefined));
    const { result } = renderHook(() => useCoachmark('test.key'));
    expect(result.current.loaded).toBe(false);
    expect(result.current.seen).toBe(false);
  });

  it('resolves to seen=false when KV returns null (never seen)', async () => {
    mockGet.mockResolvedValueOnce(null);
    const { result } = renderHook(() => useCoachmark('test.key'));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.seen).toBe(false);
  });

  it('resolves to seen=true when KV returns "1"', async () => {
    mockGet.mockResolvedValueOnce('1');
    const { result } = renderHook(() => useCoachmark('test.key'));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.seen).toBe(true);
  });

  it('resolves to seen=true when KV returns "true"', async () => {
    mockGet.mockResolvedValueOnce('true');
    const { result } = renderHook(() => useCoachmark('test.key'));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.seen).toBe(true);
  });

  it('treats KV errors as unseen (seen=false)', async () => {
    mockGet.mockRejectedValueOnce(new Error('IPC failed'));
    const { result } = renderHook(() => useCoachmark('test.key'));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.seen).toBe(false);
  });

  it('markSeen sets seen=true and writes "1" via rpc.kv.set', async () => {
    mockGet.mockResolvedValueOnce(null);
    const { result } = renderHook(() => useCoachmark('my.key'));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    act(() => {
      result.current.markSeen();
    });
    expect(result.current.seen).toBe(true);
    expect(mockSet).toHaveBeenCalledWith('my.key', '1');
  });

  it('calls rpcSilent.kv.get with the provided key', async () => {
    const { renderHook: rh } = await import('@testing-library/react');
    mockGet.mockResolvedValueOnce(null);
    rh(() => useCoachmark('coachmark.dragGrip.seen'));
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('coachmark.dragGrip.seen'));
  });
});
