import { describe, it, expect } from 'vitest';

import { extractSessionId, extractSessionIdFromLine } from './session-id-extractor.ts';

describe('session-id-extractor', () => {
  it('extracts Claude session id from stream-json system init envelope', () => {
    const hit = extractSessionIdFromLine(
      'claude',
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: '8c0fae96-1c52-4ce7-b10d-966c067a71f3',
        cwd: '/tmp/project',
      }),
    );

    expect(hit?.providerId).toBe('claude');
    expect(hit?.sessionId).toBe('8c0fae96-1c52-4ce7-b10d-966c067a71f3');
    expect(hit?.source).toBe('jsonl');
  });

  it('extracts Claude session id from interactive banner', () => {
    const hit = extractSessionId('claude', 'Welcome to Claude Code\nSession: claude-session-12345\n');

    expect(hit?.sessionId).toBe('claude-session-12345');
    expect(hit?.source).toBe('banner');
  });

  it('extracts Codex session id from startup banner', () => {
    const hit = extractSessionIdFromLine(
      'codex',
      '\u001b[32mSession ID: codex-session-abc123\u001b[0m',
    );

    expect(hit?.providerId).toBe('codex');
    expect(hit?.sessionId).toBe('codex-session-abc123');
  });

  it('extracts Codex session id from resume hint', () => {
    const hit = extractSessionId('codex', 'To continue this session, run: codex resume cx_1234567890abcdef');

    expect(hit?.sessionId).toBe('cx_1234567890abcdef');
  });

  it('Gemini is not treated as resumable without a known stable id', () => {
    const hit = extractSessionId('gemini', 'Session ID: maybe-but-unsupported\n');

    expect(hit).toBe(null);
  });

  it('ignores unrelated JSON and short tokens', () => {
    expect(
      extractSessionIdFromLine('claude', '{"type":"assistant","session_id":"not-init"}'),
    ).toBe(null);
    expect(extractSessionIdFromLine('codex', 'Session ID: abc')).toBe(null);
  });
});
