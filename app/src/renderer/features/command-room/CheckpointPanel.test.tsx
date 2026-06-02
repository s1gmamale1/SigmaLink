// @vitest-environment jsdom
//
// P6 FEAT-11 — CheckpointPanel coverage.
//
// Asserts:
//   - lists checkpoints from rpc.git.listCheckpoints (sha short + label + kind)
//   - empty state when there are none
//   - "Create checkpoint" calls rpc.git.createCheckpoint then refreshes
//   - "Restore" is confirm-gated: clicking Restore opens the AlertDialog and
//     does NOT call restoreCheckpoint until the dialog's Restore is confirmed;
//     cancelling never calls it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { SessionCheckpoint } from '@/shared/types';

const listMock = vi.fn<(sessionId: string) => Promise<SessionCheckpoint[]>>();
const createMock = vi.fn();
const restoreMock = vi.fn();
const onEventMock = vi.fn<(name: string, cb: (p: unknown) => void) => () => void>();

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    git: {
      listCheckpoints: (...a: [string]) => listMock(...a),
      createCheckpoint: (...a: unknown[]) => createMock(...a),
      restoreCheckpoint: (...a: unknown[]) => restoreMock(...a),
    },
  },
  onEvent: (...a: [string, (p: unknown) => void]) => onEventMock(...a),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { CheckpointPanel } from './CheckpointPanel';

const SAMPLE: SessionCheckpoint[] = [
  { id: 'c2', sessionId: 's1', sha: 'beefbeefcafe', label: 'after tests', kind: 'manual', createdAt: Date.now() - 60_000 },
  { id: 'c1', sessionId: 's1', sha: 'deadbeef0000', label: 'pre-rewind', kind: 'auto', createdAt: Date.now() - 3_600_000 },
];

beforeEach(() => {
  vi.clearAllMocks();
  listMock.mockResolvedValue(SAMPLE);
  createMock.mockResolvedValue(SAMPLE[0]);
  restoreMock.mockResolvedValue({ ok: true, safetySha: 'newsafety' });
  onEventMock.mockReturnValue(() => undefined);
});

afterEach(() => cleanup());

async function renderPanel() {
  await act(async () => {
    render(<CheckpointPanel sessionId="s1" />);
  });
}

describe('CheckpointPanel', () => {
  it('lists checkpoints with short sha, label, and an auto badge', async () => {
    await renderPanel();
    await waitFor(() => expect(screen.getByTestId('checkpoint-list')).toBeTruthy());
    expect(listMock).toHaveBeenCalledWith('s1');
    expect(screen.getByText('after tests')).toBeTruthy();
    // short sha (first 8 chars) is rendered
    expect(screen.getByText('beefbeef')).toBeTruthy();
    // the auto checkpoint shows an "auto" badge
    expect(screen.getByText('auto')).toBeTruthy();
    expect(screen.getAllByTestId('checkpoint-row')).toHaveLength(2);
  });

  it('shows an empty state when there are no checkpoints', async () => {
    listMock.mockResolvedValue([]);
    await renderPanel();
    await waitFor(() => expect(screen.getByTestId('checkpoint-empty')).toBeTruthy());
  });

  it('Create checkpoint calls the RPC then refreshes the list', async () => {
    await renderPanel();
    await waitFor(() => expect(screen.getByTestId('checkpoint-list')).toBeTruthy());
    expect(listMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.click(screen.getByTestId('checkpoint-create'));
    });
    expect(createMock).toHaveBeenCalledWith({ sessionId: 's1' });
    // refresh re-fetches the list
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));
  });

  it('Restore is confirm-gated — restore RPC fires only after confirming', async () => {
    await renderPanel();
    await waitFor(() => expect(screen.getByTestId('checkpoint-list')).toBeTruthy());

    // Click the first row's Restore → opens the confirm dialog, no RPC yet.
    await act(async () => {
      fireEvent.click(screen.getAllByTestId('checkpoint-restore')[0]);
    });
    expect(restoreMock).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId('checkpoint-confirm')).toBeTruthy());

    // Confirm → restore RPC fires with the row's sha.
    await act(async () => {
      fireEvent.click(screen.getByTestId('checkpoint-confirm-restore'));
    });
    expect(restoreMock).toHaveBeenCalledWith({ sessionId: 's1', sha: 'beefbeefcafe' });
  });

  it('cancelling the confirm dialog never calls restore', async () => {
    await renderPanel();
    await waitFor(() => expect(screen.getByTestId('checkpoint-list')).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getAllByTestId('checkpoint-restore')[0]);
    });
    await waitFor(() => expect(screen.getByTestId('checkpoint-confirm')).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByTestId('checkpoint-confirm-cancel'));
    });
    expect(restoreMock).not.toHaveBeenCalled();
  });

  it('subscribes to git:checkpoints-changed for live refresh', async () => {
    await renderPanel();
    expect(onEventMock).toHaveBeenCalledWith('git:checkpoints-changed', expect.any(Function));
  });
});
