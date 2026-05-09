// Memory room — three tabs (List view = list+editor+backlinks, Graph view).
// We keep the list / editor / backlinks visible in "List" mode (per the U7
// critique: list-first, graph as a secondary tab) and dedicate the full
// canvas to "Graph" mode.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Sparkles, List as ListIcon, Network as NetworkIcon } from 'lucide-react';
import { rpc } from '@/renderer/lib/rpc';
import { cn } from '@/lib/utils';
import { useAppState } from '@/renderer/app/state';
import type { Memory } from '@/shared/types';
import { MemoryList } from './MemoryList';
import { MemoryEditor } from './MemoryEditor';
import { Backlinks } from './Backlinks';
import { MemoryGraphView } from './MemoryGraph';

type Tab = 'list' | 'graph';

export function MemoryRoom() {
  const { state, dispatch } = useAppState();
  const ws = state.activeWorkspace;
  const wsId = ws?.id ?? null;
  const memories = useMemo(() => (wsId ? state.memories[wsId] ?? [] : []), [state.memories, wsId]);
  const activeName = wsId ? state.activeMemoryName[wsId] ?? null : null;
  const graph = wsId ? state.memoryGraph[wsId] ?? null : null;

  const [tab, setTab] = useState<Tab>('list');
  const [graphLoading, setGraphLoading] = useState(false);

  const knownNames = useMemo(
    () => new Set(memories.map((m) => m.name.toLowerCase())),
    [memories],
  );
  const activeMemory = useMemo(
    () => memories.find((m) => m.name === activeName) ?? null,
    [memories, activeName],
  );

  // Hydrate the hub on first mount per workspace.
  useEffect(() => {
    if (!wsId) return;
    void rpc.memory.init_hub({ workspaceId: wsId }).catch(() => {
      /* non-fatal: GUI works without on-disk hub */
    });
  }, [wsId]);

  // Refresh graph whenever memories change AND the user is on the graph tab.
  useEffect(() => {
    if (!wsId || tab !== 'graph') return;
    let alive = true;
    setGraphLoading(true);
    void (async () => {
      try {
        const g = await rpc.memory.getGraph({ workspaceId: wsId });
        if (alive) {
          dispatch({ type: 'SET_MEMORY_GRAPH', workspaceId: wsId, graph: g });
        }
      } catch (err) {
        console.error('Failed to load graph:', err);
      } finally {
        if (alive) setGraphLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [tab, wsId, memories, dispatch]);

  const onSelect = useCallback(
    (name: string) => {
      if (!wsId) return;
      dispatch({ type: 'SET_ACTIVE_MEMORY', workspaceId: wsId, name });
    },
    [dispatch, wsId],
  );

  const onCreate = useCallback(
    async (name: string) => {
      if (!wsId) return;
      try {
        const created = await rpc.memory.create_memory({ workspaceId: wsId, name });
        dispatch({ type: 'UPSERT_MEMORY', workspaceId: wsId, memory: created });
        dispatch({ type: 'SET_ACTIVE_MEMORY', workspaceId: wsId, name: created.name });
      } catch (err) {
        window.alert((err as Error).message);
      }
    },
    [dispatch, wsId],
  );

  const onSaved = useCallback(
    (memory: Memory) => {
      if (!wsId) return;
      dispatch({ type: 'UPSERT_MEMORY', workspaceId: wsId, memory });
    },
    [dispatch, wsId],
  );

  const onDeleted = useCallback(
    (memoryId: string) => {
      if (!wsId) return;
      dispatch({ type: 'REMOVE_MEMORY', workspaceId: wsId, memoryId });
      dispatch({ type: 'SET_ACTIVE_MEMORY', workspaceId: wsId, name: null });
    },
    [dispatch, wsId],
  );

  const onGraphSelect = useCallback(
    (name: string) => {
      onSelect(name);
      setTab('list');
    },
    [onSelect],
  );

  if (!ws || !wsId) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Open a workspace to use Memory.
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-3 border-b border-border px-4 py-2">
        <Sparkles className="h-4 w-4 text-primary" />
        <h1 className="text-sm font-semibold">Memory</h1>
        <span className="text-xs text-muted-foreground">
          {memories.length} note{memories.length === 1 ? '' : 's'}
          {graph ? ` · ${graph.edges.length} link${graph.edges.length === 1 ? '' : 's'}` : ''}
        </span>
        <div className="ml-auto flex items-center gap-1 rounded border border-input bg-background p-0.5">
          <button
            type="button"
            onClick={() => setTab('list')}
            className={cn(
              'flex items-center gap-1 rounded px-2 py-1 text-xs',
              tab === 'list' ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-accent/40',
            )}
          >
            <ListIcon className="h-3.5 w-3.5" /> List
          </button>
          <button
            type="button"
            onClick={() => setTab('graph')}
            className={cn(
              'flex items-center gap-1 rounded px-2 py-1 text-xs',
              tab === 'graph' ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-accent/40',
            )}
          >
            <NetworkIcon className="h-3.5 w-3.5" /> Graph
          </button>
        </div>
      </header>
      {tab === 'list' ? (
        <div className="grid min-h-0 flex-1" style={{ gridTemplateColumns: '260px 1fr 280px' }}>
          <MemoryList
            memories={memories}
            workspaceId={wsId}
            activeName={activeName}
            onSelect={onSelect}
            onCreate={onCreate}
          />
          <MemoryEditor
            workspaceId={wsId}
            memory={activeMemory}
            knownNames={knownNames}
            onNavigate={onSelect}
            onSaved={onSaved}
            onDeleted={onDeleted}
          />
          <Backlinks
            workspaceId={wsId}
            noteName={activeName}
            memoriesVersion={memories.length + (activeMemory?.updatedAt ?? 0)}
            onSelect={onSelect}
          />
        </div>
      ) : (
        <div className="relative min-h-0 flex-1">
          {graph ? (
            <MemoryGraphView graph={graph} onSelect={onGraphSelect} />
          ) : (
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
              {graphLoading ? 'Loading graph…' : 'No notes yet.'}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
