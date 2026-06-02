// @vitest-environment jsdom
//
// ONB-1 — useWhatsNew hook.
//
// Tests:
//   - gated off until uiBoot && onboarded
//   - FIRST RUN (last === null): NO toast, but the current version is seeded
//   - UPGRADE (last !== current): toast.info fires once + version persisted
//   - SAME version: no toast, no write
//   - the toast action dispatches SET_ROOM → settings

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';

const getVersion = vi.fn<() => Promise<string>>();
const kvGet = vi.fn<(k: string) => Promise<string | null>>();
const kvSet = vi.fn<(k: string, v: string) => Promise<void>>();

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    app: { getVersion: () => getVersion() },
    kv: { set: (k: string, v: string) => kvSet(k, v) },
  },
  rpcSilent: {
    kv: { get: (k: string) => kvGet(k) },
  },
}));

const toastInfo = vi.fn();
vi.mock('sonner', () => ({ toast: { info: (...a: unknown[]) => toastInfo(...a) } }));

const dispatch = vi.fn();
let mockState: { uiBoot: boolean; onboarded: boolean } = { uiBoot: true, onboarded: true };
vi.mock('@/renderer/app/state', () => ({
  useAppState: () => ({ state: mockState, dispatch }),
}));

import { useWhatsNew, LAST_SEEN_KEY } from './use-whats-new';

function Host() {
  useWhatsNew();
  return null;
}

describe('useWhatsNew — ONB-1', () => {
  beforeEach(() => {
    getVersion.mockReset().mockResolvedValue('2.0.0');
    kvGet.mockReset();
    kvSet.mockReset().mockResolvedValue(undefined);
    toastInfo.mockReset();
    dispatch.mockReset();
    mockState = { uiBoot: true, onboarded: true };
  });
  afterEach(() => cleanup());

  it('does nothing until uiBoot && onboarded', async () => {
    mockState = { uiBoot: false, onboarded: true };
    render(<Host />);
    // Give any (incorrectly scheduled) async work a tick.
    await Promise.resolve();
    expect(getVersion).not.toHaveBeenCalled();
    expect(toastInfo).not.toHaveBeenCalled();
  });

  it('FIRST RUN: no toast, but seeds the current version', async () => {
    kvGet.mockResolvedValue(null);
    render(<Host />);
    await waitFor(() => expect(kvSet).toHaveBeenCalledWith(LAST_SEEN_KEY, '2.0.0'));
    expect(toastInfo).not.toHaveBeenCalled();
  });

  it('UPGRADE: toasts once and persists the new version', async () => {
    kvGet.mockResolvedValue('1.0.0');
    render(<Host />);
    await waitFor(() => expect(toastInfo).toHaveBeenCalledTimes(1));
    expect(toastInfo).toHaveBeenCalledWith(
      "What's new in v2.0.0",
      expect.objectContaining({ action: expect.objectContaining({ label: 'View' }) }),
    );
    await waitFor(() => expect(kvSet).toHaveBeenCalledWith(LAST_SEEN_KEY, '2.0.0'));
  });

  it('SAME version: no toast, no write', async () => {
    kvGet.mockResolvedValue('2.0.0');
    render(<Host />);
    // Let the async check resolve.
    await waitFor(() => expect(getVersion).toHaveBeenCalled());
    await Promise.resolve();
    expect(toastInfo).not.toHaveBeenCalled();
    expect(kvSet).not.toHaveBeenCalled();
  });

  it('the toast action routes to the Settings room', async () => {
    kvGet.mockResolvedValue('1.0.0');
    render(<Host />);
    await waitFor(() => expect(toastInfo).toHaveBeenCalledTimes(1));
    const opts = toastInfo.mock.calls[0]![1] as {
      action: { onClick: () => void };
    };
    opts.action.onClick();
    expect(dispatch).toHaveBeenCalledWith({ type: 'SET_ROOM', room: 'settings' });
  });
});
