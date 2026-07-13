// V3-W13-012 — Sigma Assistant transcript. Role-tagged messages stream
// char-by-char (assistant rows pick up the parent's `streaming` object).
// Auto-sticks to bottom unless the user has scrolled away.
// Phase 6 — stream-reveal (rAF catch-up), spring bubble-enter, inline tool chips.

import { memo, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { cn } from '@/lib/utils';
import { useJorvisStreamReveal } from './use-jorvis-stream-reveal';
import { InlineToolChips } from './InlineToolChips';

export type ChatRole = 'user' | 'assistant' | 'tool' | 'system' | 'error';

export interface ChatMessageView {
  id: string;
  role: ChatRole;
  content: string;
  toolCallId?: string | null;
  createdAt: number;
}

interface Props {
  messages: ChatMessageView[];
  /**
   * Phase 6: pass the full streaming object (turnId+delta+messageId) instead of
   * a bare string. `messageId` is the id the committed row will eventually take
   * — used to key the in-flight sentinel so React reuses the DOM node across the
   * commit (no remount → no re-spring).
   */
  streaming?: { turnId: string; delta: string; messageId?: string | null } | null;
  /** Legacy prop kept for backward-compat — ignored when `streaming` is provided. */
  streamingDelta?: string;
  /**
   * True while a turn is in-flight but no text has streamed in yet (the
   * "thinking" gap between send and the first token). Drives the typing-dots
   * bubble. The backend only sets `streaming` once the first delta arrives, so
   * the dots cannot ride on the streaming sentinel — they ride on this flag.
   */
  pending?: boolean;
  conversationId?: string | null;
  /** P0.2 — re-sends the last user prompt. Rendered as a "Retry" button on
   *  the most recent `error` row only; omitted elsewhere. */
  onRetry?: () => void;
  className?: string;
}

const ROLE_LABEL: Record<ChatRole, string> = {
  user: 'YOU',
  assistant: 'JORVIS',
  tool: 'TOOL',
  system: 'SYSTEM',
  error: 'ERROR',
};

// Sentinel: the in-flight streaming row uses this id so ChatRow can identify it.
const STREAMING_ROW_ID = '__streaming__';

export function ChatTranscript({ messages, streaming, streamingDelta, pending, conversationId, onRetry, className }: Props) {
  // Resolve the effective streaming object: prefer the new `streaming` prop,
  // fall back to the legacy `streamingDelta` string for backward-compat.
  // Memoized so it has a stable identity and doesn't cause useEffect to re-run
  // on every render when both `streaming` and `streamingDelta` are undefined.
  const effectiveStreaming = useMemo(
    () =>
      streaming !== undefined
        ? streaming
        : streamingDelta != null
          ? { turnId: '', delta: streamingDelta, messageId: null }
          : null,
    [streaming, streamingDelta],
  );

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
  // Phase 6 — key the sentinel row by the turn's EVENTUAL committed messageId
  // when it's known (it rides along on the delta events). When the turn commits,
  // the standby handler appends a message with this exact id, so React keeps the
  // same key → reuses the same DOM node → no remount → the bubble does NOT
  // re-spring. Falls back to a constant sentinel id when the messageId is not yet
  // known (persistence failed / pre-first-delta); in that case the row simply
  // disappears on commit without a committed twin, so there's no double-spring.
  const inFlightRowId =
    (effectiveStreaming?.messageId && effectiveStreaming.messageId.length > 0)
      ? effectiveStreaming.messageId
      : STREAMING_ROW_ID;
  // Guard against a duplicate React key: if the committed row already landed in
  // `messages` (event-ordering edge where the standby-commit appended the message
  // before `streaming` cleared), the committed row wins and we skip the sentinel.
  const committedAlreadyPresent =
    hasInFlight && inFlightRowId !== STREAMING_ROW_ID
      ? messages.some((m) => m.id === inFlightRowId)
      : false;
  // createdAt 0 for the sentinel row — formatTime returns '' for 0, which is
  // acceptable: a streaming row has no committed timestamp yet.
  const inFlightMsg: ChatMessageView | null =
    hasInFlight && !committedAlreadyPresent
      ? { id: inFlightRowId, role: 'assistant', content: '', createdAt: 0 }
      : null;

  // Pre-first-token "thinking" gap: a turn is in-flight (`pending`) but no
  // stream has started yet, so there's no in-flight sentinel. Render a typing
  // bubble so the user sees Jorvis is replying. It's swapped for the streaming
  // row (or its committed twin) the moment the first delta lands.
  const showPending = pending === true && !hasInFlight;
  const pendingMsg: ChatMessageView | null = showPending
    ? { id: STREAMING_ROW_ID, role: 'assistant', content: '', createdAt: 0 }
    : null;

  const allRows: ChatMessageView[] = inFlightMsg
    ? [...messages, inFlightMsg]
    : pendingMsg
      ? [...messages, pendingMsg]
      : messages;

  // P0.2 — Retry renders ONLY when the error row is the LAST committed
  // message: retrying is meaningful exactly while nothing has happened since
  // the failure. "Most recent error anywhere" kept the button alive forever
  // (messages are append-only), and a click after later successful turns
  // re-sent whatever lastSentPromptRef held by then — a stale/duplicate send
  // that could orphan a live turn. Computed from `messages` (error rows are
  // always committed, never the in-flight sentinel/pending row) so its value
  // is stable across stream deltas; the local user-row echo in sendPrompt
  // also makes the button vanish the moment a retry is dispatched.
  const lastErrorId = useMemo(() => {
    const last = messages[messages.length - 1];
    return last && last.role === 'error' ? last.id : null;
  }, [messages]);

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
      {messages.length === 0 && !hasInFlight && !showPending ? (
        <div className="m-auto max-w-sm text-center text-xs text-muted-foreground">
          Ask Jorvis to launch panes, search memory, or open a URL. Press
          <kbd className="mx-1 rounded border border-border bg-muted px-1 font-mono text-[10px]">
            Enter
          </kbd>
          to send.
        </div>
      ) : null}
      {allRows.map((m) => {
        // The in-flight row is the sentinel we appended above (identified by the
        // resolved `inFlightRowId`, which is either the eventual messageId or the
        // constant sentinel). `inFlightMsg` is only non-null while streaming, and
        // a stored message never shares the sentinel's identity until AFTER the
        // turn commits (at which point `effectiveStreaming` is null again).
        const isStreaming = inFlightMsg != null && m === inFlightMsg;
        const isPending = pendingMsg != null && m === pendingMsg;
        // Only the last error row receives a defined onRetry — every other
        // row keeps the same `undefined` prop value across renders so
        // memo(ChatRow) still skips them (perf audit #3 contract).
        const isLastError = m.role === 'error' && m.id === lastErrorId;
        return (
          <ChatRow
            key={m.id}
            message={m}
            isStreaming={isStreaming}
            isPending={isPending}
            streamingDelta={isStreaming ? effectiveStreaming!.delta : undefined}
            conversationId={conversationId}
            streamingTurnId={isStreaming ? effectiveStreaming!.turnId : undefined}
            onRetry={isLastError ? onRetry : undefined}
          />
        );
      })}
    </div>
  );
}

interface ChatRowProps {
  message: ChatMessageView;
  isStreaming: boolean;
  /** True for the typing-dots placeholder shown during the pre-token gap. */
  isPending?: boolean;
  streamingDelta?: string;
  conversationId?: string | null;
  streamingTurnId?: string;
  /** Defined only for the single row Retry should render on (P0.2). */
  onRetry?: () => void;
}

// Perf audit 2026-06-10 #3 — memo'd: committed rows keep stable props across
// stream deltas (stable message object identity; isStreaming=false), so only
// the in-flight sentinel re-renders per delta. The sentinel's key handoff to
// its committed twin (Phase-6 H1 anti-double-spring) lives in the PARENT's
// key={m.id} and is untouched by memoization.
const ChatRow = memo(function ChatRow({ message, isStreaming, isPending, streamingDelta, conversationId, streamingTurnId, onRetry }: ChatRowProps) {
  // Spring bubble-enter: React-19 ref-as-prop, applied exactly once via useLayoutEffect([]).
  const rootRef = useRef<HTMLDivElement | null>(null);
  const played = useRef(false);
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el || played.current) return;
    played.current = true;
    el.classList.add('sl-slide-up');
    el.dataset.entered = '1';
  }, []);

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
            r === 'error' && 'bg-destructive/15 text-destructive',
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
          r === 'error' && 'text-destructive/90',
        )}
      >
        {r === 'tool' ? (
          <ToolBody content={message.content} />
        ) : isPending || (isStreaming && body.length === 0) ? (
          // Pre-first-token: Jorvis is replying but no text has streamed in yet
          // (`isPending` = the think gap before streaming; the `isStreaming`
          // branch covers an in-flight row that's momentarily empty). Show the
          // animated typing-dots bubble instead of a lone caret.
          <TypingDots />
        ) : (
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
      {/* P0.2 — Retry, rendered only on the last error row (onRetry is
          undefined for every other row; see the map in ChatTranscript). */}
      {r === 'error' && onRetry ? (
        <button
          type="button"
          className="self-start rounded border border-destructive/30 bg-background/60 px-2 py-0.5 text-[11px] font-medium text-destructive transition hover:bg-destructive/15"
          onClick={onRetry}
        >
          Retry
        </button>
      ) : null}
    </div>
  );
});

/**
 * Three staggered dots shown while Jorvis is composing a reply but before the
 * first tokens stream in — the classic "is typing…" affordance. Tinted with the
 * assistant accent (text-primary → currentColor). Reduced-motion safe (the
 * bounce is dropped in CSS; the dots stay visible). role="status" announces
 * "Jorvis is typing" to assistive tech.
 */
function TypingDots() {
  return (
    <span
      className="sl-typing text-primary"
      role="status"
      aria-label="Jorvis is typing"
      data-testid="jorvis-typing"
    >
      <span className="sl-typing-dot" />
      <span className="sl-typing-dot" />
      <span className="sl-typing-dot" />
    </span>
  );
}

function ToolBody({ content }: { content: string }) {
  // Compute outside JSX so the lint rule (no JSX in try/catch) never fires.
  // Perf audit #3 — memoized: historical tool rows re-ran JSON.parse +
  // stringify on every transcript render; content is stable for committed rows.
  const pretty = useMemo(() => prettyPrint(content), [content]);
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
