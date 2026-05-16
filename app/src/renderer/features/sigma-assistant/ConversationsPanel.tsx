// P3-S7 — Sigma Assistant Conversations panel. Sidebar inside SigmaRoom
// listing past chats persisted to the `conversations` + `messages` tables.
// Each row shows a title (derived from the first user message), a relative
// last-touched timestamp, and a count badge. Click loads the conversation;
// the header carries a "+ New" button that drops the active id so the next
// `assistant.send` lazily creates a fresh conversation.

import { MessageSquarePlus, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface ConversationListItem {
  id: string;
  title: string;
  lastMessageAt: number;
  messageCount: number;
  claudeSessionId?: string | null;
}

interface Props {
  items: ConversationListItem[];
  activeId: string | null;
  onPick: (id: string) => void;
  onNew: () => void;
  onDelete?: (id: string) => void;
  className?: string;
}

const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

/** Best-effort relative timestamp ("2h ago", "yesterday", …). Falls back to
 *  an absolute date when the delta exceeds two weeks. */
function rel(ts: number): string {
  const diffMs = ts - Date.now();
  const abs = Math.abs(diffMs);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (abs < hour) return RELATIVE.format(Math.round(diffMs / minute), 'minute');
  if (abs < day) return RELATIVE.format(Math.round(diffMs / hour), 'hour');
  if (abs < 14 * day) return RELATIVE.format(Math.round(diffMs / day), 'day');
  return new Date(ts).toLocaleDateString();
}

export function ConversationsPanel({
  items,
  activeId,
  onPick,
  onNew,
  onDelete,
  className,
}: Props) {
  return (
    <aside
      className={cn(
        'flex h-full w-60 shrink-0 flex-col border-r border-border bg-muted/5',
        className,
      )}
      data-testid="bridge-conversations-panel"
    >
      <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-border bg-muted/10 px-3 text-xs uppercase tracking-wide text-muted-foreground">
        <span className="font-semibold">Conversations</span>
        <button
          type="button"
          onClick={onNew}
          className="inline-flex items-center gap-1 rounded border border-border bg-background px-2 py-0.5 text-[11px] font-medium normal-case text-foreground transition hover:border-primary hover:text-primary"
          aria-label="New conversation"
          title="New conversation"
        >
          <Plus className="h-3 w-3" aria-hidden />
          New
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {items.length === 0 ? (
          <div className="m-auto flex max-w-[200px] flex-col items-center gap-2 px-3 py-6 text-center text-[11px] text-muted-foreground">
            <MessageSquarePlus className="h-5 w-5 text-muted-foreground/70" aria-hidden />
            <span>
              No past conversations yet. Send a prompt to start one — it stays
              persisted across app restarts.
            </span>
          </div>
        ) : null}
        {items.map((row) => {
          const active = row.id === activeId;
          return (
            <div
              key={row.id}
              role="button"
              tabIndex={0}
              onClick={() => onPick(row.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') onPick(row.id);
              }}
              className={cn(
                'group flex cursor-pointer flex-col gap-1 border-b border-border/40 px-3 py-2 text-xs transition',
                active
                  ? 'bg-primary/10 text-foreground'
                  : 'hover:bg-muted/20 text-foreground/90',
              )}
              data-active={active ? 'true' : undefined}
            >
              <div className="flex items-start justify-between gap-2">
                <span className="line-clamp-2 flex-1 break-words text-[12px] font-medium leading-tight">
                  {row.title}
                </span>
                <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">
                  {row.messageCount}
                </span>
              </div>
              <div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
                <span className="min-w-0 truncate">{rel(row.lastMessageAt)}</span>
                {row.claudeSessionId ? (
                  <span
                    className="inline-flex shrink-0 items-center gap-1 rounded-full border border-primary/25 bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary"
                    data-testid="bridge-resumable-pill"
                  >
                    <RotateCcw className="h-2.5 w-2.5" aria-hidden />
                    Resumable
                  </span>
                ) : null}
                {onDelete ? (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete(row.id);
                    }}
                    className="invisible rounded p-0.5 text-muted-foreground hover:bg-destructive/20 hover:text-destructive group-hover:visible"
                    aria-label="Delete conversation"
                    title="Delete conversation"
                  >
                    <Trash2 className="h-3 w-3" aria-hidden />
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
