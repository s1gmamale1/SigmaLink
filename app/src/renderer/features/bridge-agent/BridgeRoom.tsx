// V3-W13-012 / V3-W13-015 — Bridge Assistant root.
// Hosts orb + transcript + composer + tool-call inspector. Owns the active
// conversation, the in-flight streaming buffer, the orb state machine, and
// the cross-workspace dispatch echo handler (jump-to-pane + ding).
// P3-S7 — Adds a left-side Conversations panel that lists past chats from
// `assistant.conversations.list` and persists the active conversation id
// in `kv['bridge.activeConversationId']` so a fresh app launch restores
// the same thread the user was in.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Bot, Sparkles, X } from 'lucide-react';
import { toast } from 'sonner';
import { rpc, rpcSilent, onEvent } from '@/renderer/lib/rpc';
import { useAppState } from '@/renderer/app/state';
import { EmptyState } from '@/renderer/components/EmptyState';
import { cn } from '@/lib/utils';
import { Orb, type OrbState } from './Orb';
import { ChatTranscript, type ChatMessageView, type ChatRole } from './ChatTranscript';
import { Composer } from './Composer';
import { ToolCallInspector } from './ToolCallInspector';
import { ConversationsPanel } from './ConversationsPanel';
import { playDing } from '@/renderer/lib/notifications';
import type { AppRouter } from '@/shared/router-shape';
// V3-W15-003 — orb click triggers voice capture; the recognizer's final
// transcript fans out to `assistant.send`. The orb stays in 'listening' while
// capture is live and flips to 'thinking' once the prompt is sent.
import {
  isVoiceSupported,
  startCapture,
  VoiceBusyError,
  type VoiceCaptureHandle,
} from '@/renderer/lib/voice';

const KV_ACTIVE_CONVERSATION = 'bridge.activeConversationId';
// BUG-V1.1-04-IPC — when a Bridge tool dispatches a pane, auto-shift focus
// to the spawned pane (workspace + room + active-session + xterm focus)
// instead of waiting for the user to click "Jump to pane" in the toast.
// Default ON; users can disable by writing kv['bridge.autoFocusOnDispatch']='0'.
const KV_AUTO_FOCUS_ON_DISPATCH = 'bridge.autoFocusOnDispatch';

/** Best-effort kv write — every persistence write in this room is
 *  decorative (the user's intent survives in DB rows; kv only restores
 *  the active conversation across launches). Wrapping the rejection here
 *  collapses the four try/catch blocks into a single call site. */
const persistActiveConversation = (id: string): void => {
  void rpc.kv.set(KV_ACTIVE_CONVERSATION, id).catch(() => undefined);
};

/** Side-band invoke for the `assistant.conversations.<method>` namespace.
 *  The typed `rpc` proxy only knows about flat namespaces; this helper
 *  mirrors the `invokeReplay` pattern used by the Operator Console replay
 *  scrubber so the renderer can still exercise side-band channels with
 *  the standard `{ok,data,error}` envelope. */
async function invokeSideBand<T = unknown>(
  channel: `assistant.conversations.${string}` | `swarm.origin.${string}`,
  ...args: unknown[]
): Promise<T> {
  if (!('sigma' in window)) {
    throw new Error('Preload bridge missing — restart the app.');
  }
  const env = (await window.sigma.invoke(channel, ...args)) as
    | { ok: true; data: T }
    | { ok: false; error: string };
  if (!env || typeof env !== 'object' || !('ok' in env)) {
    throw new Error(`Bad RPC response from ${channel}`);
  }
  if (env.ok) return env.data;
  throw new Error(env.error);
}

type ConvList = Awaited<ReturnType<AppRouter['assistant']['conversations']['list']>>;
type ConvGet = Awaited<ReturnType<AppRouter['assistant']['conversations']['get']>>;
type ConversationListRow = ConvList[number];

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

interface RufloHealthEvent {
  state: 'absent' | 'starting' | 'ready' | 'degraded' | 'down';
}

interface PatternHit {
  pattern: string;
  type?: string;
  confidence: number;
  score: number;
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
  const [conversations, setConversations] = useState<ConversationListRow[]>([]);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  // V3-W15-003 — live voice capture handle. Stored in a ref so onOrbClick can
  // toggle without re-binding when state churns elsewhere in the room.
  const voiceHandleRef = useRef<VoiceCaptureHandle | null>(null);
  // Phase 4 Track C — pattern surfacing state. `composerText` mirrors the
  // textarea value so we can debounce a search; `patternHit` is the highest-
  // confidence match (≥0.7) returned by the embedded Ruflo MCP. `ribbonHidden`
  // is a session-scoped dismissal flag — it resets on conversation switch
  // or workspace change.
  const [composerText, setComposerText] = useState('');
  const [patternHit, setPatternHit] = useState<PatternHit | null>(null);
  const [ribbonHidden, setRibbonHidden] = useState(false);
  const [rufloReady, setRufloReady] = useState(false);
  const [composerExternalValue, setComposerExternalValue] = useState<string | undefined>(undefined);
  const lastSentPromptRef = useRef<string | null>(null);
  // Phase 4 Track C — readiness pinned in a ref so the assistant:state
  // listener (which only re-binds on conversationId changes) reads the
  // freshest value without forcing the effect to re-run.
  const rufloReadyRef = useRef(false);

  // Phase 4 Track C — track Ruflo health.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const h = await rpcSilent.ruflo.health();
        if (alive) {
          setRufloReady(h.state === 'ready');
          rufloReadyRef.current = h.state === 'ready';
        }
      } catch {
        /* main-process method missing — keep default false */
      }
    })();
    const off = onEvent<RufloHealthEvent>('ruflo:health', (e) => {
      const ready = e?.state === 'ready';
      setRufloReady(ready);
      rufloReadyRef.current = ready;
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  // Phase 4 Track C — debounced pattern probe (800ms). Fires only when the
  // supervisor is `ready` and the composer holds enough text to be worth a
  // round-trip. The `Promise.allSettled`-style ignore-on-fail keeps the
  // ribbon silent on degraded supervisors.
  useEffect(() => {
    let alive = true;
    const text = composerText.trim();
    const skip = !rufloReady || text.length < 8;
    if (skip) {
      // Defer the reset to a microtask so the lint rule
      // `react-hooks/set-state-in-effect` is satisfied.
      const id = window.setTimeout(() => {
        if (alive) setPatternHit(null);
      }, 0);
      return () => {
        alive = false;
        window.clearTimeout(id);
      };
    }
    const t = setTimeout(() => {
      void (async () => {
        try {
          const out = await rpcSilent.ruflo['patterns.search']({
            query: text,
            topK: 3,
            minConfidence: 0.7,
          });
          if (!alive) return;
          if (out && 'ok' in out && out.ok && out.results.length > 0) {
            // The MCP returns hits sorted by score; pick the highest-conf
            // entry that also clears the 0.7 confidence floor.
            const best = out.results.find((r) => r.confidence >= 0.7) ?? null;
            setPatternHit(best);
          } else {
            setPatternHit(null);
          }
        } catch {
          if (alive) setPatternHit(null);
        }
      })();
    }, 800);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [composerText, rufloReady]);

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

  /** P3-S7 — Refresh the Conversations panel from the side-band channel.
   *  Pulled into a callback so the panel can re-fetch after a delete or
   *  after a fresh `assistant.send` upgrades a transient client-side row
   *  into a persisted one. */
  const refreshConversations = useCallback(
    async (forWorkspaceId: string): Promise<ConversationListRow[]> => {
      try {
        const rows = await invokeSideBand<ConvList>('assistant.conversations.list', {
          workspaceId: forWorkspaceId,
        });
        setConversations(rows);
        return rows;
      } catch {
        setConversations([]);
        return [];
      }
    },
    [],
  );

  /** Hydrate a specific conversation into the transcript. Falls back to a
   *  blank slate when the row no longer exists (e.g. it was just deleted). */
  const hydrateConversation = useCallback(async (id: string): Promise<void> => {
    try {
      const res = await invokeSideBand<ConvGet>('assistant.conversations.get', {
        conversationId: id,
      });
      if (!res.conversation) {
        setConversationId(null);
        setMessages([]);
        return;
      }
      setConversationId(res.conversation.id);
      setMessages(
        res.messages.map((m) => ({
          id: m.id,
          role: m.role as ChatRole,
          content: m.content,
          toolCallId: m.toolCallId,
          createdAt: m.createdAt,
        })),
      );
    } catch {
      /* keep current view on hydration failure */
    }
  }, []);

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
        setConversations([]);
        return;
      }
      const rows = await refreshConversations(wsId);
      if (!alive) return;
      // Restore the persisted active conversation when one exists in this
      // workspace; otherwise drop down to the most recent or empty.
      let restored: string | null = null;
      try {
        restored = await rpc.kv.get(KV_ACTIVE_CONVERSATION);
      } catch {
        restored = null;
      }
      if (!alive) return;
      const target =
        rows.find((r) => r.id === restored)?.id ?? rows[0]?.id ?? null;
      if (target) {
        await hydrateConversation(target);
      } else {
        setConversationId(null);
        setMessages([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, [wsId, refreshConversations, hydrateConversation]);

  useEffect(() => {
    const off = onEvent<AssistantStateEvent>('assistant:state', (raw) => {
      if (!raw || typeof raw !== 'object') return;
      const e = raw as AssistantStateEvent;
      if (conversationId && e.conversationId !== conversationId) return;
      if (e.kind === 'state') {
        if (e.state) setOrbState(e.state);
        if (e.state === 'standby') {
          setBusy(false);
          // Phase 4 Track C — fire-and-forget pattern store. The user's most
          // recent prompt becomes a `task-completion` pattern at confidence
          // 0.8 so the next similar query can offer it back via the ribbon.
          // CRITICAL: payload shape is `{ pattern, type, confidence }` —
          // NOT `{ namespace, key, value }` per the ruflo-researcher fix.
          if (lastSentPromptRef.current && rufloReadyRef.current) {
            const pat = lastSentPromptRef.current;
            lastSentPromptRef.current = null;
            void rpcSilent.ruflo['patterns.store']({
              pattern: pat,
              type: 'task-completion',
              confidence: 0.8,
            }).catch(() => {
              /* background telemetry — losing it is acceptable */
            });
          }
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
        toast.error('Sigma dispatch failed', {
          description: echo.error ?? 'Unknown error',
        });
        return;
      }
      const targetWs = state.workspaces.find((w) => w.id === echo.workspaceId) ?? null;
      const wsLabel = targetWs?.name ?? 'workspace';

      // Cross-workspace jump: swap workspace (if needed), hop to the
      // Command Room, set the global active session, and emit
      // `sigma:pty-focus` so the matching xterm grabs keyboard focus and
      // CommandRoom syncs its activeIndex / footer metadata. Shared by
      // the auto-focus path (default) and the toast "Jump to pane"
      // fallback so both produce identical behaviour.
      const jumpToPane = (): void => {
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
          /* ignore — DOM unmounted */
        }
      };

      // BUG-V1.1-04-IPC — read the auto-focus gate (default ON). When
      // enabled, jump immediately so CommandRoom's activeIndex syncs
      // alongside the xterm focus shift; the toast becomes a confirmation
      // rather than the only path to the new pane. Users can opt out by
      // writing kv['bridge.autoFocusOnDispatch']='0'.
      void (async () => {
        let autoFocus = true;
        try {
          const raw = await rpcSilent.kv.get(KV_AUTO_FOCUS_ON_DISPATCH);
          autoFocus = raw === null || raw === undefined ? true : raw !== '0';
        } catch {
          /* default ON when kv unreachable */
        }
        if (autoFocus) jumpToPane();
        toast.success(`Sigma dispatched a ${echo.providerId} pane`, {
          description: `${wsLabel} · session ${echo.sessionId.slice(0, 8)}`,
          action: {
            label: 'Jump to pane',
            onClick: jumpToPane,
          },
        });
        void playDing();
      })();
    });
    return off;
  }, [state.workspaces, state.activeWorkspace?.id, dispatch]);

  const sendPrompt = useCallback(
    async (prompt: string) => {
      if (!activeWorkspace) {
        toast.error('Open a workspace before talking to Sigma.');
        return;
      }
      // Phase 4 Track C — capture the prompt so the post-turn `state==='standby'`
      // event can fire `ruflo.patterns.store({ pattern, type, confidence })`.
      lastSentPromptRef.current = prompt;
      setComposerText('');
      setComposerExternalValue('');
      setPatternHit(null);
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
        // P3-S7 — Persist the active id so a fresh app launch lands back in
        // this thread. Refresh the side panel so the row's title / count /
        // lastMessageAt reflect the just-sent prompt.
        persistActiveConversation(res.conversationId);
        void refreshConversations(activeWorkspace.id);
      } catch (err) {
        setBusy(false);
        setOrbState('standby');
        toast.error('Bridge failed to accept your message', {
          description: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [activeWorkspace, conversationId, refreshConversations],
  );

  /** P3-S7 — Conversation panel handlers. */
  const onPickConversation = useCallback(
    (id: string) => {
      void hydrateConversation(id);
      persistActiveConversation(id);
    },
    [hydrateConversation],
  );

  const onNewConversation = useCallback(() => {
    setConversationId(null);
    setMessages([]);
    setStreaming(null);
    setOrbState('standby');
    setBusy(false);
    persistActiveConversation('');
    composerRef.current?.focus();
  }, []);

  const onDeleteConversation = useCallback(
    async (id: string) => {
      try {
        await invokeSideBand<{ ok: true }>('assistant.conversations.delete', {
          conversationId: id,
        });
      } catch {
        /* swallowed; the panel still refreshes below */
      }
      if (!wsId) return;
      const rows = await refreshConversations(wsId);
      // If the deleted row was active, fall back to the next one.
      if (id === conversationId) {
        const next = rows[0]?.id ?? null;
        if (next) {
          await hydrateConversation(next);
          persistActiveConversation(next);
        } else {
          setConversationId(null);
          setMessages([]);
          persistActiveConversation('');
        }
      }
    },
    [conversationId, wsId, refreshConversations, hydrateConversation],
  );

  /** P3-S7 — External jump-to-message hook. The Operator Console fires a
   *  `sigma:bridge-jump-to-message` window event after switching the room
   *  back to `bridge`; we hydrate the requested conversation (if it isn't
   *  already active) and scroll the matching `[data-message-id]` element
   *  into view. */
  useEffect(() => {
    const handler = (raw: Event) => {
      const ev = raw as CustomEvent<{ conversationId: string; messageId?: string }>;
      const detail = ev.detail;
      if (!detail || typeof detail.conversationId !== 'string') return;
      void (async () => {
        if (detail.conversationId !== conversationId) {
          await hydrateConversation(detail.conversationId);
          try {
            await rpc.kv.set(KV_ACTIVE_CONVERSATION, detail.conversationId);
          } catch {
            /* best-effort */
          }
        }
        if (detail.messageId) {
          // Defer one frame so React commits the new transcript before scroll.
          requestAnimationFrame(() => {
            const root = transcriptRef.current ?? document;
            const el = root.querySelector<HTMLElement>(
              `[data-message-id="${detail.messageId}"]`,
            );
            if (el) {
              el.scrollIntoView({ behavior: 'smooth', block: 'center' });
              el.classList.add('ring-2', 'ring-primary/60');
              window.setTimeout(
                () => el.classList.remove('ring-2', 'ring-primary/60'),
                1500,
              );
            }
          });
        }
      })();
    };
    window.addEventListener('sigma:bridge-jump-to-message', handler);
    return () => window.removeEventListener('sigma:bridge-jump-to-message', handler);
  }, [conversationId, hydrateConversation]);

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
          title="Sigma Assistant"
          description="Open a workspace to talk to Sigma."
        />
      </div>
    );
  }

  // P3-S7 — The Conversations panel is only rendered in standalone mode.
  // The right-rail (`variant === 'rail'`) is already narrow and doesn't
  // have the horizontal budget to host another sidebar; the panel still
  // exists implicitly via the standalone Bridge room.
  const showPanel = variant === 'standalone';

  return (
    <div
      className={cn('flex h-full min-h-0 flex-row bg-background', className)}
      data-bridge-room={variant}
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
        ) : null}
        <div className="flex shrink-0 items-center justify-center border-b border-border/50 bg-background px-4 py-3">
          <Orb state={orbState} onClick={onOrbClick} />
        </div>
        <div ref={transcriptRef} className="flex min-h-0 flex-1 flex-col">
          <ChatTranscript messages={messages} streamingDelta={streaming?.delta} />
        </div>
        <ToolCallInspector />
        {/* Phase 4 Track C — "Similar past task" ribbon. Renders only when
            the embedded Ruflo MCP returns a hit at ≥0.7 confidence and the
            user hasn't dismissed the ribbon for the current session. The
            ribbon never blocks send; clicking "Apply" copies the matched
            pattern into the composer for one-tap edit-then-send. */}
        {patternHit && !ribbonHidden && rufloReady ? (
          <div className="flex items-start gap-2 border-t border-primary/20 bg-primary/5 px-3 py-2 text-xs">
            <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
            <div className="min-w-0 flex-1">
              <div className="text-[10px] uppercase tracking-wider text-primary">
                Similar past task ({Math.round(patternHit.confidence * 100)}% confidence)
              </div>
              <div className="mt-0.5 line-clamp-2 text-muted-foreground">{patternHit.pattern}</div>
            </div>
            <button
              type="button"
              className="rounded border border-primary/40 bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary transition hover:bg-primary/20"
              onClick={() => {
                setComposerExternalValue(patternHit.pattern);
                setComposerText(patternHit.pattern);
                setRibbonHidden(true);
                composerRef.current?.focus();
              }}
            >
              Apply
            </button>
            <button
              type="button"
              className="rounded p-0.5 text-muted-foreground transition hover:bg-muted/40 hover:text-foreground"
              aria-label="Dismiss similar task"
              onClick={() => setRibbonHidden(true)}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
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
