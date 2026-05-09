// V3-W12-006 Step 1: folder picker + recents autocomplete + repo detection
// blurb. Recents come from the existing `state.workspaces` list (sourced from
// `rpc.workspaces.list`). The user can either click a recent row or use the
// native picker. Once a workspace is active the parent enables Step 2.

import { useMemo, useState } from 'react';
import { Folder, FolderPlus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { Workspace } from '@/shared/types';

interface StartStepProps {
  selected: Workspace | null;
  recents: Workspace[];
  onPickFolder: () => void;
  onChooseRecent: (ws: Workspace) => void;
  onForgetRecent: (ws: Workspace) => void;
}

export function StartStep({
  selected,
  recents,
  onPickFolder,
  onChooseRecent,
  onForgetRecent,
}: StartStepProps) {
  const [filter, setFilter] = useState('');

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = recents.slice(0, 12);
    if (!q) return list;
    return list.filter(
      (w) =>
        w.name.toLowerCase().includes(q) || w.rootPath.toLowerCase().includes(q),
    );
  }, [recents, filter]);

  const repoBlurb = !selected
    ? 'Pick a folder to get started.'
    : selected.repoMode === 'git'
      ? 'Git repo detected — worktrees will isolate each pane.'
      : 'Plain folder — panes share the same working tree.';

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Folder
        </label>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={selected?.rootPath ?? 'Search recents or click Pick folder…'}
            className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm outline-none transition focus:border-ring"
            aria-label="Folder path or recent search"
          />
          <Button size="sm" onClick={onPickFolder} className="gap-2">
            <FolderPlus className="h-4 w-4" /> Pick folder
          </Button>
        </div>
      </div>

      {selected ? (
        <div className="rounded-md border border-border bg-muted/20 p-3 text-sm">
          <div className="flex items-center gap-2 font-medium">
            <Folder className="h-4 w-4" /> {selected.name}
          </div>
          <div
            className="mt-1 truncate text-xs text-muted-foreground"
            title={selected.rootPath}
          >
            {selected.rootPath}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">{repoBlurb}</div>
        </div>
      ) : (
        <div className="text-sm text-muted-foreground">{repoBlurb}</div>
      )}

      {filtered.length > 0 ? (
        <div>
          <div className="mb-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Recent
          </div>
          <ul className="flex flex-col gap-1">
            {filtered.map((ws) => (
              <li
                key={ws.id}
                className={cn(
                  'group flex items-center justify-between rounded-md border border-border bg-card/40 px-2 py-1.5 text-sm transition hover:bg-card',
                  selected?.id === ws.id && 'border-ring/60 bg-accent/10',
                )}
              >
                <button
                  type="button"
                  onClick={() => onChooseRecent(ws)}
                  className="flex flex-1 items-center gap-2 text-left"
                >
                  <Folder className="h-4 w-4 text-muted-foreground" />
                  <span className="truncate" title={ws.rootPath}>
                    <span className="font-medium">{ws.name}</span>{' '}
                    <span className="text-xs text-muted-foreground">{ws.rootPath}</span>
                  </span>
                </button>
                <button
                  type="button"
                  className="opacity-0 transition group-hover:opacity-100"
                  onClick={() => onForgetRecent(ws)}
                  aria-label="Forget workspace"
                >
                  <Trash2 className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
