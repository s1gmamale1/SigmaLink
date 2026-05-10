// Memory list — search + virtualized-ish list. We don't pull a virtualizer
// dep for v1; for the expected workspace sizes (≤500 notes) a simple flex
// scroll is fine. Search is debounced and filters via the in-memory index
// exposed by the main-process MCP server.
//
// Phase 4 Track C — when the embedded Ruflo MCP supervisor is `ready`, the
// search bar fires `ruflo.embeddings.search` in PARALLEL with the existing
// token search. Token-match rows render first (preserving existing ranking);
// semantic-only rows are appended with a small "semantic" chip. When the
// supervisor is unavailable the call returns `{ ok: false }` and the list
// silently falls back to token-only.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Search, Plus, Tag as TagIcon, Sparkles } from 'lucide-react';
import { rpc, rpcSilent, onEvent } from '@/renderer/lib/rpc';
import { cn } from '@/lib/utils';
import type { Memory, MemorySearchHit } from '@/shared/types';

interface Props {
  memories: Memory[];
  workspaceId: string;
  activeName: string | null;
  onSelect(name: string): void;
  onCreate(name: string): void;
}

interface SemanticHit {
  /** Memory id (matches `MemorySearchHit.id` when the row is also tracked
   *  locally). When the embedding store contains rows we don't have on disk
   *  the row is dropped from the list. */
  id: string;
  text: string;
  score: number;
}

interface RufloHealthEvent {
  state: 'absent' | 'starting' | 'ready' | 'degraded' | 'down';
}

interface VisibleRow {
  memory: Memory;
  semantic: boolean;
  score?: number;
}

export function MemoryList({ memories, workspaceId, activeName, onSelect, onCreate }: Props) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<MemorySearchHit[] | null>(null);
  const [semanticHits, setSemanticHits] = useState<SemanticHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [rufloReady, setRufloReady] = useState(false);
  const [semanticEnabled, setSemanticEnabled] = useState(true);

  const trimmed = query.trim();

  // Phase 4 Track C — track Ruflo health so we only render the toggle when
  // the supervisor is actually `ready`. The toggle disappears for any
  // other state so users on un-installed builds see the room exactly as
  // it was pre-Phase-4.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const h = await rpcSilent.ruflo.health();
        if (alive) setRufloReady(h.state === 'ready');
      } catch {
        /* main-process method not registered yet — keep default false */
      }
    })();
    const off = onEvent<RufloHealthEvent>('ruflo:health', (e) => {
      setRufloReady(e?.state === 'ready');
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  useEffect(() => {
    let alive = true;
    if (!trimmed) {
      // Defer to a microtask so the lint rule (no synchronous setState in
      // effect bodies) is satisfied. Mirrors the pattern used in
      // CommandPalette + BridgeRoom for empty-state resets.
      const id = window.setTimeout(() => {
        if (!alive) return;
        setHits(null);
        setSemanticHits(null);
      }, 0);
      return () => {
        alive = false;
        window.clearTimeout(id);
      };
    }
    const t = setTimeout(() => {
      if (!alive) return;
      setBusy(true);
      void (async () => {
        // Fire token + semantic searches in parallel. `Promise.allSettled`
        // means semantic timeouts / unavailable envelopes never block the
        // token results.
        const [tokenRes, semanticRes] = await Promise.allSettled([
          rpc.memory.search_memories({
            workspaceId,
            query: trimmed,
            limit: 50,
          }),
          semanticEnabled && rufloReady
            ? rpcSilent.ruflo['embeddings.search']({
                query: trimmed,
                topK: 10,
                threshold: 0.5,
                namespace: `memory:${workspaceId}`,
              })
            : Promise.resolve({
                ok: false as const,
                code: 'ruflo-unavailable' as const,
                reason: 'gated',
              }),
        ]);
        if (!alive) return;
        if (tokenRes.status === 'fulfilled') setHits(tokenRes.value);
        else console.error('search failed:', tokenRes.reason);
        if (
          semanticRes.status === 'fulfilled' &&
          semanticRes.value &&
          'ok' in semanticRes.value &&
          semanticRes.value.ok
        ) {
          setSemanticHits(
            semanticRes.value.results.map((r) => ({
              id: r.id,
              text: r.text,
              score: r.score,
            })),
          );
        } else {
          setSemanticHits(null);
        }
        setBusy(false);
      })();
    }, 120);
    return () => {
      alive = false;
      clearTimeout(t);
      setBusy(false);
    };
  }, [trimmed, workspaceId, semanticEnabled, rufloReady]);

  /** Computed list. Token-match rows first (preserving existing rank);
   *  semantic-only rows that did not appear in the token set are appended
   *  in score order with a `semantic` flag set. Dedup by memory id. */
  const visible = useMemo<VisibleRow[]>(() => {
    if (!hits) {
      return memories.map((m) => ({ memory: m, semantic: false }));
    }
    const byId = new Map(memories.map((m) => [m.id, m]));
    const tokenIds = new Set<string>();
    const out: VisibleRow[] = [];
    for (const h of hits) {
      const m = byId.get(h.id);
      if (m) {
        tokenIds.add(h.id);
        out.push({ memory: m, semantic: false });
      }
    }
    if (semanticHits) {
      for (const sh of semanticHits) {
        if (tokenIds.has(sh.id)) continue;
        const m = byId.get(sh.id);
        if (m) out.push({ memory: m, semantic: true, score: sh.score });
      }
    }
    return out;
  }, [hits, semanticHits, memories]);

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
      {/* Phase 4 Track C — semantic search toggle. Only shown when the
          Ruflo supervisor is reachable; otherwise the list behaves as it
          did pre-Phase-4. */}
      {rufloReady ? (
        <div className="flex items-center gap-2 border-b border-border/60 bg-card/40 px-2 py-1 text-[10px] text-muted-foreground">
          <Sparkles className="h-3 w-3" />
          <label className="flex cursor-pointer items-center gap-1">
            <input
              type="checkbox"
              className="h-3 w-3 cursor-pointer"
              checked={semanticEnabled}
              onChange={(e) => setSemanticEnabled(e.target.checked)}
              title="Find memories by meaning, not just words."
            />
            Semantic search
          </label>
        </div>
      ) : null}
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
          {visible.map(({ memory: m, semantic }) => {
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
                  <span className="flex items-center gap-1 truncate font-medium">
                    <span className="truncate">{m.name}</span>
                    {semantic ? (
                      <span
                        className="ml-auto inline-flex shrink-0 items-center gap-0.5 rounded bg-primary/20 px-1 py-px text-[9px] font-medium uppercase tracking-wide text-primary"
                        title="Surfaced by Ruflo semantic search"
                      >
                        <Sparkles className="h-2.5 w-2.5" />
                        Semantic
                      </span>
                    ) : null}
                  </span>
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
