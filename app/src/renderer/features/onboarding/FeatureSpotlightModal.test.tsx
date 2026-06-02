// @vitest-environment jsdom
//
// ONB-1 — Feature Spotlight modal.
//
// Tests:
//   - hidden until onboarding done + coachmark loaded + unseen
//   - hidden once seen
//   - shown when gates open; renders four feature cards
//   - "Show me" on Memory/Swarm routes via SET_ROOM and marks seen
//   - "Show me" on Voice routes to Settings + stages the Voice tab
//   - "Open ⌘K" toggles the command palette
//   - Skip marks seen without routing

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const dispatch = vi.fn();
let mockState: { onboarded: boolean } = { onboarded: true };
vi.mock('@/renderer/app/state', () => ({
  useAppState: () => ({ state: mockState, dispatch }),
}));

const markSeen = vi.fn();
let coachmark: { loaded: boolean; seen: boolean; markSeen: () => void } = {
  loaded: true,
  seen: false,
  markSeen,
};
vi.mock('@/renderer/features/command-room/use-coachmark', () => ({
  useCoachmark: () => coachmark,
}));

import { FeatureSpotlightModal } from './FeatureSpotlightModal';

describe('FeatureSpotlightModal — ONB-1', () => {
  beforeEach(() => {
    dispatch.mockClear();
    markSeen.mockClear();
    mockState = { onboarded: true };
    coachmark = { loaded: true, seen: false, markSeen };
  });
  afterEach(() => cleanup());

  it('is hidden until onboarding completes', () => {
    mockState = { onboarded: false };
    render(<FeatureSpotlightModal />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('is hidden while the coachmark lookup is still loading', () => {
    coachmark = { loaded: false, seen: false, markSeen };
    render(<FeatureSpotlightModal />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('is hidden once already seen', () => {
    coachmark = { loaded: true, seen: true, markSeen };
    render(<FeatureSpotlightModal />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows the modal with four feature cards when gates open', () => {
    render(<FeatureSpotlightModal />);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText('Memory')).toBeTruthy();
    expect(screen.getByText('Swarms')).toBeTruthy();
    expect(screen.getByText('Voice')).toBeTruthy();
    expect(screen.getByText('Command palette')).toBeTruthy();
  });

  it('Memory "Show me" routes to the Memory room and marks seen', () => {
    render(<FeatureSpotlightModal />);
    const showButtons = screen.getAllByRole('button', { name: 'Show me' });
    // Cards render in order: Memory, Swarms, Voice. ⌘K uses a different label.
    fireEvent.click(showButtons[0]!);
    expect(dispatch).toHaveBeenCalledWith({ type: 'SET_ROOM', room: 'memory' });
    expect(markSeen).toHaveBeenCalledTimes(1);
  });

  it('Voice "Show me" routes to Settings and stages the Voice tab', () => {
    render(<FeatureSpotlightModal />);
    const showButtons = screen.getAllByRole('button', { name: 'Show me' });
    fireEvent.click(showButtons[2]!); // Voice is the 3rd "Show me"
    expect(dispatch).toHaveBeenCalledWith({ type: 'SET_ROOM', room: 'settings' });
    expect(dispatch).toHaveBeenCalledWith({ type: 'SET_SETTINGS_TAB', tab: 'voice' });
    expect(markSeen).toHaveBeenCalledTimes(1);
  });

  it('"Open ⌘K" toggles the command palette and marks seen', () => {
    render(<FeatureSpotlightModal />);
    fireEvent.click(screen.getByRole('button', { name: /open ⌘k/i }));
    expect(dispatch).toHaveBeenCalledWith({ type: 'SET_COMMAND_PALETTE', open: true });
    expect(markSeen).toHaveBeenCalledTimes(1);
  });

  it('Skip marks seen without routing', () => {
    render(<FeatureSpotlightModal />);
    fireEvent.click(screen.getByRole('button', { name: /skip/i }));
    expect(markSeen).toHaveBeenCalledTimes(1);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
