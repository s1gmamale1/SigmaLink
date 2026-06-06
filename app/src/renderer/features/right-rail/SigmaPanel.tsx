// BSP-O1 + BSP-O2 — Persistent "Sigma" right-rail panel.
//
// Two internal sub-tabs:
//   - Canvas (default): numbered task/agent list with live status glyphs +
//     swarm-aggregate live token-delta readout (useSwarmLiveStats).
//   - Review: tool-call trace via the existing ToolCallInspector.
//
// The panel is kept alive via the lazy-mount latch in RightRail.tsx (same
// pattern as SwarmRailTab). React local state persists across room swaps;
// no KV/db writes are needed.

import { useMemo, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAppStateSelector } from '@/renderer/app/state';
import { ToolCallInspector } from '@/renderer/features/jorvis-assistant/ToolCallInspector';
import { useSwarmLiveStats } from './useSwarmLiveStats';
import { deriveStatus } from './swarm-status';
import { useRightRail } from './RightRailContext.data';
import type { AgentSession, Swarm } from '@/shared/types';

// ── Sub-tab ids ──────────────────────────────────────────────────────────────

type SigmaSubTab = 'canvas' | 'review';

// ── Empty-array singletons (avoid selector reference churn) ─────────────────

const EMPTY_SWARMS: Swarm[] = [];
const EMPTY_SESSIONS: AgentSession[] = [];

// Status glyph/color/label come from the shared `deriveStatus` (SwarmPhaseTree),
// which combines swarm-agent status (idle/busy/blocked/done) with PTY session
// status — so the Canvas shows the SAME orchestration state as the Swarm room
// rather than a session-only approximation (M1).

// ── Canvas sub-tab ───────────────────────────────────────────────────────────

interface CanvasProps {
  swarm: Swarm | null;
  sessions: AgentSession[];
}

function CanvasSubTab({ swarm, sessions }: CanvasProps) {
  // M4 — only poll usage while the Sigma tab is the visible rail tab. Rail
  // bodies stay latched/mounted across tab switches, so without this the
  // aggregator would keep polling rpc.usage.sessionSummary off-tab (PERF-5).
  const { activeTab } = useRightRail();

  // Index sessions by id for O(1) lookup.
  const sessionMap = useMemo(
    () => new Map(sessions.map((s) => [s.id, s])),
    [sessions],
  );

  const sessionIds = useMemo(
    () =>
      swarm
        ? swarm.agents.map((a) => a.sessionId).filter((id): id is string => id !== null)
        : [],
    [swarm],
  );

  const liveStats = useSwarmLiveStats(
    sessionIds,
    swarm?.status === 'running' && activeTab === 'sigma',
  );

  if (!swarm) {
    return (
      <div
        className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center"
        role="status"
        aria-label="No active swarm"
      >
        <Sparkles className="h-8 w-8 text-muted-foreground/30" aria-hidden />
        <p className="text-xs text-muted-foreground">
          No active swarm — start one from the Operator Console.
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      {/* Swarm header */}
      <div className="flex items-baseline justify-between border-b border-border px-3 py-2">
        <span className="truncate text-xs font-semibold text-foreground">
          {swarm.mission || swarm.name}
        </span>
        <span
          className={cn(
            'ml-2 shrink-0 text-[10px] font-medium tabular-nums',
            swarm.status === 'running' ? 'text-emerald-500' : 'text-muted-foreground',
          )}
        >
          {swarm.status}
        </span>
      </div>

      {/* Live token delta */}
      {liveStats.hasData || liveStats.swarmTokenDelta > 0 ? (
        <div className="flex items-center gap-1.5 border-b border-border px-3 py-1.5 text-[10px] text-muted-foreground">
          <span className="font-medium text-foreground">Live tok/poll</span>
          <span className="ml-auto font-mono tabular-nums text-emerald-500">
            +{liveStats.swarmTokenDelta}
          </span>
        </div>
      ) : null}

      {/* Agent / task list */}
      <ol className="flex flex-col divide-y divide-border/50" aria-label="Swarm agents">
        {swarm.agents.map((agent, idx) => {
          const session = agent.sessionId ? sessionMap.get(agent.sessionId) : undefined;
          // M1 — shared derivation: swarm-agent status (idle/busy/blocked/done)
          // combined with PTY status, matching the Swarm room exactly.
          const { label, color, glyph } = deriveStatus(agent.status, session?.status);

          return (
            <li
              key={agent.id}
              className="flex items-start gap-2 px-3 py-2 text-xs"
              aria-label={`Agent ${idx + 1}: ${agent.agentKey} — ${label}`}
            >
              {/* Index */}
              <span className="w-5 shrink-0 text-right font-mono text-muted-foreground/60">
                {idx + 1}.
              </span>
              {/* Status glyph */}
              <span
                className="shrink-0 font-mono text-[11px]"
                style={{ color }}
                aria-hidden
                title={label}
              >
                {glyph}
              </span>
              {/* Agent info */}
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-1.5">
                  <span className="truncate font-medium text-foreground">
                    {agent.agentKey}
                  </span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {agent.providerId}
                  </span>
                </div>
                <div className="text-[10px] text-muted-foreground capitalize">{label}</div>
              </div>
            </li>
          );
        })}
      </ol>

      {swarm.agents.length === 0 ? (
        <div className="px-3 py-2 text-xs text-muted-foreground">
          No agents in this swarm yet.
        </div>
      ) : null}
    </div>
  );
}

// ── SigmaPanel ───────────────────────────────────────────────────────────────

export function SigmaPanel() {
  const [subTab, setSubTab] = useState<SigmaSubTab>('canvas');

  const activeWorkspaceId = useAppStateSelector((s) => s.activeWorkspaceId);
  const activeSwarmId = useAppStateSelector((s) => s.activeSwarmId);
  const sessions = useAppStateSelector((s) => s.sessions ?? EMPTY_SESSIONS);

  const workspaceSwarms = useAppStateSelector((s) =>
    activeWorkspaceId
      ? (s.swarmsByWorkspace[activeWorkspaceId] ?? EMPTY_SWARMS)
      : EMPTY_SWARMS,
  );

  // Mirror SwarmRailTab's active-swarm resolution: prefer the explicitly
  // selected swarm, then fall back to the first running one in the workspace.
  const activeSwarm = useMemo(() => {
    const selected = activeSwarmId
      ? workspaceSwarms.find((s) => s.id === activeSwarmId)
      : null;
    return selected ?? workspaceSwarms.find((s) => s.status === 'running') ?? null;
  }, [activeSwarmId, workspaceSwarms]);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="sigma-panel">
      {/* Internal sub-tab bar */}
      <div
        role="tablist"
        aria-label="Sigma sub-tabs"
        className="flex shrink-0 items-center border-b border-border bg-muted/20"
      >
        {(['canvas', 'review'] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={subTab === tab}
            aria-controls={`sigma-panel-${tab}`}
            id={`sigma-tab-${tab}`}
            onClick={() => setSubTab(tab)}
            className={cn(
              'flex-1 px-3 py-1.5 text-xs transition',
              subTab === tab
                ? 'border-b-2 border-primary font-medium text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {tab === 'canvas' ? 'Canvas' : 'Review'}
          </button>
        ))}
      </div>

      {/* Sub-tab bodies — both kept mounted; inactive one is hidden */}
      <div
        role="tabpanel"
        id="sigma-panel-canvas"
        aria-labelledby="sigma-tab-canvas"
        hidden={subTab !== 'canvas'}
        className={cn('min-h-0 flex-1 flex-col', subTab === 'canvas' ? 'flex' : 'hidden')}
      >
        <CanvasSubTab swarm={activeSwarm} sessions={sessions} />
      </div>

      <div
        role="tabpanel"
        id="sigma-panel-review"
        aria-labelledby="sigma-tab-review"
        hidden={subTab !== 'review'}
        className={cn('min-h-0 flex-1 flex-col overflow-y-auto', subTab === 'review' ? 'flex' : 'hidden')}
      >
        {/* BSP-O2 — live routing trace. ToolCallInspector listens for
            assistant:tool-trace globally (the Sigma assistant's tool/routing
            decisions; not swarm-agent-scoped). M3 — caption so it isn't read
            as a swarm-only review. L1 — it's a self-managed collapsible strip
            (own max-h scroll); mount top-aligned, no flex-1 to fight shrink-0. */}
        <p className="shrink-0 px-3 py-2 text-[10px] text-muted-foreground">
          Sigma assistant routing &amp; tool calls
        </p>
        <ToolCallInspector />
      </div>
    </div>
  );
}
