import { describe, it, expect, beforeEach } from 'vitest';
import { WindowRegistry, type WindowHandle } from './registry';
import { buildDetachWorkspace, buildRedockWorkspace } from './detach-handlers';

function fakeWindow(id: number) {
  return {
    id,
    destroyed: false,
    focused: 0,
    closed: 0,
    sent: [] as Array<{ event: string; payload: unknown }>,
    isDestroyed() { return this.destroyed; },
    send(event: string, payload: unknown) { this.sent.push({ event, payload }); },
    focus() { this.focused++; },
    close() { this.closed++; this.destroyed = true; },
  };
}

describe('windows.detachWorkspace / redockWorkspace handlers', () => {
  let reg: WindowRegistry;
  let main: ReturnType<typeof fakeWindow>;
  let created: string[];
  let madeWindows: ReturnType<typeof fakeWindow>[];

  beforeEach(() => {
    reg = new WindowRegistry({ lookupSessionWorkspace: () => null });
    main = fakeWindow(1);
    reg.registerWindow(main, { isMain: true });
    created = [];
    madeWindows = [];
  });

  function detach() {
    return buildDetachWorkspace({
      registry: reg,
      createSecondaryWindow: (wsId, _name) => {
        created.push(wsId);
        const w = fakeWindow(100 + created.length);
        madeWindows.push(w);
        reg.registerWindow(w, { isMain: false });
        reg.assignWorkspace(wsId, w.id);
        return w as unknown as WindowHandle;
      },
      getWorkspaceName: (wsId) => (wsId === 'ws-a' ? 'Alpha' : null),
    });
  }

  it('creates a window for an undetached workspace', async () => {
    await detach()({ workspaceId: 'ws-a' });
    expect(created).toEqual(['ws-a']);
    expect(reg.ownerWindowIdFor('ws-a')).toBe(101);
  });

  it('focuses the existing window instead of double-detaching', async () => {
    const fn = detach();
    await fn({ workspaceId: 'ws-a' });
    await fn({ workspaceId: 'ws-a' });
    expect(created).toEqual(['ws-a']); // no second window
    expect(madeWindows[0].focused).toBe(1); // second call focused the existing one
  });

  it('rejects an unknown workspace', async () => {
    await expect(detach()({ workspaceId: 'ws-nope' })).rejects.toThrow(/unknown workspace/i);
  });

  it('detach of an ALREADY-main-owned workspace still creates a window', async () => {
    // Main ownership is the default state; only a NON-main owner triggers focus.
    reg.assignWorkspace('ws-a', main.id);
    await detach()({ workspaceId: 'ws-a' });
    expect(created).toEqual(['ws-a']); // a real secondary window was made
    expect(reg.ownerWindowIdFor('ws-a')).toBe(101); // ownership moved off main
    expect(main.focused).toBe(0); // main was NOT focused (not the existing-detached path)
  });

  it('redock reassigns to main, seeds the open list, and broadcasts scopes', async () => {
    await detach()({ workspaceId: 'ws-a' });
    const reopened: string[] = [];
    const redock = buildRedockWorkspace({
      registry: reg,
      markWorkspaceOpened: (id) => reopened.push(id),
      refreshOpenWorkspaces: () => {},
    });
    await redock({ workspaceId: 'ws-a' });
    expect(reg.ownerWindowIdFor('ws-a')).toBe(1);
    expect(reopened).toEqual(['ws-a']); // A4 continuity rule
    expect(main.focused).toBe(1);
  });

  it('redock calls refreshOpenWorkspaces (re-broadcast escape hatch)', async () => {
    await detach()({ workspaceId: 'ws-a' });
    let refreshed = 0;
    const redock = buildRedockWorkspace({
      registry: reg,
      markWorkspaceOpened: () => {},
      refreshOpenWorkspaces: () => { refreshed++; },
    });
    await redock({ workspaceId: 'ws-a' });
    expect(refreshed).toBe(1);
  });

  it('redock closes the former owner window (B1 closed-handler then no-ops)', async () => {
    await detach()({ workspaceId: 'ws-a' });
    const former = madeWindows[0];
    const redock = buildRedockWorkspace({
      registry: reg,
      markWorkspaceOpened: () => {},
      refreshOpenWorkspaces: () => {},
    });
    await redock({ workspaceId: 'ws-a' });
    expect(former.closed).toBe(1);
    // Interplay note (verified): the close fires AFTER ownership already moved to
    // main, so B1's closed handler finds an EMPTY owned list for this window →
    // its re-dock loops skip → just broadcastScopes()+refreshOpenWorkspaces()
    // again (harmless). Ownership stays on main.
    expect(reg.ownerWindowIdFor('ws-a')).toBe(1);
  });

  it('redock no-ops cleanly when the workspace is already main-owned', async () => {
    reg.assignWorkspace('ws-a', main.id);
    const reopened: string[] = [];
    let refreshed = 0;
    const redock = buildRedockWorkspace({
      registry: reg,
      markWorkspaceOpened: (id) => reopened.push(id),
      refreshOpenWorkspaces: () => { refreshed++; },
    });
    await redock({ workspaceId: 'ws-a' });
    // Early return: no seed, no re-broadcast, no focus.
    expect(reopened).toEqual([]);
    expect(refreshed).toBe(0);
    expect(main.focused).toBe(0);
    expect(reg.ownerWindowIdFor('ws-a')).toBe(1);
  });

  it('redock no-ops cleanly for an undetached (unowned) workspace', async () => {
    const reopened: string[] = [];
    let refreshed = 0;
    const redock = buildRedockWorkspace({
      registry: reg,
      markWorkspaceOpened: (id) => reopened.push(id),
      refreshOpenWorkspaces: () => { refreshed++; },
    });
    await redock({ workspaceId: 'ws-never-opened' });
    expect(reopened).toEqual([]);
    expect(refreshed).toBe(0);
    expect(main.focused).toBe(0);
  });
});
