// P3 (NTF-1 / SND-1) — shared notification + sound preference contract.
//
// PURE module: no electron, no DOM. Imported by BOTH the main process
// (`core/notifications/os-notify.ts` gating) and the renderer (`lib/sounds.ts`
// engine, `features/settings/NotificationsSettings.tsx` UI, the toast gate in
// `app/state-hooks/use-live-events.ts`). It is the single source of truth for:
// the new KV keys, the prefs shape, quiet-hours time math, the source taxonomy,
// the suppression predicates, and the sound cue catalog.
//
// Why a shared module: DND / quiet-hours / per-source gating must be evaluated
// identically in the main process (OS notifications) and the renderer (sound +
// toasts). Duplicating the predicates would drift; instead both import these
// pure functions and inject their own clock / KV reads.

import type { NotificationSeverity } from './types';

// ── KV keys ──────────────────────────────────────────────────────────────────
/** Do-Not-Disturb master switch. `'1'` = on. Default off. */
export const KV_DND = 'notifications.dnd';
/** Quiet-hours window — JSON {@link QuietHoursConfig}. Default disabled. */
export const KV_QUIET_HOURS = 'notifications.quietHours';
/** Per-source mute — JSON `NotificationSource[]`. Scaffolded in v1.4.9; wired here. */
export const KV_OS_PER_SOURCE = 'notifications.osPerSource';
/** Sound master switch. Unset/`'1'` = on, `'0'` = off. */
export const KV_SOUND_ENABLED = 'sound.enabled';
/** Global sound volume, `'0'`..`'1'` float string. Default {@link DEFAULT_SOUND_VOLUME}. */
export const KV_SOUND_VOLUME = 'sound.volume';
/** Per-cue mute — JSON `SoundCue[]`. */
export const KV_SOUND_MUTED = 'sound.mutedCues';

/** Legacy v1.13 toggle for the Jorvis completion chime → cue `agent-done`. */
export const KV_LEGACY_DING = 'notifications.ding';
/** Legacy v1.13 toggle for the new-notification tone → notification cues. */
export const KV_LEGACY_SOUND = 'notifications.sound';

// ── Notification source taxonomy ──────────────────────────────────────────────
export type NotificationSource = 'pty' | 'swarm' | 'tool' | 'system';

export const NOTIFICATION_SOURCES: ReadonlyArray<{
  id: NotificationSource;
  label: string;
}> = [
  { id: 'pty', label: 'Terminal & pane exits' },
  { id: 'swarm', label: 'Swarm messages' },
  { id: 'tool', label: 'Assistant tool errors' },
  { id: 'system', label: 'System & other' },
];

/** Map a notification `kind` onto its coarse mute-able source. */
export function notificationSource(kind: string): NotificationSource {
  if (kind === 'pty-exit') return 'pty';
  if (kind.startsWith('swarm')) return 'swarm';
  if (kind.startsWith('tool')) return 'tool';
  return 'system';
}

// ── Quiet hours ────────────────────────────────────────────────────────────────
export interface QuietHoursConfig {
  enabled: boolean;
  /** Local wall-clock "HH:MM" (24h). */
  start: string;
  /** Local wall-clock "HH:MM" (24h). May be < start to wrap past midnight. */
  end: string;
}

export const DEFAULT_QUIET_HOURS: QuietHoursConfig = {
  enabled: false,
  start: '22:00',
  end: '08:00',
};

/** Parse an "HH:MM" string to minutes-since-midnight, or null if malformed. */
export function hhmmToMinutes(s: string): number | null {
  if (typeof s !== 'string') return null;
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isInteger(h) || !Number.isInteger(min)) return null;
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/** Parse the KV value (or null) into a config, falling back to disabled-default. */
export function parseQuietHours(raw: string | null | undefined): QuietHoursConfig {
  if (!raw) return { ...DEFAULT_QUIET_HOURS };
  try {
    const parsed = JSON.parse(raw) as Partial<QuietHoursConfig>;
    const start = typeof parsed.start === 'string' && hhmmToMinutes(parsed.start) !== null
      ? parsed.start
      : DEFAULT_QUIET_HOURS.start;
    const end = typeof parsed.end === 'string' && hhmmToMinutes(parsed.end) !== null
      ? parsed.end
      : DEFAULT_QUIET_HOURS.end;
    return { enabled: parsed.enabled === true, start, end };
  } catch {
    return { ...DEFAULT_QUIET_HOURS };
  }
}

/**
 * True if `nowMinutes` (local minutes-since-midnight, 0..1439) falls inside the
 * quiet-hours window. Wrap-aware: a window like 22:00→08:00 spans midnight, so
 * "inside" means `now >= start || now < end`. A degenerate start===end window
 * is treated as "never" (zero-width) rather than "always".
 */
export function isWithinQuietHours(cfg: QuietHoursConfig, nowMinutes: number): boolean {
  if (!cfg.enabled) return false;
  const start = hhmmToMinutes(cfg.start);
  const end = hhmmToMinutes(cfg.end);
  if (start === null || end === null) return false;
  if (start === end) return false;
  if (start < end) return nowMinutes >= start && nowMinutes < end;
  // wraps past midnight
  return nowMinutes >= start || nowMinutes < end;
}

// ── Prefs aggregate + suppression predicates ──────────────────────────────────
export interface NotificationPrefs {
  dnd: boolean;
  quietHours: QuietHoursConfig;
  mutedSources: NotificationSource[];
}

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  dnd: false,
  quietHours: { ...DEFAULT_QUIET_HOURS },
  mutedSources: [],
};

/** Parse the muted-sources KV array, dropping unknown values. */
export function parseMutedSources(raw: string | null | undefined): NotificationSource[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (s): s is NotificationSource =>
        s === 'pty' || s === 'swarm' || s === 'tool' || s === 'system',
    );
  } catch {
    return [];
  }
}

/** DND or an active quiet-hours window. */
export function isQuietActive(prefs: NotificationPrefs, nowMinutes: number): boolean {
  return prefs.dnd || isWithinQuietHours(prefs.quietHours, nowMinutes);
}

/**
 * OS-notification suppression. Per-source mute always wins (the operator
 * explicitly silenced that source). `critical` bypasses DND/quiet (must-see by
 * the D6 taxonomy); every other severity is suppressed while quiet is active.
 */
export function isOsSuppressed(
  prefs: NotificationPrefs,
  opts: { source: NotificationSource; severity: NotificationSeverity },
  nowMinutes: number,
): boolean {
  if (prefs.mutedSources.includes(opts.source)) return true;
  if (opts.severity === 'critical') return false;
  return isQuietActive(prefs, nowMinutes);
}

/**
 * Sound suppression. Per-source mute wins. Otherwise sound is silenced whenever
 * quiet is active — for ALL severities, because sound is never "must-see": the
 * bell badge + (for critical) the OS popup carry urgent items visually.
 */
export function isSoundSuppressedByPrefs(
  prefs: NotificationPrefs,
  opts: { source?: NotificationSource },
  nowMinutes: number,
): boolean {
  if (opts.source && prefs.mutedSources.includes(opts.source)) return true;
  return isQuietActive(prefs, nowMinutes);
}

// ── Sound cue catalog ──────────────────────────────────────────────────────────
export type SoundCue =
  | 'agent-done'
  | 'agent-crash'
  | 'message-arrive'
  | 'merge-ready'
  | 'error'
  | 'send'
  | 'record-start'
  | 'record-stop'
  | 'notify-info'
  | 'notify-warn'
  | 'notify-error'
  | 'notify-critical';

/** Local oscillator type union — deliberately NOT the DOM `OscillatorType`, so
 *  this module carries no DOM lib dependency (it is imported by main). */
export type ToneType = 'sine' | 'square' | 'sawtooth' | 'triangle';

export interface ToneSpec {
  freq: number;
  /** Seconds after cue start. */
  start: number;
  /** Seconds. */
  duration: number;
  type?: ToneType;
  /** Peak gain BEFORE the global volume multiplier (0..1). Default 0.18. */
  peak?: number;
}

export interface CueDef {
  cue: SoundCue;
  /** Human label for the settings mute matrix. */
  label: string;
  /**
   * `alert` cues are functional and play even when the window is hidden or
   * Reduce-Motion is on (a completion chime while you are in another app is
   * the whole point). `ui` cues are ambient interaction feedback and are
   * additionally suppressed under Reduce-Motion + `document.hidden`.
   */
  category: 'alert' | 'ui';
  tones: ToneSpec[];
  /** Legacy KV mute key honored for back-compat (no setting regression). */
  legacyKey?: string;
}

export const DEFAULT_SOUND_VOLUME = 0.6;

export const SOUND_CATALOG: ReadonlyArray<CueDef> = [
  {
    cue: 'agent-done',
    label: 'Agent finished',
    category: 'alert',
    legacyKey: KV_LEGACY_DING,
    // Ascending A5→E6 — the established Jorvis completion chime.
    tones: [
      { freq: 880, start: 0, duration: 0.16 },
      { freq: 1318.51, start: 0.1, duration: 0.18 },
    ],
  },
  {
    cue: 'agent-crash',
    label: 'Agent crashed',
    category: 'alert',
    // Low descending minor third — reads as "something went down".
    tones: [
      { freq: 311.13, start: 0, duration: 0.16, type: 'triangle' },
      { freq: 233.08, start: 0.12, duration: 0.22, type: 'triangle' },
    ],
  },
  {
    cue: 'message-arrive',
    label: 'Swarm message',
    category: 'ui',
    tones: [{ freq: 659.25, start: 0, duration: 0.1 }],
  },
  {
    cue: 'merge-ready',
    label: 'Merge ready',
    category: 'alert',
    // Bright major triad arpeggio — a satisfied "ready to integrate".
    tones: [
      { freq: 659.25, start: 0, duration: 0.1 },
      { freq: 830.61, start: 0.08, duration: 0.1 },
      { freq: 987.77, start: 0.16, duration: 0.16 },
    ],
  },
  {
    cue: 'error',
    label: 'Error',
    category: 'alert',
    tones: [{ freq: 220, start: 0, duration: 0.22, type: 'square', peak: 0.12 }],
  },
  {
    cue: 'send',
    label: 'Message sent',
    category: 'ui',
    tones: [{ freq: 988, start: 0, duration: 0.07, peak: 0.12 }],
  },
  {
    cue: 'record-start',
    label: 'Recording started',
    category: 'ui',
    tones: [{ freq: 587.33, start: 0, duration: 0.09 }],
  },
  {
    cue: 'record-stop',
    label: 'Recording stopped',
    category: 'ui',
    tones: [{ freq: 440, start: 0, duration: 0.09 }],
  },
  {
    cue: 'notify-info',
    label: 'Notification — info',
    category: 'ui',
    legacyKey: KV_LEGACY_SOUND,
    tones: [{ freq: 523.25, start: 0, duration: 0.1, peak: 0.12 }],
  },
  {
    cue: 'notify-warn',
    label: 'Notification — warning',
    category: 'alert',
    legacyKey: KV_LEGACY_SOUND,
    // Established new-notification tone: D4→A3 descending.
    tones: [
      { freq: 293.66, start: 0, duration: 0.14 },
      { freq: 220, start: 0.1, duration: 0.16 },
    ],
  },
  {
    cue: 'notify-error',
    label: 'Notification — error',
    category: 'alert',
    legacyKey: KV_LEGACY_SOUND,
    tones: [
      { freq: 277.18, start: 0, duration: 0.14, type: 'triangle' },
      { freq: 196, start: 0.1, duration: 0.2, type: 'triangle' },
    ],
  },
  {
    cue: 'notify-critical',
    label: 'Notification — critical',
    category: 'alert',
    tones: [
      { freq: 415.3, start: 0, duration: 0.12, type: 'square', peak: 0.14 },
      { freq: 415.3, start: 0.18, duration: 0.12, type: 'square', peak: 0.14 },
      { freq: 311.13, start: 0.36, duration: 0.2, type: 'square', peak: 0.14 },
    ],
  },
];

const CUE_BY_NAME = new Map<SoundCue, CueDef>(SOUND_CATALOG.map((c) => [c.cue, c]));

export function cueDef(cue: SoundCue): CueDef | undefined {
  return CUE_BY_NAME.get(cue);
}

/** Notification severity → its distinct cue. */
export function severityCue(severity: NotificationSeverity): SoundCue {
  switch (severity) {
    case 'info':
      return 'notify-info';
    case 'warn':
      return 'notify-warn';
    case 'error':
      return 'notify-error';
    case 'critical':
      return 'notify-critical';
  }
}
