// V3-W13-012 — Sigma Assistant transcript. Role-tagged messages stream
// char-by-char (assistant rows pick up the parent's `streaming` object).
// Auto-sticks to bottom unless the user has scrolled away.
// Phase 6 — stream-reveal (rAF catch-up), spring bubble-enter, inline tool chips.

import { useEffect, useLayoutEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import { useJorvisStreamReveal } from './use-jorvis-stream-reveal';
import { InlineToolChips } from './InlineToolChips';

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
  /** Phase 6: pass the full streaming object (turnId+delta) instead of bare string. */
  streaming?: { turnId: string; delta: string } | null;
  /** Legacy prop kept for backward-compat — ignored when `streaming` is provided. */
  streamingDelta?: string;
  conversationId?: string | null;
  className?: string;
}

const ROLE_LABEL: Record<ChatRole, string> = {
  user: 'YOU',
  assistant: 'JORVIS',
  tool: 'TOOL',
  system: 'SYSTEM',
};

// Sentinel: the in-flight streaming row uses this id so ChatRow can identify it.
const STREAMING_ROW_ID = '__streaming__';

export function ChatTranscript({ messages, streaming, streamingDelta, conversationId, className }: Props) {
  // Resolve the effective streaming object: prefer the new `streaming` prop,
  // fall back to the legacy `streamingDelta` string for backward-compat.
  const effectiveStreaming = streaming !== undefined
    ? streaming
    : (streamingDelta != null ? { turnId: '', delta: streamingDelta } : null);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, effectiveStreaming]);

  // Build the rows: all stored messages + an in-flight row when streaming.
  // The in-flight row is SEPARATE from the stored messages — it's a virtual
  // bubble that disappears once the turn commits and the final message is added.
  const hasInFlight = effectiveStreaming != null;
  const inFlightMsg: ChatMessageView | null = hasInFlight
    ? { id: STREAMING_ROW_ID, role: 'assistant', content: '', createdAt: Date.now() }
    : null;

  const allRows: ChatMessageView[] = inFlightMsg
    ? [...messages, inFlightMsg]
    : messages;

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
      {messages.length === 0 && !hasInFlight ? (
        <div className="m-auto max-w-sm text-center text-xs text-muted-foreground">
          Ask Jorvis to launch panes, search memory, or open a URL. Press
          <kbd className="mx-1 rounded border border-border bg-muted px-1 font-mono text-[10px]">
            Enter
          </kbd>
          to send.
        </div>
      ) : null}
      {allRows.map((m) => {
        const isStreaming = m.id === STREAMING_ROW_ID && effectiveStreaming != null;
        return (
          <ChatRow
            key={m.id}
            message={m}
            isStreaming={isStreaming}
            streamingDelta={isStreaming ? effectiveStreaming!.delta : undefined}
            conversationId={conversationId}
            streamingTurnId={isStreaming ? effectiveStreaming!.turnId : undefined}
          />
        );
      })}
    </div>
  );
}

interface ChatRowProps {
  message: ChatMessageView;
  isStreaming: boolean;
  streamingDelta?: string;
  conversationId?: string | null;
  streamingTurnId?: string;
}

function ChatRow({ message, isStreaming, streamingDelta, conversationId, streamingTurnId }: ChatRowProps) {
  // Spring bubble-enter: React-19 ref-as-prop, applied exactly once via useLayoutEffect([]).
  const rootRef = useRef<HTMLDivElement | null>(null);
  const played = useRef(false);
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el || played.current) return;
    played.current = true;
    el.classList.add('sl-slide-up');
    el.dataset.entered = '1';
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Stream reveal hook — called unconditionally (stable hook order).
  // For non-streaming rows: active=false → instant full text, no rAF.
  const delta = isStreaming ? (streamingDelta ?? '') : '';
  const { revealed, caret } = useJorvisStreamReveal(delta, isStreaming);

  const r = message.role;
  const label = ROLE_LABEL[r];

  // Body: for the in-flight streaming row, show the reveal-accumulated text.
  // For completed rows, show their stored content.
  const body = isStreaming
    ? message.content + revealed
    : message.content;

  return (
    <div
      ref={rootRef}
      data-role={r}
      data-message-id={message.id}
      data-testid={`chat-row-${message.id}`}
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
        {r === 'tool' ? <ToolBody content={message.content} /> : (
          <>
            {body}
            {caret ? <span data-caret className="sl-caret">&#x2588;</span> : null}
          </>
        )}
      </div>
      {/* Inline tool chips — only for the active in-flight assistant row */}
      {isStreaming && conversationId && streamingTurnId ? (
        <InlineToolChips conversationId={conversationId} turnId={streamingTurnId} />
      ) : null}
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
