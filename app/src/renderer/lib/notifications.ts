// V3-W13-015 — Sigma completion ding + kv-backed mute toggle.
// v1.13.1 — adds playNotificationTone() for bell/panel warn+/error/critical alerts.
//
// Uses Web Audio to synth brief tones so we don't ship binary assets.
//
// kv keys:
//   `notifications.ding`   — Jorvis dispatch-finish chime. Defaults to '1' (on).
//   `notifications.sound`  — Notification bell tone.       Defaults to '1' (on, unset ⇒ on).

import { rpcSilent } from '@/renderer/lib/rpc';

const KV_DING = 'notifications.ding';
const KV_SOUND = 'notifications.sound';

let cachedEnabled: boolean | null = null;
let cachedSoundEnabled: boolean | null = null;

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

// v1.13.1 — notification-sound toggle (default ON: unset/missing → enabled).
export async function getNotificationSoundEnabled(): Promise<boolean> {
  if (cachedSoundEnabled !== null) return cachedSoundEnabled;
  try {
    const raw = await rpcSilent.kv.get(KV_SOUND);
    // Unset (null/undefined) → default ON.
    cachedSoundEnabled = raw === null || raw === undefined ? true : raw === '1';
  } catch {
    cachedSoundEnabled = true;
  }
  return cachedSoundEnabled;
}

export async function setNotificationSoundEnabled(enabled: boolean): Promise<void> {
  cachedSoundEnabled = enabled;
  try {
    await rpcSilent.kv.set(KV_SOUND, enabled ? '1' : '0');
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

/**
 * v1.13.1 — Short two-note descending tone played ONCE per notifications:changed
 * delta when the added array contains unread rows of severity warn/error/critical.
 * Audibly distinct from playDing() (D4→A3 vs A5→E6). Silent if toggled off
 * (`notifications.sound` kv key) or autoplay-blocked.
 */
export async function playNotificationTone(): Promise<void> {
  const enabled = await getNotificationSoundEnabled();
  if (!enabled) return;
  try {
    const Ctx = window.AudioContext
      ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    // D4 (293.66 Hz) → A3 (220 Hz): a short descending two-note alert.
    // Lower register and descending contour make it clearly distinct from
    // the ascending A5→E6 Jorvis chime.
    const tones = [
      { freq: 293.66, start: 0, duration: 0.14 },
      { freq: 220, start: 0.1, duration: 0.16 },
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
      gain.gain.exponentialRampToValueAtTime(0.2, t0 + 0.02);
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
    }, 500);
  } catch {
    /* audio is non-critical; silent failure preserves UX */
  }
}
