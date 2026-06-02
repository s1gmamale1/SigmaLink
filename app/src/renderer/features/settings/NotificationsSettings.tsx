// Settings → Notifications panel.
//
// v1.4.9 #07 (D6) shipped: master OS toggle + per-severity gates.
// P3 (NTF-1): Do-Not-Disturb, quiet-hours window, per-source mute, and the
// SND-1 soundscape controls (master + volume + per-cue mute matrix, in the
// sibling `NotificationsSettings.sound.tsx`).
//
// Gating taxonomy (enforced by the shared pure predicates in
// `@/shared/notification-prefs`, applied in `os-notify.ts` for OS popups and
// `lib/sounds.ts` for sound):
//   - DND / quiet-hours silence OS popups (except `critical`) and ALL sound.
//   - Per-source mute silences a source's OS popup + sound (it still lands in
//     the bell — in-app notifications are never suppressed here).

import { useEffect, useState } from 'react';
import { rpc } from '@/renderer/lib/rpc';
import { invalidateSoundPrefsCache } from '@/renderer/lib/sounds';
import {
  KV_DND,
  KV_QUIET_HOURS,
  KV_OS_PER_SOURCE,
  NOTIFICATION_SOURCES,
  DEFAULT_QUIET_HOURS,
  parseQuietHours,
  parseMutedSources,
  type NotificationSource,
  type QuietHoursConfig,
} from '@/shared/notification-prefs';
import type { NotificationSeverity } from '@/shared/types';
import { NotificationsSoundSettings } from './NotificationsSettings.sound';

const KV_OS_ENABLED = 'notifications.osEnabled';
const KV_OS_SEVERITIES = 'notifications.osSeverities';

const DEFAULT_SEVERITIES: NotificationSeverity[] = ['warn', 'error', 'critical'];
const SEVERITY_LABELS: ReadonlyArray<{ value: NotificationSeverity; label: string; locked: boolean }> = [
  { value: 'info', label: 'Info (low priority)', locked: false },
  { value: 'warn', label: 'Warn (non-zero exits, escalations)', locked: false },
  { value: 'error', label: 'Error (tool failures)', locked: false },
  { value: 'critical', label: 'Critical (must-see; cannot be disabled)', locked: true },
];

function parseSeverities(raw: string | null): NotificationSeverity[] {
  if (!raw) return DEFAULT_SEVERITIES.slice();
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const valid: NotificationSeverity[] = parsed.filter(
        (s): s is NotificationSeverity =>
          s === 'info' || s === 'warn' || s === 'error' || s === 'critical',
      );
      if (!valid.includes('critical')) valid.push('critical');
      return valid;
    }
  } catch {
    /* malformed — fall through */
  }
  return DEFAULT_SEVERITIES.slice();
}

export function NotificationsSettings() {
  const [enabled, setEnabled] = useState<boolean>(false);
  const [severities, setSeverities] = useState<NotificationSeverity[]>(DEFAULT_SEVERITIES);
  // P3 NTF-1
  const [dnd, setDnd] = useState<boolean>(false);
  const [quiet, setQuiet] = useState<QuietHoursConfig>(DEFAULT_QUIET_HOURS);
  const [mutedSources, setMutedSources] = useState<NotificationSource[]>([]);
  const [ready, setReady] = useState(false);

  // Hydrate from kv on mount.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [e, s, d, q, ms] = await Promise.all([
          rpc.kv.get(KV_OS_ENABLED),
          rpc.kv.get(KV_OS_SEVERITIES),
          rpc.kv.get(KV_DND),
          rpc.kv.get(KV_QUIET_HOURS),
          rpc.kv.get(KV_OS_PER_SOURCE),
        ]);
        if (!alive) return;
        setEnabled(e === '1');
        setSeverities(parseSeverities(s));
        setDnd(d === '1');
        setQuiet(parseQuietHours(q));
        setMutedSources(parseMutedSources(ms));
      } finally {
        if (alive) setReady(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const persistEnabled = async (next: boolean) => {
    setEnabled(next);
    await rpc.kv.set(KV_OS_ENABLED, next ? '1' : '0').catch(() => undefined);
  };

  const persistSeverities = async (next: NotificationSeverity[]) => {
    const withCritical: NotificationSeverity[] = next.includes('critical') ? next : [...next, 'critical'];
    setSeverities(withCritical);
    await rpc.kv.set(KV_OS_SEVERITIES, JSON.stringify(withCritical)).catch(() => undefined);
  };

  const toggleSeverity = (sev: NotificationSeverity) => {
    if (sev === 'critical') return; // forced-on
    const next = severities.includes(sev)
      ? severities.filter((s) => s !== sev)
      : [...severities, sev];
    void persistSeverities(next);
  };

  // P3 — these three gate BOTH OS popups (os-notify.ts) and sound (lib/sounds.ts),
  // so invalidate the renderer sound-prefs cache on every change for instant effect.
  const persistDnd = async (next: boolean) => {
    setDnd(next);
    invalidateSoundPrefsCache();
    await rpc.kv.set(KV_DND, next ? '1' : '0').catch(() => undefined);
  };

  const persistQuiet = async (next: QuietHoursConfig) => {
    setQuiet(next);
    invalidateSoundPrefsCache();
    await rpc.kv.set(KV_QUIET_HOURS, JSON.stringify(next)).catch(() => undefined);
  };

  const persistMutedSources = async (next: NotificationSource[]) => {
    setMutedSources(next);
    invalidateSoundPrefsCache();
    await rpc.kv.set(KV_OS_PER_SOURCE, JSON.stringify(next)).catch(() => undefined);
  };

  const toggleSource = (src: NotificationSource) => {
    const next = mutedSources.includes(src)
      ? mutedSources.filter((s) => s !== src)
      : [...mutedSources, src];
    void persistMutedSources(next);
  };

  if (!ready) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="notifications-settings-loading">
        Loading…
      </p>
    );
  }

  return (
    <section
      className="flex flex-col gap-5"
      aria-labelledby="notifications-settings-heading"
      data-testid="notifications-settings"
    >
      <header>
        <h3 id="notifications-settings-heading" className="text-sm font-semibold tracking-tight">
          Notifications
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Control OS notifications surfaced from PTY exits, swarm broadcasts, and Jorvis tool
          errors. In-app notifications always appear in the bell dropdown regardless of these
          settings.
        </p>
      </header>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => void persistEnabled(e.target.checked)}
          data-testid="notifications-os-enabled"
          className="accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <span>Show OS notifications</span>
      </label>

      <fieldset
        className="flex flex-col gap-1 border-l-2 border-border pl-3 text-sm"
        disabled={!enabled}
        data-testid="notifications-severity-fieldset"
        aria-disabled={!enabled}
      >
        <legend className="px-1 text-xs text-muted-foreground">Severity filter</legend>
        {SEVERITY_LABELS.map(({ value, label, locked }) => (
          <label key={value} className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={severities.includes(value)}
              disabled={locked || !enabled}
              onChange={() => toggleSeverity(value)}
              data-testid={`notifications-severity-${value}`}
              className="accent-primary"
            />
            <span className={locked ? 'text-muted-foreground' : ''}>{label}</span>
          </label>
        ))}
      </fieldset>

      {/* P3 NTF-1 — Do Not Disturb */}
      <div className="flex flex-col gap-1">
        <label className="flex items-center gap-2 text-sm" data-testid="notifications-dnd-row">
          <input
            type="checkbox"
            checked={dnd}
            onChange={(e) => void persistDnd(e.target.checked)}
            data-testid="notifications-dnd"
            className="accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <span>Do Not Disturb</span>
        </label>
        <p className="pl-6 text-xs text-muted-foreground">
          Silences OS notifications and all sound. Critical alerts still appear in Notification
          Center. In-app bell entries are never affected.
        </p>
      </div>

      {/* P3 NTF-1 — Quiet hours */}
      <fieldset className="flex flex-col gap-2 text-sm" data-testid="notifications-quiet-fieldset">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={quiet.enabled}
            onChange={(e) => void persistQuiet({ ...quiet, enabled: e.target.checked })}
            data-testid="notifications-quiet-enabled"
            className="accent-primary"
          />
          <span>Quiet hours</span>
        </label>
        <div
          className="flex items-center gap-2 pl-6 text-xs text-muted-foreground"
          aria-disabled={!quiet.enabled}
        >
          <span>From</span>
          <input
            type="time"
            value={quiet.start}
            disabled={!quiet.enabled}
            onChange={(e) => void persistQuiet({ ...quiet, start: e.target.value })}
            data-testid="notifications-quiet-start"
            className="rounded border border-border bg-background px-1.5 py-0.5 text-foreground disabled:opacity-50"
          />
          <span>to</span>
          <input
            type="time"
            value={quiet.end}
            disabled={!quiet.enabled}
            onChange={(e) => void persistQuiet({ ...quiet, end: e.target.value })}
            data-testid="notifications-quiet-end"
            className="rounded border border-border bg-background px-1.5 py-0.5 text-foreground disabled:opacity-50"
          />
        </div>
        <p className="pl-6 text-xs text-muted-foreground">
          During this window OS notifications and sound are silenced (critical still shows). Spans
          midnight if the end time is earlier than the start.
        </p>
      </fieldset>

      {/* P3 NTF-1 — Per-source mute */}
      <fieldset className="flex flex-col gap-1 text-sm" data-testid="notifications-source-fieldset">
        <legend className="px-1 text-xs text-muted-foreground">Mute by source</legend>
        {NOTIFICATION_SOURCES.map(({ id, label }) => (
          <label key={id} className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={mutedSources.includes(id)}
              onChange={() => toggleSource(id)}
              data-testid={`notifications-source-${id}`}
              className="accent-primary"
            />
            <span>{label}</span>
          </label>
        ))}
        <p className="px-1 text-xs text-muted-foreground">
          A muted source makes no OS popup and no sound, but still lands in the bell.
        </p>
      </fieldset>

      {/* P3 SND-1 — soundscape controls */}
      <NotificationsSoundSettings />
    </section>
  );
}
