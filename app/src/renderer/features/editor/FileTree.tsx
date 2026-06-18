// V3-W14-007 — Recursive file tree for the Editor tab. Roots at the active
// workspace's repoRoot (or rootPath for plain folders). Directory contents
// load lazily; expanded paths persist per root as
// `editor.<workspaceId>.<encodedRoot>.expandedPaths` so that switching to a
// different tree root (W-8 worktree browsing) does not bleed expansion state.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  FilePlus,
  FolderPlus,
  RefreshCw,
} from 'lucide-react';
import { rpc, rpcSilent } from '@/renderer/lib/rpc';
import { fsPath, isDescendant } from './fs-path';
import { useFileMutations } from './useFileMutations';
import { PromptDialog } from '@/components/ui/prompt-dialog';
import { TreeNode, type DirEntry } from './FileTreeNode';

interface Props {
  workspaceId: string;
  rootPath: string;
  selectedPath: string | null;
  onOpenFile: (path: string) => void;
}

const KV_PREFIX = 'editor.';
const KV_SUFFIX = '.expandedPaths';

// W-8 — Include rootPath in the KV key so different tree roots (workspace root
// vs. pane worktrees) maintain independent expansion state. The rootPath is
// URL-encoded to strip path separators from the key string.
function kvKey(workspaceId: string, rootPath: string): string {
  const encodedRoot = encodeURIComponent(rootPath);
  return `${KV_PREFIX}${workspaceId}.${encodedRoot}${KV_SUFFIX}`;
}

// Remount-on-workspace-change wrapper. Keying the inner component gives us a
// clean state reset without setState-in-effect (a React 19 anti-pattern).
export function FileTree(props: Props) {
  return <FileTreeInner key={`${props.workspaceId}::${props.rootPath}`} {...props} />;
}

type DialogState =
  | { mode: 'newFile'; dir: string }
  | { mode: 'newFolder'; dir: string }
  | { mode: 'rename'; path: string; currentName: string };

function FileTreeInner({ workspaceId, rootPath, selectedPath, onOpenFile }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([rootPath]));
  const [childrenByPath, setChildren] = useState<Map<string, DirEntry[]>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const hydratedRef = useRef(false);
  // In-flight paths live in a ref so the load-kicker effect never triggers a
  // re-render itself; "Loading…" is derived from expanded ∖ childrenByPath.
  const inFlightRef = useRef<Set<string>>(new Set());

  const mutations = useFileMutations();
  const [dialog, setDialog] = useState<DialogState | null>(null);

  useEffect(() => {
    let alive = true;
    hydratedRef.current = false;
    void (async () => {
      try {
        const raw = await rpcSilent.kv.get(kvKey(workspaceId, rootPath));
        if (!alive) return;
        if (raw) {
          const parsed = JSON.parse(raw) as unknown;
          if (Array.isArray(parsed)) {
            const next = new Set<string>([rootPath]);
            for (const p of parsed) {
              if (typeof p === 'string') next.add(p);
            }
            setExpanded(next);
          }
        }
      } catch {
        /* ignore — corrupt kv falls back to root-only expansion */
      } finally {
        if (alive) hydratedRef.current = true;
      }
    })();
    return () => {
      alive = false;
    };
  }, [workspaceId, rootPath]);

  // Lazy-load children when an expanded path has none cached.
  useEffect(() => {
    let alive = true;
    const need: string[] = [];
    for (const p of expanded) {
      if (!childrenByPath.has(p) && !inFlightRef.current.has(p)) need.push(p);
    }
    if (need.length === 0) return;
    for (const p of need) inFlightRef.current.add(p);
    void Promise.all(
      need.map(async (p) => {
        try {
          const res = await rpc.fs.readDir({ path: p });
          return [p, res.entries] as const;
        } catch (err) {
          if (alive) {
            setError(err instanceof Error ? err.message : String(err));
          }
          return [p, [] as DirEntry[]] as const;
        }
      }),
    ).then((results) => {
      for (const [p] of results) inFlightRef.current.delete(p);
      if (!alive) return;
      setChildren((prev) => {
        const next = new Map(prev);
        for (const [p, entries] of results) next.set(p, entries);
        return next;
      });
    });
    return () => {
      alive = false;
    };
  }, [expanded, childrenByPath]);

  // Persist expanded set whenever it changes (after hydrate).
  useEffect(() => {
    if (!hydratedRef.current) return;
    const arr = Array.from(expanded);
    void rpcSilent.kv.set(kvKey(workspaceId, rootPath), JSON.stringify(arr)).catch(() => undefined);
  }, [expanded, workspaceId, rootPath]);

  const toggle = useCallback((p: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  }, []);

  const refreshRoot = useCallback(() => {
    setChildren(new Map());
  }, []);

  // Invalidate one directory's cached listing; the lazy-load effect refetches
  // because the path is still in `expanded` but no longer in childrenByPath.
  const refreshDir = useCallback((dir: string) => {
    setChildren((prev) => {
      if (!prev.has(dir)) return prev;
      const next = new Map(prev);
      next.delete(dir);
      return next;
    });
  }, []);

  const openNewFile = useCallback((dir: string) => setDialog({ mode: 'newFile', dir }), []);
  const openNewFolder = useCallback((dir: string) => setDialog({ mode: 'newFolder', dir }), []);
  const openRename = useCallback(
    (path: string, currentName: string) => setDialog({ mode: 'rename', path, currentName }),
    [],
  );

  const handleDelete = useCallback(
    async (path: string) => {
      const ok = await mutations.trash(path);
      if (ok) refreshDir(fsPath.dirname(path));
    },
    [mutations, refreshDir],
  );

  const [dragOverDir, setDragOverDir] = useState<string | null>(null);

  const onDropMove = useCallback(
    async (destDir: string, e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragOverDir(null);
      const raw = e.dataTransfer.getData('application/sigmalink-file');
      if (!raw) return;
      let source: string;
      try {
        source = (JSON.parse(raw) as { absolutePath?: string }).absolutePath ?? '';
      } catch {
        return;
      }
      if (!source) return;
      // Guards: self, current-parent (no-op), into own subtree.
      if (source === destDir) return;
      if (fsPath.dirname(source) === destDir) return;
      if (isDescendant(destDir, source)) return;
      const moved = await mutations.move(source, destDir);
      if (moved) {
        refreshDir(fsPath.dirname(source));
        refreshDir(destDir);
        setExpanded((prev) => new Set(prev).add(destDir));
      }
    },
    [mutations, refreshDir],
  );

  // Reject leaf names that contain separators or are dot-only (UX guard; the
  // backend containment is the real boundary). Stable ref so it can be a
  // dependency of handleDialogConfirm without re-creating the callback.
  const validName = useCallback(
    (name: string) =>
      name.trim().length > 0 && !/[\\/]/.test(name) && name !== '.' && name !== '..',
    [],
  );

  const handleDialogConfirm = useCallback(
    async (raw: string) => {
      const name = raw.trim();
      // Snapshot the state value for narrowing — async callbacks can't narrow
      // React state variables directly in some TS versions.
      const d = dialog;
      if (!d) return;
      if (d.mode !== 'rename' && !validName(name)) return;
      if (d.mode === 'newFile') {
        const created = await mutations.createFile(d.dir, name);
        if (created) {
          refreshDir(d.dir);
          setExpanded((prev) => new Set(prev).add(d.dir));
          onOpenFile(created);
        }
      } else if (d.mode === 'newFolder') {
        const created = await mutations.createFolder(d.dir, name);
        if (created) {
          refreshDir(d.dir);
          setExpanded((prev) => new Set(prev).add(d.dir).add(created));
        }
      } else {
        if (!validName(name) || name === d.currentName) return;
        const moved = await mutations.rename(d.path, name);
        if (moved) refreshDir(fsPath.dirname(d.path));
      }
    },
    [dialog, mutations, refreshDir, onOpenFile, validName],
  );

  const rootName = useMemo(() => fsPath.basename(rootPath) || rootPath, [rootPath]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-border px-2 py-1.5">
        <div className="truncate text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {rootName}
        </div>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => openNewFile(rootPath)}
            className="rounded p-1 text-muted-foreground hover:bg-accent/40 hover:text-foreground"
            aria-label="New file"
            title="New file"
          >
            <FilePlus className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={() => openNewFolder(rootPath)}
            className="rounded p-1 text-muted-foreground hover:bg-accent/40 hover:text-foreground"
            aria-label="New folder"
            title="New folder"
          >
            <FolderPlus className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={refreshRoot}
            className="rounded p-1 text-muted-foreground hover:bg-accent/40 hover:text-foreground"
            aria-label="Refresh file tree"
            title="Refresh"
          >
            <RefreshCw className="h-3 w-3" />
          </button>
        </div>
      </div>
      <div
        role="tree"
        aria-label="Workspace files"
        className="flex-1 overflow-auto py-1 text-sm"
        onDragOver={(e) => { e.preventDefault(); }}
        onDrop={(e) => onDropMove(rootPath, e)}
      >
        <TreeNode
          fullPath={rootPath}
          name={rootName}
          type="dir"
          depth={0}
          expanded={expanded}
          childrenByPath={childrenByPath}
          selectedPath={selectedPath}
          onToggle={toggle}
          onOpen={onOpenFile}
          onNewFile={openNewFile}
          onNewFolder={openNewFolder}
          onRename={openRename}
          onDelete={handleDelete}
          workspaceId={workspaceId}
          rootPath={rootPath}
          onMoveInto={onDropMove}
          dragOverDir={dragOverDir}
          onDragOverDir={setDragOverDir}
        />
        {error ? (
          <div className="px-2 py-1 text-[11px] text-destructive">{error}</div>
        ) : null}
      </div>
      <PromptDialog
        open={dialog !== null}
        onOpenChange={(o) => { if (!o) setDialog(null); }}
        title={
          dialog === null ? 'New file'
            : dialog.mode === 'newFolder' ? 'New folder'
            : dialog.mode === 'rename' ? 'Rename'
            : 'New file'
        }
        label={
          dialog === null ? 'File name'
            : dialog.mode === 'newFolder' ? 'Folder name'
            : dialog.mode === 'rename' ? 'New name'
            : 'File name'
        }
        placeholder={dialog !== null && dialog.mode === 'newFolder' ? 'components' : 'index.ts'}
        defaultValue={dialog !== null && dialog.mode === 'rename' ? dialog.currentName : ''}
        confirmLabel={dialog !== null && dialog.mode === 'rename' ? 'Rename' : 'Create'}
        onConfirm={handleDialogConfirm}
      />
    </div>
  );
}
