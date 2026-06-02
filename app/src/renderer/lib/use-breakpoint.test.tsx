// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { useBelowBreakpoint } from './use-breakpoint';

afterEach(() => cleanup());

function setWidth(px: number) {
  (window as unknown as { innerWidth: number }).innerWidth = px;
  window.dispatchEvent(new Event('resize'));
}

function Probe({ name }: { name: 'narrow' | 'compact' }) {
  const below = useBelowBreakpoint(name);
  return <span data-testid="v">{below ? 'below' : 'at-or-above'}</span>;
}

describe('useBelowBreakpoint', () => {
  it('reflects the current width and updates on resize across the threshold', () => {
    setWidth(1400);
    const { getByTestId } = render(<Probe name="compact" />);
    expect(getByTestId('v').textContent).toBe('at-or-above');
    act(() => setWidth(900)); // < 1100
    expect(getByTestId('v').textContent).toBe('below');
    act(() => setWidth(1200)); // back above
    expect(getByTestId('v').textContent).toBe('at-or-above');
  });

  it('narrow uses the 900px threshold independently', () => {
    setWidth(950);
    const { getByTestId } = render(<Probe name="narrow" />);
    expect(getByTestId('v').textContent).toBe('at-or-above'); // 950 >= 900
    act(() => setWidth(850));
    expect(getByTestId('v').textContent).toBe('below');
  });
});
