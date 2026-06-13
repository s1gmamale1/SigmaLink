// openrouter-llm-engine.ts — OpenRouter chat/completions transform pass (ADR-007).
//
// Mirrors cloud-stt-engine.ts: injectable fetch, typed key-missing error, no Electron deps.
// Used as the post-transcription cleanup stage in global-capture.ts. Non-streaming.

export class LlmKeyMissingError extends Error {
  readonly provider = 'openrouter' as const;
  constructor() {
    super('OpenRouter API key missing. Set it in Settings → Cloud.');
    this.name = 'LlmKeyMissingError';
  }
}

export interface OpenRouterTransformDeps {
  /** Injectable fetch (global in prod, mock in tests). @default globalThis.fetch */
  fetchFn?: typeof fetch;
  /** Returns the OpenRouter API key (the app shell reads it from encrypted storage). */
  getApiKey: () => string | null;
}

export type TransformFn = (text: string, opts: { model: string; prompt: string }) => Promise<string>;

export function buildOpenRouterTransform(deps: OpenRouterTransformDeps): TransformFn {
  const fetchFn = deps.fetchFn ?? globalThis.fetch.bind(globalThis);
  return async (text, opts) => {
    const apiKey = deps.getApiKey();
    if (!apiKey) throw new LlmKeyMissingError();

    const response = await fetchFn('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://sigmavoice.app',
        'X-Title': 'SigmaVoice',
      },
      body: JSON.stringify({
        model: opts.model,
        temperature: 0.2,
        messages: [
          { role: 'system', content: opts.prompt },
          { role: 'user', content: text },
        ],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`OpenRouter ${response.status}: ${body}`);
    }
    const json = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    return (json.choices?.[0]?.message?.content ?? '').trim();
  };
}

// ── Transform prompt presets ────────────────────────────────────────────────
export const TRANSFORM_PRESETS = {
  punctuate:
    'You are a dictation cleanup tool. Fix punctuation, capitalization, and obvious ' +
    'transcription errors in the user\'s text. Do NOT add, remove, or rephrase content. ' +
    'Return only the corrected text, nothing else.',
  fillers:
    'You are a dictation cleanup tool. Remove filler words (um, uh, like, you know), false ' +
    'starts, and repetitions, then fix punctuation and capitalization. Preserve meaning and ' +
    'wording otherwise. Return only the cleaned text, nothing else.',
  email:
    'Rewrite the user\'s dictated text as a clear, professional email body. Keep the intent and ' +
    'facts; improve structure and tone. Return only the email body, no subject line, no preamble.',
} as const;

export type TransformPresetId = keyof typeof TRANSFORM_PRESETS | 'custom';

/** Resolve a preset id (+ optional custom prompt) to the system prompt string. */
export function resolveTransformPrompt(preset: string | null, customPrompt: string | null): string {
  if (preset === 'custom') {
    const p = (customPrompt ?? '').trim();
    return p || TRANSFORM_PRESETS.punctuate;
  }
  if (preset && preset in TRANSFORM_PRESETS) {
    return TRANSFORM_PRESETS[preset as keyof typeof TRANSFORM_PRESETS];
  }
  return TRANSFORM_PRESETS.punctuate;
}
