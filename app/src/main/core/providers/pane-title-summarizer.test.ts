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

/** Mimic `opencode run --format json` output: one JSON event per line. */
function jsonRun(text: string): string {
  return [
    JSON.stringify({ type: 'step_start', part: { type: 'step-start' } }),
    JSON.stringify({ type: 'text', part: { type: 'text', text } }),
    JSON.stringify({ type: 'step_finish', part: { type: 'step-finish' } }),
  ].join('\n') + '\n';
}

beforeEach(() => {
  __resetSummarizerCache();
  probeProviderById.mockResolvedValue({ id: 'opencode', found: true, resolvedPath: '/opt/homebrew/bin/opencode' });
});
afterEach(() => vi.clearAllMocks());

describe('sanitizeTitle', () => {
  it('keeps a clean title', () => expect(sanitizeTitle('Auth Refactor')).toBe('Auth Refactor'));
  it('strips quotes/markdown', () => expect(sanitizeTitle('- **Auth Refactor**')).toBe('Auth Refactor'));
  it('strips a leading SIGMA::LABEL sentinel', () => {
    expect(sanitizeTitle('SIGMA::LABEL Auth Refactor')).toBe('Auth Refactor');
    expect(sanitizeTitle('sigma::label  Token Flow')).toBe('Token Flow');
  });
  it('rejects junk', () => {
    expect(sanitizeTitle('')).toBeNull();
    expect(sanitizeTitle('...')).toBeNull();
  });
});

describe('summarizeTitle (opencode)', () => {
  it('parses the title from JSON text events', async () => {
    const spawn = vi.fn(() => fakeChild(jsonRun('Ecommerce Website Builder'))) as never;
    expect(await summarizeTitle('build an ecommerce site', spawn)).toBe('Ecommerce Website Builder');
  });

  it('runs `opencode run … --format json`, stdin closed, default model first (no -m)', async () => {
    const spawn = vi.fn(() => fakeChild(jsonRun('Title Here'))) as never;
    await summarizeTitle('some task', spawn);
    const [bin, args, opts] = (spawn as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(bin).toBe('/opt/homebrew/bin/opencode');
    expect(args[0]).toBe('run');
    expect(args).toContain('--format');
    expect(args).toContain('json');
    expect(args).not.toContain('-m'); // attempt 1 = opencode's default model
    expect((opts as { stdio?: unknown[] }).stdio?.[0]).toBe('ignore');
  });

  it('falls back to the first listed model when the default yields nothing', async () => {
    const spawn = vi.fn((_bin: string, args: string[]) => {
      if (args[0] === 'models') return fakeChild('opencode/big-pickle\nzai-coding-plan/glm-5.2\n');
      if (args[0] === 'run' && args.includes('-m')) return fakeChild(jsonRun('Fallback Title'));
      return fakeChild(''); // default run → empty
    }) as never;
    expect(await summarizeTitle('task', spawn)).toBe('Fallback Title');
    const runCalls = (spawn as unknown as ReturnType<typeof vi.fn>).mock.calls.filter((c) => c[1][0] === 'run');
    expect(runCalls[1][1]).toContain('opencode/big-pickle'); // first listed model
  });

  it('returns null when opencode is not installed', async () => {
    probeProviderById.mockResolvedValue({ id: 'opencode', found: false });
    const spawn = vi.fn(() => fakeChild(jsonRun('x'))) as never;
    expect(await summarizeTitle('task', spawn)).toBeNull();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('returns null on a spawn error', async () => {
    const spawn = vi.fn(() => fakeChild('', { error: true })) as never;
    expect(await summarizeTitle('task', spawn)).toBeNull();
  });

  it('returns null for blank input without spawning', async () => {
    const spawn = vi.fn(() => fakeChild('x')) as never;
    expect(await summarizeTitle('   ', spawn)).toBeNull();
    expect(spawn).not.toHaveBeenCalled();
  });
});
