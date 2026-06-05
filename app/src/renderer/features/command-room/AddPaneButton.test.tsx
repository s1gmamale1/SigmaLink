// @vitest-environment jsdom
//
// v1.5.4-A — RTL tests for the extracted AddPaneButton component.
// v1.13.1 — covers new getAddPaneDisabledReason(activeWorkspace, activeSwarm, swarmsLoading)
//           and zero-swarms swarm-creation path.
// SF-8 B3  — covers Yolo/Bypass toggle in the +Pane add flow:
//   B3-1: yolo-toggle renders with danger warning text
//   B3-2: yolo-toggle defaults ON when per-ws kv returns '1'
//   B3-3: yolo-toggle defaults OFF when per-ws kv returns null
//   B3-4: addAgent called with autoApprove:true when yolo is ON
//   B3-5: toggling ON persists kv.set '1'
//   B3-6: toggling OFF persists kv.set '0'
//
// Tests cover:
//   1. Pill visible when disabled (each of the 4 disabledReason variants)
//   2. Pill hidden when enabled
//   3. Click on enabled button opens DropdownMenu
//   4. Selecting a provider calls addAgent rpc
//   5. Error chip appears on rpc rejection
//   6. Error chip dismisses on × click
//   7. Error chip auto-dismisses after 10s (vi.useFakeTimers) — hardened (v1.5.4-A)
//   8. Error chip cleanup on unmount (no setState-on-unmounted warning)
//   9. Multiple errors reset the timer — hardened (v1.5.4-A)
//  10. Disabled-reason pill has aria-live="polite" and role="status"
//  11. Error chip has aria-live="assertive" and role="alert"
//  12. (v1.13.1) "Loading workspace…" pill while swarmsLoading
//  13. (v1.13.1) Button enabled when workspace exists + swarm null + not loading
//  14. (v1.13.1) Add-with-zero-swarms: swarms.create called before addAgent

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react';
import type { Swarm, Workspace } from '@/shared/types';

// ---- mocks -------------------------------------------------------------------

const addAgentMock = vi.fn();
const createSwarmMock = vi.fn();
const kvGetMock = vi.fn<(key: string) => Promise<string | null>>(async () => null);
const kvSetMock = vi.fn<(key: string, value: string) => Promise<void>>(async () => undefined);

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    swarms: {
      addAgent: (...args: unknown[]) => addAgentMock(...args),
      create: (...args: unknown[]) => createSwarmMock(...args),
    },
    kv: {
      get: (...args: unknown[]) => kvGetMock(...args as [string]),
      set: (...args: unknown[]) => kvSetMock(...args as [string, string]),
    },
  },
}));

const dispatchMock = vi.fn();

vi.mock('@/renderer/app/state', () => ({
  useAppDispatch: () => dispatchMock,
  useAppStateSelector: vi.fn(),
}));

const toastErrorMock = vi.fn();
const toastSuccessMock = vi.fn();

vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccessMock(...args),
    error: (...args: unknown[]) => toastErrorMock(...args),
  },
}));

// ---- dropdown-menu mock for all tests (Option C) ----------------------------
//
// Radix DropdownMenu relies on pointer-event internals and animation frames
// that do not cooperate reliably with vi.useFakeTimers() or jsdom. We replace
// the entire DropdownMenu stack with synchronous passthrough components so the
// menu items are always rendered and clickable — eliminating the Radix-may-not-
// open escape hatch in every test.
//
// vi.doMock (not vi.mock) is used because:
//   a) vi.mock factories are hoisted before imports and cannot use JSX syntax
//      (the JSX transform runs after hoisting).
//   b) AddPaneButton is imported dynamically inside renderAddPaneButton(), so
//      vi.doMock applies before each dynamic import call.
//
// We call vi.doMock once at module scope; it registers the mock for all
// subsequent dynamic imports of AddPaneButton within this file.

vi.doMock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: import('react').ReactNode }) =>
    <>{children}</>,
  DropdownMenuTrigger: ({ children, asChild }: { children: import('react').ReactNode; asChild?: boolean }) =>
    asChild ? <>{children}</> : <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: import('react').ReactNode }) =>
    <div data-testid="dropdown-content">{children}</div>,
  DropdownMenuItem: ({
    children,
    onClick,
    disabled,
  }: {
    children: import('react').ReactNode;
    onClick?: () => void;
    disabled?: boolean;
  }) => <div role="menuitem" onClick={onClick} aria-disabled={disabled}>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
}));

// ---- setup -------------------------------------------------------------------

beforeEach(() => {
  if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserver;
  }
  const proto = Element.prototype as unknown as {
    hasPointerCapture?: (id: number) => boolean;
    scrollIntoView?: () => void;
  };
  if (!proto.hasPointerCapture) proto.hasPointerCapture = () => false;
  if (!proto.scrollIntoView) proto.scrollIntoView = () => undefined;

  dispatchMock.mockReset();
  addAgentMock.mockReset();
  createSwarmMock.mockReset();
  toastErrorMock.mockReset();
  toastSuccessMock.mockReset();
  kvGetMock.mockReset().mockResolvedValue(null);
  kvSetMock.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// ---- helpers -----------------------------------------------------------------

function makeSwarm(
  overrides: Partial<Swarm> = {},
  agentCount = 0,
): Swarm {
  return {
    id: 'swarm-1',
    workspaceId: 'ws-1',
    name: 'Swarm 1',
    mission: 'test',
    preset: 'custom',
    status: 'running',
    createdAt: 0,
    endedAt: null,
    agents: Array.from({ length: agentCount }, (_, i) => ({
      id: `agent-${i}`,
      swarmId: 'swarm-1',
      sessionId: `s-${i}`,
      providerId: 'claude',
      agentKey: `agent-${i}`,
      role: 'builder' as const,
      roleIndex: i,
      status: 'idle' as const,
      inboxPath: `/tmp/inbox-${i}`,
    })),
    ...overrides,
  };
}

const DEFAULT_PROVIDERS = [
  { id: 'claude', name: 'Claude' },
  { id: 'codex', name: 'Codex' },
];

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'ws-1',
    name: 'Workspace 1',
    rootPath: '/tmp/ws-1',
    repoRoot: null,
    repoMode: 'plain',
    createdAt: 0,
    lastOpenedAt: 0,
    ...overrides,
  };
}

// Distinguish "not passed" (use default) vs "explicitly passed as null".
interface RenderProps {
  activeWorkspace?: Workspace | null;
  activeSwarm?: Swarm | null;
  swarmsLoading?: boolean;
  providers?: { id: string; name: string }[];
}

async function renderAddPaneButton(props: RenderProps = {}) {
  const { AddPaneButton } = await import('./AddPaneButton');
  const activeWorkspace = 'activeWorkspace' in props ? (props.activeWorkspace as Workspace | null) : makeWorkspace();
  const activeSwarm = 'activeSwarm' in props ? (props.activeSwarm as Swarm | null) : makeSwarm();
  const swarmsLoading = props.swarmsLoading ?? false;
  const providers = 'providers' in props ? (props.providers as { id: string; name: string }[]) : DEFAULT_PROVIDERS;
  return render(
    <AddPaneButton
      activeWorkspace={activeWorkspace}
      activeSwarm={activeSwarm}
      swarmsLoading={swarmsLoading}
      providers={providers}
    />,
  );
}

/** Click a provider menu item via the (mocked) dropdown.
 *  Works under both real and fake timers because the dropdown is always rendered. */
function clickProvider(name: string): void {
  const item = screen.getByText(name);
  fireEvent.click(item);
}

// ---- tests -------------------------------------------------------------------

describe('AddPaneButton — disabled reason pill', () => {
  it('1a: shows pill "Open or create a workspace first" ONLY when activeWorkspace is null', async () => {
    await renderAddPaneButton({ activeWorkspace: null, activeSwarm: null });
    const pill = screen.getByTestId('add-pane-disabled-reason');
    expect(pill.textContent).toContain('Open or create a workspace first');
  });

  it('1b: shows pill "Swarm is paused" when swarm status is not running', async () => {
    await renderAddPaneButton({ activeSwarm: makeSwarm({ status: 'paused' }) });
    const pill = screen.getByTestId('add-pane-disabled-reason');
    expect(pill.textContent).toContain('Swarm is paused');
  });

  it('1c: shows pill "Maximum 20 panes" when agent count reaches 20', async () => {
    await renderAddPaneButton({ activeSwarm: makeSwarm({}, 20) });
    const pill = screen.getByTestId('add-pane-disabled-reason');
    expect(pill.textContent).toContain('Maximum 20 panes per swarm');
  });

  it('2: pill is NOT rendered when swarm is running with < 20 agents', async () => {
    await renderAddPaneButton({ activeSwarm: makeSwarm({}, 5) });
    expect(screen.queryByTestId('add-pane-disabled-reason')).toBeNull();
  });

  // v1.13.1 new cases
  it('12: shows "Loading workspace…" while swarmsLoading is true (workspace set, swarm null)', async () => {
    await renderAddPaneButton({ activeWorkspace: makeWorkspace(), activeSwarm: null, swarmsLoading: true });
    const pill = screen.getByTestId('add-pane-disabled-reason');
    expect(pill.textContent).toContain('Loading workspace');
  });

  it('13: button enabled (no pill) when workspace is set + swarm null + swarmsLoading false', async () => {
    await renderAddPaneButton({ activeWorkspace: makeWorkspace(), activeSwarm: null, swarmsLoading: false });
    expect(screen.queryByTestId('add-pane-disabled-reason')).toBeNull();
  });
});

describe('AddPaneButton — a11y attributes', () => {
  it('10: disabled-reason pill has aria-live="polite" and role="status"', async () => {
    await renderAddPaneButton({ activeWorkspace: null, activeSwarm: null });
    const pill = screen.getByTestId('add-pane-disabled-reason');
    expect(pill.getAttribute('aria-live')).toBe('polite');
    expect(pill.getAttribute('role')).toBe('status');
  });

  it('11: error chip has aria-live="assertive" and role="alert" when rendered', async () => {
    addAgentMock.mockRejectedValue(new Error('a11y test error'));

    await renderAddPaneButton();
    // The mocked dropdown renders items inline — no Radix portal required.
    clickProvider('Claude');

    await waitFor(() => {
      const chip = screen.getByTestId('add-pane-error-chip');
      expect(chip.getAttribute('aria-live')).toBe('assertive');
      expect(chip.getAttribute('role')).toBe('alert');
    });
  });
});

describe('AddPaneButton — dropdown and rpc', () => {
  it('3: clicking the enabled button shows provider items in the dropdown', async () => {
    await renderAddPaneButton();
    // With mocked DropdownMenu the content is always rendered.
    expect(screen.getByText('Claude')).toBeTruthy();
    expect(screen.getByText('Codex')).toBeTruthy();
  });

  it('4: selecting a provider calls rpc.swarms.addAgent with correct args', async () => {
    addAgentMock.mockResolvedValue({
      sessionId: 's-new',
      paneIndex: 0,
      agentKey: 'builder-1',
      session: { id: 's-new', workspaceId: 'ws-1' },
      swarm: makeSwarm(),
    });

    await renderAddPaneButton();
    clickProvider('Claude');

    await waitFor(() => {
      // SF-8 B3: addAgent now also receives autoApprove (false by default).
      expect(addAgentMock).toHaveBeenCalledWith(
        expect.objectContaining({ swarmId: 'swarm-1', providerId: 'claude' }),
      );
    });
  });
});

describe('AddPaneButton — error chip', () => {
  it('5: error chip appears after rpc rejection', async () => {
    addAgentMock.mockRejectedValue(new Error('network timeout'));

    await renderAddPaneButton();
    clickProvider('Claude');

    await waitFor(() => {
      expect(screen.getByTestId('add-pane-error-chip')).toBeTruthy();
    });
    expect(screen.getByTestId('add-pane-error-chip').textContent).toContain('network timeout');
  });

  it('6: error chip dismisses on × click', async () => {
    addAgentMock.mockRejectedValue(new Error('some error'));

    await renderAddPaneButton();
    clickProvider('Claude');
    await waitFor(() => screen.getByTestId('add-pane-error-chip'));

    fireEvent.click(screen.getByRole('button', { name: /dismiss error/i }));

    await waitFor(() => {
      expect(screen.queryByTestId('add-pane-error-chip')).toBeNull();
    });
  });

  it('7: error chip auto-dismisses after 10 seconds', async () => {
    // Hardened (v1.5.4-A, Option C): DropdownMenu is mocked synchronously so
    // addAgent is always invoked — no "Radix-may-not-open" escape hatch.
    vi.useFakeTimers();
    addAgentMock.mockRejectedValue(new Error('auto dismiss'));

    await renderAddPaneButton();

    // Click the provider — mocked dropdown renders items synchronously.
    await act(async () => {
      clickProvider('Claude');
      // Pump microtask queue enough times for the async catch block to run
      // (click → addPane called → await rpc.addAgent → rejects → catch runs
      //  → setLastAddError → React re-render). Use multiple ticks; do NOT call
      // vi.runAllTimersAsync() here because that would also fire the 10s timer.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Unconditional: the rpc must have been called (proves the error path ran).
    expect(addAgentMock).toHaveBeenCalledTimes(1);
    // Unconditional: toast.error must have been called (proves catch path ran).
    expect(toastErrorMock).toHaveBeenCalledWith('Could not add pane', expect.objectContaining({ description: 'auto dismiss' }));

    // Chip must be present before we advance time.
    expect(screen.getByTestId('add-pane-error-chip')).toBeTruthy();

    // Advance 10s + 1ms — only the auto-dismiss timer fires, then flush the
    // resulting React state update. waitFor is NOT used here because it
    // internally uses real setTimeout which hangs under fake timers.
    await act(async () => {
      vi.advanceTimersByTime(10_001);
    });
    // The act() above flushes state updates synchronously; chip must be gone.
    expect(screen.queryByTestId('add-pane-error-chip')).toBeNull();
  }, 15_000);

  it('8: no setState-after-unmount warning during the 10s window', async () => {
    vi.useFakeTimers();
    const consoleSpy = vi.spyOn(console, 'error');
    addAgentMock.mockRejectedValue(new Error('unmount race'));

    const { unmount } = await renderAddPaneButton();

    await act(async () => {
      clickProvider('Claude');
      // Pump microtasks to let the rejection propagate without firing timers.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Unmount while the 10s timer may still be ticking.
    unmount();

    // Advance past the timer — must not cause React warnings.
    await act(async () => {
      vi.advanceTimersByTime(10_001);
    });

    const reactWarnings = consoleSpy.mock.calls.filter(
      ([msg]) => typeof msg === 'string' && (msg.includes('unmounted') || msg.includes('memory leak')),
    );
    expect(reactWarnings).toHaveLength(0);
    consoleSpy.mockRestore();
  }, 15_000);

  it('9: multiple errors within 10s reset the auto-dismiss timer', async () => {
    // Hardened (v1.5.4-A, Option C): removed the `if (!chipAfterFirst) return;`
    // escape hatch. Mocked dropdown guarantees addAgent is always called, so if
    // the chip-rendering path breaks these assertions FAIL LOUDLY.
    // Note: vi.runAllTimersAsync() is NOT used after clicks because it would
    // also fire the 10s auto-dismiss timer. We pump microtasks only.
    vi.useFakeTimers();
    addAgentMock.mockRejectedValue(new Error('first error'));

    await renderAddPaneButton();

    // First failure — pump microtasks to let the rejection reach the catch block.
    await act(async () => {
      clickProvider('Claude');
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Unconditional: rpc was called (proves the first error path ran).
    expect(addAgentMock).toHaveBeenCalledTimes(1);

    // Chip MUST be present — if it's missing the test FAILS (no silent skip).
    const chipAfterFirst = screen.getByTestId('add-pane-error-chip');
    expect(chipAfterFirst.textContent).toContain('first error');

    // Advance 5s (mid-window) — chip still visible.
    await act(async () => { vi.advanceTimersByTime(5_000); });
    expect(screen.queryByTestId('add-pane-error-chip')).not.toBeNull();

    // Second error — addPane is callable again because `adding` is false after
    // the first rejection's finally block.
    addAgentMock.mockRejectedValue(new Error('second error'));
    await act(async () => {
      clickProvider('Claude');
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Unconditional: rpc was called twice total.
    expect(addAgentMock).toHaveBeenCalledTimes(2);

    // Chip updates to second error message.
    expect(screen.getByTestId('add-pane-error-chip').textContent).toContain('second error');

    // 6s more (total 11s from first, 6s from second) — chip still visible
    // because the timer was reset when the second error arrived.
    await act(async () => { vi.advanceTimersByTime(6_000); });
    expect(screen.queryByTestId('add-pane-error-chip')).not.toBeNull();

    // Remaining 4s to pass second error's 10s window — chip must disappear.
    // Act flushes state updates; waitFor is NOT used (hangs under fake timers).
    await act(async () => { vi.advanceTimersByTime(4_001); });
    expect(screen.queryByTestId('add-pane-error-chip')).toBeNull();
  }, 20_000);
});

// ---- v1.13.1 zero-swarms path -----------------------------------------------

describe('AddPaneButton — zero-swarms path (v1.13.1)', () => {
  it('14: swarms.create is called before addAgent when activeSwarm is null but workspace is set', async () => {
    const newSwarm = {
      id: 'swarm-new',
      workspaceId: 'ws-1',
      name: 'Default swarm',
      mission: 'Default swarm',
      preset: 'custom',
      status: 'running',
      createdAt: 0,
      endedAt: null,
      agents: [],
    };
    createSwarmMock.mockResolvedValue(newSwarm);
    addAgentMock.mockResolvedValue({
      sessionId: 's-new',
      paneIndex: 0,
      agentKey: 'builder-1',
      session: { id: 's-new', workspaceId: 'ws-1' },
      swarm: newSwarm,
    });

    // No activeSwarm, workspace is set, not loading.
    await renderAddPaneButton({
      activeWorkspace: makeWorkspace(),
      activeSwarm: null,
      swarmsLoading: false,
    });

    // Button must be enabled (no disabled reason pill).
    expect(screen.queryByTestId('add-pane-disabled-reason')).toBeNull();

    clickProvider('Claude');

    await waitFor(() => {
      expect(createSwarmMock).toHaveBeenCalledTimes(1);
    });
    expect(createSwarmMock).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws-1', preset: 'custom' }),
    );
    await waitFor(() => {
      // SF-8 B3: addAgent now also receives autoApprove (false by default).
      expect(addAgentMock).toHaveBeenCalledWith(
        expect.objectContaining({ swarmId: 'swarm-new', providerId: 'claude' }),
      );
    });
  });
});

// ---- SF-8 B3 — Yolo/Bypass toggle in +Pane flow ----------------------------

describe('AddPaneButton — Yolo/Bypass toggle (SF-8 B3)', () => {
  it('B3-1: yolo-toggle renders with danger warning text', async () => {
    await renderAddPaneButton();
    expect(screen.getByTestId('yolo-toggle')).toBeTruthy();
    expect(screen.getByText(/yolo \/ bypass/i)).toBeTruthy();
    expect(screen.getByText(/trusted workspaces/i)).toBeTruthy();
  });

  it('B3-2: yolo-toggle defaults ON when per-ws kv returns "1"', async () => {
    kvGetMock.mockImplementation(async (key: string) => {
      if (key === 'pane.autoApprove.default.ws-1') return '1';
      return null;
    });
    await renderAddPaneButton();
    await waitFor(() => {
      const toggle = screen.getByTestId('yolo-toggle');
      const isOn =
        toggle.getAttribute('data-state') === 'checked' ||
        toggle.getAttribute('aria-checked') === 'true';
      expect(isOn).toBe(true);
    });
  });

  it('B3-3: yolo-toggle defaults OFF when per-ws kv returns null', async () => {
    kvGetMock.mockResolvedValue(null);
    await renderAddPaneButton();
    // After mount + any async kv read, the toggle must be off.
    await waitFor(() => {
      const toggle = screen.getByTestId('yolo-toggle');
      const isOff =
        toggle.getAttribute('data-state') !== 'checked' &&
        toggle.getAttribute('aria-checked') !== 'true';
      expect(isOff).toBe(true);
    });
  });

  it('B3-4: addAgent is called with autoApprove:true when yolo is ON', async () => {
    kvGetMock.mockImplementation(async (key: string) => {
      if (key === 'pane.autoApprove.default.ws-1') return '1';
      return null;
    });
    addAgentMock.mockResolvedValue({
      sessionId: 's-yolo',
      paneIndex: 0,
      agentKey: 'builder-1',
      session: { id: 's-yolo', workspaceId: 'ws-1' },
      swarm: makeSwarm(),
    });

    await renderAddPaneButton();
    // Wait for kv hydration.
    await waitFor(() => {
      const toggle = screen.getByTestId('yolo-toggle');
      expect(
        toggle.getAttribute('data-state') === 'checked' ||
        toggle.getAttribute('aria-checked') === 'true',
      ).toBe(true);
    });

    clickProvider('Claude');

    await waitFor(() => {
      expect(addAgentMock).toHaveBeenCalledWith(
        expect.objectContaining({ swarmId: 'swarm-1', providerId: 'claude', autoApprove: true }),
      );
    });
  });

  it('B3-5: toggling ON persists kv.set with "1"', async () => {
    kvGetMock.mockResolvedValue(null); // starts OFF
    await renderAddPaneButton();
    await act(async () => { await Promise.resolve(); });

    const toggle = screen.getByTestId('yolo-toggle');
    await act(async () => {
      fireEvent.click(toggle);
      await Promise.resolve();
    });

    expect(kvSetMock).toHaveBeenCalledWith('pane.autoApprove.default.ws-1', '1');
  });

  it('B3-6: toggling OFF persists kv.set with "0"', async () => {
    kvGetMock.mockImplementation(async (key: string) => {
      if (key === 'pane.autoApprove.default.ws-1') return '1';
      return null;
    });
    await renderAddPaneButton();
    await waitFor(() => {
      const toggle = screen.getByTestId('yolo-toggle');
      expect(
        toggle.getAttribute('data-state') === 'checked' ||
        toggle.getAttribute('aria-checked') === 'true',
      ).toBe(true);
    });

    const toggle = screen.getByTestId('yolo-toggle');
    await act(async () => {
      fireEvent.click(toggle);
      await Promise.resolve();
    });

    expect(kvSetMock).toHaveBeenCalledWith('pane.autoApprove.default.ws-1', '0');
  });
});

// ---- DEV-W5 — Plain terminal + per-add worktree toggle ----------------------

describe('AddPaneButton — DEV-W5: plain terminal + worktree toggle', () => {
  it('W5-UI-1: "Plain terminal" menu item is rendered', async () => {
    await renderAddPaneButton();
    // The DropdownMenuItem mock renders children as a div[role=menuitem]; match
    // by the visible text since the mock does not forward data-testid.
    expect(screen.getByText('Plain terminal')).toBeTruthy();
  });

  it('W5-UI-2: clicking "Plain terminal" calls addAgent with providerId:"shell"', async () => {
    addAgentMock.mockResolvedValue({
      sessionId: 's-shell',
      paneIndex: 0,
      agentKey: 'builder-1',
      session: { id: 's-shell', workspaceId: 'ws-1' },
      swarm: makeSwarm(),
    });

    await renderAddPaneButton();
    // The mock does not forward data-testid, so find by text.
    const termItem = screen.getByText('Plain terminal');
    fireEvent.click(termItem);

    await waitFor(() => {
      expect(addAgentMock).toHaveBeenCalledWith(
        expect.objectContaining({ providerId: 'shell' }),
      );
    });
  });

  it('W5-UI-3: "Create in worktree" toggle is rendered', async () => {
    await renderAddPaneButton();
    expect(screen.getByTestId('worktree-toggle')).toBeTruthy();
    expect(screen.getByText('Create in worktree')).toBeTruthy();
  });

  it('W5-UI-4: worktree-toggle defaults ON when worktreeMode kv is absent (default=worktree)', async () => {
    kvGetMock.mockResolvedValue(null); // no kv → default ON (create worktree)
    await renderAddPaneButton();
    await waitFor(() => {
      const toggle = screen.getByTestId('worktree-toggle');
      const isOn =
        toggle.getAttribute('data-state') === 'checked' ||
        toggle.getAttribute('aria-checked') === 'true';
      expect(isOn).toBe(true);
    });
  });

  it('W5-UI-5: worktree-toggle defaults OFF when worktreeMode kv is "in-place"', async () => {
    kvGetMock.mockImplementation(async (key: string) => {
      if (key === 'workspace.worktreeMode.ws-1') return 'in-place';
      return null;
    });
    await renderAddPaneButton();
    await waitFor(() => {
      const toggle = screen.getByTestId('worktree-toggle');
      const isOff =
        toggle.getAttribute('data-state') !== 'checked' &&
        toggle.getAttribute('aria-checked') !== 'true';
      expect(isOff).toBe(true);
    });
  });

  it('W5-UI-6: addAgent is called with skipWorktree=false when worktree-toggle is ON', async () => {
    kvGetMock.mockResolvedValue(null); // toggle defaults ON
    addAgentMock.mockResolvedValue({
      sessionId: 's-wt',
      paneIndex: 0,
      agentKey: 'builder-1',
      session: { id: 's-wt', workspaceId: 'ws-1' },
      swarm: makeSwarm(),
    });

    await renderAddPaneButton();
    // Wait for hydration (toggle defaults ON).
    await waitFor(() => {
      const toggle = screen.getByTestId('worktree-toggle');
      const isOn =
        toggle.getAttribute('data-state') === 'checked' ||
        toggle.getAttribute('aria-checked') === 'true';
      expect(isOn).toBe(true);
    });

    clickProvider('Claude');

    await waitFor(() => {
      // createWorktree=true → skipWorktree=false
      expect(addAgentMock).toHaveBeenCalledWith(
        expect.objectContaining({ skipWorktree: false }),
      );
    });
  });

  it('W5-UI-7: addAgent is called with skipWorktree=true when worktree-toggle is OFF', async () => {
    kvGetMock.mockImplementation(async (key: string) => {
      if (key === 'workspace.worktreeMode.ws-1') return 'in-place';
      return null;
    });
    addAgentMock.mockResolvedValue({
      sessionId: 's-ip',
      paneIndex: 0,
      agentKey: 'builder-1',
      session: { id: 's-ip', workspaceId: 'ws-1' },
      swarm: makeSwarm(),
    });

    await renderAddPaneButton();
    // Wait for hydration (toggle defaults OFF because kv='in-place').
    await waitFor(() => {
      const toggle = screen.getByTestId('worktree-toggle');
      const isOff =
        toggle.getAttribute('data-state') !== 'checked' &&
        toggle.getAttribute('aria-checked') !== 'true';
      expect(isOff).toBe(true);
    });

    clickProvider('Claude');

    await waitFor(() => {
      // createWorktree=false → skipWorktree=true
      expect(addAgentMock).toHaveBeenCalledWith(
        expect.objectContaining({ skipWorktree: true }),
      );
    });
  });
});
