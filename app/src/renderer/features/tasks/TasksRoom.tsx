// Kanban board with @dnd-kit/core. Five columns (Backlog / In Progress /
// In Review / Done / Archived) plus a "Swarm Roster" drop zone for the
// active swarm so cards can be assigned via drag.
//
// Drop semantics:
//   - col:<status>   → tasks.setStatus({id, status})
//   - swarm:<agentId>→ tasks.assignToSwarmAgent(...)

import { useMemo, useState } from 'react';
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  useDroppable,
  type DragEndEvent,
} from '@dnd-kit/core';
import { ListChecks, Plus, Users } from 'lucide-react';
import { rpc } from '@/renderer/lib/rpc';
import { useAppState } from '@/renderer/app/state';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { EmptyState } from '@/renderer/components/EmptyState';
import { ErrorBanner } from '@/renderer/components/ErrorBanner';
import type { Task, TaskStatus } from '@/shared/types';
import { Column } from './Column';
import { NewTaskDrawer } from './NewTaskDrawer';
import { TaskDetailDrawer } from './TaskDetailDrawer';

const COLUMN_DEFS: Array<{ id: TaskStatus; label: string; hint: string }> = [
  { id: 'backlog', label: 'Backlog', hint: 'New work waiting to start.' },
  { id: 'in_progress', label: 'In progress', hint: 'Active builds.' },
  { id: 'in_review', label: 'In review', hint: 'Awaiting reviewer.' },
  { id: 'done', label: 'Done', hint: 'Merged + verified.' },
  { id: 'archived', label: 'Archived', hint: 'Set aside, kept for reference.' },
];

const EMPTY_TASKS: never[] = [];

export function TasksRoom() {
  const { state } = useAppState();
  const wsId = state.activeWorkspace?.id ?? '';
  const tasks = state.tasks[wsId] ?? EMPTY_TASKS;
  const [newOpen, setNewOpen] = useState(false);
  const [newColumn, setNewColumn] = useState<TaskStatus>('backlog');
  const [detail, setDetail] = useState<Task | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );

  const byStatus = useMemo(() => {
    const map: Record<TaskStatus, Task[]> = {
      backlog: [],
      in_progress: [],
      in_review: [],
      done: [],
      archived: [],
    };
    for (const t of tasks) map[t.status].push(t);
    return map;
  }, [tasks]);

  const activeSwarm = state.swarms.find((s) => s.id === state.activeSwarmId) ?? null;

  const handleDragEnd = async (event: DragEndEvent) => {
    const overId = String(event.over?.id ?? '');
    const activeId = String(event.active.id ?? '');
    if (!overId.length || !activeId.startsWith('task:')) return;
    const taskId = activeId.slice('task:'.length);

    if (overId.startsWith('col:')) {
      const status = overId.slice('col:'.length) as TaskStatus;
      try {
        await rpc.tasks.setStatus({ id: taskId, status });
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      }
      return;
    }
    if (overId.startsWith('swarm:')) {
      const agentId = overId.slice('swarm:'.length);
      const agent = activeSwarm?.agents.find((a) => a.id === agentId);
      if (!activeSwarm || !agent) return;
      try {
        await rpc.tasks.assignToSwarmAgent({
          taskId,
          swarmId: activeSwarm.id,
          agentKey: agent.agentKey,
          swarmAgentId: agent.id,
        });
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      }
      return;
    }
  };

  if (!state.activeWorkspace) {
    return (
      <EmptyState
        icon={ListChecks}
        title="Open a workspace to use Tasks"
        description="The Kanban board, swarm roster, and task assignment all live per workspace."
      />
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center justify-between border-b border-border bg-muted/20 px-4 py-2">
        <div className="flex items-center gap-2">
          <ListChecks className="h-4 w-4 text-amber-400" />
          <h2 className="text-sm font-semibold">Tasks</h2>
          <span className="ml-2 text-xs text-muted-foreground">
            {tasks.length} card{tasks.length === 1 ? '' : 's'}
          </span>
        </div>
        <Button
          onClick={() => {
            setNewColumn('backlog');
            setNewOpen(true);
          }}
          size="sm"
        >
          <Plus className="mr-1 h-3 w-3" /> New task
        </Button>
      </header>
      {err ? <ErrorBanner message={err} onDismiss={() => setErr(null)} /> : null}
      <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
        <div className="relative flex min-h-0 flex-1">
          <div className="flex min-h-0 flex-1 gap-2 overflow-x-auto p-2">
            {COLUMN_DEFS.map((c) => (
              <div key={c.id} className="flex w-72 shrink-0 flex-col rounded-md border border-border bg-card/30">
                <Column
                  status={c.id}
                  label={c.label}
                  hint={c.hint}
                  tasks={byStatus[c.id]}
                  onCardClick={setDetail}
                  onAdd={() => {
                    setNewColumn(c.id);
                    setNewOpen(true);
                  }}
                />
              </div>
            ))}
          </div>
          <SwarmRosterRail swarm={activeSwarm} />
        </div>
        <NewTaskDrawer
          open={newOpen}
          workspaceId={wsId}
          initialStatus={newColumn}
          onClose={() => setNewOpen(false)}
        />
        <TaskDetailDrawer
          open={detail !== null}
          task={detail}
          onClose={() => setDetail(null)}
        />
      </DndContext>
    </div>
  );
}

function SwarmRosterRail({ swarm }: { swarm: ReturnType<typeof useAppState>['state']['swarms'][number] | null }) {
  if (!swarm) {
    return (
      <aside className="flex w-64 shrink-0 flex-col border-l border-border bg-muted/10 p-3 text-xs">
        <div className="mb-2 flex items-center gap-2 text-muted-foreground">
          <Users className="h-4 w-4" />
          <span>Swarm Roster</span>
        </div>
        <div className="rounded border border-dashed border-border/50 p-3 text-center text-[11px] text-muted-foreground">
          No active swarm. Open Swarm Room to launch one.
        </div>
      </aside>
    );
  }
  return (
    <aside className="flex w-64 shrink-0 flex-col border-l border-border bg-muted/10">
      <div className="border-b border-border px-3 py-2 text-xs">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Users className="h-4 w-4" />
          <span>Drop card → assign</span>
        </div>
        <div className="mt-1 truncate text-foreground" title={swarm.name}>
          {swarm.name}
        </div>
      </div>
      <div className="flex-1 space-y-1 overflow-y-auto p-2">
        {swarm.agents.map((a) => (
          <RosterSlot key={a.id} agentId={a.id} label={a.agentKey} role={a.role} />
        ))}
      </div>
    </aside>
  );
}

function RosterSlot({
  agentId,
  label,
  role,
}: {
  agentId: string;
  label: string;
  role: string;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: `swarm:${agentId}`,
    data: { agentId },
  });
  return (
    <div
      ref={setNodeRef}
      className={cn(
        'flex items-center justify-between rounded border px-2 py-1.5 text-xs transition',
        isOver
          ? 'border-primary bg-primary/10'
          : 'border-border bg-card/40',
      )}
    >
      <span className="truncate font-mono">{label}</span>
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{role}</span>
    </div>
  );
}
