// V3-W12-013 — Operator Console room shell.
//
// Composes the top bar (TERMINALS · CHAT · ACTIVITY · STOP ALL · group filter
// chips · mission rename) with placeholder bodies for each tab. The
// constellation graph (V3-W13-005), activity feed (V3-W13-006), and chat tail
// land in W13.
//
// `swarm:counters` and `swarm:ledger` events arrive via the preload bridge.
// Until foundations adds those event channels to the EVENTS allowlist, the
// `onEvent` calls fail silently in production but stay wired so renderer
// tests can drive the UI deterministically.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Network } from 'lucide-react';
import { onEvent } from '@/renderer/lib/rpc';
import { useAppState } from '@/renderer/app/state';
import { EmptyState } from '@/renderer/components/EmptyState';
import { TopBar, type AgentFilter, type ConsoleTab, type CountersPayload } from './TopBar';
import { Constellation } from './Constellation';
import { ActivityFeed } from './ActivityFeed';

interface LedgerPayload {
  swarmId: string;
  agentsTotal: number;
  messagesTotal: number;
  elapsedMs: number;
}

/** Side-band invoke for the `swarm.<method>` namespace. The typed `rpc` proxy
 *  only knows about controllers in `AppRouter`; the operator console channels
 *  are registered side-band by rpc-router until foundations expands the
 *  router shape. */
async function invokeSwarmRpc<T = unknown>(
  channel: `swarm.${string}`,
  ...args: unknown[]
): Promise<T> {
  if (!('sigma' in window)) {
    throw new Error('Preload bridge missing — restart the app.');
  }
  const env = (await window.sigma.invoke(channel, ...args)) as
    | { ok: true; data: T }
    | { ok: false; error: string };
  if (!env || typeof env !== 'object' || !('ok' in env)) {
    throw new Error(`Bad RPC response from ${channel}`);
  }
  if (env.ok) return env.data;
  throw new Error(env.error);
}

export function OperatorConsole() {
  const { state, dispatch } = useAppState();
  const [tab, setTab] = useState<ConsoleTab>('terminals');
  const [filter, setFilter] = useState<AgentFilter>('all');
  const [counters, setCounters] = useState<CountersPayload | null>(null);
  const [ledger, setLedger] = useState<LedgerPayload | null>(null);

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

  // Subscribe to counter + ledger events for the active swarm.
  useEffect(() => {
    if (!activeSwarm) return;
    const offCounters = onEvent<CountersPayload>('swarm:counters', (p) => {
      if (p && p.swarmId === activeSwarm.id) setCounters(p);
    });
    const offLedger = onEvent<LedgerPayload>('swarm:ledger', (p) => {
      if (p && p.swarmId === activeSwarm.id) setLedger(p);
    });
    return () => {
      offCounters();
      offLedger();
    };
  }, [activeSwarm]);

  const onTabChange = useCallback(
    (next: ConsoleTab) => {
      setTab(next);
      if (activeSwarm) {
        void invokeSwarmRpc('swarm.console-tab', {
          swarmId: activeSwarm.id,
          tab: next,
        }).catch(() => {
          /* channel allowlist not yet shipped — surface noop is fine */
        });
      }
    },
    [activeSwarm],
  );

  const onFilterChange = useCallback(
    (next: AgentFilter) => {
      setFilter(next);
      if (activeSwarm) {
        void invokeSwarmRpc('swarm.agent-filter', {
          swarmId: activeSwarm.id,
          filter: next,
        }).catch(() => undefined);
      }
    },
    [activeSwarm],
  );

  const onMissionRename = useCallback(
    async (next: string) => {
      if (!activeSwarm) return;
      try {
        await invokeSwarmRpc<{ mission: string }>('swarm.mission-rename', {
          swarmId: activeSwarm.id,
          mission: next,
        });
        dispatch({
          type: 'UPSERT_SWARM',
          swarm: { ...activeSwarm, mission: next },
        });
      } catch {
        /* allowlist not yet shipped */
      }
    },
    [activeSwarm, dispatch],
  );

  const onStopAll = useCallback(
    async (reason: string) => {
      if (!activeSwarm) return;
      try {
        await invokeSwarmRpc<{ stopped: number }>('swarm.stop-all', {
          swarmId: activeSwarm.id,
          reason,
        });
        dispatch({ type: 'MARK_SWARM_ENDED', id: activeSwarm.id });
      } catch {
        /* allowlist not yet shipped */
      }
    },
    [activeSwarm, dispatch],
  );

  if (!activeWorkspace) {
    return (
      <EmptyState
        icon={Network}
        title="Open a workspace first"
        description="The Operator Console is scoped to the active swarm."
      />
    );
  }

  if (!activeSwarm) {
    return (
      <EmptyState
        icon={Network}
        title="No active swarm"
        description="Create a swarm in the Swarm Room to populate the console."
      />
    );
  }

  // Filter membership helper for the placeholder bodies. The constellation
  // graph and activity feed (W13) reuse the same filter.
  const visibleAgents = activeSwarm.agents.filter((a) => {
    if (filter === 'all') return true;
    if (filter === 'coordinators') return a.role === 'coordinator';
    if (filter === 'builders') return a.role === 'builder';
    if (filter === 'reviewers') return a.role === 'reviewer';
    if (filter === 'scouts') return a.role === 'scout';
    return true;
  });

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <TopBar
        swarmId={activeSwarm.id}
        swarmName={activeSwarm.name}
        mission={activeSwarm.mission}
        tab={tab}
        onTabChange={onTabChange}
        filter={filter}
        onFilterChange={onFilterChange}
        counters={counters}
        onMissionRename={onMissionRename}
        onStopAll={onStopAll}
      />

      <div className="flex flex-1 overflow-hidden">
        {tab === 'terminals' ? (
          <>
            <div className="flex flex-1 flex-col overflow-hidden">
              <Constellation
                swarmId={activeSwarm.id}
                agents={visibleAgents}
                filter={filter}
              />
            </div>
            <ActivityFeed
              agents={activeSwarm.agents}
              messages={messages}
              filter={filter}
            />
          </>
        ) : null}

        {tab === 'chat' ? (
          <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
            <div className="flex flex-col items-center gap-1 text-center">
              <span className="text-sm font-medium text-foreground">
                Chat — {messages.length} messages · filter: {filter}
              </span>
              <span>Wire the live chat tail in V3-W13.</span>
            </div>
          </div>
        ) : null}

        {tab === 'activity' ? (
          <div className="flex flex-1 overflow-hidden">
            <div className="flex flex-1 items-center justify-center text-[11px] text-muted-foreground">
              {ledger
                ? `${ledger.messagesTotal} total events · ${Math.floor(
                    ledger.elapsedMs / 1000,
                  )}s elapsed`
                : 'Counting…'}
            </div>
            <ActivityFeed
              agents={activeSwarm.agents}
              messages={messages}
              filter={filter}
            />
          </div>
        ) : null}
      </div>

      {ledger ? (
        <div className="flex shrink-0 items-center gap-3 border-t border-border bg-card/40 px-3 py-1 text-[10px] uppercase tracking-wider text-muted-foreground">
          <span>
            Agents <span className="text-foreground">{ledger.agentsTotal}</span>
          </span>
          <span>
            Messages <span className="text-foreground">{ledger.messagesTotal}</span>
          </span>
          <span>
            Elapsed{' '}
            <span className="text-foreground">
              {Math.floor(ledger.elapsedMs / 1000)}s
            </span>
          </span>
        </div>
      ) : null}
    </div>
  );
}
