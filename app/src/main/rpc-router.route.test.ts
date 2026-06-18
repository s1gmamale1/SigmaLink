import { describe, it, expect } from 'vitest';
import { resolveAssistantRoute, resolveBrowserHostWindowId, isSessionRoutedEvent } from './rpc-router';

describe('resolveAssistantRoute', () => {
  const convWs = (id: string) => (id === 'c-owned' ? 'ws-conv' : null);

  it('routes by explicit workspaceId first', () => {
    expect(resolveAssistantRoute('assistant:dispatch-echo', { workspaceId: 'ws-1', sessionId: 's', conversationId: 'c' }, convWs))
      .toEqual({ kind: 'workspace', workspaceId: 'ws-1' });
    expect(resolveAssistantRoute('browser:state', { workspaceId: 'ws-2' }, convWs))
      .toEqual({ kind: 'workspace', workspaceId: 'ws-2' });
  });

  it('falls back to sessionId for pane events without a workspaceId', () => {
    expect(resolveAssistantRoute('assistant:pane-closed', { sessionId: 's-9' }, convWs))
      .toEqual({ kind: 'session', sessionId: 's-9' });
    expect(resolveAssistantRoute('assistant:pane-event', { sessionId: 's-7', conversationId: 'c' }, convWs))
      .toEqual({ kind: 'session', sessionId: 's-7' });
  });

  it('resolves conversationId → workspace for chat-stream events', () => {
    expect(resolveAssistantRoute('assistant:state', { conversationId: 'c-owned', turnId: 't' }, convWs))
      .toEqual({ kind: 'workspace', workspaceId: 'ws-conv' });
    expect(resolveAssistantRoute('assistant:tool-trace', { conversationId: 'c-owned' }, convWs))
      .toEqual({ kind: 'workspace', workspaceId: 'ws-conv' });
  });

  it('falls back to broadcast when nothing resolves or the event is not routed', () => {
    expect(resolveAssistantRoute('assistant:state', { conversationId: 'c-unknown' }, convWs)).toEqual({ kind: 'all' });
    expect(resolveAssistantRoute('assistant:state', {}, convWs)).toEqual({ kind: 'all' });
    expect(resolveAssistantRoute('memory:changed', { workspaceId: 'ws-1' }, convWs)).toEqual({ kind: 'all' });
    expect(resolveAssistantRoute('assistant:state', null, convWs)).toEqual({ kind: 'all' });
  });

  // Phase-2 external control — NON-IDEMPOTENT side effects MUST reach a single
  // owner window (else N windows double-execute: split twice, detach twice, send
  // a message twice). Regression-pin both the routed set AND the broadcast set so
  // a future edit can't silently flip an event's delivery (the agent-attention
  // routing-drop lesson).
  it('routes Phase-2 non-idempotent control events to a single owner window', () => {
    expect(resolveAssistantRoute('assistant:split-pane', { sessionId: 's-1', paneId: 's-1', direction: 'horizontal', provider: 'claude' }, convWs))
      .toEqual({ kind: 'session', sessionId: 's-1' });
    expect(resolveAssistantRoute('assistant:detach-window', { workspaceId: 'ws-1' }, convWs))
      .toEqual({ kind: 'workspace', workspaceId: 'ws-1' });
    expect(resolveAssistantRoute('assistant:redock-window', { workspaceId: 'ws-1' }, convWs))
      .toEqual({ kind: 'workspace', workspaceId: 'ws-1' });
  });

  it('does NOT route idempotent/global control events (they broadcast to every window)', () => {
    for (const ev of [
      'assistant:stop-pane',
      'assistant:set-pane-minimised',
      'assistant:set-display-provider',
      'assistant:rename-workspace',
      'assistant:resume-swarm',
      'assistant:kill-swarm',
    ]) {
      expect(resolveAssistantRoute(ev, { sessionId: 's', workspaceId: 'w' }, convWs), ev).toEqual({ kind: 'all' });
    }
  });
});

describe('isSessionRoutedEvent', () => {
  it('keeps pty:* AND agent:attention session-routed (regression: agent-attention must reach only the owning window)', () => {
    expect(isSessionRoutedEvent('pty:data')).toBe(true);
    expect(isSessionRoutedEvent('pty:exit')).toBe(true);
    expect(isSessionRoutedEvent('pty:error')).toBe(true);
    expect(isSessionRoutedEvent('pty:link-detected')).toBe(true);
    expect(isSessionRoutedEvent('agent:attention')).toBe(true);
  });
  it('does not session-route workspace-routed or unrelated events', () => {
    expect(isSessionRoutedEvent('assistant:state')).toBe(false);
    expect(isSessionRoutedEvent('browser:state')).toBe(false);
    expect(isSessionRoutedEvent('memory:changed')).toBe(false);
  });
});

describe('resolveBrowserHostWindowId', () => {
  const ids = { ownerWindowIdFor: (ws: string) => (ws === 'ws-detached' ? 1001 : null) };

  it('prefers the owner window when ownership is known', () => {
    expect(resolveBrowserHostWindowId('ws-detached', ids, 1, [1, 1001])).toBe(1001);
  });
  it('falls back to the focused window when ownership is unknown', () => {
    expect(resolveBrowserHostWindowId('ws-unowned', ids, 1, [1, 1001])).toBe(1);
  });
  it('falls back to the first window when nothing is focused', () => {
    expect(resolveBrowserHostWindowId('ws-unowned', ids, null, [7, 8])).toBe(7);
  });
  it('returns null when there are no windows', () => {
    expect(resolveBrowserHostWindowId('ws-unowned', ids, null, [])).toBeNull();
  });
});
