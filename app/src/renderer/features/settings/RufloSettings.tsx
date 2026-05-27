// Phase 4 Track C — Settings → Ruflo.
//
// Surfaces the embedded Ruflo MCP supervisor:
//   - Health row (state dot + label, version, runtime path)
//   - Download / re-download CTA when state === 'absent'
//   - Live install progress streamed via `ruflo:install-progress`
//   - Telemetry toggle (default OFF; user opts in)
//
// We deliberately don't gate the renderer features (Memory semantic search,
// Sigma ribbon, Command palette autopilot) on a Settings toggle — they
// already auto-degrade based on `ruflo.health.state`, so a single source of
// truth (the supervisor) keeps the UI honest.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Sparkles, AlertTriangle, CheckCircle2, Power, Download, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { rpc, rpcSilent, onEvent } from '@/renderer/lib/rpc';
import { cn } from '@/lib/utils';

const KV_TELEMETRY_OPT_IN = 'ruflo.telemetry.optIn';
const KV_AUTOWRITE_MCP = 'ruflo.autowriteMcp';
// SF-7 — gates per-provider auto-trust of the bundled `ruflo` MCP server in new
// workspaces. '1' (default) = ON; '0' = opt-out. Mirrors KV_RUFLO_AUTOTRUST_MCP
// in main/core/workspaces/mcp-autowrite.ts.
const KV_AUTOTRUST_MCP = 'ruflo.autoTrustMcp';
const KV_STRICT_MCP_VERIFICATION = 'ruflo.strictMcpVerification';
// v1.6.0 Phase 1 — shell-first pane mode feature flag.
const KV_PTY_SPAWN_MODE = 'pty.spawnMode';
// v1.9-scrollback — opt-in scrollback persistence flag. DEFAULT OFF.
const KV_PTY_SCROLLBACK_PERSISTENCE = 'pty.scrollbackPersistence';

const DAEMON_POLL_INTERVAL_MS = 5_000;

type RufloState = 'absent' | 'starting' | 'ready' | 'degraded' | 'down';

interface DaemonStatusRow {
  workspaceId: string;
  status: string;
  port: number;
  pid: number;
  uptime: number;
  connections: number | null;
}

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
  // SF-7 — auto-trust the bundled `ruflo` server in new workspaces (default ON).
  const [autoTrustMcp, setAutoTrustMcp] = useState<boolean>(true);
  const [strictMcpVerification, setStrictMcpVerification] = useState<boolean>(false);
  // v1.6.0 Phase 7 — shell-first pane mode flag (default ON = 'shell-first').
  const [shellFirstPanes, setShellFirstPanes] = useState<boolean>(true);
  // v1.9-scrollback — persist terminal scrollback across restart (DEFAULT OFF).
  const [scrollbackPersistence, setScrollbackPersistence] = useState<boolean>(false);
  const [daemons, setDaemons] = useState<DaemonStatusRow[]>([]);
  const [restartingDaemon, setRestartingDaemon] = useState<string | null>(null);
  const daemonPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
        const t = await rpc.kv.get(KV_AUTOTRUST_MCP);
        if (alive) setAutoTrustMcp(t !== '0');
      } catch {
        /* default ON */
      }
      try {
        const s = await rpc.kv.get(KV_STRICT_MCP_VERIFICATION);
        if (alive) setStrictMcpVerification(s === '1');
      } catch {
        /* default OFF */
      }
      try {
        const m = await rpc.kv.get(KV_PTY_SPAWN_MODE);
        // Phase 7: default is ON ('shell-first'). Only explicit 'direct' turns it off.
        if (alive) setShellFirstPanes(m !== 'direct');
      } catch {
        /* default ON (shell-first mode) */
      }
      try {
        const sb = await rpc.kv.get(KV_PTY_SCROLLBACK_PERSISTENCE);
        if (alive) setScrollbackPersistence(sb === 'on');
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

  // Poll daemon status every 5s while settings tab is mounted.
  useEffect(() => {
    let alive = true;
    const fetchDaemons = async () => {
      try {
        const rows = await rpcSilent.ruflo.daemonStatus();
        if (alive && Array.isArray(rows)) setDaemons(rows as DaemonStatusRow[]);
      } catch {
        /* ignore — daemon status is best-effort */
      }
    };
    void fetchDaemons();
    daemonPollRef.current = setInterval(() => { void fetchDaemons(); }, DAEMON_POLL_INTERVAL_MS);
    return () => {
      alive = false;
      if (daemonPollRef.current) clearInterval(daemonPollRef.current);
    };
  }, []);

  const onRestartDaemon = useCallback(async (workspaceId: string) => {
    setRestartingDaemon(workspaceId);
    try {
      const result = await rpc.ruflo.restartDaemon(workspaceId);
      if (!result.ok) {
        toast.error(result.error ?? 'Daemon restart failed');
      } else {
        toast.success('Daemon restarting…');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setRestartingDaemon(null);
    }
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

  const onToggleAutoTrustMcp = useCallback((next: boolean) => {
    setAutoTrustMcp(next);
    void rpc.kv.set(KV_AUTOTRUST_MCP, next ? '1' : '0').catch(() => undefined);
  }, []);

  const onToggleStrictMcpVerification = useCallback((next: boolean) => {
    setStrictMcpVerification(next);
    void rpc.kv.set(KV_STRICT_MCP_VERIFICATION, next ? '1' : '0').catch(() => undefined);
  }, []);

  // v1.6.0 Phase 1 — shell-first pane mode toggle. Writes 'shell-first' or
  // 'direct' to kv['pty.spawnMode']. Takes effect on next pane spawn; existing
  // panes are unaffected (flag is read at spawn time, not retroactively).
  const onToggleShellFirstPanes = useCallback((next: boolean) => {
    setShellFirstPanes(next);
    void rpc.kv.set(KV_PTY_SPAWN_MODE, next ? 'shell-first' : 'direct').catch(() => undefined);
  }, []);

  // v1.9-scrollback — scrollback persistence toggle. Writes 'on' or 'off' to
  // kv['pty.scrollbackPersistence']. DEFAULT OFF. Takes effect immediately for
  // future PTY exits and the next resume. Does NOT retroactively restore
  // scrollback for panes that are already running.
  const onToggleScrollbackPersistence = useCallback((next: boolean) => {
    setScrollbackPersistence(next);
    void rpc.kv.set(KV_PTY_SCROLLBACK_PERSISTENCE, next ? 'on' : 'off').catch(() => undefined);
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

      {/* v1.6.1 B2 — Per-workspace Ruflo HTTP daemon table. */}
      <section>
        <div className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Ruflo Daemon
        </div>
        {daemons.length === 0 ? (
          <div className="rounded-md border border-border bg-card/40 p-3 text-xs text-muted-foreground">
            No workspace daemons running.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-md border border-border bg-card/40">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border text-muted-foreground">
                  <th className="px-3 py-2 text-left font-medium">Workspace</th>
                  <th className="px-3 py-2 text-left font-medium">Status</th>
                  <th className="px-3 py-2 text-left font-medium">Port</th>
                  <th className="px-3 py-2 text-left font-medium">PID</th>
                  <th className="px-3 py-2 text-left font-medium">Uptime</th>
                  <th className="px-3 py-2 text-left font-medium">Conn.</th>
                  <th className="px-3 py-2 text-left font-medium" />
                </tr>
              </thead>
              <tbody>
                {daemons.map((row) => (
                  <tr key={row.workspaceId} className="border-b border-border last:border-0">
                    <td className="max-w-[160px] truncate px-3 py-2 font-mono" title={row.workspaceId}>
                      {row.workspaceId}
                    </td>
                    <td className="px-3 py-2">
                      <span className={cn(
                        'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium',
                        row.status === 'running' && 'bg-emerald-100/10 text-emerald-300',
                        row.status === 'starting' && 'bg-yellow-100/10 text-yellow-300',
                        (row.status === 'crashed' || row.status === 'down') && 'bg-red-100/10 text-red-400',
                      )}>
                        {row.status}
                      </span>
                    </td>
                    <td className="px-3 py-2 font-mono">{row.port > 0 ? row.port : '—'}</td>
                    <td className="px-3 py-2 font-mono">{row.pid > 0 ? row.pid : '—'}</td>
                    <td className="px-3 py-2">{formatUptime(row.uptime)}</td>
                    <td className="px-3 py-2">{row.connections !== null ? row.connections : '—'}</td>
                    <td className="px-3 py-2">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={restartingDaemon === row.workspaceId}
                        onClick={() => void onRestartDaemon(row.workspaceId)}
                        className="h-6 gap-1 px-2 text-[10px]"
                      >
                        {restartingDaemon === row.workspaceId
                          ? <Loader2 className="h-3 w-3 animate-spin" />
                          : <RefreshCw className="h-3 w-3" />
                        }
                        Restart
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
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
            MCP server that powers Memory semantic search, Sigma pattern surfacing,
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
        {/* SF-7 — auto-trust the bundled ruflo server in new workspaces. */}
        <div className="mb-3 flex items-center justify-between rounded-md border border-border bg-card/40 p-3">
          <div className="min-w-0 pr-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Sparkles className="h-3.5 w-3.5 text-primary" />
              Auto-trust the bundled Ruflo MCP server in new workspaces
            </div>
            <div className="mt-0.5 text-[11px] text-muted-foreground">
              Pre-approves only SigmaLink&apos;s own <code className="text-[10px]">ruflo</code> server by
              name — third-party MCP servers in a cloned repo still prompt.
            </div>
          </div>
          <Switch
            checked={autoTrustMcp}
            onCheckedChange={onToggleAutoTrustMcp}
            data-testid="ruflo-autotrust-toggle"
          />
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

      {/* v1.6.0 Phase 1 + v1.9-scrollback — Experimental PTY features. */}
      <section>
        <div className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Experimental
        </div>
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between rounded-md border border-border bg-card/40 p-3">
            <div className="min-w-0 pr-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Sparkles className="h-3.5 w-3.5 text-primary" />
                Shell-first panes
              </div>
              <div className="mt-0.5 text-[11px] text-muted-foreground">
                Spawns an interactive shell as the PTY parent and launches the
                agent CLI inside it. A crashed CLI returns to a live shell prompt
                in the pane. Takes effect on the next pane spawn. On by default.
              </div>
            </div>
            <Switch checked={shellFirstPanes} onCheckedChange={onToggleShellFirstPanes} />
          </div>
          {/* v1.9-scrollback — DEFAULT OFF. */}
          <div className="flex items-center justify-between rounded-md border border-border bg-card/40 p-3">
            <div className="min-w-0 pr-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Sparkles className="h-3.5 w-3.5 text-primary" />
                Persist terminal scrollback across restart (experimental)
              </div>
              <div className="mt-0.5 text-[11px] text-muted-foreground">
                Saves each pane&apos;s visible scrollback to disk on exit and restores
                it when the session is resumed. Off by default. Stored in
                userData/scrollback/. Does not affect running panes.
              </div>
            </div>
            <Switch checked={scrollbackPersistence} onCheckedChange={onToggleScrollbackPersistence} />
          </div>
        </div>
      </section>
    </div>
  );
}

function formatUptime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
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
