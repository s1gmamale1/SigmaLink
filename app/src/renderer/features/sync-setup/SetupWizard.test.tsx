// @vitest-environment jsdom
// v1.5.0 packet 09 — SetupWizard component tests.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { SetupWizard } from './SetupWizard';

afterEach(() => { cleanup(); });

const VALID_MNEMONIC =
  'abandon ability able about above absent absorb abstract absurd abuse ' +
  'access accident account accuse achieve acid acoustic acquire across act ' +
  'action actor actress actual';

const syncEnableMock = vi.fn();
const syncExportMnemonicMock = vi.fn();

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    sync: {
      enable: (...args: unknown[]) => (syncEnableMock as (...a: unknown[]) => unknown)(...args),
      exportMnemonic: () => syncExportMnemonicMock() as unknown,
    },
  },
}));

describe('SetupWizard', () => {
  const onComplete = vi.fn();
  const onCancel = vi.fn();

  beforeEach(() => {
    onComplete.mockClear();
    onCancel.mockClear();
    syncEnableMock.mockClear();
    syncExportMnemonicMock.mockClear();

    syncEnableMock.mockResolvedValue({ enabled: true, pendingConflicts: 0, pendingUpgrade: 0 });
    syncExportMnemonicMock.mockResolvedValue(VALID_MNEMONIC);
  });

  it('renders the welcome step initially', () => {
    render(<SetupWizard onComplete={onComplete} onCancel={onCancel} />);
    expect(screen.getByText('Welcome to sync setup')).toBeTruthy();
  });

  it('Cancel button calls onCancel', () => {
    render(<SetupWizard onComplete={onComplete} onCancel={onCancel} />);
    fireEvent.click(screen.getByText('Cancel'));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('advances from welcome to repo step', () => {
    render(<SetupWizard onComplete={onComplete} onCancel={onCancel} />);
    fireEvent.click(screen.getByTestId('wizard-next-welcome'));
    expect(screen.getByText('Connect your repository')).toBeTruthy();
  });

  it('repo step requires URL before advancing', () => {
    render(<SetupWizard onComplete={onComplete} onCancel={onCancel} />);
    fireEvent.click(screen.getByTestId('wizard-next-welcome'));
    const nextBtn = screen.getByTestId('wizard-next-repo') as HTMLButtonElement;
    expect(nextBtn.disabled).toBe(true);
  });

  it('advances from repo to mnemonic display after submit', async () => {
    render(<SetupWizard onComplete={onComplete} onCancel={onCancel} />);
    fireEvent.click(screen.getByTestId('wizard-next-welcome'));
    fireEvent.change(screen.getByTestId('repo-url-input'), {
      target: { value: 'https://github.com/user/sync.git' },
    });
    fireEvent.click(screen.getByTestId('wizard-next-repo'));

    await waitFor(() => {
      expect(screen.getByText('Your recovery phrase')).toBeTruthy();
    });
  });

  it('advances to mnemonic confirm when user clicks written down', async () => {
    render(<SetupWizard onComplete={onComplete} onCancel={onCancel} />);
    fireEvent.click(screen.getByTestId('wizard-next-welcome'));
    fireEvent.change(screen.getByTestId('repo-url-input'), {
      target: { value: 'https://github.com/user/sync.git' },
    });
    fireEvent.click(screen.getByTestId('wizard-next-repo'));

    await waitFor(() => screen.getByTestId('mnemonic-written-down-btn'));
    fireEvent.click(screen.getByTestId('mnemonic-written-down-btn'));

    await waitFor(() => {
      expect(screen.getByText('Confirm your phrase')).toBeTruthy();
    });
  });

  it('shows Done step and calls onComplete', async () => {
    render(<SetupWizard onComplete={onComplete} onCancel={onCancel} />);
    // Navigate to repo step
    fireEvent.click(screen.getByTestId('wizard-next-welcome'));
    fireEvent.change(screen.getByTestId('repo-url-input'), {
      target: { value: 'https://example.com/sync.git' },
    });
    fireEvent.click(screen.getByTestId('wizard-next-repo'));

    // Wait for mnemonic display
    await waitFor(() => screen.getByTestId('mnemonic-written-down-btn'));
    fireEvent.click(screen.getByTestId('mnemonic-written-down-btn'));

    // Wait for mnemonic confirm
    await waitFor(() => screen.getByTestId('mnemonic-input'));

    // Type the mnemonic and check the checkbox
    fireEvent.change(screen.getByTestId('mnemonic-input'), { target: { value: VALID_MNEMONIC } });
    fireEvent.click(screen.getByTestId('ack-checkbox'));
    fireEvent.click(screen.getByTestId('confirm-btn'));

    // Done step
    await waitFor(() => screen.getByTestId('wizard-done-btn'));
    fireEvent.click(screen.getByTestId('wizard-done-btn'));
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it('shows error when enable rpc fails', async () => {
    syncEnableMock.mockRejectedValueOnce(new Error('auth failed'));

    render(<SetupWizard onComplete={onComplete} onCancel={onCancel} />);
    fireEvent.click(screen.getByTestId('wizard-next-welcome'));
    fireEvent.change(screen.getByTestId('repo-url-input'), {
      target: { value: 'https://example.com/sync.git' },
    });
    fireEvent.click(screen.getByTestId('wizard-next-repo'));

    await waitFor(() => {
      expect(screen.getByText('auth failed')).toBeTruthy();
    });
    expect(onComplete).not.toHaveBeenCalled();
  });
});
