import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PromptSink } from './prompt-sink';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('PromptSink', () => {
  it('resolves on SIGMA::PROMPT with the parsed payload', async () => {
    const sink = new PromptSink();
    const p = sink.wait({ sessionIds: ['s1'], until: 'prompt', timeoutMs: 5000 });
    sink.feed('s1', 'some output\n');
    sink.feed('s1', 'SIGMA::PROMPT {"question":"Pick one","type":"single","choices":["a","b"]}\n');
    const r = await p;
    expect(r).toEqual({ sessionId: 's1', reason: 'prompt', prompt: { question: 'Pick one', type: 'single', choices: ['a', 'b'] } });
  });

  it('resolves on idle after idleMs of no data', async () => {
    const sink = new PromptSink();
    const p = sink.wait({ sessionIds: ['s1'], until: 'idle', timeoutMs: 5000, idleMs: 800 });
    sink.feed('s1', 'working...');
    await vi.advanceTimersByTimeAsync(799);
    sink.feed('s1', 'more'); // resets idle timer
    await vi.advanceTimersByTimeAsync(800);
    const r = await p;
    expect(r).toMatchObject({ sessionId: 's1', reason: 'idle' });
  });

  it('resolves on exit', async () => {
    const sink = new PromptSink();
    const p = sink.wait({ sessionIds: ['s1'], until: 'exit', timeoutMs: 5000 });
    sink.noteExit('s1');
    expect(await p).toMatchObject({ sessionId: 's1', reason: 'exit' });
  });

  it('wait-for-any resolves on the first ready session', async () => {
    const sink = new PromptSink();
    const p = sink.wait({ sessionIds: ['s1', 's2'], until: 'prompt', timeoutMs: 5000 });
    sink.feed('s2', 'SIGMA::PROMPT {"question":"Q","type":"single","choices":["y"]}\n');
    expect(await p).toMatchObject({ sessionId: 's2', reason: 'prompt' });
  });

  it('resolves reason:timeout when nothing happens', async () => {
    const sink = new PromptSink();
    const p = sink.wait({ sessionIds: ['s1'], until: 'prompt', timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await p).toMatchObject({ reason: 'timeout', sessionId: null });
  });
});
