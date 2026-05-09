// V3-W12-013 — Operator Console top bar.
//
// Three tabs (TERMINALS · CHAT · ACTIVITY) with unread-count badges driven
// by the `swarm:counters` event; a STOP ALL red pill that opens an
// AlertDialog with a `reason` field; group filter chips
// (All Agents · COORDINATORS · BUILDERS · REVIEWERS · SCOUTS) that scope
// downstream surfaces; and an inline mission-rename affordance.
//
// Counters payload: `{ swarmId, escalations, review, quiet, errors }`.

import { useState } from 'react';
import { ChevronDown, Pencil, StopCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { cn } from '@/lib/utils';

export type ConsoleTab = 'terminals' | 'chat' | 'activity' | 'replays';
export type AgentFilter = 'all' | 'coordinators' | 'builders' | 'scouts' | 'reviewers';

export interface CountersPayload {
  swarmId: string;
  escalations: number;
  review: number;
  quiet: number;
  errors: number;
}

interface Props {
  swarmId: string;
  swarmName: string;
  mission: string;
  tab: ConsoleTab;
  onTabChange: (tab: ConsoleTab) => void;
  filter: AgentFilter;
  onFilterChange: (filter: AgentFilter) => void;
  counters: CountersPayload | null;
  onMissionRename: (next: string) => Promise<void> | void;
  onStopAll: (reason: string) => Promise<void> | void;
}

const TABS: { id: ConsoleTab; label: string }[] = [
  { id: 'terminals', label: 'Terminals' },
  { id: 'chat', label: 'Chat' },
  { id: 'activity', label: 'Activity' },
  // P3-S6 — Persistent Swarm Replay. Differentiator over V3, where swarms
  // vanish when the window closes. Scrub past sessions frame-by-frame.
  { id: 'replays', label: 'Replays' },
];

const FILTERS: { id: AgentFilter; label: string }[] = [
  { id: 'all', label: 'All Agents' },
  { id: 'coordinators', label: 'Coordinators' },
  { id: 'builders', label: 'Builders' },
  { id: 'reviewers', label: 'Reviewers' },
  { id: 'scouts', label: 'Scouts' },
];

const FILTER_COLOR: Record<AgentFilter, string> = {
  all: 'border-border',
  coordinators: 'border-role-coordinator',
  builders: 'border-role-builder',
  reviewers: 'border-role-reviewer',
  scouts: 'border-role-scout',
};

export function TopBar({
  swarmName,
  mission,
  tab,
  onTabChange,
  filter,
  onFilterChange,
  counters,
  onMissionRename,
  onStopAll,
}: Props) {
  const [editingMission, setEditingMission] = useState(false);
  const [draftMission, setDraftMission] = useState(mission);
  const [confirmStop, setConfirmStop] = useState(false);
  const [stopReason, setStopReason] = useState('');

  function unreadFor(t: ConsoleTab): number {
    if (!counters) return 0;
    if (t === 'chat') return counters.escalations + counters.review;
    if (t === 'activity') return counters.errors + counters.quiet;
    return 0;
  }

  async function commitMission(): Promise<void> {
    const next = draftMission.trim();
    if (!next || next === mission) {
      setEditingMission(false);
      return;
    }
    await onMissionRename(next);
    setEditingMission(false);
  }

  async function commitStopAll(): Promise<void> {
    await onStopAll(stopReason.trim() || 'operator stop-all');
    setConfirmStop(false);
    setStopReason('');
  }

  return (
    <div className="flex shrink-0 flex-col gap-2 border-b border-border bg-background/80 px-3 py-2">
      <div className="flex items-center gap-2">
        {/* Swarm name + inline mission rename. */}
        <div className="flex min-w-0 flex-col">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Operator Console — {swarmName}
          </div>
          <div className="flex items-center gap-1">
            {editingMission ? (
              <input
                autoFocus
                value={draftMission}
                onChange={(e) => setDraftMission(e.target.value)}
                onBlur={commitMission}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void commitMission();
                  if (e.key === 'Escape') {
                    setDraftMission(mission);
                    setEditingMission(false);
                  }
                }}
                className="w-[28rem] max-w-full rounded-md border border-border bg-background px-2 py-0.5 text-sm"
              />
            ) : (
              <button
                type="button"
                className="flex items-center gap-1 rounded-md text-sm hover:bg-card/40"
                onClick={() => {
                  setDraftMission(mission);
                  setEditingMission(true);
                }}
                title="Rename mission"
              >
                <span className="line-clamp-1 max-w-[28rem]">{mission}</span>
                <Pencil className="h-3 w-3 opacity-50" />
              </button>
            )}
          </div>
        </div>

        <div className="ml-auto flex items-center gap-2">
          {/* STOP ALL red pill. */}
          <Button
            variant="destructive"
            size="sm"
            onClick={() => setConfirmStop(true)}
            className="gap-1"
          >
            <StopCircle className="h-3.5 w-3.5" />
            STOP ALL
          </Button>
        </div>
      </div>

      {/* Tab strip + filter strip. */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 rounded-md border border-border bg-card/40 p-1">
          {TABS.map((t) => {
            const active = tab === t.id;
            const unread = unreadFor(t.id);
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => onTabChange(t.id)}
                className={cn(
                  'flex items-center gap-1 rounded px-2 py-1 text-[11px] uppercase tracking-wider transition',
                  active ? 'bg-primary/20 text-primary-foreground' : 'text-muted-foreground hover:bg-card',
                )}
              >
                {t.label}
                {unread > 0 ? (
                  <span className="ml-1 rounded-full bg-destructive px-1.5 py-0.5 text-[9px] font-medium text-destructive-foreground">
                    {unread}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center gap-1">
          {FILTERS.map((f) => {
            const active = filter === f.id;
            return (
              <button
                key={f.id}
                type="button"
                onClick={() => onFilterChange(f.id)}
                className={cn(
                  'rounded-md border px-2 py-1 text-[10px] uppercase tracking-wider transition',
                  FILTER_COLOR[f.id],
                  active
                    ? 'bg-primary/15 text-primary-foreground'
                    : 'bg-background text-muted-foreground hover:bg-card',
                )}
              >
                {f.label}
              </button>
            );
          })}
          <ChevronDown
            className="ml-1 h-3 w-3 text-muted-foreground"
            aria-hidden
          />
        </div>

        {counters ? (
          <div className="ml-auto flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground">
            <span title="Escalations">
              ESC <span className="text-foreground">{counters.escalations}</span>
            </span>
            <span title="Review requests">
              REV <span className="text-foreground">{counters.review}</span>
            </span>
            <span title="Quiet ticks">
              QUIET <span className="text-foreground">{counters.quiet}</span>
            </span>
            <span title="Errors">
              ERR <span className="text-foreground">{counters.errors}</span>
            </span>
          </div>
        ) : null}
      </div>

      <AlertDialog open={confirmStop} onOpenChange={setConfirmStop}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop every agent in this swarm?</AlertDialogTitle>
            <AlertDialogDescription>
              This kills every PTY in the swarm and marks the swarm completed. Optional
              reason is stored alongside the stop event for forensic value.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <textarea
            value={stopReason}
            onChange={(e) => setStopReason(e.target.value)}
            placeholder="Optional reason — visible in the activity feed."
            rows={3}
            className="w-full resize-none rounded-md border border-border bg-background px-2 py-1 text-sm"
          />
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void commitStopAll();
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Stop all
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
