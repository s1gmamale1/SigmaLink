import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NativeVoiceModule } from './native-mac';

const mocks = vi.hoisted(() => ({
  loadNativeWin: vi.fn(),
  isNativeWinVoiceAvailable: vi.fn(),
}));

vi.mock('./native-win', () => ({
  loadNativeWin: mocks.loadNativeWin,
  isNativeWinVoiceAvailable: mocks.isNativeWinVoiceAvailable,
}));

vi.mock('./native-mac', () => ({
  loadNative: vi.fn(() => null),
  isNativeMacVoiceAvailable: vi.fn(() => false),
}));

import { buildVoiceController } from './adapter';

const ORIGINAL_PLATFORM = process.platform;

function deferredBoolean(): {
  promise: Promise<boolean>;
  resolve(value: boolean): void;
} {
  let resolve!: (value: boolean) => void;
  const promise = new Promise<boolean>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function nativeDouble(): NativeVoiceModule {
  return {
    isAvailable: vi.fn(() => true),
    requestPermission: vi.fn(async (): Promise<'granted'> => 'granted'),
    getAuthStatus: vi.fn((): 'granted' => 'granted'),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    onPartial: vi.fn(() => () => undefined),
    onFinal: vi.fn(() => () => undefined),
    onError: vi.fn(() => () => undefined),
    onState: vi.fn(() => () => undefined),
  };
}

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  vi.clearAllMocks();
  mocks.loadNativeWin.mockReturnValue(nativeDouble());
});

afterEach(() => {
  Object.defineProperty(process, 'platform', {
    value: ORIGINAL_PLATFORM,
    configurable: true,
  });
});

describe('Windows voice availability', () => {
  it('does not persist first-launch auto-enable before an unavailable probe resolves', async () => {
    const probe = deferredBoolean();
    mocks.isNativeWinVoiceAvailable.mockReturnValue(probe.promise);
    const set = vi.fn();
    const controller = buildVoiceController({
      emit: vi.fn(),
      kv: {
        get: vi.fn((key: string) => key === 'voice.mode' ? 'off' : null),
        set,
      },
    });

    expect(set).not.toHaveBeenCalledWith('voice.mode', 'auto');
    const start = controller.start({ source: 'assistant' });
    probe.resolve(false);

    await expect(start).rejects.toThrow('voice-disabled');
    expect(set).not.toHaveBeenCalledWith('voice.mode', 'auto');
    expect(set).toHaveBeenCalledWith('voice.firstLaunch', '1');
  });

  it('awaits an unavailable probe and uses renderer speech in auto mode', async () => {
    const probe = deferredBoolean();
    mocks.isNativeWinVoiceAvailable.mockReturnValue(probe.promise);
    const native = nativeDouble();
    mocks.loadNativeWin.mockReturnValue(native);
    const controller = buildVoiceController({ emit: vi.fn() });

    const start = controller.start({ source: 'assistant' });
    await Promise.resolve();
    expect(native.start).not.toHaveBeenCalled();

    probe.resolve(false);
    await expect(start).resolves.toEqual({ sessionId: expect.any(String) });
    expect(native.start).not.toHaveBeenCalled();
  });

  it('waits for an available probe before first-launch auto-enable and native start', async () => {
    const probe = deferredBoolean();
    mocks.isNativeWinVoiceAvailable.mockReturnValue(probe.promise);
    const native = nativeDouble();
    mocks.loadNativeWin.mockReturnValue(native);
    const set = vi.fn();
    const controller = buildVoiceController({
      emit: vi.fn(),
      kv: {
        get: vi.fn((key: string) => key === 'voice.mode' ? 'off' : null),
        set,
      },
    });

    const start = controller.start({ source: 'assistant' });
    await Promise.resolve();
    expect(set).not.toHaveBeenCalledWith('voice.mode', 'auto');
    expect(native.start).not.toHaveBeenCalled();

    probe.resolve(true);
    await expect(start).resolves.toEqual({ sessionId: expect.any(String) });
    expect(set).toHaveBeenCalledWith('voice.mode', 'auto');
    expect(set).toHaveBeenCalledWith('voice.firstLaunch', '1');
    expect(native.start).toHaveBeenCalledOnce();
  });

  it('does not let a late first-launch probe overwrite an explicit mode change', async () => {
    const probe = deferredBoolean();
    mocks.isNativeWinVoiceAvailable.mockReturnValue(probe.promise);
    const set = vi.fn();
    const controller = buildVoiceController({
      emit: vi.fn(),
      kv: {
        get: vi.fn((key: string) => key === 'voice.mode' ? 'off' : null),
        set,
      },
    });

    const modeChange = controller.setMode({ mode: 'web-speech' });
    probe.resolve(true);
    await modeChange;

    expect(set).toHaveBeenCalledWith('voice.mode', 'web-speech');
    expect(set).not.toHaveBeenCalledWith('voice.mode', 'auto');
  });

  it('reserves the session slot while the availability probe is pending', async () => {
    const probe = deferredBoolean();
    mocks.isNativeWinVoiceAvailable.mockReturnValue(probe.promise);
    const controller = buildVoiceController({ emit: vi.fn() });

    const first = controller.start({ source: 'assistant' });
    const second = controller.start({ source: 'mission' });
    probe.resolve(false);

    await expect(second).rejects.toThrow('voice-busy');
    await expect(first).resolves.toEqual({ sessionId: expect.any(String) });
  });
});
