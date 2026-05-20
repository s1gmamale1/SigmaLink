// @vitest-environment jsdom
//
// v1.4.8 — insertMention unit tests.
//
// Verifies that the PTY write RPC is called with the correct `@<path> ` format,
// and that a toast is shown (not a write) when the session is not running.
//
// v1.5.1-A: now imports the real insertMention from insertMention.ts instead
// of duplicating the logic inline.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---- mocks ---------------------------------------------------------------

const ptyWriteMock = vi.fn().mockResolvedValue(undefined);
const toastWarningMock = vi.fn();

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    pty: {
      write: (...args: unknown[]) => ptyWriteMock(...args),
    },
  },
}));

vi.mock('sonner', () => ({
  toast: {
    warning: (...args: unknown[]) => toastWarningMock(...args),
    error: vi.fn(),
    success: vi.fn(),
  },
}));

// ---- import the real function ---------------------------------------------

import { insertMention } from './insertMention';

// ---- tests -----------------------------------------------------------------

describe('insertMention', () => {
  beforeEach(() => {
    ptyWriteMock.mockReset();
    toastWarningMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('writes "@<path> " (trailing space) to the PTY when session is running', async () => {
    await insertMention('session-abc', 'src/components/Button.tsx', 'running');

    expect(ptyWriteMock).toHaveBeenCalledOnce();
    expect(ptyWriteMock).toHaveBeenCalledWith('session-abc', '@src/components/Button.tsx ');
  });

  it('includes the trailing space even for short paths', async () => {
    await insertMention('s1', 'index.ts', 'running');
    const [, data] = ptyWriteMock.mock.calls[0] as [string, string];
    expect(data.endsWith(' ')).toBe(true);
  });

  it('writes the correct session ID', async () => {
    await insertMention('target-session', 'foo/bar.ts', 'running');
    const [sessionId] = ptyWriteMock.mock.calls[0] as [string, string];
    expect(sessionId).toBe('target-session');
  });

  it('does NOT write to the PTY when session status is "exited"', async () => {
    await insertMention('s1', 'foo.ts', 'exited');
    expect(ptyWriteMock).not.toHaveBeenCalled();
  });

  it('shows a warning toast when session is not running', async () => {
    await insertMention('s1', 'foo.ts', 'exited');
    expect(toastWarningMock).toHaveBeenCalledOnce();
  });

  it('does NOT write to the PTY when session status is "error"', async () => {
    await insertMention('s1', 'foo.ts', 'error');
    expect(ptyWriteMock).not.toHaveBeenCalled();
  });

  it('does NOT write to the PTY when session status is "starting"', async () => {
    await insertMention('s1', 'foo.ts', 'starting');
    expect(ptyWriteMock).not.toHaveBeenCalled();
  });

  it('correctly formats multi-file paths joined with " @"', async () => {
    // The drop handler joins multiple paths as paths.join(' @') and then
    // insertMention wraps with @…space. Verify the resulting string.
    const paths = ['src/a.ts', 'src/b.ts', 'src/c.ts'];
    const mention = paths.join(' @'); // "src/a.ts @src/b.ts @src/c.ts"
    await insertMention('s1', mention, 'running');
    expect(ptyWriteMock).toHaveBeenCalledWith('s1', '@src/a.ts @src/b.ts @src/c.ts ');
  });
});
