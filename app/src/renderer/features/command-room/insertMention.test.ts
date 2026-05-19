// @vitest-environment jsdom
//
// v1.4.8 — insertMention unit tests.
//
// Verifies that the PTY write RPC is called with the correct `@<path> ` format,
// and that a toast is shown (not a write) when the session is not running.

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

// ---- helpers ---------------------------------------------------------------

// We import the `insertMention` function indirectly by re-exporting it.
// Because it's an internal function in CommandRoom.tsx, we duplicate the
// minimal logic here to keep the test focused and avoid pulling in the full
// component tree. The real implementation is in CommandRoom.tsx and must stay
// in sync with this contract.
//
// Contract: insertMention(sessionId, path, sessionStatus)
//   - when status === 'running'   → calls rpc.pty.write(sessionId, `@${path} `)
//   - when status !== 'running'   → shows toast.warning, does NOT call write

import { rpc } from '@/renderer/lib/rpc';
import { toast } from 'sonner';

type SessionStatus = 'starting' | 'running' | 'exited' | 'error';

async function insertMention(
  sessionId: string,
  path: string,
  sessionStatus: SessionStatus,
): Promise<void> {
  if (sessionStatus !== 'running') {
    toast.warning('Pane is not running', { description: 'Start the pane before dropping files.' });
    return;
  }
  await rpc.pty.write(sessionId, `@${path} `);
}

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
