// @vitest-environment jsdom
//
// 2026-06-10 audit finding #2 — hydrateConversation must carry a request
// token so out-of-order RPC resolutions (rapid picks, slow hydrate across a
// workspace switch) cannot paint a stale conversation over the active one.
// Mock surface mirrors JorvisRoom.b3.test.tsx (window.sigma side-band stub +
// '@/renderer/lib/rpc' kv mock + '@/renderer/app/state' workspace mock).
//
// DRIFT NOTE: Phase 9 (#143) selectorized this hook — it reads the active
// workspace via `useAppStateSelector((s) => s.activeWorkspace?.id)` instead of
// a broad `useAppState()`. The state mock below therefore provides
// `useAppStateSelector`, applying the selector to a live `activeWorkspace`
// holder so the ws-switch test can flip workspaces between rerenders.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  kvGet: vi.fn(),
  kvSet: vi.fn(),
  ws: { current: { id: 'ws-1', name: 'WS One' } as { id: string; name: string } | null },
}));

vi.mock('@/renderer/app/state', () => ({
  useAppStateSelector: <T,>(selector: (s: { activeWorkspace: { id: string; name: string } | null }) => T): T =>
    selector({ activeWorkspace: mocks.ws.current }),
}));

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    kv: {
      get: (...args: unknown[]) => mocks.kvGet(...args),
      set: (...args: unknown[]) => mocks.kvSet(...args),
    },
  },
}));

import { useJorvisConversations } from './use-jorvis-conversations';

interface Envelope {
  ok: true;
  data: unknown;
}
interface Deferred {
  resolve: (env: Envelope) => void;
  promise: Promise<Envelope>;
}
function deferred(): Deferred {
  let resolve!: (env: Envelope) => void;
  const promise = new Promise<Envelope>((r) => {
    resolve = r;
  });
  return { resolve, promise };
}

function listRow(id: string) {
  return { id, title: id, lastMessageAt: 1, messageCount: 1, claudeSessionId: null };
}

function getEnvelope(id: string): Envelope {
  return {
    ok: true,
    data: {
      conversation: { id, workspaceId: 'ws-1', title: id, createdAt: 1, claudeSessionId: null },
      messages: [
        { id: `${id}-m1`, role: 'assistant', content: `hello from ${id}`, toolCallId: null, createdAt: 2 },
      ],
    },
  };
}

const getDeferreds = new Map<string, Deferred>();
let listRowsByWs: Record<string, ReturnType<typeof listRow>[]> = {};

function resolveGet(id: string): void {
  const d = getDeferreds.get(id);
  if (!d) throw new Error(`no pending conversations.get for ${id}`);
  d.resolve(getEnvelope(id));
}

function installSigma(): void {
  const invoke = vi.fn(async (channel: string, payload?: Record<string, unknown>) => {
    if (channel === 'assistant.conversations.list') {
      const wsId = String(payload?.workspaceId ?? '');
      return { ok: true, data: listRowsByWs[wsId] ?? [] };
    }
    if (channel === 'assistant.conversations.get') {
      const id = String(payload?.conversationId ?? '');
      const d = deferred();
      getDeferreds.set(id, d);
      return d.promise;
    }
    return { ok: true, data: null };
  });
  Object.defineProperty(window, 'sigma', { configurable: true, value: { invoke } });
}

/** Macrotask flush — drains the effect's whole await chain (list → kv → get). */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getDeferreds.clear();
  listRowsByWs = {};
  mocks.ws.current = { id: 'ws-1', name: 'WS One' };
  mocks.kvGet.mockResolvedValue(null);
  mocks.kvSet.mockResolvedValue(undefined);
  installSigma();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useJorvisConversations — hydrate request token (out-of-order guard)', () => {
  it('the LAST pick wins even when its RPC resolves first', async () => {
    listRowsByWs = { 'ws-1': [] };
    const { result } = renderHook(() => useJorvisConversations());
    await flush(); // settle the mount/ws effect (empty list → blank slate)

    act(() => {
      result.current.onPickConversation('conv-a');
    });
    act(() => {
      result.current.onPickConversation('conv-b');
    });

    // B (the latest pick) resolves FIRST…
    resolveGet('conv-b');
    await flush();
    expect(result.current.conversationId).toBe('conv-b');

    // …then the STALE A resolves late. It must be discarded — pre-fix it
    // overwrites the view while kv persisted 'conv-b'.
    resolveGet('conv-a');
    await flush();

    expect(result.current.conversationId).toBe('conv-b');
    expect(result.current.messages.map((m) => m.content)).toEqual(['hello from conv-b']);
  });

  it('a slow hydrate from workspace A cannot paint inside workspace B', async () => {
    listRowsByWs = { 'ws-1': [listRow('conv-a')], 'ws-2': [] };
    mocks.kvGet.mockResolvedValue('conv-a');

    const { result, rerender } = renderHook(() => useJorvisConversations());
    await flush(); // ws-1 boot effect reaches hydrate('conv-a') — left PENDING

    // Switch workspace while the hydrate is still in flight.
    mocks.ws.current = { id: 'ws-2', name: 'WS Two' };
    rerender();
    await flush(); // ws-2 effect: empty list → blank slate

    expect(result.current.conversationId).toBeNull();

    // The stale ws-1 hydrate now resolves. It must NOT paint into ws-2.
    resolveGet('conv-a');
    await flush();

    expect(result.current.conversationId).toBeNull();
    expect(result.current.messages).toEqual([]);
  });
});
