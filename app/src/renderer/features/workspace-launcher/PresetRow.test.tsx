// @vitest-environment jsdom
//
// FEAT-10 — PresetRow named-launch-preset tests.
//
// Coverage:
//   - saved chips render and clicking one passes the WHOLE layout (preset +
//     counts) to onSelect.
//   - the `+ NEW` chip toggles into an inline name field, commits a trimmed
//     name on Save / Enter, and cancels on Escape.
//   - the inline name field is a calm `bg-background` surface (purple-flash guard).
//   - empty/whitespace names do not commit.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PresetRow, type SavedLayout } from './PresetRow';

afterEach(() => cleanup());

const layouts: SavedLayout[] = [
  { name: 'Solo', preset: 1 },
  { name: 'Quad mixed', preset: 4, counts: { claude: 2, gemini: 2 } },
];

describe('PresetRow — FEAT-10 saved layouts', () => {
  it('renders a chip per saved layout plus a NEW chip', () => {
    render(
      <PresetRow layouts={layouts} activePreset={4} onSelect={vi.fn()} onCreateNew={vi.fn()} />,
    );
    expect(screen.getByText('Solo')).toBeTruthy();
    expect(screen.getByText('Quad mixed')).toBeTruthy();
    expect(screen.getByText('NEW')).toBeTruthy();
  });

  it('clicking a chip passes the full layout (preset + counts) to onSelect', () => {
    const onSelect = vi.fn();
    render(
      <PresetRow layouts={layouts} activePreset={1} onSelect={onSelect} onCreateNew={vi.fn()} />,
    );
    fireEvent.click(screen.getByText('Quad mixed'));
    expect(onSelect).toHaveBeenCalledWith({
      name: 'Quad mixed',
      preset: 4,
      counts: { claude: 2, gemini: 2 },
    });
  });

  it('shows the empty hint when there are no layouts', () => {
    render(<PresetRow layouts={[]} activePreset={4} onSelect={vi.fn()} onCreateNew={vi.fn()} />);
    expect(screen.getByText(/no saved layouts yet/i)).toBeTruthy();
  });

  it('NEW chip opens an inline name field and Save commits a trimmed name', () => {
    const onCreateNew = vi.fn();
    render(<PresetRow layouts={[]} activePreset={4} onSelect={vi.fn()} onCreateNew={onCreateNew} />);
    fireEvent.click(screen.getByText('NEW'));
    const input = screen.getByLabelText('New layout name') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '  Morning swarm  ' } });
    fireEvent.click(screen.getByText('Save'));
    expect(onCreateNew).toHaveBeenCalledWith('Morning swarm');
  });

  it('Enter commits the name', () => {
    const onCreateNew = vi.fn();
    render(<PresetRow layouts={[]} activePreset={4} onSelect={vi.fn()} onCreateNew={onCreateNew} />);
    fireEvent.click(screen.getByText('NEW'));
    const input = screen.getByLabelText('New layout name');
    fireEvent.change(input, { target: { value: 'Pipeline' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCreateNew).toHaveBeenCalledWith('Pipeline');
  });

  it('Escape cancels without committing', () => {
    const onCreateNew = vi.fn();
    render(<PresetRow layouts={[]} activePreset={4} onSelect={vi.fn()} onCreateNew={onCreateNew} />);
    fireEvent.click(screen.getByText('NEW'));
    const input = screen.getByLabelText('New layout name');
    fireEvent.change(input, { target: { value: 'Discarded' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onCreateNew).not.toHaveBeenCalled();
    // Back to the NEW chip.
    expect(screen.getByText('NEW')).toBeTruthy();
  });

  it('does not commit an empty/whitespace name', () => {
    const onCreateNew = vi.fn();
    render(<PresetRow layouts={[]} activePreset={4} onSelect={vi.fn()} onCreateNew={onCreateNew} />);
    fireEvent.click(screen.getByText('NEW'));
    const input = screen.getByLabelText('New layout name');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCreateNew).not.toHaveBeenCalled();
  });

  it('inline name field uses a calm bg-background surface (purple-flash guard)', () => {
    render(<PresetRow layouts={[]} activePreset={4} onSelect={vi.fn()} onCreateNew={vi.fn()} />);
    fireEvent.click(screen.getByText('NEW'));
    const input = screen.getByLabelText('New layout name');
    const wrapper = input.parentElement as HTMLElement;
    expect(wrapper.className).toContain('bg-background');
    expect(wrapper.className).not.toContain('bg-accent');
  });
});
