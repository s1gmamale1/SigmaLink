// @vitest-environment jsdom
//
// P6 FEAT-2 — PaneContextSidebar unit tests.
//
// Covers:
//  1. `open` = false → renders nothing.
//  2. `open` = true → MCP section renders with daemon state label.
//  3. MCP section: each RufloDaemonState maps to the correct label.
//  4. Usage section: empty-state when sessionSummary returns zero tokens.
//  5. Usage section: populated data rows when tokens > 0.
//  6. Usage section: cost displays "—" when totalCostUsd is null.
//  7. Usage section: graceful empty-state when rpc rejects.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { AgentSession, UsageSummary } from '@/shared/types';

// ── Mock: prefersReducedMotion ────────────────────────────────────────────────
vi.mock('@/renderer/lib/motion', () => ({
  prefersReducedMotion: vi.fn(() => false),
}));

// ── Mock: useRufloDaemonHealth ────────────────────────────────────────────────
// Default: 'running'. Individual tests can override via the mock fn.
vi.mock('./useRufloDaemonHealth', () => ({
  useRufloDaemonHealth: vi.fn(() => ({
    state: 'running',
    detail: 'running · port 53112',
  })),
}));

// ── Mock: rpc / rpcSilent ─────────────────────────────────────────────────────
// rpcSilent.usage.sessionSummary returns a UsageSummary. Tests override as
// needed. We also need rpcSilent.ruflo (for if the hook ever reaches through
// in an edge case) and rpc for completeness.
const mockSessionSummary = vi.fn<() => Promise<UsageSummary>>();
// Records the raw args passed from the component so we can assert on sessionId.
const sessionSummaryArgs: unknown[][] = [];

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    usage: { sessionSummary: vi.fn() },
  },
  rpcSilent: {
    ruflo: { daemonStatus: vi.fn().mockResolvedValue([]) },
    usage: {
      sessionSummary: (...args: unknown[]) => {
        sessionSummaryArgs.push(args);
        return mockSessionSummary();
      },
    },
  },
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────
import { PaneContextSidebar } from './PaneContextSidebar';
import { useRufloDaemonHealth } from './useRufloDaemonHealth';
import type { RufloDaemonState } from './useRufloDaemonHealth';

const mockUseRufloDaemonHealth = useRufloDaemonHealth as ReturnType<typeof vi.fn>;

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: 'sess-1',
    workspaceId: 'ws-1',
    providerId: 'claude',
    cwd: '/code',
    branch: null,
    status: 'running',
    startedAt: Date.now(),
    worktreePath: null,
    ...overrides,
  };
}

function makeUsageSummary(overrides: Partial<UsageSummary> = {}): UsageSummary {
  return {
    inputTokens: 1200,
    outputTokens: 450,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalCostUsd: 0.018,
    turnCount: 3,
    ...overrides,
  };
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  // Default: sessionSummary resolves with populated data.
  mockSessionSummary.mockResolvedValue(makeUsageSummary());
  // Default: running health.
  mockUseRufloDaemonHealth.mockReturnValue({
    state: 'running' as RufloDaemonState,
    detail: 'running · port 53112',
  });
  // Clear captured args before each test.
  sessionSummaryArgs.length = 0;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PaneContextSidebar', () => {
  describe('closed state', () => {
    it('renders nothing when open is false', () => {
      const { container } = render(
        <PaneContextSidebar session={makeSession()} open={false} />,
      );
      expect(container.firstChild).toBeNull();
    });
  });

  describe('open state — MCP section', () => {
    it('renders the sidebar with MCP section when open is true', async () => {
      render(<PaneContextSidebar session={makeSession()} open={true} />);
      expect(screen.getByTestId('pane-context-sidebar')).toBeTruthy();
      expect(screen.getByTestId('pane-context-mcp-section')).toBeTruthy();
    });

    it('shows "Connected" label for running state', async () => {
      mockUseRufloDaemonHealth.mockReturnValue({
        state: 'running',
        detail: 'running · port 53112',
      });
      render(<PaneContextSidebar session={makeSession()} open={true} />);
      expect(screen.getByTestId('pane-context-mcp-label').textContent).toBe('Connected');
    });

    it('shows "Starting" label for starting state', () => {
      mockUseRufloDaemonHealth.mockReturnValue({
        state: 'starting',
        detail: 'starting…',
      });
      render(<PaneContextSidebar session={makeSession()} open={true} />);
      expect(screen.getByTestId('pane-context-mcp-label').textContent).toBe('Starting');
    });

    it('shows "Fallback (stdio)" label for fallback state', () => {
      mockUseRufloDaemonHealth.mockReturnValue({
        state: 'fallback',
        detail: 'stdio fallback — HTTP daemon unavailable',
      });
      render(<PaneContextSidebar session={makeSession()} open={true} />);
      expect(screen.getByTestId('pane-context-mcp-label').textContent).toBe('Fallback (stdio)');
    });

    it('shows "Disconnected" label for down state', () => {
      mockUseRufloDaemonHealth.mockReturnValue({
        state: 'down',
        detail: 'daemon down',
      });
      render(<PaneContextSidebar session={makeSession()} open={true} />);
      expect(screen.getByTestId('pane-context-mcp-label').textContent).toBe('Disconnected');
    });

    it('shows "Unknown" label for unknown state', () => {
      mockUseRufloDaemonHealth.mockReturnValue({
        state: 'unknown',
        detail: 'Ruflo MCP status unavailable',
      });
      render(<PaneContextSidebar session={makeSession()} open={true} />);
      expect(screen.getByTestId('pane-context-mcp-label').textContent).toBe('Unknown');
    });

    it('renders the detail string below the state label', () => {
      const detail = 'running · port 53112 · 2 conn';
      mockUseRufloDaemonHealth.mockReturnValue({ state: 'running', detail });
      render(<PaneContextSidebar session={makeSession()} open={true} />);
      expect(screen.getByTestId('pane-context-mcp-detail').textContent).toBe(detail);
    });

    it('calls useRufloDaemonHealth with the session workspaceId', () => {
      const session = makeSession({ workspaceId: 'ws-abc' });
      render(<PaneContextSidebar session={session} open={true} />);
      expect(mockUseRufloDaemonHealth).toHaveBeenCalledWith('ws-abc');
    });
  });

  describe('open state — Usage section', () => {
    it('renders the usage section', async () => {
      render(<PaneContextSidebar session={makeSession()} open={true} />);
      expect(screen.getByTestId('pane-context-usage-section')).toBeTruthy();
    });

    it('shows populated data rows when sessionSummary returns tokens > 0', async () => {
      mockSessionSummary.mockResolvedValue(makeUsageSummary({
        inputTokens: 1200,
        outputTokens: 450,
        totalCostUsd: 0.018,
      }));
      render(<PaneContextSidebar session={makeSession()} open={true} />);

      await waitFor(() => {
        expect(screen.getByTestId('pane-context-usage-data')).toBeTruthy();
      });

      const dataSection = screen.getByTestId('pane-context-usage-data');
      expect(dataSection.textContent).toContain('1.2k');
      expect(dataSection.textContent).toContain('450');
    });

    it('shows the cost formatted to 3 decimal places', async () => {
      mockSessionSummary.mockResolvedValue(makeUsageSummary({ totalCostUsd: 0.018 }));
      render(<PaneContextSidebar session={makeSession()} open={true} />);

      await waitFor(() => {
        expect(screen.getByTestId('pane-context-usage-cost')).toBeTruthy();
      });
      expect(screen.getByTestId('pane-context-usage-cost').textContent).toBe('$0.018');
    });

    it('shows "—" for cost when totalCostUsd is null', async () => {
      mockSessionSummary.mockResolvedValue(makeUsageSummary({
        inputTokens: 500,
        outputTokens: 100,
        totalCostUsd: null,
      }));
      render(<PaneContextSidebar session={makeSession()} open={true} />);

      await waitFor(() => {
        expect(screen.getByTestId('pane-context-usage-cost')).toBeTruthy();
      });
      expect(screen.getByTestId('pane-context-usage-cost').textContent).toBe('—');
    });

    it('shows empty-state when sessionSummary returns zero tokens', async () => {
      mockSessionSummary.mockResolvedValue(makeUsageSummary({
        inputTokens: 0,
        outputTokens: 0,
        totalCostUsd: null,
        turnCount: 0,
      }));
      render(<PaneContextSidebar session={makeSession()} open={true} />);

      await waitFor(() => {
        expect(screen.getByTestId('pane-context-usage-empty')).toBeTruthy();
      });
      expect(screen.queryByTestId('pane-context-usage-data')).toBeNull();
    });

    it('shows empty-state when sessionSummary rejects', async () => {
      mockSessionSummary.mockRejectedValue(new Error('not found'));
      render(<PaneContextSidebar session={makeSession()} open={true} />);

      await waitFor(() => {
        expect(screen.getByTestId('pane-context-usage-empty')).toBeTruthy();
      });
    });

    it('calls sessionSummary with the session id', async () => {
      const session = makeSession({ id: 'sess-xyz' });
      render(<PaneContextSidebar session={session} open={true} />);
      await waitFor(() => {
        expect(sessionSummaryArgs.length).toBeGreaterThan(0);
      });
      // The first positional argument to rpcSilent.usage.sessionSummary
      // must be the input object containing the session id.
      expect(sessionSummaryArgs[0][0]).toEqual({ sessionId: 'sess-xyz' });
    });
  });

  describe('accessibility', () => {
    it('has an accessible name on the aside element', () => {
      render(<PaneContextSidebar session={makeSession()} open={true} />);
      const aside = screen.getByRole('complementary', { name: /pane context/i });
      expect(aside).toBeTruthy();
    });

    it('MCP section is a labelled landmark region', () => {
      render(<PaneContextSidebar session={makeSession()} open={true} />);
      // The section heading provides the label.
      expect(screen.getByText('MCP / Ruflo')).toBeTruthy();
    });

    it('Usage section is a labelled landmark region', () => {
      render(<PaneContextSidebar session={makeSession()} open={true} />);
      expect(screen.getByText('Usage')).toBeTruthy();
    });
  });

  describe('open state — Identity section (C1)', () => {
    it('renders an Identity section with alias + provider + model + branch', () => {
      render(<PaneContextSidebar session={makeSession()} open />);
      const id = screen.getByTestId('pane-context-identity-section');
      expect(id.textContent ?? '').toMatch(/\w+/); // alias present
      expect(screen.getByTestId('pane-context-identity-section')).toBeTruthy();
    });

    it('Identity section is mounted before MCP section (first in DOM)', () => {
      render(<PaneContextSidebar session={makeSession()} open />);
      const aside = screen.getByTestId('pane-context-sidebar');
      const children = Array.from(aside.querySelectorAll('[data-testid]'));
      const identityIdx = children.findIndex(el => el.getAttribute('data-testid') === 'pane-context-identity-section');
      const mcpIdx = children.findIndex(el => el.getAttribute('data-testid') === 'pane-context-mcp-section');
      expect(identityIdx).toBeGreaterThanOrEqual(0);
      expect(mcpIdx).toBeGreaterThanOrEqual(0);
      expect(identityIdx).toBeLessThan(mcpIdx);
    });

    it('Identity section contains branch from the session', () => {
      render(<PaneContextSidebar session={makeSession({ branch: 'feature/test-branch' })} open />);
      const id = screen.getByTestId('pane-context-identity-section');
      expect(id.textContent).toContain('feature/test-branch');
    });

    it('Identity section defaults branch to "dev" when session.branch is null', () => {
      render(<PaneContextSidebar session={makeSession({ branch: null })} open />);
      const id = screen.getByTestId('pane-context-identity-section');
      expect(id.textContent).toContain('dev');
    });
  });
});
