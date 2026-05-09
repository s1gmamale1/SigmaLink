// V3-W14-007 — Editor right-rail tab. 240px FileTree on the left, Monaco on
// the right. Monaco is lazy-loaded via React.lazy so it stays out of the
// initial bundle; if the chunk fails (or runtime-throws) we render a
// read-only <pre> fallback. Theme map: parchment → vs-light, all others
// → vs-dark. External callers focus a file by dispatching the
// `editor:focus` CustomEvent (see useEditor.ts).

import {
  Component,
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ComponentType,
  type ReactNode,
} from 'react';
import { AlertTriangle, FileCode2, Save } from 'lucide-react';
import { useTheme } from '@/renderer/app/ThemeProvider';
import { useAppState } from '@/renderer/app/state';
import { EmptyState } from '@/renderer/components/EmptyState';
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

export function EditorTab() {
  const { state } = useAppState();
  const { theme } = useTheme();
  const editor = useEditor();
  const [monacoBroken, setMonacoBroken] = useState(false);

  const ws = state.activeWorkspace;
  const treeRoot = ws?.repoRoot ?? ws?.rootPath ?? null;

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

  const handleSave = useCallback(() => {
    if (!ws?.repoRoot) return;
    void editor.save(ws.repoRoot);
  }, [editor, ws]);

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
        className="flex h-full min-h-0 shrink-0 flex-col border-r border-border bg-sidebar"
        style={{ width: 240 }}
        aria-label="File tree"
      >
        <FileTree
          workspaceId={ws.id}
          rootPath={treeRoot}
          selectedPath={editor.file?.path ?? null}
          onOpenFile={handleOpen}
        />
      </aside>
      <section className="flex h-full min-h-0 flex-1 flex-col">
        <EditorHeader
          file={editor.file}
          dirty={editor.dirty}
          onSave={handleSave}
          canSave={!!ws.repoRoot}
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
