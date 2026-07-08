// P1a Task 6 — Missions rail. Mirrors jorvis-assistant/ConversationsPanel.tsx's
// list-of-rows pattern: a fixed-width left aside, click-to-select rows, a
// status dot, and a count badge in the header.
//
// Missions can be GLOBAL (workspace_id null) by design — a global mission
// renders identically to a workspace-scoped one, plus a small "Global" pill,
// so the operator can tell them apart without the list crashing or hiding
// null-workspace rows.

import { ListChecks } from 'lucide-react';
import { cn } from '@/lib/utils';
import { EmptyState } from '@/renderer/components/EmptyState';
import type { Mission, MissionStatus } from '@/shared/types';

interface Props {
  missions: Mission[];
  activeId: string | null;
  onPick: (id: string) => void;
  className?: string;
}

const STATUS_DOT: Record<MissionStatus, string> = {
  draft: 'bg-muted-foreground/40',
  active: 'bg-emerald-500',
  paused: 'bg-amber-500',
  done: 'bg-blue-500',
  failed: 'bg-red-500',
  cancelled: 'bg-muted-foreground/60',
};

export function MissionList({ missions, activeId, onPick, className }: Props) {
  return (
    <aside
      className={cn(
        'flex h-full w-64 shrink-0 flex-col border-r border-border bg-muted/5',
        className,
      )}
      data-testid="mission-list-panel"
    >
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-muted/10 px-3 text-xs uppercase tracking-wide text-muted-foreground">
        <span className="font-semibold">Missions</span>
        <span className="ml-auto rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">
          {missions.length}
        </span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {missions.length === 0 ? (
          <EmptyState
            icon={ListChecks}
            title="No missions yet"
            description="Jorvis creates missions from chat — they'll show up here live."
            className="h-full"
          />
        ) : (
          missions.map((m) => {
            const active = m.id === activeId;
            return (
              <div
                key={m.id}
                role="button"
                tabIndex={0}
                onClick={() => onPick(m.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') onPick(m.id);
                }}
                className={cn(
                  'flex cursor-pointer flex-col gap-1 border-b border-border/40 px-3 py-2 text-xs transition',
                  active ? 'bg-primary/10 text-foreground' : 'text-foreground/90 hover:bg-muted/20',
                )}
                data-active={active ? 'true' : undefined}
              >
                <div className="flex items-start gap-1.5">
                  <span
                    className={cn('mt-1 h-1.5 w-1.5 shrink-0 rounded-full', STATUS_DOT[m.status])}
                    aria-hidden
                  />
                  <span className="line-clamp-2 flex-1 break-words text-[12px] font-medium leading-tight">
                    {m.title}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
                  <span className="truncate capitalize">{m.status}</span>
                  {m.workspaceId === null ? (
                    <span className="shrink-0 rounded-full border border-border/50 px-1.5 py-0.5">
                      Global
                    </span>
                  ) : null}
                </div>
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
}
