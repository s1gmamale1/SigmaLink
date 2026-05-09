// Memory list — search + virtualized-ish list. We don't pull a virtualizer
// dep for v1; for the expected workspace sizes (≤500 notes) a simple flex
// scroll is fine. Search is debounced and filters via the in-memory index
// exposed by the main-process MCP server.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Search, Plus, Tag as TagIcon } from 'lucide-react';
import { rpc } from '@/renderer/lib/rpc';
import { cn } from '@/lib/utils';
import type { Memory, MemorySearchHit } from '@/shared/types';

interface Props {
  memories: Memory[];
  workspaceId: string;
  activeName: string | null;
  onSelect(name: string): void;
  onCreate(name: string): void;
}

export function MemoryList({ memories, workspaceId, activeName, onSelect, onCreate }: Props) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<MemorySearchHit[] | null>(null);
  const [busy, setBusy] = useState(false);

  const trimmed = query.trim();

  useEffect(() => {
    if (!trimmed) {
      setHits(null);
      return;
    }
    let alive = true;
    setBusy(true);
    const t = setTimeout(() => {
      void (async () => {
        try {
          const r = await rpc.memory.search_memories({
            workspaceId,
            query: trimmed,
            limit: 50,
          });
          if (alive) setHits(r);
        } catch (err) {
          console.error('search failed:', err);
        } finally {
          if (alive) setBusy(false);
        }
      })();
    }, 120);
    return () => {
      alive = false;
      clearTimeout(t);
      setBusy(false);
    };
  }, [trimmed, workspaceId]);

  const visible = useMemo(() => {
    if (!hits) return memories;
    const byId = new Map(memories.map((m) => [m.id, m]));
    return hits
      .map((h) => byId.get(h.id))
      .filter((m): m is Memory => !!m);
  }, [hits, memories]);

  const onCreateClick = useCallback(() => {
    const name = window.prompt('New note name:');
    if (!name || !name.trim()) return;
    onCreate(name.trim());
  }, [onCreate]);

  return (
    <div className="flex h-full flex-col border-r border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border p-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search notes…"
            className="w-full rounded border border-input bg-background py-1.5 pl-7 pr-2 text-xs outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        <button
          type="button"
          onClick={onCreateClick}
          title="Create note"
          className="rounded border border-input bg-background px-2 py-1.5 text-xs hover:bg-accent"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {busy ? (
          <div className="px-3 py-2 text-xs text-muted-foreground">Searching…</div>
        ) : null}
        {visible.length === 0 ? (
          <div className="px-3 py-4 text-xs text-muted-foreground">
            {trimmed ? 'No matches.' : 'No notes yet. Click + to create one.'}
          </div>
        ) : null}
        <ul role="listbox" aria-label="Memory notes" className="px-1 py-1">
          {visible.map((m) => {
            const isActive = m.name === activeName;
            return (
              <li key={m.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={isActive}
                  onClick={() => onSelect(m.name)}
                  className={cn(
                    'flex w-full flex-col gap-0.5 rounded px-2 py-1.5 text-left text-xs transition',
                    isActive
                      ? 'bg-accent text-accent-foreground'
                      : 'text-foreground hover:bg-accent/50',
                  )}
                >
                  <span className="truncate font-medium">{m.name}</span>
                  {m.tags.length ? (
                    <span className="flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground">
                      <TagIcon className="h-2.5 w-2.5" />
                      {m.tags.slice(0, 4).map((t) => (
                        <span key={t} className="rounded bg-muted px-1">
                          {t}
                        </span>
                      ))}
                      {m.tags.length > 4 ? <span>+{m.tags.length - 4}</span> : null}
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
