// @vitest-environment jsdom
//
// Stage-4 a11y — RoleRoster keyboard accessibility.
// Verifies:
//   - Agent card with canFocus=true has tabIndex={0}
//   - Pressing Enter on the card calls onFocusPane with the sessionId
//   - Pressing Space on the card calls onFocusPane with the sessionId
//   - Card without canFocus (no sessionId) has no tabIndex

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { RoleAssignment, SwarmAgent } from '@/shared/types';

// RoleRoster depends on useCanDo.
vi.mock('@/renderer/lib/canDo', () => ({
  useCanDo: () => 20,
}));

import { RoleRoster } from './RoleRoster';

afterEach(() => {
  cleanup();
});

function makeRoster(): RoleAssignment[] {
  return [{ role: 'builder', roleIndex: 1, providerId: 'claude' }];
}

function makeLiveAgent(sessionId: string | undefined): SwarmAgent[] {
  return [
    {
      id: 'a1',
      swarmId: 's1',
      role: 'builder',
      roleIndex: 1,
      providerId: 'claude',
      sessionId: sessionId ?? null,
      status: 'busy',
      inboxPath: '',
      agentKey: 'builder-1',
      autoApprove: false,
    },
  ];
}

/** Find the agent card div (role="button" div, not a <button> element). */
function getAgentCardDiv(): HTMLElement {
  const allButtons = screen.getAllByRole('button');
  // The outer card is a <div role="button">, inner chips are <button> elements.
  const cardDiv = allButtons.find(
    (el) => el.tagName === 'DIV',
  ) as HTMLElement | undefined;
  if (!cardDiv) throw new Error('No agent-card div[role="button"] found');
  return cardDiv;
}

describe('RoleRoster — Stage-4 a11y keyboard fix', () => {
  it('agent card has tabIndex={0} when onFocusPane + sessionId are present', () => {
    const onFocusPane = vi.fn();
    render(
      <RoleRoster
        roster={makeRoster()}
        providers={[]}
        onChange={() => undefined}
        readOnly
        liveAgents={makeLiveAgent('sess-abc')}
        onFocusPane={onFocusPane}
      />,
    );
    const card = getAgentCardDiv();
    expect(card.getAttribute('tabindex')).toBe('0');
  });

  it('pressing Enter on a card calls onFocusPane with the sessionId', () => {
    const onFocusPane = vi.fn();
    render(
      <RoleRoster
        roster={makeRoster()}
        providers={[]}
        onChange={() => undefined}
        readOnly
        liveAgents={makeLiveAgent('sess-abc')}
        onFocusPane={onFocusPane}
      />,
    );
    const card = getAgentCardDiv();
    fireEvent.keyDown(card, { key: 'Enter' });
    expect(onFocusPane).toHaveBeenCalledWith('sess-abc');
  });

  it('pressing Space on a card calls onFocusPane with the sessionId', () => {
    const onFocusPane = vi.fn();
    render(
      <RoleRoster
        roster={makeRoster()}
        providers={[]}
        onChange={() => undefined}
        readOnly
        liveAgents={makeLiveAgent('sess-abc')}
        onFocusPane={onFocusPane}
      />,
    );
    const card = getAgentCardDiv();
    fireEvent.keyDown(card, { key: ' ' });
    expect(onFocusPane).toHaveBeenCalledWith('sess-abc');
  });

  it('card has no tabIndex when sessionId is absent (canFocus=false)', () => {
    const onFocusPane = vi.fn();
    render(
      <RoleRoster
        roster={makeRoster()}
        providers={[]}
        onChange={() => undefined}
        readOnly
        liveAgents={makeLiveAgent(undefined)}
        onFocusPane={onFocusPane}
      />,
    );
    // When canFocus=false the outer div must not have role="button" or tabIndex.
    const agentCardDivs = document.querySelectorAll('div[role="button"]');
    expect(agentCardDivs).toHaveLength(0);
  });
});
