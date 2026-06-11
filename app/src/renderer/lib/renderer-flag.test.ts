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
  it('defaults to xterm when no KV is set', async () => {
    expect(await resolveRendererMode('s1')).toBe('xterm');
  });

  it('per-session override wins over the global default', async () => {
    kvGet.mockImplementation(async (key: string) => {
      if (key === rendererSessionKey('s2')) return 'dom';
      if (key === RENDERER_DEFAULT_KEY) return 'xterm';
      return null;
    });
    expect(await resolveRendererMode('s2')).toBe('dom');
  });

  it('falls through to the global default', async () => {
    kvGet.mockImplementation(async (key: string) =>
      key === RENDERER_DEFAULT_KEY ? 'dom' : null,
    );
    expect(await resolveRendererMode('s3')).toBe('dom');
  });

  it('garbage KV values resolve to xterm (validate at the boundary)', async () => {
    kvGet.mockImplementation(async () => 'webgl2-hologram');
    expect(await resolveRendererMode('s4')).toBe('xterm');
  });

  it('kv failure resolves to xterm (fallback renderer is the safe default)', async () => {
    kvGet.mockImplementation(async () => {
      throw new Error('kv down');
    });
    expect(await resolveRendererMode('s5')).toBe('xterm');
  });

  it('module-caches per session: peek is sync after first resolve, kv hit once', async () => {
    await resolveRendererMode('s6');
    expect(peekRendererMode('s6')).toBe('xterm');
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
