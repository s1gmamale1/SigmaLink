// Recursive BSP tiling renderer for the Command Room. Owns the per-workspace
// layout tree (seeded from KV), reconciles it against the authoritative live
// session ids every render, persists on change, and renders square-cornered
// leaves separated by BspDivider splitters. Leaves are keyed by sessionId so
// the cached xterm terminals never remount on relayout.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { rpcSilent } from '@/renderer/lib/rpc';
import {
  type BspNode,
  type BspPath,
  type BspTree,
  reconcile,
  setRatio,
} from '@/shared/bsp-layout';
import { BspDivider } from './BspDivider';

export interface BspLayoutProps {
  sessionIds: string[];
  activeSessionId: string | null;
  focusedPaneId: string | null;
  workspaceId: string | null;
  onActivate: (sessionId: string) => void;
  renderLeaf: (sessionId: string) => React.ReactNode;
}

function kvKey(workspaceId: string): string {
  return `bsp.tree.${workspaceId}`;
}

function parseTree(raw: string | null): BspTree {
  if (!raw) return null;
  try {
    const t = JSON.parse(raw) as BspTree;
    return t && (t.type === 'leaf' || t.type === 'split') ? t : null;
  } catch {
    return null;
  }
}

export function BspLayout({
  sessionIds,
  activeSessionId,
  focusedPaneId,
  workspaceId,
  onActivate,
  renderLeaf,
}: BspLayoutProps) {
  // Persisted tree (raw, before reconcile). Seeded from KV on workspace change.
  const [storedTree, setStoredTree] = useState<BspTree>(null);
  // Workspace whose tree is currently loaded — gates persistence so we never
  // save before the KV load returns (which would clobber the stored layout).
  const loadedForRef = useRef<string | null>(null);
  // Per-leaf host elements, for aspect-aware auto-split direction.
  const leafElsRef = useRef<Map<string, HTMLElement>>(new Map());
  const lastSavedRef = useRef<string>('');
  // Split direction for the next insert, measured from the focused leaf's aspect.
  const [dirHint, setDirHint] = useState<'h' | 'v'>('v');

  // Load persisted tree when the workspace changes. setState runs only after the
  // await (microtask boundary) to satisfy react-hooks/set-state-in-effect.
  useEffect(() => {
    let alive = true;
    void (async () => {
      let tree: BspTree = null;
      if (workspaceId) {
        try {
          tree = parseTree(await rpcSilent.kv.get(kvKey(workspaceId)));
        } catch {
          tree = null;
        }
      }
      if (!alive) return;
      loadedForRef.current = workspaceId;
      lastSavedRef.current = tree ? JSON.stringify(tree) : '';
      setStoredTree(tree);
    })();
    return () => {
      alive = false;
    };
  }, [workspaceId]);

  // Measure the focused leaf's aspect after paint (rAF avoids a synchronous
  // setState cascade) → direction for the next auto-split. Reading the ref in an
  // effect (not during render) is lint-safe.
  useEffect(() => {
    const el = activeSessionId ? leafElsRef.current.get(activeSessionId) : undefined;
    if (!el) return;
    const raf = requestAnimationFrame(() => {
      const r = el.getBoundingClientRect();
      setDirHint(r.width >= r.height ? 'v' : 'h');
    });
    return () => cancelAnimationFrame(raf);
    // Re-measure when the focused pane or the pane count changes.
  }, [activeSessionId, sessionIds.length]);

  // The live tree = persisted tree healed against the authoritative session set.
  const tree = useMemo(
    () => reconcile(storedTree, sessionIds, { focusId: activeSessionId ?? undefined, dirHint }),
    [storedTree, sessionIds, activeSessionId, dirHint],
  );

  // Persist when the reconciled tree changes (debounced), once the load for this
  // workspace has completed (loadedForRef matches).
  useEffect(() => {
    if (!workspaceId || loadedForRef.current !== workspaceId) return;
    const serialized = tree ? JSON.stringify(tree) : '';
    if (serialized === lastSavedRef.current) return;
    const t = setTimeout(() => {
      lastSavedRef.current = serialized;
      rpcSilent.kv.set(kvKey(workspaceId), serialized).catch(() => {});
    }, 250);
    return () => clearTimeout(t);
  }, [tree, workspaceId]);

  // setRatio at a path → write back into storedTree (so the user's drag persists).
  const commitRatio = useCallback(
    (path: BspPath, ratio: number) => {
      setStoredTree((prev) => {
        // Apply against the reconciled live tree so paths line up with the DOM,
        // then keep it as the new stored tree.
        const base = reconcile(prev, sessionIds, {
          focusId: activeSessionId ?? undefined,
          dirHint,
        });
        if (!base || base.type !== 'split') return prev;
        return setRatio(base, path, ratio);
      });
    },
    [sessionIds, activeSessionId, dirHint],
  );

  const registerLeaf = useCallback((id: string, el: HTMLElement | null) => {
    if (el) leafElsRef.current.set(id, el);
    else leafElsRef.current.delete(id);
  }, []);

  if (!tree) return <div className="min-h-0 flex-1" data-testid="bsp-empty" />;

  return (
    <div className="relative flex min-h-0 flex-1" data-testid="bsp-layout">
      <BspBranch
        node={tree}
        path={[]}
        focusedPaneId={focusedPaneId}
        activeSessionId={activeSessionId}
        onActivate={onActivate}
        onRatio={commitRatio}
        registerLeaf={registerLeaf}
        renderLeaf={renderLeaf}
      />
    </div>
  );
}

interface BranchProps {
  node: BspNode;
  path: BspPath;
  focusedPaneId: string | null;
  activeSessionId: string | null;
  onActivate: (id: string) => void;
  onRatio: (path: BspPath, ratio: number) => void;
  registerLeaf: (id: string, el: HTMLElement | null) => void;
  renderLeaf: (id: string) => React.ReactNode;
}

function BspBranch(props: BranchProps) {
  const { node, path, focusedPaneId } = props;
  const containerRef = useRef<HTMLDivElement | null>(null);

  if (node.type === 'leaf') {
    // Fullscreen: only the focused leaf is visible; the rest stay mounted but
    // display:none (terminal-cache contract — never unmount).
    const hidden = focusedPaneId !== null && focusedPaneId !== node.sessionId;
    const isActive = props.activeSessionId === node.sessionId && focusedPaneId === null;
    const sessionId = node.sessionId;
    return (
      <div
        ref={(el) => props.registerLeaf(sessionId, el)}
        data-testid="bsp-leaf"
        data-session-id={sessionId}
        data-bsp-hidden={hidden ? 'true' : undefined}
        onMouseDownCapture={() => props.onActivate(sessionId)}
        className={[
          'relative min-h-0 min-w-0 overflow-hidden border border-border bg-card',
          isActive ? 'sl-pane-active z-[1] shadow-[0_0_0_1px_hsl(var(--ring))]' : '',
        ].join(' ')}
        style={
          hidden
            ? { display: 'none' }
            : focusedPaneId === sessionId
              ? { position: 'absolute', inset: 0, zIndex: 5 }
              : { flex: 1 }
        }
      >
        {props.renderLeaf(sessionId)}
      </div>
    );
  }

  // Split node: flex row (v) / column (h); children get flex ratios; divider between.
  const isRow = node.dir === 'v';
  return (
    <div
      ref={containerRef}
      className={['flex min-h-0 min-w-0', isRow ? 'flex-row' : 'flex-col'].join(' ')}
      style={{ flex: 1 }}
      data-testid="bsp-branch"
      data-dir={node.dir}
    >
      <div className="flex min-h-0 min-w-0" style={{ flex: node.ratio }}>
        <BspBranch {...props} node={node.a} path={[...path, 'a']} />
      </div>
      <BspDivider
        dir={node.dir}
        ratio={node.ratio}
        getContainerSize={() =>
          isRow
            ? (containerRef.current?.getBoundingClientRect().width ?? 0)
            : (containerRef.current?.getBoundingClientRect().height ?? 0)
        }
        onRatio={(r) => props.onRatio(path, r)}
      />
      <div className="flex min-h-0 min-w-0" style={{ flex: 1 - node.ratio }}>
        <BspBranch {...props} node={node.b} path={[...path, 'b']} />
      </div>
    </div>
  );
}
