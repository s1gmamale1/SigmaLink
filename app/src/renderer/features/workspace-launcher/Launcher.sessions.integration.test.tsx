// @vitest-environment jsdom
//
// SMK-2 regression guard: the real Launcher↔SessionStep pair does NOT enter an
// infinite update loop when the Launcher is at the sessions step.
//
// Root cause: Launcher.tsx passed `rows={buildPaneRows(counts, skipAgents, preset)}`
// — a new array every render. SessionStep's useEffect([rows,...]) called
// onSelectionsChange (setPaneResumePlan), which re-rendered WorkspaceLauncher,
// producing a new rows identity, which refired the effect →
// "Maximum update depth exceeded".
//
// Fix: wrap in `useMemo([counts, skipAgents, preset])` so the identity is stable.
//
// This file intentionally does NOT vi.mock('./SessionStep') — it exercises the
// real Launcher↔SessionStep pair, which is the test-blindness gap that hid SMK-2.

import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Workspace } from '@/shared/types';

// ─── jsdom polyfills (mirrors SessionStep.test.tsx) ─────────────────────────

if (typeof ResizeObserver === 'undefined') {
  (globalThis as unknown as Record<string, unknown>).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

// ─── rpc + rpcSilent mocks ───────────────────────────────────────────────────
// Mirrors Launcher.test.tsx exactly, PLUS rpcSilent.panes (used by SessionStep).

const mockListSessions = vi.fn(async () => []);
// lastResumePlan returns one entry so the Launcher jumps to the sessions step.
const mockLastResumePlan = vi.fn(async () => [
  { paneIndex: 0, providerId: 'claude', sessionId: null },
]);

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    kv: { get: async () => null, set: async () => undefined },
    providers: { probeAll: async () => [] },
    workspaces: {
      launch: async () => ({ sessions: [] }),
      pickFolder: async () => null,
      open: async () => makeWorkspace(),
      list: async () => [makeWorkspace()],
    },
    panes: { listForWorkspace: async () => [] },
    swarms: { list: async () => [] },
    design: { createCanvas: async () => ({}) },
    browser: { getState: async () => ({ tabs: [] }) },
  },
  rpcSilent: {
    panes: {
      listSessions: (...args: Parameters<typeof mockListSessions>) =>
        mockListSessions(...args),
      lastResumePlan: (...args: Parameters<typeof mockLastResumePlan>) =>
        mockLastResumePlan(...args),
    },
    kv: { get: async () => null },
  },
}));

// ─── App state mock (mirrors Launcher.test.tsx) ──────────────────────────────

const dispatchMock = vi.fn();

vi.mock('@/renderer/app/state', () => ({
  useAppDispatch: () => dispatchMock,
  useAppStateSelector: vi.fn((selector: (s: unknown) => unknown) =>
    selector({ activeWorkspace: makeWorkspace(), workspaces: [makeWorkspace()] }),
  ),
}));

// ─── Stub UI components that Launcher renders but are NOT under test ──────────
// Stub everything EXCEPT SessionStep so the real SessionStep renders.

// StartStep: immediately triggers onChooseRecent with the workspace so the
// Launcher calls chooseExisting → fetches lastResumePlan → jumps to sessions.
vi.mock('./StartStep', () => ({
  StartStep: ({ onChooseRecent, recents }: {
    onChooseRecent: (ws: Workspace) => void;
    recents: Workspace[];
  }) => {
    // Defer one tick so the component fully mounts before triggering navigation.
    const ws = recents[0];
    if (ws) {
      void Promise.resolve().then(() => onChooseRecent(ws));
    }
    return <div data-testid="start-step-stub" />;
  },
}));

// minimal-chrome — the launcher now opens on the intent landing. Stub it to a
// single mode row so the test can advance into the wizard (grid mode).
vi.mock('./LauncherLanding', () => ({
  LauncherLanding: ({ onPick }: { onPick: (m: string) => void }) => (
    <div data-testid="launcher-landing">
      <button data-testid="intent-card-space" onClick={() => onPick('space')}>space</button>
    </div>
  ),
}));
vi.mock('./Stepper', () => ({
  Stepper: ({ onJump }: { onJump: (s: string) => void }) => (
    <div data-testid="stepper">
      <button data-testid="jump-sessions" onClick={() => onJump('sessions')}>sessions</button>
    </div>
  ),
}));
vi.mock('./LayoutStep', () => ({
  LayoutStep: () => <div data-testid="layout-step" />,
}));
vi.mock('./AgentsStep', () => ({
  AgentsStep: ({ onSkipChange }: { onSkipChange: (v: boolean) => void }) => {
    void Promise.resolve().then(() => onSkipChange(true));
    return <div data-testid="agents-step" />;
  },
}));

// Stub Radix/shadcn primitives (may not render in jsdom).
vi.mock('@/components/ui/card', () => ({
  Card: ({ children, ...rest }: { children?: ReactNode }) => <div {...rest}>{children}</div>,
}));
vi.mock('@/components/ui/button', () => ({
  Button: ({ children, onClick, disabled, ...rest }: {
    children?: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    [k: string]: unknown;
  }) => <button onClick={onClick} disabled={disabled} {...rest}>{children}</button>,
}));
vi.mock('@/renderer/components/ErrorBanner', () => ({
  ErrorBanner: ({ message }: { message: string }) => <div data-testid="error-banner">{message}</div>,
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'ws-smk2',
    name: 'SMK-2 Test WS',
    rootPath: '/tmp/smk2',
    repoRoot: null,
    repoMode: 'plain',
    createdAt: 0,
    lastOpenedAt: 0,
    ...overrides,
  };
}

async function renderLauncherAtSessionsStep() {
  const { WorkspaceLauncher } = await import('./Launcher');
  return render(<WorkspaceLauncher />);
}

// ─── Setup / teardown ────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  dispatchMock.mockReset();
  mockListSessions.mockReset().mockResolvedValue([]);
  mockLastResumePlan.mockReset().mockResolvedValue([
    { paneIndex: 0, providerId: 'claude', sessionId: null },
  ]);
});

afterEach(() => {
  cleanup();
  vi.resetModules();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Launcher ↔ SessionStep integration (SMK-2)', () => {
  it('does not enter an infinite update loop when the sessions step mounts', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await act(async () => {
      await renderLauncherAtSessionsStep();
      await Promise.resolve();
    });
    // minimal-chrome — leave the intent landing so the Start step (which fires
    // onChooseRecent → chooseExisting → the sessions-step jump) actually mounts.
    await act(async () => {
      fireEvent.click(screen.getByTestId('intent-card-space'));
      // Pump enough microtask rounds for:
      // 1. StartStep → onChooseRecent → chooseExisting (opens workspace, fetches lastResumePlan)
      // 2. lastResumePlan resolves → setStep('sessions') → SessionStep mounts
      // 3. SessionStep's useEffect([rows,...]) fires → fetchSessions resolves
      // 4. Any subsequent renders settle
      for (let i = 0; i < 10; i++) {
        await Promise.resolve();
      }
    });

    const allErrors = errSpy.mock.calls.flat();
    const hasLoopError = allErrors.some(
      (a) => typeof a === 'string' && a.includes('Maximum update depth exceeded'),
    );

    // This is the decisive assertion: before the fix, the inline buildPaneRows()
    // call on every render caused the useEffect to refire in a loop.
    // After the fix (useMemo), rows identity is stable → no loop.
    expect(hasLoopError).toBe(false);

    errSpy.mockRestore();
  });
});
