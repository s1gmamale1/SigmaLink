// @vitest-environment jsdom
//
// W-5 Phase 3 — insertSkillCommand unit tests.
//
// Verifies:
//   1. insertSkillCommand writes '/<name> ' (trailing space) to the PTY
//      when the session is running.
//   2. A toast is shown (not a write) when the session is not running.
//   3. isSlashCapableProvider returns true for claude/codex/gemini and false
//      for kimi/opencode/unknown providers.

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

// ---- import the real functions -------------------------------------------

import { insertSkillCommand, isSlashCapableProvider } from './insertSkillCommand';

// ---- tests ---------------------------------------------------------------

describe('insertSkillCommand', () => {
  beforeEach(() => {
    ptyWriteMock.mockReset();
    toastWarningMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('writes "/<name> " (trailing space, no newline) when session is running', async () => {
    await insertSkillCommand('session-abc', 'code-review', 'running');

    expect(ptyWriteMock).toHaveBeenCalledOnce();
    expect(ptyWriteMock).toHaveBeenCalledWith('session-abc', '/code-review ');
  });

  it('includes the trailing space even for single-word skill names', async () => {
    await insertSkillCommand('s1', 'debug', 'running');
    const [, data] = ptyWriteMock.mock.calls[0] as [string, string];
    expect(data.endsWith(' ')).toBe(true);
  });

  it('does NOT include a newline after the skill name', async () => {
    await insertSkillCommand('s1', 'optimize', 'running');
    const [, data] = ptyWriteMock.mock.calls[0] as [string, string];
    expect(data).not.toContain('\n');
    expect(data).not.toContain('\r');
  });

  it('writes the correct session ID', async () => {
    await insertSkillCommand('target-session', 'brainstorm', 'running');
    const [sessionId] = ptyWriteMock.mock.calls[0] as [string, string];
    expect(sessionId).toBe('target-session');
  });

  it('does NOT write to the PTY when session status is "exited"', async () => {
    await insertSkillCommand('s1', 'review', 'exited');
    expect(ptyWriteMock).not.toHaveBeenCalled();
  });

  it('shows a warning toast when session status is "exited"', async () => {
    await insertSkillCommand('s1', 'review', 'exited');
    expect(toastWarningMock).toHaveBeenCalledOnce();
  });

  it('does NOT write to the PTY when session status is "error"', async () => {
    await insertSkillCommand('s1', 'review', 'error');
    expect(ptyWriteMock).not.toHaveBeenCalled();
  });

  it('shows a warning toast when session status is "error"', async () => {
    await insertSkillCommand('s1', 'review', 'error');
    expect(toastWarningMock).toHaveBeenCalledOnce();
  });

  it('does NOT write to the PTY when session status is "starting"', async () => {
    await insertSkillCommand('s1', 'review', 'starting');
    expect(ptyWriteMock).not.toHaveBeenCalled();
  });

  it('shows a warning toast when session status is "starting"', async () => {
    await insertSkillCommand('s1', 'review', 'starting');
    expect(toastWarningMock).toHaveBeenCalledOnce();
  });

  it('correctly prefixes with "/" regardless of skill name content', async () => {
    await insertSkillCommand('s1', 'sparc:code', 'running');
    expect(ptyWriteMock).toHaveBeenCalledWith('s1', '/sparc:code ');
  });
});

describe('isSlashCapableProvider', () => {
  it('returns true for "claude"', () => {
    expect(isSlashCapableProvider('claude')).toBe(true);
  });

  it('returns true for "codex"', () => {
    expect(isSlashCapableProvider('codex')).toBe(true);
  });

  it('returns true for "gemini"', () => {
    expect(isSlashCapableProvider('gemini')).toBe(true);
  });

  it('returns false for "kimi"', () => {
    expect(isSlashCapableProvider('kimi')).toBe(false);
  });

  it('returns false for "opencode"', () => {
    expect(isSlashCapableProvider('opencode')).toBe(false);
  });

  it('returns false for an empty string', () => {
    expect(isSlashCapableProvider('')).toBe(false);
  });

  it('returns false for an unknown provider', () => {
    expect(isSlashCapableProvider('unknown-provider')).toBe(false);
  });
});
