import React, { createContext, useCallback, useContext, useEffect, useReducer } from 'react';
import type { AgentMessage, AgentProvider, OrchestratorTask, Room, SubTask, TerminalSession } from '@/types';
import { AGENT_PROVIDERS } from '@/lib/providers';
import { generateId } from '@/lib/utils';

interface WorkspaceState {
  currentRoom: Room;
  terminals: TerminalSession[];
  activeTerminalId: string | null;
  tasks: OrchestratorTask[];
  activeTaskId: string | null;
  messages: AgentMessage[];
  providers: AgentProvider[];
  isOrchestratorRunning: boolean;
  sidebarCollapsed: boolean;
  repoPath: string;
  repoRoot: string | null;
  baseBranch: string;
}

type Action =
  | { type: 'SET_ROOM'; room: Room }
  | { type: 'SET_WORKSPACE'; repoPath: string; repoRoot?: string | null }
  | { type: 'CREATE_TERMINAL'; terminal: TerminalSession }
  | { type: 'UPDATE_TERMINAL'; id: string; updates: Partial<TerminalSession> }
  | { type: 'CLOSE_TERMINAL'; id: string }
  | { type: 'SET_ACTIVE_TERMINAL'; id: string }
  | { type: 'TERMINAL_OUTPUT'; id: string; data: string }
  | { type: 'TERMINAL_STATUS'; id: string; status: TerminalSession['status'] }
  | { type: 'CREATE_TASK'; title: string; description: string; subtasks: Omit<SubTask, 'id' | 'createdAt' | 'status'>[] }
  | { type: 'SET_ACTIVE_TASK'; id: string | null }
  | { type: 'UPDATE_SUBTASK'; taskId: string; subtaskId: string; updates: Partial<SubTask> }
  | { type: 'SET_ORCHESTRATOR_RUNNING'; running: boolean }
  | { type: 'ADD_MESSAGE'; message: AgentMessage }
  | { type: 'TOGGLE_SIDEBAR' }
  | { type: 'ADD_PROVIDER'; provider: AgentProvider };

const STORAGE_KEY = 'sigmalink.workspace';

function loadWorkspaceSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { repoPath: '', repoRoot: null, baseBranch: 'HEAD' };
    const parsed = JSON.parse(raw);
    return {
      repoPath: typeof parsed.repoPath === 'string' ? parsed.repoPath : '',
      repoRoot: typeof parsed.repoRoot === 'string' ? parsed.repoRoot : null,
      baseBranch: typeof parsed.baseBranch === 'string' ? parsed.baseBranch : 'HEAD',
    };
  } catch {
    return { repoPath: '', repoRoot: null, baseBranch: 'HEAD' };
  }
}

const savedWorkspace = typeof window !== 'undefined' ? loadWorkspaceSettings() : { repoPath: '', repoRoot: null, baseBranch: 'HEAD' };

const initialState: WorkspaceState = {
  currentRoom: 'command',
  terminals: [],
  activeTerminalId: null,
  tasks: [],
  activeTaskId: null,
  messages: [],
  providers: AGENT_PROVIDERS,
  isOrchestratorRunning: false,
  sidebarCollapsed: false,
  repoPath: savedWorkspace.repoPath,
  repoRoot: savedWorkspace.repoRoot,
  baseBranch: savedWorkspace.baseBranch,
};

function workspaceReducer(state: WorkspaceState, action: Action): WorkspaceState {
  switch (action.type) {
    case 'SET_ROOM':
      return { ...state, currentRoom: action.room };

    case 'SET_WORKSPACE':
      return { ...state, repoPath: action.repoPath, repoRoot: action.repoRoot ?? null };

    case 'CREATE_TERMINAL':
      return { ...state, terminals: [...state.terminals, action.terminal], activeTerminalId: action.terminal.id };

    case 'UPDATE_TERMINAL':
      return {
        ...state,
        terminals: state.terminals.map(t => (t.id === action.id ? { ...t, ...action.updates } : t)),
      };

    case 'CLOSE_TERMINAL': {
      const filtered = state.terminals.filter(t => t.id !== action.id);
      return {
        ...state,
        terminals: filtered,
        activeTerminalId: filtered.length > 0 ? filtered[filtered.length - 1].id : null,
      };
    }

    case 'SET_ACTIVE_TERMINAL':
      return { ...state, activeTerminalId: action.id };

    case 'TERMINAL_OUTPUT':
      return {
        ...state,
        terminals: state.terminals.map(t =>
          t.id === action.id ? { ...t, output: [...t.output, action.data].slice(-1200) } : t,
        ),
      };

    case 'TERMINAL_STATUS':
      return {
        ...state,
        terminals: state.terminals.map(t => (t.id === action.id ? { ...t, status: action.status } : t)),
      };

    case 'CREATE_TASK': {
      const task: OrchestratorTask = {
        id: generateId(),
        title: action.title,
        description: action.description,
        status: 'planning',
        createdAt: Date.now(),
        subtasks: action.subtasks.map((st, i) => ({
          ...st,
          id: `${generateId()}-${i}`,
          status: 'pending',
          createdAt: Date.now(),
        })),
      };
      return { ...state, tasks: [...state.tasks, task], activeTaskId: task.id };
    }

    case 'SET_ACTIVE_TASK':
      return { ...state, activeTaskId: action.id };

    case 'UPDATE_SUBTASK':
      return {
        ...state,
        tasks: state.tasks.map(task => {
          if (task.id !== action.taskId) return task;
          const subtasks = task.subtasks.map(subtask =>
            subtask.id === action.subtaskId ? { ...subtask, ...action.updates } : subtask,
          );
          const allCompleted = subtasks.length > 0 && subtasks.every(subtask => subtask.status === 'completed');
          const anyFailed = subtasks.some(subtask => subtask.status === 'failed');
          const anyRunning = subtasks.some(subtask => ['in_progress', 'verifying'].includes(subtask.status));
          return {
            ...task,
            subtasks,
            status: allCompleted ? 'completed' : anyFailed ? 'failed' : anyRunning ? 'executing' : task.status,
            completedAt: allCompleted ? Date.now() : undefined,
          };
        }),
      };

    case 'SET_ORCHESTRATOR_RUNNING':
      return { ...state, isOrchestratorRunning: action.running };

    case 'ADD_MESSAGE':
      return { ...state, messages: [...state.messages, action.message].slice(-500) };

    case 'TOGGLE_SIDEBAR':
      return { ...state, sidebarCollapsed: !state.sidebarCollapsed };

    case 'ADD_PROVIDER':
      return { ...state, providers: [...state.providers, action.provider] };

    default:
      return state;
  }
}

interface WorkspaceContextType {
  state: WorkspaceState;
  dispatch: React.Dispatch<Action>;
  createTerminal: (providerId: string, initialPrompt?: string) => Promise<string | undefined>;
  closeTerminal: (id: string) => Promise<void>;
  sendToTerminal: (id: string, data: string) => Promise<void>;
  selectWorkspace: () => Promise<void>;
  createTask: (title: string, description: string, subtasks: Omit<SubTask, 'id' | 'createdAt' | 'status'>[]) => void;
  runOrchestrator: (taskId: string) => Promise<void>;
  setRoom: (room: Room) => void;
}

const WorkspaceContext = createContext<WorkspaceContextType | null>(null);

function buildSubtaskPrompt(task: OrchestratorTask, subtask: SubTask) {
  return [
    'You are running inside an isolated SigmaLink worktree.',
    '',
    `Parent task: ${task.title}`,
    task.description ? `Parent description: ${task.description}` : '',
    '',
    `Subtask: ${subtask.title}`,
    subtask.description ? `Description: ${subtask.description}` : '',
    subtask.intent ? `Intent: ${subtask.intent}` : '',
    '',
    'Constraints:',
    '- Make the smallest safe code change that satisfies the subtask.',
    '- Do not merge, delete the repo, or rewrite unrelated history.',
    '- After edits, summarize changed files and verification commands to run.',
    '',
    `Success criteria: ${subtask.successCriteria || 'Code compiles and tests pass.'}`,
  ].filter(Boolean).join('\n');
}

export function WorkspaceProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(workspaceReducer, initialState);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      repoPath: state.repoPath,
      repoRoot: state.repoRoot,
      baseBranch: state.baseBranch,
    }));
  }, [state.repoPath, state.repoRoot, state.baseBranch]);

  const selectWorkspace = useCallback(async () => {
    if (!window.electron) {
      dispatch({
        type: 'ADD_MESSAGE',
        message: {
          id: generateId(),
          fromAgent: 'system',
          toAgent: 'user',
          content: 'Folder picker is available only in Electron. Run npm run electron:dev.',
          timestamp: Date.now(),
          type: 'system',
        },
      });
      return;
    }
    const result = await window.electron.selectDirectory();
    if (!result.canceled && result.path) {
      dispatch({ type: 'SET_WORKSPACE', repoPath: result.path, repoRoot: null });
    }
  }, []);

  const createTerminal = useCallback(async (providerId: string, initialPrompt?: string) => {
    const provider = state.providers.find(p => p.id === providerId) || state.providers[0];
    const id = generateId();
    const branchName = `sigmalink/${provider.id}/${id.slice(0, 8)}`;
    const titleCount = state.terminals.filter(t => t.providerId === provider.id).length + 1;

    const terminal: TerminalSession = {
      id,
      providerId: provider.id,
      worktreePath: state.repoPath || 'Select a workspace first',
      repoPath: state.repoPath,
      repoRoot: state.repoRoot,
      gitEnabled: false,
      createdWorktree: false,
      branchName,
      status: 'starting',
      createdAt: Date.now(),
      title: `${provider.name} #${titleCount}`,
      output: [`\x1b[36m[SigmaLink]\x1b[0m Preparing ${provider.name}...\r\n`],
    };

    dispatch({ type: 'CREATE_TERMINAL', terminal });

    if (!window.electron) {
      dispatch({ type: 'TERMINAL_OUTPUT', id, data: '\x1b[31mElectron bridge missing. Start the app with npm run electron:dev.\x1b[0m\r\n' });
      dispatch({ type: 'TERMINAL_STATUS', id, status: 'error' });
      return id;
    }

    const session = await window.electron.createAgentSession({
      repoPath: state.repoPath || undefined,
      providerId: provider.id,
      branchName,
      base: state.baseBranch,
    });

    if (!session.success) {
      dispatch({ type: 'TERMINAL_OUTPUT', id, data: `\x1b[31m[workspace:error]\x1b[0m ${session.error || 'Failed to create workspace'}\r\n` });
      dispatch({ type: 'TERMINAL_STATUS', id, status: 'error' });
      return id;
    }

    const cwd = String(session.worktreePath || state.repoPath || '');
    dispatch({
      type: 'UPDATE_TERMINAL',
      id,
      updates: {
        worktreePath: cwd,
        repoPath: String(session.repoPath || state.repoPath || ''),
        repoRoot: typeof session.repoRoot === 'string' ? session.repoRoot : null,
        gitEnabled: Boolean(session.gitEnabled),
        createdWorktree: Boolean(session.createdWorktree),
        branchName: String(session.branchName || branchName),
      },
    });
    if (session.repoRoot) dispatch({ type: 'SET_WORKSPACE', repoPath: String(session.repoPath || state.repoPath || ''), repoRoot: String(session.repoRoot) });

    dispatch({ type: 'TERMINAL_OUTPUT', id, data: `\x1b[36m[workspace]\x1b[0m cwd: ${cwd}\r\n` });
    if (session.gitEnabled) dispatch({ type: 'TERMINAL_OUTPUT', id, data: `\x1b[36m[workspace]\x1b[0m branch: ${session.branchName}\r\n` });
    if (session.warning) dispatch({ type: 'TERMINAL_OUTPUT', id, data: `\x1b[33m[workspace:warning]\x1b[0m ${session.warning}\r\n` });

    const ptyResult = await window.electron.ptyCreate({
      id,
      command: provider.command,
      args: provider.args,
      cwd,
      cols: 110,
      rows: 30,
    });

    if (!ptyResult.success) {
      dispatch({ type: 'TERMINAL_OUTPUT', id, data: `\x1b[31m[pty:error]\x1b[0m ${ptyResult.error || 'Failed to launch provider command.'}\r\n` });
      dispatch({ type: 'TERMINAL_OUTPUT', id, data: `\x1b[33mInstall hint:\x1b[0m ${provider.installHint}\r\n` });
      dispatch({ type: 'TERMINAL_STATUS', id, status: 'error' });
      return id;
    }

    const unsubscribeData = window.electron.onPtyData(id, data => {
      dispatch({ type: 'TERMINAL_OUTPUT', id, data });
    });
    const unsubscribeExit = window.electron.onPtyExit(id, code => {
      dispatch({ type: 'TERMINAL_OUTPUT', id, data: `\r\n\x1b[90m[process exited with code ${code}]\x1b[0m\r\n` });
      dispatch({ type: 'TERMINAL_STATUS', id, status: code === 0 ? 'completed' : 'error' });
      unsubscribeData();
      unsubscribeExit();
    });

    dispatch({ type: 'TERMINAL_STATUS', id, status: 'running' });

    if (initialPrompt?.trim()) {
      setTimeout(() => {
        window.electron?.ptyWrite({ id, data: `${initialPrompt.trim()}\r` });
      }, 700);
    }

    return id;
  }, [state.baseBranch, state.providers, state.repoPath, state.repoRoot, state.terminals]);

  const closeTerminal = useCallback(async (id: string) => {
    if (window.electron) await window.electron.ptyKill({ id });
    dispatch({ type: 'CLOSE_TERMINAL', id });
  }, []);

  const sendToTerminal = useCallback(async (id: string, data: string) => {
    if (window.electron) {
      const result = await window.electron.ptyWrite({ id, data });
      if (!result.success) dispatch({ type: 'TERMINAL_OUTPUT', id, data: `\r\n\x1b[31m${result.error || 'PTY write failed'}\x1b[0m\r\n` });
    } else {
      dispatch({ type: 'TERMINAL_OUTPUT', id, data });
    }
  }, []);

  const createTask = useCallback((title: string, description: string, subtasks: Omit<SubTask, 'id' | 'createdAt' | 'status'>[]) => {
    dispatch({ type: 'CREATE_TASK', title, description, subtasks });
  }, []);

  const runOrchestrator = useCallback(async (taskId: string) => {
    const task = state.tasks.find(t => t.id === taskId);
    if (!task || task.subtasks.length === 0) return;

    dispatch({ type: 'SET_ORCHESTRATOR_RUNNING', running: true });
    dispatch({ type: 'ADD_MESSAGE', message: {
      id: generateId(),
      fromAgent: 'orchestrator',
      toAgent: 'all',
      content: `Launching ${task.subtasks.length} real agent session(s) for: ${task.title}`,
      timestamp: Date.now(),
      type: 'system',
    }});

    for (const subtask of task.subtasks) {
      dispatch({ type: 'UPDATE_SUBTASK', taskId, subtaskId: subtask.id, updates: { status: 'in_progress' } });
      const terminalId = await createTerminal(subtask.assignedProvider, buildSubtaskPrompt(task, subtask));
      if (terminalId) {
        dispatch({ type: 'UPDATE_SUBTASK', taskId, subtaskId: subtask.id, updates: { terminalId } });
      }
      dispatch({ type: 'ADD_MESSAGE', message: {
        id: generateId(),
        fromAgent: 'orchestrator',
        toAgent: subtask.assignedProvider,
        content: `Delegated real subtask: ${subtask.title}`,
        timestamp: Date.now(),
        type: 'delegation',
      }});
    }

    dispatch({ type: 'SET_ORCHESTRATOR_RUNNING', running: false });
  }, [createTerminal, state.tasks]);

  const setRoom = useCallback((room: Room) => dispatch({ type: 'SET_ROOM', room }), []);

  return (
    <WorkspaceContext.Provider value={{
      state,
      dispatch,
      createTerminal,
      closeTerminal,
      sendToTerminal,
      selectWorkspace,
      createTask,
      runOrchestrator,
      setRoom,
    }}>
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace() {
  const context = useContext(WorkspaceContext);
  if (!context) throw new Error('useWorkspace must be used within WorkspaceProvider');
  return context;
}
