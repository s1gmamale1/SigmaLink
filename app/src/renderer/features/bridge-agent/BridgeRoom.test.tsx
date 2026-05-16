// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Workspace } from '@/shared/types';

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  send: vi.fn(),
  kvGet: vi.fn(),
  kvSet: vi.fn(),
  onEvent: vi.fn(),
}));

const workspace = vi.hoisted<Workspace>(() => ({
  id: 'workspace-1',
  name: 'SigmaLink',
  rootPath: '/tmp/sigmalink',
  repoRoot: '/tmp/sigmalink',
  repoMode: 'git',
  createdAt: 1,
  lastOpenedAt: 1,
}));

vi.mock('@/renderer/app/state', () => ({
  useAppState: () => ({
    state: {
      activeWorkspace: workspace,
      workspaces: [workspace],
    },
    dispatch: mocks.dispatch,
  }),
}));

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    assistant: {
      send: mocks.send,
    },
    kv: {
      get: mocks.kvGet,
      set: mocks.kvSet,
    },
  },
  rpcSilent: {
    kv: {
      get: vi.fn().mockResolvedValue(null),
    },
    ruflo: {
      health: vi.fn().mockResolvedValue({ state: 'absent' }),
      'patterns.search': vi.fn().mockResolvedValue({ ok: true, results: [] }),
      'patterns.store': vi.fn().mockResolvedValue({ ok: true }),
    },
  },
  onEvent: mocks.onEvent,
}));

vi.mock('@/renderer/lib/voice', () => ({
  isVoiceSupported: () => false,
  startCapture: vi.fn(),
  VoiceBusyError: class VoiceBusyError extends Error {},
}));

vi.mock('@/renderer/lib/notifications', () => ({
  playDing: vi.fn(),
}));

vi.mock('@/renderer/lib/canDo', () => ({
  useCanDo: () => false,
}));

import { BridgeRoom } from './BridgeRoom';

const rows = [
  {
    id: 'conversation-1',
    workspaceId: workspace.id,
    kind: 'assistant' as const,
    createdAt: Date.now() - 120_000,
    title: 'Launch the workspace panes',
    lastMessageAt: Date.now() - 60_000,
    messageCount: 2,
    claudeSessionId: '11111111-1111-4111-8111-111111111111',
  },
  {
    id: 'conversation-2',
    workspaceId: workspace.id,
    kind: 'assistant' as const,
    createdAt: Date.now() - 240_000,
    title: 'Older resumable task',
    lastMessageAt: Date.now() - 180_000,
    messageCount: 1,
    claudeSessionId: '22222222-2222-4222-8222-222222222222',
  },
];

const hydrated = {
  conversation: {
    id: 'conversation-1',
    workspaceId: workspace.id,
    createdAt: rows[0].createdAt,
    claudeSessionId: rows[0].claudeSessionId,
  },
  messages: [
    {
      id: 'message-user-1',
      conversationId: 'conversation-1',
      role: 'user' as const,
      content: 'Please launch the workspace panes',
      toolCallId: null,
      createdAt: Date.now() - 90_000,
    },
    {
      id: 'message-assistant-1',
      conversationId: 'conversation-1',
      role: 'assistant' as const,
      content: '',
      toolCallId: 'sigma-in-flight:turn-1',
      createdAt: Date.now() - 80_000,
    },
  ],
};

function installSigma() {
  const invoke = vi.fn(async (channel: string, input: unknown) => {
    if (channel === 'assistant.conversations.list') {
      return { ok: true, data: rows };
    }
    if (channel === 'assistant.conversations.get') {
      const conversationId = (input as { conversationId: string }).conversationId;
      return {
        ok: true,
        data: conversationId === 'conversation-1'
          ? hydrated
          : {
              conversation: { ...hydrated.conversation, id: conversationId },
              messages: [],
            },
      };
    }
    return { ok: true, data: null };
  });
  Object.defineProperty(window, 'sigma', {
    configurable: true,
    value: {
      invoke,
      eventOn: vi.fn(() => vi.fn()),
    },
  });
  return invoke;
}

describe('<BridgeRoom /> resume UI', () => {
  beforeEach(() => {
    mocks.dispatch.mockReset();
    mocks.send.mockResolvedValue({ conversationId: 'conversation-1', turnId: 'turn-2' });
    mocks.kvGet.mockResolvedValue('conversation-1');
    mocks.kvSet.mockResolvedValue(undefined);
    mocks.onEvent.mockReturnValue(() => undefined);
    installSigma();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders a compact rail dropdown with resumable conversation rows', async () => {
    render(<BridgeRoom variant="rail" />);

    const trigger = await screen.findByLabelText('Conversation menu');
    expect(trigger.textContent).toContain('Launch the workspace panes');
    expect(trigger.textContent).toContain('Resumable');

    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(trigger);

    expect(await screen.findByText('Older resumable task')).toBeTruthy();
    expect(screen.getAllByText('Resumable').length).toBeGreaterThanOrEqual(2);
  });

  it('shows resume and interrupted-turn banners after hydrating a resumable conversation', async () => {
    render(<BridgeRoom variant="standalone" />);

    expect((await screen.findByTestId('bridge-resume-banner')).textContent).toMatch(
      /Resuming chat from/,
    );
    expect((await screen.findByTestId('bridge-interrupted-banner')).textContent).toMatch(
      /Interrupted turn from/,
    );
  });

  it('retries an interrupted turn with the previous user message', async () => {
    render(<BridgeRoom variant="standalone" />);

    await screen.findByTestId('bridge-interrupted-banner');
    fireEvent.click(screen.getByText('Retry'));

    await waitFor(() => {
      expect(mocks.send).toHaveBeenCalledWith({
        workspaceId: workspace.id,
        conversationId: 'conversation-1',
        prompt: 'Please launch the workspace panes',
      });
    });
    await waitFor(() => {
      expect(screen.queryByTestId('bridge-interrupted-banner')).toBeNull();
    });
  });
});
