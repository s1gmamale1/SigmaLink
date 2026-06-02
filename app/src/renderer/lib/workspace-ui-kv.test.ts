import { describe, it, expect, beforeEach, vi } from 'vitest';

const { store } = vi.hoisted(() => ({ store: new Map<string, string>() }));
vi.mock('@/renderer/lib/rpc', () => ({
  rpcSilent: {
    kv: {
      get: vi.fn(async (k: string) => (store.has(k) ? store.get(k)! : null)),
      set: vi.fn(async (k: string, v: string) => {
        store.set(k, v);
      }),
    },
  },
}));

import { workspaceUiKey, readWorkspaceUi, writeWorkspaceUi } from './workspace-ui-kv';

beforeEach(() => store.clear());

describe('workspace-ui-kv', () => {
  it('keys per workspace', () => {
    expect(workspaceUiKey('ws-1', 'memory.cols')).toBe('ui.ws-1.memory.cols');
  });

  it('writes + reads the scoped value', async () => {
    await writeWorkspaceUi('ws-1', 'rightRail.width', '500');
    expect(await readWorkspaceUi('ws-1', 'rightRail.width')).toBe('500');
    expect(store.get('ui.ws-1.rightRail.width')).toBe('500');
  });

  it('falls through to the legacy global key when the scoped value is unset', async () => {
    store.set('rightRail.width', '480'); // pre-RSP-1 global value
    expect(await readWorkspaceUi('ws-1', 'rightRail.width', 'rightRail.width')).toBe('480');
  });

  it('prefers the scoped value over the legacy key', async () => {
    store.set('rightRail.width', '480');
    store.set('ui.ws-1.rightRail.width', '600');
    expect(await readWorkspaceUi('ws-1', 'rightRail.width', 'rightRail.width')).toBe('600');
  });

  it('returns null when neither exists', async () => {
    expect(await readWorkspaceUi('ws-1', 'nope', 'also-nope')).toBeNull();
  });
});
