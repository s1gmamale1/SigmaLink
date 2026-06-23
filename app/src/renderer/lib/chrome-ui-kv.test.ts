import { beforeEach, describe, expect, it, vi } from 'vitest';

const getWorkspaceScopeMock = vi.fn<() => string | null>();
vi.mock('@/renderer/lib/window-context', () => ({
  getWorkspaceScope: () => getWorkspaceScopeMock(),
}));

const readWorkspaceUiMock = vi.fn<(...a: unknown[]) => Promise<string | null>>(
  async () => 'scoped-val',
);
const writeWorkspaceUiMock = vi.fn<(...a: unknown[]) => Promise<undefined>>(async () => undefined);
vi.mock('@/renderer/lib/workspace-ui-kv', () => ({
  readWorkspaceUi: (...a: unknown[]) => readWorkspaceUiMock(...a),
  writeWorkspaceUi: (...a: unknown[]) => writeWorkspaceUiMock(...a),
  workspaceUiKey: (ws: string, panel: string) => `ui.${ws}.${panel}`,
}));

const kvGetMock = vi.fn<(k: string) => Promise<string | null>>(async () => 'global-val');
const kvSetMock = vi.fn<(k: string, v: string) => Promise<void>>(async () => undefined);
vi.mock('@/renderer/lib/rpc', () => ({
  rpcSilent: { kv: { get: (...a: [string]) => kvGetMock(...a), set: (...a: [string, string]) => kvSetMock(...a) } },
}));

import { chromeUiKey, readChromeUi, writeChromeUi } from './chrome-ui-kv';

beforeEach(() => vi.clearAllMocks());

describe('chrome-ui-kv — main window (no scope → GLOBAL key)', () => {
  beforeEach(() => getWorkspaceScopeMock.mockReturnValue(null));

  it('chromeUiKey returns the global key', () => {
    expect(chromeUiKey('rightRail.open', 'rightRail.open')).toBe('rightRail.open');
  });

  it('readChromeUi reads the GLOBAL key and never the per-workspace key', async () => {
    const v = await readChromeUi('app.sidebar.width', 'sidebar.width');
    expect(kvGetMock).toHaveBeenCalledWith('app.sidebar.width');
    expect(readWorkspaceUiMock).not.toHaveBeenCalled();
    expect(v).toBe('global-val');
  });

  it('writeChromeUi writes the GLOBAL key', async () => {
    await writeChromeUi('app.sidebar.width', 'sidebar.width', '320');
    expect(kvSetMock).toHaveBeenCalledWith('app.sidebar.width', '320');
    expect(writeWorkspaceUiMock).not.toHaveBeenCalled();
  });
});

describe('chrome-ui-kv — scoped window (per-window-scope key)', () => {
  beforeEach(() => getWorkspaceScopeMock.mockReturnValue('ws-a'));

  it('chromeUiKey returns the per-scope key', () => {
    expect(chromeUiKey('rightRail.open', 'rightRail.open')).toBe('ui.ws-a.rightRail.open');
  });

  it('readChromeUi reads the per-scope key with a global fallback', async () => {
    const v = await readChromeUi('rightRail.width', 'rightRail.width');
    expect(readWorkspaceUiMock).toHaveBeenCalledWith('ws-a', 'rightRail.width', 'rightRail.width');
    expect(kvGetMock).not.toHaveBeenCalled();
    expect(v).toBe('scoped-val');
  });

  it('writeChromeUi writes the per-scope key', async () => {
    await writeChromeUi('rightRail.open', 'rightRail.open', 'false');
    expect(writeWorkspaceUiMock).toHaveBeenCalledWith('ws-a', 'rightRail.open', 'false');
    expect(kvSetMock).not.toHaveBeenCalled();
  });
});
