// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { PaneSearch } from './PaneSearch';

afterEach(cleanup);

describe('PaneSearch', () => {
  it('renders count, calls onTermChange as you type, cycles with Enter/Shift+Enter, closes on Escape', () => {
    const onTermChange = vi.fn();
    const onNavigate = vi.fn();
    const onClose = vi.fn();
    const { getByPlaceholderText, getByTestId } = render(
      <PaneSearch term="abc" matchCount={5} activeIndex={1} onTermChange={onTermChange} onNavigate={onNavigate} onClose={onClose} />,
    );
    expect(getByTestId('pane-search-count').textContent).toBe('2/5');
    const input = getByPlaceholderText('Find');
    fireEvent.change(input, { target: { value: 'abcd' } });
    expect(onTermChange).toHaveBeenCalledWith('abcd');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onNavigate).toHaveBeenCalledWith(1);
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(onNavigate).toHaveBeenCalledWith(-1);
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('shows 0/0 when there are no matches', () => {
    const { getByTestId } = render(
      <PaneSearch term="zz" matchCount={0} activeIndex={0} onTermChange={vi.fn()} onNavigate={vi.fn()} onClose={vi.fn()} />,
    );
    expect(getByTestId('pane-search-count').textContent).toBe('0/0');
  });
});
