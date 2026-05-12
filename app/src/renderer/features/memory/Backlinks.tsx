// Backlinks panel — lists every memory whose body contains a [[wikilink]]
// pointing at the current note. Stays in lockstep with the DB by re-fetching
// whenever the active note name changes or the global memory list changes.

import { useEffect, useState } from 'react';
import { Link2 } from 'lucide-react';
import { rpc } from '@/renderer/lib/rpc';
import type { Memory } from '@/shared/types';

interface Props {
  workspaceId: string;
  noteName: string | null;
  memoriesVersion: number; // bump to refresh
  onSelect(name: string): void;
}

export function Backlinks({ workspaceId, noteName, memoriesVersion, onSelect }: Props) {
  const [items, setItems] = useState<Memory[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!noteName) {
      queueMicrotask(() => setItems([]));
      return;
    }
    let alive = true;
    queueMicrotask(() => {
      setBusy(true);
      setErr(null);
    });
    void (async () => {
      try {
        const r = await rpc.memory.find_backlinks({ workspaceId, name: noteName });
        if (alive) setItems(r);
      } catch (e) {
        if (alive) setErr(e instanceof Error ? e.message : String(e));
      } finally {
        if (alive) setBusy(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [workspaceId, noteName, memoriesVersion]);

  if (!noteName) return null;

  return (
    <div className="flex h-full flex-col border-l border-border bg-card text-xs">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2 font-medium">
        <Link2 className="h-3.5 w-3.5" />
        <span>Backlinks</span>
        <span className="text-muted-foreground">({items.length})</span>
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {busy ? <div className="text-muted-foreground">Loading…</div> : null}
        {err ? <div className="text-destructive">{err}</div> : null}
        {!busy && !err && items.length === 0 ? (
          <div className="text-muted-foreground">No notes link here yet.</div>
        ) : null}
        <ul className="space-y-1">
          {items.map((m) => (
            <li key={m.id}>
              <button
                type="button"
                onClick={() => onSelect(m.name)}
                className="flex w-full flex-col rounded border border-transparent px-2 py-1 text-left hover:border-border hover:bg-accent/40"
              >
                <span className="font-medium text-foreground">{m.name}</span>
                {m.tags.length ? (
                  <span className="text-[10px] text-muted-foreground">
                    {m.tags.join(' · ')}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
