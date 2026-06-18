// V3-W14-007 — Recursive file tree for the Editor tab. Roots at the active
// workspace's repoRoot (or rootPath for plain folders). Directory contents
// load lazily; expanded paths persist per root as
// `editor.<workspaceId>.<encodedRoot>.expandedPaths` so that switching to a
// different tree root (W-8 worktree browsing) does not bleed expansion state.

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ChevronRight,
  File as FileIcon,
  FilePlus,
  Folder,
  FolderOpen,
  FolderPlus,
  Pencil,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { rpc, rpcSilent } from '@/renderer/lib/rpc';
import { cn } from '@/lib/utils';
import { pathRelative } from '@/renderer/lib/path-relative';
import { fsPath } from './fs-path';
import { useFileMutations } from './useFileMutations';
import { PromptDialog } from '@/components/ui/prompt-dialog';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';

interface DirEntry {
  name: string;
  type: 'file' | 'dir';
}

interface NodeProps {
  fullPath: string;
  name: string;
  type: 'file' | 'dir';
  depth: number;
  expanded: ReadonlySet<string>;
  childrenByPath: ReadonlyMap<string, DirEntry[]>;
  selectedPath: string | null;
  onToggle: (p: string) => void;
  onOpen: (p: string) => void;
  /** v1.4.8 drag-drop — passed through so the drag payload carries both paths. */
  workspaceId: string;
  rootPath: string;
  onNewFile: (dir: string) => void;
  onNewFolder: (dir: string) => void;
  onRename: (path: string, currentName: string) => void;
  onDelete: (path: string) => void;
}

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

  // Reject leaf names that contain separators or are dot-only (UX guard; the
  // backend containment is the real boundary).
  const validName = (name: string) =>
    name.trim().length > 0 && !/[\\/]/.test(name) && name !== '.' && name !== '..';

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
    [dialog, mutations, refreshDir, onOpenFile],
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
        label={dialog !== null && dialog.mode === 'newFolder' ? 'Folder name' : 'File name'}
        placeholder={dialog !== null && dialog.mode === 'newFolder' ? 'components' : 'index.ts'}
        defaultValue={dialog !== null && dialog.mode === 'rename' ? dialog.currentName : ''}
        confirmLabel={dialog !== null && dialog.mode === 'rename' ? 'Rename' : 'Create'}
        onConfirm={handleDialogConfirm}
      />
    </div>
  );
}

const TreeNode = memo(function TreeNode(props: NodeProps) {
  const {
    fullPath,
    name,
    type,
    depth,
    expanded,
    childrenByPath,
    selectedPath,
    onToggle,
    onOpen,
    onNewFile,
    onNewFolder,
    onRename,
    onDelete,
    workspaceId,
    rootPath,
  } = props;

  const isOpen = expanded.has(fullPath);
  const isSelected = selectedPath === fullPath;
  const children = type === 'dir' && isOpen ? childrenByPath.get(fullPath) : undefined;
  // "Loading" = expanded directory whose children haven't landed yet.
  const isLoading = type === 'dir' && isOpen && !children;

  // Keep root row hidden — depth 0 is rendered by the parent header.
  const isRoot = depth === 0;

  // Create-target dir: this node's path when it's a directory, else its parent.
  const ownDir = type === 'dir' ? fullPath : fsPath.dirname(fullPath);

  return (
    <div role="treeitem" aria-expanded={type === 'dir' ? isOpen : undefined}>
      {!isRoot ? (
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <button
              type="button"
              draggable
              onDragStart={(e) => {
                // v1.4.8 — workspace-relative path via shared pathRelative helper.
                // Falls back to absolutePath when the file is outside the workspace root.
                const relativePath = pathRelative(fullPath, rootPath);
                e.dataTransfer.setData(
                  'application/sigmalink-file',
                  JSON.stringify({ absolutePath: fullPath, relativePath, workspaceId }),
                );
                e.dataTransfer.effectAllowed = 'copy';
              }}
              onClick={() => (type === 'dir' ? onToggle(fullPath) : onOpen(fullPath))}
              onDoubleClick={() => type === 'dir' && onOpen(fullPath)}
              className={cn(
                'group flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-[12px] transition',
                'hover:bg-accent/30',
                isSelected && 'bg-accent text-accent-foreground',
              )}
              style={{ paddingLeft: 4 + depth * 12 }}
              title={fullPath}
            >
              {type === 'dir' ? (
                <ChevronRight
                  className={cn(
                    'h-3 w-3 shrink-0 text-muted-foreground transition',
                    isOpen && 'rotate-90',
                  )}
                  aria-hidden
                />
              ) : (
                <span className="inline-block w-3" aria-hidden />
              )}
              {type === 'dir' ? (
                isOpen ? (
                  <FolderOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                ) : (
                  <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                )
              ) : (
                <FileIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" aria-hidden />
              )}
              <span className="truncate">{name}</span>
            </button>
          </ContextMenuTrigger>
          <ContextMenuContent className="w-44">
            <ContextMenuItem onSelect={() => onNewFile(ownDir)}>
              <FilePlus className="mr-2 h-3.5 w-3.5" /> New File
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => onNewFolder(ownDir)}>
              <FolderPlus className="mr-2 h-3.5 w-3.5" /> New Folder
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => onRename(fullPath, name)}>
              <Pencil className="mr-2 h-3.5 w-3.5" /> Rename
            </ContextMenuItem>
            <ContextMenuItem
              variant="destructive"
              onSelect={() => onDelete(fullPath)}
            >
              <Trash2 className="mr-2 h-3.5 w-3.5" /> Delete
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      ) : null}
      {type === 'dir' && isOpen ? (
        <div role="group">
          {isLoading && !children ? (
            <div
              className="px-2 py-0.5 text-[11px] text-muted-foreground"
              style={{ paddingLeft: 16 + depth * 12 }}
            >
              Loading…
            </div>
          ) : children && children.length === 0 ? (
            <div
              className="px-2 py-0.5 text-[11px] text-muted-foreground/70"
              style={{ paddingLeft: 16 + depth * 12 }}
            >
              (empty)
            </div>
          ) : (
            children?.map((c) => {
              const childPath = fsPath.join(fullPath, c.name);
              return (
                <TreeNode
                  key={childPath}
                  fullPath={childPath}
                  name={c.name}
                  type={c.type}
                  depth={depth + 1}
                  expanded={expanded}
                  childrenByPath={childrenByPath}
                  selectedPath={selectedPath}
                  onToggle={onToggle}
                  onOpen={onOpen}
                  onNewFile={onNewFile}
                  onNewFolder={onNewFolder}
                  onRename={onRename}
                  onDelete={onDelete}
                  workspaceId={workspaceId}
                  rootPath={rootPath}
                />
              );
            })
          )}
        </div>
      ) : null}
    </div>
  );
});
