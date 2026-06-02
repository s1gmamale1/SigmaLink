// SND-1 — central soundscape engine.
//
// One Web-Audio synth over the shared {@link SOUND_CATALOG}, with global volume,
// per-cue mute, and DND / quiet-hours / Reduce-Motion / hidden-window gating.
// Replaces the two ad-hoc tones that lived in `lib/notifications.ts` (which is
// now a thin back-compat shim that delegates here).
//
// Gating order in `playCue` (skipped entirely when `force` is set, e.g. the
// settings "Test" button):
//   1. master `sound.enabled` off                          → silent
//   2. this cue is muted (incl. legacy ding/sound keys)     → silent
//   3. DND or quiet-hours active                            → silent (sound is
//      never must-see; the bell + OS popup carry criticals)
//   4. `ui`-category cue while Reduce-Motion OR hidden      → silent (ambient
//      feedback only — `alert` cues still fire when you are away, by design)
//
// Per-SOURCE mute is enforced by the CALLER that knows the notification's source
// (the toast/sound path in `use-live-events.ts`), not here.
//
// Everything is best-effort: audio is non-critical, so failures (no AudioContext,
// autoplay blocked, malformed KV) fall back to silence and never throw.

import { rpcSilent } from '@/renderer/lib/rpc';
import {
  KV_SOUND_ENABLED,
  KV_SOUND_VOLUME,
  KV_SOUND_MUTED,
  KV_DND,
  KV_QUIET_HOURS,
  KV_LEGACY_DING,
  KV_LEGACY_SOUND,
  DEFAULT_SOUND_VOLUME,
  SOUND_CATALOG,
  cueDef,
  severityCue,
  parseQuietHours,
  isQuietActive,
  type SoundCue,
  type CueDef,
  type NotificationPrefs,
} from '@/shared/notification-prefs';
import type { NotificationSeverity } from '@/shared/types';

interface SoundPrefsSnapshot {
  enabled: boolean;
  volume: number;
  mutedCues: Set<SoundCue>;
  prefs: Pick<NotificationPrefs, 'dnd' | 'quietHours'>;
}

const PREFS_TTL_MS = 1500;
let cache: SoundPrefsSnapshot | null = null;
let cacheStamp = 0;

/** Invalidate the prefs cache so the next cue re-reads KV. Call after any
 *  settings mutation that affects gating (DND / quiet-hours / volume / mute). */
export function invalidateSoundPrefsCache(): void {
  cache = null;
  cacheStamp = 0;
}

async function kv(key: string): Promise<string | null> {
  try {
    return await rpcSilent.kv.get(key);
  } catch {
    return null;
  }
}

function clampVolume(v: number): number {
  if (!Number.isFinite(v)) return DEFAULT_SOUND_VOLUME;
  return Math.max(0, Math.min(1, v));
}

function parseMutedCues(raw: string | null): Set<SoundCue> {
  if (!raw) return new Set();
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    const valid = new Set(SOUND_CATALOG.map((c) => c.cue));
    return new Set(parsed.filter((c): c is SoundCue => valid.has(c as SoundCue)));
  } catch {
    return new Set();
  }
}

async function loadPrefs(): Promise<SoundPrefsSnapshot> {
  const now = Date.now();
  if (cache && now - cacheStamp < PREFS_TTL_MS) return cache;

  const [enabledRaw, volRaw, mutedRaw, dndRaw, quietRaw, dingRaw, soundRaw] = await Promise.all([
    kv(KV_SOUND_ENABLED),
    kv(KV_SOUND_VOLUME),
    kv(KV_SOUND_MUTED),
    kv(KV_DND),
    kv(KV_QUIET_HOURS),
    kv(KV_LEGACY_DING),
    kv(KV_LEGACY_SOUND),
  ]);

  const muted = parseMutedCues(mutedRaw);
  // Honor the legacy v1.13 toggles so existing user prefs don't silently flip on.
  if (dingRaw === '0') muted.add('agent-done');
  if (soundRaw === '0') {
    muted.add('notify-info');
    muted.add('notify-warn');
    muted.add('notify-error');
  }

  const snapshot: SoundPrefsSnapshot = {
    enabled: enabledRaw === null || enabledRaw === undefined ? true : enabledRaw !== '0',
    volume: volRaw === null ? DEFAULT_SOUND_VOLUME : clampVolume(Number(volRaw)),
    mutedCues: muted,
    prefs: {
      dnd: dndRaw === '1',
      quietHours: parseQuietHours(quietRaw),
    },
  };
  cache = snapshot;
  cacheStamp = now;
  return snapshot;
}

function localNowMinutes(): number {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function isHidden(): boolean {
  return typeof document !== 'undefined' && document.hidden === true;
}

/** Synthesize a cue's tone list. Best-effort; silent on any failure. */
function synth(def: CueDef, volume: number): void {
  try {
    const Ctx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const base = ctx.currentTime;
    let latestEnd = base;
    for (const tone of def.tones) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = tone.type ?? 'sine';
      osc.frequency.value = tone.freq;
      const t0 = base + tone.start;
      const t1 = t0 + tone.duration;
      const peak = Math.max(0.0001, (tone.peak ?? 0.18) * volume);
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(peak, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t1);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0);
      osc.stop(t1 + 0.02);
      if (t1 > latestEnd) latestEnd = t1;
    }
    const closeInMs = Math.ceil((latestEnd - base) * 1000) + 120;
    setTimeout(() => {
      try {
        void ctx.close();
      } catch {
        /* ignore */
      }
    }, closeInMs);
  } catch {
    /* audio is non-critical; silence preserves UX */
  }
}

interface PlayOptions {
  /** Bypass all gates (master/mute/quiet/hidden). Used by the settings preview. */
  force?: boolean;
}

/** Play a cue, subject to the gating order documented at the top of the file. */
export async function playCue(cue: SoundCue, opts: PlayOptions = {}): Promise<void> {
  const def = cueDef(cue);
  if (!def) return;
  const snap = await loadPrefs();
  if (!opts.force) {
    if (!snap.enabled) return;
    if (snap.mutedCues.has(cue)) return;
    if (isQuietActive({ ...snap.prefs, mutedSources: [] }, localNowMinutes())) return;
    if (def.category === 'ui' && (prefersReducedMotion() || isHidden())) return;
  }
  synth(def, opts.force ? Math.max(snap.volume, 0.4) : snap.volume);
}

/** Play the cue for a notification severity (distinct per-severity tone). */
export async function playForSeverity(severity: NotificationSeverity): Promise<void> {
  await playCue(severityCue(severity));
}

/** Settings "Test" — force-play a cue regardless of gates (respects volume). */
export async function previewCue(cue: SoundCue): Promise<void> {
  await playCue(cue, { force: true });
}

// ── Persisted getters / setters (used by NotificationsSettings) ───────────────

export async function getSoundMasterEnabled(): Promise<boolean> {
  return (await loadPrefs()).enabled;
}

export async function setSoundMasterEnabled(enabled: boolean): Promise<void> {
  invalidateSoundPrefsCache();
  try {
    await rpcSilent.kv.set(KV_SOUND_ENABLED, enabled ? '1' : '0');
  } catch {
    /* best-effort */
  }
}

export async function getSoundVolume(): Promise<number> {
  return (await loadPrefs()).volume;
}

export async function setSoundVolume(volume: number): Promise<void> {
  invalidateSoundPrefsCache();
  try {
    await rpcSilent.kv.set(KV_SOUND_VOLUME, String(clampVolume(volume)));
  } catch {
    /* best-effort */
  }
}

export async function getMutedCues(): Promise<Set<SoundCue>> {
  return new Set((await loadPrefs()).mutedCues);
}

/** Mute/unmute a cue, keeping its legacy KV key (if any) in sync. */
export async function setCueMuted(cue: SoundCue, muted: boolean): Promise<void> {
  const current = await getMutedCues();
  if (muted) current.add(cue);
  else current.delete(cue);
  invalidateSoundPrefsCache();
  try {
    await rpcSilent.kv.set(KV_SOUND_MUTED, JSON.stringify([...current]));
    const def = cueDef(cue);
    if (def?.legacyKey) {
      await rpcSilent.kv.set(def.legacyKey, muted ? '0' : '1');
    }
  } catch {
    /* best-effort */
  }
}
