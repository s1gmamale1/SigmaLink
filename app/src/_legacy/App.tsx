import { WorkspaceProvider, useWorkspace } from '@/hooks/useWorkspace';
import { Sidebar } from '@/sections/Sidebar';
import { CommandRoom } from '@/sections/CommandRoom';
import { SwarmRoom } from '@/sections/SwarmRoom';
import { ReviewRoom } from '@/sections/ReviewRoom';
import { cn } from '@/lib/utils';
import { Activity, Bot, GitBranch, Sparkles } from 'lucide-react';

function Workspace() {
  const { state, createTerminal } = useWorkspace();
  const runningCount = state.terminals.filter((term) => term.status === 'running').length;
  const workspaceName = state.repoPath ? state.repoPath.split(/[/\\]/).pop() : 'No workspace';

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[#0a0c12] text-white">
      <Sidebar />

      <div className="flex flex-1 flex-col overflow-hidden">
        <div className="border-b border-white/5 bg-[#0d1018] px-5 py-3">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.28em] text-cyan-400/70">
                <Sparkles className="h-3.5 w-3.5" />
                <span>SigmaLink Control Surface</span>
              </div>
              <div className="mt-1 flex items-center gap-3">
                <h2 className={cn(
                  'text-sm font-semibold',
                  state.currentRoom === 'command' && 'text-emerald-300',
                  state.currentRoom === 'swarm' && 'text-purple-300',
                  state.currentRoom === 'review' && 'text-amber-300',
                )}>
                  {state.currentRoom === 'command' && 'Command Room'}
                  {state.currentRoom === 'swarm' && 'Swarm Room'}
                  {state.currentRoom === 'review' && 'Review Room'}
                </h2>
                <span className="text-xs text-gray-600">•</span>
                <span className="truncate text-xs text-gray-500">{workspaceName}</span>
              </div>
            </div>

            <div className="hidden items-center gap-2 xl:flex">
              {[
                { label: 'Live agents', value: state.terminals.length, icon: Bot },
                { label: 'Running', value: runningCount, icon: Activity },
                { label: 'Base', value: state.baseBranch, icon: GitBranch },
              ].map((item) => {
                const Icon = item.icon;
                return (
                  <div key={item.label} className="flex items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.03] px-3 py-2">
                    <Icon className="h-4 w-4 text-cyan-300" />
                    <div>
                      <p className="text-[10px] uppercase tracking-[0.2em] text-gray-500">{item.label}</p>
                      <p className="text-xs text-white">{item.value}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {state.providers.slice(0, 5).map((provider) => (
              <button
                key={provider.id}
                onClick={() => void createTerminal(provider.id)}
                className="group inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs text-gray-400 transition hover:border-cyan-500/30 hover:bg-cyan-500/8 hover:text-white"
                title={`Launch ${provider.name}`}
              >
                <div className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: provider.color }} />
                <span>{provider.name}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-hidden">
          {state.currentRoom === 'command' && <CommandRoom />}
          {state.currentRoom === 'swarm' && <SwarmRoom />}
          {state.currentRoom === 'review' && <ReviewRoom />}
        </div>
      </div>
    </div>
  );
}

function App() {
  return (
    <WorkspaceProvider>
      <Workspace />
    </WorkspaceProvider>
  );
}

export default App;
