// @vitest-environment jsdom
//
// W-4 Phase 4 — PaneShell scratch-tab RTL coverage.
//
// Invariants tested:
//   1. ZERO-SUBTAB: with no scratch tabs, no tab strip renders (regression guard).
//   2. Cmd+T (macOS) fires spawnScratch → tab strip appears + scratch tab added.
//   3. Close (×) button on a scratch tab fires killScratch + removes the tab.
//   4. When the last scratch tab is closed, the tab strip disappears again.
//   5. Switching between tabs changes the active tab highlight.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, act } from '@testing-library/react';
import type { AgentSession } from '@/shared/types';

// ---- mocks ---------------------------------------------------------------

const spawnScratchMock = vi.fn();
const killScratchMock = vi.fn();
const revealInFolderMock = vi.fn();
const openShellMock = vi.fn();
const ptyWriteMock = vi.fn().mockResolvedValue(undefined);
const toastWarningMock = vi.fn();

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    pty: {
      spawnScratch: (...args: unknown[]) => spawnScratchMock(...args),
      killScratch: (...args: unknown[]) => killScratchMock(...args),
      write: (...args: unknown[]) => ptyWriteMock(...args),
    },
    app: {
      revealInFolder: (...args: unknown[]) => revealInFolderMock(...args),
      openShell: (...args: unknown[]) => openShellMock(...args),
    },
    // FEAT-4 — PaneShell reads the pty.promptCards gate on mount. Default OFF
    // (null) so the prompt-card feature stays inert in these scratch-tab tests.
    kv: {
      get: vi.fn().mockResolvedValue(null),
    },
  },
}));

// FEAT-4 — the prompt-card hook + overlay are exercised in their own specs
// (use-prompt-card.test.ts / PromptCard.test.tsx). Stub them here so these
// scratch-tab tests aren't coupled to the PTY-scanning machinery.
vi.mock('./use-prompt-card', () => ({
  usePromptCard: () => ({ prompt: null, answer: vi.fn(), dismiss: vi.fn() }),
}));

vi.mock('./PromptCard', () => ({
  PromptCard: () => null,
}));

vi.mock('sonner', () => ({
  toast: {
    warning: (...args: unknown[]) => toastWarningMock(...args),
    error: vi.fn(),
    success: vi.fn(),
  },
}));

// Stub Terminal so we don't need xterm + ResizeObserver machinery.
vi.mock('./Terminal', () => ({
  SessionTerminal: ({ sessionId, className }: { sessionId: string; className?: string }) => (
    <div data-testid={`terminal-${sessionId}`} className={className}>
      terminal:{sessionId}
    </div>
  ),
}));

vi.mock('./PaneSplash', () => ({
  PaneSplash: () => null,
}));

vi.mock('./PaneFooter', () => ({
  PaneFooter: () => null,
}));

vi.mock('./PaneHeader', () => ({
  PaneHeader: () => <div data-testid="pane-header" />,
}));

vi.mock('@/renderer/lib/path-relative', () => ({
  pathRelative: (abs: string) => abs,
}));

vi.mock('@/renderer/features/skills/SkillsTab', () => ({
  SKILL_DRAG_MIME: 'application/sigmalink-skill',
}));

vi.mock('@/renderer/features/skills/SkillBindingChip', () => ({
  SkillBindingChip: () => null,
}));

beforeEach(() => {
  spawnScratchMock.mockReset();
  killScratchMock.mockReset();
  ptyWriteMock.mockReset();
  toastWarningMock.mockReset();
  // Default: spawnScratch resolves with a fresh id each time.
  let counter = 0;
  spawnScratchMock.mockImplementation(() =>
    Promise.resolve({ scratchId: `scratch-${++counter}` }),
  );
  killScratchMock.mockResolvedValue(undefined);

  if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserver;
  }
  // Ensure Radix portals don't blow up in jsdom.
  const proto = Element.prototype as unknown as {
    hasPointerCapture?: (id: number) => boolean;
    scrollIntoView?: () => void;
  };
  if (!proto.hasPointerCapture) proto.hasPointerCapture = () => false;
  if (!proto.scrollIntoView) proto.scrollIntoView = () => undefined;

  // Stub window.sigma.getPathForFile for drag-drop paths (not under test here).
  Object.defineProperty(window, 'sigma', {
    value: { getPathForFile: () => null, invoke: vi.fn() },
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: 'main-session',
    workspaceId: 'ws-1',
    providerId: 'claude',
    cwd: '/tmp/ws-1',
    branch: null,
    status: 'running',
    startedAt: 0,
    worktreePath: '/tmp/ws-1/worktree',
    ...overrides,
  };
}

async function renderPaneShell(session: AgentSession = makeSession()) {
  const { PaneShell } = await import('./PaneShell');
  return render(
    <PaneShell
      session={session}
      paneIndex={0}
      providers={[{ id: 'claude', name: 'Claude' }]}
      workspaceRootPath="/tmp/ws-1"
      onFocus={vi.fn()}
      onRemove={vi.fn()}
      onStop={vi.fn()}
      onSplit={vi.fn()}
      onToggleMinimise={vi.fn()}
      isFullscreen={false}
      onToggleFullscreen={vi.fn()}
    />,
  );
}

// ---------------------------------------------------------------------------
// 1. ZERO-SUBTAB INVARIANT
// ---------------------------------------------------------------------------
describe('PaneShell — zero-subtab invariant', () => {
  it('renders no tab strip when there are no scratch tabs', async () => {
    await renderPaneShell();
    expect(screen.queryByTestId('pane-tab-strip')).toBeNull();
  });

  it('renders the main session terminal with no extra wrapper style when there are no scratch tabs', async () => {
    await renderPaneShell();
    // Main terminal is present and NOT hidden.
    const mainTerminal = screen.getByTestId('terminal-main-session');
    // The wrapping div should not have display:none when no scratch tabs exist.
    // In the zero-subtab path activeTabId === session.id so the wrapping div
    // has no display:none style (style attribute is either null or does not
    // contain display:none).
    const wrapper = mainTerminal.parentElement;
    const style = wrapper?.getAttribute('style') ?? '';
    expect(style).not.toContain('display: none');
  });
});

// ---------------------------------------------------------------------------
// 2. Cmd+T opens a scratch tab
// ---------------------------------------------------------------------------
describe('PaneShell — Cmd+T opens scratch tab', () => {
  it('tab strip appears after Cmd+T and a scratch terminal is mounted', async () => {
    const { container } = await renderPaneShell();

    // No tab strip yet.
    expect(screen.queryByTestId('pane-tab-strip')).toBeNull();

    // Fire a Cmd+T keydown event targeting a node INSIDE the pane container.
    const paneContainer = container.firstElementChild as HTMLElement;
    await act(async () => {
      fireEvent.keyDown(paneContainer, {
        key: 't',
        metaKey: true,
        shiftKey: false,
        ctrlKey: false,
        bubbles: true,
      });
      // Wait for the async spawnScratch to resolve.
      await Promise.resolve();
    });

    // spawnScratch should have been called.
    expect(spawnScratchMock).toHaveBeenCalledTimes(1);
    expect(spawnScratchMock).toHaveBeenCalledWith({ cwd: '/tmp/ws-1/worktree' });

    // Tab strip should now be visible.
    expect(screen.queryByTestId('pane-tab-strip')).toBeTruthy();

    // A scratch terminal should be mounted.
    expect(screen.queryByTestId('terminal-scratch-1')).toBeTruthy();
  });

  it('Cmd+T uses session.cwd when worktreePath is null', async () => {
    const session = makeSession({ worktreePath: null, cwd: '/tmp/fallback' });
    const { container } = await renderPaneShell(session);

    const paneContainer = container.firstElementChild as HTMLElement;
    await act(async () => {
      fireEvent.keyDown(paneContainer, {
        key: 't',
        metaKey: true,
        bubbles: true,
      });
      await Promise.resolve();
    });

    expect(spawnScratchMock).toHaveBeenCalledWith({ cwd: '.' });
  });
});

// ---------------------------------------------------------------------------
// 3. Close (×) button fires killScratch + removes tab
// ---------------------------------------------------------------------------
describe('PaneShell — close scratch tab', () => {
  it('clicking × calls killScratch and removes the tab', async () => {
    const { container } = await renderPaneShell();

    // Open a scratch tab.
    const paneContainer = container.firstElementChild as HTMLElement;
    await act(async () => {
      fireEvent.keyDown(paneContainer, { key: 't', metaKey: true, bubbles: true });
      await Promise.resolve();
    });
    expect(screen.queryByTestId('pane-tab-strip')).toBeTruthy();

    // Click the close button.
    const closeBtn = screen.getByLabelText('Close scratch 1');
    await act(async () => {
      fireEvent.click(closeBtn);
      await Promise.resolve();
    });

    expect(killScratchMock).toHaveBeenCalledWith({ scratchId: 'scratch-1' });
  });

  it('tab strip disappears when the last scratch tab is closed', async () => {
    const { container } = await renderPaneShell();

    const paneContainer = container.firstElementChild as HTMLElement;
    await act(async () => {
      fireEvent.keyDown(paneContainer, { key: 't', metaKey: true, bubbles: true });
      await Promise.resolve();
    });
    expect(screen.queryByTestId('pane-tab-strip')).toBeTruthy();

    const closeBtn = screen.getByLabelText('Close scratch 1');
    await act(async () => {
      fireEvent.click(closeBtn);
      await Promise.resolve();
    });

    // Strip is hidden again.
    expect(screen.queryByTestId('pane-tab-strip')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. Switching tabs changes active tab
// ---------------------------------------------------------------------------
describe('PaneShell — tab switching', () => {
  it('clicking the main tab shows the main terminal and hides the scratch terminal', async () => {
    const { container } = await renderPaneShell();
    const paneContainer = container.firstElementChild as HTMLElement;

    // Open a scratch tab.
    await act(async () => {
      fireEvent.keyDown(paneContainer, { key: 't', metaKey: true, bubbles: true });
      await Promise.resolve();
    });

    // The scratch tab should now be active (scratch-1 terminal NOT hidden).
    const scratchTerminal = screen.getByTestId('terminal-scratch-1');
    expect(scratchTerminal.classList.contains('hidden')).toBe(false);

    // Click the main tab.
    const mainTab = screen.getByTestId('pane-tab-main');
    fireEvent.click(mainTab);

    // Main terminal wrapper should be visible: in the multi-tab path the
    // active main wrapper uses `display:contents` (not hidden) so the terminal
    // still fills the pane. (Zero-subtab fast path has no wrapper at all.)
    const mainTerminal = screen.getByTestId('terminal-main-session');
    const wrapper = mainTerminal.parentElement;
    expect(wrapper?.classList.contains('hidden')).toBe(false);
    expect(wrapper?.classList.contains('contents')).toBe(true);

    // Scratch terminal should now be hidden.
    expect(scratchTerminal.classList.contains('hidden')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. v1.13.2 — runtime-crash banner vs ENOENT launch-failure
// ---------------------------------------------------------------------------
describe('PaneShell — v1.13.2 crash banner', () => {
  async function renderWith(session: AgentSession, onRelaunch?: () => void) {
    const { PaneShell } = await import('./PaneShell');
    return render(
      <PaneShell
        session={session}
        paneIndex={0}
        providers={[{ id: 'claude', name: 'Claude' }]}
        workspaceRootPath="/tmp/ws-1"
        onFocus={vi.fn()}
        onRemove={vi.fn()}
        onStop={vi.fn()}
        onSplit={vi.fn()}
        onToggleMinimise={vi.fn()}
        isFullscreen={false}
        onToggleFullscreen={vi.fn()}
        onRelaunch={onRelaunch}
      />,
    );
  }

  it('renders the crash banner + keeps the scrollback terminal mounted for a runtime crash', async () => {
    // Runtime crash: status 'error' + numeric exitCode, NO error string.
    await renderWith(makeSession({ status: 'error', exitCode: 1 }));

    const banner = screen.getByTestId('pane-crash-banner');
    expect(banner.textContent).toContain('Pane crashed (exit 1)');
    // The terminal stays mounted so the user can read the crash output.
    expect(screen.getByTestId('terminal-main-session')).toBeTruthy();
    // It is NOT the ENOENT "Failed to launch" surface.
    expect(screen.queryByText('Failed to launch')).toBeNull();
  });

  it('shows a Relaunch button that fires onRelaunch', async () => {
    const onRelaunch = vi.fn();
    await renderWith(makeSession({ status: 'error', exitCode: 137 }), onRelaunch);

    const btn = screen.getByTestId('pane-relaunch-button');
    fireEvent.click(btn);
    expect(onRelaunch).toHaveBeenCalledTimes(1);
  });

  it('omits the Relaunch button when no handler is wired', async () => {
    await renderWith(makeSession({ status: 'error', exitCode: 2 }));
    expect(screen.queryByTestId('pane-relaunch-button')).toBeNull();
  });

  it('renders "Failed to launch" (no terminal, no crash banner) for an ENOENT launch failure', async () => {
    // Launch failure: status 'error' + error string, NO numeric exitCode.
    await renderWith(makeSession({ status: 'error', error: 'spawn codex ENOENT', exitCode: undefined }));

    expect(screen.getByText('Failed to launch')).toBeTruthy();
    expect(screen.getByText('spawn codex ENOENT')).toBeTruthy();
    // No crash banner and no terminal in the pure launch-failure surface.
    expect(screen.queryByTestId('pane-crash-banner')).toBeNull();
    expect(screen.queryByTestId('terminal-main-session')).toBeNull();
  });

  it('treats a signal-only death (no exitCode, no error string) as a crash with scrollback', async () => {
    // A signal kill has no numeric exitCode and never sets `session.error`.
    // The discriminator is the absent error string → crash surface, with the
    // exit code rendered as "unknown" and the terminal kept mounted.
    await renderWith(makeSession({ status: 'error' }));
    const banner = screen.getByTestId('pane-crash-banner');
    expect(banner.textContent).toContain('Pane crashed (exit unknown)');
    expect(screen.getByTestId('terminal-main-session')).toBeTruthy();
    expect(screen.queryByText('Failed to launch')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. W-5 Phase 3 — skill-drop slash-command injection
// ---------------------------------------------------------------------------

import { SKILL_DRAG_MIME } from '@/renderer/features/skills/SkillsTab';

/** Creates a synthetic drop event with skill MIME data. */
function makeSkillDropEvent(skillName: string, source = 'superpowers'): Partial<DragEvent> & { dataTransfer: DataTransfer } {
  const payload = JSON.stringify({ kind: 'skill', name: skillName, source });
  const map = new Map<string, string>([[SKILL_DRAG_MIME, payload]]);
  return {
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    dataTransfer: {
      getData: (key: string) => map.get(key) ?? '',
      setData: vi.fn(),
      types: [SKILL_DRAG_MIME],
      files: [] as unknown as FileList,
      items: [] as unknown as DataTransferItemList,
      dropEffect: 'copy' as DataTransfer['dropEffect'],
      effectAllowed: 'all' as DataTransfer['effectAllowed'],
      clearData: vi.fn(),
    } as unknown as DataTransfer,
  };
}

describe('PaneShell — W-5 Phase 3 skill-drop injection', () => {
  it('writes "/<skillName> " to PTY when provider is claude and pane is running', async () => {
    const onSkillDrop = vi.fn();
    const { PaneShell } = await import('./PaneShell');
    render(
      <PaneShell
        session={makeSession({ providerId: 'claude', status: 'running' })}
        paneIndex={0}
        providers={[{ id: 'claude', name: 'Claude' }]}
        workspaceRootPath="/tmp/ws-1"
        onFocus={vi.fn()}
        onRemove={vi.fn()}
        onStop={vi.fn()}
        onSplit={vi.fn()}
        onToggleMinimise={vi.fn()}
        isFullscreen={false}
        onToggleFullscreen={vi.fn()}
        onSkillDrop={onSkillDrop}
      />,
    );

    const paneBody = screen.getByTestId('pane-body');
    await act(async () => {
      fireEvent.drop(paneBody, makeSkillDropEvent('code-review'));
      await Promise.resolve();
    });

    expect(ptyWriteMock).toHaveBeenCalledWith('main-session', '/code-review ');
    expect(onSkillDrop).toHaveBeenCalledWith('code-review', 'superpowers');
  });

  it('writes "/<skillName> " to PTY when provider is codex', async () => {
    const { PaneShell } = await import('./PaneShell');
    render(
      <PaneShell
        session={makeSession({ providerId: 'codex', status: 'running' })}
        paneIndex={0}
        providers={[{ id: 'codex', name: 'Codex' }]}
        workspaceRootPath="/tmp/ws-1"
        onFocus={vi.fn()}
        onRemove={vi.fn()}
        onStop={vi.fn()}
        onSplit={vi.fn()}
        onToggleMinimise={vi.fn()}
        isFullscreen={false}
        onToggleFullscreen={vi.fn()}
      />,
    );

    const paneBody = screen.getByTestId('pane-body');
    await act(async () => {
      fireEvent.drop(paneBody, makeSkillDropEvent('debug-mode'));
      await Promise.resolve();
    });

    expect(ptyWriteMock).toHaveBeenCalledWith('main-session', '/debug-mode ');
  });

  it('writes "/<skillName> " to PTY when provider is gemini', async () => {
    const { PaneShell } = await import('./PaneShell');
    render(
      <PaneShell
        session={makeSession({ providerId: 'gemini', status: 'running' })}
        paneIndex={0}
        providers={[{ id: 'gemini', name: 'Gemini' }]}
        workspaceRootPath="/tmp/ws-1"
        onFocus={vi.fn()}
        onRemove={vi.fn()}
        onStop={vi.fn()}
        onSplit={vi.fn()}
        onToggleMinimise={vi.fn()}
        isFullscreen={false}
        onToggleFullscreen={vi.fn()}
      />,
    );

    const paneBody = screen.getByTestId('pane-body');
    await act(async () => {
      fireEvent.drop(paneBody, makeSkillDropEvent('optimize'));
      await Promise.resolve();
    });

    expect(ptyWriteMock).toHaveBeenCalledWith('main-session', '/optimize ');
  });

  it('does NOT inject for kimi provider and shows a toast', async () => {
    const onSkillDrop = vi.fn();
    const { PaneShell } = await import('./PaneShell');
    render(
      <PaneShell
        session={makeSession({ providerId: 'kimi', status: 'running' })}
        paneIndex={0}
        providers={[{ id: 'kimi', name: 'Kimi' }]}
        workspaceRootPath="/tmp/ws-1"
        onFocus={vi.fn()}
        onRemove={vi.fn()}
        onStop={vi.fn()}
        onSplit={vi.fn()}
        onToggleMinimise={vi.fn()}
        isFullscreen={false}
        onToggleFullscreen={vi.fn()}
        onSkillDrop={onSkillDrop}
      />,
    );

    const paneBody = screen.getByTestId('pane-body');
    await act(async () => {
      fireEvent.drop(paneBody, makeSkillDropEvent('review'));
      await Promise.resolve();
    });

    // No PTY write for unsupported provider.
    expect(ptyWriteMock).not.toHaveBeenCalled();
    // Toast shown explaining the limitation.
    expect(toastWarningMock).toHaveBeenCalledOnce();
    expect(toastWarningMock.mock.calls[0][0]).toContain('kimi');
    // Chip binding still called.
    expect(onSkillDrop).toHaveBeenCalledWith('review', 'superpowers');
  });

  it('does NOT inject for opencode provider and shows a toast', async () => {
    const { PaneShell } = await import('./PaneShell');
    render(
      <PaneShell
        session={makeSession({ providerId: 'opencode', status: 'running' })}
        paneIndex={0}
        providers={[{ id: 'opencode', name: 'OpenCode' }]}
        workspaceRootPath="/tmp/ws-1"
        onFocus={vi.fn()}
        onRemove={vi.fn()}
        onStop={vi.fn()}
        onSplit={vi.fn()}
        onToggleMinimise={vi.fn()}
        isFullscreen={false}
        onToggleFullscreen={vi.fn()}
      />,
    );

    const paneBody = screen.getByTestId('pane-body');
    await act(async () => {
      fireEvent.drop(paneBody, makeSkillDropEvent('brainstorm'));
      await Promise.resolve();
    });

    expect(ptyWriteMock).not.toHaveBeenCalled();
    expect(toastWarningMock).toHaveBeenCalledOnce();
    expect(toastWarningMock.mock.calls[0][0]).toContain('opencode');
  });

  it('shows "pane not running" toast (not PTY write) when claude pane is exited', async () => {
    const { PaneShell } = await import('./PaneShell');
    render(
      <PaneShell
        session={makeSession({ providerId: 'claude', status: 'exited' })}
        paneIndex={0}
        providers={[{ id: 'claude', name: 'Claude' }]}
        workspaceRootPath="/tmp/ws-1"
        onFocus={vi.fn()}
        onRemove={vi.fn()}
        onStop={vi.fn()}
        onSplit={vi.fn()}
        onToggleMinimise={vi.fn()}
        isFullscreen={false}
        onToggleFullscreen={vi.fn()}
      />,
    );

    const paneBody = screen.getByTestId('pane-body');
    await act(async () => {
      fireEvent.drop(paneBody, makeSkillDropEvent('review'));
      await Promise.resolve();
    });

    expect(ptyWriteMock).not.toHaveBeenCalled();
    expect(toastWarningMock).toHaveBeenCalledOnce();
  });
});
