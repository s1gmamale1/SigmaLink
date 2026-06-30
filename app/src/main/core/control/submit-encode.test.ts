import { describe, it, expect, vi } from 'vitest';
import { submitByte, submitPrompt } from './submit-encode';

describe('submit-encode', () => {
  it('submitByte defaults to CR for all known providers', () => {
    for (const p of ['claude', 'codex', 'gemini', 'kimi', 'opencode', 'unknown']) {
      expect(submitByte(p)).toBe('\r');
    }
  });

  it('submitPrompt writes body, settles, then writes the submit byte separately', async () => {
    const writes: string[] = [];
    const order: string[] = [];
    const sleep = vi.fn(async () => { order.push('settle'); });
    await submitPrompt((s) => { writes.push(s); order.push(`write:${s === '\r' ? 'CR' : 'body'}`); },
      'claude', 'multi\nline task', { settleMs: 80, sleep });
    expect(writes).toEqual(['multi\nline task', '\r']);
    expect(order).toEqual(['write:body', 'settle', 'write:CR']);
    expect(sleep).toHaveBeenCalledWith(80);
  });
});
