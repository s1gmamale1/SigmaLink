// V3-W13-015 — Bridge completion ding + kv-backed mute toggle.
//
// Uses Web Audio to synth a brief two-note chime so we don't ship a binary
// asset. `kv['notifications.ding']` defaults to '1' (on); set to '0' to mute.

import { rpcSilent } from '@/renderer/lib/rpc';

const KV_DING = 'notifications.ding';

let cachedEnabled: boolean | null = null;

export async function getDingEnabled(): Promise<boolean> {
  if (cachedEnabled !== null) return cachedEnabled;
  try {
    const raw = await rpcSilent.kv.get(KV_DING);
    cachedEnabled = raw === null || raw === undefined ? true : raw === '1';
  } catch {
    cachedEnabled = true;
  }
  return cachedEnabled;
}

export async function setDingEnabled(enabled: boolean): Promise<void> {
  cachedEnabled = enabled;
  try {
    await rpcSilent.kv.set(KV_DING, enabled ? '1' : '0');
  } catch {
    /* best-effort */
  }
}

/** Brief A5→E6 chime under 300ms. Silent if muted or autoplay-blocked. */
export async function playDing(): Promise<void> {
  const enabled = await getDingEnabled();
  if (!enabled) return;
  try {
    const Ctx = window.AudioContext
      ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const tones = [
      { freq: 880, start: 0, duration: 0.16 },
      { freq: 1318.51, start: 0.1, duration: 0.18 },
    ];
    const now = ctx.currentTime;
    for (const tone of tones) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = tone.freq;
      const t0 = now + tone.start;
      const t1 = t0 + tone.duration;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.18, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t1);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0);
      osc.stop(t1 + 0.02);
    }
    setTimeout(() => {
      try {
        void ctx.close();
      } catch {
        /* ignore */
      }
    }, 600);
  } catch {
    /* audio is non-critical; silent failure preserves UX */
  }
}
