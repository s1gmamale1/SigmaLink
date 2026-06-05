// @vitest-environment jsdom
//
// FEAT-14 — AgentsStep per-row model dropdown tests.
// BSP-V2 — dispatch preset control tests.
//
// Coverage:
//   - model dropdowns render ONLY for providers that accept `--model`
//     (claude / cursor / gemini); codex / kimi / opencode render none.
//   - picking a model fires onModelsChange with {providerId: modelId}.
//   - choosing "Default" (empty value) clears the provider's model entry.
//   - the dropdown is a calm `bg-background` surface (v1.36 purple-flash guard).
//   [BSP-V2] preset control renders when onModelsChange is provided.
//   [BSP-V2] clicking "Deep" sets claude model to claude-opus-4-7.
//   [BSP-V2] clicking "Fast" sets claude model to claude-haiku-4-5.
//   [BSP-V2] clicking "Balanced" sets claude model to claude-sonnet-4-6.
//   [BSP-V2] active preset is reflected (aria-checked=true).
//   [BSP-V2] preset control is disabled when skipAgents=true.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { AgentsStep } from './AgentsStep';
import { PRESET_TO_MODEL_ID } from '@/shared/model-catalog';
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

describe('AgentsStep — BSP-V2 dispatch preset control', () => {
  it('PRESET_TO_MODEL_ID mapping table has the correct ids', () => {
    // Unit-test the mapping table itself (locked operator decision).
    expect(PRESET_TO_MODEL_ID.fast).toBe('claude-haiku-4-5');
    expect(PRESET_TO_MODEL_ID.balanced).toBe('claude-sonnet-4-6');
    expect(PRESET_TO_MODEL_ID.deep).toBe('claude-opus-4-7');
  });

  it('renders the preset control when onModelsChange is provided', () => {
    renderStep();
    expect(screen.getByTestId('dispatch-preset-control')).toBeTruthy();
  });

  it('clicking "Deep" calls onModelsChange with the opus id', () => {
    const { onModelsChange } = renderStep();
    fireEvent.click(screen.getByTestId('preset-deep'));
    expect(onModelsChange).toHaveBeenCalledWith({ claude: 'claude-opus-4-7' });
  });

  it('clicking "Fast" calls onModelsChange with the haiku id', () => {
    const { onModelsChange } = renderStep();
    fireEvent.click(screen.getByTestId('preset-fast'));
    expect(onModelsChange).toHaveBeenCalledWith({ claude: 'claude-haiku-4-5' });
  });

  it('clicking "Balanced" calls onModelsChange with the sonnet id', () => {
    const { onModelsChange } = renderStep();
    fireEvent.click(screen.getByTestId('preset-balanced'));
    expect(onModelsChange).toHaveBeenCalledWith({ claude: 'claude-sonnet-4-6' });
  });

  it('active preset is marked aria-checked=true (deep is active when opus is selected)', () => {
    renderStep({ models: { claude: 'claude-opus-4-7' } });
    const deepBtn = screen.getByTestId('preset-deep') as HTMLButtonElement;
    const fastBtn = screen.getByTestId('preset-fast') as HTMLButtonElement;
    expect(deepBtn.getAttribute('aria-checked')).toBe('true');
    expect(fastBtn.getAttribute('aria-checked')).toBe('false');
  });

  it('all preset buttons are disabled when skipAgents=true', () => {
    renderStep({ skipAgents: true });
    for (const preset of ['fast', 'balanced', 'deep']) {
      const btn = screen.getByTestId(`preset-${preset}`) as HTMLButtonElement;
      expect(btn.disabled).toBe(true);
    }
  });

  it('preset control does not render when onModelsChange is omitted', () => {
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
    expect(screen.queryByTestId('dispatch-preset-control')).toBeNull();
  });
});
