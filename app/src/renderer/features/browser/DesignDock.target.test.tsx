// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

// Fake pane sessions that the state selector will return.
const FAKE_PANES = [
  {
    id: 'S1',
    workspaceId: 'ws-1',
    providerId: 'claude',
    cwd: '/repo',
    branch: 'feat/abc',
    status: 'running' as const,
    startedAt: 1000,
    worktreePath: '/worktrees/feat-abc',
    initialPrompt: undefined,
  },
  {
    id: 'S2',
    workspaceId: 'ws-1',
    providerId: 'gemini',
    cwd: '/repo',
    branch: 'feat/xyz',
    status: 'running' as const,
    startedAt: 2000,
    worktreePath: '/worktrees/feat-xyz',
    initialPrompt: undefined,
  },
];

// Mock rpc — must be hoisted.
vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    design: {
      dispatch: vi.fn().mockResolvedValue({ routedTo: 'S1' }),
    },
    git: {
      diff: vi.fn().mockResolvedValue({ stat: '', patches: 'diff --git a/foo.ts...', untrackedFiles: [] }),
    },
    kv: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
    },
  },
  onEvent: vi.fn().mockReturnValue(() => {}),
}));

// Mock state selector so the component sees our fake panes.
vi.mock('@/renderer/app/state', () => ({
  useAppStateSelector: vi.fn((selector: (s: unknown) => unknown) =>
    selector({
      sessionsByWorkspace: {
        'ws-1': FAKE_PANES,
      },
    }),
  ),
}));

// Need @testing-library/react and @testing-library/user-event.
import { DesignDock } from './DesignDock';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('DesignDock — target pane mode (C-13)', () => {
  it('shows "Existing pane" mode toggle button', () => {
    render(<DesignDock workspaceId="ws-1" />);
    expect(screen.getByRole('button', { name: 'Existing pane' })).toBeTruthy();
  });

  it('shows pane picker when "Existing pane" mode is active', () => {
    render(<DesignDock workspaceId="ws-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Existing pane' }));
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    expect(select).toBeTruthy();
    // Both panes should be listed.
    const options = Array.from(select.options).map((o) => o.value);
    expect(options).toContain('S1');
    expect(options).toContain('S2');
  });

  it('hides providers grid in pane mode', () => {
    render(<DesignDock workspaceId="ws-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Existing pane' }));
    // Provider buttons should not be visible.
    expect(screen.queryByRole('button', { name: /Claude/i })).toBeNull();
  });

  it('dispatches with targetSessionId and shows diff', async () => {
    const { rpc } = await import('@/renderer/lib/rpc');

    render(<DesignDock workspaceId="ws-1" />);

    // Switch to pane mode.
    fireEvent.click(screen.getByRole('button', { name: 'Existing pane' }));

    // Select pane S1.
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'S1' } });

    // Enter a prompt.
    const textarea = screen.getByPlaceholderText('Describe the change…') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'make it blue' } });

    // Click dispatch.
    const dispatchBtn = screen.getByRole('button', { name: /Send to pane/i });
    fireEvent.click(dispatchBtn);

    // rpc.design.dispatch should be called with targetSessionId.
    await waitFor(() => {
      expect(rpc.design.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          targetSessionId: 'S1',
          prompt: 'make it blue',
        }),
      );
    });

    // rpc.git.diff should be called with the pane's worktreePath.
    await waitFor(() => {
      expect(rpc.git.diff).toHaveBeenCalledWith('/worktrees/feat-abc');
    });

    // Diff panel should render the returned patches.
    await waitFor(() => {
      const diffEl = screen.getByTestId('design-dock-diff');
      expect(diffEl.textContent).toContain('diff --git a/foo.ts...');
    });
  });

  it('dispatch button is disabled when no pane is selected in pane mode', () => {
    render(<DesignDock workspaceId="ws-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Existing pane' }));

    const textarea = screen.getByPlaceholderText('Describe the change…') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'make it blue' } });

    const dispatchBtn = screen.getByRole('button', { name: /Send to pane/i }) as HTMLButtonElement;
    expect(dispatchBtn.disabled).toBe(true);
  });

  it('does NOT include providers in dispatch call for pane mode', async () => {
    const { rpc } = await import('@/renderer/lib/rpc');

    render(<DesignDock workspaceId="ws-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Existing pane' }));

    const select = screen.getByRole('combobox') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'S1' } });

    const textarea = screen.getByPlaceholderText('Describe the change…') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'test' } });

    fireEvent.click(screen.getByRole('button', { name: /Send to pane/i }));

    await waitFor(() => expect(rpc.design.dispatch).toHaveBeenCalled());

    const callArg = (rpc.design.dispatch as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
    expect(callArg).not.toHaveProperty('providers');
  });

  it('spawn agents mode still calls dispatch with providers', async () => {
    const { rpc } = await import('@/renderer/lib/rpc');
    // Mock for spawn path needs a different return.
    (rpc.design.dispatch as ReturnType<typeof vi.fn>).mockResolvedValue({ dispatched: 1, sessionIds: ['X'] });

    render(<DesignDock workspaceId="ws-1" />);
    // Default mode is agents — no mode switch needed.

    const textarea = screen.getByPlaceholderText('Describe the change…') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'test prompt' } });

    fireEvent.click(screen.getByRole('button', { name: /Dispatch/i }));

    await waitFor(() => expect(rpc.design.dispatch).toHaveBeenCalled());

    const callArg = (rpc.design.dispatch as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
    expect(callArg).toHaveProperty('providers');
    expect(callArg).not.toHaveProperty('targetSessionId');
  });
});
