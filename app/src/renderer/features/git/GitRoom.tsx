// BSP-G2 / BSP-G4 — Repo-level Git panel.
// Three tabs: Changes (staged/unstaged/untracked) · History (git log) · Branches.
// Layout: left panel (file list / history / branches) + right panel (DiffView).
// Size persistence mirrors MemoryRoom (readWorkspaceUi / writeWorkspaceUi).

import { useCallback, useEffect, useState } from 'react';
import { GitBranch, GitFork, History } from 'lucide-react';
import { cn } from '@/lib/utils';
import { rpc } from '@/renderer/lib/rpc';
import { useAppStateSelector } from '@/renderer/app/state';
import { readWorkspaceUi, writeWorkspaceUi } from '@/renderer/lib/workspace-ui-kv';
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from '@/components/ui/resizable';
import { EmptyState } from '@/renderer/components/EmptyState';
import { DiffView } from '@/renderer/features/review/DiffView';
import { ChangesPanel } from './ChangesPanel';
import { HistoryPanel } from './HistoryPanel';
import { BranchSelector } from './BranchSelector';
import type { GitDiff, GitStatus, ReviewDiff } from '@/shared/types';

// KV key for the split-panel size (per workspace).
const GIT_SPLIT_PANEL = 'git.split';
const PANEL_LEFT = 'git-left';
const PANEL_RIGHT = 'git-right';
const DEFAULT_SPLIT: [number, number] = [35, 65];

type Tab = 'changes' | 'history' | 'branches';

/** Convert a raw GitDiff into the ReviewDiff shape DiffView expects. */
function gitDiffToReviewDiff(diff: GitDiff, repoRoot: string, branch: string): ReviewDiff {
  return {
    repoRoot,
    branch,
    files: [],        // DiffView parses patches directly; files array is optional enrichment
    patches: diff.patches,
    stat: diff.stat,
    truncated: diff.truncated,
    detached: false,
  };
}

function parseSplit(raw: string | null): [number, number] {
  if (!raw) return DEFAULT_SPLIT;
  try {
    const arr = JSON.parse(raw) as number[];
    if (Array.isArray(arr) && arr.length === 2 && arr.every((n) => Number.isFinite(n))) {
      return [arr[0], arr[1]] as [number, number];
    }
  } catch {
    /* ignore */
  }
  return DEFAULT_SPLIT;
}

export function GitRoom() {
  const activeWorkspace = useAppStateSelector((s) => s.activeWorkspace);
  const wsId = activeWorkspace?.id ?? null;
  const repoRoot = activeWorkspace?.repoRoot ?? null;

  const [tab, setTab] = useState<Tab>('changes');
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [activeDiff, setActiveDiff] = useState<ReviewDiff | null>(null);
  const [split, setSplit] = useState<[number, number]>(DEFAULT_SPLIT);

  // Load persisted split sizes.
  useEffect(() => {
    if (!wsId) return;
    let alive = true;
    void (async () => {
      const raw = await readWorkspaceUi(wsId, GIT_SPLIT_PANEL);
      if (!alive) return;
      setSplit(parseSplit(raw));
    })();
    return () => { alive = false; };
  }, [wsId]);

  // Debounced persist helper. We use a simple non-React timer here (not a ref)
  // because the callback is recreated when wsId changes anyway.
  const persistSplit = useCallback(
    (layout: number[]) => {
      if (!wsId) return;
      // Best-effort fire-and-forget — layout persistence is non-critical.
      void writeWorkspaceUi(wsId, GIT_SPLIT_PANEL, JSON.stringify(layout));
    },
    [wsId],
  );

  // Fetch git status on mount and when repo root changes.
  async function refreshStatus() {
    if (!repoRoot) return;
    try {
      const s = await rpc.git.status(repoRoot);
      setStatus(s);
    } catch {
      setStatus(null);
    }
  }

  useEffect(() => {
    if (!repoRoot) return;
    let alive = true;
    void (async () => {
      try {
        const s = await rpc.git.status(repoRoot);
        if (alive) setStatus(s);
      } catch {
        if (alive) setStatus(null);
      }
    })();
    return () => { alive = false; };
  }, [repoRoot]);

  // Handle diff request from ChangesPanel.
  function handleDiff(diff: GitDiff | null) {
    if (!diff || !repoRoot || !status) {
      setActiveDiff(null);
      return;
    }
    setActiveDiff(gitDiffToReviewDiff(diff, repoRoot, status.branch));
  }

  if (!repoRoot) {
    return (
      <EmptyState
        title="No workspace open"
        description="Open a workspace to browse its Git history and changes."
      />
    );
  }

  const tabConfig: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: 'changes', label: 'Changes', icon: <GitFork className="h-3.5 w-3.5" /> },
    { id: 'history', label: 'History', icon: <History className="h-3.5 w-3.5" /> },
    { id: 'branches', label: 'Branches', icon: <GitBranch className="h-3.5 w-3.5" /> },
  ];

  // BSP-G4 — ahead/behind pill + branch name from git.status.
  const aheadBehind = status
    ? `↑${status.ahead} ↓${status.behind}`
    : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <header className="flex items-center gap-3 border-b border-border px-4 py-2">
        <GitBranch className="h-4 w-4 text-primary" />
        <h1 className="text-sm font-semibold">Git</h1>
        {status ? (
          <span className="font-mono text-xs text-muted-foreground">{status.branch}</span>
        ) : null}
        {aheadBehind && (status?.ahead || status?.behind) ? (
          <span
            className="rounded bg-primary/10 px-1.5 py-px font-mono text-[10px] text-primary"
            title={`${status!.ahead} commit(s) ahead · ${status!.behind} commit(s) behind`}
          >
            {aheadBehind}
          </span>
        ) : null}
      </header>

      {/* Content */}
      <ResizablePanelGroup
        orientation="horizontal"
        className="min-h-0 flex-1"
        onLayoutChanged={(layout) => {
          const left = layout[PANEL_LEFT];
          const right = layout[PANEL_RIGHT];
          if (Number.isFinite(left) && Number.isFinite(right)) {
            persistSplit([left, right]);
          }
        }}
      >
        {/* Left: tab switcher + panel content */}
        <ResizablePanel
          id={PANEL_LEFT}
          defaultSize={split[0]}
          minSize={20}
          className="flex min-h-0 flex-col"
        >
          {/* Segmented tab bar */}
          <div className="flex shrink-0 gap-px border-b border-border bg-muted/30 px-2 py-1">
            {tabConfig.map(({ id, label, icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                className={cn(
                  'flex items-center gap-1 rounded px-2 py-1 text-xs font-medium transition-colors',
                  tab === id
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:bg-background/60 hover:text-foreground',
                )}
                data-testid={`git-tab-${id}`}
              >
                {icon}
                {label}
              </button>
            ))}
          </div>

          {/* Panel body */}
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {tab === 'changes' && (
              <ChangesPanel
                status={status}
                repoRoot={repoRoot}
                onDiff={(diff) => handleDiff(diff)}
              />
            )}
            {tab === 'history' && (
              <HistoryPanel repoRoot={repoRoot} />
            )}
            {tab === 'branches' && (
              <BranchSelector
                repoRoot={repoRoot}
                status={status}
                onSwitched={() => void refreshStatus()}
              />
            )}
          </div>
        </ResizablePanel>

        <ResizableHandle withHandle />

        {/* Right: DiffView */}
        <ResizablePanel
          id={PANEL_RIGHT}
          defaultSize={split[1]}
          minSize={25}
          className="flex min-h-0 flex-col"
        >
          <DiffView diff={activeDiff} />
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
