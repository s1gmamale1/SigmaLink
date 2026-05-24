// C-7 — Sigma Agent Orchestrator Panel.
//
// Task-authoring form that spawns N worktree-isolated agent panes in ONE
// `swarms.create` call, briefs each with a plan capsule, proposes a
// conflict-aware merge order, and executes an ordered batch merge.
//
// RPC-FREE: reuses existing rpc.swarms.create, rpc.panes.brief,
// rpc.git.status, rpc.review.batchCommitAndMerge.

import { useCallback, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { rpc } from '@/renderer/lib/rpc';
import { useAppDispatch, useAppStateSelector } from '@/renderer/app/state';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { Swarm, SwarmAgent } from '@/shared/types';
import { tasksToRoster, taskCapsule, type OrchestratorTask } from '@/shared/orchestrator-tasks';
import { proposeMergeOrder, type PaneChange } from '@/shared/merge-order';

interface TaskRow extends OrchestratorTask {
  id: string; // local stable key
}

function emptyTask(id: string): TaskRow {
  return {
    id,
    title: '',
    prompt: '',
    providerId: 'claude',
    targetFiles: [],
    successCriteria: [],
    outOfScope: [],
  };
}

function parseLines(raw: string): string[] {
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

interface MergeOrderEntry {
  sessionId: string;
  agentKey: string;
  fileCount: number;
  overlapScore: number;
}

type BatchResult = Awaited<ReturnType<typeof rpc.review.batchCommitAndMerge>>;

export function OrchestratorPanel() {
  const dispatch = useAppDispatch();
  const activeWorkspace = useAppStateSelector((s) => s.activeWorkspace);

  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [mission, setMission] = useState('');
  const [launching, setLaunching] = useState(false);
  const [activeSwarm, setActiveSwarm] = useState<Swarm | null>(null);

  // Merge-order state
  const [mergeOrder, setMergeOrder] = useState<MergeOrderEntry[] | null>(null);
  const [proposing, setProposing] = useState(false);
  const [merging, setMerging] = useState(false);
  const [mergeResult, setMergeResult] = useState<BatchResult | null>(null);

  const addTask = useCallback(() => {
    setTasks((prev) => [...prev, emptyTask(crypto.randomUUID())]);
  }, []);

  const removeTask = useCallback((id: string) => {
    setTasks((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const updateTask = useCallback((id: string, patch: Partial<OrchestratorTask>) => {
    setTasks((prev) =>
      prev.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    );
  }, []);

  const launchSwarm = useCallback(async () => {
    if (!activeWorkspace || tasks.length === 0) {
      toast.error('Add at least one task and open a workspace first.');
      return;
    }
    setLaunching(true);
    try {
      const swarm = await rpc.swarms.create({
        workspaceId: activeWorkspace.id,
        mission: mission || tasks.map((t) => t.title || t.prompt).join(', '),
        preset: 'custom',
        roster: tasksToRoster(tasks),
      });

      dispatch({ type: 'UPSERT_SWARM', swarm });
      dispatch({ type: 'SET_ACTIVE_SWARM', id: swarm.id });
      setActiveSwarm(swarm);

      // Brief each spawned agent with its task capsule.
      for (let i = 0; i < swarm.agents.length; i++) {
        const agent = swarm.agents[i] as SwarmAgent & { worktreePath?: string };
        const task = tasks[i];
        if (!agent?.sessionId || !task) continue;
        await rpc.panes.brief({
          sessionId: agent.sessionId,
          worktreePath: agent.worktreePath ?? null,
          capsule: taskCapsule(task),
        }).catch((err: unknown) => {
          toast.error(`Brief failed for ${agent.agentKey}`, {
            description: err instanceof Error ? err.message : String(err),
          });
        });
      }

      toast.success(`Swarm launched: ${swarm.agents.length} agents briefed.`);
      setMergeOrder(null);
      setMergeResult(null);
    } catch (err: unknown) {
      toast.error('Failed to launch swarm', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setLaunching(false);
    }
  }, [activeWorkspace, tasks, mission, dispatch]);

  const proposeMerge = useCallback(async () => {
    if (!activeSwarm) return;
    setProposing(true);
    try {
      const paneChanges: PaneChange[] = [];
      for (const agent of activeSwarm.agents) {
        const a = agent as SwarmAgent & { worktreePath?: string };
        if (!a.worktreePath) continue;
        const status = await rpc.git.status(a.worktreePath).catch(() => null);
        if (!status) continue;
        const changedFiles = [
          ...status.staged,
          ...status.unstaged,
          ...status.untracked,
        ];
        paneChanges.push({ sessionId: a.sessionId ?? a.agentKey, changedFiles });
      }

      const orderedIds = proposeMergeOrder(paneChanges);
      const changeMap = new Map(paneChanges.map((p) => [p.sessionId, p]));

      const entries: MergeOrderEntry[] = orderedIds.map((sessionId) => {
        const change = changeMap.get(sessionId);
        const agent = activeSwarm.agents.find(
          (a) => a.sessionId === sessionId || a.agentKey === sessionId,
        );
        const agentKey = agent?.agentKey ?? sessionId;
        const fileCount = change?.changedFiles.length ?? 0;
        // Overlap score = sum of pairwise intersections (informational).
        let overlapScore = 0;
        if (change) {
          const fileSet = new Set(change.changedFiles);
          for (const other of paneChanges) {
            if (other.sessionId === sessionId) continue;
            for (const f of other.changedFiles) {
              if (fileSet.has(f)) overlapScore++;
            }
          }
        }
        return { sessionId, agentKey, fileCount, overlapScore };
      });

      setMergeOrder(entries);
    } finally {
      setProposing(false);
    }
  }, [activeSwarm]);

  const mergeInOrder = useCallback(async () => {
    if (!mergeOrder || mergeOrder.length === 0) return;
    setMerging(true);
    try {
      const result = await rpc.review.batchCommitAndMerge({
        sessionIds: mergeOrder.map((e) => e.sessionId),
        messageTemplate: 'Merge ${branch}: orchestrated work',
      });
      setMergeResult(result);
      const failed = result.results.filter((r) => !r.ok);
      if (failed.length === 0) {
        toast.success('All panes merged successfully.');
      } else {
        toast.warning(`Merge stopped at ${failed[0]?.sessionId ?? 'unknown'} — resolve conflicts and retry.`);
      }
    } catch (err: unknown) {
      toast.error('Batch merge failed', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setMerging(false);
    }
  }, [mergeOrder]);

  return (
    <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-foreground">
          Sigma Agent — Orchestrator
        </h2>
      </div>

      {/* Mission summary */}
      <div className="flex flex-col gap-1">
        <Label htmlFor="orchestrator-mission" className="text-xs text-muted-foreground">
          Mission summary (optional)
        </Label>
        <Input
          id="orchestrator-mission"
          value={mission}
          onChange={(e) => setMission(e.target.value)}
          placeholder="Describe the overall goal…"
          className="h-8 text-xs"
        />
      </div>

      {/* Task list */}
      <div className="flex flex-col gap-3">
        {tasks.map((task, idx) => (
          <TaskRowEditor
            key={task.id}
            task={task}
            index={idx}
            onChange={(patch) => updateTask(task.id, patch)}
            onRemove={() => removeTask(task.id)}
          />
        ))}

        <Button
          variant="outline"
          size="sm"
          className="w-full gap-1.5 text-xs"
          onClick={addTask}
          aria-label="Add task"
        >
          <Plus className="h-3.5 w-3.5" />
          Add task
        </Button>
      </div>

      {/* Launch */}
      <Button
        size="sm"
        className="w-full text-xs"
        onClick={() => void launchSwarm()}
        disabled={launching || tasks.length === 0 || !activeWorkspace}
        aria-label="Launch swarm"
      >
        {launching ? 'Launching…' : `Launch swarm (${tasks.length} agent${tasks.length === 1 ? '' : 's'})`}
      </Button>

      {/* Merge-order section — shown after a swarm is active */}
      {activeSwarm ? (
        <div className="flex flex-col gap-2 rounded-md border border-border p-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-foreground">Merge Order</span>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={() => void proposeMerge()}
              disabled={proposing}
              aria-label="Propose merge order"
            >
              {proposing ? 'Computing…' : 'Propose merge order'}
            </Button>
          </div>

          {mergeOrder && mergeOrder.length > 0 ? (
            <>
              <ol className="flex flex-col gap-1 text-[11px]">
                {mergeOrder.map((entry, i) => (
                  <li key={entry.sessionId} className="flex items-center gap-2 text-muted-foreground">
                    <span className="w-4 text-right font-mono text-foreground">{i + 1}.</span>
                    <span className="font-medium text-foreground">{entry.agentKey}</span>
                    <span>{entry.fileCount} file{entry.fileCount === 1 ? '' : 's'}</span>
                    {entry.overlapScore > 0 ? (
                      <span className="rounded bg-amber-500/15 px-1 text-[10px] text-amber-600">
                        ±{entry.overlapScore} overlap
                      </span>
                    ) : null}
                  </li>
                ))}
              </ol>

              <Button
                size="sm"
                variant="secondary"
                className="h-7 w-full text-xs"
                onClick={() => void mergeInOrder()}
                disabled={merging}
                aria-label="Merge in order"
              >
                {merging ? 'Merging…' : 'Merge in order'}
              </Button>
            </>
          ) : null}

          {/* Batch merge result */}
          {mergeResult ? (
            <div className="flex flex-col gap-0.5 text-[11px]">
              {mergeResult.results.map((r) => (
                <div
                  key={r.sessionId}
                  className={r.ok ? 'text-green-500' : 'text-red-500'}
                >
                  {r.ok ? 'merged' : 'stopped'}: {r.sessionId}
                  {r.stderr ? ` — ${r.stderr}` : ''}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ─── TaskRowEditor ──────────────────────────────────────────────────────────

interface TaskRowEditorProps {
  task: TaskRow;
  index: number;
  onChange: (patch: Partial<OrchestratorTask>) => void;
  onRemove: () => void;
}

const PROVIDER_OPTIONS = [
  { id: 'claude', label: 'Claude' },
  { id: 'gemini', label: 'Gemini' },
  { id: 'codex', label: 'Codex' },
  { id: 'kimi', label: 'Kimi' },
  { id: 'opencode', label: 'OpenCode' },
];

function TaskRowEditor({ task, index, onChange, onRemove }: TaskRowEditorProps) {
  const labelId = `task-${task.id}`;
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border p-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-muted-foreground">
          Task {index + 1}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={onRemove}
          aria-label={`Remove task ${index + 1}`}
        >
          <Trash2 className="h-3 w-3" />
        </Button>
      </div>

      <div className="flex flex-col gap-1">
        <Label htmlFor={`${labelId}-title`} className="text-xs text-muted-foreground">
          Title
        </Label>
        <Input
          id={`${labelId}-title`}
          value={task.title}
          onChange={(e) => onChange({ title: e.target.value })}
          placeholder="Short task title"
          className="h-7 text-xs"
        />
      </div>

      <div className="flex flex-col gap-1">
        <Label htmlFor={`${labelId}-prompt`} className="text-xs text-muted-foreground">
          Goal / Prompt
        </Label>
        <Textarea
          id={`${labelId}-prompt`}
          value={task.prompt}
          onChange={(e) => onChange({ prompt: e.target.value })}
          placeholder="Describe the agent's goal…"
          className="min-h-[52px] resize-none text-xs"
          aria-label="goal"
        />
      </div>

      <div className="flex flex-col gap-1">
        <Label htmlFor={`${labelId}-provider`} className="text-xs text-muted-foreground">
          Provider
        </Label>
        <select
          id={`${labelId}-provider`}
          value={task.providerId}
          onChange={(e) => onChange({ providerId: e.target.value })}
          className="h-7 rounded-md border border-input bg-background px-2 text-xs text-foreground"
          aria-label="Provider"
        >
          {PROVIDER_OPTIONS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-1">
        <Label htmlFor={`${labelId}-target-files`} className="text-xs text-muted-foreground">
          Target files (one per line)
        </Label>
        <Textarea
          id={`${labelId}-target-files`}
          value={task.targetFiles.join('\n')}
          onChange={(e) => onChange({ targetFiles: parseLines(e.target.value) })}
          placeholder="src/auth.ts&#10;src/db/**"
          className="min-h-[40px] resize-none font-mono text-[10px]"
          aria-label="Target files"
        />
      </div>

      <div className="flex flex-col gap-1">
        <Label htmlFor={`${labelId}-success-criteria`} className="text-xs text-muted-foreground">
          Success criteria (one per line)
        </Label>
        <Textarea
          id={`${labelId}-success-criteria`}
          value={task.successCriteria.join('\n')}
          onChange={(e) => onChange({ successCriteria: parseLines(e.target.value) })}
          placeholder="All tests pass&#10;No lint errors"
          className="min-h-[40px] resize-none font-mono text-[10px]"
          aria-label="Success criteria"
        />
      </div>

      <div className="flex flex-col gap-1">
        <Label htmlFor={`${labelId}-out-of-scope`} className="text-xs text-muted-foreground">
          Out of scope (one per line)
        </Label>
        <Textarea
          id={`${labelId}-out-of-scope`}
          value={task.outOfScope.join('\n')}
          onChange={(e) => onChange({ outOfScope: parseLines(e.target.value) })}
          placeholder="src/billing/**"
          className="min-h-[40px] resize-none font-mono text-[10px]"
          aria-label="Out of scope"
        />
      </div>
    </div>
  );
}
