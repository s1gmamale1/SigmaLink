// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { store } = vi.hoisted(() => ({ store: new Map<string, string>() }));

vi.mock('@/renderer/lib/rpc', () => ({
  rpcSilent: {
    kv: {
      get: vi.fn(async (k: string) => (store.has(k) ? store.get(k)! : null)),
      set: vi.fn(async (k: string, v: string) => {
        store.set(k, v);
      }),
    },
  },
  rpc: { kv: { get: vi.fn(), set: vi.fn() } },
}));

import {
  playCue,
  playForSeverity,
  previewCue,
  getSoundVolume,
  setSoundVolume,
  setCueMuted,
  setSoundMasterEnabled,
  invalidateSoundPrefsCache,
} from './sounds';
import {
  KV_SOUND_ENABLED,
  KV_SOUND_MUTED,
  KV_DND,
  KV_LEGACY_DING,
} from '@/shared/notification-prefs';

let oscStarts = 0;
let reducedMotion = false;
let hidden = false;

class FakeOscillator {
  type = 'sine';
  frequency = { value: 0 };
  connect() {
    return { connect: () => undefined };
  }
  start() {
    oscStarts += 1;
  }
  stop() {
    /* noop */
  }
}

class FakeAudioContext {
  currentTime = 0;
  destination = {};
  createOscillator() {
    return new FakeOscillator();
  }
  createGain() {
    return {
      gain: { setValueAtTime: () => undefined, exponentialRampToValueAtTime: () => undefined },
      connect: () => ({ connect: () => undefined }),
    };
  }
  close() {
    return Promise.resolve();
  }
}

beforeEach(() => {
  store.clear();
  invalidateSoundPrefsCache();
  oscStarts = 0;
  reducedMotion = false;
  hidden = false;
  (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
  window.matchMedia = vi.fn().mockImplementation((q: string) => ({
    matches: q.includes('reduce') ? reducedMotion : false,
    media: q,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
    onchange: null,
  })) as unknown as typeof window.matchMedia;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
});

describe('playCue gating', () => {
  it('plays an enabled, unmuted cue when not quiet', async () => {
    await playCue('agent-done');
    expect(oscStarts).toBeGreaterThan(0);
  });

  it('is silent when the master switch is off', async () => {
    store.set(KV_SOUND_ENABLED, '0');
    await playCue('agent-done');
    expect(oscStarts).toBe(0);
  });

  it('is silent when the cue is muted', async () => {
    store.set(KV_SOUND_MUTED, JSON.stringify(['agent-done']));
    await playCue('agent-done');
    expect(oscStarts).toBe(0);
  });

  it('is silent for all cues while DND is active', async () => {
    store.set(KV_DND, '1');
    await playCue('agent-done'); // alert category — still silenced by DND
    expect(oscStarts).toBe(0);
  });

  it('ui cues are silenced under reduce-motion; alert cues still play', async () => {
    reducedMotion = true;
    await playCue('send'); // ui
    expect(oscStarts).toBe(0);
    await playCue('agent-done'); // alert
    expect(oscStarts).toBeGreaterThan(0);
  });

  it('ui cues are silenced when the window is hidden', async () => {
    hidden = true;
    await playCue('message-arrive'); // ui
    expect(oscStarts).toBe(0);
  });

  it('honors the legacy ding mute key', async () => {
    store.set(KV_LEGACY_DING, '0');
    await playCue('agent-done');
    expect(oscStarts).toBe(0);
  });
});

describe('previewCue', () => {
  it('force-plays even when muted and under DND', async () => {
    store.set(KV_SOUND_MUTED, JSON.stringify(['agent-crash']));
    store.set(KV_DND, '1');
    await previewCue('agent-crash');
    expect(oscStarts).toBeGreaterThan(0);
  });
});

describe('playForSeverity', () => {
  it('maps severity to its distinct cue and plays', async () => {
    await playForSeverity('critical');
    expect(oscStarts).toBeGreaterThan(0);
  });
});

describe('persisted setters', () => {
  it('volume round-trips and clamps', async () => {
    await setSoundVolume(2);
    invalidateSoundPrefsCache();
    expect(await getSoundVolume()).toBe(1);
    await setSoundVolume(-1);
    invalidateSoundPrefsCache();
    expect(await getSoundVolume()).toBe(0);
  });

  it('setCueMuted writes the legacy key in sync', async () => {
    await setCueMuted('agent-done', true);
    expect(store.get(KV_SOUND_MUTED)).toContain('agent-done');
    expect(store.get(KV_LEGACY_DING)).toBe('0');
    await setCueMuted('agent-done', false);
    expect(store.get(KV_LEGACY_DING)).toBe('1');
  });

  it('master toggle persists', async () => {
    await setSoundMasterEnabled(false);
    expect(store.get(KV_SOUND_ENABLED)).toBe('0');
  });

  // M1 regression: notify-info/warn/error share the legacy KV_LEGACY_SOUND key.
  // Muting ONE must not drag its siblings down once the new matrix is authoritative.
  it('muting one legacy-backed notify cue leaves its siblings audible', async () => {
    await setCueMuted('notify-info', true);
    invalidateSoundPrefsCache();
    oscStarts = 0;
    await playForSeverity('warn');
    expect(oscStarts).toBeGreaterThan(0); // notify-warn still plays
    oscStarts = 0;
    await playForSeverity('error');
    expect(oscStarts).toBeGreaterThan(0); // notify-error still plays
    oscStarts = 0;
    await playForSeverity('info');
    expect(oscStarts).toBe(0); // only notify-info muted
  });
});
