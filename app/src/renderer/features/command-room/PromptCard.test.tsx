// @vitest-environment jsdom
//
// FEAT-4 — PromptCard RTL coverage.
//
// Scope:
//   • single-select: each choice is a button; clicking submits that choice.
//   • multi-select: checkboxes + a Send button; Send is disabled until ≥1 is
//     checked, then submits the checked choices.
//   • dismiss via the × button and via Escape.
//   • accessibility: role="dialog" + labelled question.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { PromptPayload } from '@/main/core/swarms/protocol';
import { PromptCard } from './PromptCard';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const single: PromptPayload = {
  question: 'Pick a colour',
  type: 'single',
  choices: ['red', 'blue'],
};
const multi: PromptPayload = {
  question: 'Pick toppings',
  type: 'multi',
  choices: ['cheese', 'olives', 'ham'],
};

describe('PromptCard — single-select', () => {
  it('renders the question as a labelled dialog with one button per choice', () => {
    render(<PromptCard prompt={single} onSubmit={vi.fn()} onDismiss={vi.fn()} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(screen.getByText('Pick a colour')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'red' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'blue' })).toBeTruthy();
  });

  it('submits the clicked choice', () => {
    const onSubmit = vi.fn();
    render(<PromptCard prompt={single} onSubmit={onSubmit} onDismiss={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'blue' }));
    expect(onSubmit).toHaveBeenCalledWith(['blue']);
  });
});

describe('PromptCard — multi-select', () => {
  it('renders a checkbox per choice and a Send button', () => {
    render(<PromptCard prompt={multi} onSubmit={vi.fn()} onDismiss={vi.fn()} />);
    expect(screen.getAllByRole('checkbox')).toHaveLength(3);
    expect(screen.getByTestId('prompt-card-send')).toBeTruthy();
  });

  it('disables Send until at least one choice is checked', () => {
    render(<PromptCard prompt={multi} onSubmit={vi.fn()} onDismiss={vi.fn()} />);
    const send = screen.getByTestId('prompt-card-send') as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: 'olives' }));
    expect(send.disabled).toBe(false);
  });

  it('submits the checked choices in choice order', () => {
    const onSubmit = vi.fn();
    render(<PromptCard prompt={multi} onSubmit={onSubmit} onDismiss={vi.fn()} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'ham' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'cheese' }));
    fireEvent.click(screen.getByTestId('prompt-card-send'));
    expect(onSubmit).toHaveBeenCalledWith(['cheese', 'ham']);
  });
});

describe('PromptCard — dismiss', () => {
  it('dismisses via the × button', () => {
    const onDismiss = vi.fn();
    render(<PromptCard prompt={single} onSubmit={vi.fn()} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByTestId('prompt-card-dismiss'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('dismisses on Escape', () => {
    const onDismiss = vi.fn();
    render(<PromptCard prompt={single} onSubmit={vi.fn()} onDismiss={onDismiss} />);
    fireEvent.keyDown(screen.getByTestId('prompt-card'), { key: 'Escape' });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
