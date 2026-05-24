// output-router.test.ts — Unit tests for routeTranscript C-10b pane routing.
//
// Node env (default — no jsdom docblock required).
// All native + electron deps are mocked below.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock: electron (clipboard is used by the existing non-pane paths)
// ---------------------------------------------------------------------------

vi.mock('electron', () => ({
  clipboard: {
    writeText: vi.fn(),
    readText: vi.fn(() => ''),
  },
}));

// ---------------------------------------------------------------------------
// Mock: child_process (spawnSync used by Windows/Linux path detection)
// ---------------------------------------------------------------------------

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(() => ({ status: 1, stdout: '', stderr: '' })),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('routeTranscript — C-10b focused-pane branch', () => {
  let emit: (event: string, payload: unknown) => void;
  let ptyWrite: (sessionId: string, data: string) => void;

  beforeEach(() => {
    emit = vi.fn<(event: string, payload: unknown) => void>();
    ptyWrite = vi.fn<(sessionId: string, data: string) => void>();
    vi.clearAllMocks();
  });

  it('writes text + newline to the focused pane and returns target:focused-pty when injectToPane=true', async () => {
    const { routeTranscript } = await import('../output-router');

    const result = routeTranscript('hello world', emit, {
      focusedSessionId: 's1',
      injectToPane: true,
      ptyWrite,
    });

    expect(ptyWrite).toHaveBeenCalledWith('s1', 'hello world\n');
    expect(result.target).toBe('focused-pty');
    // dispatchToSigmaLinkPane MUST NOT be called (no voice:dispatch-echo)
    expect(emit).not.toHaveBeenCalledWith(
      'voice:dispatch-echo',
      expect.anything(),
    );
  });

  it('falls through to the existing assistant route when injectToPane=false', async () => {
    // Force darwin platform so we hit the sigmalink-pane path reliably by
    // mocking the bundle-id check to return the sigmalink id. On darwin the
    // loadMacExt is tried; mock it to null so getFrontmostBundleId returns ''.
    // That triggers the AX-paste path → clipboard. We just need to confirm
    // ptyWrite is NOT called and emit IS called normally.
    const { routeTranscript } = await import('../output-router');

    const result = routeTranscript('hello world', emit, {
      focusedSessionId: 's1',
      injectToPane: false,
      ptyWrite,
    });

    expect(ptyWrite).not.toHaveBeenCalled();
    // On non-darwin or when mac ext is unavailable the result will be
    // clipboard / ax-paste. We just need it NOT to be focused-pty.
    expect(result.target).not.toBe('focused-pty');
  });

  it('falls through when focusedSessionId is null even if injectToPane=true', async () => {
    const { routeTranscript } = await import('../output-router');

    const result = routeTranscript('hello world', emit, {
      focusedSessionId: null,
      injectToPane: true,
      ptyWrite,
    });

    expect(ptyWrite).not.toHaveBeenCalled();
    expect(result.target).not.toBe('focused-pty');
  });

  it('falls through when ptyWrite is not provided', async () => {
    const { routeTranscript } = await import('../output-router');

    const result = routeTranscript('hello world', emit, {
      focusedSessionId: 's1',
      injectToPane: true,
      // no ptyWrite
    });

    expect(result.target).not.toBe('focused-pty');
  });

  it('returns clipboard for empty transcript regardless of options', async () => {
    const { routeTranscript } = await import('../output-router');

    const result = routeTranscript('   ', emit, {
      focusedSessionId: 's1',
      injectToPane: true,
      ptyWrite,
    });

    expect(ptyWrite).not.toHaveBeenCalled();
    expect(result.target).toBe('clipboard');
  });
});
