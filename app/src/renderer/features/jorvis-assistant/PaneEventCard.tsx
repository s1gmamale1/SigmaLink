import { cn } from '@/lib/utils';
import { Terminal, AlertTriangle, Play } from 'lucide-react';

export type PaneEventKind = 'started' | 'exited' | 'error' | 'output-spike' | 'idle';

export interface PaneEvent {
  id: string;
  conversationId: string;
  sessionId: string;
  kind: PaneEventKind;
  body?: Record<string, unknown> | null;
  ts: number;
}

interface Props {
  event: PaneEvent;
  onReply?: (event: PaneEvent) => void;
}

const KIND_CONFIG: Record<PaneEventKind, { label: string; icon: typeof Terminal; tone: string; bg: string; border: string }> = {
  started:   { label: 'Pane started',   icon: Play,          tone: 'text-emerald-700 dark:text-emerald-300', bg: 'bg-emerald-500/10', border: 'border-emerald-500/25' },
  exited:    { label: 'Pane exited',    icon: Terminal,      tone: 'text-slate-700 dark:text-slate-300',   bg: 'bg-slate-500/10',   border: 'border-slate-500/25' },
  error:     { label: 'Pane error',     icon: AlertTriangle, tone: 'text-red-700 dark:text-red-300',       bg: 'bg-red-500/10',     border: 'border-red-500/25' },
  'output-spike': { label: 'Output spike', icon: Terminal, tone: 'text-amber-700 dark:text-amber-300',     bg: 'bg-amber-500/10',   border: 'border-amber-500/25' },
  idle:      { label: 'Pane idle',      icon: Terminal,      tone: 'text-blue-700 dark:text-blue-300',      bg: 'bg-blue-500/10',    border: 'border-blue-500/25' },
};

export function PaneEventCard({ event, onReply }: Props) {
  const cfg = KIND_CONFIG[event.kind];
  const Icon = cfg.icon;
  return (
    <div className={cn('flex items-start gap-2 rounded border px-3 py-2 text-xs', cfg.bg, cfg.border)}>
      <Icon className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', cfg.tone)} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className={cn('font-medium', cfg.tone)}>{cfg.label}</div>
        <div className="text-muted-foreground">
          Session {event.sessionId.slice(0, 8)}
          {event.body?.exitCode !== undefined ? ` · exit ${event.body.exitCode}` : null}
        </div>
      </div>
      {onReply ? (
        <button
          type="button"
          className="shrink-0 rounded border border-border bg-background px-2 py-0.5 text-[11px] font-medium transition hover:bg-muted"
          onClick={() => onReply(event)}
        >
          Reply to pane
        </button>
      ) : null}
    </div>
  );
}
