// MCP servers tab — FEAT-5 diagnostics.
//
// Reads the per-workspace MCP config diagnostics (rpc.mcp.diagnoseWorkspace),
// which scans every provider's on-disk config (.mcp.json, .cursor/mcp.json,
// ~/.codex/config.toml, ~/.gemini/settings.json, ~/.kimi/mcp.json,
// opencode.json), lists the declared servers, and flags scope conflicts /
// missing env / duplicate defs / unreadable files. Renders a "Manage N servers"
// header, a color-coded issues list, and the server table. Defensive about
// loading / empty / error states and an absent active workspace.

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  Info,
  RefreshCcw,
  Server,
  ShieldCheck,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { rpc } from '@/renderer/lib/rpc';
import { useAppState } from '@/renderer/app/state';
import { EmptyState } from '@/renderer/components/EmptyState';
import { cn } from '@/lib/utils';
import type { McpDiagnostic, McpIssue, McpServerEntry } from '@/shared/types';

type LoadState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; data: McpDiagnostic }
  | { kind: 'error'; message: string };

const SEVERITY_META: Record<
  McpIssue['severity'],
  { Icon: typeof AlertTriangle; tone: string; label: string }
> = {
  error: { Icon: AlertCircle, tone: 'text-destructive', label: 'Error' },
  warn: { Icon: AlertTriangle, tone: 'text-amber-500', label: 'Warning' },
  info: { Icon: Info, tone: 'text-muted-foreground', label: 'Info' },
};

const PROVIDER_LABEL: Record<McpServerEntry['provider'], string> = {
  claude: 'Claude',
  cursor: 'Cursor',
  codex: 'Codex',
  gemini: 'Gemini',
  kimi: 'Kimi',
  opencode: 'OpenCode',
};

export function McpServersTab() {
  const { state } = useAppState();
  const workspaces = state.workspaces;

  // The user's explicit pick (null = follow the active workspace). We DERIVE the
  // effective id rather than storing+correcting it in an effect, so there is no
  // synchronous setState-in-effect (react-hooks/set-state-in-effect).
  const [override, setOverride] = useState<string | null>(null);
  const [load, setLoad] = useState<LoadState>({ kind: 'idle' });

  const selectedId = useMemo<string | null>(() => {
    if (override && workspaces.some((w) => w.id === override)) return override;
    return state.activeWorkspaceId ?? workspaces[0]?.id ?? null;
  }, [override, workspaces, state.activeWorkspaceId]);

  const refresh = useCallback(async (workspaceId: string) => {
    setLoad({ kind: 'loading' });
    try {
      const data = await rpc.mcp.diagnoseWorkspace({ workspaceId });
      setLoad({ kind: 'ready', data });
    } catch (err) {
      setLoad({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }, []);

  // Drive the scan off the selection. All setState happens asynchronously (in a
  // microtask), never synchronously in the effect body, to avoid cascading
  // renders (react-hooks/set-state-in-effect).
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      if (!selectedId) {
        setLoad({ kind: 'idle' });
        return;
      }
      void refresh(selectedId);
    });
    return () => {
      cancelled = true;
    };
  }, [selectedId, refresh]);

  const data = load.kind === 'ready' ? load.data : null;
  const serverCount = data?.servers.length ?? 0;
  const sortedIssues = useMemo(() => {
    if (!data) return [];
    const rank: Record<McpIssue['severity'], number> = { error: 0, warn: 1, info: 2 };
    return [...data.issues].sort((a, b) => rank[a.severity] - rank[b.severity]);
  }, [data]);

  if (workspaces.length === 0) {
    return (
      <EmptyState
        icon={Server}
        title="No workspaces yet"
        description="Open a project folder to inspect its MCP server configuration here."
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Server className="h-4 w-4 text-muted-foreground" aria-hidden />
          <span className="text-sm font-medium">
            {load.kind === 'ready'
              ? `Manage ${serverCount} server${serverCount === 1 ? '' : 's'}`
              : 'MCP servers'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {workspaces.length > 1 && (
            <select
              aria-label="Workspace"
              className="rounded-md border border-border bg-background px-2 py-1 text-xs"
              value={selectedId ?? ''}
              onChange={(e) => setOverride(e.target.value || null)}
            >
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          )}
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => selectedId && void refresh(selectedId)}
            disabled={load.kind === 'loading' || !selectedId}
            className="gap-1"
          >
            <RefreshCcw className={cn('h-3.5 w-3.5', load.kind === 'loading' && 'animate-spin')} />{' '}
            Rescan
          </Button>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        Scans each provider&apos;s on-disk MCP config for the selected workspace and flags scope
        conflicts, missing environment, duplicate definitions, and unreadable files.
      </p>

      {load.kind === 'loading' && (
        <div className="rounded-md border border-border bg-card/40 px-3 py-4 text-center text-xs text-muted-foreground">
          Scanning provider configs…
        </div>
      )}

      {load.kind === 'error' && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>Diagnostics failed: {load.message}</span>
        </div>
      )}

      {load.kind === 'ready' && (
        <>
          {/* ── Issues ── */}
          {sortedIssues.length === 0 ? (
            <div className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-600 dark:text-emerald-400">
              <ShieldCheck className="h-3.5 w-3.5 shrink-0" aria-hidden />
              <span>No configuration issues detected.</span>
            </div>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {sortedIssues.map((issue, i) => {
                const meta = SEVERITY_META[issue.severity];
                const { Icon } = meta;
                return (
                  <li
                    key={`${issue.kind}-${issue.file ?? ''}-${i}`}
                    className="flex items-start gap-2 rounded-md border border-border bg-card/40 px-3 py-2 text-xs"
                  >
                    <Icon
                      className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', meta.tone)}
                      aria-label={meta.label}
                    />
                    <div className="min-w-0">
                      <div className="font-medium">{issue.title}</div>
                      <div className="mt-0.5 text-muted-foreground">{issue.detail}</div>
                      {issue.file && (
                        <div className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground/80">
                          {issue.file}
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {/* ── Servers ── */}
          {serverCount === 0 ? (
            <EmptyState
              icon={Server}
              title="No MCP servers configured"
              description="No provider config declares an MCP server for this workspace yet."
            />
          ) : (
            <ul className="flex flex-col gap-1.5">
              {data?.servers.map((s) => (
                <li
                  key={`${s.provider}-${s.name}-${s.file}`}
                  className="flex items-center justify-between gap-2 rounded-md border border-border bg-card/40 px-3 py-2 text-sm"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{s.name}</span>
                      {s.managed && (
                        <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                          managed
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground" title={s.file}>
                      {s.file}
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                    <span>{PROVIDER_LABEL[s.provider]}</span>
                    <span>{s.scope}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
