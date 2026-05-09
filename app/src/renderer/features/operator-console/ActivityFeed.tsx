// V3-W13-006 — Activity-feed sidebar.
//
// Right-side panel (~280px) listing the last N events for the active swarm,
// grouped per agent. Each row shows a time stamp, the originating agent, the
// envelope kind (with the same colour family used elsewhere), and a one-line
// body preview. Group filter chips on the top-bar scope what's visible:
//
//   - all          → every agent
//   - coordinators → coordinator-* events only
//   - builders/scouts/reviewers — analogous
//
// Source data:
//   - The renderer already projects `swarm:message` envelopes into
//     `state.swarmMessages[swarmId]` (state.tsx). We pull the slice for the
//     active swarm and project it into UI rows. Subscribing additionally to
//     `swarm:message` is unnecessary — the global listener already
//     dispatches; we just `useMemo` over the array.

import { useMemo } from 'react';
import { cn } from '@/lib/utils';
import type { Role, SwarmAgent, SwarmMessage } from '@/shared/types';
import type { AgentFilter } from './TopBar';

interface Props {
  agents: SwarmAgent[];
  messages: SwarmMessage[];
  filter: AgentFilter;
  /** Cap the visible history per agent. Defaults to 50 per the V3 brief. */
  maxPerAgent?: number;
}

interface Row {
  message: SwarmMessage;
  agentKey: string;
  role: Role | null;
}

const KIND_BADGE: Record<string, string> = {
  STATUS: 'bg-amber-500/20 text-amber-300',
  DONE: 'bg-violet-500/20 text-violet-300',
  ACK: 'bg-sky-500/20 text-sky-300',
  SAY: 'bg-emerald-500/20 text-emerald-300',
  OPERATOR: 'bg-primary/20 text-primary-foreground',
  ROLLCALL: 'bg-pink-500/20 text-pink-300',
  ROLLCALL_REPLY: 'bg-pink-500/10 text-pink-200',
  SYSTEM: 'bg-muted text-muted-foreground',
  escalation: 'bg-red-500/25 text-red-300',
  review_request: 'bg-blue-500/25 text-blue-300',
  quiet_tick: 'bg-zinc-500/25 text-zinc-300',
  error_report: 'bg-rose-500/25 text-rose-300',
  task_brief: 'bg-indigo-500/25 text-indigo-300',
  board_post: 'bg-teal-500/25 text-teal-300',
  directive: 'bg-orange-500/25 text-orange-300',
  bridge_dispatch: 'bg-fuchsia-500/25 text-fuchsia-300',
  design_dispatch: 'bg-cyan-500/25 text-cyan-300',
  skill_toggle: 'bg-lime-500/25 text-lime-300',
};

const ROLE_DOT: Record<Role, string> = {
  coordinator: 'bg-role-coordinator',
  builder: 'bg-role-builder',
  scout: 'bg-role-scout',
  reviewer: 'bg-role-reviewer',
};

export function ActivityFeed({ agents, messages, filter, maxPerAgent = 50 }: Props) {
  const roleByAgent = useMemo(() => {
    const m = new Map<string, Role>();
    for (const a of agents) m.set(a.agentKey, a.role);
    return m;
  }, [agents]);

  // Group by agent + truncate to last N. We iterate newest-first so the cap
  // discards the oldest messages first, then reverse back into chronological
  // order for display.
  const rowsByAgent = useMemo(() => {
    const buckets = new Map<string, Row[]>();
    // Sorted newest → oldest so we can early-stop the tail.
    const sorted = [...messages].sort((a, b) => b.ts - a.ts);
    for (const m of sorted) {
      // Skip envelope kinds that don't represent agent activity (e.g.
      // operator broadcasts addressed at '*' — show under 'operator').
      const agentKey = activityOwnerOf(m);
      const role = roleByAgent.get(agentKey) ?? null;
      const bucket = buckets.get(agentKey) ?? [];
      if (bucket.length >= maxPerAgent) continue;
      bucket.push({ message: m, agentKey, role });
      buckets.set(agentKey, bucket);
    }
    return buckets;
  }, [messages, roleByAgent, maxPerAgent]);

  // Apply the group-filter at render time so flipping the chip doesn't
  // re-bucket every event.
  const visibleAgentKeys = useMemo(() => {
    const keys: string[] = [];
    for (const a of agents) {
      if (!matchesFilter(filter, a.role)) continue;
      if (!rowsByAgent.has(a.agentKey)) continue;
      keys.push(a.agentKey);
    }
    // Always show the operator bucket last when 'all' is active so the eye
    // lands on agent activity first.
    if (filter === 'all' && rowsByAgent.has('operator')) {
      keys.push('operator');
    }
    return keys;
  }, [agents, filter, rowsByAgent]);

  return (
    <aside className="flex h-full w-[280px] shrink-0 flex-col border-l border-border bg-card/30">
      <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-2">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
          Activity feed
        </span>
        <span className="text-[10px] text-muted-foreground">
          {messages.length} events
        </span>
      </div>
      <div className="flex-1 overflow-y-auto px-2 py-2">
        {visibleAgentKeys.length === 0 ? (
          <div className="flex h-full items-center justify-center text-[11px] text-muted-foreground">
            No activity yet.
          </div>
        ) : (
          visibleAgentKeys.map((agentKey) => {
            const rows = (rowsByAgent.get(agentKey) ?? []).slice().reverse();
            const role = roleByAgent.get(agentKey) ?? null;
            return (
              <section key={agentKey} className="mb-3">
                <header className="flex items-center gap-2 px-1 py-1">
                  {role ? (
                    <span
                      className={cn('h-2 w-2 rounded-full', ROLE_DOT[role])}
                      aria-hidden
                    />
                  ) : null}
                  <span className="text-[11px] font-medium text-foreground">
                    {agentKey}
                  </span>
                  <span className="ml-auto text-[10px] text-muted-foreground">
                    {rows.length}
                  </span>
                </header>
                <ul className="flex flex-col gap-1">
                  {rows.map((r) => (
                    <ActivityRow key={r.message.id} row={r} />
                  ))}
                </ul>
              </section>
            );
          })
        )}
      </div>
    </aside>
  );
}

function ActivityRow({ row }: { row: Row }) {
  const m = row.message;
  const badge = KIND_BADGE[m.kind] ?? KIND_BADGE.SYSTEM;
  const preview = m.body.length > 80 ? `${m.body.slice(0, 77)}…` : m.body;
  return (
    <li className="rounded-md border border-border/50 bg-background/60 px-2 py-1">
      <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
        <span className={cn('rounded px-1 py-0.5 font-medium', badge)}>
          {m.kind}
        </span>
        <span className="ml-auto">{formatTime(m.ts)}</span>
      </div>
      <div className="mt-0.5 text-[11px] text-foreground/90 line-clamp-2">
        {preview || <span className="text-muted-foreground">(no body)</span>}
      </div>
    </li>
  );
}

/**
 * Return the agentKey whose activity this envelope represents. For
 * agent-originated events that's `fromAgent`; for operator → agent DMs we
 * project under the recipient so it shows up in the agent's lane. Broadcasts
 * are bucketed under 'operator'.
 */
function activityOwnerOf(m: SwarmMessage): string {
  if (m.fromAgent === 'operator') {
    if (!m.toAgent || m.toAgent === '*') return 'operator';
    return m.toAgent;
  }
  return m.fromAgent;
}

function matchesFilter(filter: AgentFilter, role: Role): boolean {
  if (filter === 'all') return true;
  if (filter === 'coordinators') return role === 'coordinator';
  if (filter === 'builders') return role === 'builder';
  if (filter === 'scouts') return role === 'scout';
  if (filter === 'reviewers') return role === 'reviewer';
  return true;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}
