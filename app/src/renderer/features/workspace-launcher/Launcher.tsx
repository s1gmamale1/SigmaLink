import { useEffect, useMemo, useState } from 'react';
import { Folder, FolderPlus, Play, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { rpc } from '@/renderer/lib/rpc';
import { useAppState } from '@/renderer/app/state';
import { ErrorBanner } from '@/renderer/components/ErrorBanner';
import type { GridPreset, LaunchPlan, Workspace } from '@/shared/types';
import type { ProviderProbe } from '@/shared/types';

const PRESETS: GridPreset[] = [1, 2, 4, 6, 8, 10, 12, 14, 16];

interface ProviderInfo {
  id: string;
  name: string;
  description: string;
  color: string;
  installHint: string;
  probe?: ProviderProbe;
}

export function WorkspaceLauncher() {
  const { state, dispatch } = useAppState();
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [selectedWorkspace, setSelectedWorkspace] = useState<Workspace | null>(state.activeWorkspace);
  const [preset, setPreset] = useState<GridPreset>(4);
  const [paneProviders, setPaneProviders] = useState<string[]>([]);
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const list = await rpc.providers.list();
      const probes = await rpc.providers.probeAll().catch(() => [] as ProviderProbe[]);
      if (!alive) return;
      const probeById = new Map(probes.map((p) => [p.id, p]));
      const merged: ProviderInfo[] = list.map((p) => ({
        ...p,
        probe: probeById.get(p.id),
      }));
      setProviders(merged);
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (paneProviders.length === preset) return;
    const fallback = providers[0]?.id ?? 'shell';
    setPaneProviders((prev) => {
      const next = Array(preset).fill(fallback);
      for (let i = 0; i < Math.min(prev.length, preset); i++) next[i] = prev[i];
      return next;
    });
  }, [preset, providers, paneProviders.length]);

  const repoLabel = useMemo(() => {
    if (!selectedWorkspace) return 'Select a folder';
    return selectedWorkspace.repoMode === 'git'
      ? 'Git worktrees will be created per pane'
      : 'Plain folder mode (no worktree isolation)';
  }, [selectedWorkspace]);

  async function pickFolder(): Promise<void> {
    const r = await rpc.workspaces.pickFolder();
    if (!r) return;
    const ws = await rpc.workspaces.open(r.path);
    setSelectedWorkspace(ws);
    dispatch({ type: 'SET_WORKSPACES', workspaces: await rpc.workspaces.list() });
  }

  async function chooseExisting(ws: Workspace): Promise<void> {
    const reopened = await rpc.workspaces.open(ws.rootPath);
    setSelectedWorkspace(reopened);
  }

  async function removeExisting(ws: Workspace): Promise<void> {
    await rpc.workspaces.remove(ws.id);
    dispatch({ type: 'SET_WORKSPACES', workspaces: await rpc.workspaces.list() });
    if (selectedWorkspace?.id === ws.id) setSelectedWorkspace(null);
  }

  async function launch(): Promise<void> {
    if (!selectedWorkspace) {
      setError('Pick a workspace folder first.');
      return;
    }
    setLaunching(true);
    setError(null);
    try {
      const plan: LaunchPlan = {
        workspaceRoot: selectedWorkspace.rootPath,
        preset,
        panes: paneProviders.map((providerId, paneIndex) => ({ paneIndex, providerId })),
      };
      const out = await rpc.workspaces.launch(plan);
      dispatch({ type: 'SET_ACTIVE_WORKSPACE', workspace: selectedWorkspace });
      dispatch({ type: 'ADD_SESSIONS', sessions: out.sessions });
      dispatch({ type: 'SET_ROOM', room: 'command' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    } finally {
      setLaunching(false);
    }
  }

  return (
    <div className="sl-fade-in flex h-full flex-col gap-4 overflow-y-auto p-6">
      {error ? (
        <ErrorBanner message={error} onDismiss={() => setError(null)} />
      ) : null}
      <header>
        <div className="text-2xl font-semibold tracking-tight">Workspaces</div>
        <div className="text-sm text-muted-foreground">
          Open a project folder, choose a grid layout, assign one CLI agent per pane, then launch.
        </div>
      </header>

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="col-span-1 flex flex-col gap-3 p-4 lg:col-span-2">
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium">1 · Choose a folder</div>
            <Button size="sm" onClick={pickFolder} className="gap-2">
              <FolderPlus className="h-4 w-4" /> Pick folder
            </Button>
          </div>
          {selectedWorkspace ? (
            <div className="rounded-md border border-border bg-muted/20 p-3 text-sm">
              <div className="flex items-center gap-2 font-medium">
                <Folder className="h-4 w-4" /> {selectedWorkspace.name}
              </div>
              <div className="mt-1 truncate text-xs text-muted-foreground" title={selectedWorkspace.rootPath}>
                {selectedWorkspace.rootPath}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">{repoLabel}</div>
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">No folder selected.</div>
          )}
          {state.workspaces.length > 0 && (
            <div className="mt-2">
              <div className="mb-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Recent
              </div>
              <ul className="flex flex-col gap-1">
                {state.workspaces.slice(0, 8).map((ws) => (
                  <li
                    key={ws.id}
                    className={cn(
                      'group flex items-center justify-between rounded-md border border-border bg-card/40 px-2 py-1.5 text-sm transition hover:bg-card',
                      selectedWorkspace?.id === ws.id && 'border-primary/60 bg-primary/10',
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => chooseExisting(ws)}
                      className="flex flex-1 items-center gap-2 text-left"
                    >
                      <Folder className="h-4 w-4 text-muted-foreground" />
                      <span className="truncate" title={ws.rootPath}>
                        <span className="font-medium">{ws.name}</span>{' '}
                        <span className="text-xs text-muted-foreground">{ws.rootPath}</span>
                      </span>
                    </button>
                    <button
                      type="button"
                      className="opacity-0 transition group-hover:opacity-100"
                      onClick={() => removeExisting(ws)}
                      aria-label="Forget workspace"
                    >
                      <Trash2 className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive" />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>

        <Card className="col-span-1 flex flex-col gap-3 p-4">
          <div className="text-sm font-medium">2 · Grid preset</div>
          <div className="grid grid-cols-3 gap-2">
            {PRESETS.map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setPreset(n)}
                className={cn(
                  'rounded-md border border-border px-3 py-2 text-sm transition',
                  preset === n
                    ? 'border-primary bg-primary/15 text-primary-foreground'
                    : 'bg-card/40 hover:bg-card',
                )}
              >
                {n} {n === 1 ? 'pane' : 'panes'}
              </button>
            ))}
          </div>
        </Card>
      </section>

      <Card className="flex flex-col gap-3 p-4">
        <div className="text-sm font-medium">3 · Assign a provider per pane</div>
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          {paneProviders.map((providerId, idx) => (
            <PaneAssign
              key={idx}
              index={idx}
              providers={providers}
              providerId={providerId}
              onChange={(next) =>
                setPaneProviders((prev) => prev.map((p, i) => (i === idx ? next : p)))
              }
            />
          ))}
        </div>
      </Card>

      <div className="flex items-center justify-between">
        <div className="text-xs text-muted-foreground">
          {error ? <span className="text-destructive">{error}</span> : 'Ready when you are.'}
        </div>
        <Button onClick={launch} disabled={launching || !selectedWorkspace} className="gap-2">
          <Play className="h-4 w-4" />
          {launching ? 'Launching…' : `Launch ${preset} ${preset === 1 ? 'agent' : 'agents'}`}
        </Button>
      </div>
    </div>
  );
}

function PaneAssign({
  index,
  providers,
  providerId,
  onChange,
}: {
  index: number;
  providers: ProviderInfo[];
  providerId: string;
  onChange: (id: string) => void;
}) {
  const provider = providers.find((p) => p.id === providerId);
  return (
    <label className="flex flex-col gap-1 rounded-md border border-border bg-card/40 p-2">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
        Pane {index + 1}
      </span>
      <select
        value={providerId}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-md border border-border bg-background px-2 py-1 text-sm"
      >
        {providers.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
            {p.probe ? (p.probe.found ? ' ✓' : ' (not on PATH)') : ''}
          </option>
        ))}
      </select>
      {provider && !provider.probe?.found && provider.id !== 'shell' && (
        <span className="text-[10px] text-amber-400">{provider.installHint}</span>
      )}
    </label>
  );
}
