// P0.3 — contract tests for classifyEnvelope, backed by recorded/derived
// fixtures so a new `claude` CLI release can't silently break turn routing.
// See cli-envelope.ts header for the envelope shape reference.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCliLine, classifyEnvelope } from './cli-envelope';

const fx = (n: string) =>
  readFileSync(join(__dirname, '__fixtures__/cli-envelopes', n), 'utf8')
    .split('\n').filter(Boolean);

describe('classifyEnvelope', () => {
  it('never throws and classifies every line of the unknown-subtypes fixture', () => {
    for (const line of fx('unknown-subtypes.jsonl')) {
      const env = parseCliLine(line);
      expect(env).not.toBeNull();
      expect(() => classifyEnvelope(env!)).not.toThrow();
    }
  });
  it('classifies the known shapes', () => {
    const kinds = fx('unknown-subtypes.jsonl').map((l) => classifyEnvelope(parseCliLine(l)!));
    expect(kinds).toEqual([
      'system-init', 'other', 'assistant', 'other', 'result-success', 'other',
    ]);
  });
  it('a recorded real success turn ends in exactly one result-success', () => {
    const kinds = fx('success.jsonl').map((l) => classifyEnvelope(parseCliLine(l)!));
    expect(kinds.filter((k) => k === 'result-success').length).toBe(1);
  });
  it('malformed lines parse to null (caller surfaces raw delta)', () => {
    expect(parseCliLine('{not json')).toBeNull();
    expect(parseCliLine('')).toBeNull();
  });
});
