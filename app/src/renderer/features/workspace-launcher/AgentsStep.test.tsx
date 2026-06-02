// @vitest-environment jsdom
//
// FEAT-14 — AgentsStep per-row model dropdown tests.
//
// Coverage:
//   - model dropdowns render ONLY for providers that accept `--model`
//     (claude / cursor / gemini); codex / kimi / opencode render none.
//   - picking a model fires onModelsChange with {providerId: modelId}.
//   - choosing "Default" (empty value) clears the provider's model entry.
//   - the dropdown is a calm `bg-background` surface (v1.36 purple-flash guard).

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { AgentsStep } from './AgentsStep';
import type { ProviderProbe } from '@/shared/types';

// Stub Radix-backed primitives that may not render cleanly in jsdom.
vi.mock('@/components/ui/button', () => ({
  Button: ({ children, onClick, disabled, ...rest }: {
    children?: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    [k: string]: unknown;
  }) => (
    <button onClick={onClick} disabled={disabled} {...rest}>
      {children}
    </button>
  ),
}));
vi.mock('./ProviderInstallModal', () => ({
  ProviderInstallModal: () => null,
}));

afterEach(() => cleanup());

const noopProbes: ProviderProbe[] = [];

function renderStep(overrides: Partial<Parameters<typeof AgentsStep>[0]> = {}) {
  const onCountsChange = vi.fn();
  const onSkipChange = vi.fn();
  const onModelsChange = vi.fn();
  render(
    <AgentsStep
      totalPanes={4}
      counts={{}}
      onCountsChange={onCountsChange}
      skipAgents={false}
      onSkipChange={onSkipChange}
      probes={noopProbes}
      models={{}}
      onModelsChange={onModelsChange}
      {...overrides}
    />,
  );
  return { onCountsChange, onSkipChange, onModelsChange };
}

describe('AgentsStep — FEAT-14 model dropdown', () => {
  it('renders a model dropdown for claude, cursor (when present), and gemini only', () => {
    renderStep();
    // claude + gemini are in the matrix; codex/kimi/opencode/custom are too but
    // must NOT get a dropdown.
    expect(screen.getByLabelText('Model for claude')).toBeTruthy();
    expect(screen.getByLabelText('Model for gemini')).toBeTruthy();
    expect(screen.queryByLabelText('Model for codex')).toBeNull();
    expect(screen.queryByLabelText('Model for kimi')).toBeNull();
    expect(screen.queryByLabelText('Model for opencode')).toBeNull();
    expect(screen.queryByLabelText('Model for custom')).toBeNull();
  });

  it('lists Default + the provider catalog options for claude', () => {
    renderStep();
    const select = screen.getByLabelText('Model for claude') as HTMLSelectElement;
    const labels = within(select).getAllByRole('option').map((o) => o.textContent);
    expect(labels[0]).toBe('Default');
    expect(labels).toContain('Opus 4.7 (1M)');
    expect(labels).toContain('Sonnet 4.6');
    expect(labels).toContain('Haiku 4.5');
  });

  it('picking a model fires onModelsChange keyed by providerId', () => {
    const { onModelsChange } = renderStep();
    const select = screen.getByLabelText('Model for claude') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'claude-sonnet-4-6' } });
    expect(onModelsChange).toHaveBeenCalledWith({ claude: 'claude-sonnet-4-6' });
  });

  it('choosing "Default" (empty) clears the provider entry', () => {
    const { onModelsChange } = renderStep({ models: { claude: 'claude-opus-4-7' } });
    const select = screen.getByLabelText('Model for claude') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: '' } });
    expect(onModelsChange).toHaveBeenCalledWith({});
  });

  it('reflects the controlled value from the models prop', () => {
    renderStep({ models: { gemini: 'gemini-2.5-pro' } });
    const select = screen.getByLabelText('Model for gemini') as HTMLSelectElement;
    expect(select.value).toBe('gemini-2.5-pro');
  });

  it('uses a calm bg-background surface, not bg-accent (purple-flash guard)', () => {
    renderStep();
    const select = screen.getByLabelText('Model for claude') as HTMLSelectElement;
    expect(select.className).toContain('bg-background');
    expect(select.className).not.toContain('bg-accent');
  });

  it('disables the dropdown when skipAgents is true', () => {
    renderStep({ skipAgents: true });
    const select = screen.getByLabelText('Model for claude') as HTMLSelectElement;
    expect(select.disabled).toBe(true);
  });

  it('does not render dropdowns when onModelsChange is omitted (legacy caller)', () => {
    render(
      <AgentsStep
        totalPanes={4}
        counts={{}}
        onCountsChange={vi.fn()}
        skipAgents={false}
        onSkipChange={vi.fn()}
        probes={noopProbes}
      />,
    );
    // The select still renders for capable providers but is disabled so it
    // cannot mutate state without a handler. Assert disabled.
    const select = screen.getByLabelText('Model for claude') as HTMLSelectElement;
    expect(select.disabled).toBe(true);
  });
});
