// H-8 — IPC payload validation tests. Drives `validateChannelInput` against a
// mocked schema registry so both VALIDATION_MODE branches are exercised in
// isolation. The registry is mocked (not the real CHANNEL_SCHEMAS) so the test
// stays decoupled from future schema churn: we assert the VALIDATOR's
// behaviour, not the specific shapes in schemas.ts.
//
// Pure node test (vitest `globals: false` → explicit imports). No Electron, no
// DB, no native modules.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ChannelSchema } from './schemas';

// ── Mock the schema registry + mode flag ────────────────────────────────────
// `VALIDATION_MODE` is a const export; we expose a mutable `mode` ref through
// the mock so each suite can flip it before importing the validator.
const mockState: { mode: 'warn' | 'enforce' } = { mode: 'enforce' };

const SCHEMAS: Record<string, ChannelSchema> = {
  // A tightened object channel mirroring `fs.writeFile`.
  'fs.writeFile': {
    input: z.object({
      path: z.string().min(1).max(4096),
      content: z.string().max(16 * 1024 * 1024),
      repoRoot: z.string().min(1).max(4096),
    }),
    output: z.any(),
  },
  // A `stub`/z.any channel: input present but permissive.
  'workspaces.launch': { input: z.any(), output: z.any() },
  // An output-only entry (no `input`): should always pass through.
  'app.tier': { output: z.enum(['basic', 'pro', 'ultra']) },
};

vi.mock('./schemas', () => ({
  get VALIDATION_MODE() {
    return mockState.mode;
  },
  getChannelSchema: (channel: string): ChannelSchema | undefined => SCHEMAS[channel],
}));

// Import AFTER the mock is registered. `validateChannelInput` reads
// VALIDATION_MODE live through the getter, so flipping `mockState.mode` between
// suites takes effect without re-importing.
import { validateChannelInput } from './validate';

const VALID_WRITE = {
  path: '/repo/src/a.ts',
  content: 'hello',
  repoRoot: '/repo',
};

describe('validateChannelInput — enforce mode', () => {
  beforeEach(() => {
    mockState.mode = 'enforce';
  });

  it('returns the parsed value for a tightened channel with a valid payload', () => {
    const out = validateChannelInput('fs.writeFile', VALID_WRITE);
    expect(out).toEqual(VALID_WRITE);
  });

  it('THROWS when a required field is missing (no `path`)', () => {
    expect(() =>
      validateChannelInput('fs.writeFile', { content: 'x', repoRoot: '/repo' }),
    ).toThrow();
  });

  it('THROWS when `path` is not a string', () => {
    expect(() =>
      validateChannelInput('fs.writeFile', { path: 42, content: 'x', repoRoot: '/repo' }),
    ).toThrow();
  });

  it('throws a ZodError instance on failure', () => {
    try {
      validateChannelInput('fs.writeFile', {});
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(z.ZodError);
    }
  });

  it('passes anything through for a stub (z.any) channel', () => {
    expect(validateChannelInput('workspaces.launch', { anything: [1, 2, 3] })).toEqual({
      anything: [1, 2, 3],
    });
    expect(validateChannelInput('workspaces.launch', 'a string')).toBe('a string');
    expect(validateChannelInput('workspaces.launch', undefined)).toBeUndefined();
  });

  it('passes an unknown channel through without throwing', () => {
    const payload = { evil: true };
    expect(validateChannelInput('totally.unknown', payload)).toBe(payload);
  });

  it('passes through an output-only schema entry (no `input`)', () => {
    const payload = { whatever: 1 };
    expect(validateChannelInput('app.tier', payload)).toBe(payload);
  });
});

describe('validateChannelInput — warn mode', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockState.mode = 'warn';
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('returns the ORIGINAL input (never throws) on a bad payload + warns', () => {
    const bad = { content: 'x' }; // missing path + repoRoot
    const out = validateChannelInput('fs.writeFile', bad);
    expect(out).toBe(bad); // original, not parsed
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain('fs.writeFile');
  });

  it('returns the parsed value (no warn) on a valid payload', () => {
    const out = validateChannelInput('fs.writeFile', VALID_WRITE);
    expect(out).toEqual(VALID_WRITE);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('warns once for an unknown channel and passes through', () => {
    const payload = { x: 1 };
    expect(validateChannelInput('warn.unknownChannel', payload)).toBe(payload);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    // Second call for the same channel must NOT re-warn (deduped).
    expect(validateChannelInput('warn.unknownChannel', payload)).toBe(payload);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
