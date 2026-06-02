// Memory room — three tabs (List view = list+editor+backlinks, Graph view).
// We keep the list / editor / backlinks visible in "List" mode (per the U7
// critique: list-first, graph as a secondary tab) and dedicate the full
// canvas to "Graph" mode.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Sparkles, List as ListIcon, Network as NetworkIcon } from 'lucide-react';
import { rpc } from '@/renderer/lib/rpc';
import { cn } from '@/lib/utils';
import { useAppState } from '@/renderer/app/state';
import { EmptyState } from '@/renderer/components/EmptyState';
import { ErrorBanner } from '@/renderer/components/ErrorBanner';
import { Spinner } from '@/components/ui/spinner';
import type { Memory, MemoryGraph, RufloEntry } from '@/shared/types';
import { MemoryList } from './MemoryList';
import { MemoryEditor } from './MemoryEditor';
import { Backlinks } from './Backlinks';
import { MemoryGraphView, type MemoryGraphNodeSelection } from './MemoryGraph';
import { useRufloGraphOverlay } from './useRufloGraphOverlay';

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
  const [createError, setCreateError] = useState<string | null>(null);
  // P4 MEM-1 — when a Ruflo (agent-memory) graph node is opened, the editor
  // column shows it as a read-only virtual note instead of the active note.
  const [rufloView, setRufloView] = useState<RufloEntry | null>(null);

  const knownNames = useMemo(
    () => new Set(memories.map((m) => m.name.toLowerCase())),
    [memories],
  );
  const activeMemory = useMemo(
    () => memories.find((m) => m.name === activeName) ?? null,
    [memories, activeName],
  );

  // P4 MEM-1 — Ruflo AgentDB overlay (read-only nodes/edges). Active only on the
  // graph tab; the context query is the open note's name so the agent-memory
  // shown is semantically related to what the operator is looking at. Degrades
  // to empty when Ruflo is offline.
  const rufloOverlay = useRufloGraphOverlay({
    workspaceId: wsId ?? '',
    contextQuery: activeName ?? ws?.name ?? '',
    enabled: tab === 'graph' && !!wsId,
  });

  // Merge the local note graph (kind:'note') with the Ruflo overlay for the canvas.
  const mergedGraph = useMemo<MemoryGraph | null>(() => {
    if (!graph && rufloOverlay.nodes.length === 0) return null;
    const localNodes = (graph?.nodes ?? []).map((n) => ({ ...n, kind: n.kind ?? ('note' as const) }));
    const localEdges = (graph?.edges ?? []).map((e) => ({ ...e, kind: e.kind ?? ('wikilink' as const) }));
    return {
      nodes: [...localNodes, ...rufloOverlay.nodes],
      edges: [...localEdges, ...rufloOverlay.edges],
    };
  }, [graph, rufloOverlay.nodes, rufloOverlay.edges]);

  // A read-only Memory-shaped projection of the opened Ruflo entry for the editor.
  const rufloViewMemory = useMemo<Memory | null>(() => {
    if (!rufloView || !wsId) return null;
    return {
      id: rufloView.id,
      workspaceId: wsId,
      name: rufloView.id,
      body: rufloView.text,
      tags: [],
      links: [],
      createdAt: rufloView.createdAt ?? 0,
      updatedAt: rufloView.createdAt ?? 0,
      frontmatter: null,
    };
  }, [rufloView, wsId]);

  // P4 MEM-1 — clear the read-only Ruflo view when the workspace changes, so a
  // virtual note opened in workspace A never lingers (stale) under workspace B.
  // queueMicrotask defers the set out of the effect body (react-hooks/set-state-
  // in-effect), matching the graph-loading effect's pattern below.
  useEffect(() => {
    queueMicrotask(() => setRufloView(null));
  }, [wsId]);

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
    queueMicrotask(() => setGraphLoading(true));
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
      setRufloView(null); // selecting a real note exits the read-only Ruflo view
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
        setCreateError((err as Error).message);
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

  // P4 MEM-1 — graph node click. Local notes open by name; Ruflo nodes open
  // their full entry as a read-only virtual note in the editor column.
  const onGraphSelectNode = useCallback(
    (node: MemoryGraphNodeSelection) => {
      if (node.kind === 'ruflo') {
        const entry = rufloOverlay.entriesById[node.id];
        if (entry) {
          setRufloView(entry);
          setTab('list');
        }
        return;
      }
      onGraphSelect(node.label);
    },
    [onGraphSelect, rufloOverlay.entriesById],
  );

  if (!ws || !wsId) {
    return (
      <EmptyState
        icon={Sparkles}
        title="Open a workspace to use Memory"
        description="Notes, backlinks, and the memory graph are scoped per workspace."
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {createError ? (
        <ErrorBanner
          message={createError}
          onDismiss={() => setCreateError(null)}
        />
      ) : null}
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
        <div className="memory-tri-grid grid min-h-0 flex-1">
          <MemoryList
            memories={memories}
            workspaceId={wsId}
            activeName={activeName}
            onSelect={onSelect}
            onCreate={onCreate}
          />
          {rufloView && rufloViewMemory ? (
            <MemoryEditor
              workspaceId={wsId}
              memory={rufloViewMemory}
              knownNames={knownNames}
              onNavigate={onSelect}
              onSaved={onSaved}
              onDeleted={onDeleted}
              readOnly
              readOnlyMeta={{ namespace: rufloView.namespace, score: rufloView.score }}
            />
          ) : (
            <MemoryEditor
              workspaceId={wsId}
              memory={activeMemory}
              knownNames={knownNames}
              onNavigate={onSelect}
              onSaved={onSaved}
              onDeleted={onDeleted}
            />
          )}
          <Backlinks
            workspaceId={wsId}
            noteName={activeName}
            memoriesVersion={memories.length + (activeMemory?.updatedAt ?? 0)}
            onSelect={onSelect}
          />
        </div>
      ) : (
        <div className="relative min-h-0 flex-1">
          {graphLoading ? (
            <div className="flex h-full items-center justify-center">
              <Spinner />
            </div>
          ) : mergedGraph ? (
            <MemoryGraphView
              graph={mergedGraph}
              onSelect={onGraphSelect}
              onSelectNode={onGraphSelectNode}
            />
          ) : (
            <EmptyState
              icon={NetworkIcon}
              title="No notes yet"
              description="Create notes in the List tab to build your memory graph."
            />
          )}
        </div>
      )}
    </div>
  );
}
