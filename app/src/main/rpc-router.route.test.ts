import { describe, it, expect } from 'vitest';
import { resolveAssistantRoute } from './rpc-router';

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
});
