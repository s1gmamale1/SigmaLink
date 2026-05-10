// V1.1.1 — runVoiceDiagnostics() unit tests.
//
// We mock the four collaborators (`./native-mac` for the platform probe,
// `./dispatcher` for the classifier smoke, `../db/client` for the kv read,
// and the global `process.platform` hint) so each scenario exercises one
// failure mode at a time. Every probe inside `diagnostics.ts` is wrapped
// in try/catch — these tests pin that behaviour by injecting throws and
// asserting the envelope still resolves with sensible defaults.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../native-mac', () => ({
  loadNative: vi.fn(),
  isNativeMacVoiceAvailable: vi.fn(),
}));

vi.mock('../../db/client', () => ({
  getRawDb: vi.fn(),
}));

import { loadNative } from '../native-mac';
import { getRawDb } from '../../db/client';
import { runVoiceDiagnostics } from '../diagnostics';

const ORIGINAL_PLATFORM = process.platform;

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

function restorePlatform(): void {
  Object.defineProperty(process, 'platform', {
    value: ORIGINAL_PLATFORM,
    configurable: true,
  });
}

interface FakeNative {
  isAvailable: () => boolean;
  getAuthStatus: () => 'granted' | 'denied' | 'restricted' | 'not-determined';
  requestPermission: () => Promise<'granted'>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  onPartial: () => () => void;
  onFinal: () => () => void;
  onError: () => () => void;
  onState: () => () => void;
}

function fakeNative(overrides: Partial<FakeNative> = {}): FakeNative {
  return {
    isAvailable: () => true,
    getAuthStatus: () => 'granted',
    requestPermission: () => Promise.resolve('granted'),
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    onPartial: () => () => {},
    onFinal: () => () => {},
    onError: () => () => {},
    onState: () => () => {},
    ...overrides,
  };
}

interface FakeStmt {
  get: (key: string) => { value?: string } | undefined;
}

function fakeDb(modeRow: { value?: string } | undefined): {
  prepare: () => FakeStmt;
} {
  return {
    prepare: () =>
      ({
        get: () => modeRow,
      }) satisfies FakeStmt,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  restorePlatform();
});

describe('runVoiceDiagnostics', () => {
  it('returns the happy-path envelope on darwin with permission granted', async () => {
    setPlatform('darwin');
    vi.mocked(loadNative).mockReturnValue(fakeNative());
    vi.mocked(getRawDb).mockReturnValue(
      fakeDb({ value: 'auto' }) as unknown as ReturnType<typeof getRawDb>,
    );

    const out = await runVoiceDiagnostics();

    expect(out).toEqual({
      nativeLoaded: true,
      permissionStatus: 'granted',
      dispatcherReachable: true,
      mode: 'auto',
      lastError: null,
    });
  });

  it('reports unsupported permission on non-darwin', async () => {
    setPlatform('linux');
    vi.mocked(loadNative).mockReturnValue(null);
    vi.mocked(getRawDb).mockReturnValue(
      fakeDb({ value: 'off' }) as unknown as ReturnType<typeof getRawDb>,
    );

    const out = await runVoiceDiagnostics();

    expect(out.nativeLoaded).toBe(false);
    expect(out.permissionStatus).toBe('unsupported');
    expect(out.dispatcherReachable).toBe(true);
    expect(out.mode).toBe('off');
    expect(out.lastError).toBeNull();
  });

  it('flags denied permission as the lastError when native is loaded', async () => {
    setPlatform('darwin');
    vi.mocked(loadNative).mockReturnValue(
      fakeNative({ getAuthStatus: () => 'denied' }),
    );
    vi.mocked(getRawDb).mockReturnValue(
      fakeDb({ value: 'auto' }) as unknown as ReturnType<typeof getRawDb>,
    );

    const out = await runVoiceDiagnostics();

    expect(out.nativeLoaded).toBe(true);
    expect(out.permissionStatus).toBe('denied');
    expect(out.lastError).toBe('microphone permission denied');
  });

  it('captures native module load failure under lastError', async () => {
    setPlatform('darwin');
    vi.mocked(loadNative).mockReturnValue(null);
    vi.mocked(getRawDb).mockReturnValue(
      fakeDb({ value: 'auto' }) as unknown as ReturnType<typeof getRawDb>,
    );

    const out = await runVoiceDiagnostics();

    expect(out.nativeLoaded).toBe(false);
    expect(out.permissionStatus).toBe('unsupported');
    expect(out.lastError).toBe('native module not loaded');
  });

  it('collapses isAvailable() = false into a structured error', async () => {
    setPlatform('darwin');
    vi.mocked(loadNative).mockReturnValue(
      fakeNative({ isAvailable: () => false }),
    );
    vi.mocked(getRawDb).mockReturnValue(
      fakeDb(undefined) as unknown as ReturnType<typeof getRawDb>,
    );

    const out = await runVoiceDiagnostics();

    expect(out.nativeLoaded).toBe(false);
    expect(out.lastError).toBe(
      'native module reports isAvailable() = false',
    );
    // Mode falls back to 'auto' when kv has no row.
    expect(out.mode).toBe('auto');
  });

  it('survives a kv read that throws', async () => {
    setPlatform('darwin');
    vi.mocked(loadNative).mockReturnValue(fakeNative());
    vi.mocked(getRawDb).mockImplementation(() => {
      throw new Error('db locked');
    });

    const out = await runVoiceDiagnostics();

    expect(out.nativeLoaded).toBe(true);
    expect(out.dispatcherReachable).toBe(true);
    // kv error surfaces in lastError once native is healthy.
    expect(out.lastError).toContain('db locked');
    expect(out.mode).toBe('auto');
  });

  it('survives a getAuthStatus that throws', async () => {
    setPlatform('darwin');
    vi.mocked(loadNative).mockReturnValue(
      fakeNative({
        getAuthStatus: () => {
          throw new Error('TCC denied');
        },
      }),
    );
    vi.mocked(getRawDb).mockReturnValue(
      fakeDb({ value: 'auto' }) as unknown as ReturnType<typeof getRawDb>,
    );

    const out = await runVoiceDiagnostics();

    expect(out.nativeLoaded).toBe(true);
    expect(out.permissionStatus).toBe('undetermined');
    expect(out.lastError).toContain('getAuthStatus failed');
  });
});
