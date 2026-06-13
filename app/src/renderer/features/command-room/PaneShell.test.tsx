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
import * as terminalCache from '@/renderer/lib/terminal-cache';

// ---- mocks ---------------------------------------------------------------

const spawnScratchMock = vi.fn();
const killScratchMock = vi.fn();
// 2026-06-10 finding 1 — the real scratch-tabs store runs in these tests; it
// imports terminal-cache (destroy) which we stub so xterm never loads here.
// getCached is kept (default undefined) so the existing context-menu Copy/Paste
// tests can still vi.spyOn it.
const destroyTerminalMock = vi.fn();
vi.mock('@/renderer/lib/terminal-cache', () => ({
  destroy: (...args: unknown[]) => destroyTerminalMock(...args),
  getCached: vi.fn(),
}));
const revealInFolderMock = vi.fn();
const openShellMock = vi.fn();
const ptyWriteMock = vi.fn().mockResolvedValue(undefined);
const toastWarningMock = vi.fn();
const worktreeCreateMock = vi.fn();
const openInPaneMock = vi.fn();
const openNewWorkspaceMock = vi.fn();
const stageImageMock = vi.fn();

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
    git: {
      worktreeCreate: (...args: unknown[]) => worktreeCreateMock(...args),
      openInPane: (...args: unknown[]) => openInPaneMock(...args),
    },
    workspaces: {
      openNew: (...args: unknown[]) => openNewWorkspaceMock(...args),
    },
    panes: {
      stageImage: (...args: unknown[]) => stageImageMock(...args),
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

// BSP-G1 — Stub CreateWorktreeModal so PaneShell tests don't depend on Dialog.
const createWorktreeModalOpenChangeMock = vi.fn();
let capturedCreateWorktreeModalProps: { open: boolean; repoRoot: string } | null = null;
vi.mock('./CreateWorktreeModal', () => ({
  CreateWorktreeModal: (props: { open: boolean; onOpenChange: (v: boolean) => void; repoRoot: string }) => {
    capturedCreateWorktreeModalProps = { open: props.open, repoRoot: props.repoRoot };
    createWorktreeModalOpenChangeMock.mockImplementation(props.onOpenChange);
    return props.open ? <div data-testid="create-worktree-modal-stub">modal</div> : null;
  },
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

beforeEach(async () => {
  spawnScratchMock.mockReset();
  killScratchMock.mockReset();
  destroyTerminalMock.mockReset();
  ptyWriteMock.mockReset();
  toastWarningMock.mockReset();
  worktreeCreateMock.mockReset();
  openInPaneMock.mockReset();
  openNewWorkspaceMock.mockReset();
  stageImageMock.mockReset();
  createWorktreeModalOpenChangeMock.mockReset();
  capturedCreateWorktreeModalProps = null;
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

  // 2026-06-10 finding 1 — the scratch store is a module singleton; reset it
  // so tabs from a previous test never leak into the next one.
  const scratchStore = await import('@/renderer/lib/scratch-tabs');
  scratchStore.__resetScratchTabs();
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

  // 2026-06-14 — PANE-SHRINK REFLOW REGRESSION GUARD.
  //
  // Symptom: dragging a divider to NARROW a pane left the terminal text at its
  // old (wider) column count, overflowing the pane and overlapping the divider;
  // it never reflowed, even after release. Renderer-agnostic (xterm, DOM
  // GridView, FlowView all affected) — most visible on a full-screen TUI.
  //
  // Root cause: the terminal area is a flex item in a flex ROW (FEAT-2 added the
  // row at PaneShell:496 so a context sidebar can sit beside the terminal). A
  // flex item defaults to `min-width:auto`, which floors it at its CONTENT's
  // intrinsic width — i.e. the terminal's stamped pixel width. So the box never
  // shrank below the content, the ResizeObserver/runFit never saw a smaller
  // width, and nothing reflowed. A descendant `overflow:hidden` (the DOM
  // presenter container) does NOT relieve this — the flex item ITSELF needs
  // `min-width:0`. Verified in headless Chromium: at a 200px cell the area
  // measured 1872px (floored) without min-w-0 and 200px (shrinks) with it, for
  // both overflow:visible (xterm) and overflow:hidden (DOM) children.
  //
  // jsdom has no layout engine, so this guards the CSS CONTRACT: both the flex
  // row (:496) and the terminal-area flex item (:497) must carry `min-w-0`.
  it('terminal-area flex wrappers carry min-w-0 so a narrowed pane can reflow', async () => {
    await renderPaneShell();
    const paneBody = screen.getByTestId('pane-body');
    const row = paneBody.firstElementChild; // :496 — flex ROW (terminal + sidebar)
    const area = row?.firstElementChild; // :497 — the terminal area flex item
    expect(row?.className).toContain('flex-1');
    expect(row?.className).toContain('min-w-0');
    expect(area?.className).toContain('flex-1');
    expect(area?.className).toContain('min-w-0');
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
// 8. 2026-06-10 finding 1 — scratch lifecycle: remount survival + cache destroy
// ---------------------------------------------------------------------------
describe('PaneShell — scratch tab lifecycle (2026-06-10 finding 1)', () => {
  it('scratch tabs survive an unmount/remount cycle (room/workspace switch)', async () => {
    const first = await renderPaneShell();
    const paneContainer = first.container.firstElementChild as HTMLElement;
    await act(async () => {
      fireEvent.keyDown(paneContainer, { key: 't', metaKey: true, bubbles: true });
      await Promise.resolve();
    });
    expect(screen.queryByTestId('pane-tab-strip')).toBeTruthy();

    // Simulate a room/workspace switch: full unmount, then a fresh mount.
    first.unmount();
    await renderPaneShell();

    // The tab strip and the scratch terminal are back WITHOUT a new spawn.
    expect(screen.queryByTestId('pane-tab-strip')).toBeTruthy();
    expect(screen.queryByTestId('terminal-scratch-1')).toBeTruthy();
    expect(spawnScratchMock).toHaveBeenCalledTimes(1);
  });

  it('closing a scratch tab destroys its cached terminal (finding 1c)', async () => {
    const { container } = await renderPaneShell();
    const paneContainer = container.firstElementChild as HTMLElement;
    await act(async () => {
      fireEvent.keyDown(paneContainer, { key: 't', metaKey: true, bubbles: true });
      await Promise.resolve();
    });
    const closeBtn = screen.getByLabelText('Close scratch 1');
    await act(async () => {
      fireEvent.click(closeBtn);
      await Promise.resolve();
    });
    expect(destroyTerminalMock).toHaveBeenCalledWith('scratch-1');
    expect(killScratchMock).toHaveBeenCalledWith({ scratchId: 'scratch-1' });
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

  it('writes "$<skillName> " to PTY when provider is codex (SMK-3b)', async () => {
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

    expect(ptyWriteMock).toHaveBeenCalledWith('main-session', '$debug-mode '); // SMK-3b: codex uses $ prefix
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

// ---------------------------------------------------------------------------
// 7. BSP-G1/P1/G3 + DEV-W3a — new context menu items
// ---------------------------------------------------------------------------

// Helper: open the context menu on the pane body by firing a contextmenu event,
// then wait for Radix to mount the portal content.
async function openContextMenu() {
  const paneBody = screen.getByTestId('pane-body');
  await act(async () => {
    fireEvent.contextMenu(paneBody);
    await Promise.resolve();
  });
}

describe('PaneShell — BSP-G1/P1/G3/W3a context menu items', () => {
  it('renders ctx-create-worktree, ctx-open-in-pane, and ctx-open-new-workspace items after right-click', async () => {
    await renderPaneShell();
    await openContextMenu();
    // Radix portals attach to document.body.
    expect(document.querySelector('[data-testid="ctx-create-worktree"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="ctx-open-in-pane"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="ctx-open-new-workspace"]')).toBeTruthy();
  });

  it('ctx-open-in-pane is disabled when session.status === "running"', async () => {
    await renderPaneShell(makeSession({ status: 'running' }));
    await openContextMenu();
    const item = document.querySelector('[data-testid="ctx-open-in-pane"]') as HTMLElement | null;
    expect(item).toBeTruthy();
    // Radix ContextMenuItem sets data-disabled="true" or aria-disabled="true" when disabled.
    const isDisabled =
      item!.getAttribute('data-disabled') === 'true' ||
      item!.getAttribute('aria-disabled') === 'true' ||
      (item as HTMLButtonElement).disabled === true;
    expect(isDisabled).toBe(true);
  });

  it('ctx-open-in-pane is enabled when session.status === "exited"', async () => {
    await renderPaneShell(makeSession({ status: 'exited' }));
    await openContextMenu();
    const item = document.querySelector('[data-testid="ctx-open-in-pane"]') as HTMLElement | null;
    expect(item).toBeTruthy();
    const isDisabled =
      item!.getAttribute('data-disabled') === 'true' ||
      item!.getAttribute('aria-disabled') === 'true';
    expect(isDisabled).toBe(false);
  });

  it('clicking ctx-create-worktree opens the CreateWorktreeModal', async () => {
    await renderPaneShell();
    await openContextMenu();
    const item = document.querySelector('[data-testid="ctx-create-worktree"]') as HTMLElement;
    expect(item).toBeTruthy();
    await act(async () => {
      fireEvent.click(item);
      await Promise.resolve();
    });
    // The stub modal should now be rendered with open=true.
    expect(screen.queryByTestId('create-worktree-modal-stub')).toBeTruthy();
  });

  it('CreateWorktreeModal receives the workspaceRootPath as repoRoot', async () => {
    await renderPaneShell();
    // The CreateWorktreeModal stub captures props on every render.
    // Even when closed (open=false), the component is mounted and props are captured.
    expect(capturedCreateWorktreeModalProps?.repoRoot).toBe('/tmp/ws-1');
  });
});

// ---------------------------------------------------------------------------
// 8. Spec 2026-06-10 (C) — right-click Copy/Paste + copy-on-select
// ---------------------------------------------------------------------------

describe('pane context-menu Copy/Paste (spec 2026-06-10 C)', () => {
  it('Copy writes the xterm selection to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText, readText: vi.fn().mockResolvedValue('') },
      configurable: true,
    });
    vi.spyOn(terminalCache, 'getCached').mockReturnValue({
      terminal: { hasSelection: () => true, getSelection: () => 'picked text' },
    } as unknown as ReturnType<typeof terminalCache.getCached>);

    await renderPaneShell();
    await openContextMenu();

    const item = document.querySelector('[data-testid="ctx-copy"]') as HTMLElement;
    expect(item).toBeTruthy();
    await act(async () => {
      fireEvent.click(item);
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledWith('picked text');
  });

  it('Paste writes clipboard text to the pane PTY', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(), readText: vi.fn().mockResolvedValue('pasted!') },
      configurable: true,
    });
    vi.spyOn(terminalCache, 'getCached').mockReturnValue({
      terminal: { hasSelection: () => false, getSelection: () => '' },
    } as unknown as ReturnType<typeof terminalCache.getCached>);

    await renderPaneShell();
    await openContextMenu();

    const item = document.querySelector('[data-testid="ctx-paste"]') as HTMLElement;
    expect(item).toBeTruthy();
    await act(async () => {
      fireEvent.click(item);
      await Promise.resolve();
    });

    await vi.waitFor(() => expect(ptyWriteMock).toHaveBeenCalledWith(expect.any(String), 'pasted!'));
  });
});

// ---------------------------------------------------------------------------
// 8b. P1c — per-pane renderer toggle in the context menu
// ---------------------------------------------------------------------------

describe('pane context-menu renderer toggle (P1c)', () => {
  it('offers a renderer toggle that persists + fires the remount event', async () => {
    const { setSessionRendererMode, __resetRendererFlagCache } = await import(
      '@/renderer/lib/renderer-flag'
    );
    __resetRendererFlagCache();
    await setSessionRendererMode('main-session', 'dom'); // warm the peek cache
    const events: string[] = [];
    const onEvt = (ev: Event) =>
      events.push((ev as CustomEvent<{ sessionId?: string }>).detail?.sessionId ?? '');
    window.addEventListener('sigma:renderer-mode-changed', onEvt);
    try {
      await renderPaneShell();
      await openContextMenu();
      const item = document.querySelector('[data-testid="ctx-renderer-toggle"]') as HTMLElement;
      expect(item).toBeTruthy();
      expect(item.textContent).toMatch(/xterm/i); // offers the OTHER mode
      await act(async () => {
        fireEvent.click(item);
        await Promise.resolve();
      });
      await vi.waitFor(() => expect(events).toContain('main-session'));
    } finally {
      window.removeEventListener('sigma:renderer-mode-changed', onEvt);
    }
  });
});

// ---------------------------------------------------------------------------
// 9. Spec 2026-06-10 (B) — image drop staging
// ---------------------------------------------------------------------------

describe('image drop staging (spec 2026-06-10 B)', () => {
  function dropEvent(files: File[]) {
    return {
      dataTransfer: { types: ['Files'], files: files as unknown as FileList, getData: () => '' } as unknown as DataTransfer,
      preventDefault: () => undefined,
    };
  }

  it('stages an image on a claude pane and injects the ABSOLUTE @path', async () => {
    stageImageMock.mockResolvedValue({ absPath: '/tmp/staged/img.png' });

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
      />,
    );

    const bytes = new Uint8Array([1, 2, 3]);
    const file = new File([bytes], 'shot.png', { type: 'image/png' });
    // jsdom may not implement arrayBuffer — stub it if missing
    if (typeof file.arrayBuffer !== 'function') {
      Object.defineProperty(file, 'arrayBuffer', {
        value: () => Promise.resolve(bytes.buffer),
      });
    }

    fireEvent.drop(screen.getByTestId('pane-body'), dropEvent([file]));

    await vi.waitFor(() =>
      expect(stageImageMock).toHaveBeenCalledWith(expect.objectContaining({ ext: 'png' })),
    );
    // insertMention writes '@<absPath> ' via rpc.pty.write
    await vi.waitFor(() =>
      expect(ptyWriteMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('/tmp/staged/img.png'),
      ),
    );
  });

  it('keeps the relative path-mention for an image on a NON-image provider (shell)', async () => {
    // Override getPathForFile to return a real abs path for this test
    Object.defineProperty(window, 'sigma', {
      value: { getPathForFile: () => '/abs/shot.png', invoke: vi.fn() },
      writable: true,
      configurable: true,
    });

    const { PaneShell } = await import('./PaneShell');
    render(
      <PaneShell
        session={makeSession({ providerId: 'shell', status: 'running' })}
        paneIndex={0}
        providers={[{ id: 'shell', name: 'Shell' }]}
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

    const file = new File([new Uint8Array([1])], 'shot.png', { type: 'image/png' });
    fireEvent.drop(screen.getByTestId('pane-body'), dropEvent([file]));

    await Promise.resolve();
    expect(stageImageMock).not.toHaveBeenCalled();
    // Existing relative-mention path is taken via getPathForFile
  });

  it('keeps the path-mention for a NON-image file on a claude pane', async () => {
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
      />,
    );

    const file = new File(['hi'], 'notes.txt', { type: 'text/plain' });
    fireEvent.drop(screen.getByTestId('pane-body'), dropEvent([file]));

    await Promise.resolve();
    expect(stageImageMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 10. Spec 2026-06-10 (B) — image paste interception
// ---------------------------------------------------------------------------

describe('image paste interception (spec 2026-06-10 B)', () => {
  function pasteEvent(items: Array<{ kind: string; type: string; file: File | null }>, target: Node) {
    const e = new Event('paste', { bubbles: true }) as ClipboardEvent;
    Object.defineProperty(e, 'clipboardData', {
      value: { items: items.map((it) => ({ kind: it.kind, type: it.type, getAsFile: () => it.file })) },
    });
    Object.defineProperty(e, 'target', { value: target });
    return e;
  }

  it('stages a pasted image on a running claude pane (and prevents default)', async () => {
    stageImageMock.mockResolvedValue({ absPath: '/tmp/staged/clip.png' });

    const { container } = await renderPaneShell();

    const file = new File([new Uint8Array([9])], 'clip.png', { type: 'image/png' });
    // jsdom may not implement arrayBuffer — stub it if missing
    if (typeof file.arrayBuffer !== 'function') {
      Object.defineProperty(file, 'arrayBuffer', {
        value: () => Promise.resolve(new Uint8Array([9]).buffer),
      });
    }

    // Target a node INSIDE the pane container (mirrors the Cmd+T test pattern)
    const paneContainer = container.firstElementChild as HTMLElement;
    const evt = pasteEvent([{ kind: 'file', type: 'image/png', file }], paneContainer);
    const prevent = vi.spyOn(evt, 'preventDefault');
    act(() => { window.dispatchEvent(evt); });
    await vi.waitFor(() => expect(stageImageMock).toHaveBeenCalled());
    expect(prevent).toHaveBeenCalled();
  });

  it('ignores a text-only paste (xterm keeps handling it)', async () => {
    const { container } = await renderPaneShell();

    const paneContainer = container.firstElementChild as HTMLElement;
    const evt = pasteEvent([{ kind: 'string', type: 'text/plain', file: null }], paneContainer);
    const prevent = vi.spyOn(evt, 'preventDefault');
    act(() => { window.dispatchEvent(evt); });
    await Promise.resolve();
    expect(stageImageMock).not.toHaveBeenCalled();
    expect(prevent).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 2026-06-10 audit, finding 6 — flash-drop timer hygiene
// ---------------------------------------------------------------------------
describe('PaneShell — flash-drop timer hygiene', () => {
  it('clears the 200ms flash reset timer on unmount', async () => {
    vi.useFakeTimers();
    try {
      // worktreePath:null keeps the git-status poller inert so the timer
      // delta below isolates the flash timer.
      const session = makeSession({ worktreePath: null });
      const { unmount } = await renderPaneShell(session);
      await act(async () => {}); // settle mount effects (kv gate read)

      const body = screen.getByTestId('pane-body');
      const before = vi.getTimerCount();
      fireEvent.drop(body, {
        dataTransfer: { types: ['Files'], getData: () => '', files: [] },
      });
      expect(vi.getTimerCount()).toBe(before + 1); // flash reset armed

      unmount();
      // Pre-fix: before + 1 — the 200ms timeout leaked past unmount.
      expect(vi.getTimerCount()).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });
});
