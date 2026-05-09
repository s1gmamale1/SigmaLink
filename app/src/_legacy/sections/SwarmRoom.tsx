import { useState } from 'react';
import { useWorkspace } from '@/hooks/useWorkspace';
import { cn } from '@/lib/utils';
import {
  Bot, Play, Plus, Trash2, Sparkles, ArrowRight,
  ChevronDown, ChevronUp, MessageSquare, CheckCircle, AlertCircle,
  Clock, Zap, GitBranch, Loader2, Circle
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
// SubTask type used via inference

interface SubTaskForm {
  title: string;
  description: string;
  assignedProvider: string;
  intent: string;
}

export function SwarmRoom() {
  const { state, createTask, runOrchestrator, dispatch } = useWorkspace();
  const [taskTitle, setTaskTitle] = useState('');
  const [taskDescription, setTaskDescription] = useState('');
  const [subtasks, setSubtasks] = useState<SubTaskForm[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const addSubtask = () => {
    setSubtasks(prev => [...prev, {
      title: '',
      description: '',
      assignedProvider: state.providers[0]?.id || 'claude',
      intent: '',
    }]);
  };

  const updateSubtask = (index: number, field: keyof SubTaskForm, value: string) => {
    setSubtasks(prev => prev.map((st, i) => i === index ? { ...st, [field]: value } : st));
  };

  const removeSubtask = (index: number) => {
    setSubtasks(prev => prev.filter((_, i) => i !== index));
  };

  const handleCreateTask = () => {
    if (!taskTitle.trim() || subtasks.length === 0) return;

    createTask(
      taskTitle,
      taskDescription,
      subtasks.map(st => ({
        title: st.title,
        description: st.description,
        assignedProvider: st.assignedProvider,
        intent: st.intent,
        inputs: [st.description],
        constraints: [],
        successCriteria: 'Code compiles and tests pass',
      }))
    );

    setTaskTitle('');
    setTaskDescription('');
    setSubtasks([]);
    setShowForm(false);
  };

  const toggleCollapsed = (id: string) => {
    setCollapsed(prev => ({ ...prev, [id]: !prev[id] }));
  };

  return (
    <div className="flex h-full">
      {/* Left Panel - Task Creation */}
      <div className="w-1/2 flex flex-col border-r border-white/10">
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
          <div>
            <h2 className="text-lg font-semibold text-white flex items-center gap-2">
              <Sparkles className="w-5 h-5 text-purple-400" />
              Orchestrator
            </h2>
            <p className="text-xs text-gray-500 mt-1">Delegate tasks to multiple AI agents in parallel</p>
          </div>
          <Button
            onClick={() => setShowForm(!showForm)}
            className="bg-purple-600 hover:bg-purple-700 text-white"
            size="sm"
          >
            <Plus className="w-4 h-4 mr-1" />
            New Task
          </Button>
        </div>

        <ScrollArea className="flex-1">
          {showForm ? (
            <div className="p-6 space-y-4">
              <div>
                <label className="text-xs font-medium text-gray-400 mb-1.5 block">Task Title</label>
                <Input
                  value={taskTitle}
                  onChange={e => setTaskTitle(e.target.value)}
                  placeholder="e.g., Implement user authentication system"
                  className="bg-white/5 border-white/10 text-white placeholder:text-gray-600"
                />
              </div>

              <div>
                <label className="text-xs font-medium text-gray-400 mb-1.5 block">Description</label>
                <Textarea
                  value={taskDescription}
                  onChange={e => setTaskDescription(e.target.value)}
                  placeholder="Describe the overall goal..."
                  className="bg-white/5 border-white/10 text-white placeholder:text-gray-600 min-h-[80px]"
                />
              </div>

              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium text-gray-300">Subtasks ({subtasks.length})</h3>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={addSubtask}
                  className="border-white/10 text-gray-300 hover:text-white hover:bg-white/5"
                >
                  <Plus className="w-3 h-3 mr-1" />
                  Add Subtask
                </Button>
              </div>

              {subtasks.map((st, i) => (
                <div key={i} className="p-4 rounded-lg bg-white/5 border border-white/10 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-purple-400">Subtask {i + 1}</span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 text-gray-500 hover:text-red-400"
                      onClick={() => removeSubtask(i)}
                    >
                      <Trash2 className="w-3 h-3" />
                    </Button>
                  </div>
                  <Input
                    value={st.title}
                    onChange={e => updateSubtask(i, 'title', e.target.value)}
                    placeholder="Subtask title"
                    className="bg-white/5 border-white/10 text-white text-sm placeholder:text-gray-600"
                  />
                  <Textarea
                    value={st.description}
                    onChange={e => updateSubtask(i, 'description', e.target.value)}
                    placeholder="What should this agent do?"
                    className="bg-white/5 border-white/10 text-white text-sm placeholder:text-gray-600 min-h-[60px]"
                  />
                  <div className="flex gap-2">
                    <select
                      value={st.assignedProvider}
                      onChange={e => updateSubtask(i, 'assignedProvider', e.target.value)}
                      className="flex-1 bg-white/5 border border-white/10 text-white text-sm rounded-md px-3 py-2 outline-none focus:border-purple-500/50"
                    >
                      {state.providers.map(p => (
                        <option key={p.id} value={p.id} className="bg-[#1a1d2a]">{p.name}</option>
                      ))}
                    </select>
                  </div>
                  <Input
                    value={st.intent}
                    onChange={e => updateSubtask(i, 'intent', e.target.value)}
                    placeholder="Intent: e.g., Create login form with validation"
                    className="bg-white/5 border-white/10 text-white text-sm placeholder:text-gray-600"
                  />
                </div>
              ))}

              <div className="flex gap-3 pt-2">
                <Button
                  onClick={handleCreateTask}
                  disabled={!taskTitle.trim() || subtasks.length === 0}
                  className="flex-1 bg-purple-600 hover:bg-purple-700 text-white"
                >
                  <Zap className="w-4 h-4 mr-1" />
                  Create Task
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setShowForm(false)}
                  className="border-white/10 text-gray-300 hover:text-white hover:bg-white/5"
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className="p-6 space-y-4">
              {state.tasks.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-gray-600">
                  <Sparkles className="w-12 h-12 mb-4" />
                  <p className="text-sm">No tasks created yet</p>
                  <p className="text-xs mt-1">Click "New Task" to start orchestrating</p>
                </div>
              ) : (
                state.tasks.map(task => (
                  <div
                    key={task.id}
                    className={cn(
                      'p-4 rounded-lg border transition-all cursor-pointer',
                      state.activeTaskId === task.id
                        ? 'bg-purple-500/10 border-purple-500/30'
                        : 'bg-white/5 border-white/10 hover:border-white/20'
                    )}
                    onClick={() => dispatch({ type: 'SET_ACTIVE_TASK', id: task.id })}
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <h3 className="text-sm font-medium text-white">{task.title}</h3>
                        <p className="text-xs text-gray-500 mt-1 line-clamp-2">{task.description}</p>
                      </div>
                      <TaskStatusBadge status={task.status} />
                    </div>
                    <div className="flex items-center gap-4 mt-3">
                      <span className="text-[10px] text-gray-600">
                        {task.subtasks.length} subtasks
                      </span>
                      <span className="text-[10px] text-gray-600">
                        {task.subtasks.filter(st => st.status === 'completed').length}/{task.subtasks.length} done
                      </span>
                      {task.status === 'executing' && (
                        <Loader2 className="w-3 h-3 text-purple-400 animate-spin" />
                      )}
                    </div>
                    {/* Subtask progress */}
                    <div className="mt-2 h-1 bg-white/5 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-purple-500 transition-all duration-500"
                        style={{
                          width: `${task.subtasks.length > 0
                            ? (task.subtasks.filter(st => st.status === 'completed').length / task.subtasks.length) * 100
                            : 0}%`
                        }}
                      />
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </ScrollArea>
      </div>

      {/* Right Panel - Active Task Detail / Agent Messages */}
      <div className="w-1/2 flex flex-col">
        <div className="px-6 py-4 border-b border-white/10">
          <h2 className="text-lg font-semibold text-white flex items-center gap-2">
            <MessageSquare className="w-5 h-5 text-emerald-400" />
            Agent Communication
          </h2>
          <p className="text-xs text-gray-500 mt-1">Real-time messages between orchestrator and agents</p>
        </div>

        <ScrollArea className="flex-1 p-6">
          {state.activeTaskId ? (
            <ActiveTaskDetail
              taskId={state.activeTaskId}
              collapsed={collapsed}
              toggleCollapsed={toggleCollapsed}
              onRun={() => void runOrchestrator(state.activeTaskId!)}
            />
          ) : (
            <div className="flex flex-col items-center justify-center py-16 text-gray-600">
              <Bot className="w-12 h-12 mb-4" />
              <p className="text-sm">Select a task to view details</p>
              <p className="text-xs mt-1">or create a new task to start orchestration</p>
            </div>
          )}
        </ScrollArea>
      </div>
    </div>
  );
}

function TaskStatusBadge({ status }: { status: string }) {
  const config: Record<string, { color: string; icon: typeof CheckCircle }> = {
    planning: { color: 'text-blue-400 bg-blue-400/10', icon: Clock },
    executing: { color: 'text-purple-400 bg-purple-400/10', icon: Loader2 },
    verifying: { color: 'text-amber-400 bg-amber-400/10', icon: CheckCircle },
    completed: { color: 'text-green-400 bg-green-400/10', icon: CheckCircle },
    failed: { color: 'text-red-400 bg-red-400/10', icon: AlertCircle },
  };
  const c = config[status] || config.planning;
  const Icon = c.icon;
  return (
    <Badge variant="outline" className={cn('text-[10px] border-0', c.color)}>
      <Icon className="w-3 h-3 mr-1" />
      {status}
    </Badge>
  );
}

function ActiveTaskDetail({
  taskId,
  collapsed,
  toggleCollapsed,
  onRun,
}: {
  taskId: string;
  collapsed: Record<string, boolean>;
  toggleCollapsed: (id: string) => void;
  onRun: () => void;
}) {
  const { state } = useWorkspace();
  const task = state.tasks.find(t => t.id === taskId);
  if (!task) return null;

  return (
    <div className="space-y-4">
      {/* Task Header */}
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-base font-semibold text-white">{task.title}</h3>
          <p className="text-xs text-gray-500 mt-1">{task.description}</p>
        </div>
        {task.status === 'planning' && (
          <Button
            onClick={onRun}
            disabled={state.isOrchestratorRunning}
            className="bg-purple-600 hover:bg-purple-700 text-white"
            size="sm"
          >
            <Play className="w-4 h-4 mr-1" />
            Run Orchestrator
          </Button>
        )}
        {task.status === 'executing' && (
          <Button disabled size="sm" className="bg-purple-600/50 text-white">
            <Loader2 className="w-4 h-4 mr-1 animate-spin" />
            Running...
          </Button>
        )}
      </div>

      {/* Subtasks */}
      <div className="space-y-2">
        {task.subtasks.map(subtask => (
          <div
            key={subtask.id}
            className={cn(
              'rounded-lg border transition-all',
              subtask.status === 'completed' ? 'bg-green-500/5 border-green-500/20' :
              subtask.status === 'failed' ? 'bg-red-500/5 border-red-500/20' :
              subtask.status === 'in_progress' ? 'bg-purple-500/5 border-purple-500/20' :
              subtask.status === 'verifying' ? 'bg-amber-500/5 border-amber-500/20' :
              'bg-white/5 border-white/10'
            )}
          >
            <button
              className="w-full flex items-center gap-3 px-4 py-3"
              onClick={() => toggleCollapsed(subtask.id)}
            >
              <SubtaskStatusIcon status={subtask.status} />
              <div className="flex-1 text-left">
                <span className="text-sm text-gray-200">{subtask.title}</span>
                <div className="flex items-center gap-2 mt-0.5">
                  <Badge variant="outline" className="text-[9px] border-white/10 text-gray-500">
                    {state.providers.find(p => p.id === subtask.assignedProvider)?.name || subtask.assignedProvider}
                  </Badge>
                  {subtask.terminalId && (
                    <Badge variant="outline" className="text-[9px] border-emerald-500/20 text-emerald-400">
                      <GitBranch className="w-2 h-2 mr-1" />
                      Terminal
                    </Badge>
                  )}
                </div>
              </div>
              {collapsed[subtask.id] ? (
                <ChevronDown className="w-4 h-4 text-gray-600" />
              ) : (
                <ChevronUp className="w-4 h-4 text-gray-600" />
              )}
            </button>

            {!collapsed[subtask.id] && (
              <div className="px-4 pb-4 space-y-2">
                <p className="text-xs text-gray-500">{subtask.description}</p>
                <div className="flex items-center gap-2">
                  <ArrowRight className="w-3 h-3 text-purple-400" />
                  <span className="text-xs text-purple-300">{subtask.intent}</span>
                </div>
                {subtask.verificationResult && (
                  <div className={cn(
                    'p-2 rounded text-xs',
                    subtask.verificationResult.passed
                      ? 'bg-green-500/10 text-green-400'
                      : 'bg-red-500/10 text-red-400'
                  )}>
                    {subtask.verificationResult.passed ? 'Verified' : 'Failed'}: {subtask.verificationResult.feedback}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Messages */}
      {state.messages.length > 0 && (
        <div className="mt-6">
          <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">Communication Log</h4>
          <div className="space-y-2">
            {state.messages.map(msg => (
              <div
                key={msg.id}
                className={cn(
                  'flex items-start gap-3 p-3 rounded-lg',
                  msg.type === 'delegation' ? 'bg-purple-500/5 border border-purple-500/10' :
                  msg.type === 'response' ? 'bg-emerald-500/5 border border-emerald-500/10' :
                  msg.type === 'verification' ? 'bg-amber-500/5 border border-amber-500/10' :
                  'bg-white/5 border border-white/10'
                )}
              >
                <MessageTypeIcon type={msg.type} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-gray-300">{msg.fromAgent}</span>
                    <ArrowRight className="w-2 h-2 text-gray-600" />
                    <span className="text-xs text-gray-500">{msg.toAgent}</span>
                  </div>
                  <p className="text-xs text-gray-400 mt-1">{msg.content}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function SubtaskStatusIcon({ status }: { status: string }) {
  switch (status) {
    case 'completed':
      return <CheckCircle className="w-4 h-4 text-green-400 flex-shrink-0" />;
    case 'failed':
      return <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0" />;
    case 'in_progress':
      return <Loader2 className="w-4 h-4 text-purple-400 animate-spin flex-shrink-0" />;
    case 'verifying':
      return <Clock className="w-4 h-4 text-amber-400 flex-shrink-0" />;
    default:
      return <Circle className="w-4 h-4 text-gray-600 flex-shrink-0" />;
  }
}

function MessageTypeIcon({ type }: { type: string }) {
  switch (type) {
    case 'delegation':
      return <ArrowRight className="w-4 h-4 text-purple-400 flex-shrink-0 mt-0.5" />;
    case 'response':
      return <MessageSquare className="w-4 h-4 text-emerald-400 flex-shrink-0 mt-0.5" />;
    case 'verification':
      return <CheckCircle className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />;
    default:
      return <Bot className="w-4 h-4 text-gray-500 flex-shrink-0 mt-0.5" />;
  }
}
