// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react';

// MailboxBubble uses useAppState (requires AppStateProvider) — mock it so
// SideChat tests don't need a full provider tree.
vi.mock('./MailboxBubble', () => ({
  MailboxBubble: ({ message }: { message: { body: string } }) => (
    <div data-testid="mailbox-bubble">{message.body}</div>
  ),
}));

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    swarms: {
      broadcast: vi.fn().mockResolvedValue({}),
      sendMessage: vi.fn().mockResolvedValue({}),
    },
  },
}));

vi.mock('@/renderer/lib/pane-context-builder', async (orig) => ({
  ...(await orig() as Record<string, unknown>),
  buildPaneContext: vi.fn().mockResolvedValue('CTX-BLOCK'),
  PANE_DRAG_MIME: 'application/sigmalink-pane',
}));

// Mock KV persistence for pin tests.
const kvStore: Record<string, string> = {};
vi.mock('@/renderer/lib/workspace-ui-kv', () => ({
  readWorkspaceUi: vi.fn((_wsId: string, _panel: string) => {
    const key = `${_wsId}:${_panel}`;
    return Promise.resolve(kvStore[key] ?? null);
  }),
  writeWorkspaceUi: vi.fn((_wsId: string, _panel: string, value: string) => {
    kvStore[`${_wsId}:${_panel}`] = value;
    return Promise.resolve();
  }),
}));

import { SideChat } from './SideChat';
import { PANE_DRAG_MIME } from '@/renderer/lib/pane-context-builder';
import { readWorkspaceUi, writeWorkspaceUi } from '@/renderer/lib/workspace-ui-kv';
import type { Swarm, SwarmMessage } from '@/shared/types';

beforeAll(() => {
  if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

afterEach(() => {
  cleanup();
  for (const k of Object.keys(kvStore)) delete kvStore[k];
  vi.clearAllMocks();
});

function makeSwarm(overrides: Partial<Swarm> = {}): Swarm {
  return {
    id: 'swarm-1',
    workspaceId: 'ws-1',
    name: 'Test Swarm',
    mission: 'test',
    preset: 'squad' as const,
    status: 'running',
    agents: [],
    createdAt: Date.now(),
    endedAt: null,
    ...overrides,
  } as Swarm;
}

function makeMsg(overrides: Partial<SwarmMessage> = {}): SwarmMessage {
  return {
    id: `msg-${Math.random()}`,
    swarmId: 'swarm-1',
    fromAgent: 'operator',
    toAgent: '*',
    kind: 'SAY',
    body: 'hello world',
    ts: Date.now(),
    readAt: null,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Legacy: composer drop zone
// ─────────────────────────────────────────────────────────────────────────────
describe('SideChat drop zone', () => {
  it('appends pane context to draft when PANE_DRAG_MIME is dropped on composer', async () => {
    render(<SideChat swarm={makeSwarm()} messages={[]} />);
    const composerWrapper = screen.getByTestId('sidechat-composer');
    fireEvent.dragOver(composerWrapper, {
      dataTransfer: { types: [PANE_DRAG_MIME] },
    });
    fireEvent.drop(composerWrapper, {
      dataTransfer: {
        types: [PANE_DRAG_MIME],
        getData: () => JSON.stringify({ kind: 'pane', sessionId: 's1', branch: 'b', worktreePath: '/w', providerId: 'claude' }),
      },
    });
    await waitFor(() =>
      expect(screen.getByPlaceholderText(/Broadcast|Message/i)).toHaveProperty('value', expect.stringContaining('CTX-BLOCK')),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FEAT-9: search
// ─────────────────────────────────────────────────────────────────────────────
describe('SideChat search', () => {
  it('renders search input when messages exist', () => {
    render(<SideChat swarm={makeSwarm()} messages={[makeMsg()]} />);
    expect(screen.queryByRole('searchbox')).not.toBeNull();
  });

  it('hides search input when no messages', () => {
    render(<SideChat swarm={makeSwarm()} messages={[]} />);
    expect(screen.queryByRole('searchbox')).toBeNull();
  });

  it('filters messages by body text after debounce', async () => {
    const msgs = [
      makeMsg({ id: 'm1', body: 'alpha beta' }),
      makeMsg({ id: 'm2', body: 'gamma delta' }),
    ];
    render(<SideChat swarm={makeSwarm()} messages={msgs} />);

    const input = screen.getByRole('searchbox');

    await act(async () => {
      fireEvent.change(input, { target: { value: 'alpha' } });
      // Advance past the 120ms debounce using real async wait.
      await new Promise<void>((r) => setTimeout(r, 150));
    });

    expect(screen.queryByText('gamma delta')).toBeNull();
    expect(screen.queryByText('alpha beta')).not.toBeNull();
  });

  it('filters messages by fromAgent', async () => {
    const msgs = [
      makeMsg({ id: 'm1', fromAgent: 'coordinator-1', body: 'task done' }),
      makeMsg({ id: 'm2', fromAgent: 'builder-1', body: 'building' }),
    ];
    render(<SideChat swarm={makeSwarm()} messages={msgs} />);

    const input = screen.getByRole('searchbox');

    await act(async () => {
      fireEvent.change(input, { target: { value: 'coordinator' } });
      await new Promise<void>((r) => setTimeout(r, 150));
    });

    expect(screen.queryByText('building')).toBeNull();
    expect(screen.queryByText('task done')).not.toBeNull();
  });

  it('shows "no match" empty state when search yields nothing', async () => {
    render(<SideChat swarm={makeSwarm()} messages={[makeMsg({ body: 'hello' })]} />);

    const input = screen.getByRole('searchbox');

    await act(async () => {
      fireEvent.change(input, { target: { value: 'zzznomatch' } });
      await new Promise<void>((r) => setTimeout(r, 150));
    });

    const emptyText = document.body.textContent ?? '';
    expect(emptyText).toMatch(/no messages match/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FEAT-9: kind-filter pills
// ─────────────────────────────────────────────────────────────────────────────
describe('SideChat kind-filter pills', () => {
  it('renders filter pill buttons when messages exist', () => {
    render(<SideChat swarm={makeSwarm()} messages={[makeMsg()]} />);
    const sayBtn = screen.queryAllByRole('button').find(
      (b) => b.textContent?.toUpperCase() === 'SAY',
    );
    expect(sayBtn).not.toBeUndefined();
  });

  it('filters to only SAY messages when SAY pill is active', () => {
    const msgs = [
      makeMsg({ id: 'm1', kind: 'SAY', body: 'say message' }),
      makeMsg({ id: 'm2', kind: 'DONE', body: 'done message' }),
    ];
    render(<SideChat swarm={makeSwarm()} messages={msgs} />);

    // Both visible before filtering.
    expect(screen.queryByText('say message')).not.toBeNull();
    expect(screen.queryByText('done message')).not.toBeNull();

    const sayBtn = screen.queryAllByRole('button').find(
      (b) => b.textContent?.toUpperCase() === 'SAY',
    );
    expect(sayBtn).not.toBeUndefined();
    fireEvent.click(sayBtn!);

    // After clicking SAY pill, DONE messages should be hidden.
    expect(screen.queryByText('done message')).toBeNull();
    expect(screen.queryByText('say message')).not.toBeNull();
  });

  it('shows clear button when a pill is active, clears on click', () => {
    render(<SideChat swarm={makeSwarm()} messages={[makeMsg()]} />);

    const sayBtn = screen.queryAllByRole('button').find(
      (b) => b.textContent?.toUpperCase() === 'SAY',
    );
    fireEvent.click(sayBtn!);

    const clearBtn = screen.queryAllByRole('button').find(
      (b) => b.textContent?.toLowerCase() === 'clear',
    );
    expect(clearBtn).not.toBeUndefined();

    fireEvent.click(clearBtn!);

    const stillClear = screen.queryAllByRole('button').find(
      (b) => b.textContent?.toLowerCase() === 'clear',
    );
    expect(stillClear).toBeUndefined();
  });

  it('allows multiple kind filters simultaneously', () => {
    const msgs = [
      makeMsg({ id: 'm1', kind: 'SAY', body: 'say message' }),
      makeMsg({ id: 'm2', kind: 'ACK', body: 'ack message' }),
      makeMsg({ id: 'm3', kind: 'STATUS', body: 'status message' }),
    ];
    render(<SideChat swarm={makeSwarm()} messages={msgs} />);

    const sayBtn = screen.queryAllByRole('button').find((b) => b.textContent?.toUpperCase() === 'SAY');
    const ackBtn = screen.queryAllByRole('button').find((b) => b.textContent?.toUpperCase() === 'ACK');
    fireEvent.click(sayBtn!);
    fireEvent.click(ackBtn!);

    expect(screen.queryByText('status message')).toBeNull();
    expect(screen.queryByText('say message')).not.toBeNull();
    expect(screen.queryByText('ack message')).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FEAT-9: per-message pin toggle with KV persistence
// ─────────────────────────────────────────────────────────────────────────────
describe('SideChat pin toggle', () => {
  it('pin button is present on each message row', async () => {
    const msgs = [makeMsg({ id: 'm1', body: 'pinnable message' })];
    render(<SideChat swarm={makeSwarm()} messages={msgs} />);

    // Pin button may be visually hidden (opacity-0 group-hover) but still in DOM.
    // queryAllByRole finds it by aria-label.
    const pinBtn = screen.queryAllByRole('button').find(
      (b) => b.getAttribute('aria-label') === 'Pin message',
    );
    expect(pinBtn).not.toBeUndefined();
  });

  it('persists pin to KV on toggle and shows pinned section', async () => {
    const msgs = [makeMsg({ id: 'm1', body: 'pin me' })];
    render(<SideChat swarm={makeSwarm()} messages={msgs} />);

    const pinBtn = screen.queryAllByRole('button').find(
      (b) => b.getAttribute('aria-label') === 'Pin message',
    );
    expect(pinBtn).not.toBeUndefined();
    fireEvent.click(pinBtn!);

    await waitFor(() => {
      expect(writeWorkspaceUi).toHaveBeenCalledWith(
        'swarm-1',
        'swarmChat.pins',
        expect.stringContaining('m1'),
      );
    });

    // Pinned section header should appear.
    const pinnedText = document.body.textContent ?? '';
    expect(pinnedText).toMatch(/pinned/i);
  });

  it('hydrates pins from KV on mount', async () => {
    kvStore['swarm-1:swarmChat.pins'] = JSON.stringify(['m1']);

    const msgs = [makeMsg({ id: 'm1', body: 'already pinned' })];
    render(<SideChat swarm={makeSwarm()} messages={msgs} />);

    await waitFor(() => {
      expect(readWorkspaceUi).toHaveBeenCalledWith('swarm-1', 'swarmChat.pins');
    });

    // After KV hydration the Pinned section should appear.
    await waitFor(() => {
      const text = document.body.textContent ?? '';
      expect(text).toMatch(/pinned/i);
    });
  });

  it('unpins: unpin-button appears after pin, pin-button returns after unpin', () => {
    const msgs = [makeMsg({ id: 'm1', body: 'unpin me' })];
    render(<SideChat swarm={makeSwarm()} messages={msgs} />);

    const pinBtn = screen.queryAllByRole('button').find(
      (b) => b.getAttribute('aria-label') === 'Pin message',
    );
    expect(pinBtn).not.toBeUndefined();

    // Pin it — Unpin button should now exist.
    fireEvent.click(pinBtn!);

    const unpinBtn = screen.queryAllByRole('button').find(
      (b) => b.getAttribute('aria-label') === 'Unpin message',
    );
    expect(unpinBtn).not.toBeUndefined();

    // Unpin it — no more Unpin buttons.
    fireEvent.click(unpinBtn!);

    const afterUnpin = screen.queryAllByRole('button').filter(
      (b) => b.getAttribute('aria-label') === 'Unpin message',
    );
    expect(afterUnpin).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FEAT-9: run-gap grouping
// ─────────────────────────────────────────────────────────────────────────────
describe('SideChat run-gap grouping', () => {
  it('shows no group headers when gaps < 10 min', () => {
    const now = Date.now();
    const msgs = [
      makeMsg({ id: 'm1', body: 'first', ts: now }),
      makeMsg({ id: 'm2', body: 'second', ts: now + 60_000 }),
    ];
    render(<SideChat swarm={makeSwarm()} messages={msgs} />);
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/older run/i);
  });

  it('shows collapsible "Older run" header when gap > 10 min', () => {
    const now = Date.now();
    const GAP = 11 * 60 * 1000;
    const msgs = [
      makeMsg({ id: 'm1', body: 'old message', ts: now - GAP }),
      makeMsg({ id: 'm2', body: 'new message', ts: now }),
    ];
    render(<SideChat swarm={makeSwarm()} messages={msgs} />);
    const text = document.body.textContent ?? '';
    expect(text).toMatch(/older run/i);
  });

  it('older run group trigger starts collapsed (aria-expanded=false)', () => {
    const now = Date.now();
    const GAP = 11 * 60 * 1000;
    const msgs = [
      makeMsg({ id: 'm1', body: 'old message', ts: now - GAP }),
      makeMsg({ id: 'm2', body: 'new message', ts: now }),
    ];
    render(<SideChat swarm={makeSwarm()} messages={msgs} />);
    const trigger = screen.queryAllByRole('button').find((b) =>
      (b.textContent ?? '').match(/older run/i),
    );
    expect(trigger).not.toBeUndefined();
    expect(trigger!.getAttribute('aria-expanded')).toBe('false');
  });

  it('expands older run group on click', () => {
    const now = Date.now();
    const GAP = 11 * 60 * 1000;
    const msgs = [
      makeMsg({ id: 'm1', body: 'old message', ts: now - GAP }),
      makeMsg({ id: 'm2', body: 'new message', ts: now }),
    ];
    render(<SideChat swarm={makeSwarm()} messages={msgs} />);

    const trigger = screen.queryAllByRole('button').find((b) =>
      (b.textContent ?? '').match(/older run/i),
    );
    expect(trigger).not.toBeUndefined();
    fireEvent.click(trigger!);

    // Radix Collapsible updates data-state synchronously on click.
    expect(trigger!.getAttribute('aria-expanded')).toBe('true');
  });

  it('newest run always shows its messages without a collapse trigger', () => {
    const now = Date.now();
    const GAP = 11 * 60 * 1000;
    const msgs = [
      makeMsg({ id: 'm1', body: 'old message', ts: now - GAP }),
      makeMsg({ id: 'm2', body: 'new message', ts: now }),
    ];
    render(<SideChat swarm={makeSwarm()} messages={msgs} />);
    expect(screen.queryByText('new message')).not.toBeNull();
  });
});
