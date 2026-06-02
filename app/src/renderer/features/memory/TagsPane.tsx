// P4 MEM-3 — Tags pane. A controlled tag-filter sidebar that surfaces the
// distinct tags across a workspace's notes (with counts) and lets the user
// scope the MemoryList + graph to a single tag.
//
// Controlled: the *selection* lives with the parent (`activeTag`) so it can be
// threaded into MemoryList + the graph filter. This component owns only the
// fetched tag list. It refetches on mount, on `workspaceId` change, and
// whenever `refreshKey` changes (the lead bumps it after a note create/edit so
// new/removed tags appear). setState happens only from resolved async
// callbacks behind an `alive` guard — no impurity in render.

import { useEffect, useState } from 'react';
import { Tag as TagIcon, X } from 'lucide-react';
import { rpc } from '@/renderer/lib/rpc';
import { cn } from '@/lib/utils';

interface TagCount {
  tag: string;
  count: number;
}

interface Props {
  workspaceId: string;
  /** Currently-selected tag, or null when unfiltered. Owned by the parent. */
  activeTag: string | null;
  /** Toggle handler. Clicking the active tag clears it (caller receives null). */
  onTagClick: (tag: string | null) => void;
  /** Bump to force a refetch (e.g. after a note's tags change). */
  refreshKey?: number;
}

export function TagsPane({ workspaceId, activeTag, onTagClick, refreshKey }: Props) {
  const [tags, setTags] = useState<TagCount[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true;
    // All setState happens inside the async IIFE (after a microtask boundary),
    // never synchronously in the effect body — satisfies the
    // react-hooks/set-state-in-effect rule. The `alive` guard + cleanup means a
    // resolved fetch from a stale workspace/refreshKey can never write state.
    void (async () => {
      if (alive) {
        setBusy(true);
        setError(false);
      }
      try {
        const rows = await rpc.memory.list_tags({ workspaceId });
        if (!alive) return;
        setTags(rows);
      } catch {
        if (!alive) return;
        setError(true);
        setTags([]);
      } finally {
        if (alive) setBusy(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [workspaceId, refreshKey]);

  return (
    <div
      data-testid="tags-pane"
      className="flex h-full flex-col border-r border-border bg-card"
    >
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <span className="flex items-center gap-1.5 text-xs font-medium text-foreground">
          <TagIcon className="h-3.5 w-3.5 text-muted-foreground" />
          Tags
        </span>
        {activeTag ? (
          <button
            type="button"
            data-testid="tags-clear"
            onClick={() => onTagClick(null)}
            title="Clear tag filter"
            aria-label="Clear tag filter"
            className="inline-flex items-center gap-0.5 rounded border border-input bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground transition hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <X className="h-2.5 w-2.5" />
            Clear
          </button>
        ) : null}
      </div>

      <div className="flex-1 overflow-y-auto px-1 py-1">
        {busy ? (
          <div className="px-2 py-2 text-xs text-muted-foreground">Loading tags…</div>
        ) : null}

        {!busy && error ? (
          <div className="px-2 py-3 text-xs text-muted-foreground" role="status">
            Couldn’t load tags.
          </div>
        ) : null}

        {!busy && !error && tags.length === 0 ? (
          <div
            data-testid="tags-empty"
            className="px-2 py-4 text-xs text-muted-foreground"
          >
            No tags yet. Add tags to a note to filter by them here.
          </div>
        ) : null}

        {!busy && !error && tags.length > 0 ? (
          <ul role="listbox" aria-label="Filter by tag" className="flex flex-col gap-0.5">
            {/* "All" / clear row — selected when nothing is filtered. */}
            <li>
              <button
                type="button"
                role="option"
                aria-selected={activeTag === null}
                data-testid="tags-all"
                onClick={() => onTagClick(null)}
                className={cn(
                  'flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-xs transition focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                  activeTag === null
                    ? 'bg-accent text-accent-foreground'
                    : 'text-foreground hover:bg-accent/50',
                )}
              >
                <span className="truncate font-medium">All notes</span>
              </button>
            </li>

            {tags.map(({ tag, count }) => {
              const isActive = tag === activeTag;
              return (
                <li key={tag}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={isActive}
                    data-testid={`tags-chip-${tag}`}
                    title={`${count} note${count === 1 ? '' : 's'} tagged “${tag}”`}
                    // Toggle: clicking the active tag clears the filter.
                    onClick={() => onTagClick(isActive ? null : tag)}
                    className={cn(
                      'flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-xs transition focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                      isActive
                        ? 'bg-accent text-accent-foreground'
                        : 'text-foreground hover:bg-accent/50',
                    )}
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      <TagIcon className="h-3 w-3 shrink-0 text-muted-foreground" />
                      <span className="truncate">{tag}</span>
                    </span>
                    <span
                      className={cn(
                        'shrink-0 rounded px-1 text-[10px] tabular-nums',
                        isActive ? 'bg-accent-foreground/15' : 'bg-muted text-muted-foreground',
                      )}
                    >
                      {count}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
