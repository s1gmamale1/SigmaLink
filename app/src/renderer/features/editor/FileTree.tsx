// V3-W14-007 — Recursive file tree for the Editor tab. Roots at the active
// workspace's repoRoot (or rootPath for plain folders). Directory contents
// load lazily; expanded paths persist as `editor.<workspaceId>.expandedPaths`.

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ChevronRight, File as FileIcon, Folder, FolderOpen, RefreshCw } from 'lucide-react';
import { rpc, rpcSilent } from '@/renderer/lib/rpc';
import { cn } from '@/lib/utils';

// Tiny renderer-side path helpers — `path-browserify` isn't in our deps and
// the renderer can't import the Node `path` module. We only need `join` +
// `basename`, and our paths are always absolute (POSIX or Windows).
const ptr = {
  join: (...parts: string[]): string => {
    const sep = parts[0]?.includes('\\') && !parts[0].startsWith('/') ? '\\' : '/';
    return parts
      .map((p, i) => (i === 0 ? p.replace(/[\\/]+$/, '') : p.replace(/^[\\/]+|[\\/]+$/g, '')))
      .filter(Boolean)
      .join(sep);
  },
  basename: (p: string): string => {
    const norm = p.replace(/[\\/]+$/, '');
    const idx = Math.max(norm.lastIndexOf('/'), norm.lastIndexOf('\\'));
    return idx === -1 ? norm : norm.slice(idx + 1);
  },
};

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
}

interface Props {
  workspaceId: string;
  rootPath: string;
  selectedPath: string | null;
  onOpenFile: (path: string) => void;
}

const KV_PREFIX = 'editor.';
const KV_SUFFIX = '.expandedPaths';

function kvKey(workspaceId: string): string {
  return `${KV_PREFIX}${workspaceId}${KV_SUFFIX}`;
}

// Remount-on-workspace-change wrapper. Keying the inner component gives us a
// clean state reset without setState-in-effect (a React 19 anti-pattern).
export function FileTree(props: Props) {
  return <FileTreeInner key={`${props.workspaceId}::${props.rootPath}`} {...props} />;
}

function FileTreeInner({ workspaceId, rootPath, selectedPath, onOpenFile }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([rootPath]));
  const [childrenByPath, setChildren] = useState<Map<string, DirEntry[]>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const hydratedRef = useRef(false);
  // In-flight paths live in a ref so the load-kicker effect never triggers a
  // re-render itself; "Loading…" is derived from expanded ∖ childrenByPath.
  const inFlightRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    let alive = true;
    hydratedRef.current = false;
    void (async () => {
      try {
        const raw = await rpcSilent.kv.get(kvKey(workspaceId));
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
    void rpcSilent.kv.set(kvKey(workspaceId), JSON.stringify(arr)).catch(() => undefined);
  }, [expanded, workspaceId]);

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

  const rootName = useMemo(() => ptr.basename(rootPath) || rootPath, [rootPath]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-border px-2 py-1.5">
        <div className="truncate text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {rootName}
        </div>
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
        />
        {error ? (
          <div className="px-2 py-1 text-[11px] text-destructive">{error}</div>
        ) : null}
      </div>
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
  } = props;

  const isOpen = expanded.has(fullPath);
  const isSelected = selectedPath === fullPath;
  const children = type === 'dir' && isOpen ? childrenByPath.get(fullPath) : undefined;
  // "Loading" = expanded directory whose children haven't landed yet.
  const isLoading = type === 'dir' && isOpen && !children;

  // Keep root row hidden — depth 0 is rendered by the parent header.
  const isRoot = depth === 0;

  return (
    <div role="treeitem" aria-expanded={type === 'dir' ? isOpen : undefined}>
      {!isRoot ? (
        <button
          type="button"
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
              const childPath = ptr.join(fullPath, c.name);
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
                />
              );
            })
          )}
        </div>
      ) : null}
    </div>
  );
});
