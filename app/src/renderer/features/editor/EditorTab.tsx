// V3-W14-007 — Editor right-rail tab. 240px FileTree on the left, Monaco on
// the right. Monaco is lazy-loaded via React.lazy so it stays out of the
// initial bundle; if the chunk fails (or runtime-throws) we render a
// read-only <pre> fallback. Theme map: parchment → vs-light, all others
// → vs-dark. External callers focus a file by dispatching the
// `editor:focus` CustomEvent (see useEditor.ts).
//
// W-8 — Per-pane worktree browsing. A root selector above the FileTree lets
// the user switch between the workspace root, any open pane's worktreePath,
// or the "Follow focused pane" auto-mode. Selection persists in KV under
// `editor.<workspaceId>.rootSelection`. Save path-containment passes the
// active root so worktree edits are accepted by the fs.writeFile guard.

import {
  Component,
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from 'react';
import { AlertTriangle, ChevronDown, FileCode2, Save } from 'lucide-react';
import { useTheme } from '@/renderer/app/ThemeProvider';
import { useAppState } from '@/renderer/app/state';
import { EmptyState } from '@/renderer/components/EmptyState';
import { rpc } from '@/renderer/lib/rpc';
import type { AgentSession } from '@/shared/types';
import { FileTree } from './FileTree';
import {
  EDITOR_FOCUS_EVENT,
  useEditor,
  type EditorFocusDetail,
} from './useEditor';

type MonacoProps = {
  height?: string | number;
  language?: string;
  value?: string;
  theme?: string;
  onChange?: (value: string | undefined) => void;
  options?: Record<string, unknown>;
};

const MonacoLoader = lazy(async () => {
  const mod = await import('@monaco-editor/react');
  return { default: mod.default as ComponentType<MonacoProps> };
});

function themeToMonaco(themeId: string): 'vs-dark' | 'vs-light' {
  return themeId === 'parchment' ? 'vs-light' : 'vs-dark';
}

const LANG_MAP: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
  json: 'json', md: 'markdown', css: 'css', scss: 'scss', html: 'html',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
  c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp',
  yml: 'yaml', yaml: 'yaml', sh: 'shell', bash: 'shell', zsh: 'shell', sql: 'sql',
};

function languageForPath(p: string): string {
  const dot = p.toLowerCase().lastIndexOf('.');
  if (dot < 0) return 'plaintext';
  return LANG_MAP[p.toLowerCase().slice(dot + 1)] ?? 'plaintext';
}

const EDITOR_SIDEBAR_DEFAULT = 240;
const EDITOR_SIDEBAR_MIN = 160;
const EDITOR_SIDEBAR_MAX = 600;
const EDITOR_SIDEBAR_KV_KEY = 'editor.sidebar.width';

// W-8 — Root selection KV key template.
const ROOT_SELECTION_KV_KEY = (workspaceId: string) =>
  `editor.${workspaceId}.rootSelection`;

// W-8 — Possible persisted values for the root selector.
type RootSelection = 'workspace' | 'follow' | string; // string = specific worktreePath

export function EditorTab() {
  const { state } = useAppState();
  const { theme } = useTheme();
  const editor = useEditor();
  const [monacoBroken, setMonacoBroken] = useState(false);

  // v1.4.8 packet-02 — stateful sidebar width with kv persistence.
  const [sidebarWidth, setSidebarWidth] = useState<number>(EDITOR_SIDEBAR_DEFAULT);
  const isDragging = useRef(false);
  const rafHandle = useRef<number | null>(null);

  // W-8 — Root selector state. Default 'workspace' = zero behaviour change.
  const [rootSelection, setRootSelectionState] = useState<RootSelection>('workspace');

  useEffect(() => {
    void rpc.kv.get(EDITOR_SIDEBAR_KV_KEY).then((v) => {
      const n = Number(v);
      if (Number.isFinite(n) && n >= EDITOR_SIDEBAR_MIN && n <= EDITOR_SIDEBAR_MAX) {
        setSidebarWidth(n);
      }
    });
  }, []);

  const ws = state.activeWorkspace;

  // W-8 — Hydrate root selection from KV on workspace change.
  useEffect(() => {
    if (!ws) return;
    void rpc.kv.get(ROOT_SELECTION_KV_KEY(ws.id)).then((v) => {
      if (v === 'workspace' || v === 'follow' || (typeof v === 'string' && v.startsWith('/'))) {
        setRootSelectionState(v);
      } else {
        setRootSelectionState('workspace');
      }
    });
  }, [ws?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // W-8 — Persist root selection to KV whenever it changes.
  const setRootSelection = useCallback(
    (next: RootSelection) => {
      setRootSelectionState(next);
      if (ws) {
        void rpc.kv.set(ROOT_SELECTION_KV_KEY(ws.id), next);
      }
    },
    [ws],
  );

  // W-8 — Sessions for the active workspace that carry a worktreePath.
  const paneWorktrees = useMemo(() => {
    if (!ws) return [];
    return state.sessions
      .filter((s) => s.workspaceId === ws.id && s.worktreePath)
      // Deduplicate by worktreePath so multiple panes on the same branch show once.
      .reduce<typeof state.sessions>((acc, s) => {
        if (!acc.some((a) => a.worktreePath === s.worktreePath)) acc.push(s);
        return acc;
      }, []);
  }, [state.sessions, ws]);

  // W-8 — The session currently focused (by sigma:pty-focus / activeSessionId).
  const activeSession = useMemo(
    () => (state.activeSessionId
      ? state.sessions.find((s) => s.id === state.activeSessionId) ?? null
      : null),
    [state.sessions, state.activeSessionId],
  );

  // W-8 — Resolve the actual tree root from the selection.
  const treeRoot = useMemo((): string | null => {
    const wsRoot = ws?.repoRoot ?? ws?.rootPath ?? null;
    if (!ws || !wsRoot) return null;
    if (rootSelection === 'workspace') return wsRoot;
    if (rootSelection === 'follow') {
      // Use focused pane's worktree if it has one, else fall back to workspace root.
      return activeSession?.worktreePath ?? wsRoot;
    }
    // Explicit worktree path selected — verify it still exists in open panes.
    const stillOpen = paneWorktrees.some((s) => s.worktreePath === rootSelection);
    return stillOpen ? rootSelection : wsRoot;
  }, [ws, rootSelection, activeSession, paneWorktrees]);

  const startEditorSidebarDrag = useCallback(
    (ev: React.PointerEvent<HTMLDivElement>) => {
      ev.preventDefault();
      const startX = ev.clientX;
      const startWidth = sidebarWidth;
      isDragging.current = true;
      document.body.dataset.dragging = 'true';

      // `pending` holds the next value waiting for a rAF tick.
      // `committed` holds the last value we actually applied (for kv persist on up).
      let pending: number | null = null;
      let committed = startWidth;

      const flush = () => {
        if (pending !== null) {
          committed = pending;
          setSidebarWidth(pending);
        }
        pending = null;
        rafHandle.current = null;
      };

      const move = (e: PointerEvent) => {
        pending = Math.max(
          EDITOR_SIDEBAR_MIN,
          Math.min(EDITOR_SIDEBAR_MAX, startWidth + (e.clientX - startX)),
        );
        if (rafHandle.current === null) {
          rafHandle.current = requestAnimationFrame(flush);
        }
      };

      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        isDragging.current = false;
        delete document.body.dataset.dragging;
        // Flush any pending rAF synchronously on pointerup.
        if (rafHandle.current !== null) {
          cancelAnimationFrame(rafHandle.current);
          rafHandle.current = null;
          if (pending !== null) {
            committed = pending;
            setSidebarWidth(pending);
          }
        }
        pending = null;
        // Persist the final committed width to kv.
        void rpc.kv.set(EDITOR_SIDEBAR_KV_KEY, String(committed));
      };

      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    },
    [sidebarWidth],
  );

  // External "open this file" listener — lets chat/pane footers focus a file
  // path here without needing a direct ref.
  useEffect(() => {
    function onFocus(e: Event) {
      const detail = (e as CustomEvent<EditorFocusDetail>).detail;
      if (!detail?.path) return;
      void editor.open(detail.path);
    }
    window.addEventListener(EDITOR_FOCUS_EVENT, onFocus as EventListener);
    return () => window.removeEventListener(EDITOR_FOCUS_EVENT, onFocus as EventListener);
  }, [editor]);

  const handleOpen = useCallback(
    (path: string) => {
      void editor.open(path);
    },
    [editor],
  );

  // W-8 — Save must pass the active treeRoot (which may be a worktree path) so
  // the fs.writeFile containment guard accepts files under that worktree.
  const handleSave = useCallback(() => {
    if (!treeRoot) return;
    void editor.save(treeRoot);
  }, [editor, treeRoot]);

  // Cmd/Ctrl+S triggers save while focus is anywhere in the tab.
  useEffect(() => {
    function onKey(ev: KeyboardEvent) {
      const isSave = (ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 's';
      if (!isSave) return;
      if (!editor.dirty) return;
      ev.preventDefault();
      handleSave();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editor.dirty, handleSave]);

  const monacoTheme = themeToMonaco(theme);
  const language = useMemo(
    () => (editor.file ? languageForPath(editor.file.path) : 'plaintext'),
    [editor.file],
  );

  if (!ws || !treeRoot) {
    return (
      <div className="flex h-full min-h-0 flex-1 items-center justify-center p-4">
        <EmptyState
          icon={FileCode2}
          title="No workspace open"
          description="Open a workspace from the sidebar to browse and edit files here."
        />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-1 flex-row">
      <aside
        className="flex h-full min-h-0 shrink-0 flex-col bg-sidebar"
        style={{ width: sidebarWidth }}
        aria-label="File tree"
      >
        {/* W-8 — Root selector dropdown above the file tree. */}
        <RootSelector
          paneWorktrees={paneWorktrees}
          selection={rootSelection}
          onSelect={setRootSelection}
        />
        <FileTree
          workspaceId={ws.id}
          rootPath={treeRoot}
          selectedPath={editor.file?.path ?? null}
          onOpenFile={handleOpen}
        />
      </aside>
      {/* v1.4.8 packet-02 — 4px drag divider; border-r lives here so it
          doesn't move with the aside width. Double-click resets to default. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize file tree"
        className="w-1 shrink-0 cursor-col-resize border-r border-border hover:bg-accent active:bg-accent/70"
        onPointerDown={startEditorSidebarDrag}
        onDoubleClick={() => {
          setSidebarWidth(EDITOR_SIDEBAR_DEFAULT);
          void rpc.kv.set(EDITOR_SIDEBAR_KV_KEY, String(EDITOR_SIDEBAR_DEFAULT));
        }}
      />
      <section className="flex h-full min-h-0 flex-1 flex-col">
        <EditorHeader
          file={editor.file}
          dirty={editor.dirty}
          onSave={handleSave}
          canSave={!!treeRoot}
        />
        <div className="relative flex min-h-0 flex-1">
          {editor.error ? (
            <div className="m-auto max-w-md p-4 text-center text-xs text-destructive">
              <AlertTriangle className="mx-auto mb-2 h-5 w-5" />
              {editor.error}
            </div>
          ) : !editor.file ? (
            <div className="m-auto max-w-sm p-4 text-center text-xs text-muted-foreground">
              Select a file from the tree to start editing.
              <br />
              Click any file path in chat or a pane footer to focus it here.
            </div>
          ) : editor.file.encoding === 'binary' ? (
            <div className="m-auto max-w-sm p-4 text-center text-xs text-muted-foreground">
              Binary file — preview not supported.
            </div>
          ) : monacoBroken ? (
            <FallbackEditor value={editor.buffer} />
          ) : (
            <ErrorBoundary onError={() => setMonacoBroken(true)}>
              <Suspense
                fallback={<div className="m-auto text-xs text-muted-foreground">Loading editor…</div>}
              >
                <MonacoLoader
                  height="100%"
                  language={language}
                  value={editor.buffer}
                  theme={monacoTheme}
                  onChange={(v) => editor.setBuffer(v ?? '')}
                  options={{
                    minimap: { enabled: false },
                    fontSize: 12,
                    wordWrap: 'on',
                    automaticLayout: true,
                    scrollBeyondLastLine: false,
                    smoothScrolling: true,
                    renderWhitespace: 'selection',
                  }}
                />
              </Suspense>
            </ErrorBoundary>
          )}
        </div>
        {editor.file?.truncated ? (
          <div className="border-t border-border bg-amber-500/10 px-3 py-1 text-[11px] text-amber-600">
            File truncated at 8 MiB. Save will write only the loaded portion.
          </div>
        ) : null}
      </section>
    </div>
  );
}

// W-8 — Root selector component. Lists workspace root, each open pane's
// worktreePath, and the "Follow focused pane" auto-mode option.
function RootSelector({
  paneWorktrees,
  selection,
  onSelect,
}: {
  paneWorktrees: AgentSession[];
  selection: RootSelection;
  onSelect: (v: RootSelection) => void;
}) {
  // Only render the selector when there are pane worktrees to show.
  if (paneWorktrees.length === 0) return null;

  // Derive a short label for a worktree path: provider · branch.
  function paneLabel(s: AgentSession): string {
    const branch = s.branch ?? s.worktreePath?.split('/').pop() ?? 'worktree';
    return `${s.providerId} · ${branch}`;
  }

  // Human-readable label for the current selection.
  function currentLabel(): string {
    if (selection === 'workspace') return 'Workspace root';
    if (selection === 'follow') return 'Follow focused pane';
    const found = paneWorktrees.find((s) => s.worktreePath === selection);
    return found ? paneLabel(found) : 'Workspace root';
  }

  return (
    <div className="border-b border-border px-2 py-1">
      <label className="sr-only" htmlFor="editor-root-selector">
        File tree root
      </label>
      <div className="relative">
        <select
          id="editor-root-selector"
          value={selection}
          onChange={(e) => onSelect(e.target.value as RootSelection)}
          aria-label="File tree root"
          className="w-full appearance-none truncate rounded bg-transparent py-0.5 pl-1 pr-5 text-[11px] text-muted-foreground hover:bg-accent/30 focus:outline-none cursor-pointer"
          title={currentLabel()}
        >
          <option value="workspace">Workspace root</option>
          <option value="follow">Follow focused pane</option>
          {paneWorktrees.map((s) => (
            <option key={s.id} value={s.worktreePath!}>
              {paneLabel(s)}
            </option>
          ))}
        </select>
        <ChevronDown
          className="pointer-events-none absolute right-1 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
      </div>
    </div>
  );
}

function EditorHeader({
  file,
  dirty,
  onSave,
  canSave,
}: {
  file: ReturnType<typeof useEditor>['file'];
  dirty: boolean;
  onSave: () => void;
  canSave: boolean;
}) {
  return (
    <div className="flex items-center justify-between border-b border-border bg-sidebar px-2 py-1">
      <div className="flex min-w-0 items-center gap-2">
        <FileCode2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="truncate text-[11px] text-muted-foreground" title={file?.path ?? ''}>
          {file?.path ?? '(no file open)'}
        </span>
        {dirty ? (
          <span
            className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-amber-500"
            aria-label="Unsaved changes"
            title="Unsaved changes"
          />
        ) : null}
      </div>
      <button
        type="button"
        onClick={onSave}
        disabled={!file || !dirty || !canSave}
        className="flex items-center gap-1 rounded px-2 py-0.5 text-[11px] text-muted-foreground transition hover:bg-accent/40 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
        title={canSave ? 'Save (⌘S / Ctrl+S)' : 'Save disabled — workspace has no repo root'}
      >
        <Save className="h-3 w-3" />
        Save
      </button>
    </div>
  );
}

/** Read-only fallback when Monaco fails. Line-numbered <pre>, no editing. */
function FallbackEditor({ value }: { value: string }) {
  const lines = value.split('\n');
  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div className="border-b border-border bg-amber-500/10 px-3 py-1 text-[11px] text-amber-600">
        Monaco unavailable — read-only fallback active.
      </div>
      <div className="flex flex-1 overflow-auto font-mono text-[12px] leading-5">
        <div
          aria-hidden
          className="select-none bg-muted/40 px-2 py-2 text-right text-muted-foreground"
        >
          {lines.map((_, i) => (
            <div key={i}>{i + 1}</div>
          ))}
        </div>
        <pre className="m-0 flex-1 whitespace-pre overflow-auto px-2 py-2">{value}</pre>
      </div>
    </div>
  );
}

// Tiny error boundary so a Monaco runtime error doesn't blank the whole tab —
// the parent swaps to FallbackEditor when `onError` fires.
interface ErrorBoundaryProps { children: ReactNode; onError: () => void; }
class ErrorBoundary extends Component<ErrorBoundaryProps, { hasError: boolean }> {
  state = { hasError: false };
  static getDerivedStateFromError() { return { hasError: true }; }
  componentDidCatch() { this.props.onError(); }
  render() { return this.state.hasError ? null : this.props.children; }
}
