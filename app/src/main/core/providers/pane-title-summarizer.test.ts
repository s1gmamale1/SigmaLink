// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

const probeProviderById = vi.fn();
vi.mock('./probe', () => ({
  probeProviderById: (id: string) => probeProviderById(id),
}));

import { summarizeTitle, sanitizeTitle, __resetSummarizerCache } from './pane-title-summarizer';

type FakeChild = EventEmitter & { stdout: EventEmitter; kill: () => void };

function fakeChild(stdout: string, opts: { error?: boolean } = {}): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.kill = () => {};
  queueMicrotask(() => {
    if (opts.error) { child.emit('error', new Error('spawn failed')); return; }
    if (stdout) child.stdout.emit('data', Buffer.from(stdout));
    child.emit('close', 0);
  });
  return child;
}

beforeEach(() => {
  __resetSummarizerCache();
  probeProviderById.mockResolvedValue({ id: 'claude', found: true, resolvedPath: '/usr/bin/claude' });
});
afterEach(() => vi.clearAllMocks());

describe('sanitizeTitle', () => {
  it('keeps a clean title', () => expect(sanitizeTitle('Auth Refactor')).toBe('Auth Refactor'));
  it('strips surrounding quotes/markdown', () => {
    expect(sanitizeTitle('"Auth Refactor"')).toBe('Auth Refactor');
    expect(sanitizeTitle('- **Auth Refactor**')).toBe('Auth Refactor');
  });
  it('takes the first non-empty line', () => expect(sanitizeTitle('\n  Auth Refactor \nblah')).toBe('Auth Refactor'));
  it('rejects junk', () => {
    expect(sanitizeTitle('')).toBeNull();
    expect(sanitizeTitle('...')).toBeNull();
    expect(sanitizeTitle('   ')).toBeNull();
  });
  it('caps very long output', () => {
    const long = 'word '.repeat(40);
    expect((sanitizeTitle(long) ?? '').length).toBeLessThanOrEqual(60);
  });
});

describe('summarizeTitle', () => {
  it('returns the sanitized model output', async () => {
    const spawn = vi.fn(() => fakeChild('Auth Refactor\n')) as never;
    expect(await summarizeTitle('refactor the auth flow', spawn)).toBe('Auth Refactor');
  });

  it('passes -p, the prompt, and --model haiku to the claude binary', async () => {
    const spawn = vi.fn(() => fakeChild('Title Here\n')) as never;
    await summarizeTitle('some task', spawn);
    const [bin, args] = (spawn as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(bin).toBe('/usr/bin/claude');
    expect(args).toContain('-p');
    expect(args).toContain('--model');
    expect(args).toContain('haiku');
  });

  it('returns null when the claude binary is not found', async () => {
    probeProviderById.mockResolvedValue({ id: 'claude', found: false });
    const spawn = vi.fn(() => fakeChild('x')) as never;
    expect(await summarizeTitle('task', spawn)).toBeNull();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('returns null on a spawn error', async () => {
    const spawn = vi.fn(() => fakeChild('', { error: true })) as never;
    expect(await summarizeTitle('task', spawn)).toBeNull();
  });

  it('returns null on empty output', async () => {
    const spawn = vi.fn(() => fakeChild('')) as never;
    expect(await summarizeTitle('task', spawn)).toBeNull();
  });

  it('returns null for blank input without spawning', async () => {
    const spawn = vi.fn(() => fakeChild('x')) as never;
    expect(await summarizeTitle('   ', spawn)).toBeNull();
    expect(spawn).not.toHaveBeenCalled();
  });
});
