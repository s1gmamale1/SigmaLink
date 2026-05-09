// V3-W13-012 / V3-W13-015 — Bridge Assistant root.
// Hosts orb + transcript + composer + tool-call inspector. Owns the active
// conversation, the in-flight streaming buffer, the orb state machine, and
// the cross-workspace dispatch echo handler (jump-to-pane + ding).

import { useCallback, useEffect, useRef, useState } from 'react';
import { Bot } from 'lucide-react';
import { toast } from 'sonner';
import { rpc, onEvent } from '@/renderer/lib/rpc';
import { useAppState } from '@/renderer/app/state';
import { EmptyState } from '@/renderer/components/EmptyState';
import { cn } from '@/lib/utils';
import { Orb, type OrbState } from './Orb';
import { ChatTranscript, type ChatMessageView, type ChatRole } from './ChatTranscript';
import { Composer } from './Composer';
import { ToolCallInspector } from './ToolCallInspector';
import { playDing } from '@/renderer/lib/notifications';
// V3-W15-003 — orb click triggers voice capture; the recognizer's final
// transcript fans out to `assistant.send`. The orb stays in 'listening' while
// capture is live and flips to 'thinking' once the prompt is sent.
import {
  isVoiceSupported,
  startCapture,
  VoiceBusyError,
  type VoiceCaptureHandle,
} from '@/renderer/lib/voice';

interface AssistantStateEvent {
  kind: 'state' | 'delta';
  state?: OrbState;
  conversationId: string;
  turnId: string;
  delta?: string;
  messageId?: string;
}

interface DispatchEchoEvent {
  workspaceId: string;
  sessionId: string;
  providerId: string;
  ok: boolean;
  error: string | null;
  conversationId: string | null;
}

interface Props {
  /** Compact mode trims the header chrome — used inside the right-rail tab. */
  variant?: 'standalone' | 'rail';
  className?: string;
}

export function BridgeRoom({ variant = 'standalone', className }: Props) {
  const { state, dispatch } = useAppState();
  const activeWorkspace = state.activeWorkspace;
  const wsId = activeWorkspace?.id;
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessageView[]>([]);
  const [streaming, setStreaming] = useState<{ turnId: string; delta: string } | null>(null);
  const [orbState, setOrbState] = useState<OrbState>('standby');
  const [busy, setBusy] = useState(false);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  // V3-W15-003 — live voice capture handle. Stored in a ref so onOrbClick can
  // toggle without re-binding when state churns elsewhere in the room.
  const voiceHandleRef = useRef<VoiceCaptureHandle | null>(null);

  // Hydrate the conversation list when the workspace changes. Reset path
  // is microtasked so we never call setState synchronously inside the
  // effect body (lint: react-hooks/set-state-in-effect).
  useEffect(() => {
    let alive = true;
    void (async () => {
      if (!wsId) {
        if (!alive) return;
        setConversationId(null);
        setMessages([]);
        return;
      }
      try {
        const list = await rpc.assistant.list({ workspaceId: wsId });
        if (!alive) return;
        const latest = list[0];
        if (latest) {
          setConversationId(latest.id);
          setMessages(
            latest.messages.map((m) => ({
              id: m.id,
              role: m.role as ChatRole,
              content: m.content,
              toolCallId: m.toolCallId,
              createdAt: m.createdAt,
            })),
          );
        } else {
          setConversationId(null);
          setMessages([]);
        }
      } catch {
        /* surface stays empty on hydration failure */
      }
    })();
    return () => {
      alive = false;
    };
  }, [wsId]);

  useEffect(() => {
    const off = onEvent<AssistantStateEvent>('assistant:state', (raw) => {
      if (!raw || typeof raw !== 'object') return;
      const e = raw as AssistantStateEvent;
      if (conversationId && e.conversationId !== conversationId) return;
      if (e.kind === 'state') {
        if (e.state) setOrbState(e.state);
        if (e.state === 'standby') {
          setBusy(false);
          setStreaming((prev) => {
            if (!prev || !e.messageId) return null;
            const messageId = e.messageId;
            setMessages((rows) =>
              rows.some((r) => r.id === messageId)
                ? rows
                : [
                    ...rows,
                    {
                      id: messageId,
                      role: 'assistant',
                      content: prev.delta,
                      createdAt: Date.now(),
                    },
                  ],
            );
            return null;
          });
        }
      } else if (e.kind === 'delta' && e.delta) {
        setStreaming((prev) =>
          !prev || prev.turnId !== e.turnId
            ? { turnId: e.turnId, delta: e.delta ?? '' }
            : { turnId: prev.turnId, delta: prev.delta + e.delta },
        );
      }
    });
    return off;
  }, [conversationId]);

  useEffect(() => {
    const off = onEvent<DispatchEchoEvent>('assistant:dispatch-echo', (raw) => {
      if (!raw || typeof raw !== 'object') return;
      const echo = raw as DispatchEchoEvent;
      if (!echo.ok) {
        toast.error('Bridge dispatch failed', {
          description: echo.error ?? 'Unknown error',
        });
        return;
      }
      const targetWs = state.workspaces.find((w) => w.id === echo.workspaceId) ?? null;
      const wsLabel = targetWs?.name ?? 'workspace';
      toast.success(`Bridge dispatched a ${echo.providerId} pane`, {
        description: `${wsLabel} · session ${echo.sessionId.slice(0, 8)}`,
        action: {
          label: 'Jump to pane',
          onClick: () => {
            // Cross-workspace jump: swap workspace, hop to Command Room,
            // notify Terminal.tsx via a window event for focus.
            if (targetWs && state.activeWorkspace?.id !== targetWs.id) {
              dispatch({ type: 'SET_ACTIVE_WORKSPACE', workspace: targetWs });
            }
            dispatch({ type: 'SET_ROOM', room: 'command' });
            dispatch({ type: 'SET_ACTIVE_SESSION', id: echo.sessionId });
            try {
              window.dispatchEvent(
                new CustomEvent('sigma:pty-focus', {
                  detail: { sessionId: echo.sessionId },
                }),
              );
            } catch {
              /* ignore */
            }
          },
        },
      });
      void playDing();
    });
    return off;
  }, [state.workspaces, state.activeWorkspace?.id, dispatch]);

  const sendPrompt = useCallback(
    async (prompt: string) => {
      if (!activeWorkspace) {
        toast.error('Open a workspace before talking to the Bridge.');
        return;
      }
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
      } catch (err) {
        setBusy(false);
        setOrbState('standby');
        toast.error('Bridge failed to accept your message', {
          description: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [activeWorkspace, conversationId],
  );

  const sendPromptRef = useRef(sendPrompt);
  useEffect(() => {
    sendPromptRef.current = sendPrompt;
  }, [sendPrompt]);

  // V3-W15-003 — orb click toggles BridgeVoice capture. STANDBY → kick off
  // a session and switch to LISTENING; click again to abort. The recognizer's
  // final transcript is dispatched to `assistant.send` and the orb advances
  // to THINKING (the streaming events emitted by the assistant controller
  // already drive RECEIVING / back-to-STANDBY transitions).
  const onOrbClick = useCallback(() => {
    composerRef.current?.focus();
    if (voiceHandleRef.current) {
      voiceHandleRef.current.stop();
      voiceHandleRef.current = null;
      setOrbState('standby');
      return;
    }
    if (!isVoiceSupported()) {
      // Fallback to the W13 visual toggle so the orb still pulses for users
      // on unsupported platforms — they can use the Composer + mic instead.
      setOrbState((s) => (s === 'listening' ? 'standby' : 'listening'));
      toast.error('Voice not supported on this platform');
      return;
    }
    setOrbState('listening');
    void (async () => {
      try {
        const handle = await startCapture({
          source: 'assistant',
          onFinal: (text) => {
            voiceHandleRef.current = null;
            const trimmed = text.trim();
            if (!trimmed) {
              setOrbState('standby');
              return;
            }
            void sendPromptRef.current(trimmed);
          },
          onError: () => {
            voiceHandleRef.current = null;
            setOrbState('standby');
          },
        });
        voiceHandleRef.current = handle;
      } catch (err) {
        voiceHandleRef.current = null;
        setOrbState('standby');
        if (err instanceof VoiceBusyError) {
          toast.error('Another voice session is active');
        }
      }
    })();
  }, []);

  // Stop any in-flight capture when the room unmounts.
  useEffect(() => {
    return () => {
      voiceHandleRef.current?.stop();
      voiceHandleRef.current = null;
    };
  }, []);

  if (!activeWorkspace) {
    return (
      <div className={cn('flex h-full min-h-0 flex-col bg-background', className)}>
        <EmptyState
          icon={Bot}
          title="Bridge Assistant"
          description="Open a workspace to talk to the Bridge."
        />
      </div>
    );
  }

  return (
    <div
      className={cn('flex h-full min-h-0 flex-col bg-background', className)}
      data-bridge-room={variant}
    >
      {variant === 'standalone' ? (
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-muted/10 px-3 text-sm">
          <Bot className="h-4 w-4 text-primary" aria-hidden />
          <h2 className="text-sm font-semibold tracking-tight">Bridge Assistant</h2>
          <span className="ml-2 truncate text-xs text-muted-foreground">
            {activeWorkspace.name}
          </span>
        </header>
      ) : null}
      <div className="flex shrink-0 items-center justify-center border-b border-border/50 bg-background px-4 py-3">
        <Orb state={orbState} onClick={onOrbClick} />
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        <ChatTranscript messages={messages} streamingDelta={streaming?.delta} />
      </div>
      <ToolCallInspector />
      <Composer ref={composerRef} busy={busy} onSend={sendPrompt} onMicPress={onOrbClick} />
    </div>
  );
}
