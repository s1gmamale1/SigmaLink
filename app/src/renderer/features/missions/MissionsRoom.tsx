// P1a Task 6 — Missions room root. Read-only display: the operator watches
// Jorvis build the mission board live via chat (P1a ships no manual
// drag/edit UI — that's optional P1b polish, see Task 6 brief). Three
// columns: a mission rail (MissionList), the kanban board for the open
// mission (MissionBoard), and its detail/timeline (MissionDetail).

import { Kanban } from 'lucide-react';
import { cn } from '@/lib/utils';
import { EmptyState } from '@/renderer/components/EmptyState';
import { useMissions } from './use-missions';
import { MissionList } from './MissionList';
import { MissionBoard } from './MissionBoard';
import { MissionDetail } from './MissionDetail';
import { AmendmentsPanel } from './AmendmentsPanel';

interface Props {
  className?: string;
}

export function MissionsRoom({ className }: Props) {
  const { missions, missionId, mission, tasks, events, onPickMission } = useMissions();

  return (
    <div
      className={cn('flex h-full min-h-0 flex-row bg-background', className)}
      data-testid="missions-room"
    >
      <MissionList missions={missions} activeId={missionId} onPick={onPickMission} />
      <div className="flex h-full min-h-0 flex-1 flex-col">
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-muted/10 px-3 text-sm">
          <Kanban className="h-4 w-4 text-primary" aria-hidden />
          <h2 className="text-sm font-semibold tracking-tight">Missions</h2>
          {mission ? (
            <span className="ml-2 truncate text-xs text-muted-foreground">{mission.title}</span>
          ) : null}
        </header>
        <AmendmentsPanel />
        {missionId ? (
          <MissionBoard tasks={tasks} />
        ) : (
          <EmptyState
            icon={Kanban}
            title="Pick a mission"
            description="Select a mission from the list on the left to see its kanban board."
          />
        )}
      </div>
      <MissionDetail mission={mission} tasks={tasks} events={events} />
    </div>
  );
}
