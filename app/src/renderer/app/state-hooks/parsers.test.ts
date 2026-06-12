// v1.1.10 — coverage for the warning-level audit fixes in `parsers.ts`.
//
// Focuses on:
//   - parseSwarmMessage rejects payloads with an unknown `kind` discriminant
//     instead of silently smuggling them into AppState via an `as` cast.
//   - parseSwarmMessage still accepts every documented kind and falls back
//     to 'OPERATOR' when `kind` is absent (legacy main-process payloads).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseSwarmMessage, parseWindowScopeChanged, runRefreshOnEvent } from './parsers';
import type { SwarmMessageKind } from '../../../shared/types';

const baseRaw = {
  id: 'msg-1',
  swarmId: 'sw-1',
  from: 'operator',
  to: '*',
  body: 'hello',
  ts: 1700000000000,
};

const VALID_KINDS: SwarmMessageKind[] = [
  'SAY',
  'ACK',
  'STATUS',
  'DONE',
  'OPERATOR',
  'ROLLCALL',
  'ROLLCALL_REPLY',
  'SYSTEM',
];

describe('parseSwarmMessage runtime kind validation', () => {
  it('accepts every documented SwarmMessageKind', () => {
    for (const kind of VALID_KINDS) {
      const parsed = parseSwarmMessage({ ...baseRaw, kind });
      expect(parsed?.kind).toBe(kind);
    }
  });

  it('rejects payloads with an unknown kind string', () => {
    // Pre-v1.1.10 this would return a SwarmMessage with `kind: 'INVALID' as any`.
    expect(parseSwarmMessage({ ...baseRaw, kind: 'INVALID' })).toBeNull();
    expect(parseSwarmMessage({ ...baseRaw, kind: '' })).toBeNull();
    expect(parseSwarmMessage({ ...baseRaw, kind: 'system' })).toBeNull(); // case-sensitive
  });

  it('rejects payloads where kind is a non-string non-nullish value', () => {
    expect(parseSwarmMessage({ ...baseRaw, kind: 1 })).toBeNull();
    expect(parseSwarmMessage({ ...baseRaw, kind: {} })).toBeNull();
    expect(parseSwarmMessage({ ...baseRaw, kind: true })).toBeNull();
  });

  it('falls back to OPERATOR when kind is missing (legacy payloads)', () => {
    const parsed = parseSwarmMessage(baseRaw);
    expect(parsed?.kind).toBe('OPERATOR');
  });

  it('falls back to OPERATOR when kind is explicitly null', () => {
    const parsed = parseSwarmMessage({ ...baseRaw, kind: null });
    expect(parsed?.kind).toBe('OPERATOR');
  });

  it('still rejects payloads missing required identifiers regardless of kind', () => {
    expect(parseSwarmMessage({ kind: 'SAY' })).toBeNull();
    expect(parseSwarmMessage({ ...baseRaw, id: '' })).toBeNull();
    expect(parseSwarmMessage({ ...baseRaw, swarmId: '' })).toBeNull();
  });
});

describe('runRefreshOnEvent — perf-hot-paths Task 5: 250 ms trailing coalesce', () => {
  let eventHandler: (() => void) | null = null;
  const offSpy = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    eventHandler = null;
    offSpy.mockClear();
    vi.stubGlobal('window', {
      sigma: {
        eventOn: vi.fn((_name: string, handler: () => void) => {
          eventHandler = handler;
          return offSpy;
        }),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('mount-time hydration fires immediately (no debounce on the first fetch)', () => {
    const fetcher = vi.fn(async () => {});
    const cleanup = runRefreshOnEvent(fetcher, 'memory:changed', 'memories');
    expect(fetcher).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('a burst of 5 events coalesces into ONE trailing refetch after 250 ms', () => {
    const fetcher = vi.fn(async () => {});
    const cleanup = runRefreshOnEvent(fetcher, 'memory:changed', 'memories');
    expect(fetcher).toHaveBeenCalledTimes(1); // mount fetch

    for (let i = 0; i < 5; i++) eventHandler!();
    vi.advanceTimersByTime(249);
    expect(fetcher).toHaveBeenCalledTimes(1); // still coalescing
    vi.advanceTimersByTime(1);
    expect(fetcher).toHaveBeenCalledTimes(2); // ONE trailing refetch
    cleanup();
  });

  it('a later event re-arms the trailing window (true trailing debounce)', () => {
    const fetcher = vi.fn(async () => {});
    const cleanup = runRefreshOnEvent(fetcher, 'tasks:changed', 'tasks');
    eventHandler!();
    vi.advanceTimersByTime(200);
    eventHandler!(); // re-arms at t=200
    vi.advanceTimersByTime(200); // t=400, window ends at 450
    expect(fetcher).toHaveBeenCalledTimes(1); // mount only
    vi.advanceTimersByTime(50);
    expect(fetcher).toHaveBeenCalledTimes(2);
    cleanup();
  });

  it('cleanup cancels a pending debounced refetch and unsubscribes', () => {
    const fetcher = vi.fn(async () => {});
    const cleanup = runRefreshOnEvent(fetcher, 'skills:changed', 'skills');
    eventHandler!();
    cleanup();
    vi.advanceTimersByTime(1_000);
    expect(fetcher).toHaveBeenCalledTimes(1); // mount fetch only
    expect(offSpy).toHaveBeenCalledTimes(1);
  });
});

describe('parseWindowScopeChanged — multi-window B3 scope table', () => {
  it('parses a well-formed multi-window scope table', () => {
    const parsed = parseWindowScopeChanged({
      scopes: [
        { windowId: 1, isMain: true, workspaceIds: ['a', 'c'] },
        { windowId: 2, isMain: false, workspaceIds: ['b'] },
      ],
    });
    expect(parsed).toEqual([
      { windowId: 1, isMain: true, workspaceIds: ['a', 'c'] },
      { windowId: 2, isMain: false, workspaceIds: ['b'] },
    ]);
  });

  it('tolerates extra unknown fields on an entry (accepted; extras not echoed)', () => {
    const parsed = parseWindowScopeChanged({
      scopes: [{ windowId: 1, isMain: true, workspaceIds: ['a'], focused: true, zOrder: 3 }],
    });
    // toEqual is exact on keys — proves the extra fields are NOT echoed through.
    expect(parsed).toEqual([{ windowId: 1, isMain: true, workspaceIds: ['a'] }]);
  });

  it('accepts an empty scopes array and empty workspaceIds', () => {
    expect(parseWindowScopeChanged({ scopes: [] })).toEqual([]);
    expect(
      parseWindowScopeChanged({ scopes: [{ windowId: 1, isMain: true, workspaceIds: [] }] }),
    ).toEqual([{ windowId: 1, isMain: true, workspaceIds: [] }]);
  });

  it('rejects non-object / missing-scopes payloads', () => {
    expect(parseWindowScopeChanged(null)).toBeNull();
    expect(parseWindowScopeChanged(undefined)).toBeNull();
    expect(parseWindowScopeChanged('x')).toBeNull();
    expect(parseWindowScopeChanged({})).toBeNull();
    expect(parseWindowScopeChanged({ scopes: 'nope' })).toBeNull();
  });

  it('rejects the WHOLE payload when any entry is malformed', () => {
    // non-integer windowId
    expect(
      parseWindowScopeChanged({ scopes: [{ windowId: 1.5, isMain: true, workspaceIds: [] }] }),
    ).toBeNull();
    // non-number windowId
    expect(
      parseWindowScopeChanged({ scopes: [{ windowId: 'x', isMain: true, workspaceIds: [] }] }),
    ).toBeNull();
    // non-boolean isMain
    expect(
      parseWindowScopeChanged({ scopes: [{ windowId: 1, isMain: 'yes', workspaceIds: [] }] }),
    ).toBeNull();
    // non-array workspaceIds
    expect(
      parseWindowScopeChanged({ scopes: [{ windowId: 1, isMain: true, workspaceIds: 'a' }] }),
    ).toBeNull();
    // a non-string id inside workspaceIds
    expect(
      parseWindowScopeChanged({ scopes: [{ windowId: 1, isMain: true, workspaceIds: ['a', 3] }] }),
    ).toBeNull();
    // an empty-string id inside workspaceIds
    expect(
      parseWindowScopeChanged({ scopes: [{ windowId: 1, isMain: true, workspaceIds: ['a', ''] }] }),
    ).toBeNull();
    // null entry
    expect(parseWindowScopeChanged({ scopes: [null] })).toBeNull();
  });
});
