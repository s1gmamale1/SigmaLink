// MemoryAssistPanel — surfaces orphan notes and suggested connections.
// MEM-6: Orphans = notes with no incoming AND no outgoing links.
// Suggestions = top-10 by shared-tag overlap for the currently active note.

import { useEffect, useState } from 'react';
import { GitBranchPlus, Unlink } from 'lucide-react';
import { rpcSilent } from '@/renderer/lib/rpc';
import { cn } from '@/lib/utils';
import type { Memory, MemoryConnectionSuggestion } from '@/shared/types';

interface Props {
  workspaceId: string;
  activeName: string | null;
  onSelect: (name: string) => void;
  refreshKey?: number;
}

function Section({
  title,
  icon,
  count,
  open,
  onToggle,
  children,
  testId,
}: {
  title: string;
  icon: React.ReactNode;
  count: number;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
  testId: string;
}) {
  return (
    <div className="border-b border-border last:border-b-0" data-testid={testId}>
      <button
        type="button"
        onClick={onToggle}
        className={cn(
          'flex w-full items-center gap-2 px-3 py-2 text-xs font-medium',
          'hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          'transition-colors',
        )}
        aria-expanded={open}
        data-testid={`${testId}-toggle`}
      >
        {icon}
        <span>{title}</span>
        <span
          className="ml-auto rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
          data-testid={`${testId}-badge`}
        >
          {count}
        </span>
      </button>
      {open ? <div className="px-2 pb-2">{children}</div> : null}
    </div>
  );
}

export function MemoryAssistPanel({ workspaceId, activeName, onSelect, refreshKey }: Props) {
  const [orphans, setOrphans] = useState<Memory[]>([]);
  const [suggestions, setSuggestions] = useState<MemoryConnectionSuggestion[]>([]);
  const [orphansOpen, setOrphansOpen] = useState(true);
  const [suggestOpen, setSuggestOpen] = useState(true);

  // Fetch orphans whenever workspaceId or refreshKey changes.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const result = await rpcSilent.memory.list_orphans({ workspaceId });
        if (alive) setOrphans(result);
      } catch {
        if (alive) setOrphans([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, [workspaceId, refreshKey]);

  // Fetch suggestions whenever activeName, workspaceId, or refreshKey changes.
  useEffect(() => {
    if (!activeName) {
      // Clear suggestions via microtask to avoid synchronous setState in effect body.
      const t = setTimeout(() => setSuggestions([]), 0);
      return () => clearTimeout(t);
    }
    let alive = true;
    void (async () => {
      try {
        const result = await rpcSilent.memory.suggest_connections({
          workspaceId,
          name: activeName,
        });
        if (alive) setSuggestions(result);
      } catch {
        if (alive) setSuggestions([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, [workspaceId, activeName, refreshKey]);

  return (
    <div
      className="flex h-full flex-col overflow-y-auto bg-card text-xs"
      data-testid="memory-assist-panel"
    >
      {/* Orphans section */}
      <Section
        title="Orphan Notes"
        icon={<Unlink className="h-3.5 w-3.5 shrink-0" />}
        count={orphans.length}
        open={orphansOpen}
        onToggle={() => setOrphansOpen((v) => !v)}
        testId="orphans-section"
      >
        {orphans.length === 0 ? (
          <p className="px-1 py-1 text-muted-foreground" data-testid="orphans-empty">
            No orphan notes.
          </p>
        ) : (
          <ul className="space-y-0.5" data-testid="orphans-list">
            {orphans.map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  onClick={() => onSelect(m.name)}
                  className={cn(
                    'flex w-full rounded px-2 py-1 text-left',
                    'hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    'transition-colors',
                  )}
                  data-testid={`orphan-item-${m.id}`}
                >
                  <span className="font-medium text-foreground">{m.name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* Suggested connections section */}
      <Section
        title="Suggested Connections"
        icon={<GitBranchPlus className="h-3.5 w-3.5 shrink-0" />}
        count={suggestions.length}
        open={suggestOpen}
        onToggle={() => setSuggestOpen((v) => !v)}
        testId="suggestions-section"
      >
        {!activeName ? (
          <p className="px-1 py-1 text-muted-foreground" data-testid="suggestions-no-active">
            Select a note to see suggestions.
          </p>
        ) : suggestions.length === 0 ? (
          <p className="px-1 py-1 text-muted-foreground" data-testid="suggestions-empty">
            No suggestions for this note.
          </p>
        ) : (
          <ul className="space-y-0.5" data-testid="suggestions-list">
            {suggestions.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => onSelect(s.name)}
                  className={cn(
                    'flex w-full flex-col rounded px-2 py-1 text-left',
                    'hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    'transition-colors',
                  )}
                  data-testid={`suggestion-item-${s.id}`}
                >
                  <span className="font-medium text-foreground">{s.name}</span>
                  <div className="mt-0.5 flex flex-wrap items-center gap-1">
                    {s.sharedTags.map((tag) => (
                      <span
                        key={tag}
                        className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
                        data-testid={`suggestion-tag-${s.id}-${tag}`}
                      >
                        {tag}
                      </span>
                    ))}
                    <span
                      className="ml-auto text-[10px] text-muted-foreground"
                      data-testid={`suggestion-score-${s.id}`}
                    >
                      {s.score.toFixed(2)}
                    </span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
