// P4 MEM-1 — unit tests for the new ruflo.entries.* controller methods.

import { describe, it, expect, vi } from 'vitest';
import { buildRufloController } from './controller';

interface FakeProxy {
  ready: boolean;
  call: ReturnType<typeof vi.fn>;
}

function build(opts: { ready?: boolean; call?: (tool: string, args: unknown) => unknown } = {}) {
  const ready = opts.ready ?? true;
  const proxy: FakeProxy = {
    ready,
    call: vi.fn(async (tool: string, args: unknown) => (opts.call ? opts.call(tool, args) : {})),
  };
  const supervisor = { health: () => ({ state: ready ? 'ready' : 'down' }) };
  const controller = buildRufloController({
    // Minimal structural fakes — the controller only touches health()/isReady()/call().
    supervisor: supervisor as never,
    proxy: { isReady: () => proxy.ready, call: proxy.call } as never,
    installer: { start: () => ({ jobId: 'x', promise: Promise.resolve({ ok: false }) }) } as never,
  });
  return { controller, proxy };
}

describe('ruflo.entries.list', () => {
  it('forwards memory_search_unified and normalizes rows (key→id, content→text, namespace)', async () => {
    const { controller, proxy } = build({
      call: () => ({
        results: [
          { key: 'verdict:p3', content: 'shipped P3', namespace: 'patterns', score: 0.62 },
          { id: 'fallback-id', text: 'via text field', namespace: 'feedback' },
          { content: 'no id — dropped' },
        ],
      }),
    });
    const res = (await controller['entries.list']({ query: 'notifications' })) as {
      ok: true;
      entries: Array<{ id: string; text: string; namespace: string; score?: number }>;
    };
    expect(res.ok).toBe(true);
    expect(res.entries).toHaveLength(2);
    expect(res.entries[0]).toMatchObject({ id: 'verdict:p3', text: 'shipped P3', namespace: 'patterns', score: 0.62 });
    expect(res.entries[1]).toMatchObject({ id: 'fallback-id', text: 'via text field', namespace: 'feedback' });
    expect(proxy.call).toHaveBeenCalledWith('memory_search_unified', { query: 'notifications', limit: 60 });
  });

  it('degrades to unavailable when the supervisor is not ready', async () => {
    const { controller, proxy } = build({ ready: false });
    const res = (await controller['entries.list']({})) as { ok: false; code: string };
    expect(res.ok).toBe(false);
    expect(res.code).toBe('ruflo-unavailable');
    expect(proxy.call).not.toHaveBeenCalled();
  });
});

describe('ruflo.entries.neighbors', () => {
  it('builds similarity edges from embeddings_search, dropping self', async () => {
    const { controller } = build({
      call: () => ({
        results: [
          { id: 'self', score: 1 },
          { id: 'near', score: 0.8, text: 't' },
          { id: 'far', score: 0.45, text: 't' },
        ],
      }),
    });
    const res = (await controller['entries.neighbors']({ id: 'self', text: 'some text' })) as {
      ok: true;
      edges: Array<{ fromId: string; toId: string; kind: string; weight: number }>;
    };
    expect(res.ok).toBe(true);
    expect(res.edges).toEqual([
      { fromId: 'self', toId: 'near', kind: 'similarity', weight: 0.8 },
      { fromId: 'self', toId: 'far', kind: 'similarity', weight: 0.45 },
    ]);
  });

  it('returns empty edges on malformed input without calling the proxy', async () => {
    const { controller, proxy } = build();
    const res = (await controller['entries.neighbors']({ id: '', text: '' })) as { ok: true; edges: unknown[] };
    expect(res.ok).toBe(true);
    expect(res.edges).toEqual([]);
    expect(proxy.call).not.toHaveBeenCalled();
  });
});
