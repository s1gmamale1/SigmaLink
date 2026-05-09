// V3-W15-001 — BridgeVoice main-process adapter (state machine stub).
//
// Source: docs/02-research/v3-protocol-delta.md §6 — BridgeVoice spec; backlog
// V3-W15-001..003. The renderer drives Web Speech API capture in-process
// (Electron's renderer fully supports `webkitSpeechRecognition` on macOS +
// Windows). This main-side adapter is intentionally thin: it tracks a
// single in-flight session id, rejects concurrent starts with `voice-busy`,
// and broadcasts `voice:state` so any subscribed renderer (title-bar pill,
// orb, palette) reflects the same active source.
//
// Native speech bindings (macOS Speech framework, Windows SAPI) are out of
// scope for v1 — they'd need Swift / COM bridges. This stub is forward-
// compatible: a v1.1 adapter can plug a native engine behind the same RPC
// surface without renderer changes.

import { randomUUID } from 'node:crypto';
import { defineController } from '../../../shared/rpc';

export type VoiceSource = 'mission' | 'assistant' | 'palette';

export interface VoiceControllerDeps {
  emit: (event: string, payload: unknown) => void;
}

interface ActiveSession {
  id: string;
  source: VoiceSource;
  startedAt: number;
}

const VALID_SOURCES: ReadonlySet<VoiceSource> = new Set([
  'mission',
  'assistant',
  'palette',
]);

export function buildVoiceController(deps: VoiceControllerDeps) {
  let active: ActiveSession | null = null;

  function broadcast(): void {
    deps.emit('voice:state', {
      active: active !== null,
      source: active?.source ?? null,
      sessionId: active?.id ?? null,
    });
  }

  return defineController({
    /**
     * Begin a voice session. Rejects with `voice-busy` while another session
     * is active — the renderer adapter enforces single-capture too, but main
     * is the source of truth across windows.
     */
    start: async (input: { source: VoiceSource }): Promise<{ sessionId: string }> => {
      const source = input?.source;
      if (!VALID_SOURCES.has(source)) {
        throw new Error(`voice.start: invalid source "${String(source)}"`);
      }
      if (active) {
        throw new Error('voice-busy');
      }
      active = { id: randomUUID(), source, startedAt: Date.now() };
      broadcast();
      return { sessionId: active.id };
    },
    /**
     * Stop the active session. Idempotent — a stop with no active session is
     * a no-op (the renderer may double-fire on cleanup paths). When the
     * provided `sessionId` doesn't match the live one we leave it alone so a
     * stale teardown can't kill a fresh session. Empty string is permitted as
     * a "stop whatever's active" hatch for the renderer's error paths where
     * the original id was never captured.
     */
    stop: async (input: { sessionId: string }): Promise<void> => {
      if (!active) {
        broadcast();
        return;
      }
      const sessionId = input?.sessionId ?? '';
      if (sessionId && active.id !== sessionId) {
        return;
      }
      active = null;
      broadcast();
    },
  });
}
