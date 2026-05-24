// @vitest-environment jsdom
//
// G4 — Guardrail matrix toggles in SkillsTab.
//
// Verifies:
//   1. A "Guardrails" section renders with one toggle per GUARDRAILS id.
//   2. On mount the component reads guardrails.enabled from rpc.kv.get.
//   3. Toggling a guardrail calls rpc.kv.set with the updated JSON id array.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { GUARDRAILS } from '@/shared/guardrails';

// ---- mocks ----

const kvGetMock = vi.fn<(key: string) => Promise<string | null>>();
const kvSetMock = vi.fn<(key: string, value: string) => Promise<void>>();

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    skills: {
      listInstalled: vi.fn().mockResolvedValue([]),
      list: vi.fn().mockResolvedValue({ skills: [], states: [] }),
    },
    kv: {
      get: (key: string) => kvGetMock(key),
      set: (key: string, value: string) => kvSetMock(key, value),
    },
  },
}));

// navigator.clipboard polyfill
Object.defineProperty(navigator, 'clipboard', {
  value: { writeText: vi.fn().mockResolvedValue(undefined) },
  writable: true,
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// ---- tests ----

describe('SkillsTab — Guardrails section', () => {
  it('renders a Guardrails section heading', async () => {
    kvGetMock.mockResolvedValue(null);
    const { SkillsTab } = await import('./SkillsTab');
    render(<SkillsTab />);
    await waitFor(() => {
      expect(screen.getByTestId('guardrails-section')).toBeDefined();
    });
  });

  it('renders one toggle row per GUARDRAILS id', async () => {
    kvGetMock.mockResolvedValue(null);
    const { SkillsTab } = await import('./SkillsTab');
    render(<SkillsTab />);
    const ids = Object.keys(GUARDRAILS);
    await waitFor(() => {
      for (const id of ids) {
        expect(screen.getByTestId(`guardrail-toggle-${id}`)).toBeDefined();
      }
    });
  });

  it('reads guardrails.enabled from rpc.kv.get on mount', async () => {
    kvGetMock.mockImplementation(async (key) => {
      if (key === 'guardrails.enabled') return JSON.stringify(['test-driven']);
      return null;
    });
    const { SkillsTab } = await import('./SkillsTab');
    render(<SkillsTab />);
    await waitFor(() => {
      expect(kvGetMock).toHaveBeenCalledWith('guardrails.enabled');
    });
  });

  it('shows test-driven toggle as checked when it is in the loaded KV array', async () => {
    kvGetMock.mockImplementation(async (key) => {
      if (key === 'guardrails.enabled') return JSON.stringify(['test-driven']);
      return null;
    });
    const { SkillsTab } = await import('./SkillsTab');
    render(<SkillsTab />);
    await waitFor(() => {
      const toggle = screen.getByTestId('guardrail-toggle-test-driven');
      expect(toggle.getAttribute('aria-checked')).toBe('true');
    });
  });

  it('shows non-enabled toggles as unchecked', async () => {
    kvGetMock.mockImplementation(async (key) => {
      if (key === 'guardrails.enabled') return JSON.stringify(['test-driven']);
      return null;
    });
    const { SkillsTab } = await import('./SkillsTab');
    render(<SkillsTab />);
    await waitFor(() => {
      const toggle = screen.getByTestId('guardrail-toggle-dry-principle');
      expect(toggle.getAttribute('aria-checked')).toBe('false');
    });
  });

  it('toggling an off guardrail adds it to enabled and calls rpc.kv.set', async () => {
    kvSetMock.mockResolvedValue(undefined);
    kvGetMock.mockImplementation(async (key) => {
      if (key === 'guardrails.enabled') return JSON.stringify(['test-driven']);
      return null;
    });
    const { SkillsTab } = await import('./SkillsTab');
    render(<SkillsTab />);

    await waitFor(() => {
      expect(screen.getByTestId('guardrail-toggle-dry-principle')).toBeDefined();
    });

    fireEvent.click(screen.getByTestId('guardrail-toggle-dry-principle'));

    await waitFor(() => {
      expect(kvSetMock).toHaveBeenCalledWith(
        'guardrails.enabled',
        expect.stringContaining('dry-principle'),
      );
    });
    const callArg = kvSetMock.mock.calls[0][1];
    const parsed = JSON.parse(callArg) as string[];
    expect(parsed).toContain('test-driven');
    expect(parsed).toContain('dry-principle');
  });

  it('toggling an on guardrail removes it from enabled and calls rpc.kv.set', async () => {
    kvSetMock.mockResolvedValue(undefined);
    kvGetMock.mockImplementation(async (key) => {
      if (key === 'guardrails.enabled') return JSON.stringify(['test-driven', 'security-audit']);
      return null;
    });
    const { SkillsTab } = await import('./SkillsTab');
    render(<SkillsTab />);

    await waitFor(() => {
      expect(screen.getByTestId('guardrail-toggle-test-driven')).toBeDefined();
    });

    fireEvent.click(screen.getByTestId('guardrail-toggle-test-driven'));

    await waitFor(() => {
      expect(kvSetMock).toHaveBeenCalledWith(
        'guardrails.enabled',
        expect.not.stringContaining('test-driven'),
      );
    });
    const callArg = kvSetMock.mock.calls[0][1];
    const parsed = JSON.parse(callArg) as string[];
    expect(parsed).not.toContain('test-driven');
    expect(parsed).toContain('security-audit');
  });

  it('renders the launch note below the toggles', async () => {
    kvGetMock.mockResolvedValue(null);
    const { SkillsTab } = await import('./SkillsTab');
    render(<SkillsTab />);
    await waitFor(() => {
      const section = screen.getByTestId('guardrails-section');
      expect(section.textContent).toContain("worktree CLAUDE.md");
    });
  });
});
