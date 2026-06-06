// SwarmPhaseTree — FEAT-6 phase-grouped agent tree in the right-rail Swarm tab.
//
// Synthesizes phases from SwarmAgent.role:
//   coordinator → "Orchestrate"
//   builder     → "Execute"
//   reviewer    → "Verify"
//   scout       → "Scout"
//   (custom)    → role name (title-cased)
//
// Each phase header is collapsible, shows the agent count, and is expanded
// by default. Rows are buttons that dispatch SET_ACTIVE_SESSION on click.
// Status uses both a colored dot AND a glyph/text label for accessibility.
// Collapse animation uses the sl-fade-in token; motion-safe only (honoring
// prefers-reduced-motion via Tailwind motion-safe:* utilities).

import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAppDispatch } from '@/renderer/app/state';
import type { AgentSession, Swarm, SwarmAgent } from '@/shared/types';
import { deriveStatus, type SessionStatus } from './swarm-status';

// ─── Phase synthesis ──────────────────────────────────────────────────────────

const ROLE_TO_PHASE: Record<string, string> = {
  coordinator: 'Orchestrate',
  builder: 'Execute',
  reviewer: 'Verify',
  scout: 'Scout',
};

function phaseFromRole(role: string): string {
  return ROLE_TO_PHASE[role] ?? role.charAt(0).toUpperCase() + role.slice(1);
}

// Canonical display order for known phases; custom roles sort alphabetically
// after the last canonical phase.
const PHASE_ORDER: Record<string, number> = {
  Orchestrate: 0,
  Execute: 1,
  Verify: 2,
  Scout: 3,
};

function phaseSort(a: string, b: string): number {
  const oa = PHASE_ORDER[a] ?? 999;
  const ob = PHASE_ORDER[b] ?? 999;
  if (oa !== ob) return oa - ob;
  return a.localeCompare(b);
}

// ─── Status derivation ────────────────────────────────────────────────────────
// `deriveStatus` lives in ./swarm-status so the Sigma rail Canvas can reuse it
// without tripping react-refresh/only-export-components on this component file.

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SwarmPhaseTreeProps {
  swarm: Swarm;
  /** All sessions from app state — used to cross-ref PTY status. */
  sessions: AgentSession[];
  /** Message counts per agentKey (e.g. "builder-1" → 3). */
  messageCounts: Record<string, number>;
  /** Latest non-SYSTEM body per agentKey for the activity blurb. */
  lastActivity: Record<string, string>;
}

// ─── Phase header ─────────────────────────────────────────────────────────────

interface PhaseHeaderProps {
  phase: string;
  agentCount: number;
  expanded: boolean;
  onToggle: () => void;
}

function PhaseHeader({ phase, agentCount, expanded, onToggle }: PhaseHeaderProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      className={cn(
        'flex w-full items-center gap-1.5 rounded-md px-2 py-1.5',
        'text-left text-[11px] font-semibold uppercase tracking-wider',
        'text-muted-foreground transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      )}
    >
      {expanded ? (
        <ChevronDown className="h-3 w-3 shrink-0" aria-hidden="true" />
      ) : (
        <ChevronRight className="h-3 w-3 shrink-0" aria-hidden="true" />
      )}
      <span>{phase}</span>
      <span
        className="ml-1 rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-normal text-muted-foreground tabular-nums"
        aria-label={`${agentCount} agent${agentCount !== 1 ? 's' : ''}`}
      >
        {agentCount}
      </span>
    </button>
  );
}

// ─── Agent row ────────────────────────────────────────────────────────────────

interface AgentRowProps {
  agent: SwarmAgent;
  sessionStatus?: SessionStatus;
  messageCount: number;
  lastActivityBody?: string;
  onFocus: (sessionId: string) => void;
}

function AgentRow({
  agent,
  sessionStatus,
  messageCount,
  lastActivityBody,
  onFocus,
}: AgentRowProps) {
  const status = deriveStatus(agent.status, sessionStatus);
  const canFocus = !!agent.sessionId;

  return (
    <button
      type="button"
      disabled={!canFocus}
      onClick={canFocus ? () => onFocus(agent.sessionId!) : undefined}
      aria-label={`Focus ${agent.agentKey} — ${status.label}`}
      className={cn(
        'sl-fade-in flex w-full flex-col gap-0.5 rounded-md border border-transparent px-3 py-2 text-left',
        'transition-colors',
        canFocus
          ? 'cursor-pointer hover:border-border hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
          : 'cursor-default opacity-60',
      )}
    >
      {/* Row header: agentKey + provider + status */}
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-foreground">
          {agent.agentKey}
        </span>
        <span className="shrink-0 text-[10px] text-muted-foreground">{agent.providerId}</span>
        {/* Status: colored dot (decorative) + glyph+text (accessible) */}
        <span
          className="flex shrink-0 items-center gap-1 text-[10px]"
          aria-label={`status: ${status.label}`}
        >
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ background: status.color }}
            aria-hidden="true"
          />
          <span
            className="font-mono"
            style={{ color: status.color }}
            aria-hidden="true"
          >
            {status.glyph}
          </span>
          <span className="sr-only">{status.label}</span>
        </span>
      </div>
      {/* Message count + last activity */}
      <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
        {messageCount > 0 ? (
          <span className="shrink-0 tabular-nums">{messageCount} msgs</span>
        ) : null}
        {lastActivityBody ? (
          <span className="min-w-0 flex-1 truncate">{lastActivityBody}</span>
        ) : null}
      </div>
    </button>
  );
}

// ─── SwarmPhaseTree ───────────────────────────────────────────────────────────

export function SwarmPhaseTree({
  swarm,
  sessions,
  messageCounts,
  lastActivity,
}: SwarmPhaseTreeProps) {
  const dispatch = useAppDispatch();

  // Group agents by synthetic phase.
  const phases = useMemo(() => {
    const map = new Map<string, SwarmAgent[]>();
    for (const agent of swarm.agents) {
      const phase = phaseFromRole(agent.role);
      const existing = map.get(phase) ?? [];
      map.set(phase, [...existing, agent]);
    }
    // Sort phases canonically then entries by roleIndex.
    return Array.from(map.entries())
      .sort(([a], [b]) => phaseSort(a, b))
      .map(([phase, agents]) => ({
        phase,
        agents: [...agents].sort((a, b) => a.roleIndex - b.roleIndex),
      }));
  }, [swarm.agents]);

  // All phases start expanded.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  function togglePhase(phase: string) {
    setCollapsed((prev) => ({ ...prev, [phase]: !prev[phase] }));
  }

  function handleFocus(sessionId: string) {
    dispatch({ type: 'SET_ACTIVE_SESSION', id: sessionId });
  }

  if (phases.length === 0) {
    return (
      <div className="px-2 py-3 text-center text-[11px] text-muted-foreground">
        No agents in swarm.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1 px-1 py-1" role="tree" aria-label="Swarm phases">
      {phases.map(({ phase, agents }) => {
        const isExpanded = !collapsed[phase];
        return (
          <div key={phase} role="treeitem" aria-expanded={isExpanded}>
            <PhaseHeader
              phase={phase}
              agentCount={agents.length}
              expanded={isExpanded}
              onToggle={() => togglePhase(phase)}
            />
            {isExpanded ? (
              <div
                className="ml-2 flex flex-col gap-0.5 overflow-hidden sl-fade-in"
                role="group"
                aria-label={`${phase} agents`}
              >
                {agents.map((agent) => {
                  const session = sessions.find((s) => s.id === agent.sessionId);
                  return (
                    <AgentRow
                      key={agent.id}
                      agent={agent}
                      sessionStatus={session?.status}
                      messageCount={messageCounts[agent.agentKey] ?? 0}
                      lastActivityBody={lastActivity[agent.agentKey]}
                      onFocus={handleFocus}
                    />
                  );
                })}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
