// V3-W13-012 — Bridge Assistant transcript. Role-tagged messages stream
// char-by-char (assistant rows pick up the parent's `streamingDelta`).
// Auto-sticks to bottom unless the user has scrolled away.

import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';

export type ChatRole = 'user' | 'assistant' | 'tool' | 'system';

export interface ChatMessageView {
  id: string;
  role: ChatRole;
  content: string;
  toolCallId?: string | null;
  createdAt: number;
}

interface Props {
  messages: ChatMessageView[];
  streamingDelta?: string;
  className?: string;
}

const ROLE_LABEL: Record<ChatRole, string> = {
  user: 'YOU',
  assistant: 'SIGMA',
  tool: 'TOOL',
  system: 'SYSTEM',
};

export function ChatTranscript({ messages, streamingDelta, className }: Props) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, streamingDelta]);

  return (
    <div
      ref={scrollRef}
      onScroll={() => {
        const el = scrollRef.current;
        if (!el) return;
        stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
      }}
      className={cn('flex h-full min-h-0 flex-col gap-3 overflow-y-auto px-4 py-3', className)}
    >
      {messages.length === 0 ? (
        <div className="m-auto max-w-sm text-center text-xs text-muted-foreground">
          Ask Sigma to launch panes, search memory, or open a URL. Press
          <kbd className="mx-1 rounded border border-border bg-muted px-1 font-mono text-[10px]">
            Enter
          </kbd>
          to send.
        </div>
      ) : null}
      {messages.map((m) => (
        <ChatRow key={m.id} message={m} streamingDelta={streamingDelta} />
      ))}
    </div>
  );
}

function ChatRow({ message, streamingDelta }: { message: ChatMessageView; streamingDelta?: string }) {
  const r = message.role;
  const label = ROLE_LABEL[r];
  const body = r === 'assistant' && streamingDelta
    ? message.content + streamingDelta
    : message.content;

  return (
    <div
      data-role={r}
      data-message-id={message.id}
      className="flex flex-col gap-1 rounded transition-shadow"
      role="group"
      aria-label={label}
    >
      <div className="flex items-center gap-2">
        <span
          className={cn(
            'inline-flex h-5 items-center rounded-full px-2 font-mono text-[10px] font-semibold uppercase tracking-[0.12em]',
            r === 'assistant' && 'bg-primary/15 text-primary',
            r === 'user' && 'text-muted-foreground',
            r === 'tool' && 'bg-muted text-muted-foreground',
            r === 'system' && 'bg-amber-500/15 text-amber-500',
          )}
        >
          {label}
        </span>
        {r === 'tool' && message.toolCallId ? (
          <span className="text-[10px] font-mono text-muted-foreground">{message.toolCallId}</span>
        ) : null}
        <span className="ml-auto text-[10px] text-muted-foreground/60 tabular-nums">
          {formatTime(message.createdAt)}
        </span>
      </div>
      <div
        className={cn(
          'whitespace-pre-wrap break-words text-sm leading-relaxed',
          r === 'assistant' && 'text-foreground',
          r === 'user' && 'text-foreground/90',
          r === 'tool' && 'rounded border border-border bg-muted/40 px-2 py-1 font-mono text-[11px] text-muted-foreground',
          r === 'system' && 'text-amber-500/90',
        )}
      >
        {r === 'tool' ? <ToolBody content={message.content} /> : body}
      </div>
    </div>
  );
}

function ToolBody({ content }: { content: string }) {
  // Compute outside JSX so the lint rule (no JSX in try/catch) never fires.
  const pretty = prettyPrint(content);
  return pretty === null
    ? <span>{content}</span>
    : <pre className="m-0 whitespace-pre-wrap break-words">{pretty}</pre>;
}

function prettyPrint(content: string): string | null {
  try {
    return JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    return null;
  }
}

function formatTime(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}
