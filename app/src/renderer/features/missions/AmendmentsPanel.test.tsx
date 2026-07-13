// @vitest-environment jsdom
//
// P2 Task 8 — AmendmentsPanel: fetch-on-mount, badge count, row content,
// Approve/Deny → jorvis.amendmentsDecide, and refetch on
// 'jorvis:amendments-changed'. Mirrors use-missions.test.ts's vi.hoisted
// rpc/onEvent mock harness combined with MissionBoard.test.tsx's
// render/screen/within/cleanup harness (query by role/testid).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { JorvisAmendment } from '@/shared/types';

const mocks = vi.hoisted(() => ({
  amendmentsList: vi.fn(),
  amendmentsDecide: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: { error: (...args: unknown[]) => mocks.toastError(...args) },
}));

type EventCb = (payload: unknown) => void;
const handlers = new Map<string, Set<EventCb>>();
function emitEvent(name: string, payload?: unknown): void {
  handlers.get(name)?.forEach((fn) => fn(payload));
}

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    jorvis: {
      amendmentsList: (...args: unknown[]) => mocks.amendmentsList(...args),
      amendmentsDecide: (...args: unknown[]) => mocks.amendmentsDecide(...args),
    },
  },
  onEvent: (name: string, cb: EventCb) => {
    let set = handlers.get(name);
    if (!set) {
      set = new Set();
      handlers.set(name, set);
    }
    set.add(cb);
    return () => {
      set!.delete(cb);
    };
  },
}));

import { AmendmentsPanel } from './AmendmentsPanel';

function amendment(id: string, overrides: Partial<JorvisAmendment> = {}): JorvisAmendment {
  return {
    id,
    text: `Amendment ${id}`,
    rationale: null,
    status: 'proposed',
    decisionReason: null,
    proposedAt: 1,
    decidedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  handlers.clear();
  mocks.amendmentsList.mockResolvedValue([]);
  mocks.amendmentsDecide.mockResolvedValue({});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('AmendmentsPanel', () => {
  it('renders nothing when the review queue is empty', async () => {
    render(<AmendmentsPanel />);
    await waitFor(() => expect(mocks.amendmentsList).toHaveBeenCalled());
    expect(screen.queryByTestId('amendments-panel')).toBeNull();
  });

  it('fetches PROPOSED amendments on mount and shows a badge count', async () => {
    mocks.amendmentsList.mockResolvedValue([amendment('a1'), amendment('a2')]);
    render(<AmendmentsPanel />);
    await waitFor(() => expect(screen.getByTestId('amendments-panel')).toBeTruthy());
    expect(mocks.amendmentsList).toHaveBeenCalledWith({ status: 'proposed' });
    expect(screen.getByTestId('amendments-badge').textContent).toBe('2');
  });

  it('renders text and rationale for each proposed amendment', async () => {
    mocks.amendmentsList.mockResolvedValue([
      amendment('a1', { text: 'Always ship receipts', rationale: 'operator trust' }),
    ]);
    render(<AmendmentsPanel />);
    await waitFor(() => expect(screen.getByText('Always ship receipts')).toBeTruthy());
    expect(screen.getByText('operator trust')).toBeTruthy();
  });

  it('an amendment with no rationale renders without crashing (rationale is optional)', async () => {
    mocks.amendmentsList.mockResolvedValue([amendment('a1', { text: 'No rationale here' })]);
    render(<AmendmentsPanel />);
    await waitFor(() => expect(screen.getByText('No rationale here')).toBeTruthy());
  });

  it('Approve calls jorvis.amendmentsDecide with { amendmentId, approved: true }', async () => {
    mocks.amendmentsList.mockResolvedValue([amendment('a1')]);
    render(<AmendmentsPanel />);
    await waitFor(() => expect(screen.getByText('Amendment a1')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() =>
      expect(mocks.amendmentsDecide).toHaveBeenCalledWith({ amendmentId: 'a1', approved: true }),
    );
  });

  it('Deny calls jorvis.amendmentsDecide with { amendmentId, approved: false }', async () => {
    mocks.amendmentsList.mockResolvedValue([amendment('a1')]);
    render(<AmendmentsPanel />);
    await waitFor(() => expect(screen.getByText('Amendment a1')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    await waitFor(() =>
      expect(mocks.amendmentsDecide).toHaveBeenCalledWith({ amendmentId: 'a1', approved: false }),
    );
  });

  // Pre-v3 fix — a rejected amendmentsDecide used to be swallowed whole (no
  // catch, no toast, the row silently stayed): the operator had no way to
  // tell the decision didn't take.
  it('a rejected amendmentsDecide surfaces a toast and re-enables the buttons', async () => {
    mocks.amendmentsList.mockResolvedValue([amendment('a1')]);
    mocks.amendmentsDecide.mockRejectedValue(new Error('db locked'));
    render(<AmendmentsPanel />);
    await waitFor(() => expect(screen.getByText('Amendment a1')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledTimes(1));
    // finally-reset: the row's buttons must come back so the operator can retry
    await waitFor(() => {
      expect(
        (screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled,
      ).toBe(false);
    });
  });

  it('each amendment row scopes its own Approve/Deny buttons', async () => {
    mocks.amendmentsList.mockResolvedValue([amendment('a1'), amendment('a2')]);
    render(<AmendmentsPanel />);
    await waitFor(() => expect(screen.getAllByTestId('amendment-row')).toHaveLength(2));
    const rows = screen.getAllByTestId('amendment-row');
    fireEvent.click(within(rows[1]).getByRole('button', { name: 'Approve' }));
    await waitFor(() =>
      expect(mocks.amendmentsDecide).toHaveBeenCalledWith({ amendmentId: 'a2', approved: true }),
    );
  });

  it('refetches on a jorvis:amendments-changed event', async () => {
    mocks.amendmentsList.mockResolvedValueOnce([]).mockResolvedValueOnce([amendment('a1')]);
    render(<AmendmentsPanel />);
    await waitFor(() => expect(mocks.amendmentsList).toHaveBeenCalledTimes(1));

    emitEvent('jorvis:amendments-changed');
    await waitFor(() => expect(screen.getByTestId('amendments-panel')).toBeTruthy());
    expect(mocks.amendmentsList).toHaveBeenCalledTimes(2);
  });

  it('a failing amendmentsList fetch degrades to an empty (hidden) panel, never throws', async () => {
    mocks.amendmentsList.mockRejectedValue(new Error('rpc down'));
    expect(() => render(<AmendmentsPanel />)).not.toThrow();
    await waitFor(() => expect(mocks.amendmentsList).toHaveBeenCalled());
    expect(screen.queryByTestId('amendments-panel')).toBeNull();
  });
});
