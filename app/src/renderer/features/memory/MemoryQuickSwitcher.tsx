// P4 MEM-4 — ⌘O Memory Quick Switcher.
//
// A controlled cmdk dialog (the lead owns `open` + the ⌘O binding) that lets
// the operator jump to a local note OR a Ruflo AgentDB entry in one stroke.
// cmdk does the fuzzy filtering against each item's visible label.
//
// Notes always render (synchronously, from props). Agent-memory rows are
// fetched lazily from `rpcSilent.ruflo['entries.list']` only when the dialog
// OPENS and the Ruflo supervisor is `ready` (probed via `rpc.ruflo.health()`
// + the `'ruflo:health'` event, mirroring MemoryList.tsx). When Ruflo is
// offline / returns `{ ok: false }` / rejects, the switcher silently degrades
// to a Notes-only palette.

import { useEffect, useState } from 'react';
import { FileText, Sparkles } from 'lucide-react';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { rpcSilent, onEvent } from '@/renderer/lib/rpc';
import type { Memory, RufloEntry } from '@/shared/types';

interface RufloHealthEvent {
  state: 'absent' | 'starting' | 'ready' | 'degraded' | 'down';
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  memories: Memory[];
  onSelectNote: (name: string) => void;
  onSelectRuflo: (entry: RufloEntry) => void;
}

/** Collapse a (possibly multi-line) Ruflo entry body to a short, single-line
 *  label so it sits cleanly in the palette. */
function rufloLabel(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > 80 ? `${oneLine.slice(0, 79)}…` : oneLine || '(empty entry)';
}

export function MemoryQuickSwitcher({
  open,
  onOpenChange,
  memories,
  onSelectNote,
  onSelectRuflo,
}: Props) {
  // Track Ruflo health so we only attempt the entries fetch when the embedded
  // supervisor is actually reachable. Default false → Notes-only until proven.
  const [rufloReady, setRufloReady] = useState(false);
  const [rufloEntries, setRufloEntries] = useState<RufloEntry[]>([]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const h = await rpcSilent.ruflo.health();
        if (alive) setRufloReady(h.state === 'ready');
      } catch {
        /* main-process method not registered — keep default false */
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

  // Fetch agent-memory entries when the dialog OPENS and Ruflo is ready.
  // Don't fetch while closed; reset entries on close so a stale list never
  // flashes on the next open before the fresh fetch resolves. setState only
  // ever fires from a resolved async callback behind the `alive` guard.
  useEffect(() => {
    if (!open || !rufloReady) {
      const id = window.setTimeout(() => setRufloEntries([]), 0);
      return () => window.clearTimeout(id);
    }
    let alive = true;
    void (async () => {
      try {
        const res = await rpcSilent.ruflo['entries.list']({ limit: 50 });
        if (!alive) return;
        if (res && 'ok' in res && res.ok) setRufloEntries(res.entries);
        else setRufloEntries([]);
      } catch {
        if (alive) setRufloEntries([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, [open, rufloReady]);

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Memory quick switcher"
      description="Jump to a note or agent memory."
    >
      <CommandInput placeholder="Jump to a note or agent memory…" />
      <CommandList>
        <CommandEmpty>No matches.</CommandEmpty>
        {memories.length ? (
          <CommandGroup heading="Notes">
            {memories.map((m) => (
              <CommandItem
                key={m.id}
                value={`note ${m.name}`}
                onSelect={() => {
                  onSelectNote(m.name);
                  onOpenChange(false);
                }}
              >
                <FileText className="mr-2 h-4 w-4" />
                <span className="flex-1 truncate">{m.name}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}
        {rufloEntries.length ? (
          <CommandGroup heading="Agent memory">
            {rufloEntries.map((entry) => {
              const label = rufloLabel(entry.text);
              return (
                <CommandItem
                  // Prefix the value with the namespace + id so cmdk can
                  // disambiguate a Ruflo row from a note carrying the same text.
                  key={entry.id}
                  value={`ruflo ${entry.namespace} ${label} ${entry.id}`}
                  onSelect={() => {
                    onSelectRuflo(entry);
                    onOpenChange(false);
                  }}
                >
                  <Sparkles className="mr-2 h-4 w-4" />
                  <span className="flex-1 truncate">{label}</span>
                  <span className="ml-2 shrink-0 truncate text-xs text-muted-foreground">
                    {entry.namespace}
                  </span>
                </CommandItem>
              );
            })}
          </CommandGroup>
        ) : null}
      </CommandList>
    </CommandDialog>
  );
}
