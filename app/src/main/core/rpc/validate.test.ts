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
  // ARCH-9 — a channel with a CONCRETE output schema for the output validator.
  'git.status': { input: z.any(), output: z.object({ branch: z.string(), clean: z.boolean() }) },
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
import { validateChannelInput, validateChannelOutput } from './validate';

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

describe('validateChannelOutput — ARCH-9 fail-open drift detection', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => warnSpy.mockRestore());

  it('returns the value unchanged when it matches the output schema (no warn)', () => {
    const ok = { branch: 'main', clean: true };
    expect(validateChannelOutput('git.status', ok)).toBe(ok);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('FAILS OPEN on a drifted output — returns the ORIGINAL + warns once', () => {
    const bad = { branch: 123, clean: 'nope' } as unknown;
    // never throws, never rejects — returns the original object identity.
    expect(validateChannelOutput('git.status', bad)).toBe(bad);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    // second mismatch for the same channel does not spam.
    validateChannelOutput('git.status', { branch: 1 });
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('passes through channels with no output schema / z.any() output', () => {
    const v = { whatever: [1, 2, 3] };
    expect(validateChannelOutput('workspaces.launch', v)).toBe(v); // z.any()
    expect(validateChannelOutput('does.not.exist', v)).toBe(v); // unknown channel
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
