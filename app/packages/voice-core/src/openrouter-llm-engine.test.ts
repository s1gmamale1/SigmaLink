import { describe, it, expect, vi } from 'vitest';
import {
  buildOpenRouterTransform, LlmKeyMissingError, resolveTransformPrompt, TRANSFORM_PRESETS,
} from './openrouter-llm-engine.js';

function chatResponse(content: string, status = 200): typeof fetch {
  return vi.fn(async () => new Response(
    JSON.stringify({ choices: [{ message: { content } }] }),
    { status, headers: { 'Content-Type': 'application/json' } },
  )) as unknown as typeof fetch;
}

describe('buildOpenRouterTransform', () => {
  it('throws LlmKeyMissingError when no key', async () => {
    const transform = buildOpenRouterTransform({ fetchFn: vi.fn() as unknown as typeof fetch, getApiKey: () => null });
    await expect(transform('hi', { model: 'm', prompt: 'p' })).rejects.toBeInstanceOf(LlmKeyMissingError);
  });

  it('POSTs chat/completions with system+user messages and returns content', async () => {
    let url = ''; let body: any = {}; let headers: Record<string, string> = {};
    const fetchFn = vi.fn(async (u: string, init: RequestInit) => {
      url = u; headers = init.headers as Record<string, string>; body = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ choices: [{ message: { content: 'Cleaned text.' } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const transform = buildOpenRouterTransform({ fetchFn, getApiKey: () => 'or-key' });
    const out = await transform('cleaned text', { model: 'google/gemini-2.5-flash-lite', prompt: 'Fix it' });
    expect(out).toBe('Cleaned text.');
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(headers.Authorization).toBe('Bearer or-key');
    expect(body.model).toBe('google/gemini-2.5-flash-lite');
    expect(body.messages).toEqual([
      { role: 'system', content: 'Fix it' },
      { role: 'user', content: 'cleaned text' },
    ]);
  });

  it('throws on non-2xx so the caller can passthrough', async () => {
    const transform = buildOpenRouterTransform({ fetchFn: chatResponse('x', 500), getApiKey: () => 'k' });
    await expect(transform('t', { model: 'm', prompt: 'p' })).rejects.toThrow(/OpenRouter 500/);
  });
});

describe('resolveTransformPrompt', () => {
  it('returns the preset prompt for a known preset id', () => {
    expect(resolveTransformPrompt('punctuate', null)).toBe(TRANSFORM_PRESETS.punctuate);
    expect(resolveTransformPrompt('email', null)).toBe(TRANSFORM_PRESETS.email);
  });
  it('returns the custom prompt when preset=custom and a prompt is set', () => {
    expect(resolveTransformPrompt('custom', 'Make it a haiku')).toBe('Make it a haiku');
  });
  it('falls back to the punctuate preset for unknown/empty', () => {
    expect(resolveTransformPrompt(null, null)).toBe(TRANSFORM_PRESETS.punctuate);
    expect(resolveTransformPrompt('custom', '')).toBe(TRANSFORM_PRESETS.punctuate);
  });
});
