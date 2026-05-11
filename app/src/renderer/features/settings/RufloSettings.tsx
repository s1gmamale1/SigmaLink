// Phase 4 Track C — Settings → Ruflo.
//
// Surfaces the embedded Ruflo MCP supervisor:
//   - Health row (state dot + label, version, runtime path)
//   - Download / re-download CTA when state === 'absent'
//   - Live install progress streamed via `ruflo:install-progress`
//   - Telemetry toggle (default OFF; user opts in)
//
// We deliberately don't gate the renderer features (Memory semantic search,
// Bridge ribbon, Command palette autopilot) on a Settings toggle — they
// already auto-degrade based on `ruflo.health.state`, so a single source of
// truth (the supervisor) keeps the UI honest.

import { useCallback, useEffect, useState } from 'react';
import { Loader2, Sparkles, AlertTriangle, CheckCircle2, Power, Download } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { rpc, rpcSilent, onEvent } from '@/renderer/lib/rpc';
import { cn } from '@/lib/utils';

const KV_TELEMETRY_OPT_IN = 'ruflo.telemetry.optIn';
const KV_AUTOWRITE_MCP = 'ruflo.autowriteMcp';
const KV_STRICT_MCP_VERIFICATION = 'ruflo.strictMcpVerification';

type RufloState = 'absent' | 'starting' | 'ready' | 'degraded' | 'down';

interface RufloHealth {
  state: RufloState;
  lastError?: string;
  pid?: number;
  uptimeMs?: number;
  version?: string;
  runtimePath?: string;
}

interface InstallProgress {
  jobId: string;
  phase:
    | 'queued'
    | 'fetching-metadata'
    | 'downloading'
    | 'verifying'
    | 'extracting'
    | 'finalizing'
    | 'done'
    | 'error';
  bytesDone: number;
  bytesTotal: number;
  message?: string;
}

const STATE_COLOR: Record<RufloState, string> = {
  absent: 'bg-muted-foreground',
  starting: 'bg-yellow-400',
  ready: 'bg-emerald-400',
  degraded: 'bg-amber-400',
  down: 'bg-red-500',
};

const STATE_LABEL: Record<RufloState, string> = {
  absent: 'Not installed',
  starting: 'Starting…',
  ready: 'Ready',
  degraded: 'Degraded',
  down: 'Stopped',
};

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 MB';
  const mb = n / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${(n / 1024).toFixed(0)} KB`;
}

export function RufloSettings() {
  const [health, setHealth] = useState<RufloHealth | null>(null);
  const [progress, setProgress] = useState<InstallProgress | null>(null);
  const [installing, setInstalling] = useState<boolean>(false);
  const [telemetry, setTelemetry] = useState<boolean>(false);
  const [autowriteMcp, setAutowriteMcp] = useState<boolean>(true);
  const [strictMcpVerification, setStrictMcpVerification] = useState<boolean>(false);

  // Hydrate health + telemetry on mount.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const h = await rpcSilent.ruflo.health();
        if (alive) setHealth(h);
      } catch {
        if (alive) setHealth({ state: 'absent' });
      }
      try {
        const t = await rpc.kv.get(KV_TELEMETRY_OPT_IN);
        if (alive) setTelemetry(t === '1');
      } catch {
        /* ignore */
      }
      try {
        const a = await rpc.kv.get(KV_AUTOWRITE_MCP);
        if (alive) setAutowriteMcp(a !== '0');
      } catch {
        /* default ON */
      }
      try {
        const s = await rpc.kv.get(KV_STRICT_MCP_VERIFICATION);
        if (alive) setStrictMcpVerification(s === '1');
      } catch {
        /* default OFF */
      }
    })();
    const offHealth = onEvent<RufloHealth>('ruflo:health', (h) => {
      if (h && typeof h === 'object') setHealth(h);
    });
    const offProgress = onEvent<InstallProgress>('ruflo:install-progress', (p) => {
      if (!p || typeof p !== 'object') return;
      setProgress(p);
      if (p.phase === 'done') {
        setInstalling(false);
        toast.success('Ruflo installed successfully');
      } else if (p.phase === 'error') {
        setInstalling(false);
        toast.error(p.message ?? 'Ruflo install failed');
      }
    });
    return () => {
      alive = false;
      offHealth();
      offProgress();
    };
  }, []);

  const onInstall = useCallback(async () => {
    setInstalling(true);
    try {
      await rpc.ruflo['install.start']();
    } catch (err) {
      setInstalling(false);
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const onToggleTelemetry = useCallback((next: boolean) => {
    setTelemetry(next);
    void rpc.kv.set(KV_TELEMETRY_OPT_IN, next ? '1' : '0').catch(() => undefined);
  }, []);

  const onToggleAutowriteMcp = useCallback((next: boolean) => {
    setAutowriteMcp(next);
    void rpc.kv.set(KV_AUTOWRITE_MCP, next ? '1' : '0').catch(() => undefined);
  }, []);

  const onToggleStrictMcpVerification = useCallback((next: boolean) => {
    setStrictMcpVerification(next);
    void rpc.kv.set(KV_STRICT_MCP_VERIFICATION, next ? '1' : '0').catch(() => undefined);
  }, []);

  const state = health?.state ?? 'absent';
  const isInstalled = state !== 'absent';
  const showInstallCta = !isInstalled && !installing;

  return (
    <div className="flex flex-col gap-6">
      <section>
        <div className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Ruflo runtime
        </div>
        <div className="rounded-md border border-border bg-card/40 p-3 text-sm">
          <div className="flex items-center gap-2">
            <span
              className={cn('h-2.5 w-2.5 rounded-full', STATE_COLOR[state])}
              aria-hidden
            />
            <span className="font-medium">{STATE_LABEL[state]}</span>
            {health?.version ? (
              <span className="ml-2 text-[11px] text-muted-foreground">
                v{health.version}
              </span>
            ) : null}
            {health?.pid ? (
              <span className="ml-2 text-[11px] text-muted-foreground">
                pid {health.pid}
              </span>
            ) : null}
          </div>
          {health?.runtimePath ? (
            <div className="mt-1 truncate text-[11px] text-muted-foreground" title={health.runtimePath}>
              {health.runtimePath}
            </div>
          ) : null}
          {health?.lastError && (state === 'down' || state === 'degraded') ? (
            <div className="mt-2 flex items-start gap-1 rounded border border-amber-300/40 bg-amber-100/10 p-2 text-[11px] text-amber-200">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
              <pre className="whitespace-pre-wrap font-mono">{health.lastError}</pre>
            </div>
          ) : null}
        </div>
      </section>

      {/* Phase 4 Track C — Install / re-download. Option B (lazy-download)
          per the design doc: SigmaLink ships zero Ruflo bytes in the DMG;
          users opt in here. The download is ≈350 MB. */}
      <section>
        <div className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Embedded Ruflo MCP
        </div>
        <div className="rounded-md border border-border bg-card/40 p-3 text-sm">
          <p className="mb-2 text-xs leading-relaxed text-muted-foreground">
            Ruflo is the embedded <code className="text-[11px]">@claude-flow/cli</code>{' '}
            MCP server that powers Memory semantic search, Bridge pattern surfacing,
            and Command-palette autopilot. The runtime installs into{' '}
            <code className="text-[11px]">~/Library/Application Support/SigmaLink/ruflo/</code>.
          </p>

          {showInstallCta ? (
            <Button onClick={onInstall} className="gap-2">
              <Download className="h-4 w-4" />
              Download Ruflo (≈350 MB)
            </Button>
          ) : null}

          {installing && progress ? (
            <div className="mt-2 space-y-1">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                <span>{progressLabel(progress.phase)}</span>
                <span className="ml-auto font-mono">
                  {formatBytes(progress.bytesDone)}
                  {progress.bytesTotal > 0 ? ` / ${formatBytes(progress.bytesTotal)}` : ''}
                </span>
              </div>
              <div className="h-1 w-full overflow-hidden rounded bg-muted">
                <div
                  className="h-full bg-primary transition-all"
                  style={{
                    width:
                      progress.bytesTotal > 0
                        ? `${Math.min(100, Math.round((progress.bytesDone / progress.bytesTotal) * 100))}%`
                        : '0%',
                  }}
                />
              </div>
            </div>
          ) : null}

          {isInstalled && state === 'ready' ? (
            <div className="mt-2 flex items-center gap-1 text-[11px] text-emerald-300">
              <CheckCircle2 className="h-3 w-3" />
              All Ruflo features are active
            </div>
          ) : null}
          {isInstalled && state === 'down' ? (
            <div className="mt-2 flex items-center gap-1 text-[11px] text-muted-foreground">
              <Power className="h-3 w-3" />
              Ruflo runtime is stopped
            </div>
          ) : null}
        </div>
      </section>

      <section>
        <div className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Privacy
        </div>
        <div className="mb-3 flex items-center justify-between rounded-md border border-border bg-card/40 p-3">
          <div className="min-w-0 pr-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Sparkles className="h-3.5 w-3.5 text-primary" />
              Auto-configure Ruflo MCP for spawned agents
            </div>
            <div className="mt-0.5 text-[11px] text-muted-foreground">
              Writes workspace MCP entries on open. Turning this off leaves existing configs unchanged.
            </div>
          </div>
          <Switch checked={autowriteMcp} onCheckedChange={onToggleAutowriteMcp} />
        </div>
        <div className="mb-3 flex items-center justify-between rounded-md border border-border bg-card/40 p-3">
          <div className="min-w-0 pr-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Sparkles className="h-3.5 w-3.5 text-primary" />
              Strict MCP verification
            </div>
            <div className="mt-0.5 text-[11px] text-muted-foreground">
              Probes each CLI after workspace open. Slower, but catches discovery failures.
            </div>
          </div>
          <Switch
            checked={strictMcpVerification}
            onCheckedChange={onToggleStrictMcpVerification}
          />
        </div>
        <div className="flex items-center justify-between rounded-md border border-border bg-card/40 p-3">
          <div className="min-w-0 pr-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Sparkles className="h-3.5 w-3.5 text-primary" />
              Share anonymous Ruflo feature usage
            </div>
            <div className="mt-0.5 text-[11px] text-muted-foreground">
              Helps us prioritise improvements. Off by default; never includes
              code, prompts, or memory contents.
            </div>
          </div>
          <Switch checked={telemetry} onCheckedChange={onToggleTelemetry} />
        </div>
      </section>
    </div>
  );
}

function progressLabel(phase: InstallProgress['phase']): string {
  switch (phase) {
    case 'queued':
      return 'Queued…';
    case 'fetching-metadata':
      return 'Fetching package metadata…';
    case 'downloading':
      return 'Downloading…';
    case 'verifying':
      return 'Verifying checksum…';
    case 'extracting':
      return 'Extracting…';
    case 'finalizing':
      return 'Finalising install…';
    case 'done':
      return 'Done';
    case 'error':
      return 'Error';
    default:
      return phase;
  }
}
