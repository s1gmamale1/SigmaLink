// v1.4.9 #07 — Settings → Notifications panel (D6).
//
// Surfaces:
//   - Master toggle for native OS notifications (kv `notifications.osEnabled`).
//   - Per-severity checkboxes (kv `notifications.osSeverities` — JSON array).
//     `info` defaults off; `warn` + `error` + `critical` default on. `critical`
//     is disabled in the UI and forced-on (D6 — by definition must-see).
//
// Out of scope for v1.4.9 (per the locked taxonomy reviewer):
//   - Quiet hours.
//   - Per-source toggles.
//
// Both feature flags would touch this same panel and the `osPerSource` kv
// key is scaffolded for them; the v1 UI deliberately doesn't render either.

import { useEffect, useState } from 'react';
import { rpc } from '@/renderer/lib/rpc';
import { getDingEnabled, setDingEnabled } from '@/renderer/lib/notifications';
import type { NotificationSeverity } from '@/shared/types';

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
  const [dingEnabled, setDing] = useState<boolean>(true);
  const [ready, setReady] = useState(false);

  // Hydrate from kv on mount.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const e = await rpc.kv.get(KV_OS_ENABLED);
        const s = await rpc.kv.get(KV_OS_SEVERITIES);
        const d = await getDingEnabled();
        if (!alive) return;
        setEnabled(e === '1');
        setSeverities(parseSeverities(s));
        setDing(d);
      } finally {
        if (alive) setReady(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const persistDing = async (next: boolean) => {
    setDing(next);
    await setDingEnabled(next);
  };

  const persistEnabled = async (next: boolean) => {
    setEnabled(next);
    await rpc.kv.set(KV_OS_ENABLED, next ? '1' : '0').catch(() => undefined);
  };

  const persistSeverities = async (next: NotificationSeverity[]) => {
    // D6 — critical is forced-on regardless of UI state.
    const withCritical: NotificationSeverity[] = next.includes('critical')
      ? next
      : [...next, 'critical'];
    setSeverities(withCritical);
    await rpc.kv
      .set(KV_OS_SEVERITIES, JSON.stringify(withCritical))
      .catch(() => undefined);
  };

  const toggleSeverity = (sev: NotificationSeverity) => {
    if (sev === 'critical') return; // forced-on
    const next = severities.includes(sev)
      ? severities.filter((s) => s !== sev)
      : [...severities, sev];
    void persistSeverities(next);
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
      className="flex flex-col gap-4"
      aria-labelledby="notifications-settings-heading"
      data-testid="notifications-settings"
    >
      <header>
        <h3
          id="notifications-settings-heading"
          className="text-sm font-semibold tracking-tight"
        >
          Notifications
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Control OS notifications surfaced from PTY exits, swarm broadcasts,
          and Jorvis tool errors. In-app notifications always appear
          in the bell dropdown regardless of these settings.
        </p>
      </header>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => void persistEnabled(e.target.checked)}
          data-testid="notifications-os-enabled"
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
            />
            <span className={locked ? 'text-muted-foreground' : ''}>{label}</span>
          </label>
        ))}
      </fieldset>
      {/* V3-W13-015 — surface the existing notifications.ding kv toggle in
          the Settings UI. The Sigma Assistant plays a brief A5→E6 chime on
          dispatch-pane completion; some users find it intrusive. */}
      <label className="flex items-center gap-2 text-sm" data-testid="notifications-ding-row">
        <input
          type="checkbox"
          checked={dingEnabled}
          onChange={(e) => void persistDing(e.target.checked)}
          data-testid="notifications-ding-enabled"
        />
        <span>Play completion chime on Jorvis dispatch finish</span>
      </label>
    </section>
  );
}
