// @vitest-environment jsdom
//
// Stage-4 a11y — SigmaBenchRoom empty-state guard.
// Verifies that the room renders EmptyState when there is no active workspace
// instead of rendering the bench form.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

// Minimal rpc mock — the empty-state guard short-circuits before any rpc call.
vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    sigmabench: {
      run: vi.fn(),
      getRun: vi.fn(),
      listRuns: vi.fn().mockResolvedValue([]),
    },
  },
}));

// No active workspace — activeWorkspace is undefined.
vi.mock('@/renderer/app/state', () => ({
  useAppState: () => ({
    state: { room: 'sigmabench', activeWorkspace: undefined },
  }),
}));

import { SigmaBenchRoom } from './SigmaBenchRoom';

afterEach(() => {
  cleanup();
});

describe('SigmaBenchRoom — Stage-4 empty-state guard', () => {
  it('renders EmptyState when there is no active workspace', () => {
    render(<SigmaBenchRoom />);
    // EmptyState renders with role="status".
    expect(screen.getByRole('status')).toBeTruthy();
    // The empty-state title text should be visible.
    expect(screen.getByText(/open a workspace to use sigmabench/i)).toBeTruthy();
    // The bench form (textarea) must NOT be present.
    expect(screen.queryByRole('textbox', { name: /task prompt/i })).toBeNull();
  });
});
