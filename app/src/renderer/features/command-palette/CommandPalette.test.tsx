// @vitest-environment jsdom
//
// UX-3 — CommandPalette prompt wiring. cmdk's real DOM measurement is brittle
// in jsdom, so the `@/components/ui/command` primitives are mocked to plain
// elements (CommandItem → a button that invokes `onSelect`). That lets us
// deterministically pick the "New memory note" / "Run command…" actions and
// assert the themed PromptDialog opens + confirming runs the original RPC.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';

// ---- mocks -----------------------------------------------------------------

const createMemoryMock = vi.fn(async (..._a: unknown[]) => ({ id: 'm1', name: 'note' }));
const runCommandMock = vi.fn(async (..._a: unknown[]) => undefined);

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    memory: { create_memory: (...a: unknown[]) => createMemoryMock(...a) },
    review: { runCommand: (...a: unknown[]) => runCommandMock(...a) },
    workspaces: { open: vi.fn(), pickFolder: vi.fn() },
    pty: { kill: vi.fn() },
    swarms: { kill: vi.fn() },
    skills: { ingestFolder: vi.fn() },
  },
  rpcSilent: {
    ruflo: { 'autopilot.predict': vi.fn(async () => ({ ok: false })) },
  },
  onEvent: vi.fn(() => () => undefined),
}));

const dispatchMock = vi.fn();
const baseState = {
  commandPaletteOpen: true,
  activeWorkspace: { id: 'ws-1', name: 'WS', rootPath: '/tmp' },
  workspaces: [],
  sessionsByWorkspace: {},
  activeSwarmId: null,
  activeReviewSessionId: 'review-1',
};

vi.mock('@/renderer/app/state', () => ({
  useAppDispatch: () => dispatchMock,
  useAppStateSelector: (sel: (s: typeof baseState) => unknown) => sel(baseState),
}));

vi.mock('@/renderer/app/ThemeProvider', () => ({
  useTheme: () => ({ theme: 'obsidian', setTheme: vi.fn() }),
}));

vi.mock('@/renderer/lib/shortcuts', () => ({
  bindShortcut: vi.fn(() => () => undefined),
}));

vi.mock('@/renderer/lib/voice', () => ({
  isVoiceSupported: () => false,
  startCapture: vi.fn(),
  VoiceBusyError: class VoiceBusyError extends Error {},
}));

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

// Lightweight command primitives. CommandItem renders a real button that fires
// `onSelect` so tests can pick an action without cmdk's layout engine.
vi.mock('@/components/ui/command', () => {
  const Passthrough = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  return {
    CommandDialog: ({ open, children }: { open: boolean; children?: React.ReactNode }) =>
      open ? <div data-testid="cmd-dialog">{children}</div> : null,
    CommandInput: () => <input aria-label="palette-input" />,
    CommandList: Passthrough,
    CommandEmpty: Passthrough,
    CommandGroup: Passthrough,
    CommandSeparator: () => <hr />,
    CommandItem: ({
      children,
      onSelect,
      disabled,
    }: {
      children?: React.ReactNode;
      onSelect?: () => void;
      disabled?: boolean;
    }) => (
      <button type="button" disabled={disabled} onClick={() => onSelect?.()}>
        {children}
      </button>
    ),
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  baseState.commandPaletteOpen = true;
});

import { CommandPalette } from './CommandPalette';

describe('CommandPalette — UX-3 prompt wiring', () => {
  it('opens a themed PromptDialog for "New memory note" and creates on confirm', async () => {
    render(<CommandPalette />);

    fireEvent.click(screen.getByText(/New memory note/i));

    // window.prompt is never used.
    const dialog = await waitFor(() => screen.getByRole('dialog'));
    const input = within(dialog).getByRole('textbox');
    fireEvent.change(input, { target: { value: 'my note' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /create/i }));

    await waitFor(() => {
      expect(createMemoryMock).toHaveBeenCalledWith({ workspaceId: 'ws-1', name: 'my note' });
    });
  });

  it('opens a themed PromptDialog for "Run command…" and runs on confirm', async () => {
    render(<CommandPalette />);

    fireEvent.click(screen.getByText(/Run command in active worktree/i));

    const dialog = await waitFor(() => screen.getByRole('dialog'));
    const input = within(dialog).getByRole('textbox');
    fireEvent.change(input, { target: { value: 'npm test' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /run/i }));

    await waitFor(() => {
      expect(runCommandMock).toHaveBeenCalledWith({
        sessionId: 'review-1',
        command: 'npm test',
      });
    });
  });

  it('does not run the action when the prompt is cancelled', async () => {
    render(<CommandPalette />);

    fireEvent.click(screen.getByText(/New memory note/i));
    const dialog = await waitFor(() => screen.getByRole('dialog'));
    fireEvent.click(within(dialog).getByRole('button', { name: /cancel/i }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(createMemoryMock).not.toHaveBeenCalled();
  });
});
