// Phase 6 — inline per-turn tool-chip rail.
// Subscribes to assistant:tool-trace events scoped to the active conversationId.
// Renders compact pills for each in-flight tool call.

import { useEffect, useState } from 'react';
import { onEvent } from '@/renderer/lib/rpc';
import { cn } from '@/lib/utils';

interface ToolChip {
  id: string;
  name: string;
  ok: boolean;
  durationMs: number;
}

interface ToolTracePayload {
  id?: string;
  conversationId?: string | null;
  name?: string;
  startedAt?: number;
  finishedAt?: number;
  ok?: boolean;
  error?: string;
}

interface Props {
  conversationId: string;
  /** turnId is kept for future use when the backend adds turnId to the trace payload. */
  turnId: string;
}

export function InlineToolChips({ conversationId }: Props) {
  const [chips, setChips] = useState<ToolChip[]>([]);

  useEffect(() => {
    const off = onEvent<unknown>('assistant:tool-trace', (raw) => {
      if (!raw || typeof raw !== 'object') return;
      const t = raw as ToolTracePayload;
      // Filter to this conversation only (turnId not in payload yet).
      if (t.conversationId !== conversationId) return;
      if (!t.id || !t.name) return;
      const started = typeof t.startedAt === 'number' ? t.startedAt : Date.now();
      const finished = typeof t.finishedAt === 'number' ? t.finishedAt : Date.now();
      const chip: ToolChip = {
        id: t.id,
        name: t.name,
        ok: t.ok === true,
        durationMs: Math.max(0, finished - started),
      };
      setChips((prev) => {
        // Replace existing chip with same id (update) or append.
        const idx = prev.findIndex((c) => c.id === chip.id);
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = chip;
          return next;
        }
        return [...prev, chip];
      });
    });
    return off;
  }, [conversationId]);

  if (chips.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1 pt-1" aria-label="Tool calls in progress">
      {chips.map((chip) => (
        <span
          key={chip.id}
          data-testid="tool-chip"
          className={cn(
            'inline-flex animate-sl-pop-in items-center gap-1 rounded-full border border-border/60 bg-muted/60 px-2 py-0.5 font-mono text-[10px] text-muted-foreground',
          )}
        >
          <span
            aria-hidden
            className={cn(
              'inline-block h-1.5 w-1.5 rounded-full',
              chip.ok ? 'bg-emerald-500' : 'bg-amber-500',
            )}
          />
          {chip.name}
          {chip.durationMs > 0 ? (
            <span className="tabular-nums text-muted-foreground/70">{chip.durationMs}ms</span>
          ) : null}
        </span>
      ))}
    </div>
  );
}
