// V3-W15-001 — SigmaVoice title-bar indicator.
//
// Source: V3 frames 0080 + 0090 (top-bar pill that shows the active voice
// source while capture is live). Subscribes to two channels:
//   • renderer-internal `voice:state` CustomEvent (fired by lib/voice.ts) —
//     covers in-process listeners without an IPC round-trip.
//   • main-side `voice:state` IPC event — keeps the pill in sync if voice was
//     started in another renderer window.
// Auto-hides 200ms after `active === false` for a soft fade-out.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Mic } from 'lucide-react';
import { toast } from 'sonner';
import { onEvent } from '@/renderer/lib/rpc';
import type { VoiceSource } from '@/renderer/lib/voice';
import { cn } from '@/lib/utils';

interface DispatchEchoDetail {
  intent: string;
  controller: string;
  args: Record<string, unknown>;
  raw: string;
}

const ROUTING_LABEL: Record<string, string> = {
  create_swarm: 'Spawning swarm…',
  'app.navigate': 'Switching pane…',
  'swarms.broadcast': 'Broadcasting…',
  'swarms.rollCall': 'Calling roll…',
  'assistant.freeform': 'Asking Sigma…',
};

interface VoiceStateDetail {
  active: boolean;
  source: VoiceSource | null;
  sessionId?: string | null;
}

const SOURCE_LABEL: Record<VoiceSource, string> = {
  mission: 'Mission',
  assistant: 'Assistant',
  palette: 'Palette',
};

export function VoicePill() {
  const [state, setState] = useState<{ active: boolean; source: VoiceSource | null }>({
    active: false,
    source: null,
  });
  // `mounted` keeps the pill in DOM during the 200ms fade-out so the CSS
  // opacity transition can run before the element disappears. The state is
  // owned by event handlers + a single setTimeout, never by render.
  const [mounted, setMounted] = useState(false);
  const fadeTimerRef = useRef<number | null>(null);

  const handleTransition = useCallback((detail: VoiceStateDetail) => {
    setState({ active: detail.active, source: detail.source });
    if (detail.active) {
      if (fadeTimerRef.current !== null) {
        window.clearTimeout(fadeTimerRef.current);
        fadeTimerRef.current = null;
      }
      setMounted(true);
      return;
    }
    // Inactive → schedule unmount after the CSS fade. Replacing any in-flight
    // timer is safe; we want the latest stop to define the unmount time.
    if (fadeTimerRef.current !== null) {
      window.clearTimeout(fadeTimerRef.current);
    }
    fadeTimerRef.current = window.setTimeout(() => {
      fadeTimerRef.current = null;
      setMounted(false);
    }, 200);
  }, []);

  // Renderer-internal CustomEvent — fired by lib/voice.ts on every transition.
  useEffect(() => {
    const onLocal = (e: Event) => {
      const detail = (e as CustomEvent<VoiceStateDetail>).detail;
      if (!detail) return;
      handleTransition(detail);
    };
    window.addEventListener('voice:state', onLocal as EventListener);
    return () => window.removeEventListener('voice:state', onLocal as EventListener);
  }, [handleTransition]);

  // Main-side IPC echo so cross-window state converges (right-rail bridge,
  // standalone window all see the same pill).
  useEffect(() => {
    const off = onEvent<VoiceStateDetail>('voice:state', (raw) => {
      if (!raw || typeof raw !== 'object') return;
      handleTransition(raw);
    });
    return off;
  }, [handleTransition]);

  // Tear the timer down on unmount so we don't leak.
  useEffect(() => {
    return () => {
      if (fadeTimerRef.current !== null) {
        window.clearTimeout(fadeTimerRef.current);
        fadeTimerRef.current = null;
      }
    };
  }, []);

  // V1.1 — SigmaVoice dispatch echo. Fires once between the recogniser's
  // final transcript and the controller invocation. Surfacing a small toast
  // gives the operator immediate feedback when speech is being routed
  // (matches the `dispatching` phase in the adapter state machine).
  useEffect(() => {
    const off = onEvent<DispatchEchoDetail>('voice:dispatch-echo', (raw) => {
      if (!raw || typeof raw !== 'object') return;
      const label = ROUTING_LABEL[raw.intent] ?? 'Routing…';
      const description = typeof raw.raw === 'string' && raw.raw.length > 0
        ? `“${raw.raw.slice(0, 80)}${raw.raw.length > 80 ? '…' : ''}”`
        : undefined;
      toast(label, { description, duration: 1800 });
    });
    return off;
  }, []);

  if (!mounted) return null;
  const label = state.source ? SOURCE_LABEL[state.source] : '';

  return (
    <div
      data-testid="voice-pill"
      data-active={state.active}
      className={cn(
        'pointer-events-none flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium',
        'border-cyan-400/40 bg-cyan-400/10 text-cyan-200 shadow-sm transition-opacity duration-200',
        state.active ? 'opacity-100' : 'opacity-0',
      )}
      aria-live="polite"
      role="status"
    >
      <Mic className="h-3 w-3" aria-hidden />
      <span>SigmaVoice</span>
      {label ? <span className="opacity-70">· {label}</span> : null}
    </div>
  );
}
