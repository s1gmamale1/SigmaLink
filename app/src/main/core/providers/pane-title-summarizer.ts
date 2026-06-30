// Provider-agnostic pane-title summarizer via Ollama CLOUD models — a raw HTTP
// call to the LOCAL ollama daemon (127.0.0.1:11434), which PROXIES the request to
// Ollama's servers. So: free (Ollama free tier, after `ollama signin`), clean,
// fast (~2s warm), and crucially NO local model RAM (the compute is remote). No
// API key in the app; decoupled from the pane's own agent.
//
// Self-healing model choice: try the preferred cloud models in order; a retired/
// unauthorized/unavailable model just falls through to the next (verified live:
// glm-4.6 returned "was retired"). All fail → null → renderer keeps the pane name.
//
// Reasoning models (gpt-oss) need a bigger token budget to emit past their hidden
// thinking; non-reasoning ones (qwen3-coder) answer directly — encoded per model.

import { spawn } from 'node:child_process';

const OLLAMA_URL = 'http://127.0.0.1:11434/api/generate';
const WARM_TIMEOUT_MS = 35_000; // first cloud call can cold-start (~30s/502); warm ~2s
const TITLE_CAP = 60;

interface TitleModel { name: string; numPredict: number; think: boolean }
// Preferred cloud models, best first. qwen3-coder answers directly (no reasoning);
// gpt-oss reasons so it needs a larger budget. Override-able via setTitleModels().
let MODELS: TitleModel[] = [
  { name: 'qwen3-coder:480b-cloud', numPredict: 24, think: false },
  { name: 'gpt-oss:120b-cloud', numPredict: 160, think: false },
];

/** Operator/KV override of the model preference list (names). */
export function setTitleModels(names: string[]): void {
  if (names.length) {
    MODELS = names.map((name) =>
      name.startsWith('gpt-oss')
        ? { name, numPredict: 160, think: false }
        : { name, numPredict: 24, think: false },
    );
  }
}

let triedStartServe = false;

/** Best-effort: start `ollama serve` once if the daemon is down (it's light with
 *  no LOCAL model loaded — cloud models don't load weights locally). */
function tryStartOllamaServe(): void {
  if (triedStartServe || process.env.VITEST) return; // never spawn during tests
  triedStartServe = true;
  try {
    const child = spawn('ollama', ['serve'], { detached: true, stdio: 'ignore' });
    // ENOENT (not installed) arrives as an ASYNC 'error' event — swallow it, else
    // it surfaces as an unhandled error. Caller falls back to name-only anyway.
    child.on('error', () => { /* not installed / can't start */ });
    child.unref();
  } catch {
    /* sync spawn failure — ignored */
  }
}

/** Clean a model's reply into a title: strip a stray SIGMA::LABEL prefix, quotes,
 *  markdown, edge punctuation; collapse; cap. Null if nothing usable. */
export function sanitizeTitle(out: string): string | null {
  const line = out.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  let s = line.replace(/^\s*SIGMA::LABEL\s*/i, '');
  s = s.replace(/^["'`*#\s.\-–—]+/, '').replace(/["'`*\s.]+$/, '').replace(/\s+/g, ' ').trim();
  if (!s || !/[\p{L}\p{N}]/u.test(s)) return null;
  return s.length > TITLE_CAP ? s.slice(0, TITLE_CAP).trim() : s;
}

interface OllamaResult { ok: boolean; title: string | null; retry: boolean }

async function callOllama(
  model: TitleModel,
  prompt: string,
  fetchImpl: typeof fetch,
): Promise<OllamaResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), WARM_TIMEOUT_MS);
  try {
    const res = await fetchImpl(OLLAMA_URL, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: model.name,
        prompt,
        stream: false,
        think: model.think,
        options: { num_predict: model.numPredict, temperature: 0.2 },
      }),
    });
    if (!res.ok) {
      // 5xx (incl. cloud cold-start 502) is worth one retry on the SAME model;
      // 4xx (retired/unauthorized) is permanent → move to the next model.
      return { ok: false, title: null, retry: res.status >= 500 };
    }
    const data = (await res.json()) as { response?: string; error?: string };
    if (data.error) return { ok: false, title: null, retry: false };
    return { ok: true, title: sanitizeTitle(String(data.response ?? '')), retry: false };
  } catch {
    // Network error (daemon down / abort) — try to bring the daemon up, retry once.
    tryStartOllamaServe();
    return { ok: false, title: null, retry: true };
  } finally {
    clearTimeout(timer);
  }
}

function buildTitlePrompt(text: string): string {
  return (
    'Output ONLY a 2-4 word lowercase title (no quotes, no punctuation, no ' +
    'reasoning, no explanation) for this coding task:\n\n' + text.slice(0, 2_000)
  );
}

/**
 * Summarize a task prompt into a short title via an Ollama cloud model, or null on
 * any failure. `fetchImpl` is injectable for tests.
 */
export async function summarizeTitle(
  text: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  if (!text || !text.trim()) return null;
  const prompt = buildTitlePrompt(text);

  for (const model of MODELS) {
    let r = await callOllama(model, prompt, fetchImpl);
    if (!r.ok && r.retry) r = await callOllama(model, prompt, fetchImpl); // one retry (cold-start/daemon-up)
    if (r.title) return r.title;
    // else: empty/permanent-error → fall through to the next preferred model
  }
  return null;
}

/** Test-only: reset module state. */
export function __resetSummarizerCache(): void {
  triedStartServe = false;
  MODELS = [
    { name: 'qwen3-coder:480b-cloud', numPredict: 24, think: false },
    { name: 'gpt-oss:120b-cloud', numPredict: 160, think: false },
  ];
}
