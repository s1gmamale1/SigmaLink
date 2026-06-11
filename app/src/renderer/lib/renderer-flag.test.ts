import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const kvGet = vi.hoisted(() =>
  vi.fn<(key: string) => Promise<string | null>>(() => Promise.resolve(null)),
);
const kvSet = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@/renderer/lib/rpc', () => ({
  rpc: { kv: { get: kvGet, set: kvSet } },
  rpcSilent: { kv: { get: kvGet, set: kvSet } },
}));

import {
  __resetRendererFlagCache,
  peekRendererMode,
  RENDERER_DEFAULT_KEY,
  rendererSessionKey,
  resolveRendererMode,
  setSessionRendererMode,
} from './renderer-flag';

beforeEach(() => vi.clearAllMocks());
afterEach(() => __resetRendererFlagCache());

describe('renderer-flag', () => {
  it('defaults to dom when no KV is set (v2.4.1 default flip)', async () => {
    expect(await resolveRendererMode('s1')).toBe('dom');
  });

  it('per-session override wins over the global default', async () => {
    kvGet.mockImplementation(async (key: string) => {
      if (key === rendererSessionKey('s2')) return 'dom';
      if (key === RENDERER_DEFAULT_KEY) return 'xterm';
      return null;
    });
    expect(await resolveRendererMode('s2')).toBe('dom');
  });

  it('falls through to the global default — xterm stays one KV away', async () => {
    kvGet.mockImplementation(async (key: string) =>
      key === RENDERER_DEFAULT_KEY ? 'xterm' : null,
    );
    expect(await resolveRendererMode('s3')).toBe('xterm');
  });

  it('garbage KV values resolve to the default (validate at the boundary)', async () => {
    kvGet.mockImplementation(async () => 'webgl2-hologram');
    expect(await resolveRendererMode('s4')).toBe('dom');
  });

  it('kv failure resolves to the default (consistency over split-brain)', async () => {
    kvGet.mockImplementation(async () => {
      throw new Error('kv down');
    });
    expect(await resolveRendererMode('s5')).toBe('dom');
  });

  it('module-caches per session: peek is sync after first resolve, kv hit once', async () => {
    await resolveRendererMode('s6');
    expect(peekRendererMode('s6')).toBe('dom');
    kvGet.mockClear();
    await resolveRendererMode('s6');
    expect(kvGet).not.toHaveBeenCalled();
  });

  it('setSessionRendererMode persists and updates the cache', async () => {
    await setSessionRendererMode('s7', 'dom');
    expect(peekRendererMode('s7')).toBe('dom');
    expect(kvSet).toHaveBeenCalledWith(rendererSessionKey('s7'), 'dom');
  });
});
