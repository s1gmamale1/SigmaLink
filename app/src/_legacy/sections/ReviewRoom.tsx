import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useWorkspace } from '@/hooks/useWorkspace';
import { cn, formatDuration } from '@/lib/utils';
import type { OrchestratorTask, SubTask, TerminalSession } from '@/types';
import {
  AlertCircle, ArrowRight, CheckCircle, ChevronDown, ChevronUp, Circle,
  ClipboardCheck, Clock, FileCode, GitBranch, GitMerge, Loader2,
  TestTube, XCircle, Eye, RefreshCw, Terminal as TerminalIcon
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Input } from '@/components/ui/input';

export function ReviewRoom() {
  const { state } = useWorkspace();
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(state.activeTaskId);

  useEffect(() => {
    if (!selectedTaskId && state.activeTaskId) setSelectedTaskId(state.activeTaskId);
  }, [selectedTaskId, state.activeTaskId]);

  const completedTasks = state.tasks.filter(t => t.status === 'completed');
  const failedTasks = state.tasks.filter(t => t.status === 'failed');
  const activeTasks = state.tasks.filter(t => t.status === 'executing' || t.status === 'planning');

  return (
    <div className="flex h-full">
      <div className="w-1/3 border-r border-white/10 flex flex-col">
        <div className="px-6 py-4 border-b border-white/10">
          <h2 className="text-lg font-semibold text-white flex items-center gap-2">
            <ClipboardCheck className="w-5 h-5 text-amber-400" />
            Review
          </h2>
          <div className="flex gap-3 mt-3">
            <StatusCount label="Active" count={activeTasks.length} color="text-purple-400" />
            <StatusCount label="Completed" count={completedTasks.length} color="text-green-400" />
            <StatusCount label="Failed" count={failedTasks.length} color="text-red-400" />
          </div>
        </div>

        <ScrollArea className="flex-1">
          <div className="p-4 space-y-2">
            {state.tasks.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-gray-600">
                <ClipboardCheck className="w-12 h-12 mb-4" />
                <p className="text-sm">No tasks to review</p>
              </div>
            ) : (
              state.tasks.map(task => {
                const isSelected = selectedTaskId === task.id;
                const completed = task.subtasks.filter(st => st.status === 'completed').length;
                const total = task.subtasks.length;
                return (
                  <button
                    key={task.id}
                    onClick={() => setSelectedTaskId(task.id)}
                    className={cn(
                      'w-full p-3 rounded-lg border text-left transition-all',
                      isSelected ? 'bg-white/10 border-purple-500/30' : 'bg-white/5 border-white/5 hover:border-white/10'
                    )}
                  >
                    <div className="flex items-start justify-between">
                      <h3 className="text-sm font-medium text-gray-200 truncate pr-2">{task.title}</h3>
                      <TaskStatusIcon status={task.status} />
                    </div>
                    <div className="flex items-center gap-2 mt-2">
                      <div className="flex-1 h-1.5 bg-white/5 rounded-full overflow-hidden">
                        <div
                          className={cn('h-full transition-all duration-500', task.status === 'completed' ? 'bg-green-500' : task.status === 'failed' ? 'bg-red-500' : 'bg-purple-500')}
                          style={{ width: `${total > 0 ? (completed / total) * 100 : 0}%` }}
                        />
                      </div>
                      <span className="text-[10px] text-gray-500">{completed}/{total}</span>
                    </div>
                    {task.completedAt && (
                      <p className="text-[10px] text-gray-600 mt-1">Duration: {formatDuration(task.completedAt - task.createdAt)}</p>
                    )}
                  </button>
                );
              })
            )}
          </div>
        </ScrollArea>
      </div>

      <div className="flex-1 flex flex-col">
        {selectedTaskId ? (
          <TaskReviewDetail taskId={selectedTaskId} />
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-gray-600">
            <Eye className="w-16 h-16 mb-4" />
            <p className="text-lg font-medium text-gray-500">Select a task to review</p>
            <p className="text-sm text-gray-600 mt-1">Inspect live worktrees, run commands, approve or reject</p>
          </div>
        )}
      </div>
    </div>
  );
}

function TaskReviewDetail({ taskId }: { taskId: string }) {
  const { state } = useWorkspace();
  const task = state.tasks.find(t => t.id === taskId);
  const [viewMode, setViewMode] = useState<'overview' | 'diff' | 'tests'>('overview');
  const [mergeOutput, setMergeOutput] = useState('');
  const [isMerging, setIsMerging] = useState(false);

  if (!task) return null;

  const completedSubtasks = task.subtasks.filter(st => st.status === 'completed');
  const failedSubtasks = task.subtasks.filter(st => st.status === 'failed');
  const inProgressSubtasks = task.subtasks.filter(st => st.status === 'in_progress' || st.status === 'verifying');

  const mergeable = completedSubtasks
    .map(subtask => ({ subtask, terminal: state.terminals.find(t => t.id === subtask.terminalId) }))
    .filter((item): item is { subtask: SubTask; terminal: TerminalSession } => Boolean(item.terminal?.gitEnabled && item.terminal.repoRoot));

  const handleCommitAndMerge = async () => {
    if (!window.electron || mergeable.length === 0) return;
    setIsMerging(true);
    setMergeOutput('');
    const outputs: string[] = [];
    for (const { subtask, terminal } of mergeable) {
      const result = await window.electron.gitCommitAndMerge({
        repoRoot: terminal.repoRoot!,
        worktreePath: terminal.worktreePath,
        branchName: terminal.branchName,
        message: `SigmaLink: ${subtask.title}`,
      });
      outputs.push(`$ ${terminal.branchName}\n${result.success ? result.output || 'Merged.' : result.error || 'Merge failed.'}`);
      if (!result.success) break;
    }
    setMergeOutput(outputs.join('\n\n'));
    setIsMerging(false);
  };

  return (
    <>
      <div className="px-6 py-4 border-b border-white/10">
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-3">
              <h2 className="text-xl font-semibold text-white">{task.title}</h2>
              <TaskStatusBadge status={task.status} />
            </div>
            <p className="text-sm text-gray-500 mt-1">{task.description}</p>
          </div>
          <div className="flex gap-2">
            <ModeButton active={viewMode === 'overview'} onClick={() => setViewMode('overview')}>Overview</ModeButton>
            <ModeButton active={viewMode === 'diff'} onClick={() => setViewMode('diff')} icon={<GitBranch className="w-3 h-3 mr-1" />}>Diff</ModeButton>
            <ModeButton active={viewMode === 'tests'} onClick={() => setViewMode('tests')} icon={<TestTube className="w-3 h-3 mr-1" />}>Tests</ModeButton>
          </div>
        </div>

        <div className="flex gap-6 mt-4">
          <div className="flex items-center gap-2"><CheckCircle className="w-4 h-4 text-green-400" /><span className="text-xs text-gray-400">{completedSubtasks.length} Passed</span></div>
          <div className="flex items-center gap-2"><XCircle className="w-4 h-4 text-red-400" /><span className="text-xs text-gray-400">{failedSubtasks.length} Failed</span></div>
          <div className="flex items-center gap-2"><Loader2 className="w-4 h-4 text-purple-400" /><span className="text-xs text-gray-400">{inProgressSubtasks.length} Running</span></div>
          {task.completedAt && <div className="flex items-center gap-2"><Clock className="w-4 h-4 text-gray-500" /><span className="text-xs text-gray-400">{formatDuration(task.completedAt - task.createdAt)}</span></div>}
        </div>
      </div>

      <ScrollArea className="flex-1 p-6">
        {viewMode === 'overview' && (
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-gray-300 mb-3">Subtask Results</h3>
            {task.subtasks.map(subtask => <SubtaskReviewCard key={subtask.id} taskId={task.id} subtask={subtask} />)}
          </div>
        )}
        {viewMode === 'diff' && <DiffView task={task} />}
        {viewMode === 'tests' && <TestResults task={task} />}
      </ScrollArea>

      <div className="px-6 py-4 border-t border-white/10 bg-[#0f1117] flex items-center justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <GitBranch className="w-4 h-4 text-gray-500" />
            <span className="text-xs text-gray-500 font-mono truncate">
              {mergeable.length > 0 ? `${mergeable.length} mergeable worktree(s)` : 'Mark subtasks passed to enable commit & merge'}
            </span>
          </div>
          {mergeOutput && <pre className="mt-2 max-h-20 overflow-auto text-[10px] text-gray-400 whitespace-pre-wrap">{mergeOutput}</pre>}
        </div>
        <Button
          className="bg-green-600 hover:bg-green-700 text-white"
          size="sm"
          disabled={mergeable.length === 0 || isMerging}
          onClick={() => void handleCommitAndMerge()}
        >
          {isMerging ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <GitMerge className="w-4 h-4 mr-1" />}
          Commit & Merge
        </Button>
      </div>
    </>
  );
}

function ModeButton({ active, onClick, children, icon }: { active: boolean; onClick: () => void; children: ReactNode; icon?: ReactNode }) {
  return (
    <Button
      variant="outline"
      size="sm"
      className={cn('border-white/10 text-xs', active ? 'bg-white/10 text-white' : 'text-gray-400 hover:text-white')}
      onClick={onClick}
    >
      {icon}{children}
    </Button>
  );
}

function SubtaskReviewCard({ taskId, subtask }: { taskId: string; subtask: SubTask }) {
  const { state, dispatch, setRoom } = useWorkspace();
  const provider = state.providers.find(p => p.id === subtask.assignedProvider);
  const terminal = state.terminals.find(t => t.id === subtask.terminalId);
  const [expanded, setExpanded] = useState(false);

  const mark = (passed: boolean) => {
    dispatch({
      type: 'UPDATE_SUBTASK',
      taskId,
      subtaskId: subtask.id,
      updates: {
        status: passed ? 'completed' : 'failed',
        completedAt: Date.now(),
        verificationResult: {
          passed,
          feedback: passed ? 'Marked passed by reviewer.' : 'Marked failed by reviewer.',
          checkedAt: Date.now(),
        },
      },
    });
  };

  return (
    <div className={cn('rounded-lg border transition-all', subtask.status === 'completed' ? 'bg-green-500/5 border-green-500/20' : subtask.status === 'failed' ? 'bg-red-500/5 border-red-500/20' : subtask.status === 'in_progress' ? 'bg-purple-500/5 border-purple-500/20' : 'bg-white/5 border-white/10')}>
      <button className="w-full flex items-center gap-3 px-4 py-3" onClick={() => setExpanded(!expanded)}>
        <SubtaskStatusIcon status={subtask.status} />
        <div className="flex-1 text-left min-w-0">
          <span className="text-sm text-gray-200 truncate block">{subtask.title}</span>
          {terminal && <span className="text-[10px] text-gray-600 font-mono truncate block">{terminal.branchName}</span>}
        </div>
        <Badge variant="outline" className="text-[9px] border-white/10" style={{ color: provider?.color || '#999' }}>{provider?.name || subtask.assignedProvider}</Badge>
        {expanded ? <ChevronUp className="w-4 h-4 text-gray-600" /> : <ChevronDown className="w-4 h-4 text-gray-600" />}
      </button>

      {expanded && (
        <div className="px-4 pb-4 space-y-3">
          <p className="text-xs text-gray-500">{subtask.description}</p>
          <div className="flex items-center gap-2"><ArrowRight className="w-3 h-3 text-purple-400" /><span className="text-xs text-purple-300">{subtask.intent}</span></div>
          {terminal ? (
            <div className="rounded-lg bg-black/20 border border-white/5 p-3 text-xs text-gray-500 space-y-1">
              <p><span className="text-gray-400">Worktree:</span> <span className="font-mono">{terminal.worktreePath}</span></p>
              <p><span className="text-gray-400">Git:</span> {terminal.gitEnabled ? 'enabled' : 'disabled/direct folder'}</p>
            </div>
          ) : (
            <div className="rounded-lg bg-amber-500/10 border border-amber-500/20 p-3 text-xs text-amber-300">No terminal linked yet. Run the orchestrator first.</div>
          )}

          {subtask.verificationResult && (
            <div className={cn('p-3 rounded-lg text-xs space-y-1', subtask.verificationResult.passed ? 'bg-green-500/10 border border-green-500/20' : 'bg-red-500/10 border border-red-500/20')}>
              <div className="flex items-center gap-2">
                {subtask.verificationResult.passed ? <CheckCircle className="w-3 h-3 text-green-400" /> : <AlertCircle className="w-3 h-3 text-red-400" />}
                <span className={subtask.verificationResult.passed ? 'text-green-400' : 'text-red-400'}>{subtask.verificationResult.passed ? 'Verification Passed' : 'Verification Failed'}</span>
              </div>
              <p className="text-gray-400 ml-5">{subtask.verificationResult.feedback}</p>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            {terminal && (
              <Button size="sm" variant="outline" className="border-white/10 text-gray-300 hover:text-white" onClick={() => { dispatch({ type: 'SET_ACTIVE_TERMINAL', id: terminal.id }); setRoom('command'); }}>
                <TerminalIcon className="w-3 h-3 mr-1" /> Open Terminal
              </Button>
            )}
            <Button size="sm" className="bg-green-600 hover:bg-green-700 text-white" onClick={() => mark(true)}>
              <CheckCircle className="w-3 h-3 mr-1" /> Mark Passed
            </Button>
            <Button size="sm" className="bg-red-600 hover:bg-red-700 text-white" onClick={() => mark(false)}>
              <XCircle className="w-3 h-3 mr-1" /> Mark Failed
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function DiffView({ task }: { task: OrchestratorTask }) {
  const { state } = useWorkspace();
  const pairs = task.subtasks.map(subtask => ({ subtask, terminal: state.terminals.find(t => t.id === subtask.terminalId) }));

  return (
    <div className="space-y-4">
      {pairs.length === 0 ? <EmptyNote text="No linked terminals yet. Run the orchestrator first." /> : pairs.map(({ subtask, terminal }) => (
        <WorktreeDiff key={subtask.id} subtask={subtask} terminal={terminal} />
      ))}
    </div>
  );
}

function WorktreeDiff({ subtask, terminal }: { subtask: SubTask; terminal?: TerminalSession }) {
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('');
  const [stat, setStat] = useState('');
  const [diff, setDiff] = useState('');
  const [untracked, setUntracked] = useState('');
  const [error, setError] = useState('');

  const refresh = async () => {
    if (!window.electron || !terminal) return;
    setLoading(true);
    setError('');
    const [statusResult, diffResult] = await Promise.all([
      window.electron.gitStatus({ cwd: terminal.worktreePath }),
      window.electron.gitDiff({ cwd: terminal.worktreePath }),
    ]);
    if (statusResult.success) setStatus(statusResult.output || 'Clean worktree.');
    else setError(statusResult.error || 'Failed to read git status.');
    if (diffResult.success) {
      setStat(diffResult.stat || 'No tracked diff.');
      setDiff(diffResult.diff || 'No tracked file changes.');
      setUntracked(diffResult.untracked || '');
    } else setError(diffResult.error || 'Failed to read git diff.');
    setLoading(false);
  };

  useEffect(() => { void refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [terminal?.id]);

  if (!terminal) return <EmptyNote text={`No worktree linked for ${subtask.title}.`} />;

  return (
    <div className="rounded-lg overflow-hidden border border-white/10">
      <div className="flex items-center gap-2 px-4 py-2 bg-[#0f1117] border-b border-white/5">
        <FileCode className="w-4 h-4 text-gray-500" />
        <span className="text-xs text-gray-400 font-mono truncate">{terminal.branchName}</span>
        <Button size="sm" variant="ghost" className="ml-auto h-7 text-gray-400 hover:text-white" onClick={() => void refresh()} disabled={loading}>
          {loading ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <RefreshCw className="w-3 h-3 mr-1" />} Refresh
        </Button>
      </div>
      <div className="bg-[#0d0f17] p-4 space-y-4">
        {error && <pre className="text-xs text-red-300 whitespace-pre-wrap">{error}</pre>}
        <Block title="Status" text={status} />
        <Block title="Stat" text={stat} />
        {untracked && <Block title="Untracked files" text={untracked} />}
        <Block title="Diff" text={diff} tall />
      </div>
    </div>
  );
}

function TestResults({ task }: { task: OrchestratorTask }) {
  const { state } = useWorkspace();
  const [command, setCommand] = useState('npm test');
  const [running, setRunning] = useState(false);
  const [outputs, setOutputs] = useState<Record<string, string>>({});
  const terminals = useMemo(() => task.subtasks.map(subtask => state.terminals.find(t => t.id === subtask.terminalId)).filter(Boolean) as TerminalSession[], [state.terminals, task.subtasks]);

  const run = async () => {
    if (!window.electron || terminals.length === 0) return;
    setRunning(true);
    const next: Record<string, string> = {};
    for (const terminal of terminals) {
      const result = await window.electron.runCommand({ cwd: terminal.worktreePath, commandLine: command, timeoutMs: 180000 });
      next[terminal.id] = [
        `$ ${command}`,
        result.stdout || '',
        result.stderr || '',
        result.success ? `\n[exit ${result.code ?? 0}]` : `\n[failed] ${result.error || `exit ${result.code}`}`,
      ].filter(Boolean).join('\n');
      setOutputs({ ...next });
    }
    setRunning(false);
  };

  return (
    <div className="space-y-4">
      <div className="p-4 rounded-lg bg-white/5 border border-white/10 flex items-center gap-3">
        <Input value={command} onChange={event => setCommand(event.target.value)} className="bg-black/20 border-white/10 text-white font-mono" placeholder="npm test, npm run build, pytest..." />
        <Button onClick={() => void run()} disabled={running || terminals.length === 0} className="bg-purple-600 hover:bg-purple-700 text-white">
          {running ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <TestTube className="w-4 h-4 mr-1" />}
          Run
        </Button>
      </div>
      {terminals.length === 0 && <EmptyNote text="No linked worktrees. Run the orchestrator first." />}
      {terminals.map(terminal => (
        <div key={terminal.id} className="rounded-lg overflow-hidden border border-white/10">
          <div className="px-4 py-2 bg-[#0f1117] border-b border-white/5 text-xs text-gray-400 font-mono">{terminal.branchName}</div>
          <pre className="bg-[#0d0f17] p-4 text-xs text-gray-300 whitespace-pre-wrap max-h-96 overflow-auto">{outputs[terminal.id] || 'No command run yet.'}</pre>
        </div>
      ))}
    </div>
  );
}

function Block({ title, text, tall }: { title: string; text: string; tall?: boolean }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider text-gray-600 mb-2">{title}</p>
      <pre className={cn('font-mono text-xs text-gray-300 whitespace-pre-wrap overflow-auto rounded-lg bg-black/20 border border-white/5 p-3', tall ? 'max-h-[460px]' : 'max-h-40')}>{text || '—'}</pre>
    </div>
  );
}

function EmptyNote({ text }: { text: string }) {
  return <div className="rounded-lg bg-white/5 border border-white/10 p-4 text-sm text-gray-500">{text}</div>;
}

function StatusCount({ label, count, color }: { label: string; count: number; color: string }) {
  return <div className="text-center"><p className={cn('text-lg font-bold', color)}>{count}</p><p className="text-[10px] text-gray-500">{label}</p></div>;
}

function TaskStatusIcon({ status }: { status: string }) {
  switch (status) {
    case 'completed': return <CheckCircle className="w-5 h-5 text-green-400" />;
    case 'failed': return <AlertCircle className="w-5 h-5 text-red-400" />;
    case 'executing': return <Loader2 className="w-5 h-5 text-purple-400 animate-spin" />;
    case 'planning': return <Clock className="w-5 h-5 text-blue-400" />;
    default: return <Circle className="w-5 h-5 text-gray-600" />;
  }
}

function TaskStatusBadge({ status }: { status: string }) {
  const configs: Record<string, string> = {
    completed: 'bg-green-500/10 text-green-400 border-green-500/20',
    failed: 'bg-red-500/10 text-red-400 border-red-500/20',
    executing: 'bg-purple-500/10 text-purple-400 border-purple-500/20',
    planning: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
    verifying: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  };
  return <Badge variant="outline" className={cn('text-[10px] border', configs[status] || configs.planning)}>{status}</Badge>;
}

function SubtaskStatusIcon({ status }: { status: string }) {
  switch (status) {
    case 'completed': return <CheckCircle className="w-4 h-4 text-green-400 flex-shrink-0" />;
    case 'failed': return <XCircle className="w-4 h-4 text-red-400 flex-shrink-0" />;
    case 'in_progress': return <Loader2 className="w-4 h-4 text-purple-400 animate-spin flex-shrink-0" />;
    case 'verifying': return <Clock className="w-4 h-4 text-amber-400 flex-shrink-0" />;
    default: return <Circle className="w-4 h-4 text-gray-600 flex-shrink-0" />;
  }
}
