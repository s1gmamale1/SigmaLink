// @vitest-environment jsdom
//
// RTL-based tests for the N2 room-nav active-cue changes (Stage 2 polish lane):
//   • active dropdown item uses bg-primary/15 + text-primary + aria-current="true"
//   • trigger button gains bg-accent/30 + text-foreground cue when room !== 'command'
//   • trigger button reverts to muted-foreground when room === 'command'
//
// vi.mock factories are hoisted; state is shared via a module-level `_room`
// variable and mutated between tests.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { RoomId } from '@/renderer/app/state';

// ── Shared mock state (mutated per-test) ─────────────────────────────────────
let _room: RoomId = 'command';

// ── Module mocks ─────────────────────────────────────────────────────────────
vi.mock('@/renderer/lib/rpc', () => ({ rpc: {} }));
vi.mock('@/renderer/lib/drag-region', () => ({
  dragStyle: () => ({}),
  noDragStyle: () => ({}),
}));

// PERF-3: RoomsMenuButton migrated to useAppStateSelector + useAppDispatch.
// Each mock fn builds the state lazily (getter reads `_room` at call-time) so
// the selector sees the per-test room — same lazy pattern as the old getter.
vi.mock('@/renderer/app/state', () => {
  const buildState = () => ({
    get room() { return _room; },
    activeWorkspace: { id: 'ws-1', name: 'Test' },
  });
  return {
    useAppStateSelector: <T,>(sel: (s: ReturnType<typeof buildState>) => T) => sel(buildState()),
    useAppDispatch: () => vi.fn(),
    useAppState: () => ({ state: buildState(), dispatch: vi.fn() }),
    appStateReducer: (s: unknown) => s,
    initialAppState: { room: 'workspaces', roomByWorkspace: {} },
  };
});

// ── Helpers ───────────────────────────────────────────────────────────────────
afterEach(() => {
  cleanup();
});

import { RoomsMenuButton } from './RoomsMenuButton';

function renderButton(room: RoomId) {
  _room = room;
  return render(<RoomsMenuButton />);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('<RoomsMenuButton /> trigger active cue', () => {
  it('trigger has text-muted-foreground when room is command (default)', () => {
    renderButton('command');
    const trigger = screen.getByRole('button', { name: /open rooms menu/i });
    const classes = trigger.className.split(/\s+/);
    expect(classes).toContain('text-muted-foreground');
    expect(classes).not.toContain('bg-accent/30');
  });

  it('trigger gains text-foreground + bg-accent/30 when room is not command', () => {
    renderButton('swarm');
    const trigger = screen.getByRole('button', { name: /open rooms menu/i });
    const classes = trigger.className.split(/\s+/);
    expect(classes).toContain('text-foreground');
    expect(classes).toContain('bg-accent/30');
    expect(classes).not.toContain('text-muted-foreground');
  });
});

describe('<RoomsMenuButton /> dropdown active item vocabulary', () => {
  it('active dropdown item has bg-primary/15, text-primary, and aria-current=true', () => {
    renderButton('swarm');
    const trigger = screen.getByRole('button', { name: /open rooms menu/i });
    // Open the dropdown via pointer events (Radix DropdownMenu).
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(trigger);

    const activeItem = document
      .querySelector('[data-room-id="swarm"]') as HTMLElement | null;
    expect(activeItem).not.toBeNull();

    const classes = (activeItem?.className ?? '').split(/\s+/);
    expect(classes).toContain('bg-primary/15');
    expect(classes).toContain('text-primary');
    expect(activeItem?.getAttribute('aria-current')).toBe('true');
  });

  it('inactive dropdown items do not carry bg-primary/15 or aria-current', () => {
    renderButton('swarm');
    const trigger = screen.getByRole('button', { name: /open rooms menu/i });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(trigger);

    // 'command' room is in the list but is not the active room.
    const inactiveItem = document
      .querySelector('[data-room-id="command"]') as HTMLElement | null;
    expect(inactiveItem).not.toBeNull();

    const classes = (inactiveItem?.className ?? '').split(/\s+/);
    expect(classes).not.toContain('bg-primary/15');
    expect(inactiveItem?.getAttribute('aria-current')).toBeNull();
  });
});
