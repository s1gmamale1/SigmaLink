// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The module reads window.sigma at call time (no module-level cache), so
// resetModules + dynamic import gives the cleanest per-test isolation in case
// an implementation change ever captures the value at load time.
describe('window-context', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    // Restore window.sigma to a clean state so other tests in the suite are
    // not affected by whatever shape we set here.
    delete (window as unknown as { sigma?: unknown }).sigma;
  });

  it('reads scope + main flag from the preload bridge', async () => {
    (window as any).sigma = { windowContext: { windowId: 7, isMain: false, workspaceScope: 'ws-a' } };
    const { getWindowContext, isMainWindow, getWorkspaceScope } = await import('./window-context');
    expect(getWindowContext()).toEqual({ windowId: 7, isMain: false, workspaceScope: 'ws-a' });
    expect(isMainWindow()).toBe(false);
    expect(getWorkspaceScope()).toBe('ws-a');
  });

  it('defaults to main-window semantics when the bridge predates multi-window', async () => {
    (window as any).sigma = {};
    const { isMainWindow, getWorkspaceScope } = await import('./window-context');
    expect(isMainWindow()).toBe(true);
    expect(getWorkspaceScope()).toBeNull();
  });

  it('empty-string workspaceScope degrades to null', async () => {
    (window as any).sigma = { windowContext: { windowId: null, isMain: true, workspaceScope: '' } };
    const { getWindowContext, getWorkspaceScope } = await import('./window-context');
    expect(getWindowContext()).toEqual({ windowId: null, isMain: true, workspaceScope: null });
    expect(getWorkspaceScope()).toBeNull();
  });

  it('window.sigma entirely undefined → main-window defaults', async () => {
    delete (window as unknown as { sigma?: unknown }).sigma;
    const { getWindowContext, isMainWindow, getWorkspaceScope } = await import('./window-context');
    expect(getWindowContext()).toEqual({ windowId: null, isMain: true, workspaceScope: null });
    expect(isMainWindow()).toBe(true);
    expect(getWorkspaceScope()).toBeNull();
  });
});
