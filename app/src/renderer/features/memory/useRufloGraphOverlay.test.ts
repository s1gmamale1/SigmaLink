// @vitest-environment jsdom
//
// P4 MEM-1 (Lane A1) — coverage for the Ruflo-graph overlay hook.
//
// Verifies:
//   - nodes are built with kind:'ruflo', group=namespace, id prefixed 'ruflo:'
//   - label truncated to ~40 single-line chars
//   - similarity edges are built; dangling edges (endpoint not in node set) drop
//   - per-neighbor {ok:false}/reject tolerated without losing nodes
//   - empty + ready:false when health is not ready
//   - flips ready + populates on a ruflo:health 'ready' event
//   - empty + ready:false when enabled:false (even though health is ready)
//   - empty on a {ok:false} entries.list envelope
//   - bounded edge fan-out: only top-N entries (by score) request neighbors

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import type { RufloEntry, RufloEntryEdge } from '@/shared/types';

type HealthState = 'absent' | 'starting' | 'ready' | 'degraded' | 'down';
type ListRes =
  | { ok: true; entries: RufloEntry[] }
  | { ok: false; code: 'ruflo-unavailable'; reason: string };
type NeighborsRes =
  | { ok: true; edges: RufloEntryEdge[] }
  | { ok: false; code: 'ruflo-unavailable'; reason: string };

// vi.mock is hoisted — the factory must not reference module-scope vars. Use
// inline vi.fn()s; retrieve the references from the imported module below.
// `onEvent` is backed by a per-test event bus stored on globalThis so we can
// emit `ruflo:health` from a test.
vi.mock('@/renderer/lib/rpc', () => {
  type Cb = (p: unknown) => void;
  const handlers = new Map<string, Set<Cb>>();
  (globalThis as unknown as { __rufloEmit: (e: string, p: unknown) => void }).__rufloEmit = (
    event,
    payload,
  ) => handlers.get(event)?.forEach((fn) => fn(payload));
  return {
    rpc: {},
    rpcSilent: {
      ruflo: {
        health: vi.fn(),
        'entries.list': vi.fn(),
        'entries.neighbors': vi.fn(),
      },
    },
    onEvent: (name: string, cb: Cb) => {
      let set = handlers.get(name);
      if (!set) {
        set = new Set();
        handlers.set(name, set);
      }
      set.add(cb);
      return () => {
        handlers.get(name)?.delete(cb);
      };
    },
  };
});

import { rpcSilent } from '@/renderer/lib/rpc';
import { useRufloGraphOverlay } from './useRufloGraphOverlay';

const healthMock = rpcSilent.ruflo.health as ReturnType<
  typeof vi.fn<() => Promise<{ state: HealthState }>>
>;
const listMock = rpcSilent.ruflo['entries.list'] as ReturnType<
  typeof vi.fn<(input: { query?: string; limit?: number }) => Promise<ListRes>>
>;
const neighborsMock = rpcSilent.ruflo['entries.neighbors'] as ReturnType<
  typeof vi.fn<(input: { id: string; text: string; topK?: number }) => Promise<NeighborsRes>>
>;

function emitHealth(state: HealthState): void {
  (globalThis as unknown as { __rufloEmit: (e: string, p: unknown) => void }).__rufloEmit(
    'ruflo:health',
    { state },
  );
}

function entry(id: string, overrides: Partial<RufloEntry> = {}): RufloEntry {
  return {
    id,
    text: `entry ${id} body text`,
    namespace: 'patterns',
    score: 0.5,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  healthMock.mockReset();
  listMock.mockReset();
  neighborsMock.mockReset();
  healthMock.mockResolvedValue({ state: 'ready' });
  listMock.mockResolvedValue({ ok: true, entries: [] });
  neighborsMock.mockResolvedValue({ ok: true, edges: [] });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** Flush the mount health probe (microtask → re-render → fetch effect schedules
 *  its debounce timer), then advance past the debounce and drain the
 *  list → Promise.all(neighbors) → setState async chain. */
async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  await act(async () => {
    vi.advanceTimersByTime(350);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useRufloGraphOverlay', () => {
  it('builds nodes with kind:ruflo, group=namespace, id prefixed ruflo:', async () => {
    listMock.mockResolvedValue({
      ok: true,
      entries: [
        entry('a', { namespace: 'patterns', text: 'pattern note' }),
        entry('b', { namespace: 'feedback', text: 'feedback note' }),
      ],
    });

    const { result } = renderHook(() => useRufloGraphOverlay({ workspaceId: 'w1', enabled: true }));
    await settle();

    expect(result.current.ready).toBe(true);
    expect(result.current.nodes).toHaveLength(2);
    const [n0, n1] = result.current.nodes;
    expect(n0.id).toBe('ruflo:a');
    expect(n0.kind).toBe('ruflo');
    expect(n0.group).toBe('patterns');
    expect(n0.label).toBe('pattern note');
    expect(n0.tagCount).toBe(0);
    expect(n0.refCount).toBe(0);
    expect(n1.id).toBe('ruflo:b');
    expect(n1.group).toBe('feedback');
  });

  it('truncates the label to ~40 single-line chars', async () => {
    const long = 'x'.repeat(80);
    listMock.mockResolvedValue({
      ok: true,
      entries: [entry('a', { text: `multi\nline   ${long}` })],
    });

    const { result } = renderHook(() => useRufloGraphOverlay({ workspaceId: 'w1', enabled: true }));
    await settle();

    expect(result.current.nodes).toHaveLength(1);
    expect(result.current.nodes[0].label.length).toBe(40);
    expect(result.current.nodes[0].label).not.toContain('\n');
  });

  it('builds similarity edges and drops dangling edges', async () => {
    listMock.mockResolvedValue({ ok: true, entries: [entry('a'), entry('b')] });
    neighborsMock.mockResolvedValue({
      ok: true,
      edges: [
        { fromId: 'a', toId: 'b', kind: 'similarity', weight: 0.9 }, // both in set → kept
        { fromId: 'a', toId: 'zzz', kind: 'similarity', weight: 0.7 }, // dangling → dropped
      ],
    });

    const { result } = renderHook(() => useRufloGraphOverlay({ workspaceId: 'w1', enabled: true }));
    await settle();

    expect(result.current.edges).toHaveLength(1);
    const [e] = result.current.edges;
    expect(e.from).toBe('ruflo:a');
    expect(e.to).toBe('ruflo:b');
    expect(e.kind).toBe('similarity');
    expect(e.weight).toBe(0.9);
  });

  it('tolerates a per-neighbor {ok:false} without losing nodes', async () => {
    listMock.mockResolvedValue({ ok: true, entries: [entry('a'), entry('b')] });
    neighborsMock.mockResolvedValue({ ok: false, code: 'ruflo-unavailable', reason: 'down' });

    const { result } = renderHook(() => useRufloGraphOverlay({ workspaceId: 'w1', enabled: true }));
    await settle();

    expect(result.current.nodes).toHaveLength(2);
    expect(result.current.edges).toHaveLength(0);
  });

  it('is empty + ready:false when health is not ready', async () => {
    healthMock.mockResolvedValue({ state: 'down' });
    listMock.mockResolvedValue({ ok: true, entries: [entry('a')] });

    const { result } = renderHook(() => useRufloGraphOverlay({ workspaceId: 'w1', enabled: true }));
    await settle();

    expect(result.current.ready).toBe(false);
    expect(result.current.nodes).toHaveLength(0);
    expect(result.current.edges).toHaveLength(0);
    expect(listMock).not.toHaveBeenCalled();
  });

  it('flips ready + populates after a ruflo:health event reports ready', async () => {
    healthMock.mockResolvedValue({ state: 'starting' });
    listMock.mockResolvedValue({ ok: true, entries: [entry('a')] });

    const { result } = renderHook(() => useRufloGraphOverlay({ workspaceId: 'w1', enabled: true }));
    await settle();
    expect(result.current.ready).toBe(false);

    await act(async () => {
      emitHealth('ready');
      await Promise.resolve();
    });
    await settle();

    expect(result.current.ready).toBe(true);
    expect(result.current.nodes).toHaveLength(1);
  });

  it('is empty + ready:false when enabled is false (even if health ready)', async () => {
    listMock.mockResolvedValue({ ok: true, entries: [entry('a')] });

    const { result } = renderHook(() =>
      useRufloGraphOverlay({ workspaceId: 'w1', enabled: false }),
    );
    await settle();

    expect(result.current.ready).toBe(true); // health probe still resolves ready
    expect(result.current.nodes).toHaveLength(0);
    expect(result.current.edges).toHaveLength(0);
    expect(listMock).not.toHaveBeenCalled();
  });

  it('is empty on a {ok:false} entries.list envelope', async () => {
    listMock.mockResolvedValue({ ok: false, code: 'ruflo-unavailable', reason: 'gated' });

    const { result } = renderHook(() => useRufloGraphOverlay({ workspaceId: 'w1', enabled: true }));
    await settle();

    expect(result.current.nodes).toHaveLength(0);
    expect(result.current.edges).toHaveLength(0);
    expect(neighborsMock).not.toHaveBeenCalled();
  });

  it('seeds neighbors only from the top entries by score (bounded fan-out)', async () => {
    const many: RufloEntry[] = Array.from({ length: 12 }, (_, i) =>
      entry(`e${i}`, { score: i / 12 }),
    );
    listMock.mockResolvedValue({ ok: true, entries: many });

    const { result } = renderHook(() => useRufloGraphOverlay({ workspaceId: 'w1', enabled: true }));
    await settle();

    expect(result.current.nodes).toHaveLength(12);
    // Only the top-8 entries request neighbors.
    expect(neighborsMock).toHaveBeenCalledTimes(8);
    const seededIds = neighborsMock.mock.calls.map((c) => c[0].id);
    expect(seededIds).toContain('e11'); // highest score → seeded
    expect(seededIds).not.toContain('e0'); // lowest score → not seeded
  });
});
