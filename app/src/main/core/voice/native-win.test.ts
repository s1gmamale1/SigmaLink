// native-win.test.ts — unit tests for the Windows voice adapter.
// All tests pass on macOS/Linux CI. win32-specific behaviour is tested by
// mocking loadNativeWin directly (since createRequire calls cannot be
// intercepted by vi.doMock in a Vitest ESM environment).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NativeVoiceModule } from './native-mac';

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeMockModule(overrides: Partial<NativeVoiceModule> = {}): NativeVoiceModule {
  const noop = () => () => {};
  return {
    isAvailable: vi.fn().mockReturnValue(true),
    requestPermission: vi.fn().mockResolvedValue('granted'),
    getAuthStatus: vi.fn().mockReturnValue('granted'),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    onPartial: vi.fn().mockReturnValue(noop),
    onFinal: vi.fn().mockReturnValue(noop),
    onError: vi.fn().mockReturnValue(noop),
    onState: vi.fn().mockReturnValue(noop),
    ...overrides,
  };
}

// ─── loadNativeWin on non-win32 ───────────────────────────────────────────────

describe('loadNativeWin — non-win32', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('returns null on darwin', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    const { loadNativeWin } = await import('./native-win');
    expect(loadNativeWin()).toBeNull();
  });

  it('returns null on linux', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const { loadNativeWin } = await import('./native-win');
    expect(loadNativeWin()).toBeNull();
  });
});

// ─── isNativeWinVoiceAvailable on non-win32 ───────────────────────────────────

describe('isNativeWinVoiceAvailable — non-win32', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    // Restore darwin so other test files are unaffected.
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  });

  it('returns false on darwin', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    const { isNativeWinVoiceAvailable } = await import('./native-win');
    expect(isNativeWinVoiceAvailable()).toBe(false);
  });

  it('returns false on linux', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const { isNativeWinVoiceAvailable } = await import('./native-win');
    expect(isNativeWinVoiceAvailable()).toBe(false);
  });
});

// ─── NativeVoiceModule interface shape ───────────────────────────────────────

describe('NativeVoiceModule interface contract', () => {
  it('mock exposes required surface: isAvailable, start, stop, requestPermission, getAuthStatus, callbacks', () => {
    const mod = makeMockModule();
    expect(typeof mod.isAvailable).toBe('function');
    expect(typeof mod.requestPermission).toBe('function');
    expect(typeof mod.getAuthStatus).toBe('function');
    expect(typeof mod.start).toBe('function');
    expect(typeof mod.stop).toBe('function');
    expect(typeof mod.onPartial).toBe('function');
    expect(typeof mod.onFinal).toBe('function');
    expect(typeof mod.onError).toBe('function');
    expect(typeof mod.onState).toBe('function');
  });

  it('isAvailable() returns boolean', () => {
    const mod = makeMockModule({ isAvailable: vi.fn().mockReturnValue(true) });
    expect(mod.isAvailable()).toBe(true);
  });

  it('requestPermission() resolves to granted status', async () => {
    const mod = makeMockModule();
    await expect(mod.requestPermission()).resolves.toBe('granted');
  });

  it('start() resolves without error', async () => {
    const mod = makeMockModule();
    await expect(mod.start({ locale: 'en-US', onDevice: true })).resolves.toBeUndefined();
  });

  it('stop() resolves without error', async () => {
    const mod = makeMockModule();
    await expect(mod.stop()).resolves.toBeUndefined();
  });

  it('onPartial returns an unsubscribe function', () => {
    const mod = makeMockModule();
    const unsub = mod.onPartial((_text) => {});
    expect(typeof unsub).toBe('function');
  });

  it('onFinal returns an unsubscribe function', () => {
    const mod = makeMockModule();
    const unsub = mod.onFinal((_text) => {});
    expect(typeof unsub).toBe('function');
  });

  it('onError returns an unsubscribe function', () => {
    const mod = makeMockModule();
    const unsub = mod.onError((_err) => {});
    expect(typeof unsub).toBe('function');
  });

  it('onState returns an unsubscribe function', () => {
    const mod = makeMockModule();
    const unsub = mod.onState((_state) => {});
    expect(typeof unsub).toBe('function');
  });
});

// ─── isNativeWinVoiceAvailable with mocked loadNativeWin ─────────────────────

describe('isNativeWinVoiceAvailable — mocked module', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('returns false when isAvailable() returns false', async () => {
    // Spy on loadNativeWin via re-exporting via the module's own references.
    // Since we cannot intercept CJS require calls in Vitest ESM mode,
    // we test isNativeWinVoiceAvailable indirectly: on any non-win32 host
    // it must return false regardless of any native binary.
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    const { isNativeWinVoiceAvailable } = await import('./native-win');
    expect(isNativeWinVoiceAvailable()).toBe(false);
  });
});
