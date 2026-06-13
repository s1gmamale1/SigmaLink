// cloud-stt-engine.ts — Cloud STT backends for OpenAI Whisper API + Deepgram (BSP-V1).
//
// Both factories implement the `WhisperEngine` interface so they can be passed to
// `resolveTranscriptionEngine` alongside the existing local/gemini engines.
//
// Design goals:
//   - Inject `fetch` + `getApiKey` for testability (no real network in unit tests).
//   - Throw a typed `SttKeyMissingError` when the API key is absent so the caller
//     can surface an appropriate toast without inspecting the message string.
//   - Encode PCM → WAV internally (reuse `wav-encode.ts`).
//   - Zero Electron / native dependencies.

import { encodeWav } from './wav-encode.js';
import type { WhisperEngine } from './whisper-engine.js';
import type { TranscribeResult } from '@sigmalink/voice-whisper';

// ---------------------------------------------------------------------------
// Typed error
// ---------------------------------------------------------------------------

/**
 * Thrown by a cloud STT engine when its API key is missing from the KV store.
 * Callers check `err instanceof SttKeyMissingError` to surface a suitable toast.
 */
export class SttKeyMissingError extends Error {
  readonly provider: 'openai-whisper-api' | 'deepgram';
  constructor(provider: 'openai-whisper-api' | 'deepgram') {
    super(`API key missing for STT provider "${provider}". Set it in Settings → Voice.`);
    this.name = 'SttKeyMissingError';
    this.provider = provider;
  }
}

// ---------------------------------------------------------------------------
// Shared deps interface
// ---------------------------------------------------------------------------

export interface CloudSttEngineDeps {
  /**
   * Injectable `fetch` — use the global in production; inject a mock in tests.
   * @default globalThis.fetch
   */
  fetchFn?: typeof fetch;
  /**
   * Return the API key for the given provider from the KV store, or null when
   * not set. Injected so the factory stays free of direct KV imports.
   *
   * @param provider  The provider identifier string.
   */
  getApiKey: (provider: 'openai-whisper-api' | 'deepgram') => string | null;
  /**
   * ADR-007 — optional base URL for a self-hosted/LAN OpenAI-compatible server.
   * Absent/empty → default OpenAI cloud. Only consulted by the OpenAI engine.
   */
  getBaseUrl?: () => string | null;
  /**
   * ADR-007 — optional model id (self-hosted servers use their own ids).
   * Default 'whisper-1'.
   */
  getModel?: () => string | null;
}

// ---------------------------------------------------------------------------
// OpenAI Whisper API engine
// ---------------------------------------------------------------------------

/**
 * Build a `WhisperEngine` that POSTs audio to OpenAI `/v1/audio/transcriptions`.
 *
 * API reference: https://platform.openai.com/docs/api-reference/audio/createTranscription
 *
 * The `modelPath` argument from the WhisperEngine interface is ignored — the
 * OpenAI API selects its own model (we default to "whisper-1").
 *
 * @throws {SttKeyMissingError} when `voice.stt.openai-whisper-api.apiKey` is absent.
 */
export function buildOpenAiSttEngine(deps: CloudSttEngineDeps): WhisperEngine {
  const fetchFn = deps.fetchFn ?? globalThis.fetch.bind(globalThis);

  return {
    async transcribe(audio: Float32Array): Promise<TranscribeResult> {
      const apiKey = deps.getApiKey('openai-whisper-api');
      const rawBase = deps.getBaseUrl?.()?.trim() || '';
      // No key AND no custom endpoint → default OpenAI cloud path, which requires a key.
      if (!apiKey && !rawBase) throw new SttKeyMissingError('openai-whisper-api');

      const base = (rawBase || 'https://api.openai.com/v1').replace(/\/+$/, '');
      const url = `${base}/audio/transcriptions`;
      const model = deps.getModel?.()?.trim() || 'whisper-1';

      // Encode PCM → WAV (16 kHz mono, as Whisper expects)
      const wavBuffer = encodeWav(audio, 16000);

      // Build multipart/form-data body
      const formData = new FormData();
      formData.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), 'audio.wav');
      formData.append('model', model);
      formData.append('response_format', 'json');
      formData.append('language', 'en');

      const headers: Record<string, string> = {};
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

      const response = await fetchFn(url, {
        method: 'POST',
        headers,
        body: formData,
        signal: AbortSignal.timeout(30_000),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`OpenAI-compatible STT error ${response.status}: ${body}`);
      }

      const json = await response.json() as { text?: string };
      return {
        text: (json.text ?? '').trim(),
        segments: [],
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Deepgram engine
// ---------------------------------------------------------------------------

/**
 * Build a `WhisperEngine` that POSTs audio to Deepgram `/v1/listen`.
 *
 * API reference: https://developers.deepgram.com/reference/pre-recorded
 *
 * The `modelPath` argument from the WhisperEngine interface is ignored — Deepgram
 * selects its own model server-side. We send `model=nova-2` (Deepgram's most
 * accurate general-purpose pre-recorded model).
 *
 * @throws {SttKeyMissingError} when `voice.stt.deepgram.apiKey` is absent.
 */
export function buildDeepgramSttEngine(deps: CloudSttEngineDeps): WhisperEngine {
  const fetchFn = deps.fetchFn ?? globalThis.fetch.bind(globalThis);

  return {
    async transcribe(audio: Float32Array): Promise<TranscribeResult> {
      const apiKey = deps.getApiKey('deepgram');
      if (!apiKey) {
        throw new SttKeyMissingError('deepgram');
      }

      const wavBuffer = encodeWav(audio, 16000);

      const url =
        'https://api.deepgram.com/v1/listen?model=nova-2&language=en&smart_format=true';

      const response = await fetchFn(url, {
        method: 'POST',
        headers: {
          Authorization: `Token ${apiKey}`,
          'Content-Type': 'audio/wav',
        },
        body: wavBuffer,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`Deepgram STT error ${response.status}: ${body}`);
      }

      // Deepgram response shape (pre-recorded):
      // { results: { channels: [{ alternatives: [{ transcript: string }] }] } }
      const json = await response.json() as {
        results?: {
          channels?: Array<{
            alternatives?: Array<{ transcript?: string }>;
          }>;
        };
      };

      const transcript =
        json.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? '';

      return {
        text: transcript.trim(),
        segments: [],
      };
    },
  };
}
