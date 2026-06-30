// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { summarizeTitle, sanitizeTitle, setTitleModels, __resetSummarizerCache } from './pane-title-summarizer';

afterEach(() => __resetSummarizerCache());

/** A fake fetch that returns the queued responses in order (one per call). */
function fakeFetch(responses: Array<{ ok?: boolean; status?: number; body?: unknown } | Error>) {
  let i = 0;
  return vi.fn(async () => {
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    if (r instanceof Error) throw r;
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      json: async () => r.body ?? {},
    } as Response;
  });
}

describe('sanitizeTitle', () => {
  it('keeps a clean title', () => expect(sanitizeTitle('ecommerce website development')).toBe('ecommerce website development'));
  it('strips quotes/markdown + SIGMA::LABEL', () => {
    expect(sanitizeTitle('"Auth Refactor"')).toBe('Auth Refactor');
    expect(sanitizeTitle('SIGMA::LABEL token flow')).toBe('token flow');
  });
  it('rejects junk', () => { expect(sanitizeTitle('')).toBeNull(); expect(sanitizeTitle('...')).toBeNull(); });
});

describe('summarizeTitle (Ollama cloud)', () => {
  it('returns the title from the model response', async () => {
    const f = fakeFetch([{ body: { response: 'ecommerce website development' } }]) as never;
    expect(await summarizeTitle('build an ecommerce site', f)).toBe('ecommerce website development');
  });

  it('POSTs to the local ollama daemon with the cloud model + stream:false', async () => {
    const f = fakeFetch([{ body: { response: 'a title' } }]) as never;
    await summarizeTitle('task', f);
    const [url, opts] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('http://127.0.0.1:11434/api/generate');
    const sent = JSON.parse((opts as { body: string }).body);
    expect(sent.model).toBe('qwen3-coder:480b-cloud');
    expect(sent.stream).toBe(false);
  });

  it('falls back to the next model when the first is retired (4xx body error)', async () => {
    const f = fakeFetch([
      { body: { error: 'qwen3-coder was retired' } }, // model 1 permanent error
      { body: { response: 'fallback title' } },        // model 2 ok
    ]) as never;
    expect(await summarizeTitle('task', f)).toBe('fallback title');
  });

  it('retries the same model once on a 5xx cold-start, then succeeds', async () => {
    const f = fakeFetch([
      { ok: false, status: 502 },                 // cold-start
      { body: { response: 'warm title' } },        // retry ok
    ]) as never;
    expect(await summarizeTitle('task', f)).toBe('warm title');
  });

  it('returns null when every model fails', async () => {
    const f = fakeFetch([{ ok: false, status: 401 }]) as never; // unauthorized, all
    expect(await summarizeTitle('task', f)).toBeNull();
  });

  it('returns null on a network error (daemon down)', async () => {
    const f = fakeFetch([new Error('ECONNREFUSED')]) as never;
    expect(await summarizeTitle('task', f)).toBeNull();
  });

  it('returns null for blank input without calling fetch', async () => {
    const f = fakeFetch([{ body: { response: 'x' } }]) as never;
    expect(await summarizeTitle('   ', f)).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });

  it('honors a model override via setTitleModels', async () => {
    setTitleModels(['my-custom:cloud']);
    const f = fakeFetch([{ body: { response: 'custom' } }]) as never;
    await summarizeTitle('task', f);
    const sent = JSON.parse((f as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(sent.model).toBe('my-custom:cloud');
  });
});
