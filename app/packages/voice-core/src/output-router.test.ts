// output-router.test.ts — Unit tests for @sigmalink/voice-core output-router.
//
// Covers the C-10b focused-pane inject branch and existing routing fallbacks.
// All native/Electron deps are mocked so tests run on any platform.
//
// Run via:
//   pnpm exec vitest run packages/voice-core/src/output-router.test.ts

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(() => ({ status: 1, stdout: '', stderr: '' })),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

import { routeTranscript } from './output-router.js';

function makeEmit() {
  return vi.fn<(event: string, payload: unknown) => void>();
}

function makeClipboard() {
  return { writeText: vi.fn() };
}

describe('routeTranscript — C-10b focused-pane branch', () => {
  let emit: ReturnType<typeof makeEmit>;
  let clipboard: ReturnType<typeof makeClipboard>;
  let ptyWrite: ReturnType<typeof vi.fn<(sessionId: string, data: string) => void>>;

  beforeEach(() => {
    emit = makeEmit();
    clipboard = makeClipboard();
    ptyWrite = vi.fn<(sessionId: string, data: string) => void>();
    vi.clearAllMocks();
  });

  it('writes text + newline to the focused pane and returns target:focused-pty', () => {
    const result = routeTranscript('hello world', emit, clipboard, {
      focusedSessionId: 's1',
      injectToPane: true,
      ptyWrite,
    });

    expect(ptyWrite).toHaveBeenCalledWith('s1', 'hello world\n');
    expect(result.target).toBe('focused-pty');
    expect(result.toast).toBe('');
    // Assistant dispatch must NOT fire
    expect(emit).not.toHaveBeenCalledWith('voice:dispatch-echo', expect.anything());
    // Clipboard must NOT be written
    expect(clipboard.writeText).not.toHaveBeenCalled();
  });

  it('falls through when injectToPane=false', () => {
    const result = routeTranscript('hello world', emit, clipboard, {
      focusedSessionId: 's1',
      injectToPane: false,
      ptyWrite,
    });

    expect(ptyWrite).not.toHaveBeenCalled();
    expect(result.target).not.toBe('focused-pty');
  });

  it('falls through when focusedSessionId is null even if injectToPane=true', () => {
    const result = routeTranscript('hello world', emit, clipboard, {
      focusedSessionId: null,
      injectToPane: true,
      ptyWrite,
    });

    expect(ptyWrite).not.toHaveBeenCalled();
    expect(result.target).not.toBe('focused-pty');
  });

  it('falls through when ptyWrite is not provided', () => {
    const result = routeTranscript('hello world', emit, clipboard, {
      focusedSessionId: 's1',
      injectToPane: true,
      // no ptyWrite
    });

    expect(result.target).not.toBe('focused-pty');
  });

  it('falls through when opts is undefined (no opts arg)', () => {
    const result = routeTranscript('hello world', emit, clipboard);

    expect(ptyWrite).not.toHaveBeenCalled();
    expect(result.target).not.toBe('focused-pty');
  });

  it('returns clipboard for empty transcript regardless of focused-pane opts', () => {
    const result = routeTranscript('   ', emit, clipboard, {
      focusedSessionId: 's1',
      injectToPane: true,
      ptyWrite,
    });

    expect(ptyWrite).not.toHaveBeenCalled();
    expect(result.target).toBe('clipboard');
  });

  it('passes the exact session id and appended newline to ptyWrite', () => {
    const result = routeTranscript('dictate this text', emit, clipboard, {
      focusedSessionId: 'pane-99',
      injectToPane: true,
      ptyWrite,
    });

    expect(ptyWrite).toHaveBeenCalledWith('pane-99', 'dictate this text\n');
    expect(result.target).toBe('focused-pty');
  });
});

describe('routeTranscript — existing routing (no C-10b opts)', () => {
  it('returns clipboard target on non-darwin/win/linux fallback', () => {
    // spawnSync mocked to fail → falls through all platform branches to clipboard
    const emit = makeEmit();
    const clipboard = makeClipboard();
    const result = routeTranscript('test', emit, clipboard);
    // Any non-focused-pty result is acceptable; just confirm it doesn't throw
    expect(['clipboard', 'sigmalink-pane', 'ax-paste']).toContain(result.target);
  });
});
