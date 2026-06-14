// cloud-stt-engine.test.ts — Unit tests for cloud STT engines (BSP-V1).
//
// All network calls are intercepted via injected `fetchFn` — no real HTTP.
//
// Run via:
//   npx vitest run packages/voice-core/src/cloud-stt-engine.test.ts

import { describe, it, expect, vi } from 'vitest';
import {
  buildOpenAiSttEngine,
  buildDeepgramSttEngine,
  SttKeyMissingError,
} from './cloud-stt-engine.js';
import type { CloudSttEngineDeps } from './cloud-stt-engine.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** 10 ms of silence at 16 kHz mono → Float32Array */
function silentAudio(durationSec = 0.01): Float32Array {
  return new Float32Array(Math.round(16000 * durationSec));
}

/** Create a fake fetch that returns the given JSON body + status. */
function makeFetchFn(status: number, body: unknown): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  ) as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// OpenAI engine
// ---------------------------------------------------------------------------

describe('buildOpenAiSttEngine', () => {
  it('throws SttKeyMissingError when the API key is absent', async () => {
    const deps: CloudSttEngineDeps = {
      fetchFn: vi.fn() as unknown as typeof fetch,
      getApiKey: () => null,
    };
    const engine = buildOpenAiSttEngine(deps);
    await expect(engine.transcribe(silentAudio(), '')).rejects.toBeInstanceOf(SttKeyMissingError);
  });

  it('SttKeyMissingError carries the right provider', async () => {
    const deps: CloudSttEngineDeps = {
      fetchFn: vi.fn() as unknown as typeof fetch,
      getApiKey: () => null,
    };
    const engine = buildOpenAiSttEngine(deps);
    try {
      await engine.transcribe(silentAudio(), '');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SttKeyMissingError);
      expect((err as SttKeyMissingError).provider).toBe('openai-whisper-api');
    }
  });

  it('POSTs to the correct OpenAI endpoint with Authorization header', async () => {
    const mockFetch = makeFetchFn(200, { text: 'hello world' });
    const deps: CloudSttEngineDeps = {
      fetchFn: mockFetch,
      getApiKey: () => 'sk-test123',
    };
    const engine = buildOpenAiSttEngine(deps);
    await engine.transcribe(silentAudio(), '');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer sk-test123');
    expect(init.method).toBe('POST');
  });

  it('returns the transcript text from the OpenAI response', async () => {
    const mockFetch = makeFetchFn(200, { text: ' Hello Jorvis! ' });
    const deps: CloudSttEngineDeps = {
      fetchFn: mockFetch,
      getApiKey: () => 'sk-key',
    };
    const engine = buildOpenAiSttEngine(deps);
    const result = await engine.transcribe(silentAudio(), '');
    expect(result.text).toBe('Hello Jorvis!');
    expect(result.segments).toEqual([]);
  });

  it('throws on non-200 HTTP response from OpenAI', async () => {
    const mockFetch = vi.fn(async () =>
      new Response('Unauthorized', { status: 401 }),
    ) as unknown as typeof fetch;
    const deps: CloudSttEngineDeps = {
      fetchFn: mockFetch,
      getApiKey: () => 'bad-key',
    };
    const engine = buildOpenAiSttEngine(deps);
    await expect(engine.transcribe(silentAudio(), '')).rejects.toThrow('OpenAI-compatible STT error 401');
  });

  it('returns empty string when OpenAI response has no text field', async () => {
    const mockFetch = makeFetchFn(200, {});
    const deps: CloudSttEngineDeps = { fetchFn: mockFetch, getApiKey: () => 'sk-key' };
    const engine = buildOpenAiSttEngine(deps);
    const result = await engine.transcribe(silentAudio(), '');
    expect(result.text).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Deepgram engine
// ---------------------------------------------------------------------------

describe('buildDeepgramSttEngine', () => {
  it('throws SttKeyMissingError when the API key is absent', async () => {
    const deps: CloudSttEngineDeps = {
      fetchFn: vi.fn() as unknown as typeof fetch,
      getApiKey: () => null,
    };
    const engine = buildDeepgramSttEngine(deps);
    await expect(engine.transcribe(silentAudio(), '')).rejects.toBeInstanceOf(SttKeyMissingError);
  });

  it('SttKeyMissingError carries the right provider', async () => {
    const deps: CloudSttEngineDeps = {
      fetchFn: vi.fn() as unknown as typeof fetch,
      getApiKey: () => null,
    };
    const engine = buildDeepgramSttEngine(deps);
    try {
      await engine.transcribe(silentAudio(), '');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SttKeyMissingError);
      expect((err as SttKeyMissingError).provider).toBe('deepgram');
    }
  });

  it('POSTs to the correct Deepgram endpoint with Authorization header', async () => {
    const dgResponse = {
      results: { channels: [{ alternatives: [{ transcript: 'test audio' }] }] },
    };
    const mockFetch = makeFetchFn(200, dgResponse);
    const deps: CloudSttEngineDeps = {
      fetchFn: mockFetch,
      getApiKey: () => 'dg-tok-abc',
    };
    const engine = buildDeepgramSttEngine(deps);
    await engine.transcribe(silentAudio(), '');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain('api.deepgram.com/v1/listen');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Token dg-tok-abc');
    expect(init.method).toBe('POST');
  });

  it('parses the transcript from the Deepgram response shape', async () => {
    const dgResponse = {
      results: { channels: [{ alternatives: [{ transcript: ' deep gram result ' }] }] },
    };
    const mockFetch = makeFetchFn(200, dgResponse);
    const deps: CloudSttEngineDeps = {
      fetchFn: mockFetch,
      getApiKey: () => 'dg-key',
    };
    const engine = buildDeepgramSttEngine(deps);
    const result = await engine.transcribe(silentAudio(), '');
    expect(result.text).toBe('deep gram result');
    expect(result.segments).toEqual([]);
  });

  it('throws on non-200 HTTP response from Deepgram', async () => {
    const mockFetch = vi.fn(async () =>
      new Response('Invalid credentials', { status: 401 }),
    ) as unknown as typeof fetch;
    const deps: CloudSttEngineDeps = {
      fetchFn: mockFetch,
      getApiKey: () => 'bad',
    };
    const engine = buildDeepgramSttEngine(deps);
    await expect(engine.transcribe(silentAudio(), '')).rejects.toThrow('Deepgram STT error 401');
  });

  it('returns empty string when the Deepgram response has missing channels', async () => {
    const mockFetch = makeFetchFn(200, { results: {} });
    const deps: CloudSttEngineDeps = { fetchFn: mockFetch, getApiKey: () => 'dg-key' };
    const engine = buildDeepgramSttEngine(deps);
    const result = await engine.transcribe(silentAudio(), '');
    expect(result.text).toBe('');
  });
});

// ---------------------------------------------------------------------------
// ADR-007 — configurable endpoint (custom baseUrl + optional key)
// ---------------------------------------------------------------------------

describe('buildOpenAiSttEngine — configurable endpoint (ADR-007)', () => {
  it('POSTs to a custom baseUrl + model and omits Authorization when keyless', async () => {
    let calledUrl = '';
    let calledHeaders: Record<string, string> = {};
    const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
      calledUrl = url;
      calledHeaders = (init.headers ?? {}) as Record<string, string>;
      return new Response(JSON.stringify({ text: 'hello lan' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const engine = buildOpenAiSttEngine({
      fetchFn,
      getApiKey: () => null,
      getBaseUrl: () => 'http://192.168.1.50:8000/v1',
      getModel: () => 'Systran/faster-whisper-large-v3',
    });
    const result = await engine.transcribe(silentAudio(), '');
    expect(result.text).toBe('hello lan');
    expect(calledUrl).toBe('http://192.168.1.50:8000/v1/audio/transcriptions');
    expect('Authorization' in calledHeaders).toBe(false);
  });

  it('sends Authorization when a key IS present, against the custom baseUrl', async () => {
    let calledUrl = '';
    let calledHeaders: Record<string, string> = {};
    const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
      calledUrl = url;
      calledHeaders = (init.headers ?? {}) as Record<string, string>;
      return new Response(JSON.stringify({ text: 'k' }), { status: 200 });
    }) as unknown as typeof fetch;
    const engine = buildOpenAiSttEngine({
      fetchFn, getApiKey: () => 'sk-test', getBaseUrl: () => 'https://api.groq.com/openai/v1',
    });
    await engine.transcribe(silentAudio(), '');
    expect(calledUrl).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
    expect(calledHeaders.Authorization).toBe('Bearer sk-test');
  });

  it('strips a trailing slash from the baseUrl (no double slash in URL)', async () => {
    let calledUrl = '';
    const fetchFn = vi.fn(async (url: string) => {
      calledUrl = url;
      return new Response(JSON.stringify({ text: 'ok' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const engine = buildOpenAiSttEngine({
      fetchFn,
      getApiKey: () => null,
      getBaseUrl: () => 'http://192.168.1.50:8000/v1/',
    });
    await engine.transcribe(silentAudio(), '');
    expect(calledUrl).toBe('http://192.168.1.50:8000/v1/audio/transcriptions');
  });

  it('does NOT throw SttKeyMissingError when a baseUrl is set but no key', async () => {
    const fetchFn = makeFetchFn(200, { text: 'ok' });
    const engine = buildOpenAiSttEngine({ fetchFn, getApiKey: () => null, getBaseUrl: () => 'http://box:9000' });
    await expect(engine.transcribe(silentAudio(), '')).resolves.toEqual({ text: 'ok', segments: [] });
  });

  it('still throws SttKeyMissingError for default cloud (no baseUrl, no key)', async () => {
    const engine = buildOpenAiSttEngine({ fetchFn: vi.fn() as unknown as typeof fetch, getApiKey: () => null });
    await expect(engine.transcribe(silentAudio(), '')).rejects.toBeInstanceOf(SttKeyMissingError);
  });
});
