// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the KV client BEFORE importing the module under test.
const kvGet = vi.fn<(k: string) => Promise<string | null>>();
const kvSet = vi.fn<(k: string, v: string) => Promise<void>>();
vi.mock('@/renderer/lib/rpc', () => ({
  rpc: { kv: { get: (k: string) => kvGet(k) } },
  rpcSilent: { kv: { set: (k: string, v: string) => kvSet(k, v) } },
}));

import {
  ZOOM_DEFAULT,
  ZOOM_KV_KEY,
  ZOOM_MAX,
  ZOOM_MIN,
  applyZoom,
  clampZoom,
  getZoom,
  loadPersistedZoom,
  persistZoom,
  resetZoom,
  zoomByWheel,
  zoomIn,
  zoomOut,
} from './zoom';

const setZoomFactor = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  setZoomFactor.mockClear();
  kvGet.mockReset();
  kvSet.mockReset().mockResolvedValue(undefined);
  (window as unknown as { sigma: { setZoomFactor: typeof setZoomFactor; getZoomFactor: () => number } }).sigma = {
    setZoomFactor,
    getZoomFactor: () => 1,
  };
  resetZoom(); // normalise module state to 1.0 between tests
  setZoomFactor.mockClear();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

describe('clampZoom', () => {
  it('clamps below min, above max, and coerces NaN to default', () => {
    expect(clampZoom(0.3)).toBe(ZOOM_MIN);
    expect(clampZoom(3)).toBe(ZOOM_MAX);
    expect(clampZoom(Number.NaN)).toBe(ZOOM_DEFAULT);
    expect(clampZoom(1.25)).toBe(1.25);
  });
});

describe('applyZoom', () => {
  it('clamps, stores, and drives the native bridge', () => {
    expect(applyZoom(1.5)).toBe(1.5);
    expect(getZoom()).toBe(1.5);
    expect(setZoomFactor).toHaveBeenCalledWith(1.5);
    applyZoom(99);
    expect(setZoomFactor).toHaveBeenLastCalledWith(ZOOM_MAX);
  });

  it('never throws when the bridge is absent', () => {
    delete (window as unknown as { sigma?: unknown }).sigma;
    expect(() => applyZoom(1.2)).not.toThrow();
    expect(getZoom()).toBe(1.2);
  });
});

describe('step helpers', () => {
  it('zoomByWheel grows on negative deltaY and shrinks on positive', () => {
    const up = zoomByWheel(-100);
    expect(up).toBeGreaterThan(1);
    resetZoom();
    const down = zoomByWheel(100);
    expect(down).toBeLessThan(1);
  });

  it('zoomIn/zoomOut step by 0.1 and reset returns to default', () => {
    expect(zoomIn()).toBeCloseTo(1.1, 5);
    expect(zoomOut()).toBeCloseTo(1.0, 5);
    applyZoom(1.7);
    expect(resetZoom()).toBe(ZOOM_DEFAULT);
  });
});

describe('persistZoom', () => {
  it('debounces and writes a clamped string to KV', () => {
    persistZoom(1.4);
    persistZoom(1.5);
    expect(kvSet).not.toHaveBeenCalled();
    vi.advanceTimersByTime(250);
    expect(kvSet).toHaveBeenCalledTimes(1);
    expect(kvSet).toHaveBeenCalledWith(ZOOM_KV_KEY, '1.5');
  });
});

describe('loadPersistedZoom', () => {
  it('parses + clamps a stored value', async () => {
    kvGet.mockResolvedValue('1.75');
    await loadPersistedZoom();
    expect(getZoom()).toBe(1.75);
    expect(setZoomFactor).toHaveBeenCalledWith(1.75);
  });

  it('falls back to default on null', async () => {
    kvGet.mockResolvedValue(null);
    await loadPersistedZoom();
    expect(getZoom()).toBe(ZOOM_DEFAULT);
  });

  it('falls back to default when KV throws', async () => {
    kvGet.mockRejectedValue(new Error('kv down'));
    await loadPersistedZoom();
    expect(getZoom()).toBe(ZOOM_DEFAULT);
  });
});
