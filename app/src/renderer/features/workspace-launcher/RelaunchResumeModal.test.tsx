// @vitest-environment jsdom
//
// P6 FEAT-1 — RelaunchResumeModal unit tests.
//
// Locks the modal contract:
//   - lists the workspace's panes via panes.listForWorkspace
//   - selecting a subset + Relaunch calls panes.resumeSelected(wsId, [ids])
//   - "Select exited/crashed" picks exactly the non-running rows
//   - the PaneResumeResult is surfaced as a toast
//   - empty state when the workspace has no panes

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import type { AgentSession } from '@/shared/types';
import type { PaneResumeResult } from '@/main/core/pty/resume-launcher';

// ---------------------------------------------------------------------------
// RPC + sonner mocks — installed before the component loads.
// ---------------------------------------------------------------------------

function makeSession(over: Partial<AgentSession> & Pick<AgentSession, 'id'>): AgentSession {
  return {
    workspaceId: 'ws-1',
    providerId: 'claude',
    cwd: '/tmp/project',
    branch: null,
    status: 'running',
    startedAt: Date.now(),
    worktreePath: null,
    ...over,
  };
}

const listForWorkspace = vi.fn<(wsId: string) => Promise<AgentSession[]>>(
  async () => [],
);
const resumeSelected = vi.fn<
  (wsId: string, ids: string[]) => Promise<PaneResumeResult>
>(async () => ({
  workspaceId: 'ws-1',
  resumed: [
    {
      sessionId: 's-aaaaaa',
      providerId: 'claude',
      providerEffective: 'claude',
      externalSessionId: '',
      pid: 123,
    },
  ],
  failed: [],
  skipped: [],
}));

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    panes: {
      listForWorkspace: (wsId: string) => listForWorkspace(wsId),
      resumeSelected: (wsId: string, ids: string[]) => resumeSelected(wsId, ids),
    },
  },
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
  },
}));

import { RelaunchResumeModal } from './RelaunchResumeModal';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  listForWorkspace.mockResolvedValue([]);
});

describe('RelaunchResumeModal', () => {
  it('renders nothing when closed', () => {
    render(
      <RelaunchResumeModal open={false} onOpenChange={vi.fn()} workspaceId="ws-1" />,
    );
    expect(screen.queryByTestId('relaunch-resume-modal')).toBeNull();
    expect(listForWorkspace).not.toHaveBeenCalled();
  });

  it('lists the workspace panes on open', async () => {
    listForWorkspace.mockResolvedValue([
      makeSession({ id: 's-aaaaaa11', providerId: 'claude', status: 'running' }),
      makeSession({ id: 's-bbbbbb22', providerId: 'codex', status: 'exited' }),
    ]);
    render(
      <RelaunchResumeModal open onOpenChange={vi.fn()} workspaceId="ws-1" />,
    );
    await waitFor(() =>
      expect(screen.getByTestId('relaunch-session-list')).toBeTruthy(),
    );
    expect(listForWorkspace).toHaveBeenCalledWith('ws-1');
    expect(screen.getByTestId('relaunch-row-s-aaaaaa11')).toBeTruthy();
    expect(screen.getByTestId('relaunch-row-s-bbbbbb22')).toBeTruthy();
    // short id (first 6 chars) is rendered
    expect(screen.getByText('s-aaaa')).toBeTruthy();
  });

  it('selecting a subset + Relaunch calls resumeSelected(wsId, [chosen ids])', async () => {
    const onOpenChange = vi.fn();
    listForWorkspace.mockResolvedValue([
      makeSession({ id: 's-aaaaaa11', status: 'running' }),
      makeSession({ id: 's-bbbbbb22', status: 'exited' }),
    ]);
    render(
      <RelaunchResumeModal open onOpenChange={onOpenChange} workspaceId="ws-1" />,
    );
    await waitFor(() => screen.getByTestId('relaunch-session-list'));

    // Tick only the second row.
    fireEvent.click(screen.getByTestId('relaunch-checkbox-s-bbbbbb22'));

    const confirm = screen.getByTestId('relaunch-confirm') as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
    expect(confirm.textContent).toContain('(1)');

    fireEvent.click(confirm);

    await waitFor(() => expect(resumeSelected).toHaveBeenCalledTimes(1));
    expect(resumeSelected).toHaveBeenCalledWith('ws-1', ['s-bbbbbb22']);
    // Toast fired with the result summary; modal closed.
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('"Select exited/crashed" picks exactly the non-running rows', async () => {
    listForWorkspace.mockResolvedValue([
      makeSession({ id: 's-running1', status: 'running' }),
      makeSession({ id: 's-exited22', status: 'exited' }),
      makeSession({ id: 's-error333', status: 'error' }),
    ]);
    render(
      <RelaunchResumeModal open onOpenChange={vi.fn()} workspaceId="ws-1" />,
    );
    await waitFor(() => screen.getByTestId('relaunch-session-list'));

    fireEvent.click(screen.getByTestId('relaunch-select-exited'));

    // Confirm label reflects 2 selected (exited + error, NOT running).
    expect(
      (screen.getByTestId('relaunch-confirm') as HTMLButtonElement).textContent,
    ).toContain('(2)');

    fireEvent.click(screen.getByTestId('relaunch-confirm'));
    await waitFor(() => expect(resumeSelected).toHaveBeenCalledTimes(1));
    const [, ids] = resumeSelected.mock.calls[0]!;
    expect([...ids].sort()).toEqual(['s-error333', 's-exited22']);
  });

  it('surfaces a failure toast when resumeSelected reports failures', async () => {
    listForWorkspace.mockResolvedValue([
      makeSession({ id: 's-exited22', status: 'exited' }),
    ]);
    resumeSelected.mockResolvedValueOnce({
      workspaceId: 'ws-1',
      resumed: [],
      failed: [
        {
          sessionId: 's-exited22',
          providerId: 'claude',
          externalSessionId: '',
          error: 'spawn failed',
        },
      ],
      skipped: [],
    });
    render(
      <RelaunchResumeModal open onOpenChange={vi.fn()} workspaceId="ws-1" />,
    );
    await waitFor(() => screen.getByTestId('relaunch-session-list'));
    fireEvent.click(screen.getByTestId('relaunch-checkbox-s-exited22'));
    fireEvent.click(screen.getByTestId('relaunch-confirm'));
    await waitFor(() => expect(toastError).toHaveBeenCalled());
  });

  it('shows the empty state when the workspace has no panes', async () => {
    listForWorkspace.mockResolvedValue([]);
    render(
      <RelaunchResumeModal open onOpenChange={vi.fn()} workspaceId="ws-1" />,
    );
    await waitFor(() => expect(screen.getByTestId('relaunch-empty')).toBeTruthy());
    // Confirm button is disabled with nothing to select.
    expect(
      (screen.getByTestId('relaunch-confirm') as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('does not query when no workspace is active', () => {
    render(
      <RelaunchResumeModal open onOpenChange={vi.fn()} workspaceId={null} />,
    );
    expect(listForWorkspace).not.toHaveBeenCalled();
  });
});
