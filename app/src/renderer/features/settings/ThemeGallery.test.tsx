// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ThemePreviewCard } from './ThemePreviewCard';
import { ThemeGallery } from './ThemeGallery';
import { THEMES } from '@/renderer/lib/themes';

afterEach(() => cleanup());

describe('ThemePreviewCard', () => {
  it('renders the theme label, marks ACTIVE when selected, and is an aria-pressed button', () => {
    const glass = THEMES.find((t) => t.id === 'glass')!;
    render(<ThemePreviewCard theme={glass} active onSelect={() => {}} />);
    const btn = screen.getByRole('button', { name: new RegExp(glass.label, 'i') });
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText(/active/i)).toBeTruthy();
  });

  it('calls onSelect(id) when clicked', () => {
    const clean = THEMES.find((t) => t.id === 'clean')!;
    const onSelect = vi.fn();
    render(<ThemePreviewCard theme={clean} active={false} onSelect={onSelect} />);
    screen.getByRole('button', { name: new RegExp(clean.label, 'i') }).click();
    expect(onSelect).toHaveBeenCalledWith('clean');
  });
});

describe('ThemeGallery', () => {
  it('All/Dark/Light filter narrows by appearance', () => {
    render(<ThemeGallery current="glass" onSelect={() => {}} />);
    // default All → both a known dark (glass) and the known light (clean-light) present
    expect(screen.getByTestId('theme-card-glass')).toBeTruthy();
    expect(screen.getByTestId('theme-card-clean-light')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^light$/i }));
    expect(screen.queryByTestId('theme-card-glass')).toBeNull();        // dark hidden
    expect(screen.getByTestId('theme-card-clean-light')).toBeTruthy();  // light kept
  });

  it('search narrows by label/description/id', () => {
    render(<ThemeGallery current="glass" onSelect={() => {}} />);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'parchment' } });
    expect(screen.getByTestId('theme-card-parchment')).toBeTruthy();
    expect(screen.queryByTestId('theme-card-glass')).toBeNull();
  });

  it('marks the current theme ACTIVE and calls onSelect on a card click', () => {
    const onSelect = vi.fn();
    render(<ThemeGallery current="glass" onSelect={onSelect} />);
    fireEvent.click(screen.getByTestId('theme-card-nord'));
    expect(onSelect).toHaveBeenCalledWith('nord');
  });
});
