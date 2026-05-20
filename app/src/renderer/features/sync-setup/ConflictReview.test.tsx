// @vitest-environment jsdom
// v1.5.0 packet 09 — ConflictReview component tests.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { ConflictReview } from './ConflictReview';
import type { SyncConflict } from '@/shared/types';

afterEach(() => { cleanup(); });

const resolveConflictMock = vi.fn();

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    sync: {
      resolveConflict: (...args: unknown[]) => (resolveConflictMock as (...a: unknown[]) => unknown)(...args),
    },
  },
}));

const mockConflicts: SyncConflict[] = [
  {
    id: 'c-1',
    tableName: 'conversations',
    rowId: 'row-aaa',
    localRowJson: JSON.stringify({ id: 'row-aaa', content: 'local version' }),
    remoteRowJson: JSON.stringify({ id: 'row-aaa', content: 'remote version' }),
    createdAt: Date.now() - 1000,
  },
];

describe('ConflictReview', () => {
  const onResolved = vi.fn();
  const onBack = vi.fn();

  beforeEach(() => {
    onResolved.mockClear();
    onBack.mockClear();
    resolveConflictMock.mockClear();
    resolveConflictMock.mockResolvedValue(undefined);
  });

  it('renders "no conflicts" when empty list', () => {
    render(<ConflictReview conflicts={[]} onResolved={onResolved} onBack={onBack} />);
    expect(screen.getByText(/No conflicts to review/)).toBeTruthy();
  });

  it('renders conflict cards', () => {
    render(<ConflictReview conflicts={mockConflicts} onResolved={onResolved} onBack={onBack} />);
    expect(screen.getByText('conversations')).toBeTruthy();
    expect(screen.getByText('row-aaa')).toBeTruthy();
  });

  it('apply button is disabled when no resolutions chosen', () => {
    render(<ConflictReview conflicts={mockConflicts} onResolved={onResolved} onBack={onBack} />);
    const btn = screen.getByTestId('apply-resolutions-btn') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('apply button is enabled when all conflicts have resolutions', () => {
    render(<ConflictReview conflicts={mockConflicts} onResolved={onResolved} onBack={onBack} />);
    fireEvent.click(screen.getByTestId(`keep-local-c-1`));
    const btn = screen.getByTestId('apply-resolutions-btn') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });

  it('calls rpc resolveConflict and onResolved when applied', async () => {
    render(<ConflictReview conflicts={mockConflicts} onResolved={onResolved} onBack={onBack} />);
    fireEvent.click(screen.getByTestId('keep-local-c-1'));
    fireEvent.click(screen.getByTestId('apply-resolutions-btn'));

    await waitFor(() => {
      expect(onResolved).toHaveBeenCalledOnce();
    });
    expect(resolveConflictMock).toHaveBeenCalledWith({
      conflictId: 'c-1',
      resolution: 'keep_local',
    });
  });

  it('shows error when rpc fails', async () => {
    resolveConflictMock.mockRejectedValue(new Error('Network error'));

    render(<ConflictReview conflicts={mockConflicts} onResolved={onResolved} onBack={onBack} />);
    fireEvent.click(screen.getByTestId('keep-remote-c-1'));
    fireEvent.click(screen.getByTestId('apply-resolutions-btn'));

    await waitFor(() => {
      expect(screen.getByText('Network error')).toBeTruthy();
    });
    expect(onResolved).not.toHaveBeenCalled();
  });

  it('calls onBack when Cancel is clicked', () => {
    render(<ConflictReview conflicts={mockConflicts} onResolved={onResolved} onBack={onBack} />);
    fireEvent.click(screen.getByText('Cancel'));
    expect(onBack).toHaveBeenCalledOnce();
  });
});
