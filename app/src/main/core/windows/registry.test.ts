import { describe, it, expect, beforeEach } from 'vitest';
import {
  WindowRegistry,
  type WindowHandle,
} from './registry';

function fakeWindow(id: number): WindowHandle & { sent: Array<{ event: string; payload: unknown }>; destroyed: boolean } {
  const sent: Array<{ event: string; payload: unknown }> = [];
  return {
    id,
    sent,
    destroyed: false,
    isDestroyed() { return this.destroyed; },
    send(event: string, payload: unknown) { sent.push({ event, payload }); },
    focus() { /* recorded only when a test needs it */ },
    close() { this.destroyed = true; },
  };
}

describe('WindowRegistry', () => {
  let reg: WindowRegistry;
  let main: ReturnType<typeof fakeWindow>;

  beforeEach(() => {
    reg = new WindowRegistry({ lookupSessionWorkspace: () => null });
    main = fakeWindow(1);
    reg.registerWindow(main, { isMain: true });
  });

  it('routes sendToAll to every live window and skips destroyed ones', () => {
    const w2 = fakeWindow(2);
    reg.registerWindow(w2, { isMain: false });
    w2.destroyed = true;
    reg.sendToAll('app:navigate', { pane: 'settings' });
    expect(main.sent).toHaveLength(1);
    expect(w2.sent).toHaveLength(0);
  });

  it('assigns workspace ownership and routes sendToWorkspaceOwner', () => {
    const w2 = fakeWindow(2);
    reg.registerWindow(w2, { isMain: false });
    reg.assignWorkspace('ws-a', 2);
    reg.sendToWorkspaceOwner('ws-a', 'x:ev', { v: 1 });
    expect(w2.sent).toEqual([{ event: 'x:ev', payload: { v: 1 } }]);
    expect(main.sent).toHaveLength(0);
  });

  it('falls back to sendToAll for an unowned workspace', () => {
    reg.sendToWorkspaceOwner('ws-unknown', 'x:ev', {});
    expect(main.sent).toHaveLength(1);
  });

  it('assignWorkspace throws on an unknown windowId', () => {
    expect(() => reg.assignWorkspace('ws-x', 999)).toThrow(/unknown windowId/);
  });

  it('re-registering an existing windowId replaces the handle (ownership untouched)', () => {
    const w2a = fakeWindow(2);
    reg.registerWindow(w2a, { isMain: false });
    reg.assignWorkspace('ws-a', 2);
    const w2b = fakeWindow(2);
    reg.registerWindow(w2b, { isMain: false });
    reg.sendToWorkspaceOwner('ws-a', 'x:ev', { v: 1 });
    expect(w2b.sent).toEqual([{ event: 'x:ev', payload: { v: 1 } }]);
    expect(w2a.sent).toHaveLength(0);
    expect(reg.ownerWindowIdFor('ws-a')).toBe(2);
  });

  it('resolves session owner through the cache, then the injected lookup', () => {
    const lookups: string[] = [];
    reg = new WindowRegistry({
      lookupSessionWorkspace: (sid) => { lookups.push(sid); return 'ws-a'; },
    });
    reg.registerWindow(main, { isMain: true });
    const w2 = fakeWindow(2);
    reg.registerWindow(w2, { isMain: false });
    reg.assignWorkspace('ws-a', 2);

    reg.sendToSessionOwner('sess-1', 'pty:data', { sessionId: 'sess-1', data: 'x' });
    reg.sendToSessionOwner('sess-1', 'pty:data', { sessionId: 'sess-1', data: 'y' });
    expect(w2.sent).toHaveLength(2);
    expect(lookups).toEqual(['sess-1']); // second send hit the cache
  });

  it('falls back to sendToAll when the session lookup returns null — and caches the negative (lookup runs ONCE)', () => {
    let lookups = 0;
    reg = new WindowRegistry({
      lookupSessionWorkspace: () => { lookups += 1; return null; },
    });
    reg.registerWindow(main, { isMain: true });
    reg.sendToSessionOwner('sess-ghost', 'pty:data', {});
    reg.sendToSessionOwner('sess-ghost', 'pty:data', {});
    expect(main.sent).toHaveLength(2); // both delivered via the sendToAll fallback
    expect(lookups).toBe(1); // negative entry cached — no per-chunk DB re-query
  });

  it('unregisterWindow returns the workspaces it owned and re-docks them to main', () => {
    const w2 = fakeWindow(2);
    reg.registerWindow(w2, { isMain: false });
    reg.assignWorkspace('ws-a', 2);
    reg.assignWorkspace('ws-b', 2);
    const released = reg.unregisterWindow(2);
    expect(released.sort()).toEqual(['ws-a', 'ws-b']);
    // re-assignment is the CALLER's job (main.ts closed handler) — registry only releases
    expect(reg.ownerWindowIdFor('ws-a')).toBeNull();
  });

  it('broadcastScopes sends one scope snapshot to every window', () => {
    const w2 = fakeWindow(2);
    reg.registerWindow(w2, { isMain: false });
    reg.assignWorkspace('ws-a', 2);
    reg.broadcastScopes();
    const payload = main.sent[0];
    expect(payload.event).toBe('app:window-scope-changed');
    expect(payload.payload).toEqual({
      scopes: [
        { windowId: 1, isMain: true, workspaceIds: [] },
        { windowId: 2, isMain: false, workspaceIds: ['ws-a'] },
      ],
    });
    expect(w2.sent[0]).toEqual(payload);
  });

  it('forgetSession evicts the routing cache', () => {
    reg = new WindowRegistry({ lookupSessionWorkspace: () => 'ws-a' });
    reg.registerWindow(main, { isMain: true });
    reg.sendToSessionOwner('s1', 'pty:data', {});
    reg.forgetSession('s1');
    reg.sendToSessionOwner('s1', 'pty:data', {});
    expect(main.sent).toHaveLength(2);
  });
});
