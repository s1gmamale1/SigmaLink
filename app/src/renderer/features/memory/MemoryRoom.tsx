// Memory room — three tabs (List view = list+editor+backlinks, Graph view).
// We keep the list / editor / backlinks visible in "List" mode (per the U7
// critique: list-first, graph as a secondary tab) and dedicate the full
// canvas to "Graph" mode.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Sparkles, List as ListIcon, Network as NetworkIcon, CalendarDays } from 'lucide-react';
import { rpc } from '@/renderer/lib/rpc';
import { cn } from '@/lib/utils';
import { bindShortcut } from '@/renderer/lib/shortcuts';
import { useAppState } from '@/renderer/app/state';
import { useBelowBreakpoint } from '@/renderer/lib/use-breakpoint';
import { readWorkspaceUi, writeWorkspaceUi } from '@/renderer/lib/workspace-ui-kv';
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from '@/components/ui/resizable';
import { EmptyState } from '@/renderer/components/EmptyState';
import { ErrorBanner } from '@/renderer/components/ErrorBanner';
import { Spinner } from '@/components/ui/spinner';
import type { Memory, MemoryGraph, RufloEntry } from '@/shared/types';
import { MemoryList } from './MemoryList';
import { MemoryEditor } from './MemoryEditor';
import { Backlinks } from './Backlinks';
import { MemoryGraphView, type MemoryGraphNodeSelection } from './MemoryGraph';
import { useRufloGraphOverlay } from './useRufloGraphOverlay';
import { TagsPane } from './TagsPane';
import { MemoryAssistPanel } from './MemoryAssistPanel';
import { MemoryQuickSwitcher } from './MemoryQuickSwitcher';
import { openDailyNote } from './daily-note';

type Tab = 'list' | 'graph';

// RSP-1 — the list tab is a horizontal resizable tri-column. Stable panel ids
// key the persisted layout; the order [left, editor, right] is the array order
// stored under `memory.cols`.
const MEMORY_COLS_PANEL = 'memory.cols';
const PANEL_LEFT = 'mem-left';
const PANEL_EDITOR = 'mem-editor';
const PANEL_RIGHT = 'mem-right';
/** Default percentages [left, editor, right]; editor is the largest primary. */
const DEFAULT_COLS: [number, number, number] = [22, 56, 22];
const PERSIST_DEBOUNCE_MS = 400;

/** Parse a stored `JSON.stringify(number[])` of exactly 3 finite sizes; else
 *  fall back to the defaults so a corrupt/legacy value never breaks layout. */
function parseCols(raw: string | null): [number, number, number] {
  if (!raw) return DEFAULT_COLS;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      Array.isArray(parsed) &&
      parsed.length === 3 &&
      parsed.every((n) => typeof n === 'number' && Number.isFinite(n) && n > 0)
    ) {
      return [parsed[0], parsed[1], parsed[2]] as [number, number, number];
    }
  } catch {
    /* fall through to defaults */
  }
  return DEFAULT_COLS;
}

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
  // P4 MEM-3 — active tag filter (null = all). P4 MEM-4 — ⌘O quick switcher.
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [switcherOpen, setSwitcherOpen] = useState(false);

  // RSP-1 — narrow viewports stack the list tab to a single (editor) column,
  // matching the prior 900px CSS collapse — now driven by the shared hook.
  const isNarrow = useBelowBreakpoint('narrow');

  // RSP-1 — per-workspace resizable column sizes. `null` until hydrated; we
  // render the body full-bleed (default layout) until then so there's no flash
  // (mirrors the async-hydrate-then-render guard used by the rail/sidebar).
  const [cols, setCols] = useState<[number, number, number] | null>(null);
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Re-hydrate the column layout whenever the workspace changes. The reset to
  // `null` (unhydrated) is deferred via queueMicrotask out of the effect body —
  // matching the rufloView/graph-loading effects above — so B never flashes A's
  // layout and the resizable group remounts with B's persisted sizes.
  useEffect(() => {
    if (!wsId) return;
    let alive = true;
    queueMicrotask(() => {
      if (alive) setCols(null);
    });
    void (async () => {
      const raw = await readWorkspaceUi(wsId, MEMORY_COLS_PANEL);
      if (alive) setCols(parseCols(raw));
    })();
    return () => {
      alive = false;
    };
  }, [wsId]);

  // Debounced persist of a layout change (best-effort, per workspace).
  const persistCols = useCallback(
    (next: [number, number, number]) => {
      if (!wsId) return;
      if (persistTimer.current) clearTimeout(persistTimer.current);
      persistTimer.current = setTimeout(() => {
        void writeWorkspaceUi(wsId, MEMORY_COLS_PANEL, JSON.stringify(next));
      }, PERSIST_DEBOUNCE_MS);
    },
    [wsId],
  );

  // Clear any pending debounce on unmount.
  useEffect(
    () => () => {
      if (persistTimer.current) clearTimeout(persistTimer.current);
    },
    [],
  );

  const knownNames = useMemo(
    () => new Set(memories.map((m) => m.name.toLowerCase())),
    [memories],
  );

  // P4 MEM-3 — note list filtered by the active tag (the switcher still searches all).
  const visibleMemories = useMemo(
    () => (activeTag ? memories.filter((m) => m.tags.includes(activeTag)) : memories),
    [memories, activeTag],
  );
  const activeMemory = useMemo(
    () => memories.find((m) => m.name === activeName) ?? null,
    [memories, activeName],
  );
  // Refresh signal for TagsPane / MemoryAssistPanel. Bumps on ANY note's update
  // (count + max updatedAt) — review L3: a tag edit on a NON-active note (e.g. via
  // sync/agent) must still refresh the tag counts, which `activeMemory.updatedAt` missed.
  const memVersion = useMemo(
    () => memories.length + memories.reduce((mx, m) => Math.max(mx, m.updatedAt), 0),
    [memories],
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

  // Merge the local note graph (kind:'note') with the Ruflo overlay for the
  // canvas. When a tag filter is active, the local graph is narrowed to notes
  // carrying that tag (Ruflo nodes are always kept — they aren't tag-scoped),
  // and edges to dropped nodes are pruned, so a tag click filters the graph too.
  const mergedGraph = useMemo<MemoryGraph | null>(() => {
    if (!graph && rufloOverlay.nodes.length === 0) return null;
    let localNodes = (graph?.nodes ?? []).map((n) => ({ ...n, kind: n.kind ?? ('note' as const) }));
    let localEdges = (graph?.edges ?? []).map((e) => ({ ...e, kind: e.kind ?? ('wikilink' as const) }));
    if (activeTag) {
      const tagged = new Set(memories.filter((m) => m.tags.includes(activeTag)).map((m) => m.id));
      localNodes = localNodes.filter((n) => tagged.has(n.id));
      localEdges = localEdges.filter((e) => tagged.has(e.from) && tagged.has(e.to));
    }
    return {
      nodes: [...localNodes, ...rufloOverlay.nodes],
      edges: [...localEdges, ...rufloOverlay.edges],
    };
  }, [graph, rufloOverlay.nodes, rufloOverlay.edges, memories, activeTag]);

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
    queueMicrotask(() => {
      setRufloView(null);
      setActiveTag(null); // review L1 — don't carry a tag filter across workspaces (would empty B's list)
    });
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

  // P4 MEM-4 — ⌘O opens the quick switcher (active while the Memory room is mounted).
  useEffect(() => bindShortcut('mod+o', (e) => {
    e.preventDefault();
    setSwitcherOpen(true);
  }), []);

  // P4 MEM-2 — open (or idempotently create) today's daily note.
  const onOpenDaily = useCallback(async () => {
    if (!wsId) return;
    try {
      const note = await openDailyNote(wsId, new Date(), {
        create: (input) => rpc.memory.create_memory(input),
        read: (input) => rpc.memory.read_memory(input),
      });
      dispatch({ type: 'UPSERT_MEMORY', workspaceId: wsId, memory: note });
      onSelect(note.name);
      setTab('list');
    } catch (err) {
      setCreateError((err as Error).message);
    }
  }, [wsId, dispatch, onSelect]);

  // Quick-switcher selection handlers.
  const onSwitcherNote = useCallback(
    (name: string) => {
      onSelect(name);
      setTab('list');
      setSwitcherOpen(false);
    },
    [onSelect],
  );
  const onSwitcherRuflo = useCallback((entry: RufloEntry) => {
    setRufloView(entry);
    setTab('list');
    setSwitcherOpen(false);
  }, []);

  if (!ws || !wsId) {
    return (
      <EmptyState
        icon={Sparkles}
        title="Open a workspace to use Memory"
        description="Notes, backlinks, and the memory graph are scoped per workspace."
      />
    );
  }

  // RSP-1 — the three list-tab regions, extracted once so the resizable
  // (wide) and single-column (narrow) layouts share identical children. The
  // editor preserves its `rufloView ? read-only : normal` branch verbatim.
  const leftRegion = (
    <div className="flex min-h-0 flex-col overflow-hidden h-full">
      {/* P4 MEM-3 — tag facets above the note list; clicking filters both. */}
      <TagsPane
        workspaceId={wsId}
        activeTag={activeTag}
        onTagClick={setActiveTag}
        refreshKey={memVersion}
      />
      <div className="min-h-0 flex-1">
        <MemoryList
          memories={visibleMemories}
          workspaceId={wsId}
          activeName={activeName}
          onSelect={onSelect}
          onCreate={onCreate}
        />
      </div>
    </div>
  );

  const editorRegion =
    rufloView && rufloViewMemory ? (
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
    );

  const rightRegion = (
    <div className="flex min-h-0 flex-col overflow-y-auto h-full">
      <Backlinks
        workspaceId={wsId}
        noteName={activeName}
        memoriesVersion={memVersion}
        onSelect={onSelect}
      />
      {/* P4 MEM-6 — surface the shipped orphans + suggested-connections. */}
      <MemoryAssistPanel
        workspaceId={wsId}
        activeName={activeName}
        onSelect={onSelect}
        refreshKey={memVersion}
      />
    </div>
  );

  // Build the list-tab body for the current viewport / hydration state.
  // - Narrow: stack to a single (editor) column — reproduces the prior 900px
  //   CSS collapse via the shared breakpoint hook (no resizable group).
  // - Wide, not-yet-hydrated (`cols === null`): render a neutral full-bleed
  //   placeholder so there's no flash AND so the three regions mount EXACTLY
  //   ONCE — inside the group — rather than mounting in a default tree and
  //   then remounting when hydration swaps in the group (a remount would reset
  //   child-owned state such as the note-list create dialog). The resizable
  //   group's mount-time `defaultSize`s thus reflect the persisted layout.
  // - Wide, hydrated: the horizontal resizable tri-column persisted per workspace.
  let listBody: ReactNode;
  if (isNarrow) {
    listBody = (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{editorRegion}</div>
    );
  } else if (cols === null) {
    listBody = <div className="min-h-0 flex-1" aria-hidden />;
  } else {
    listBody = (
      <ResizablePanelGroup
        orientation="horizontal"
        className="min-h-0 flex-1"
        onLayoutChanged={(layout) => {
          const left = layout[PANEL_LEFT];
          const editor = layout[PANEL_EDITOR];
          const right = layout[PANEL_RIGHT];
          if (
            Number.isFinite(left) &&
            Number.isFinite(editor) &&
            Number.isFinite(right)
          ) {
            persistCols([left, editor, right]);
          }
        }}
      >
        <ResizablePanel
          id={PANEL_LEFT}
          defaultSize={cols[0]}
          minSize={14}
          collapsible
          collapsedSize={0}
          className="flex min-h-0 flex-col"
        >
          {leftRegion}
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel
          id={PANEL_EDITOR}
          defaultSize={cols[1]}
          minSize={30}
          className="flex min-h-0 flex-col"
        >
          {editorRegion}
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel
          id={PANEL_RIGHT}
          defaultSize={cols[2]}
          minSize={14}
          collapsible
          collapsedSize={0}
          className="flex min-h-0 flex-col"
        >
          {rightRegion}
        </ResizablePanel>
      </ResizablePanelGroup>
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
        <button
          type="button"
          onClick={() => void onOpenDaily()}
          className="ml-auto flex items-center gap-1 rounded border border-input bg-background px-2 py-1 text-xs text-muted-foreground hover:bg-accent/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-testid="memory-daily-note"
          title="Open today's daily note"
        >
          <CalendarDays className="h-3.5 w-3.5" /> Today
        </button>
        <div className="flex items-center gap-1 rounded border border-input bg-background p-0.5">
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
        listBody
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
      {/* P4 MEM-4 — ⌘O quick switcher (searches ALL notes + agent memory). */}
      <MemoryQuickSwitcher
        open={switcherOpen}
        onOpenChange={setSwitcherOpen}
        memories={memories}
        onSelectNote={onSwitcherNote}
        onSelectRuflo={onSwitcherRuflo}
      />
    </div>
  );
}
