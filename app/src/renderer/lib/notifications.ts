// Back-compat shim over the SND-1 soundscape engine (`lib/sounds.ts`).
//
// Before P3 this file owned two ad-hoc Web-Audio tones. Those moved into the
// central `lib/sounds.ts` catalog/engine; this module now only preserves the
// historical public surface so existing call sites + their test mocks keep
// working unchanged:
//   - `playDing()`             → cue `agent-done`   (Jorvis completion chime)
//   - `playNotificationTone()` → per-severity cue   (new-notification tone)
//   - the legacy `notifications.ding` / `notifications.sound` KV toggles, which
//     `lib/sounds.ts` also honors when computing per-cue mute state.
//
// New code should import from `@/renderer/lib/sounds` directly.

import { rpcSilent } from '@/renderer/lib/rpc';
import {
  playCue,
  playForSeverity,
  invalidateSoundPrefsCache,
} from '@/renderer/lib/sounds';
import { KV_LEGACY_DING, KV_LEGACY_SOUND } from '@/shared/notification-prefs';
import type { NotificationSeverity } from '@/shared/types';

// ── Legacy toggles (unchanged semantics; default ON when unset) ───────────────

export async function getDingEnabled(): Promise<boolean> {
  try {
    const raw = await rpcSilent.kv.get(KV_LEGACY_DING);
    return raw === null || raw === undefined ? true : raw === '1';
  } catch {
    return true;
  }
}

export async function setDingEnabled(enabled: boolean): Promise<void> {
  invalidateSoundPrefsCache();
  try {
    await rpcSilent.kv.set(KV_LEGACY_DING, enabled ? '1' : '0');
  } catch {
    /* best-effort */
  }
}

export async function getNotificationSoundEnabled(): Promise<boolean> {
  try {
    const raw = await rpcSilent.kv.get(KV_LEGACY_SOUND);
    return raw === null || raw === undefined ? true : raw === '1';
  } catch {
    return true;
  }
}

export async function setNotificationSoundEnabled(enabled: boolean): Promise<void> {
  invalidateSoundPrefsCache();
  try {
    await rpcSilent.kv.set(KV_LEGACY_SOUND, enabled ? '1' : '0');
  } catch {
    /* best-effort */
  }
}

// ── Tone playback (delegates to the soundscape engine, which owns all gating) ──

/** Jorvis dispatch-finish chime. Gating (mute/DND/quiet) lives in the engine. */
export async function playDing(): Promise<void> {
  await playCue('agent-done');
}

/**
 * New-notification tone. Pass the delta's highest unread severity for a distinct
 * per-severity cue; defaults to the warning tone when no severity is supplied
 * (preserves the pre-P3 single-tone behavior for legacy callers).
 */
export async function playNotificationTone(severity?: NotificationSeverity): Promise<void> {
  await playForSeverity(severity ?? 'warn');
}
