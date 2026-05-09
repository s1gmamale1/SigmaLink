import { useEffect, useMemo, useState } from 'react';
import { Megaphone, Network, Plus, Power, Radio, RefreshCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { rpc } from '@/renderer/lib/rpc';
import { useAppState } from '@/renderer/app/state';
import { EmptyState } from '@/renderer/components/EmptyState';
import { ErrorBanner } from '@/renderer/components/ErrorBanner';
import type { RoleAssignment } from '@/shared/types';
import { SwarmCreate } from './SwarmCreate';
import { RoleRoster } from './RoleRoster';
import { SideChat } from './SideChat';

export function SwarmRoom() {
  const { state, dispatch } = useAppState();
  const [creating, setCreating] = useState(false);
  const [providers, setProviders] = useState<{ id: string; name: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeWorkspace = state.activeWorkspace;
  const swarms = useMemo(
    () =>
      state.swarms.filter((s) => activeWorkspace && s.workspaceId === activeWorkspace.id),
    [state.swarms, activeWorkspace],
  );
  const activeSwarm = useMemo(
    () => swarms.find((s) => s.id === state.activeSwarmId) ?? swarms[0] ?? null,
    [swarms, state.activeSwarmId],
  );
  const messages = useMemo(
    () => (activeSwarm ? state.swarmMessages[activeSwarm.id] ?? [] : []),
    [activeSwarm, state.swarmMessages],
  );

  // Initial tail when active swarm changes.
  useEffect(() => {
    let alive = true;
    if (!activeSwarm) return;
    if (state.swarmMessages[activeSwarm.id]) return;
    void (async () => {
      try {
        const tail = await rpc.swarms.tail(activeSwarm.id, { limit: 200 });
        if (!alive) return;
        dispatch({ type: 'SET_SWARM_MESSAGES', swarmId: activeSwarm.id, messages: tail });
      } catch (err) {
        console.error('tail failed', err);
      }
    })();
    return () => {
      alive = false;
    };
  }, [activeSwarm, dispatch, state.swarmMessages]);

  // Provider list for the roster card.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const list = await rpc.providers.list();
        if (!alive) return;
        setProviders(list.map((p) => ({ id: p.id, name: p.name })));
      } catch (err) {
        console.error(err);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const messageCounts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const m of messages) {
      if (m.fromAgent !== 'operator') {
        out[m.fromAgent] = (out[m.fromAgent] ?? 0) + 1;
      }
      if (m.toAgent !== '*') {
        out[m.toAgent] = (out[m.toAgent] ?? 0) + 1;
      }
    }
    return out;
  }, [messages]);

  async function refreshSwarms(): Promise<void> {
    if (!activeWorkspace) return;
    try {
      const list = await rpc.swarms.list(activeWorkspace.id);
      dispatch({ type: 'SET_SWARMS', swarms: list });
    } catch (err) {
      console.error(err);
    }
  }

  async function rollCall(): Promise<void> {
    if (!activeSwarm) return;
    setBusy(true);
    setError(null);
    try {
      await rpc.swarms.rollCall(activeSwarm.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function killActive(): Promise<void> {
    if (!activeSwarm) return;
    setBusy(true);
    setError(null);
    try {
      await rpc.swarms.kill(activeSwarm.id);
      dispatch({ type: 'MARK_SWARM_ENDED', id: activeSwarm.id });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!activeWorkspace) {
    return (
      <EmptyState
        icon={Network}
        title="Open a workspace first"
        description="Swarms are scoped per workspace — open a project folder to start one."
      />
    );
  }

  if (creating || swarms.length === 0) {
    return (
      <SwarmCreate
        onCancel={() => setCreating(false)}
        onCreated={(swarm) => {
          dispatch({ type: 'UPSERT_SWARM', swarm });
          dispatch({ type: 'SET_ACTIVE_SWARM', id: swarm.id });
          setCreating(false);
        }}
      />
    );
  }

  if (!activeSwarm) {
    return null;
  }

  const liveAgents = activeSwarm.agents;
  const roster: RoleAssignment[] = liveAgents.map((a) => ({
    role: a.role,
    roleIndex: a.roleIndex,
    providerId: a.providerId,
  }));

  return (
    <div className="flex h-full min-h-0 flex-col">
      {error ? (
        <ErrorBanner message={error} onDismiss={() => setError(null)} />
      ) : null}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-sm">
        <select
          value={activeSwarm.id}
          onChange={(e) => dispatch({ type: 'SET_ACTIVE_SWARM', id: e.target.value })}
          className="rounded-md border border-border bg-background px-2 py-1 text-sm"
        >
          {swarms.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} · {s.preset} · {s.status}
            </option>
          ))}
        </select>
        <div className="text-xs text-muted-foreground">
          mission: <span className="text-foreground">{activeSwarm.mission}</span>
        </div>
        <div className="ml-auto flex items-center gap-1">
          <Button variant="outline" size="sm" onClick={() => void refreshSwarms()} className="gap-1">
            <RefreshCcw className="h-3.5 w-3.5" /> Refresh
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void rollCall()}
            disabled={busy || activeSwarm.status !== 'running'}
            className="gap-1"
          >
            <Radio className="h-3.5 w-3.5" /> Roll-call
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setCreating(true)}
            className="gap-1"
          >
            <Plus className="h-3.5 w-3.5" /> New swarm
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => void killActive()}
            disabled={busy || activeSwarm.status !== 'running'}
            className="gap-1"
          >
            <Power className="h-3.5 w-3.5" /> Kill
          </Button>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[1fr_22rem]">
        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto p-3">
          <div className="flex items-center gap-2 rounded-md border border-border bg-card/40 px-3 py-2 text-xs text-muted-foreground">
            <Megaphone className="h-3.5 w-3.5" />
            <span>
              {activeSwarm.agents.length} agents · status{' '}
              <span className="text-foreground">{activeSwarm.status}</span>
            </span>
            {error ? <span className="ml-auto text-destructive">{error}</span> : null}
          </div>
          <RoleRoster
            roster={roster}
            providers={providers}
            onChange={() => undefined}
            readOnly
            liveAgents={liveAgents}
            messageCounts={messageCounts}
          />
        </div>
        <SideChat swarm={activeSwarm} messages={messages} />
      </div>
    </div>
  );
}
