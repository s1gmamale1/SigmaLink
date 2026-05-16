// V3-W13-012 / V3-W13-015 — Sigma Assistant root.
// Hosts orb + transcript + composer + tool-call inspector. Owns the active
// conversation, the in-flight streaming buffer, the orb state machine, and
// the cross-workspace dispatch echo handler (jump-to-pane + ding).
// P3-S7 — Adds a left-side Conversations panel that lists past chats from
// `assistant.conversations.list` and persists the active conversation id
// in `kv['sigma.activeConversationId']` so a fresh app launch restores
// the same thread the user was in.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bot } from 'lucide-react';
import { toast } from 'sonner';
import { rpc } from '@/renderer/lib/rpc';
import { useAppState } from '@/renderer/app/state';
import { EmptyState } from '@/renderer/components/EmptyState';
import { cn } from '@/lib/utils';
import { Orb, type OrbState } from './Orb';
import { ChatTranscript } from './ChatTranscript';
import { Composer } from './Composer';
import { ToolCallInspector } from './ToolCallInspector';
import { ConversationsPanel } from './ConversationsPanel';
import { PaneEventCard, type PaneEvent } from './PaneEventCard';
import { useSigmaPaneEvents } from './use-sigma-pane-events';
import {
  useSigmaConversations,
  persistActiveConversation,
} from './use-sigma-conversations';
import { useSigmaResumeFlow } from './use-sigma-resume-flow';
import { SigmaRailDropdown } from './SigmaRailDropdown';
import { ResumeBanner } from './ResumeBanner';
import { InterruptedTurnBanner } from './InterruptedTurnBanner';
import { PatternRibbon } from './PatternRibbon';
import { useSigmaRufloHealth } from './use-sigma-ruflo-health';
import { useSigmaPatternProbe } from './use-sigma-pattern-probe';
import { useSigmaDispatchEcho } from './use-sigma-dispatch-echo';
import { useSigmaJumpToMessage } from './use-sigma-jump-to-message';
import { useSigmaVoice } from './use-sigma-voice';
import { useSigmaAssistantState } from './use-sigma-assistant-state';

interface Props {
  /** Compact mode trims the header chrome — used inside the right-rail tab. */
  variant?: 'standalone' | 'rail';
  className?: string;
}

export function SigmaRoom({ variant = 'standalone', className }: Props) {
  const { state, dispatch } = useAppState();
  const activeWorkspace = state.activeWorkspace;
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
  } = useSigmaConversations();

  const { interruptedTurn, dismissInterrupted, resetDismissed } = useSigmaResumeFlow(messages);

  const [streaming, setStreaming] = useState<{ turnId: string; delta: string } | null>(null);
  const [orbState, setOrbState] = useState<OrbState>('standby');
  const [busy, setBusy] = useState(false);
  const [composerText, setComposerText] = useState('');
  const [ribbonHidden, setRibbonHidden] = useState(false);
  const [composerExternalValue, setComposerExternalValue] = useState<string | undefined>(undefined);
  const lastSentPromptRef = useRef<string | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const sendPromptRef = useRef<(prompt: string) => Promise<void>>(async () => {});

  const { rufloReady, rufloReadyRef } = useSigmaRufloHealth();
  const { patternHit } = useSigmaPatternProbe({ composerText, rufloReady });
  useSigmaDispatchEcho({
    workspaces: state.workspaces,
    activeWorkspaceId: state.activeWorkspace?.id,
    dispatch,
  });
  useSigmaJumpToMessage({ conversationId, hydrateConversation, transcriptRef });
  useSigmaAssistantState({
    conversationId,
    setMessages,
    setOrbState,
    setBusy,
    setStreaming,
    lastSentPromptRef,
    rufloReadyRef,
  });
  const { onOrbClick } = useSigmaVoice({ composerRef, sendPromptRef, setOrbState });

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
        toast.error('Open a workspace before talking to Sigma.');
        return;
      }
      lastSentPromptRef.current = prompt;
      setComposerText('');
      setComposerExternalValue('');
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
      try {
        const res = await rpc.assistant.send({
          workspaceId: activeWorkspace.id,
          conversationId: conversationId ?? undefined,
          prompt,
        });
        setConversationId(res.conversationId);
        persistActiveConversation(res.conversationId);
        void refreshConversations(activeWorkspace.id);
      } catch (err) {
        setBusy(false);
        setOrbState('standby');
        toast.error('Sigma failed to accept your message', {
          description: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [activeWorkspace, conversationId, setConversationId, setMessages, refreshConversations],
  );

  useEffect(() => {
    sendPromptRef.current = sendPrompt;
  }, [sendPrompt]);

  const onNewConversation = useCallback(() => {
    clearConversation();
    resetDismissed();
    setStreaming(null);
    setOrbState('standby');
    setBusy(false);
    composerRef.current?.focus();
  }, [clearConversation, resetDismissed]);

  const paneEvents = useSigmaPaneEvents(conversationId);

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
          title="Sigma Assistant"
          description="Open a workspace to talk to Sigma."
        />
      </div>
    );
  }

  const showPanel = variant === 'standalone';

  return (
    <div
      className={cn('flex h-full min-h-0 flex-row bg-background', className)}
      data-sigma-room={variant}
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
      <div className="flex h-full min-h-0 flex-1 flex-col">
        {variant === 'standalone' ? (
          <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-muted/10 px-3 text-sm">
            <Bot className="h-4 w-4 text-primary" aria-hidden />
            <h2 className="text-sm font-semibold tracking-tight">Sigma Assistant</h2>
            <span className="ml-2 truncate text-xs text-muted-foreground">
              {activeWorkspace.name}
            </span>
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
          <ChatTranscript messages={messages} streamingDelta={streaming?.delta} />
        </div>
        <ToolCallInspector />
        {patternHit && !ribbonHidden && rufloReady ? (
          <PatternRibbon
            pattern={patternHit.pattern}
            confidence={patternHit.confidence}
            onApply={() => {
              setComposerExternalValue(patternHit.pattern);
              setComposerText(patternHit.pattern);
              setRibbonHidden(true);
              composerRef.current?.focus();
            }}
            onDismiss={() => setRibbonHidden(true)}
          />
        ) : null}
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
  );
}
