import { cn } from '@/lib/utils';
import type { SwarmMessage } from '@/shared/types';

interface Props {
  message: SwarmMessage;
}

const KIND_BADGE: Record<string, string> = {
  SAY: 'bg-emerald-500/15 text-emerald-300',
  ACK: 'bg-sky-500/15 text-sky-300',
  STATUS: 'bg-amber-500/15 text-amber-300',
  DONE: 'bg-violet-500/15 text-violet-300',
  OPERATOR: 'bg-primary/15 text-primary-foreground',
  ROLLCALL: 'bg-pink-500/15 text-pink-300',
  ROLLCALL_REPLY: 'bg-pink-500/10 text-pink-200',
  SYSTEM: 'bg-muted text-muted-foreground',
};

export function MailboxBubble({ message }: Props) {
  const isOperator = message.fromAgent === 'operator';
  const isBroadcast = message.toAgent === '*';
  return (
    <div
      className={cn(
        'flex w-full',
        isOperator ? 'justify-end' : 'justify-start',
      )}
    >
      <div
        className={cn(
          'flex max-w-[85%] flex-col gap-1 rounded-md border border-border px-3 py-2 text-xs',
          isOperator ? 'bg-primary/10' : 'bg-card/60',
        )}
      >
        <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground">
          <span
            className={cn(
              'rounded px-1.5 py-0.5 text-[10px] font-medium',
              KIND_BADGE[message.kind] ?? KIND_BADGE.SYSTEM,
            )}
          >
            {message.kind}
          </span>
          <span>
            {message.fromAgent} → {isBroadcast ? 'all' : message.toAgent}
          </span>
          <span className="ml-auto opacity-60">{formatTime(message.ts)}</span>
        </div>
        <div className="whitespace-pre-wrap text-sm text-foreground">{message.body}</div>
      </div>
    </div>
  );
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}
