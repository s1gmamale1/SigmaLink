// V3-W13-013 — Bridge Assistant tool-call inspector. Listens for
// `assistant:tool-trace`; rows expand to show args + result JSON.

import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Wrench } from 'lucide-react';
import { onEvent } from '@/renderer/lib/rpc';
import { cn } from '@/lib/utils';

interface ToolTrace {
  id: string;
  conversationId: string | null;
  name: string;
  startedAt: number;
  finishedAt: number;
  args: Record<string, unknown>;
  ok: boolean;
  result: unknown;
  error?: string;
}

const MAX_ROWS = 50;

export function ToolCallInspector({ className }: { className?: string }) {
  const [traces, setTraces] = useState<ToolTrace[]>([]);
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    const off = onEvent<unknown>('assistant:tool-trace', (raw) => {
      const t = coerceTrace(raw);
      if (!t) return;
      setTraces((prev) => [t, ...prev].slice(0, MAX_ROWS));
    });
    return off;
  }, []);

  return (
    <section
      className={cn('flex shrink-0 flex-col border-t border-border bg-muted/20 text-xs', className)}
      aria-label="Tool calls"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 px-3 py-1.5 text-left text-muted-foreground transition hover:text-foreground"
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <Wrench className="h-3 w-3" />
        <span className="font-medium">Tool calls</span>
        <span className="ml-auto rounded-full bg-muted px-2 py-0 text-[10px] tabular-nums">
          {traces.length}
        </span>
      </button>
      {open ? (
        <div className="max-h-48 overflow-y-auto border-t border-border">
          {traces.length === 0 ? (
            <div className="px-3 py-2 text-muted-foreground/80">No tool calls yet.</div>
          ) : (
            traces.map((t) => (
              <ToolRow
                key={t.id}
                trace={t}
                expanded={expanded === t.id}
                onToggle={() => setExpanded((cur) => (cur === t.id ? null : t.id))}
              />
            ))
          )}
        </div>
      ) : null}
    </section>
  );
}

function ToolRow({
  trace,
  expanded,
  onToggle,
}: {
  trace: ToolTrace;
  expanded: boolean;
  onToggle: () => void;
}) {
  const ms = Math.max(0, trace.finishedAt - trace.startedAt);
  return (
    <div data-ok={trace.ok} className="border-b border-border/50 last:border-b-0">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition hover:bg-accent/30"
      >
        <span
          aria-hidden
          className={cn(
            'inline-block h-2 w-2 rounded-full',
            trace.ok ? 'bg-emerald-500' : 'bg-amber-500',
          )}
        />
        <span className="font-mono text-[11px]">{trace.name}</span>
        <span className="ml-auto tabular-nums text-[10px] text-muted-foreground">{ms}ms</span>
        {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
      </button>
      {expanded ? (
        <div className="space-y-1 border-t border-border/50 bg-background/40 px-3 py-2 font-mono text-[11px]">
          <Section label="args" body={JSON.stringify(trace.args, null, 2)} />
          {trace.ok ? (
            <Section label="result" body={JSON.stringify(trace.result, null, 2)} />
          ) : (
            <Section label="error" body={trace.error ?? 'unknown error'} accent="amber" />
          )}
        </div>
      ) : null}
    </div>
  );
}

function Section({
  label,
  body,
  accent,
}: {
  label: string;
  body: string;
  accent?: 'amber';
}) {
  return (
    <div>
      <div className={accent === 'amber' ? 'text-amber-500' : 'text-muted-foreground'}>{label}</div>
      <pre
        className={cn(
          'm-0 whitespace-pre-wrap break-words',
          accent === 'amber' ? 'text-amber-500/90' : 'text-foreground',
        )}
      >
        {body}
      </pre>
    </div>
  );
}

function coerceTrace(raw: unknown): ToolTrace | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || typeof r.name !== 'string') return null;
  return {
    id: r.id,
    conversationId: typeof r.conversationId === 'string' ? r.conversationId : null,
    name: r.name,
    startedAt: typeof r.startedAt === 'number' ? r.startedAt : Date.now(),
    finishedAt: typeof r.finishedAt === 'number' ? r.finishedAt : Date.now(),
    args: r.args && typeof r.args === 'object' ? (r.args as Record<string, unknown>) : {},
    ok: r.ok === true,
    result: r.result ?? null,
    error: typeof r.error === 'string' ? r.error : undefined,
  };
}
