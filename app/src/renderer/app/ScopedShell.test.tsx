// @vitest-environment jsdom
//
// Task 7 — ScopedShell mounts the RightRailSwitcher (without Settings gear)
// and the RightRail in the scoped workspace window titlebar.
//
// We extracted ScopedShell to its own file (ScopedShell.tsx) so we can test
// it in isolation without pulling in App.tsx's heavy lazy-room tree or the
// module-level IS_SCOPED_WINDOW constant.

import { describe, it, expect, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: { kv: { set: vi.fn().mockResolvedValue(undefined) } },
  rpcSilent: { kv: { get: vi.fn().mockResolvedValue(null) } },
}));

vi.mock('@/renderer/lib/workspace-ui-kv', () => ({
  readWorkspaceUi: vi.fn().mockResolvedValue(null),
  writeWorkspaceUi: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/renderer/app/state', () => ({
  useAppStateSelector: (sel: (s: unknown) => unknown) =>
    sel({ activeWorkspace: { id: 'ws-scoped', name: 'Scoped WS' } }),
  useAppDispatch: () => vi.fn(),
}));

vi.mock('@/renderer/lib/drag-region', () => ({
  dragStyle: () => ({}),
  noDragStyle: () => ({}),
}));

// Stub useRightRailEnabled to return ready+enabled so the switcher renders.
vi.mock('@/renderer/features/right-rail/use-right-rail-enabled', () => ({
  useRightRailEnabled: () => ({ enabled: true, ready: true }),
}));

// Stub CommandRoom — it's heavy (xterm, terminals) and not the subject here.
vi.mock('@/renderer/features/command-room/CommandRoom', () => ({
  CommandRoom: () => <div data-testid="command-room-stub" />,
}));

// Stub the RightRail dock body so we don't need to mock all its inner deps.
vi.mock('@/renderer/features/right-rail/RightRail', () => ({
  RightRail: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="right-rail-stub">{children}</div>
  ),
}));

// Stub heavy tab bodies that RightRailSwitcher doesn't need but whose modules
// get pulled in if RightRail.tsx is real.
vi.mock('@/renderer/features/browser/BrowserRoom', () => ({
  BrowserRoom: () => null,
}));

import { RightRailProvider } from '@/renderer/features/right-rail/RightRailContext';
import { ScopedShell } from './ScopedShell';

function renderScoped() {
  return render(
    <RightRailProvider>
      <ScopedShell />
    </RightRailProvider>,
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ScopedShell', () => {
  it('renders the right-rail switcher tabs (incl. Jorvis and Browser) in the titlebar', async () => {
    renderScoped();
    await act(async () => {});
    expect(screen.getByLabelText('Jorvis')).toBeTruthy();
    expect(screen.getByLabelText('Browser')).toBeTruthy();
  });

  it('does NOT render the Settings gear in the scoped titlebar', async () => {
    renderScoped();
    await act(async () => {});
    expect(screen.queryByLabelText('Settings')).toBeNull();
  });
});
