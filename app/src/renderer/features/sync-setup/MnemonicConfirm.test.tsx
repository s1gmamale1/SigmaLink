// @vitest-environment jsdom
// v1.5.0 packet 09 — MnemonicConfirm component tests.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MnemonicConfirm } from './MnemonicConfirm';

afterEach(() => { cleanup(); });

const MNEMONIC_24 =
  'abandon ability able about above absent absorb abstract absurd abuse ' +
  'access accident account accuse achieve acid acoustic acquire across act ' +
  'action actor actress actual';

describe('MnemonicConfirm', () => {
  const onConfirmed = vi.fn();
  const onBack = vi.fn();

  beforeEach(() => {
    onConfirmed.mockClear();
    onBack.mockClear();
  });

  it('renders the textarea and confirm button', () => {
    render(<MnemonicConfirm mnemonic={MNEMONIC_24} onConfirmed={onConfirmed} onBack={onBack} />);
    expect(screen.getByTestId('mnemonic-input')).toBeTruthy();
    expect(screen.getByTestId('confirm-btn')).toBeTruthy();
  });

  it('confirm button is disabled when textarea is empty', () => {
    render(<MnemonicConfirm mnemonic={MNEMONIC_24} onConfirmed={onConfirmed} onBack={onBack} />);
    const btn = screen.getByTestId('confirm-btn') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('confirm button is disabled when mnemonic is correct but checkbox not checked', () => {
    render(<MnemonicConfirm mnemonic={MNEMONIC_24} onConfirmed={onConfirmed} onBack={onBack} />);
    fireEvent.change(screen.getByTestId('mnemonic-input'), { target: { value: MNEMONIC_24 } });
    const btn = screen.getByTestId('confirm-btn') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('confirm button is enabled when mnemonic matches AND checkbox is checked', () => {
    render(<MnemonicConfirm mnemonic={MNEMONIC_24} onConfirmed={onConfirmed} onBack={onBack} />);
    fireEvent.change(screen.getByTestId('mnemonic-input'), { target: { value: MNEMONIC_24 } });
    fireEvent.click(screen.getByTestId('ack-checkbox'));
    const btn = screen.getByTestId('confirm-btn') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });

  it('calls onConfirmed when valid mnemonic + checkbox + button click', () => {
    render(<MnemonicConfirm mnemonic={MNEMONIC_24} onConfirmed={onConfirmed} onBack={onBack} />);
    fireEvent.change(screen.getByTestId('mnemonic-input'), { target: { value: MNEMONIC_24 } });
    fireEvent.click(screen.getByTestId('ack-checkbox'));
    fireEvent.click(screen.getByTestId('confirm-btn'));
    expect(onConfirmed).toHaveBeenCalledOnce();
  });

  it('does NOT call onConfirmed when mnemonic is wrong', () => {
    render(<MnemonicConfirm mnemonic={MNEMONIC_24} onConfirmed={onConfirmed} onBack={onBack} />);
    fireEvent.change(screen.getByTestId('mnemonic-input'), { target: { value: 'wrong words here' } });
    fireEvent.click(screen.getByTestId('ack-checkbox'));
    // Button should be disabled — click should be a no-op.
    const btn = screen.getByTestId('confirm-btn') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(onConfirmed).not.toHaveBeenCalled();
  });

  it('match status is shown when typing begins', () => {
    render(<MnemonicConfirm mnemonic={MNEMONIC_24} onConfirmed={onConfirmed} onBack={onBack} />);
    fireEvent.change(screen.getByTestId('mnemonic-input'), { target: { value: 'abandon' } });
    expect(screen.getByTestId('match-status')).toBeTruthy();
  });

  it('is case-insensitive for mnemonic comparison', () => {
    render(<MnemonicConfirm mnemonic={MNEMONIC_24} onConfirmed={onConfirmed} onBack={onBack} />);
    fireEvent.change(screen.getByTestId('mnemonic-input'), { target: { value: MNEMONIC_24.toUpperCase() } });
    fireEvent.click(screen.getByTestId('ack-checkbox'));
    const btn = screen.getByTestId('confirm-btn') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });

  it('calls onBack when Back button is clicked', () => {
    render(<MnemonicConfirm mnemonic={MNEMONIC_24} onConfirmed={onConfirmed} onBack={onBack} />);
    fireEvent.click(screen.getByText('Back'));
    expect(onBack).toHaveBeenCalledOnce();
  });
});
