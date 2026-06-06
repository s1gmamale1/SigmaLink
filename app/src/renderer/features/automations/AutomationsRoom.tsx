// BSP-O3 — Automations room. A dashboard that surfaces the two real automations
// already wired into SigmaLink:
//   1. Telegram remote (Jorvis bot remote bridge) — polls rpc.telegram.getStatus
//      every 5s, expose enable/disable toggle, and a "Configure" link that
//      deep-links into Settings → Telegram tab.
//   2. Nightly digest — pure KV (no dedicated channel); reads
//      KV_DAILY_SUMMARY_ENABLED / KV_DAILY_SUMMARY_TIME, expose enable toggle
//      and a "Configure" link to Settings → Notifications tab.
//
// This is a DASHBOARD, not a re-embed of Settings. It offers the most-useful
// inline controls (enable/disable) and links out for the full config surface.
// Adds NO new RPC channels — reuses existing rpc.telegram.* and rpc.kv.*.

import { useCallback, useEffect, useState } from 'react';
import { Zap, Send, Bell, CheckCircle2, XCircle, Lock, AlertCircle } from 'lucide-react';
import { rpc } from '@/renderer/lib/rpc';
import { useAppDispatch } from '@/renderer/app/state';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import type { TelegramRemoteStatus } from '@/shared/router-shape';
import {
  KV_DAILY_SUMMARY_ENABLED,
  KV_DAILY_SUMMARY_TIME,
  DEFAULT_DAILY_SUMMARY_TIME,
} from '@/shared/notification-prefs';

// ── Telegram status helpers ───────────────────────────────────────────────────

function telegramStatusLabel(status: TelegramRemoteStatus | null): {
  label: string;
  variant: 'default' | 'secondary' | 'outline' | 'destructive';
  icon: React.ReactNode;
} {
  if (status === null) {
    return { label: 'Loading…', variant: 'outline', icon: null };
  }
  if (status.locked) {
    return {
      label: 'Locked',
      variant: 'secondary',
      icon: <Lock className="h-3 w-3" aria-hidden />,
    };
  }
  if (status.running) {
    return {
      label: 'Running',
      variant: 'default',
      icon: <CheckCircle2 className="h-3 w-3" aria-hidden />,
    };
  }
  if (status.enabled) {
    return {
      label: 'Stopped',
      variant: 'secondary',
      icon: <AlertCircle className="h-3 w-3" aria-hidden />,
    };
  }
  return {
    label: 'Off',
    variant: 'outline',
    icon: <XCircle className="h-3 w-3" aria-hidden />,
  };
}

// ── Card wrapper ─────────────────────────────────────────────────────────────

function AutomationCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-muted/20 p-5">
      {children}
    </div>
  );
}

// ── Telegram remote card ──────────────────────────────────────────────────────

function TelegramCard() {
  const dispatch = useAppDispatch();
  const [status, setStatus] = useState<TelegramRemoteStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await rpc.telegram.getStatus();
      setStatus(s);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // Poll every 5s, mirroring TelegramTab's queueMicrotask pattern so the
  // initial fetch doesn't run synchronously in the effect body (lint rule).
  useEffect(() => {
    queueMicrotask(() => void refresh());
    const interval = setInterval(() => void refresh(), 5_000);
    return () => clearInterval(interval);
  }, [refresh]);

  const handleToggle = useCallback(
    async (next: boolean) => {
      try {
        await rpc.telegram.setEnabled(next);
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [refresh],
  );

  const handleConfigure = useCallback(() => {
    // Deep-link: navigate to Settings room + select the Telegram tab.
    dispatch({ type: 'SET_SETTINGS_TAB', tab: 'telegram' });
    dispatch({ type: 'SET_ROOM', room: 'settings' });
  }, [dispatch]);

  const { label, variant, icon } = telegramStatusLabel(status);

  return (
    <AutomationCard>
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3 min-w-0">
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
            <Send className="h-4 w-4" aria-hidden />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold leading-none">Remote control (Telegram)</h3>
              <Badge
                variant={variant}
                data-testid="telegram-status-badge"
                className="gap-1"
              >
                {icon}
                {label}
              </Badge>
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">
              Control Jorvis remotely via a Telegram bot. Send commands from your phone; Jorvis
              replies inline. Requires a bot token and an allowlist of numeric chat IDs.
            </p>
            {error && (
              <p className="mt-2 text-xs text-destructive" data-testid="telegram-card-error">
                {error}
              </p>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <Switch
            data-testid="telegram-card-switch"
            checked={status?.enabled ?? false}
            onCheckedChange={(v) => void handleToggle(v)}
            aria-label="Enable Telegram remote"
            disabled={status === null}
          />
          <Button
            variant="outline"
            size="sm"
            data-testid="telegram-card-configure"
            onClick={handleConfigure}
          >
            Configure
          </Button>
        </div>
      </div>
    </AutomationCard>
  );
}

// ── Nightly digest card ───────────────────────────────────────────────────────

function NightlyDigestCard() {
  const dispatch = useAppDispatch();
  const [enabled, setEnabled] = useState<boolean>(false);
  const [time, setTime] = useState<string>(DEFAULT_DAILY_SUMMARY_TIME);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Hydrate from KV on mount.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [rawEnabled, rawTime] = await Promise.all([
          rpc.kv.get(KV_DAILY_SUMMARY_ENABLED),
          rpc.kv.get(KV_DAILY_SUMMARY_TIME),
        ]);
        if (!alive) return;
        setEnabled(rawEnabled === '1');
        if (typeof rawTime === 'string' && rawTime.match(/^\d{1,2}:\d{2}$/)) {
          setTime(rawTime);
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (alive) setReady(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const handleToggle = useCallback(
    async (next: boolean) => {
      setEnabled(next);
      try {
        await rpc.kv.set(KV_DAILY_SUMMARY_ENABLED, next ? '1' : '0');
      } catch (e) {
        setEnabled(!next); // revert optimistic update
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [],
  );

  const handleConfigure = useCallback(() => {
    // Deep-link: navigate to Settings room + select the Notifications tab.
    dispatch({ type: 'SET_SETTINGS_TAB', tab: 'notifications' });
    dispatch({ type: 'SET_ROOM', room: 'settings' });
  }, [dispatch]);

  return (
    <AutomationCard>
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3 min-w-0">
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
            <Bell className="h-4 w-4" aria-hidden />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold leading-none">Nightly digest</h3>
              <Badge
                variant={enabled ? 'default' : 'outline'}
                data-testid="digest-status-badge"
              >
                {enabled ? 'Enabled' : 'Off'}
              </Badge>
              {ready && enabled && (
                <span
                  className="text-xs text-muted-foreground"
                  data-testid="digest-time-label"
                >
                  at {time}
                </span>
              )}
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">
              A once-daily notification that rolls up the day's agent events by kind and severity.
              Fires at the configured local wall-clock time, subject to Do Not Disturb / quiet
              hours.
            </p>
            {error && (
              <p className="mt-2 text-xs text-destructive" data-testid="digest-card-error">
                {error}
              </p>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <Switch
            data-testid="digest-card-switch"
            checked={enabled}
            onCheckedChange={(v) => void handleToggle(v)}
            aria-label="Enable nightly digest"
            disabled={!ready}
          />
          <Button
            variant="outline"
            size="sm"
            data-testid="digest-card-configure"
            onClick={handleConfigure}
          >
            Configure
          </Button>
        </div>
      </div>
    </AutomationCard>
  );
}

// ── Room shell ───────────────────────────────────────────────────────────────

export function AutomationsRoom() {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-muted/10 px-3 text-sm">
        <Zap className="h-4 w-4 text-primary" aria-hidden />
        <h2 className="text-sm font-semibold tracking-tight">Automations</h2>
        <span className="ml-2 hidden truncate text-xs text-muted-foreground sm:inline">
          Scheduled tasks and remote bridges.
        </span>
      </header>
      <div className="sl-fade-in min-h-0 flex-1 overflow-y-auto p-5">
        <div className="mx-auto max-w-2xl space-y-4">
          <TelegramCard />
          <NightlyDigestCard />
        </div>
      </div>
    </div>
  );
}
