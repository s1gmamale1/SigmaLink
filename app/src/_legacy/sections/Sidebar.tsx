import { useEffect, useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { useWorkspace } from '@/hooks/useWorkspace';
import type { Room } from '@/types';
import {
  Activity, ChevronLeft, ChevronRight, ClipboardCheck, FolderOpen, MessageSquare,
  Plus, Sparkles, Terminal, Users, Zap
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

const ROOMS: { id: Room; label: string; icon: typeof Terminal; color: string }[] = [
  { id: 'command', label: 'Command Room', icon: Terminal, color: 'text-emerald-400' },
  { id: 'swarm', label: 'Swarm Room', icon: Users, color: 'text-purple-400' },
  { id: 'review', label: 'Review Room', icon: ClipboardCheck, color: 'text-amber-400' },
];

interface SavedWorkspace {
  id: string;
  name: string;
  path: string;
  repoRoot: string | null;
}

const WORKSPACES_KEY = 'sigmalink.savedWorkspaces';

function loadSavedWorkspaces(): SavedWorkspace[] {
  try {
    const raw = localStorage.getItem(WORKSPACES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch {
    return [];
  }
}

function inferName(path: string) {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] || 'Workspace';
}

export function Sidebar() {
  const { state, dispatch, createTerminal, setRoom, selectWorkspace } = useWorkspace();
  const [savedWorkspaces, setSavedWorkspaces] = useState<SavedWorkspace[]>(() => (typeof window !== 'undefined' ? loadSavedWorkspaces() : []));

  useEffect(() => {
    localStorage.setItem(WORKSPACES_KEY, JSON.stringify(savedWorkspaces));
  }, [savedWorkspaces]);

  const currentWorkspaceId = useMemo(() => {
    return savedWorkspaces.find((item) => item.path === state.repoPath)?.id ?? null;
  }, [savedWorkspaces, state.repoPath]);

  function saveCurrentWorkspace() {
    if (!state.repoPath) return;
    setSavedWorkspaces((prev) => {
      const exists = prev.some((item) => item.path === state.repoPath);
      if (exists) return prev;
      return [
        { id: `ws-${Date.now()}`, name: inferName(state.repoPath), path: state.repoPath, repoRoot: state.repoRoot },
        ...prev,
      ].slice(0, 12);
    });
  }

  function selectSavedWorkspace(workspace: SavedWorkspace) {
    dispatch({ type: 'SET_WORKSPACE', repoPath: workspace.path, repoRoot: workspace.repoRoot });
  }

  function removeSavedWorkspace(id: string) {
    setSavedWorkspaces((prev) => prev.filter((item) => item.id !== id));
  }

  return (
    <TooltipProvider delayDuration={0}>
      <div
        className={cn(
          'flex h-full flex-col border-r border-white/10 bg-[#0f1117] transition-all duration-300',
          state.sidebarCollapsed ? 'w-16' : 'w-72'
        )}
      >
        <div className="flex items-center justify-between border-b border-white/10 p-4">
          {!state.sidebarCollapsed && (
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-purple-500 to-cyan-500 shadow-lg shadow-cyan-500/10">
                <Zap className="h-4 w-4 text-white" />
              </div>
              <div>
                <h1 className="text-sm font-bold text-white leading-tight">SigmaLink</h1>
                <p className="text-[10px] text-gray-500">Mission control v1.1</p>
              </div>
            </div>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-gray-400 hover:bg-white/10 hover:text-white"
            onClick={() => dispatch({ type: 'TOGGLE_SIDEBAR' })}
          >
            {state.sidebarCollapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
          </Button>
        </div>

        <ScrollArea className="flex-1">
          <div className="border-b border-white/10 p-2">
            {!state.sidebarCollapsed && (
              <div className="mb-2 flex items-center justify-between px-2">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">Workspaces</p>
                <button onClick={saveCurrentWorkspace} className="text-[10px] text-cyan-300 transition hover:text-cyan-200">Save</button>
              </div>
            )}

            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => void selectWorkspace()}
                  className="mb-1 flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-gray-400 transition-all hover:bg-white/5 hover:text-white"
                >
                  <FolderOpen className="h-4 w-4 flex-shrink-0 text-cyan-400" />
                  {!state.sidebarCollapsed && (
                    <div className="min-w-0 text-left">
                      <p className="truncate text-xs text-gray-200">{state.repoPath || 'Select repo/folder'}</p>
                      <p className="truncate text-[10px] text-gray-600">{state.repoRoot ? 'Git worktrees enabled' : 'Direct folder mode'}</p>
                    </div>
                  )}
                </button>
              </TooltipTrigger>
              {state.sidebarCollapsed && <TooltipContent side="right">Select workspace</TooltipContent>}
            </Tooltip>

            {!state.sidebarCollapsed && savedWorkspaces.length > 0 && (
              <div className="space-y-1 px-1 pt-1">
                {savedWorkspaces.map((workspace) => {
                  const isActive = currentWorkspaceId === workspace.id;
                  return (
                    <div key={workspace.id} className={cn('group flex items-center gap-2 rounded-xl px-2 py-2', isActive ? 'bg-white/10' : 'hover:bg-white/5')}>
                      <button onClick={() => selectSavedWorkspace(workspace)} className="min-w-0 flex-1 text-left">
                        <div className="flex items-center gap-2">
                          <Sparkles className={cn('h-3.5 w-3.5', isActive ? 'text-cyan-300' : 'text-gray-600')} />
                          <span className={cn('truncate text-xs', isActive ? 'text-white' : 'text-gray-400')}>{workspace.name}</span>
                        </div>
                        <p className="mt-1 truncate pl-5 text-[10px] text-gray-600">{workspace.path}</p>
                      </button>
                      <button
                        onClick={() => removeSavedWorkspace(workspace.id)}
                        className="opacity-0 text-[10px] text-gray-500 transition group-hover:opacity-100 hover:text-red-300"
                      >
                        x
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="p-2">
            {!state.sidebarCollapsed && (
              <p className="mb-2 px-2 text-[10px] font-semibold uppercase tracking-wider text-gray-500">Rooms</p>
            )}
            {ROOMS.map((room) => {
              const Icon = room.icon;
              const isActive = state.currentRoom === room.id;
              return (
                <Tooltip key={room.id}>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => setRoom(room.id)}
                      className={cn(
                        'mb-1 flex w-full items-center gap-3 rounded-xl px-3 py-2.5 transition-all',
                        isActive ? 'bg-white/10 text-white' : 'text-gray-400 hover:bg-white/5 hover:text-white',
                      )}
                    >
                      <Icon className={cn('h-4 w-4 flex-shrink-0', isActive ? room.color : '')} />
                      {!state.sidebarCollapsed && (
                        <>
                          <span className="flex-1 text-left text-sm">{room.label}</span>
                          {room.id === 'swarm' && state.isOrchestratorRunning && <Activity className="h-3 w-3 animate-pulse text-purple-400" />}
                        </>
                      )}
                    </button>
                  </TooltipTrigger>
                  {state.sidebarCollapsed && <TooltipContent side="right">{room.label}</TooltipContent>}
                </Tooltip>
              );
            })}
          </div>

          {state.terminals.length > 0 && (
            <div className="border-t border-white/10 p-2">
              {!state.sidebarCollapsed && (
                <p className="mb-2 px-2 text-[10px] font-semibold uppercase tracking-wider text-gray-500">Active agents ({state.terminals.length})</p>
              )}
              {state.terminals.map((term) => {
                const provider = state.providers.find((p) => p.id === term.providerId);
                const isActive = state.activeTerminalId === term.id;
                return (
                  <Tooltip key={term.id}>
                    <TooltipTrigger asChild>
                      <button
                        onClick={() => {
                          setRoom('command');
                          dispatch({ type: 'SET_ACTIVE_TERMINAL', id: term.id });
                        }}
                        className={cn('group mb-1 flex w-full items-center gap-2 rounded-xl px-3 py-2 transition-all', isActive ? 'bg-white/10' : 'hover:bg-white/5')}
                      >
                        <div className="h-2.5 w-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: provider?.color || '#666' }} />
                        {!state.sidebarCollapsed ? (
                          <>
                            <div className="min-w-0 flex-1 text-left">
                              <span className={cn('block truncate text-xs', isActive ? 'text-white' : 'text-gray-300')}>{term.title}</span>
                              <span className="block truncate text-[10px] text-gray-600">{term.branchName}</span>
                            </div>
                            <div className={cn(
                              'h-1.5 w-1.5 rounded-full',
                              term.status === 'running' ? 'bg-green-400 animate-pulse' : term.status === 'completed' ? 'bg-blue-400' : term.status === 'error' ? 'bg-red-400' : 'bg-gray-500',
                            )} />
                          </>
                        ) : (
                          <div className={cn('h-1.5 w-1.5 rounded-full', term.status === 'running' ? 'bg-green-400 animate-pulse' : 'bg-gray-500')} />
                        )}
                      </button>
                    </TooltipTrigger>
                    {state.sidebarCollapsed && <TooltipContent side="right">{term.title}</TooltipContent>}
                  </Tooltip>
                );
              })}
            </div>
          )}

          <div className="border-t border-white/10 p-2">
            {!state.sidebarCollapsed && (
              <p className="mb-2 px-2 text-[10px] font-semibold uppercase tracking-wider text-gray-500">Launch agent</p>
            )}
            {state.providers.map((provider) => (
              <Tooltip key={provider.id}>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => void createTerminal(provider.id)}
                    className="group mb-1 flex w-full items-center gap-2 rounded-xl px-3 py-2 text-gray-400 transition-all hover:bg-white/5 hover:text-white"
                  >
                    <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg" style={{ backgroundColor: `${provider.color}20` }}>
                      <Plus className="h-3.5 w-3.5" style={{ color: provider.color }} />
                    </div>
                    {!state.sidebarCollapsed && (
                      <div className="min-w-0 flex-1 text-left">
                        <span className="block text-xs text-gray-300">{provider.name}</span>
                        <span className="block truncate text-[10px] text-gray-600">{provider.command || 'manual'}</span>
                      </div>
                    )}
                  </button>
                </TooltipTrigger>
                {state.sidebarCollapsed && <TooltipContent side="right">Launch {provider.name}</TooltipContent>}
              </Tooltip>
            ))}
          </div>

          {state.tasks.length > 0 && (
            <div className="border-t border-white/10 p-2">
              {!state.sidebarCollapsed && (
                <p className="mb-2 px-2 text-[10px] font-semibold uppercase tracking-wider text-gray-500">Tasks ({state.tasks.length})</p>
              )}
              {state.tasks.slice(-3).map((task) => (
                <button
                  key={task.id}
                  onClick={() => {
                    dispatch({ type: 'SET_ACTIVE_TASK', id: task.id });
                    setRoom('review');
                  }}
                  className={cn(
                    'mb-1 flex w-full items-center gap-2 rounded-xl px-3 py-2 transition-all',
                    state.activeTaskId === task.id ? 'bg-white/10 text-white' : 'text-gray-400 hover:bg-white/5',
                  )}
                >
                  <MessageSquare className="h-3.5 w-3.5 flex-shrink-0" />
                  {!state.sidebarCollapsed && <span className="truncate text-xs text-left flex-1">{task.title}</span>}
                </button>
              ))}
            </div>
          )}
        </ScrollArea>

        <div className="border-t border-white/10 p-3">
          <div className="flex items-center gap-2">
            <div className={cn('h-2 w-2 rounded-full', state.isOrchestratorRunning ? 'bg-purple-400 animate-pulse' : 'bg-green-400')} />
            {!state.sidebarCollapsed && (
              <span className="text-[10px] text-gray-500">{state.isOrchestratorRunning ? 'Orchestrator active' : 'Ready for launch'}</span>
            )}
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}
