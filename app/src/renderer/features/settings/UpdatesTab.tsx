// V3-W14-008 — Settings → Updates. Opt-in auto-update toggle + manual check.
// Auto-installs are explicitly OFF: the toggle just enables the *check*;
// downloads/installs always require the user's explicit click in the dialog
// raised by `electron-updater`.

import { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCcw } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { rpc } from '@/renderer/lib/rpc';

const KV_OPT_IN = 'updates.optIn';
const KV_LAST_CHECK = 'updates.lastCheckTimestamp';

function formatTimestamp(epochMs: number | null): string {
  if (!epochMs || !Number.isFinite(epochMs)) return 'never';
  try {
    return new Date(epochMs).toLocaleString();
  } catch {
    return 'unknown';
  }
}

export function UpdatesTab() {
  const [optIn, setOptIn] = useState<boolean>(false);
  const [version, setVersion] = useState<string>('—');
  const [lastCheck, setLastCheck] = useState<number | null>(null);
  const [busy, setBusy] = useState<boolean>(false);

  const refreshLastCheck = useCallback(async () => {
    const raw = await rpc.kv.get(KV_LAST_CHECK).catch(() => null);
    const n = raw ? Number.parseInt(raw, 10) : NaN;
    setLastCheck(Number.isFinite(n) ? n : null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const [v, optInRaw] = await Promise.all([
        rpc.app.getVersion().catch(() => 'unknown'),
        rpc.kv.get(KV_OPT_IN).catch(() => null),
      ]);
      if (cancelled) return;
      setVersion(v);
      setOptIn(optInRaw === '1');
      await refreshLastCheck();
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [refreshLastCheck]);

  const onToggleOptIn = useCallback((next: boolean) => {
    setOptIn(next);
    void rpc.kv.set(KV_OPT_IN, next ? '1' : '0').catch(() => undefined);
  }, []);

  const onCheckNow = useCallback(async () => {
    setBusy(true);
    try {
      const result = await rpc.app.checkForUpdates();
      if (result.ok) {
        toast.success(
          result.version
            ? `Update available: v${result.version}`
            : 'You are on the latest version',
        );
      } else {
        toast.error(result.error || 'Update check failed');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      void refreshLastCheck();
    }
  }, [refreshLastCheck]);

  const sectionLabel = 'mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground';
  const cardCls = 'rounded-md border border-border bg-card/40 p-3';

  return (
    <div className="flex flex-col gap-6">
      <section>
        <div className={sectionLabel}>Automatic updates</div>
        <div className={`flex items-start justify-between gap-4 ${cardCls}`}>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">Check for updates on launch</div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              When on, SigmaLink checks the GitHub Releases feed shortly after each
              app start. Downloads and installs always require your explicit click —
              no silent installs.
            </div>
          </div>
          <Switch
            checked={optIn}
            onCheckedChange={onToggleOptIn}
            aria-label="Enable automatic update checks"
          />
        </div>
      </section>

      <section>
        <div className={sectionLabel}>Manual check</div>
        <div className={`flex items-center justify-between gap-3 ${cardCls}`}>
          <div className="min-w-0">
            <div className="text-xs text-muted-foreground">Last checked</div>
            <div className="font-mono text-sm">{formatTimestamp(lastCheck)}</div>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void onCheckNow()}
            disabled={busy}
            className="gap-1"
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCcw className="h-3.5 w-3.5" />
            )}
            Check for updates
          </Button>
        </div>
      </section>

      <section>
        <div className={sectionLabel}>About</div>
        <div className="overflow-hidden rounded-md border border-border bg-card/30">
          <Row label="Current version" value={`v${version}`} mono />
          <Row label="Update channel" value="GitHub Releases" />
          <Row label="Repository" value="s1gmamale1/SigmaLink" mono />
        </div>
        <div className="mt-2 text-[11px] text-muted-foreground">
          macOS builds are unsigned in v1 — Gatekeeper warns on first launch until a
          Developer ID is attached. No update is ever applied without your explicit
          confirmation.
        </div>
      </section>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start gap-3 border-b border-border px-3 py-2 last:border-b-0">
      <div className="w-32 shrink-0 text-[11px] uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <code className={mono ? 'flex-1 select-all break-all font-mono text-xs' : 'flex-1 select-all break-words text-xs'}>
        {value}
      </code>
    </div>
  );
}
