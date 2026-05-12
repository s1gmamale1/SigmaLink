// V3-W14-008 / v1.2.4 — Settings → Updates.
// Platform-aware auto-update state machine: idle → checking → downloading → ready | error.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Loader2,
  RefreshCcw,
  Download,
  CheckCircle2,
  AlertCircle,
  ExternalLink,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { rpc } from '@/renderer/lib/rpc';
import { onEvent } from '@/renderer/lib/rpc';

const KV_OPT_IN = 'updates.optIn';
const KV_LAST_CHECK = 'updates.lastCheckTimestamp';

type UpdateState = 'idle' | 'checking' | 'downloading' | 'ready' | 'error';
type Platform = 'darwin' | 'win32' | 'linux' | 'unknown';

function formatTimestamp(epochMs: number | null): string {
  if (!epochMs || !Number.isFinite(epochMs)) return 'never';
  try {
    return new Date(epochMs).toLocaleString();
  } catch {
    return 'unknown';
  }
}

function formatBytes(b: number): string {
  if (b === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log10(b) / 3), units.length - 1);
  return `${(b / 10 ** (i * 3)).toFixed(1)} ${units[i]}`;
}

export function UpdatesTab() {
  const [optIn, setOptIn] = useState<boolean>(false);
  const [version, setVersion] = useState<string>('—');
  const [platform, setPlatform] = useState<Platform>('unknown');
  const [lastCheck, setLastCheck] = useState<number | null>(null);

  const [state, setState] = useState<UpdateState>('idle');
  const [updateVersion, setUpdateVersion] = useState<string>('');
  const [progress, setProgress] = useState<{ downloaded: number; total: number }>({
    downloaded: 0,
    total: 0,
  });
  const [errorMsg, setErrorMsg] = useState<string>('');

  const refreshLastCheck = useCallback(async () => {
    const raw = await rpc.kv.get(KV_LAST_CHECK).catch(() => null);
    const n = raw ? Number.parseInt(raw, 10) : NaN;
    setLastCheck(Number.isFinite(n) ? n : null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const [v, optInRaw, plat] = await Promise.all([
        rpc.app.getVersion().catch(() => 'unknown'),
        rpc.kv.get(KV_OPT_IN).catch(() => null),
        rpc.app.getPlatform().catch(() => 'unknown' as Platform),
      ]);
      if (cancelled) return;
      setVersion(v);
      setOptIn(optInRaw === '1');
      setPlatform(plat as Platform);
      await refreshLastCheck();
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [refreshLastCheck]);

  // Subscribe to update lifecycle events
  useEffect(() => {
    const offs: Array<() => void> = [];

    offs.push(
      onEvent<{ version: string }>('app:update-available', ({ version }) => {
        setUpdateVersion(version);
        setState('downloading');
        setProgress({ downloaded: 0, total: 0 });
        toast.success(`Update v${version} available — downloading…`);
      }),
    );

    offs.push(
      onEvent<{ version: string; downloaded: number; total: number }>(
        'app:update-mac-dmg-progress',
        ({ downloaded, total }) => {
          setProgress((prev) => ({
            downloaded: prev.downloaded + downloaded,
            total: total || prev.total,
          }));
        },
      ),
    );

    offs.push(
      onEvent<{ version: string; path: string }>('app:update-mac-dmg-ready', ({ version }) => {
        setUpdateVersion(version);
        setState('ready');
        toast.success(`Update v${version} ready — open DMG to install.`);
      }),
    );

    offs.push(
      onEvent<{ version?: string; downloaded: number; total: number }>(
        'app:update-win-progress',
        ({ downloaded, total }) => {
          setProgress((prev) => ({
            downloaded: prev.downloaded + downloaded,
            total: total || prev.total,
          }));
        },
      ),
    );

    offs.push(
      onEvent<{ version: string }>('app:update-win-ready', ({ version }) => {
        setUpdateVersion(version);
        setState('ready');
        toast.success(`Update v${version} ready — quit and install when ready.`);
      }),
    );

    offs.push(
      onEvent<{ error: string }>('app:update-error', ({ error }) => {
        setErrorMsg(error);
        setState('error');
        toast.error(`Update failed: ${error}`);
      }),
    );

    return () => {
      offs.forEach((off) => off());
    };
  }, []);

  const onToggleOptIn = useCallback((next: boolean) => {
    setOptIn(next);
    void rpc.kv.set(KV_OPT_IN, next ? '1' : '0').catch(() => undefined);
  }, []);

  const onCheckNow = useCallback(async () => {
    setState('checking');
    setErrorMsg('');
    setProgress({ downloaded: 0, total: 0 });
    try {
      const result = await rpc.app.checkForUpdates();
      if (result.ok) {
        if (!result.version) {
          setState('idle');
          toast.success('You are on the latest version');
        }
        // If result.version is present, the backend will broadcast
        // app:update-available which transitions us to 'downloading'.
      } else {
        setErrorMsg(result.error || 'Update check failed');
        setState('error');
        toast.error(result.error || 'Update check failed');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMsg(msg);
      setState('error');
      toast.error(msg);
    } finally {
      void refreshLastCheck();
    }
  }, [refreshLastCheck]);

  const onInstall = useCallback(async () => {
    try {
      await rpc.app.quitAndInstall();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const onDismiss = useCallback(() => {
    setState('idle');
    setErrorMsg('');
    setProgress({ downloaded: 0, total: 0 });
  }, []);

  const percent =
    progress.total > 0 ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100)) : 0;

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
              When on, SigmaLink checks the GitHub Releases feed shortly after each app start.
              Downloads and installs always require your explicit click — no silent installs.
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
        <div className={sectionLabel}>Update status</div>
        <div className={cardCls}>
          {state === 'idle' && (
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-xs text-muted-foreground">Last checked</div>
                <div className="font-mono text-sm">{formatTimestamp(lastCheck)}</div>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void onCheckNow()}
                className="gap-1"
              >
                <RefreshCcw className="h-3.5 w-3.5" />
                Check for updates
              </Button>
            </div>
          )}

          {state === 'checking' && (
            <div className="flex items-center gap-3 text-sm">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              <span className="text-muted-foreground">Checking for updates…</span>
            </div>
          )}

          {state === 'downloading' && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2 text-sm">
                <Download className="h-4 w-4 animate-bounce text-muted-foreground" />
                <span>
                  Downloading v{updateVersion}… {percent > 0 ? `${percent}%` : ''}
                </span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-border">
                <div
                  className="h-full bg-primary transition-all duration-300"
                  style={{ width: `${percent}%` }}
                />
              </div>
              {progress.total > 0 && (
                <div className="text-[11px] text-muted-foreground">
                  {formatBytes(progress.downloaded)} of {formatBytes(progress.total)}
                </div>
              )}
            </div>
          )}

          {state === 'ready' && (
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-2 text-sm">
                <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                <span>
                  Update <span className="font-medium">v{updateVersion}</span> is ready.
                </span>
              </div>
              <div className="flex items-center gap-2">
                {platform === 'darwin' ? (
                  <Button type="button" size="sm" onClick={() => void onInstall()} className="gap-1">
                    <ExternalLink className="h-3.5 w-3.5" />
                    Open DMG
                  </Button>
                ) : platform === 'win32' ? (
                  <Button type="button" size="sm" onClick={() => void onInstall()} className="gap-1">
                    <ExternalLink className="h-3.5 w-3.5" />
                    Quit & Install
                  </Button>
                ) : (
                  <Button type="button" size="sm" disabled>
                    Unsupported platform
                  </Button>
                )}
                <Button type="button" size="sm" variant="outline" onClick={onDismiss}>
                  Later
                </Button>
              </div>
              {platform === 'darwin' && (
                <div className="text-[11px] text-muted-foreground">
                  The DMG will open in Finder. Drag SigmaLink to Applications to complete the update.
                </div>
              )}
            </div>
          )}

          {state === 'error' && (
            <div className="flex flex-col gap-3">
              <div className="flex items-start gap-2 text-sm">
                <AlertCircle className="mt-0.5 h-4 w-4 text-red-400" />
                <div className="min-w-0">
                  <div className="font-medium text-red-400">Update failed</div>
                  <div className="mt-0.5 break-words text-xs text-muted-foreground">{errorMsg}</div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button type="button" size="sm" variant="outline" onClick={() => void onCheckNow()}>
                  Retry
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={onDismiss} className="gap-1">
                  <X className="h-3.5 w-3.5" />
                  Dismiss
                </Button>
              </div>
            </div>
          )}
        </div>
      </section>

      <section>
        <div className={sectionLabel}>About</div>
        <div className="overflow-hidden rounded-md border border-border bg-card/30">
          <Row label="Current version" value={`v${version}`} mono />
          <Row label="Platform" value={platform} mono />
          <Row label="Update channel" value="GitHub Releases" />
          <Row label="Repository" value="s1gmamale1/SigmaLink" mono />
        </div>
        <div className="mt-2 text-[11px] text-muted-foreground">
          macOS builds are unsigned in v1 — Gatekeeper warns on first launch until a Developer ID is
          attached. No update is ever applied without your explicit confirmation.
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
      <code
        className={
          mono
            ? 'flex-1 select-all break-all font-mono text-xs'
            : 'flex-1 select-all break-words text-xs'
        }
      >
        {value}
      </code>
    </div>
  );
}
