import { useMemo, useState, useCallback, type CSSProperties } from 'react';
import { useWorkspace } from '@/hooks/useWorkspace';
import { TerminalPane } from './TerminalPane';
import { CommandDock } from './CommandDock';
import { cn } from '@/lib/utils';
import { LayoutGrid, Columns2, Square, GalleryVerticalEnd, SidebarOpen, SidebarClose, Grip, Rows3 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { TerminalSession } from '@/types';

type LayoutMode = 'mosaic' | 'columns' | 'focus';
type DensityMode = 'compact' | 'balanced' | 'expanded';

function getActiveTerminal(terminals: TerminalSession[], activeTerminalId: string | null) {
  return terminals.find((t) => t.id === activeTerminalId) || terminals[terminals.length - 1] || terminals[0];
}

function getDisplayTerminals(terminals: TerminalSession[], activeTerminalId: string | null, layout: LayoutMode) {
  if (layout === 'mosaic') return terminals;

  const active = getActiveTerminal(terminals, activeTerminalId);
  if (!active) return [];

  if (layout === 'focus') return [active];

  const ordered = [active, ...terminals.filter((t) => t.id !== active.id)];
  return ordered.slice(0, Math.min(3, ordered.length));
}

function getGridStyle(layout: LayoutMode, density: DensityMode, terminalCount: number): CSSProperties {
  if (layout === 'focus') {
    return { gridTemplateColumns: 'minmax(0, 1fr)', gridAutoRows: 'minmax(0, 1fr)' };
  }

  const minWidth = density === 'compact' ? 260 : density === 'balanced' ? 320 : 400;
  const minHeight = density === 'compact' ? 240 : density === 'balanced' ? 300 : 360;

  if (layout === 'columns') {
    const columns = terminalCount >= 3 ? 3 : terminalCount === 2 ? 2 : 1;
    return {
      gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
      gridAutoRows: `minmax(${minHeight}px, 1fr)`,
    };
  }

  return {
    gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, ${minWidth}px), 1fr))`,
    gridAutoRows: `minmax(${minHeight}px, 1fr)`,
  };
}

export function CommandRoom() {
  const { state, dispatch, createTerminal } = useWorkspace();
  const [layout, setLayout] = useState<LayoutMode>('mosaic');
  const [density, setDensity] = useState<DensityMode>('compact');
  const [fullscreenId, setFullscreenId] = useState<string | null>(null);
  const [dockVisible, setDockVisible] = useState(true);

  const toggleFullscreen = useCallback((id: string) => {
    setFullscreenId((prev) => (prev === id ? null : id));
  }, []);

  const displayTerminals = useMemo(
    () => getDisplayTerminals(state.terminals, state.activeTerminalId, layout),
    [layout, state.activeTerminalId, state.terminals],
  );

  const activeTerminal = useMemo(
    () => getActiveTerminal(state.terminals, state.activeTerminalId),
    [state.activeTerminalId, state.terminals],
  );

  if (state.terminals.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center text-gray-500">
        <div className="mb-6 flex h-20 w-20 items-center justify-center rounded-3xl border border-cyan-500/10 bg-cyan-500/5">
          <GalleryVerticalEnd className="h-10 w-10 text-cyan-400/70" />
        </div>
        <h2 className="mb-2 text-xl font-semibold text-gray-300">Build your first command mosaic</h2>
        <p className="mb-6 max-w-2xl text-center text-sm text-gray-500">
          SigmaLink now supports a dense multi-agent deck inspired by workstation-style orchestration layouts.
          Launch agents below, then use the mosaic/columns/focus controls and the right-side mission dock.
        </p>
        <div className="flex flex-wrap justify-center gap-3">
          {state.providers.filter((provider) => provider.id !== 'custom').slice(0, 5).map((provider) => (
            <button
              key={provider.id}
              onClick={() => void createTerminal(provider.id)}
              className="group flex items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 transition hover:border-cyan-500/30 hover:bg-white/[0.06]"
            >
              <div className="h-3 w-3 rounded-full" style={{ backgroundColor: provider.color }} />
              <span className="text-sm text-gray-300 group-hover:text-white">{provider.name}</span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  if (fullscreenId) {
    const term = state.terminals.find((t) => t.id === fullscreenId);
    if (term) {
      return (
        <div className="h-full min-h-0 p-4">
          <TerminalPane
            terminal={term}
            density="expanded"
            isActive={true}
            onActivate={() => {}}
            isFullscreen={true}
            layoutSignal={`fullscreen-${fullscreenId}`}
            onToggleFullscreen={() => toggleFullscreen(term.id)}
          />
        </div>
      );
    }
  }

  const gridStyle = getGridStyle(layout, density, displayTerminals.length);

  return (
    <div className="flex h-full min-h-0 flex-col bg-[radial-gradient(circle_at_top_right,rgba(34,211,238,0.08),transparent_26%),radial-gradient(circle_at_top_left,rgba(168,85,247,0.06),transparent_24%),#0a0d14]">
      <div className="flex items-center justify-between border-b border-white/5 px-4 py-3 shrink-0">
        <div className="flex min-w-0 items-center gap-3">
          <div>
            <p className="text-[10px] uppercase tracking-[0.28em] text-cyan-400/70">Command mosaic</p>
            <h2 className="text-sm font-semibold text-white">
              {state.terminals.length} live agent{state.terminals.length !== 1 ? 's' : ''}
            </h2>
          </div>
          <div className="hidden items-center gap-2 lg:flex">
            <span className="rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 text-[10px] uppercase tracking-[0.18em] text-gray-400">
              Workspace · {state.repoPath ? state.repoPath.split(/[/\\]/).pop() : 'none'}
            </span>
            <span className="rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 text-[10px] uppercase tracking-[0.18em] text-gray-400">
              Active branch · {activeTerminal?.branchName ?? 'n/a'}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <div className="hidden items-center gap-1 rounded-xl border border-white/10 bg-white/[0.03] p-1 md:flex">
            {[
              { id: 'mosaic', icon: LayoutGrid, title: 'Mosaic' },
              { id: 'columns', icon: Columns2, title: 'Columns' },
              { id: 'focus', icon: Square, title: 'Focus' },
            ].map((item) => {
              const Icon = item.icon;
              const active = layout === item.id;
              return (
                <Button
                  key={item.id}
                  variant="ghost"
                  size="icon"
                  className={cn('h-8 w-8', active ? 'bg-cyan-500/10 text-cyan-300' : 'text-gray-500 hover:text-white')}
                  title={item.title}
                  onClick={() => setLayout(item.id as LayoutMode)}
                >
                  <Icon className="h-4 w-4" />
                </Button>
              );
            })}
          </div>

          <div className="hidden items-center gap-1 rounded-xl border border-white/10 bg-white/[0.03] p-1 md:flex">
            {[
              { id: 'compact', icon: Grip, title: 'Compact' },
              { id: 'balanced', icon: Rows3, title: 'Balanced' },
              { id: 'expanded', icon: SidebarOpen, title: 'Expanded' },
            ].map((item) => {
              const Icon = item.icon;
              const active = density === item.id;
              return (
                <button
                  key={item.id}
                  title={item.title}
                  onClick={() => setDensity(item.id as DensityMode)}
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] transition-all',
                    active ? 'bg-purple-500/12 text-purple-300' : 'text-gray-500 hover:bg-white/5 hover:text-white',
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                  <span className="hidden xl:inline">{item.title}</span>
                </button>
              );
            })}
          </div>

          <Button
            variant="ghost"
            size="sm"
            className={cn('h-8 gap-2 rounded-xl border border-white/10 px-3 text-xs', dockVisible ? 'text-cyan-300 bg-cyan-500/8' : 'text-gray-400')}
            onClick={() => setDockVisible((prev) => !prev)}
          >
            {dockVisible ? <SidebarClose className="h-4 w-4" /> : <SidebarOpen className="h-4 w-4" />}
            <span className="hidden md:inline">Dock</span>
          </Button>
        </div>
      </div>

      <div className="flex flex-1 min-h-0 overflow-hidden">
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="grid grid-cols-2 gap-3 border-b border-white/5 px-4 py-3 lg:grid-cols-4 shrink-0">
            {[
              { label: 'Running', value: state.terminals.filter((t) => t.status === 'running').length },
              { label: 'Ready to review', value: state.terminals.filter((t) => t.status === 'completed').length },
              { label: 'Needs attention', value: state.terminals.filter((t) => t.status === 'error').length },
              { label: 'Tasks staged', value: state.tasks.length },
            ].map((card) => (
              <div key={card.label} className="rounded-2xl border border-white/10 bg-white/[0.03] px-3 py-3">
                <p className="text-[10px] uppercase tracking-[0.2em] text-gray-500">{card.label}</p>
                <p className="mt-2 text-base font-semibold text-white">{card.value}</p>
              </div>
            ))}
          </div>

          <div className="flex-1 min-h-0 overflow-auto p-4">
            <div className="grid h-full gap-4" style={gridStyle}>
              {displayTerminals.map((term) => (
                <TerminalPane
                  key={term.id}
                  terminal={term}
                  density={density}
                  isActive={state.activeTerminalId === term.id}
                  onActivate={() => dispatch({ type: 'SET_ACTIVE_TERMINAL', id: term.id })}
                  isFullscreen={false}
                  layoutSignal={`${layout}-${density}-${displayTerminals.map((t) => t.id).join('-')}`}
                  onToggleFullscreen={() => toggleFullscreen(term.id)}
                />
              ))}
            </div>
          </div>
        </div>

        {dockVisible && (
          <div className="hidden h-full w-[420px] shrink-0 border-l border-white/5 p-4 xl:block">
            <CommandDock activeTerminal={activeTerminal} />
          </div>
        )}
      </div>
    </div>
  );
}
