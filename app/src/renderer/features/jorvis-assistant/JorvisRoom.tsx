// V3-W13-012 / V3-W13-015 — Jorvis Assistant root.
// Hosts orb + transcript + composer + tool-call inspector. Owns the active
// conversation, the in-flight streaming buffer, the orb state machine, and
// the cross-workspace dispatch echo handler (jump-to-pane + ding).
// P3-S7 — Adds a left-side Conversations panel that lists past chats from
// `assistant.conversations.list` and persists the active conversation id
// in `kv['sigma.activeConversationId']` so a fresh app launch restores
// the same thread the user was in.

import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { Bot, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import { rpc } from '@/renderer/lib/rpc';
import { PANE_DRAG_MIME, buildPaneContext, type PaneDragPayload } from '@/renderer/lib/pane-context-builder';
import { useAppDispatch, useAppStateSelector } from '@/renderer/app/state';
import { EmptyState } from '@/renderer/components/EmptyState';
import { cn } from '@/lib/utils';
import { Orb, type OrbState } from './Orb';
import { ChatTranscript } from './ChatTranscript';
import { Composer, type ComposerExternalValue } from './Composer';
import { ToolCallInspector } from './ToolCallInspector';
import { ConversationsPanel } from './ConversationsPanel';
import { PaneEventCard, type PaneEvent } from './PaneEventCard';
import { useJorvisPaneEvents } from './use-jorvis-pane-events';
import {
  useJorvisConversations,
  persistActiveConversation,
} from './use-jorvis-conversations';
import { useJorvisResumeFlow } from './use-jorvis-resume-flow';
import { SigmaRailDropdown } from './SigmaRailDropdown';
import { ResumeBanner } from './ResumeBanner';
import { InterruptedTurnBanner } from './InterruptedTurnBanner';
import { PatternRibbon } from './PatternRibbon';
import { useJorvisRufloHealth } from './use-jorvis-ruflo-health';
import { useJorvisPatternProbe } from './use-jorvis-pattern-probe';
import { useJorvisDispatchEcho } from './use-jorvis-dispatch-echo';
import { useJorvisJumpToMessage } from './use-jorvis-jump-to-message';
import { useJorvisVoice } from './use-jorvis-voice';
import { useJorvisAssistantState } from './use-jorvis-assistant-state';

interface Props {
  /** Compact mode trims the header chrome — used inside the right-rail tab. */
  variant?: 'standalone' | 'rail';
  className?: string;
}

/**
 * B3 — renderer-side per-turn watchdog. If a turn never emits 'standby'
 * (e.g. the `claude` CLI blocks on an interactive trust/login prompt in dev
 * and produces no envelopes), the composer would stay gated forever. After
 * this long with no terminal state the renderer self-heals: clears `busy`,
 * resets the Orb to standby, and retires the active turn id. Generous so a
 * legitimately slow turn isn't cut off mid-stream — the main-side turn timeout
 * (runClaudeCliTurn) is the primary teardown; this is the renderer backstop.
 */
const TURN_WATCHDOG_MS = 120_000;

export function JorvisRoom({ variant = 'standalone', className }: Props) {
  // Perf audit 2026-06-10 #5 — narrow selectors (PERF-3 continuation). The
  // broad useAppState() context read re-rendered the whole transcript subtree
  // on every global dispatch.
  const dispatch = useAppDispatch();
  const activeWorkspace = useAppStateSelector((s) => s.activeWorkspace);
  const workspaces = useAppStateSelector((s) => s.workspaces);
  const wsId = activeWorkspace?.id;

  const {
    conversations,
    conversationId,
    setConversationId,
    messages,
    setMessages,
    resumeNotice,
    setResumeNotice,
    refreshConversations,
    hydrateConversation,
    onPickConversation,
    onDeleteConversation,
    clearConversation,
  } = useJorvisConversations();

  const { interruptedTurn, dismissInterrupted, resetDismissed } = useJorvisResumeFlow(messages);

  const [streaming, setStreaming] = useState<
    { turnId: string; delta: string; messageId: string | null } | null
  >(null);
  const [orbState, setOrbState] = useState<OrbState>('standby');
  const [busy, setBusy] = useState(false);
  const [composerText, setComposerText] = useState('');
  const [ribbonHidden, setRibbonHidden] = useState(false);
  const [composerExternalValue, setComposerExternalValue] = useState<
    ComposerExternalValue | undefined
  >(undefined);
  /** 2026-06-10 audit #5 — every programmatic composer push goes through
   *  here. The nonce bump makes consecutive identical pushes (clearing to ''
   *  after a banner-retry/voice send) distinct, so Composer always re-syncs. */
  const pushComposerValue = useCallback((value: string) => {
    setComposerExternalValue((prev) => ({ value, nonce: (prev?.nonce ?? 0) + 1 }));
  }, []);
  const lastSentPromptRef = useRef<string | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const sendPromptRef = useRef<(prompt: string) => Promise<void>>(async () => {});
  // B3 — the turn THIS room started this session. The assistant-state handler
  // only moves busy/orb for events whose turnId matches this ref, so a stale /
  // boot / cross-conversation `assistant:state` event can never latch `busy`.
  const activeTurnIdRef = useRef<string | null>(null);
  // B3 — mirror of `busy` so the event handler can read it synchronously
  // (to adopt the first event of an in-flight turn) without re-subscribing.
  // Writing a ref in an effect is allowed; `react-hooks/set-state-in-effect`
  // only forbids setState in the effect body.
  const busyRef = useRef(busy);
  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);
  // 2026-06-10 audit #4 — mirror of `streaming` for the assistant-state
  // handler: the standby commit reads the buffered delta from this ref as a
  // sibling setState instead of nesting setMessages inside the setStreaming
  // updater. The handler writes it synchronously per delta; this effect
  // re-syncs it when JorvisRoom clears `streaming` externally (watchdog
  // timeout, onNewConversation reset).
  const streamingRef = useRef(streaming);
  useEffect(() => {
    streamingRef.current = streaming;
  }, [streaming]);
  // B3 — per-turn watchdog timer. If a turn never reaches 'standby' within
  // TURN_WATCHDOG_MS the composer would be permanently gated; the watchdog
  // resets busy + orb so a hung turn can't brick the room.
  const watchdogTimerRef = useRef<number | null>(null);

  const clearWatchdog = useCallback(() => {
    if (watchdogTimerRef.current !== null) {
      window.clearTimeout(watchdogTimerRef.current);
      watchdogTimerRef.current = null;
    }
  }, []);

  const { rufloReady, rufloReadyRef } = useJorvisRufloHealth();
  const { patternHit } = useJorvisPatternProbe({ composerText, rufloReady });
  useJorvisDispatchEcho({
    workspaces,
    activeWorkspaceId: wsId,
    dispatch,
  });
  useJorvisJumpToMessage({ conversationId, hydrateConversation, transcriptRef });
  useJorvisAssistantState({
    conversationId,
    setMessages,
    setOrbState,
    setBusy,
    setStreaming,
    lastSentPromptRef,
    rufloReadyRef,
    activeTurnIdRef,
    busyRef,
    streamingRef,
    clearWatchdog,
  });
  const { onOrbClick } = useJorvisVoice({ composerRef, sendPromptRef, setOrbState });

  // Reset ribbon dismissal when the conversation or workspace changes.
  useEffect(() => {
    let alive = true;
    const id = window.setTimeout(() => {
      if (alive) setRibbonHidden(false);
    }, 0);
    return () => {
      alive = false;
      window.clearTimeout(id);
    };
  }, [conversationId, wsId]);

  // Reset dismissed interrupted IDs when the conversation changes.
  useEffect(() => {
    resetDismissed();
  }, [conversationId, resetDismissed]);

  const sendPrompt = useCallback(
    async (prompt: string) => {
      if (!activeWorkspace) {
        toast.error('Open a workspace before talking to Jorvis.');
        return;
      }
      lastSentPromptRef.current = prompt;
      setComposerText('');
      pushComposerValue('');
      setMessages((rows) => [
        ...rows,
        {
          id: `local-${Date.now()}`,
          role: 'user',
          content: prompt,
          createdAt: Date.now(),
        },
      ]);
      setBusy(true);
      setOrbState('thinking');
      // B3 — arm the per-turn watchdog. If no terminal 'standby'/'error' for
      // this turn arrives in time, self-heal so the composer can't stay gated
      // forever on a hung turn. Armed BEFORE the await so a turn that hangs at
      // dispatch is still covered.
      clearWatchdog();
      watchdogTimerRef.current = window.setTimeout(() => {
        watchdogTimerRef.current = null;
        activeTurnIdRef.current = null;
        setBusy(false);
        setOrbState('standby');
        setStreaming(null);
        lastSentPromptRef.current = null;
        toast.error('Jorvis stopped responding', {
          description: 'The turn timed out. You can send your message again.',
        });
      }, TURN_WATCHDOG_MS);
      try {
        const res = await rpc.assistant.send({
          workspaceId: activeWorkspace.id,
          conversationId: conversationId ?? undefined,
          prompt,
        });
        // B3 — record the live turn id so the assistant-state handler only
        // reacts to events for THIS turn (boot/stale events are dropped).
        activeTurnIdRef.current = res.turnId;
        setConversationId(res.conversationId);
        persistActiveConversation(res.conversationId);
        void refreshConversations(activeWorkspace.id);
      } catch (err) {
        clearWatchdog();
        activeTurnIdRef.current = null;
        setBusy(false);
        setOrbState('standby');
        toast.error('Jorvis failed to accept your message', {
          description: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [
      activeWorkspace,
      conversationId,
      setConversationId,
      setMessages,
      refreshConversations,
      clearWatchdog,
      pushComposerValue,
    ],
  );

  useEffect(() => {
    sendPromptRef.current = sendPrompt;
  }, [sendPrompt]);

  // P0.2 — Retry re-sends the last user prompt captured by `sendPrompt`
  // above. `lastSentPromptRef` survives a failed turn untouched (the error
  // handler in useJorvisAssistantState returns before reaching the
  // standby branch that would otherwise consume it for the Ruflo
  // pattern-store fire-and-forget), so it's still valid on click. The `busy`
  // guard (and withholding the prop entirely at the render site) keeps a
  // Retry click from racing a live turn — a second concurrent send would
  // overwrite activeTurnIdRef and silently orphan the in-flight turn's
  // events.
  const onRetryError = useCallback(() => {
    if (busy) return;
    const prompt = lastSentPromptRef.current;
    if (!prompt) return;
    void sendPrompt(prompt);
  }, [busy, sendPrompt]);

  // B3 — make sure a pending watchdog timer never fires after unmount.
  useEffect(() => clearWatchdog, [clearWatchdog]);

  const onNewConversation = useCallback(() => {
    clearConversation();
    resetDismissed();
    setStreaming(null);
    setOrbState('standby');
    setBusy(false);
    // B3 — retire any in-flight turn + cancel its watchdog so the fresh
    // conversation starts ungated and a stray standby for the old turn is
    // ignored.
    clearWatchdog();
    activeTurnIdRef.current = null;
    composerRef.current?.focus();
  }, [clearConversation, resetDismissed, clearWatchdog]);

  // P0.4 — fresh-session control. Distinct from onNewConversation above:
  // this clears the Claude CLI resume id for the ACTIVE conversation so the
  // next turn starts a clean context, but keeps the transcript on screen.
  // Final-review fix — newSession CANCELS an in-flight turn on main, and a
  // cancelled turn emits no terminal event, so mirror onNewConversation's
  // local reset here or a mid-turn click leaves the Orb/composer stuck on
  // "thinking" until the watchdog.
  const onFreshSession = useCallback(() => {
    if (!conversationId) return;
    setStreaming(null);
    setOrbState('standby');
    setBusy(false);
    clearWatchdog();
    activeTurnIdRef.current = null;
    void rpc.assistant
      .newSession({ conversationId })
      .then(() => {
        toast.success('Fresh Jorvis session — history kept.');
      })
      .catch((err: unknown) => {
        toast.error('Could not start a fresh session', {
          description: err instanceof Error ? err.message : String(err),
        });
      });
  }, [conversationId, clearWatchdog]);

  const paneEvents = useJorvisPaneEvents(conversationId);

  function handleComposerDragOver(e: DragEvent<HTMLDivElement>): void {
    if (e.dataTransfer.types.includes(PANE_DRAG_MIME)) {
      e.preventDefault();
    }
  }

  function handleComposerDrop(e: DragEvent<HTMLDivElement>): void {
    if (!e.dataTransfer.types.includes(PANE_DRAG_MIME)) return;
    e.preventDefault();
    const raw = e.dataTransfer.getData(PANE_DRAG_MIME);
    try {
      const payload = JSON.parse(raw) as PaneDragPayload;
      void buildPaneContext(payload).then((ctx) => {
        pushComposerValue(ctx);
      }).catch(() => undefined);
    } catch {
      /* malformed payload — ignore */
    }
  }

  const handlePaneReply = useCallback((evt: PaneEvent) => {
    const context = `Pane event: ${evt.kind} for session ${evt.sessionId.slice(0, 8)}${evt.body?.exitCode !== undefined ? ` (exit ${evt.body.exitCode})` : ''}`;
    void sendPromptRef.current(context);
  }, []);

  const activeConversation = useMemo(
    () => conversations.find((row) => row.id === conversationId) ?? null,
    [conversations, conversationId],
  );

  if (!activeWorkspace) {
    return (
      <div className={cn('flex h-full min-h-0 flex-col bg-background', className)}>
        <EmptyState
          icon={Bot}
          title="Jorvis"
          description="Open a workspace to talk to Jorvis."
        />
      </div>
    );
  }

  const showPanel = variant === 'standalone';

  return (
    <div
      className={cn('flex h-full min-h-0 flex-row bg-background', className)}
      data-jorvis-room={variant}
    >
      {showPanel ? (
        <ConversationsPanel
          items={conversations}
          activeId={conversationId}
          onPick={onPickConversation}
          onNew={onNewConversation}
          onDelete={(id) => void onDeleteConversation(id)}
        />
      ) : null}
      {/* min-w-0 is load-bearing, not cosmetic. This column is a flex item in the
          row above, so its default `min-width: auto` floors it at its CONTENT's
          min-content width. A long unbreakable token in a message (e.g. a tool
          result's JSON) then blows the column wider than the panel — and the
          composer, a sibling in this column, stretches with it and stops
          wrapping. `break-words` does NOT prevent this: overflow-wrap only
          breaks for layout, it does not shrink min-content. The vertical twin
          (min-h-0) was already here; this is the horizontal one. */}
      <div className={cn('flex h-full min-h-0 min-w-0 flex-1 flex-col', variant === 'rail' && 'px-3')}>
        {variant === 'standalone' ? (
          <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-muted/10 px-3 text-sm">
            <Bot className="h-4 w-4 text-primary" aria-hidden />
            <h2 className="text-sm font-semibold tracking-tight">Jorvis</h2>
            <span className="ml-2 truncate text-xs text-muted-foreground">
              {activeWorkspace.name}
            </span>
            {conversationId ? (
              <button
                type="button"
                onClick={onFreshSession}
                className="ml-auto inline-flex shrink-0 items-center gap-1 rounded border border-border bg-background px-2 py-0.5 text-[11px] font-medium text-foreground transition hover:border-primary hover:text-primary"
                aria-label="New session (keep history)"
                title="New session (keep history)"
              >
                <RotateCcw className="h-3 w-3" aria-hidden />
                Fresh session
              </button>
            ) : null}
          </header>
        ) : (
          <SigmaRailDropdown
            conversations={conversations}
            activeConversation={activeConversation}
            conversationId={conversationId}
            onPick={onPickConversation}
          />
        )}
        <div className="flex shrink-0 items-center justify-center border-b border-border/50 bg-background px-4 py-3">
          <Orb state={orbState} onClick={onOrbClick} />
        </div>
        <div ref={transcriptRef} className="flex min-h-0 flex-1 flex-col">
          {resumeNotice && resumeNotice.conversationId === conversationId ? (
            <ResumeBanner
              lastMessageAt={resumeNotice.lastMessageAt}
              onDismiss={() => setResumeNotice(null)}
            />
          ) : null}
          {interruptedTurn ? (
            <InterruptedTurnBanner
              turn={interruptedTurn}
              onRetry={(prompt) => {
                dismissInterrupted(interruptedTurn.messageId);
                void sendPrompt(prompt);
              }}
              onDismiss={(messageId) => dismissInterrupted(messageId)}
            />
          ) : null}
          {paneEvents.length > 0 ? (
            <div className="flex shrink-0 flex-col gap-1 border-b border-border/50 bg-background px-3 py-2">
              {paneEvents.map((evt) => (
                <PaneEventCard
                  key={evt.id}
                  event={evt}
                  onReply={handlePaneReply}
                />
              ))}
            </div>
          ) : null}
          <ChatTranscript
            messages={messages}
            streaming={streaming}
            pending={busy && streaming == null}
            conversationId={conversationId}
            onRetry={busy ? undefined : onRetryError}
          />
        </div>
        <ToolCallInspector />
        {patternHit && !ribbonHidden && rufloReady ? (
          <PatternRibbon
            pattern={patternHit.pattern}
            confidence={patternHit.confidence}
            onApply={() => {
              pushComposerValue(patternHit.pattern);
              setComposerText(patternHit.pattern);
              setRibbonHidden(true);
              composerRef.current?.focus();
            }}
            onDismiss={() => setRibbonHidden(true)}
          />
        ) : null}
        <div onDragOver={handleComposerDragOver} onDrop={handleComposerDrop}>
          <Composer
            ref={composerRef}
            busy={busy}
            onSend={sendPrompt}
            onMicPress={onOrbClick}
            onChange={setComposerText}
            externalValue={composerExternalValue}
          />
        </div>
      </div>
    </div>
  );
}
