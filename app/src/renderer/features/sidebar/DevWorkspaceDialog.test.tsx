// @vitest-environment jsdom
//
// SigmaLink Dev — terminal-count dialog (Phase 14, Task 8).
//
// Asserts:
//   - default count is 4 → Launch fires onLaunch(4)
//   - + increments, − decrements
//   - clamps: − disabled at 1, + disabled at 12 (DEV_WORKSPACE_MAX_PANES)

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { DEV_WORKSPACE_MAX_PANES } from '@/shared/special-workspace';
import { DevWorkspaceDialog } from './DevWorkspaceDialog';

afterEach(cleanup);

function renderDialog(overrides: Partial<{ open: boolean }> = {}) {
  const onLaunch = vi.fn<(count: number) => void>();
  const onOpenChange = vi.fn<(open: boolean) => void>();
  const utils = render(
    <DevWorkspaceDialog
      open={overrides.open ?? true}
      onOpenChange={onOpenChange}
      onLaunch={onLaunch}
    />,
  );
  return { ...utils, onLaunch, onOpenChange };
}

describe('<DevWorkspaceDialog />', () => {
  it('defaults to 4 terminals and launches with that count', () => {
    const { getByTestId, onLaunch } = renderDialog();
    expect(getByTestId('dev-workspace-count').textContent).toBe('4');
    fireEvent.click(getByTestId('dev-workspace-launch'));
    expect(onLaunch).toHaveBeenCalledWith(4);
  });

  it('increments the count with +', () => {
    const { getByTestId, getByLabelText, onLaunch } = renderDialog();
    fireEvent.click(getByLabelText('Increment'));
    expect(getByTestId('dev-workspace-count').textContent).toBe('5');
    fireEvent.click(getByTestId('dev-workspace-launch'));
    expect(onLaunch).toHaveBeenCalledWith(5);
  });

  it('decrements the count with −', () => {
    const { getByTestId, getByLabelText, onLaunch } = renderDialog();
    fireEvent.click(getByLabelText('Decrement'));
    expect(getByTestId('dev-workspace-count').textContent).toBe('3');
    fireEvent.click(getByTestId('dev-workspace-launch'));
    expect(onLaunch).toHaveBeenCalledWith(3);
  });

  it('clamps the count at the lower bound of 1 (− disabled)', () => {
    const { getByTestId, getByLabelText } = renderDialog();
    const dec = getByLabelText('Decrement') as HTMLButtonElement;
    // Start at 4 → click down 3× to reach 1.
    fireEvent.click(dec);
    fireEvent.click(dec);
    fireEvent.click(dec);
    expect(getByTestId('dev-workspace-count').textContent).toBe('1');
    expect(dec.disabled).toBe(true);
    // Further clicks are no-ops.
    fireEvent.click(dec);
    expect(getByTestId('dev-workspace-count').textContent).toBe('1');
  });

  it('clamps the count at the upper bound of DEV_WORKSPACE_MAX_PANES (+ disabled)', () => {
    const { getByTestId, getByLabelText } = renderDialog();
    const inc = getByLabelText('Increment') as HTMLButtonElement;
    // Start at 4 → click up until the cap.
    for (let i = 0; i < DEV_WORKSPACE_MAX_PANES; i++) fireEvent.click(inc);
    expect(getByTestId('dev-workspace-count').textContent).toBe(String(DEV_WORKSPACE_MAX_PANES));
    expect(inc.disabled).toBe(true);
    fireEvent.click(inc);
    expect(getByTestId('dev-workspace-count').textContent).toBe(String(DEV_WORKSPACE_MAX_PANES));
  });
});
